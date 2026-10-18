"""Parameterized read-only Neo4j scans and disk-indexed exact graph verification."""
import base64
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from kag.builder.codec import BuilderContractError, canonical_json, decode_properties
from kag.builder.embedding_chunker import effective_weights
from kag.builder.mapping import application_edge_key
from kag.vector_contract import TARGETS, valid_vector as _valid_vector
from kag.run_state import MESSAGES, RunBlocked


NODE_RETURN = 'id(n) AS physical_id, labels(n) AS labels, properties(n) AS properties'
ENDPOINT = ('{physical_id:id(%s),labels:labels(%s),property_keys:keys(%s),'
            'properties:%s{.id,.name,.stub,.degraded,._stub,._degraded,.isStub,.isDegraded}}')
EDGE_RETURN = ('id(r) AS physical_id, type(r) AS predicate, properties(r) AS properties, '
               + ENDPOINT % ('a', 'a', 'a', 'a') + ' AS from_node, '
               + ENDPOINT % ('b', 'b', 'b', 'b') + ' AS to_node')
QUERIES = {
    'nodes': ('MATCH (n) WHERE id(n)>$cursor AND any(l IN labels(n) WHERE l STARTS WITH $namespace) '
              'RETURN ' + NODE_RETURN + ' ORDER BY physical_id LIMIT $limit'),
    'edges': ('MATCH (a)-[r]->(b) WHERE id(r)>$cursor AND '
              '(any(l IN labels(a) WHERE l STARTS WITH $namespace) OR '
              'any(l IN labels(b) WHERE l STARTS WITH $namespace)) RETURN '
              + EDGE_RETURN + ' ORDER BY physical_id LIMIT $limit'),
    'batch_nodes': ('MATCH (n) WHERE any(k IN $keys WHERE k[0] IN labels(n) AND n.id=k[1]) '
                    'RETURN ' + NODE_RETURN + ' ORDER BY physical_id LIMIT $limit'),
    'batch_edges': ('MATCH (a)-[r]->(b) WHERE any(k IN $keys WHERE k[0] IN labels(a) AND a.id=k[1] '
                    'AND type(r)=k[2] AND k[3] IN labels(b) AND b.id=k[4]) RETURN '
                    + EDGE_RETURN + ' ORDER BY physical_id LIMIT $limit'),
    'databases': ('SHOW DATABASES YIELD name,databaseID,currentStatus WHERE name=$database '
                  'RETURN name,databaseID,currentStatus'),
    'database_metadata': ('SHOW DATABASES YIELD name,databaseID,serverID,currentStatus '
        'RETURN name,databaseID,serverID,currentStatus,toLower($database) AS requested'),
    'indexes': ('SHOW INDEXES YIELD name,type,state,labelsOrTypes,properties,options '
                'RETURN name,type,state,labelsOrTypes,properties,options'),
    'structure_counts': ('CALL { MATCH (n) RETURN count(n) AS nodes } '
                         'CALL { MATCH ()-[r]->() RETURN count(r) AS edges } RETURN nodes,edges'),
}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _storage_record(record, *, edge=False):
    """Remove OpenSPG's documented outer JSON storage layer, exactly once.

    id is storage identity; vectors/native scalars remain native. Schema/codec
    checks still reject numeric Text, double encoding, unknown properties and flags.
    """
    try:
        result = dict(record)
        result['properties'] = {key: json.loads(value) if isinstance(value, str)
            and key != 'id' and not key.endswith('_vector') else value
            for key, value in record['properties'].items()}
        if edge:
            result['from'] = _storage_record(record['from'])
            result['to'] = _storage_record(record['to'])
        return result
    except (ValueError, KeyError, TypeError):
        raise RunBlocked('INTEGRITY') from None


class Neo4jReadClient:
    def __init__(self, http_endpoint, database, *, username, password, timeout):
        try:
            parsed = urlsplit(http_endpoint)
            if (parsed.scheme not in ('http', 'https') or not parsed.hostname or not parsed.port
                    or parsed.username or parsed.password or parsed.query or parsed.fragment
                    or parsed.path not in ('', '/') or http_endpoint.strip() != http_endpoint
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,62}', database)
                    or type(timeout) not in (int, float) or timeout <= 0
                    or not isinstance(username, str) or not username or not isinstance(password, str) or not password):
                raise ValueError
        except (TypeError, ValueError, AttributeError):
            raise RunBlocked('CONFIG') from None
        self.endpoint, self.database, self.timeout = http_endpoint.rstrip('/'), database, timeout
        self._auth = 'Basic ' + base64.b64encode((username + ':' + password).encode()).decode()
        self._opener = build_opener(_NoRedirect())
        self.read_requests = 0

    def _query(self, name, parameters=None, *, database=None):
        if name not in QUERIES:
            raise RunBlocked('CONFIG')
        target = 'system' if name in ('databases', 'database_metadata') else self.database
        if database is not None and database != target:
            raise RunBlocked('CONFIG')
        payload = {'statements': [{'statement': QUERIES[name], 'parameters': parameters or {}}]}
        request = Request(self.endpoint + '/db/' + quote(target, safe='') + '/tx/commit',
            data=canonical_json(payload).encode(), headers={'Authorization': self._auth,
            'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
        self.read_requests += 1
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                result = json.load(response)
            if result.get('errors') or len(result['results']) != 1:
                raise ValueError
            table = result['results'][0]
            rows = []
            for entry in table['data']:
                if len(entry['row']) != len(table['columns']):
                    raise ValueError
                record = dict(zip(table['columns'], entry['row']))
                if name in ('edges', 'batch_edges'):
                    record['from'] = record.pop('from_node')
                    record['to'] = record.pop('to_node')
                rows.append(record)
        except Exception:
            raise RuntimeError(MESSAGES['TRANSPORT']) from None
        if name in ('nodes', 'batch_nodes', 'edges', 'batch_edges'):
            return [_storage_record(row, edge=name in ('edges', 'batch_edges')) for row in rows]
        return rows

    def database_identity(self):
        rows = self._query('databases', {'database': self.database})
        if (len(rows) != 1 or rows[0].get('name') != self.database
                or rows[0].get('currentStatus') != 'online'
                or not isinstance(rows[0].get('databaseID'), str) or not rows[0]['databaseID'].strip()):
            raise RunBlocked('LOCK')
        return rows[0]['databaseID']

    def database_metadata(self):
        """Resolve only a unique ONLINE catalog entry and unique physical ID."""
        rows = self._query('database_metadata', {'database': self.database})
        matches = [r for r in rows if r.get('name') == self.database.lower()]
        if len(matches) != 1:
            raise RunBlocked('LOCK')
        row = matches[0]
        if (row.get('currentStatus') != 'online'
                or any(not isinstance(row.get(k), str) or not row[k].strip()
                       for k in ('name', 'databaseID', 'serverID'))
                or sum(r.get('databaseID') == row['databaseID'] for r in rows) != 1):
            raise RunBlocked('LOCK')
        return {key: row[key] for key in ('name', 'databaseID', 'serverID', 'currentStatus')}

    def protected_database_identity(self, database):
        rows = self._query('database_metadata', {'database': database})
        matches = [row for row in rows if row.get('name') == database.lower()]
        if len(matches) != 1 or not isinstance(matches[0].get('databaseID'), str):
            raise RunBlocked('SCOPE')
        return matches[0]['databaseID']

    def _scan(self, kind, namespace, batch_size):
        _batch_size(batch_size)
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', namespace):
            raise RunBlocked('CONFIG')
        cursor = -1
        while True:
            rows = self._query(kind, {'namespace': namespace + '.', 'cursor': cursor, 'limit': batch_size})
            if not rows:
                return
            if len(rows) > batch_size or any(type(r.get('physical_id')) is not int for r in rows):
                raise RunBlocked('INTEGRITY')
            positions = [r['physical_id'] for r in rows]
            if positions != sorted(set(positions)) or positions[0] <= cursor:
                raise RunBlocked('INTEGRITY')
            cursor = positions[-1]
            yield rows

    def iter_nodes(self, namespace, batch_size):
        yield from self._scan('nodes', namespace, batch_size)

    def iter_edges(self, namespace, batch_size):
        yield from self._scan('edges', namespace, batch_size)

    def indexes(self):
        return self._query('indexes')

    def read_nodes(self, keys):
        return self._query('batch_nodes', {'keys': keys, 'limit': len(keys) + 1})

    def read_edges(self, keys):
        return self._query('batch_edges', {'keys': keys, 'limit': len(keys) + 1})


def _batch_size(value):
    if type(value) is not int or value < 1:
        raise RunBlocked('CONFIG')


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _identity(record, contract):
    labels, props = record['labels'], record['properties']
    types = [contract['namespace'] + '.' + local for local in contract['node_types']]
    matching = [label for label in labels if label in types]
    if (len(matching) != 1 or set(labels) - {matching[0], 'Entity'}
            or not isinstance(props.get('id'), str) or not props['id'].strip()
            or props.get('name') != props['id']
            or any(props.get(flag) not in (None, False, 'false') for flag in
                   ('stub', 'degraded', '_stub', '_degraded', 'isStub', 'isDegraded'))):
        raise RunBlocked('NODES')
    return matching[0], props['id']


def _node(record, contract, dimension=3072):
    type_name, identity = _identity(record, contract)
    local = type_name.rsplit('.', 1)[-1]
    props = record['properties']
    rows = contract['node_properties'][local]
    targets = TARGETS[local]
    allowed = {row['schema_name'] for row in rows} | {field for _, field in targets}
    if set(props) - allowed:
        raise RunBlocked('NODES')
    semantic = decode_properties(props, rows, server_encoded=False)
    if local == 'LegalUnit' and semantic.get('unit_type') not in contract['unit_type_values']:
        raise RunBlocked('NODES')
    vectors, sources = {}, {}
    names = {r['schema_name']: r['logical_name'] for r in rows}
    for prop, field in targets:
        text = semantic.get(names[prop]) or ''
        if not isinstance(text, str):
            raise RunBlocked('VECTORS')
        sources[prop] = text
        if text:
            if not _valid_vector(props.get(field), dimension):
                raise RunBlocked('VECTORS')
            # Neo4j JSON emits +0.0 for -0.0; both are the same numeric vector component.
            # No tolerance or rounding applies to any nonzero component.
            vectors[field] = [0.0 if value == 0 else value for value in props[field]]
        elif field in props:
            raise RunBlocked('VECTORS')
    key = canonical_json([type_name, identity])
    return key, _digest({'type': type_name, 'id': identity, 'properties': semantic, 'vectors': vectors}), sources


def _expected_node(spec, contract, dimension=3072):
    props = dict(spec['properties'])
    if spec['name'] != spec['id'] or any(k in props and props[k] != spec[k] for k in ('id', 'name')):
        raise RunBlocked('NODES')
    props.update(id=spec['id'], name=spec['name'])
    return _node({'labels': [spec['type']], 'properties': props}, contract, dimension)


def _endpoint(record, contract):
    type_name, identity = _identity(record, contract)
    rows = contract['node_properties'][type_name.rsplit('.', 1)[-1]]
    keys = set(record.get('property_keys', record['properties']))
    if any(row['schema_name'] not in keys for row in rows if row['required']):
        raise RunBlocked('EDGES')
    if type(record.get('physical_id')) is not int or record['physical_id'] < 0:
        raise RunBlocked('EDGES')
    return type_name, identity


def _edge_payload(fields, props, contract):
    if (len(fields) != 5 or fields[2] not in contract['relations']
            or not all(isinstance(v, str) and v for v in fields)):
        raise RunBlocked('EDGES')
    relation = contract['relations'][fields[2]]
    namespace = contract['namespace'] + '.'
    if fields[0] != namespace + relation['from_type'] or fields[3] != namespace + relation['to_type']:
        raise RunBlocked('EDGES')
    rows = contract['relation_properties'][fields[2]]
    if set(props) - {r['schema_name'] for r in rows}:
        raise RunBlocked('EDGES')
    semantic = decode_properties(props, rows, server_encoded=False)
    return canonical_json(list(fields)), _digest({'tuple': list(fields), 'properties': semantic})


def _edge(record, contract):
    source, target = _endpoint(record['from'], contract), _endpoint(record['to'], contract)
    fields = [source[0], source[1], record['predicate'], target[0], target[1]]
    return _edge_payload(fields, record['properties'], contract)


def _expected_edge(spec, contract):
    if spec['application_edge_key'] != application_edge_key(spec['tuple']):
        raise RunBlocked('EDGES')
    return _edge_payload(spec['tuple'], spec['properties'], contract)


def _chunks(job, source):
    fallback, config, failure = job['fallback'], job['fallback_config'], job['direct_failure']
    for record in (fallback, failure):
        if any(record.get(k) != job[k] for k in
               ('node_type', 'node_id', 'property', 'source_sha256', 'source_chars', 'model_identity', 'dimension')):
            raise RunBlocked('PROVENANCE')
    chunks = fallback['chunks']
    config_fields = ('max_chunk_chars', 'overlap_chars', 'min_chunk_chars', 'max_split_depth')
    if (config.get('enabled') is not True or any(type(config.get(k)) is not int for k in config_fields)
            or any(fallback.get(k) != config[k] for k in config_fields)
            or not 0 <= config['overlap_chars'] < config['max_chunk_chars']
            or not 1 <= config['min_chunk_chars'] <= config['max_chunk_chars']
            or not 0 <= config['max_split_depth'] <= 16
            or fallback.get('chunking_version') != config.get('chunking_version')
            or fallback.get('aggregation') != 'length_weighted_mean' or fallback.get('normalization') != 'l2'
            or fallback.get('aggregation_result') != 'PASS' or fallback.get('failed_chunks') != 0
            or fallback.get('chunk_count') != len(chunks) or fallback.get('successful_chunks') != len(chunks)):
        raise RunBlocked('PROVENANCE')
    offsets = []
    for chunk in chunks:
        start, end = chunk['start_offset'], chunk['end_offset']
        if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(source)
                or end - start > config['max_chunk_chars']
                or chunk.get('status') != 'SUCCESS' or chunk.get('chunk_chars') != end - start
                or chunk['chunk_sha256'] != hashlib.sha256(source[start:end].encode()).hexdigest()):
            raise RunBlocked('PROVENANCE')
        offsets.append((start, end))
    weights = effective_weights(offsets, len(source))
    if weights != [chunk.get('effective_weight') for chunk in chunks]:
        raise RunBlocked('PROVENANCE')


def _fingerprint(db, table):
    digest = hashlib.sha256()
    for key, payload in db.execute('SELECT key,payload_hash FROM ' + table + ' ORDER BY key'):
        digest.update((canonical_json([key, payload]) + '\n').encode())
    return digest.hexdigest()


def _job_fingerprint(db):
    digest = hashlib.sha256()
    for key, source, expected_hash, chars, size, status, provenance, method in db.execute(
            'SELECT key,source,source_sha256,source_chars,source_bytes,status,provenance_hash,method '
            'FROM expected_jobs ORDER BY key'):
        raw = source.encode()
        actual_hash = hashlib.sha256(raw).hexdigest()
        if (actual_hash != expected_hash or len(source) != chars or len(raw) != size
                or status != ('SUCCESS' if source else 'SKIPPED_EMPTY')
                or method not in ('DIRECT', 'CHUNK_AGGREGATED') or (not source and method != 'DIRECT')):
            raise RunBlocked('PROVENANCE')
        digest.update((canonical_json([key, actual_hash, chars, size, status, provenance, method]) + '\n').encode())
    return digest.hexdigest()


def index_expected(db_path, nodes, edges, *, contract, provenance, dimension=3072):
    if type(dimension) is not int or not 1 <= dimension <= 65536:
        raise RunBlocked('CONFIG')
    db = sqlite3.connect(db_path)
    try:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS expected_nodes (key TEXT PRIMARY KEY, type TEXT, payload_hash TEXT);
            CREATE TABLE IF NOT EXISTS expected_edges (key TEXT PRIMARY KEY, predicate TEXT, payload_hash TEXT);
            CREATE TABLE IF NOT EXISTS expected_jobs (key TEXT PRIMARY KEY, source TEXT, source_sha256 TEXT,
                source_chars INTEGER, source_bytes INTEGER, status TEXT, provenance_hash TEXT, method TEXT);
            CREATE TABLE IF NOT EXISTS expected_meta (key TEXT PRIMARY KEY, value TEXT);
        ''')
        with db:
            for table in ('expected_nodes', 'expected_edges', 'expected_jobs', 'expected_meta'):
                db.execute('DELETE FROM ' + table)
            for spec in nodes:
                key, payload, sources = _expected_node(spec, contract, dimension)
                db.execute('INSERT INTO expected_nodes VALUES (?,?,?)', (key, spec['type'], payload))
                for prop, text in sources.items():
                    raw = text.encode()
                    db.execute('INSERT INTO expected_jobs VALUES (?,?,?,?,?,NULL,NULL,NULL)',
                        (canonical_json([spec['type'], spec['id'], prop]), text,
                         hashlib.sha256(raw).hexdigest(), len(text), len(raw)))
            for spec in edges:
                key, payload = _expected_edge(spec, contract)
                fields = spec['tuple']
                for type_name, identity in ((fields[0], fields[1]), (fields[3], fields[4])):
                    if not db.execute('SELECT 1 FROM expected_nodes WHERE key=?',
                                      (canonical_json([type_name, identity]),)).fetchone():
                        raise RunBlocked('EDGES')
                db.execute('INSERT INTO expected_edges VALUES (?,?,?)', (key, fields[2], payload))
            model, methods, statuses = None, Counter(), Counter()
            for job in provenance:
                key = canonical_json([job['node_type'], job['node_id'], job['property']])
                row = db.execute('SELECT source,source_sha256,source_chars,source_bytes,status '
                                 'FROM expected_jobs WHERE key=?', (key,)).fetchone()
                if (row is None or row[4] is not None or type(job['dimension']) is not int or job['dimension'] != dimension
                        or [job.get(k) for k in ('source_sha256', 'source_chars', 'source_bytes')] != list(row[1:4])
                        or not isinstance(job.get('model_identity'), str) or not job['model_identity']):
                    raise RunBlocked('PROVENANCE')
                model = model or job['model_identity']
                if job['model_identity'] != model:
                    raise RunBlocked('PROVENANCE')
                expected_status = 'SUCCESS' if row[0] else 'SKIPPED_EMPTY'
                if job['status'] != expected_status or job.get('embedding_method') not in ('DIRECT', 'CHUNK_AGGREGATED'):
                    raise RunBlocked('PROVENANCE')
                if job['embedding_method'] == 'CHUNK_AGGREGATED':
                    if not row[0]:
                        raise RunBlocked('PROVENANCE')
                    _chunks(job, row[0])
                statuses[job['status']] += 1
                if row[0]: methods[job['embedding_method']] += 1
                db.execute('UPDATE expected_jobs SET status=?,provenance_hash=?,method=? WHERE key=?',
                           (job['status'], _digest(job), job['embedding_method'], key))
            if db.execute('SELECT 1 FROM expected_jobs WHERE status IS NULL').fetchone():
                raise RunBlocked('PROVENANCE')
            prov_digest = hashlib.sha256()
            for key, digest in db.execute('SELECT key,provenance_hash FROM expected_jobs ORDER BY key'):
                prov_digest.update((canonical_json([key, digest]) + '\n').encode())
            summary = {'schema_hash': _digest(contract), 'node_fingerprint': _fingerprint(db, 'expected_nodes'),
                'edge_fingerprint': _fingerprint(db, 'expected_edges'), 'provenance_hash': prov_digest.hexdigest(),
                'expected_jobs_fingerprint': _job_fingerprint(db),
                'model_identity': model, 'provenance': {m: methods[m] for m in ('DIRECT', 'CHUNK_AGGREGATED')},
                'vectors': {'candidates': sum(statuses.values()), 'nonempty': statuses['SUCCESS'],
                            'skipped_empty': statuses['SKIPPED_EMPTY'], 'dimension': dimension}}
            db.execute('INSERT INTO expected_meta VALUES (?,?)', ('summary', canonical_json(summary)))
        return summary
    except (BuilderContractError, sqlite3.IntegrityError, KeyError, TypeError, ValueError) as error:
        if isinstance(error, RunBlocked): raise
        raise RunBlocked('PROVENANCE') from None
    finally:
        db.close()


def _valid_index(row, dimension):
    options = row.get('options')
    config = options.get('indexConfig') if isinstance(options, dict) else None
    return (row.get('state') == 'ONLINE' and isinstance(config, dict)
            and type(config.get('vector.dimensions')) is int and config['vector.dimensions'] == dimension
            and isinstance(config.get('vector.similarity_function'), str)
            and config['vector.similarity_function'].lower() == 'cosine')


def _indexes(reader, contract, dimension=3072):
    rows, verified = reader.indexes(), []
    for local, targets in TARGETS.items():
        for _, vector in targets:
            label = contract['namespace'] + '.' + local
            candidates = [r for r in rows if r.get('type') == 'VECTOR'
                          and r.get('labelsOrTypes') == [label] and r.get('properties') == [vector]]
            if not candidates:
                raise RunBlocked('INDEX')
            for row in candidates:
                if not _valid_index(row, dimension):
                    raise RunBlocked('INDEX')
            verified.append({'label': label, 'property': vector, 'state': 'ONLINE', 'dimension': dimension})
    return verified


def _scan_graph(reader, db, contract, batch_size, nodes_only, dimension=3072):
    db.executescript('''
        DROP TABLE IF EXISTS observed_nodes;
        DROP TABLE IF EXISTS observed_edges;
        CREATE TEMP TABLE observed_nodes (key TEXT PRIMARY KEY,physical INTEGER UNIQUE,type TEXT,payload_hash TEXT);
        CREATE TEMP TABLE observed_edges (key TEXT PRIMARY KEY,physical INTEGER UNIQUE,predicate TEXT,payload_hash TEXT);
    ''')
    nodes, edges = Counter(), Counter()
    for batch in reader.iter_nodes(contract['namespace'], batch_size):
        if len(batch) > batch_size:
            raise RunBlocked('NODES')
        for record in batch:
            key, payload, _ = _node(record, contract, dimension)
            row = db.execute('SELECT payload_hash,type FROM expected_nodes WHERE key=?', (key,)).fetchone()
            if row is None or payload != row[0] or type(record.get('physical_id')) is not int:
                raise RunBlocked('NODES')
            db.execute('INSERT INTO observed_nodes VALUES (?,?,?,?)', (key, record['physical_id'], row[1], payload))
            nodes[row[1]] += 1
    if db.execute('SELECT 1 FROM expected_nodes e LEFT JOIN observed_nodes o ON e.key=o.key WHERE o.key IS NULL').fetchone():
        raise RunBlocked('NODES')
    if not nodes_only:
        for batch in reader.iter_edges(contract['namespace'], batch_size):
            if len(batch) > batch_size:
                raise RunBlocked('EDGES')
            for record in batch:
                key, payload = _edge(record, contract)
                row = db.execute('SELECT payload_hash FROM expected_edges WHERE key=?', (key,)).fetchone()
                if row is None or payload != row[0] or type(record.get('physical_id')) is not int:
                    raise RunBlocked('EDGES')
                for endpoint in (record['from'], record['to']):
                    endpoint_key = canonical_json(list(_endpoint(endpoint, contract)))
                    if not db.execute('SELECT 1 FROM observed_nodes WHERE key=? AND physical=?',
                                      (endpoint_key, endpoint['physical_id'])).fetchone():
                        raise RunBlocked('EDGES')
                db.execute('INSERT INTO observed_edges VALUES (?,?,?,?)',
                           (key, record['physical_id'], record['predicate'], payload))
                edges[record['predicate']] += 1
        if db.execute('SELECT 1 FROM expected_edges e LEFT JOIN observed_edges o ON e.key=o.key WHERE o.key IS NULL').fetchone():
            raise RunBlocked('EDGES')
    return {'nodes': {'total': sum(nodes.values()), 'by_type': dict(sorted(nodes.items()))},
            'edges': {'total': sum(edges.values()), 'by_predicate': dict(sorted(edges.items()))},
            'node_fingerprint': _fingerprint(db, 'observed_nodes'),
            'edge_fingerprint': _fingerprint(db, 'observed_edges') if not nodes_only else None}


def verify_graph(reader, *, db_path, contract, batch_size, nodes_only=False):
    _batch_size(batch_size)
    path = Path(db_path).resolve()
    if not path.is_file():
        raise RunBlocked('INTEGRITY')
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        db.execute('PRAGMA temp_store=FILE')
        row = db.execute('SELECT value FROM expected_meta WHERE key=\'summary\'').fetchone()
        if row is None:
            raise RunBlocked('INTEGRITY')
        summary = json.loads(row[0])
        if summary['schema_hash'] != _digest(contract):
            raise RunBlocked('INTEGRITY')
        if (summary['node_fingerprint'] != _fingerprint(db, 'expected_nodes')
                or summary['edge_fingerprint'] != _fingerprint(db, 'expected_edges')
                or summary['expected_jobs_fingerprint'] != _job_fingerprint(db)):
            raise RunBlocked('INTEGRITY')
        dimension = summary['vectors']['dimension']
        if type(dimension) is not int or not 1 <= dimension <= 65536:
            raise RunBlocked('INTEGRITY')
        first = _scan_graph(reader, db, contract, batch_size, nodes_only, dimension)
        indexes = _indexes(reader, contract, dimension)
        second = _scan_graph(reader, db, contract, batch_size, nodes_only, dimension)
        if first != second or indexes != _indexes(reader, contract, dimension):
            raise RunBlocked('INTEGRITY')
        result = dict(summary, **first, indexes=indexes, nodes_only=nodes_only)
        result['fingerprint'] = _digest(result)
        return result
    except (BuilderContractError, sqlite3.DatabaseError, KeyError, TypeError, ValueError) as error:
        if isinstance(error, RunBlocked): raise
        raise RunBlocked('INTEGRITY') from None
    finally:
        db.close()


def verify_batch(reader, specs, *, kind, contract, dimension=3072):
    try:
        if kind == 'nodes':
            expected = [_expected_node(spec, contract, dimension)[:2] for spec in specs]
            records = reader.read_nodes([[spec['type'], spec['id']] for spec in specs])
            actual = [_node(record, contract, dimension)[:2] for record in records]
        elif kind == 'edges':
            expected = [_expected_edge(spec, contract) for spec in specs]
            records = reader.read_edges([spec['tuple'] for spec in specs])
            actual = [_edge(record, contract) for record in records]
        else:
            raise RunBlocked('CONFIG')
        if len(set(expected)) != len(expected) or sorted(actual) != sorted(expected):
            raise RunBlocked('NODES' if kind == 'nodes' else 'EDGES')
        return {'confirmed': len(specs), 'fingerprint': _digest(sorted(actual)), 'state': 'CONFIRMED_EXISTING'}
    except (BuilderContractError, KeyError, TypeError, ValueError) as error:
        if isinstance(error, RunBlocked): raise
        raise RunBlocked('INTEGRITY') from None
