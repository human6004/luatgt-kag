"""Run-owned durable state and a conservative, exclusive physical-database lock."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import threading
import uuid

from kag.builder.codec import canonical_json


STAGES = ('preflight', 'plan', 'vectorize', 'export-artifact', 'write-nodes',
          'verify-nodes', 'write-edges', 'verify', 'release')
SOURCE_STAGES = ('source-nodes', 'source-edges', 'source-verify', 'source-complete')
ROOT = Path(__file__).resolve().parents[1]
ZERO = '0' * 64
GRAPH_LOCK_VOLUME = 'kag-builder-graph-locks'
MESSAGES = {'CONFIG': 'Invalid runner configuration.', 'SCOPE': 'Scope verification refused.',
    'CLEAR_DENIED': 'Deployment has not granted data deletion for this exact project and physical database.',
    'CLEAR_SHARED': 'Another project shares this physical database or its connection cannot be ruled out.',
    'CLEAR_SERVING': 'The database is referenced by the configured serving runtime or release.',
    'CLEAR_STALE': 'Target, data, structure or deployment grant changed. Preview deletion again.',
    'CLEAR_UNCERTAIN': 'A delete transaction may still be active. The graph lock is retained; operator reconciliation is required.',
    'STRUCTURE_STALE': 'Target, schema, indexes or model changed. Preview the structure again.',
    'SCHEMA': 'Target schema is missing or incompatible with the supplied LuatGT schema.',
    'TARGET_MODEL': 'Existing target vectors lack matching model and exact readback provenance. Use an empty project or the original model and run history.',
    'INTEGRITY': 'Run or artifact integrity verification refused.', 'LOCK': 'Database writer lock unavailable.',
    'LOCK_MOUNT': 'Shared graph lock requires the canonical writable Docker named volume.',
    'PLAN': 'Source plan verification refused.', 'VECTORS': 'Required vectors are not verified.',
    'PROVIDER_BUDGET': 'Configured embedding request limit reached.',
    'NODES': 'Node verification refused.', 'EDGES': 'Edge verification refused.',
    'INDEX': 'Vector index verification refused.', 'PROVENANCE': 'Vector provenance verification refused.',
    'INTERRUPTED': 'Run interrupted at a durable batch boundary.',
    'TRANSPORT': 'Graph transport unavailable.', 'RUNTIME': 'Runner execution failed.'}


class RunBlocked(ValueError):
    def __init__(self, code='INTEGRITY'):
        self.code = code if code in MESSAGES else 'INTEGRITY'
        super().__init__(MESSAGES[self.code])


def _utc():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def atomic_json(path, value, *, mode=0o666):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(canonical_json(value) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_run_directory(run_root, run_id, *, repo_root=ROOT, read_only_paths=()):
    if (not isinstance(run_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', run_id)
            or run_id.endswith('.')
            or run_id.rstrip('. ').upper().split('.')[0] in
            {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}):
        raise RunBlocked('CONFIG')
    root = Path(run_root).resolve()
    directory = (root / run_id).resolve()
    if not directory.is_relative_to(root):
        raise RunBlocked('CONFIG')
    for protected in (repo_root, *read_only_paths):
        protected = Path(protected).resolve()
        if directory.is_relative_to(protected) or protected.is_relative_to(directory):
            raise RunBlocked('CONFIG')
    return directory


def _shared_lock_root(path):
    """One local Docker volume for every managed writer, regardless of mount path."""
    try:
        root = Path(path).resolve()
        if not Path(path).is_absolute() or not root.is_dir():
            raise ValueError
        # Compose owns provisioning; mountinfo proves this process uses the shared disk root.
        volume = os.environ.get('KAG_GRAPH_LOCK_VOLUME', GRAPH_LOCK_VOLUME)
        if not re.fullmatch(r'(?:[a-z0-9][a-z0-9_-]*_)?kag-builder-graph-locks', volume):
            raise ValueError
        suffix = '/' + volume + '/_data'
        unescape = lambda value: re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            fields = line.split()
            boundary = fields.index('-')
            if (unescape(fields[4]) == str(root) and unescape(fields[3]).endswith(suffix)
                    and 'rw' in fields[5].split(',') and 'rw' in fields[boundary + 3].split(',')
                    and fields[boundary + 1] in ('ext4', 'xfs', 'btrfs')):
                return {'mountpoint': str(root), 'volume': volume}
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        pass
    raise RunBlocked('LOCK_MOUNT')


class GraphLock:
    def __init__(self, lock_root, database_id, owner, *, backend_proof=None, backend_session=None,
                 shared=True):
        self.shared = shared
        self._backend_proof, self._backend_session = backend_proof, backend_session
        if (backend_proof is not None or backend_session is not None
                or owner.get('scope') in ('PRODUCTION', 'C4_3A_MANIFEST_SAMPLE')):
            self._validate_backend(database_id)
        if not isinstance(database_id, str) or not database_id.strip():
            raise RunBlocked('LOCK')
        root = Path(lock_root).resolve()
        if root.is_relative_to(ROOT) or ROOT.is_relative_to(root):
            raise RunBlocked('LOCK')
        self.path = root / (hashlib.sha256(database_id.encode()).hexdigest() + '.lock')
        self.token = uuid.uuid4().hex
        allowed = ('run_id', 'scope', 'project_id', 'namespace', 'openspg_endpoint', 'neo4j_endpoint', 'database')
        self.metadata = {'database_id': database_id, 'lock_root': str(root), 'owner_token': self.token,
                         'pid': os.getpid(), 'hostname': socket.gethostname(), 'created_at': _utc(),
                         'owner': {k: owner[k] for k in allowed if k in owner}}
        self.acquired = False

    def _validate_backend(self, database_id):
        from kag.backend_identity import BackendIdentitySession, BackendIdentityProof
        try:
            if (not isinstance(self._backend_session, BackendIdentitySession)
                    or not isinstance(self._backend_proof, BackendIdentityProof)):
                raise ValueError
            self._backend_session.validate(self._backend_proof)
            if database_id != self._backend_proof.physical_database_id:
                raise ValueError
        except ValueError:
            raise RunBlocked('LOCK') from None

    def acquire(self):
        if self._backend_proof is not None:
            self._validate_backend(self.metadata['database_id'])
        if self.shared:
            _shared_lock_root(self.path.parent)
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except OSError:
            raise RunBlocked('LOCK') from None
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(canonical_json(self.metadata) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        self.acquired = True

    def assert_owned(self, database_id):
        if self.shared:
            _shared_lock_root(self.path.parent)
        try:
            actual = json.loads(self.path.read_bytes())
        except (OSError, ValueError):
            raise RunBlocked('LOCK') from None
        if (not self.acquired or actual != self.metadata or database_id != self.metadata['database_id']
                or self.metadata['pid'] != os.getpid() or self.metadata['hostname'] != socket.gethostname()):
            raise RunBlocked('LOCK')

    def release(self):
        self.assert_owned(self.metadata['database_id'])
        self.path.unlink()
        self.acquired = False


class RunState:
    def __init__(self, run_dir, identity, *, resume=False):
        self.run_dir = Path(run_dir).resolve()
        if self.run_dir.is_relative_to(ROOT) or ROOT.is_relative_to(self.run_dir):
            raise RunBlocked('CONFIG')
        self.identity = json.loads(canonical_json(identity))
        self.stages = (('preflight', 'plan') + SOURCE_STAGES
                       if self.identity.get('scope') == 'SOURCE_ONLY_DRY_RUN' else STAGES)
        self._status_lock = threading.Lock()
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread = None
        self._heartbeat_failed = threading.Event()
        self.db = None
        ledger = self._owned_file('ledger.sqlite3')
        if resume != ledger.is_file() or (not resume and self.run_dir.exists() and any(self.run_dir.iterdir())):
            raise RunBlocked('INTEGRITY')
        self.run_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.db = sqlite3.connect(ledger)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS run_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS run_stages (stage TEXT PRIMARY KEY, result TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS run_batches (stage TEXT, key TEXT, source_hash TEXT NOT NULL,
                    state TEXT NOT NULL, result TEXT, PRIMARY KEY(stage,key));
                CREATE TABLE IF NOT EXISTS run_outbox (log TEXT, sequence INTEGER, payload TEXT NOT NULL,
                    emitted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(log,sequence));
            ''')
            if resume:
                if self.db.execute("SELECT 1 FROM run_meta WHERE key='disposition'").fetchone():
                    raise RunBlocked('INTEGRITY')
                if self._meta('identity') != canonical_json(self.identity):
                    raise RunBlocked('INTEGRITY')
                self.status = json.loads(self._meta('status'))
            else:
                now = _utc()
                self.status = dict(run_id=identity['run_id'], scope=identity['scope'], stage='preflight',
                    state='RUNNING', done=0, total=0, started_at=now, updated_at=now,
                    heartbeat=now, error_code=None, sanitized_error=None)
                with self.db:
                    self._set_meta('identity', canonical_json(self.identity))
                    self._set_meta('status', canonical_json(self.status))
            self._anchors = self._validate_logs()
            self._flush_outbox()
            atomic_json(self._owned_file('status.json'), self.status)
            self._receipt()
        except Exception:
            self.close()
            raise

    def _meta(self, key):
        row = self.db.execute('SELECT value FROM run_meta WHERE key=?', (key,)).fetchone()
        if not row:
            raise RunBlocked('INTEGRITY')
        return row[0]

    def _owned_file(self, name):
        path = self.run_dir / name
        if path.is_symlink() or path.resolve().parent != self.run_dir:
            raise RunBlocked('CONFIG')
        return path

    def _set_meta(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO run_meta VALUES (?,?)', (key, value))

    def _validate_logs(self):
        anchors = {}
        for log in ('events', 'batches'):
            path = self._owned_file(log + '.jsonl')
            sequence, previous = 0, ZERO
            if path.exists():
                with path.open('rb') as stream:
                    for line in stream:
                        try:
                            if not line.endswith(b'\n'):
                                raise ValueError
                            record = json.loads(line)
                            claimed = record.pop('record_hash')
                            sequence += 1
                            if (record['sequence'] != sequence or record['previous_hash'] != previous
                                    or record['identity'] != _hash(self.identity) or claimed != _hash(record)):
                                raise ValueError
                            record['record_hash'] = claimed
                            row = self.db.execute('SELECT payload FROM run_outbox WHERE log=? AND sequence=?',
                                                  (log, sequence)).fetchone()
                            if row is None or row[0] != canonical_json(record):
                                raise ValueError
                            previous = claimed
                        except (ValueError, KeyError, TypeError):
                            raise RunBlocked('INTEGRITY') from None
            missing_ack = self.db.execute('SELECT 1 FROM run_outbox WHERE log=? AND sequence>? AND emitted=1',
                                          (log, sequence)).fetchone()
            if missing_ack:
                raise RunBlocked('INTEGRITY')
            anchors[log] = (sequence, previous)
        if self.identity.get('scope') == 'SOURCE_ONLY_DRY_RUN':
            self._validate_source_ledger()
        return anchors

    def _validate_source_ledger(self):
        """Reconcile source ledger against durable outbox, including unflushed intents."""
        was_in_transaction = self.db.in_transaction
        if (self.status['stage'] not in self.stages or any(stage not in self.stages for (stage,) in
                self.db.execute('SELECT stage FROM run_stages'))):
            raise RunBlocked('INTEGRITY')
        self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('''CREATE TEMP TABLE IF NOT EXISTS source_audit_batches (
            stage TEXT, key TEXT, source_hash TEXT, state TEXT, result TEXT, PRIMARY KEY(stage,key))''')
        self.db.execute('DELETE FROM source_audit_batches')
        sequence, previous = 0, ZERO
        for ordinal, payload in self.db.execute(
                "SELECT sequence,payload FROM run_outbox WHERE log='batches' ORDER BY sequence"):
            try:
                record = json.loads(payload)
                claimed = record.pop('record_hash')
                sequence += 1
                if (ordinal != sequence or record['sequence'] != sequence or record['previous_hash'] != previous
                        or record['identity'] != _hash(self.identity) or claimed != _hash(record)
                        or record['stage'] not in ('source-nodes', 'source-edges')
                        or record['state'] not in ('INTENT', 'CONFIRMED')):
                    raise RunBlocked('INTEGRITY')
                previous = claimed
                prior = self.db.execute('SELECT source_hash,state FROM source_audit_batches WHERE stage=? AND key=?',
                                         (record['stage'], record['key'])).fetchone()
                if (prior is None and record['state'] != 'INTENT') or (prior is not None and
                        (prior != (record['source_hash'], 'INTENT') or record['state'] != 'CONFIRMED')):
                    raise RunBlocked('INTEGRITY')
                result = canonical_json(record['result']) if 'result' in record else None
                self.db.execute('INSERT OR REPLACE INTO source_audit_batches VALUES (?,?,?,?,?)',
                    (record['stage'], record['key'], record['source_hash'], record['state'], result))
            except (ValueError, KeyError, TypeError):
                raise RunBlocked('INTEGRITY') from None
        mismatch = self.db.execute('''SELECT 1 FROM source_audit_batches a
            LEFT JOIN run_batches b ON a.stage=b.stage AND a.key=b.key
            WHERE b.key IS NULL OR a.source_hash IS NOT b.source_hash
                OR a.state IS NOT b.state OR a.result IS NOT b.result
            UNION ALL SELECT 1 FROM run_batches b
            LEFT JOIN source_audit_batches a ON a.stage=b.stage AND a.key=b.key
            WHERE a.key IS NULL LIMIT 1''').fetchone()
        self.db.execute('DROP TABLE source_audit_batches')
        if not was_in_transaction: self.db.commit()
        if mismatch: raise RunBlocked('INTEGRITY')

    def _enqueue(self, log, value):
        row = self.db.execute('SELECT sequence,payload FROM run_outbox WHERE log=? ORDER BY sequence DESC LIMIT 1',
                              (log,)).fetchone()
        sequence = row[0] + 1 if row else 1
        previous = json.loads(row[1])['record_hash'] if row else ZERO
        record = dict(value, sequence=sequence, identity=_hash(self.identity), previous_hash=previous)
        record['record_hash'] = _hash(record)
        self.db.execute('INSERT INTO run_outbox(log,sequence,payload) VALUES (?,?,?)',
                        (log, sequence, canonical_json(record)))

    def _ack_outbox(self, log, sequence):
        with self.db:
            self.db.execute('UPDATE run_outbox SET emitted=1 WHERE log=? AND sequence=?', (log, sequence))

    def _flush_outbox(self):
        for log in ('events', 'batches'):
            path = self._owned_file(log + '.jsonl')
            path.touch(exist_ok=True)
            for sequence, payload in self.db.execute(
                    'SELECT sequence,payload FROM run_outbox WHERE log=? AND emitted=0 ORDER BY sequence', (log,)):
                anchor, previous = self._anchors[log]
                record = json.loads(payload)
                if sequence > anchor:
                    if sequence != anchor + 1 or record['previous_hash'] != previous:
                        raise RunBlocked('INTEGRITY')
                    with path.open('a', encoding='utf-8', newline='\n') as stream:
                        stream.write(payload + '\n')
                        stream.flush()
                        os.fsync(stream.fileno())
                    self._anchors[log] = (sequence, record['record_hash'])
                self._ack_outbox(log, sequence)

    def update(self, stage, state, done, total, *, error_code=None):
        if state in ('RUNNING', 'PASS'): self._check_heartbeat()
        if (stage not in self.stages or state not in ('RUNNING', 'PASS', 'ERROR', 'BLOCKED')
                or type(done) is not int or type(total) is not int or not 0 <= done <= total):
            raise RunBlocked('CONFIG')
        with self._status_lock:
            if stage == self.status['stage'] and done < self.status['done']:
                raise RunBlocked('INTEGRITY')
            code = error_code if error_code in MESSAGES else ('RUNTIME' if error_code is not None else None)
            now = _utc()
            status = dict(self.status, stage=stage, state=state, done=done, total=total,
                          updated_at=now, heartbeat=now, error_code=code,
                          sanitized_error=MESSAGES.get(code))
            with self.db:
                self._set_meta('status', canonical_json(status))
                self._enqueue('events', status)
            self._flush_outbox()
            atomic_json(self._owned_file('status.json'), status)
            self.status = status

    def begin_batch(self, stage, key, source_hash):
        self._check_heartbeat()
        if stage not in self.stages or not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', source_hash):
            raise RunBlocked('CONFIG')
        row = self.db.execute('SELECT source_hash,state,result FROM run_batches WHERE stage=? AND key=?',
                              (stage, key)).fetchone()
        if row:
            if row[0] != source_hash:
                raise RunBlocked('INTEGRITY')
            return {'state': row[1], 'result': json.loads(row[2]) if row[2] else None}
        with self.db:
            self.db.execute('INSERT INTO run_batches VALUES (?,?,?,\'INTENT\',NULL)', (stage, key, source_hash))
            self._enqueue('batches', dict(stage=stage, key=key, source_hash=source_hash, state='INTENT'))
        self._flush_outbox()
        return {'state': 'INTENT', 'result': None}

    def record_attempt(self, stage, key, counter):
        """Durable dispatch intent; remote completion can remain uncertain."""
        self._check_heartbeat()
        if stage not in self.stages or (stage, counter) not in (('vectorize', 'embedding_calls'), ('write-nodes', 'graph_writes'),
                                     ('write-edges', 'graph_writes')):
            raise RunBlocked('CONFIG')
        row = self.db.execute('SELECT source_hash,state,result FROM run_batches WHERE stage=? AND key=?',
                              (stage, key)).fetchone()
        if row is None or row[1] != 'INTENT': raise RunBlocked('INTEGRITY')
        result = json.loads(row[2]) if row[2] else {}
        result[counter] = result.get(counter, 0) + 1
        with self.db:
            self.db.execute('UPDATE run_batches SET result=? WHERE stage=? AND key=?',
                            (canonical_json(result), stage, key))
            self._enqueue('batches', dict(stage=stage, key=key, source_hash=row[0], state='INTENT', result=result))
        self._flush_outbox()
        return result[counter]

    def confirm_batch(self, stage, key, result):
        self._check_heartbeat()
        if stage not in self.stages: raise RunBlocked('INTEGRITY')
        row = self.db.execute('SELECT source_hash,state,result FROM run_batches WHERE stage=? AND key=?',
                              (stage, key)).fetchone()
        encoded = canonical_json(result)
        if not row or (row[1] == 'CONFIRMED' and row[2] != encoded):
            raise RunBlocked('INTEGRITY')
        if row[1] == 'CONFIRMED':
            return
        with self.db:
            self.db.execute('UPDATE run_batches SET state=\'CONFIRMED\',result=? WHERE stage=? AND key=?',
                            (encoded, stage, key))
            payload = dict(stage=stage, key=key, source_hash=row[0], state='CONFIRMED', result=result)
            self._enqueue('batches', payload)
            self._enqueue('events', payload)
        self._flush_outbox()

    def completed_stage(self, stage):
        row = self.db.execute('SELECT result FROM run_stages WHERE stage=?', (stage,)).fetchone()
        return json.loads(row[0]) if row else None

    def finish_stage(self, stage, result):
        self._check_heartbeat()
        if stage not in self.stages:
            raise RunBlocked('CONFIG')
        previous = self.completed_stage(stage)
        if previous is not None and canonical_json(previous) != canonical_json(result):
            raise RunBlocked('INTEGRITY')
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO run_stages VALUES (?,?)', (stage, canonical_json(result)))
            # update commits stage result, ledger status and PASS outbox together.
            self.update(stage, 'PASS', self.status['done'], self.status['total'])
        self._receipt()

    def _receipt(self):
        if self.identity.get('scope') == 'SOURCE_ONLY_DRY_RUN':
            self._validate_source_ledger()
        stages = {stage: json.loads(result) for stage, result in self.db.execute('SELECT stage,result FROM run_stages')}
        receipt = {'identity': self.identity, 'stages': stages,
                   'audit': {log: {'sequence': seq, 'hash': digest} for log, (seq, digest) in self._anchors.items()}}
        atomic_json(self._owned_file('receipt.json'), receipt)

    def start_heartbeat(self, interval):
        if type(interval) not in (int, float) or interval <= 0 or self._heartbeat_thread is not None:
            raise RunBlocked('CONFIG')
        def heartbeat():
            while not self._heartbeat_stop.wait(interval):
                try:
                    with self._status_lock:
                        self.status['heartbeat'] = _utc()
                        atomic_json(self._owned_file('status.json'), self.status)
                except Exception:
                    self._heartbeat_failed.set()
                    return
        self._heartbeat_thread = threading.Thread(target=heartbeat, name='kag-heartbeat', daemon=True)
        self._heartbeat_thread.start()

    def _check_heartbeat(self):
        if self._heartbeat_failed.is_set():
            raise RuntimeError('Runner heartbeat unavailable.')

    def close(self):
        self._heartbeat_stop.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join()
        if self.db is not None:
            self.db.close()
            self.db = None
