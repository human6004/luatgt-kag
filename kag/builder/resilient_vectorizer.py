"""Checkpointed orchestration around pinned KAG, with bounded field recovery.

Synchronous by design: one runner owns one checkpoint. No source text or provider
response body is stored in failure records. Checkpoints contain successful vectors.
"""
import copy
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
import time
from types import MethodType, SimpleNamespace

from kag.vector_contract import TARGETS, valid_vector as _valid_vector
from kag.run_state import RunBlocked


BACKOFF = (2, 5, 10)
_SAFE_CODES = {'MODEL_NOT_FOUND', 'SERVICE_UNAVAILABLE', 'BAD_REQUEST', 'RATE_LIMIT_EXCEEDED',
               'context_length_exceeded', 'invalid_request_error'}
_SAFE_ERRORS = {'ProviderError','TimeoutError','APITimeoutError','APIConnectionError','ConnectionError',
    'ConnectionResetError','ConnectTimeout','ReadTimeout','ReadError','ConnectError','HTTPStatusError',
    'BadRequestError','NotFoundError','InternalServerError','RateLimitError','AuthenticationError',
    'PermissionDeniedError','UnprocessableEntityError','RuntimeError','ValueError'}


class IncompleteVectorization(ValueError):
    pass


class _Failure(Exception):
    def __init__(self, info):
        self.info = info
        super().__init__(info['error_class'])


def _error_info(error):
    if isinstance(error, _Failure):
        return error.info
    name = type(error).__name__
    body = getattr(error, 'body', None)
    body = body if isinstance(body, dict) else {}
    code = body.get('code')
    status = getattr(error, 'status_code', None)
    status = status if type(status) is int else None
    return {'http_status': status, 'error_class': name if name in _SAFE_ERRORS else 'ProviderError',
            'code': code if isinstance(code,str) and code in _SAFE_CODES else None,
            'timeout': isinstance(error, TimeoutError) or 'timeout' in name.lower(),
            'connection': isinstance(error, ConnectionError) or 'connection' in name.lower(),
            'explicit_input_limit': code == 'context_length_exceeded'}


@dataclass
class VectorizationResult:
    runner: object
    originals: list
    jobs: list
    provider_requests: int
    retry_requests: int
    http_counts: dict
    checkpoint_revision: int

    @property
    def counts(self):
        statuses = Counter(job['status'] for job in self.jobs)
        return {'successful': statuses['SUCCESS'], 'skipped_empty': statuses['SKIPPED_EMPTY'],
                'failed_exhausted': statuses['FAILED_EXHAUSTED'] + statuses['FALLBACK_INCOMPLETE']}

    @property
    def complete(self):
        return self.runner.revision == self.checkpoint_revision and not self.counts['failed_exhausted'] and all(
            j['status'] in ('SUCCESS', 'SKIPPED_EMPTY') for j in self.jobs)

    def require_complete(self):
        if not self.complete:
            raise IncompleteVectorization('required vector jobs unresolved; node/edge barrier remains locked')

    def iter_nodes(self):
        self.require_complete()
        for original in self.originals:
            self.require_complete()
            node = copy.deepcopy(original)
            for _, field in TARGETS[node['type'].rsplit('.', 1)[-1]]:
                node['properties'].pop(field, None)
            for job in self.runner._jobs([original]):
                entry = self.runner._entry(job)
                if entry['status'] not in ('SUCCESS', 'SKIPPED_EMPTY'):
                    raise IncompleteVectorization('result no longer matches checkpoint/source')
                if entry['status'] == 'SUCCESS':
                    node['properties'][job['field']] = entry['vector']
            yield node


class ResilientVectorizer:
    """Reuse an initialized BatchVectorizer and its configured canonical adapter.

    model_identity must identify endpoint + model, excluding credentials.
    Optional SQLite checkpoint enables restart without repeating cached successes.
    """
    def __init__(self, batch_vectorizer, *, model_identity, dimension, checkpoint_path=None,
                 sleep=time.sleep, embedding_fallback=None, stop_event=None):
        if not isinstance(model_identity, str) or not model_identity:
            raise ValueError('explicit endpoint/model identity required')
        if type(dimension) is not int or dimension <= 0:
            raise ValueError('dimension must be a positive native integer')
        self.batch = batch_vectorizer
        self.model_identity = model_identity
        self.dimension = dimension
        self.sleep = sleep
        self.stop_event = stop_event
        self.service_failures = 0
        self.batch_success = False
        self._retry_starts = {}
        self.fallback_config = {'enabled':False, 'max_chunk_chars':8000, 'overlap_chars':500,
            'min_chunk_chars':1000, 'max_split_depth':3, 'chunking_version':'boundary_offsets_v1'}
        if embedding_fallback is not None:
            if not isinstance(embedding_fallback, dict) or set(embedding_fallback)-self.fallback_config.keys():
                raise ValueError('unknown embedding fallback configuration')
            self.fallback_config.update(embedding_fallback)
        cfg = self.fallback_config
        if (type(cfg['enabled']) is not bool or any(type(cfg[k]) is not int for k in
                ('max_chunk_chars','overlap_chars','min_chunk_chars','max_split_depth')) or
                not 0 <= cfg['overlap_chars'] < cfg['max_chunk_chars'] or
                not 1 <= cfg['min_chunk_chars'] <= cfg['max_chunk_chars'] or
                not 0 <= cfg['max_split_depth'] <= 16 or
                not isinstance(cfg['chunking_version'],str) or not cfg['chunking_version']):
            raise ValueError('invalid bounded embedding fallback configuration')
        if checkpoint_path is not None:
            Path(checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(checkpoint_path) if checkpoint_path else ':memory:')
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (identity TEXT PRIMARY KEY, state TEXT NOT NULL)')
        self.db.commit()
        self.requests = self.retries = 0
        self.http = Counter()
        self.revision = 0

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
            self.revision += 1

    def _jobs(self, nodes):
        seen = set()
        for node in nodes:
            if not node.get('id') or not node.get('name') or not isinstance(node.get('properties'), dict):
                raise ValueError('exact node id/name and property mapping required')
            local = node['type'].rsplit('.', 1)[-1]
            if local not in TARGETS or '_name_vector' in node['properties']:
                raise ValueError('unsupported vector target or forbidden name vector')
            for prop, field in TARGETS[local]:
                text = node['properties'].get(prop)
                if text is not None and not isinstance(text, str):
                    raise ValueError('vector source must remain original Text')
                key = json.dumps([node['type'], node['id'], prop], ensure_ascii=False, separators=(',', ':'))
                if key in seen:
                    raise ValueError('duplicate vector job identity')
                seen.add(key)
                raw = (text or '').encode('utf-8')
                yield {'key': key, 'node_type': node['type'], 'node_id': node['id'], 'property': prop,
                    'field': field, 'text': text, 'source_sha256': hashlib.sha256(raw).hexdigest(),
                    'source_chars': len(text or ''), 'source_bytes': len(raw)}

    def _entry(self, job):
        row = self.db.execute('SELECT state FROM jobs WHERE identity=?', (job['key'],)).fetchone()
        if row:
            value = json.loads(row[0])
            if (all(value.get(k) == job[k] for k in ('node_type','node_id','property','source_sha256'))
                    and value['model_identity'] == self.model_identity and value['dimension'] == self.dimension):
                value.setdefault('embedding_method','DIRECT')
                if value.get('embedding_method') == 'CHUNK_AGGREGATED' and (
                        not self.fallback_config['enabled'] or value.get('fallback_config') != self.fallback_config):
                    previous = value.get('direct_failure', {})
                    if all(previous.get(k) == value[k] for k in
                            ('node_type','node_id','property','source_sha256','model_identity','dimension')):
                        return previous
                    value = None
                if value is not None and (value['status'] != 'SUCCESS' or _valid_vector(value.get('vector'), self.dimension)):
                    return value
        return {k: job[k] for k in ('node_type', 'node_id', 'property', 'source_sha256', 'source_chars', 'source_bytes')} | {
            'model_identity': self.model_identity, 'dimension': self.dimension,
            'status': 'PENDING', 'attempts': [], 'classification': None, 'embedding_method':'DIRECT'}

    def _store(self, job, entry):
        self.db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?)',
            (job['key'], json.dumps(entry, ensure_ascii=False, allow_nan=False, separators=(',', ':'))))

    def import_successes(self, originals, vectorized_nodes, *, artifact_model_identity, artifact_dimension,
                         artifact_jobs=None):
        """Import a verified DIRECT artifact, or mixed vectors with verified job sidecar.

        Cold imports of CHUNK_AGGREGATED vectors require artifact_jobs from the
        vectorization receipt. Existing identical aggregate checkpoints keep their
        provenance. The caller must verify artifact/sidecar hashes before import.
        """
        if artifact_model_identity != self.model_identity or type(artifact_dimension) is not int or artifact_dimension != self.dimension:
            raise ValueError('artifact endpoint/model/dimension provenance differs from runner')
        self.revision += 1
        source = {(n['type'], n['id']): n for n in originals}
        provenance = {}
        for record in artifact_jobs or ():
            key = (record['node_type'],record['node_id'],record['property'])
            if key in provenance:
                raise ValueError('duplicate artifact provenance identity')
            provenance[key] = record
        count = 0
        with self.db:
            for node in vectorized_nodes:
                original = source[(node['type'], node['id'])]
                if (node['name'] != original['name'] or '_name_vector' in node['properties'] or
                        {k:v for k,v in node['properties'].items() if not k.startswith('_')} != original['properties']):
                    raise ValueError('artifact changed source semantics')
                allowed = {j['field'] for j in self._jobs([original])}
                if any(k.startswith('_') and k not in allowed for k in node['properties']):
                    raise ValueError('unexpected artifact vector field')
                for job in self._jobs([original]):
                    if job['text'] in (None, ''):
                        if job['field'] in node['properties']:
                            raise ValueError('empty field has unexpected vector')
                        continue
                    vector = node['properties'].get(job['field'])
                    if vector is None:
                        continue
                    if not _valid_vector(vector, self.dimension):
                        raise ValueError('invalid cached vector')
                    entry = self._entry(job)
                    record = provenance.get((job['node_type'],job['node_id'],job['property']))
                    if artifact_jobs is not None:
                        if (record is None or record.get('status') != 'SUCCESS' or
                                any(record.get(k) != job[k] for k in ('node_type','node_id','property','source_sha256')) or
                                record.get('model_identity') != self.model_identity or record.get('dimension') != self.dimension):
                            raise ValueError('artifact job provenance differs from source/model/dimension')
                        if record.get('embedding_method') == 'CHUNK_AGGREGATED':
                            if (not self.fallback_config['enabled'] or record.get('fallback_config') != self.fallback_config or
                                    not isinstance(record.get('direct_failure'),dict) or not isinstance(record.get('fallback'),dict)):
                                raise ValueError('aggregate chunk provenance/configuration required')
                            entry = copy.deepcopy(record)
                        elif record.get('embedding_method') != 'DIRECT':
                            raise ValueError('unknown artifact embedding method')
                    retained_aggregate = entry.get('embedding_method') == 'CHUNK_AGGREGATED' and (
                        record is not None and record.get('embedding_method') == 'CHUNK_AGGREGATED' or
                        record is None and entry.get('vector') == vector)
                    if retained_aggregate:
                        entry.update(status='SUCCESS',vector=vector)
                    else:
                        for key in ('fallback','fallback_config','direct_failure'):
                            entry.pop(key,None)
                        entry.update(status='SUCCESS',vector=vector,classification='IMPORTED_VALID_SUCCESS',embedding_method='DIRECT')
                    self._store(job, entry)
                    count += 1
        return count

    def _adapter_call(self, texts, timeout):
        """Canonical adapter remains in use; capture SDK errors it otherwise swallows."""
        original = self.batch.vectorize_model
        # Pinned models use a singleton __new__ requiring endpoint/model arguments.
        # Clone initialized state without invoking that factory or mutating its client.
        adapter = object.__new__(type(original))
        adapter.__dict__.update(original.__dict__)
        adapter.timeout = timeout
        captured = []
        if hasattr(adapter, 'client'):
            client = adapter.client.with_options(timeout=timeout, max_retries=0)
            def create(*args, **kwargs):
                try:
                    return client.embeddings.create(*args, **kwargs)
                except Exception as error:
                    captured.append(_error_info(error))
                    raise
            adapter.client = SimpleNamespace(embeddings=SimpleNamespace(create=create))
        # Pinned adapter logs full input on failure. Suppress only that logger.
        logger = logging.getLogger(type(adapter).__module__)
        previous = logger.disabled
        logger.disabled = True
        try:
            vectors = adapter.vectorize(texts)
            if vectors is None:
                raise _Failure(captured[-1] if captured else _error_info(RuntimeError()))
            return vectors
        finally:
            logger.disabled = previous

    def _call(self, texts, jobs, timeout, phase):
        self._check_stop()
        # KAG deduplicates original values, then maps whitespace to "none".
        # Distinct original whitespace values can therefore share request strings.
        groups = {}
        for job in jobs:
            entry = self._entry(job)
            if entry['status'] == 'PENDING' and (phase != 'ORIGINAL' or not entry['attempts']):
                groups.setdefault(job['text'], []).append(job)
        related = []
        for index, value in enumerate(texts):
            match = next((source for source in groups if
                ('none' if phase == 'ORIGINAL' and source is not None and source.strip() == '' else source) == value), None)
            if match is None:
                raise ValueError('KAG submitted a value outside unresolved original fields')
            related.extend((job,index) for job in groups.pop(match))
        self.requests += 1
        self.retries += phase == 'RECOVERY'
        with self.db:
            for job, _ in related:
                entry = self._entry(job)
                entry['attempts'].append({'phase': phase, 'timeout_seconds': timeout,
                    'http_status': None, 'error_class': 'INTERRUPTED_REQUEST'})
                self._store(job, entry)
        response_received = False
        try:
            vectors = self._adapter_call(texts, timeout)
            response_received = True
            self.http['200'] += 1
            if not isinstance(vectors, list) or len(vectors) != len(texts):
                raise _Failure(_error_info(ValueError()) | {'error_class': 'INVALID_PROVIDER_VECTOR'})
            invalid = None
            with self.db:
                for job, index in related:
                    entry = self._entry(job)
                    if not _valid_vector(vectors[index], self.dimension):
                        invalid = _error_info(ValueError()) | {'error_class': 'INVALID_PROVIDER_VECTOR'}
                        entry['attempts'][-1].update(invalid)
                        entry.update(classification='INVALID_PROVIDER_VECTOR', status='FAILED_EXHAUSTED')
                    else:
                        entry['attempts'][-1].update(http_status=200, error_class=None)
                        old_status = entry['attempts'][-2].get('http_status') if len(entry['attempts']) > 1 else None
                        entry.update(status='SUCCESS', vector=vectors[index],
                            classification='BATCH_OR_PROVIDER_TRANSIENT' if old_status == 400 else 'SUCCESS')
                        self.batch_success = True
                    self._store(job, entry)
            if invalid:
                raise _Failure(invalid)
            self.service_failures = 0
            return vectors
        except Exception as error:
            info = _error_info(error)
            if response_received:
                info = info | {'http_status':200}
            else:
                self.http[str(info['http_status'])] += 1
            with self.db:
                for job, _ in related:
                    entry = self._entry(job)
                    if entry['status'] == 'SUCCESS':
                        continue
                    entry['attempts'][-1].update(info)
                    self._store(job, entry)
            self._check_stop()
            self.service_failures = self.service_failures + 1 if info['http_status'] == 503 or info.get('connection') else 0
            if self.service_failures >= 3 and not self.batch_success:
                raise RunBlocked('VECTORS') from None
            raise _Failure(info) from None

    def _check_stop(self):
        if self.stop_event is not None and self.stop_event.is_set():
            raise RunBlocked('INTERRUPTED')

    def _recover(self, job):
        while True:
            self._check_stop()
            entry = self._entry(job)
            if entry['status'] in ('SUCCESS', 'FAILED_EXHAUSTED'):
                return
            attempts = entry['attempts']
            last = attempts[-1]
            recovery = [a for a in attempts[self._retry_starts.get(job['key'], 0):] if a['phase'] == 'RECOVERY']
            info = last
            interrupted = info.get('error_class') == 'INTERRUPTED_REQUEST'
            large_timeout = job['source_chars'] > 100000 and (info.get('timeout', False) or
                interrupted and any(a['timeout_seconds'] in (180,300) for a in recovery))
            retryable = (info.get('timeout') or info.get('connection') or
                info.get('http_status') in (429,500,502,503,504) or
                info.get('http_status') == 404 and info.get('code') == 'MODEL_NOT_FOUND' or
                info.get('error_class') == 'INTERRUPTED_REQUEST')
            classification = None
            if info['error_class'] == 'INVALID_PROVIDER_VECTOR':
                classification = 'INVALID_PROVIDER_VECTOR'
            elif interrupted and recovery and any(a.get('http_status') == 400 for a in attempts):
                classification = 'INTERRUPTED_SINGLE_VALUE_RECOVERY'
            elif info.get('http_status') == 400 and sum(a.get('http_status') == 400 for a in attempts) >= 2:
                classification = 'DETERMINISTIC_PROVIDER_REJECTION'
            elif large_timeout and any(a['timeout_seconds'] == 300 for a in recovery):
                classification = 'INTERRUPTED_FINAL_LARGE_INPUT_ATTEMPT' if interrupted else 'PERSISTENT_LARGE_INPUT_TIMEOUT'
            elif len(recovery) >= 3:
                classification = 'RETRY_EXHAUSTED'
            elif info.get('http_status') != 400 and not retryable:
                classification = 'PROVIDER_REJECTION'
            if classification:
                entry.update(status='FAILED_EXHAUSTED', classification=classification)
                with self.db: self._store(job, entry)
                return
            timeout = getattr(self.batch.vectorize_model, 'timeout', None) or 60
            if large_timeout:
                timeout = 300 if any(a['timeout_seconds'] == 180 for a in recovery) else 180
            if info.get('http_status') != 400:
                self._check_stop()
                self.sleep(BACKOFF[len(recovery)])
            try:
                self._call([job['text']], [job], timeout, 'RECOVERY')
            except _Failure:
                pass

    def run(self, nodes, *, previous_failures=(), resume=False):
        self.revision += 1
        originals = copy.deepcopy(list(nodes))
        jobs = list(self._jobs(originals))
        self.service_failures = 0
        self._retry_starts = {}
        self.batch_success = any(self._entry(job)['status'] == 'SUCCESS' for job in jobs)
        by_key = {(j['node_type'],j['node_id'],j['property']): j for j in jobs}
        with self.db:
            for failure in previous_failures:
                job = by_key[(failure['node_type'],failure['node_id'],failure['property'])]
                entry = self._entry(job)
                if not entry['attempts'] and entry['status'] == 'PENDING':
                    error_class = failure.get('error_class')
                    error_class = error_class if error_class in _SAFE_ERRORS else 'ProviderError'
                    code = failure.get('code')
                    status = failure.get('http_status')
                    info = {'http_status': status if type(status) is int else None, 'error_class': error_class,
                        'code': code if isinstance(code,str) and code in _SAFE_CODES else None,
                        'timeout': 'timeout' in error_class.lower(), 'connection': 'connection' in error_class.lower(),
                        'explicit_input_limit': code == 'context_length_exceeded'}
                    entry['attempts'] = [info | {'phase':'ORIGINAL', 'timeout_seconds':60}]
                    self._store(job, entry)
            for job in jobs:
                entry = self._entry(job)
                if resume and entry['status'] in ('PENDING', 'FAILED_EXHAUSTED') and entry['attempts']:
                    last = entry['attempts'][-1]
                    if last.get('http_status') == 503 or last.get('timeout') or last.get('connection'):
                        # A user resume starts a bounded retry window, preserving paid attempt history.
                        self._retry_starts[job['key']] = len(entry['attempts'])
                        entry.update(status='PENDING', classification=None)
                        self._store(job, entry)
                if job['text'] in (None, ''):
                    entry.update(status='SKIPPED_EMPTY', classification='PINNED_EMPTY_BEHAVIOR')
                    self._store(job, entry)
        before_requests, before_retries, before_http = self.requests, self.retries, self.http.copy()
        # Keep each graph small; provider-batch responses checkpoint before KAG's final patch.
        from kag.builder.model.sub_graph import Node, SubGraph
        for offset in range(0, len(originals), 32):
            group = originals[offset:offset+32]
            self._process_group(group, Node, SubGraph)
        if self.fallback_config['enabled']:
            for job in jobs:
                entry = self._entry(job)
                if (job['node_type'].rsplit('.',1)[-1] == 'LegalUnit' and job['property'] == 'text'
                        and job['text'] not in (None,'') and entry['status'] in ('FAILED_EXHAUSTED','FALLBACK_INCOMPLETE')):
                    self._fallback(job, entry)
        return self._result(originals, jobs, before_requests, before_retries, before_http)

    def _fallback(self, source, entry):
        from kag.builder.embedding_chunker import chunk_text, split_chunk, effective_weights, pool_vectors
        cfg = self.fallback_config
        direct = copy.deepcopy(entry.get('direct_failure',entry))
        direct.pop('vector',None);direct.pop('fallback',None);direct.pop('direct_failure',None)
        # Retain direct exhaustion during interruption; never restart full-text retries.
        entry.update(status='FALLBACK_INCOMPLETE',direct_failure=direct)
        with self.db: self._store(source,entry)
        before_requests, before_retries = self.requests, self.retries
        leaves, cache_hits = [], 0
        try:
            initial = chunk_text(source['text'],cfg['max_chunk_chars'],cfg['overlap_chars'])
        except ValueError:
            initial = []
        def visit(offsets, depth):
            nonlocal cache_hits
            start,end = offsets
            text = source['text'][start:end]
            sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
            key = json.dumps(['CHUNK',source['key'],source['source_sha256'],cfg,self.model_identity,
                self.dimension,start,end,sha],ensure_ascii=False,sort_keys=True,separators=(',',':'))
            job = source | {'key':key,'text':text,'source_sha256':sha,
                'source_chars':len(text),'source_bytes':len(text.encode('utf-8'))}
            value = self._entry(job)
            if value['status'] == 'SUCCESS':
                cache_hits += 1
            elif value['status'] == 'PENDING':
                if not value['attempts']:
                    try:
                        self._call([text],[job],getattr(self.batch.vectorize_model,'timeout',None) or 60,'ORIGINAL')
                    except _Failure:
                        pass
                self._recover(job)
                value = self._entry(job)
            children = split_chunk(source['text'],offsets,cfg['min_chunk_chars']) if (
                value['status'] == 'FAILED_EXHAUSTED' and depth < cfg['max_split_depth']) else None
            if children:
                for child in children: visit(child,depth+1)
                return
            metadata = {'start_offset':start,'end_offset':end,'chunk_sha256':sha,'chunk_chars':len(text),
                'split_depth':depth,'status':value['status'],'classification':value['classification'],
                'attempt_count':len(value['attempts']),'attempts':value['attempts'],
                'sanitized_error_class':value['attempts'][-1].get('error_class') if value['attempts'] else None,
                'last_http_status':value['attempts'][-1].get('http_status') if value['attempts'] else None}
            leaves.append((metadata,value.get('vector')))
        for offsets in initial: visit(offsets,0)
        leaves.sort(key=lambda item:(item[0]['start_offset'],item[0]['end_offset']))
        for index,(metadata,_) in enumerate(leaves): metadata['chunk_index']=index
        manifest = {k:source[k] for k in ('node_type','node_id','property','source_sha256','source_chars')}
        manifest.update(chunking_version=cfg['chunking_version'],max_chunk_chars=cfg['max_chunk_chars'],
            overlap_chars=cfg['overlap_chars'],min_chunk_chars=cfg['min_chunk_chars'],max_split_depth=cfg['max_split_depth'],
            initial_chunk_count=len(initial),final_chunk_count=len(leaves),chunk_count=len(leaves),
            successful_chunks=sum(m['status']=='SUCCESS' for m,_ in leaves),
            failed_chunks=sum(m['status']!='SUCCESS' for m,_ in leaves),chunks=[m for m,_ in leaves],
            provider_requests=self.requests-before_requests,retry_requests=self.retries-before_retries,cache_hits=cache_hits,
            aggregation='length_weighted_mean',normalization='l2',
            effective_weight_rule='first covering chunk owns characters; later overlap contributes zero extra weight',
            model_identity=self.model_identity,dimension=self.dimension)
        entry.update(fallback=manifest,fallback_config=copy.deepcopy(cfg))
        if leaves and not manifest['failed_chunks']:
            try:
                weights = effective_weights([(m['start_offset'],m['end_offset']) for m,_ in leaves],source['source_chars'])
                vector = pool_vectors([v for _,v in leaves],weights,self.dimension)
                for (metadata,_),weight in zip(leaves,weights): metadata['effective_weight']=weight
                entry.update(status='SUCCESS',vector=vector,embedding_method='CHUNK_AGGREGATED',classification='CHUNK_AGGREGATED')
            except ValueError:
                entry.update(classification='INVALID_AGGREGATE_VECTOR')
        else:
            entry.update(classification='FALLBACK_INCOMPLETE')
        manifest['aggregation_result'] = 'PASS' if entry['status']=='SUCCESS' else 'FALLBACK_INCOMPLETE'
        with self.db: self._store(source,entry)

    def _process_group(self, group, Node, SubGraph):
        active = list(self._jobs(group))
        while True:
            pending = [j for j in active if self._entry(j)['status'] == 'PENDING' and not self._entry(j)['attempts']]
            if pending:
                clone = copy.copy(self.batch)
                timeout = getattr(self.batch.vectorize_model, 'timeout', None) or 60
                owner = self
                class CapturedDense:
                    def vectorize(self, texts): return owner._call(texts, active, timeout, 'ORIGINAL')
                clone.vectorize_model = CapturedDense()
                if clone.sparse_vectorize_model is not None:
                    raise ValueError('sparse vectorization requires a separate recovery policy')
                disabled = set(clone.disable_generation or ())
                disabled.update(local + '.name' for local in (*TARGETS, 'Entity'))
                # Previous failed fields must go through individual bounded recovery.
                pending_keys = {j['key'] for j in pending}
                graph_nodes = []
                for spec in group:
                    props = {k:copy.deepcopy(v) for k,v in spec['properties'].items() if not k.startswith('_')}
                    spec_jobs = list(self._jobs([spec]))
                    if not any(j['key'] in pending_keys for j in spec_jobs):
                        continue
                    for job in spec_jobs:
                        entry = self._entry(job)
                        if entry['status'] == 'SUCCESS':
                            props[job['field']] = entry['vector']
                        elif job['key'] not in pending_keys:
                            # Temporary runtime marker makes KAG skip exhausted fields.
                            # It is never persisted as a vector or emitted to the writer.
                            props[job['field']] = None
                    graph_nodes.append(Node(_id=spec['id'],name=spec['name'],label=spec['type'].rsplit('.',1)[-1],properties=props))
                clone.disable_generation = list(disabled)
                fn = type(clone)._generate_embedding_vectors
                clone._generate_embedding_vectors = MethodType(getattr(fn, '__wrapped__', fn), clone)
                failed = False
                try:
                    clone._invoke(SubGraph(graph_nodes, []))
                except _Failure:
                    failed = True
                if not failed:
                    with self.db:
                        for job in pending:
                            entry = self._entry(job)
                            if entry['status'] == 'PENDING' and not entry['attempts']:
                                entry.update(status='FAILED_EXHAUSTED', classification='MISSING_KAG_VECTOR_TARGET')
                                self._store(job, entry)
            for job in active:
                entry = self._entry(job)
                if entry['status'] == 'PENDING' and entry['attempts']:
                    self._recover(job)
            if not any(self._entry(j)['status'] == 'PENDING' for j in active):
                return

    def _result(self, originals, jobs, requests, retries, http):
        records = []
        for job in jobs:
            entry = self._entry(job)
            if entry['status'] not in ('SUCCESS', 'SKIPPED_EMPTY', 'FAILED_EXHAUSTED','FALLBACK_INCOMPLETE'):
                raise IncompleteVectorization('unclassified vector job')
            records.append({k:v for k,v in entry.items() if k != 'vector'} | {
                'attempt_count':len(entry['attempts']),
                'sanitized_error_class':entry['attempts'][-1].get('error_class') if entry['attempts'] else None,
                'last_http_status':entry['attempts'][-1].get('http_status') if entry['attempts'] else None})
        return VectorizationResult(self, originals, records, self.requests-requests, self.retries-retries,
                                   dict(self.http-http), self.revision)
