"""Exact read-only graph verification, using real schema/codec and network seams."""
import copy
import hashlib
import importlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from kag.builder.codec import canonical_json, encode_properties
from kag.builder.mapping import application_edge_key
from kag.builder.resilient_vectorizer import TARGETS


ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT / 'kag/schema/schema_contract.json').read_bytes())
MODEL = 'https://embedding.invalid/v1|example-model'


def fixture():
    nodes, jobs = [], []
    for local, identity in [('LegalDocument', 'D1'), ('LegalUnit', 'D1::D1'), ('TrafficSign', 'QCVN::P1')]:
        logical = {}
        for row in CONTRACT['node_properties'][local]:
            if not row['required']:
                continue
            kind, name = row['contract_type'], row['logical_name']
            logical[name] = ({'path': 'source.jsonl', 'line': 1} if kind == 'JSON_TEXT' else
                             7 if kind == 'INTEGER' else False if kind == 'BOOLEAN_ENCODING' else 'nguồn tiếng Việt ạ')
        logical.update(id=identity, name=identity)
        if local == 'LegalUnit':
            logical['unit_type'] = 'Dieu'
        if local == 'TrafficSign':
            logical['ten'] = ''
        props = encode_properties(logical, CONTRACT['node_properties'][local])
        props.pop('id'); props.pop('name')
        node = {'type': 'VietRoadTraffic.' + local, 'id': identity, 'name': identity, 'properties': props}
        for prop, vector in TARGETS[local]:
            text = props.get(prop, '')
            job = dict(node_type=node['type'], node_id=identity, property=prop,
                       source_sha256=hashlib.sha256(text.encode()).hexdigest(),
                       source_chars=len(text), source_bytes=len(text.encode()),
                       model_identity=MODEL, dimension=3072, embedding_method='DIRECT',
                       status='SUCCESS' if text else 'SKIPPED_EMPTY')
            if text:
                props[vector] = [0.01] * 3072
            if local == 'LegalUnit':
                job['embedding_method'] = 'CHUNK_AGGREGATED'
                job['direct_failure'] = dict(job, embedding_method='DIRECT', status='FAILED_EXHAUSTED')
                job['fallback_config'] = {'enabled': True, 'max_chunk_chars': 8000, 'overlap_chars': 500,
                    'min_chunk_chars': 1000, 'max_split_depth': 3, 'chunking_version': 'boundary_offsets_v1'}
                job['fallback'] = {k: job[k] for k in ('node_type', 'node_id', 'property', 'source_sha256',
                    'source_chars', 'model_identity', 'dimension')}
                job['fallback'].update({k: v for k, v in job['fallback_config'].items()
                                        if k not in ('enabled', 'chunking_version')})
                job['fallback'].update(chunking_version='boundary_offsets_v1', chunk_count=1,
                    successful_chunks=1, failed_chunks=0, aggregation='length_weighted_mean',
                    normalization='l2', aggregation_result='PASS', chunks=[dict(start_offset=0,
                    end_offset=len(text), chunk_sha256=job['source_sha256'], chunk_chars=len(text),
                    status='SUCCESS', effective_weight=len(text))])
            jobs.append(job)
        nodes.append(node)
    fields = [nodes[0]['type'], nodes[0]['id'], 'hasUnit', nodes[1]['type'], nodes[1]['id']]
    edge = {'tuple': fields, 'application_edge_key': application_edge_key(fields),
            'properties': encode_properties({'source_record': {'path': 'source.jsonl', 'line': 1}},
                                             CONTRACT['relation_properties']['hasUnit'])}
    return nodes, [edge], jobs


def graph_node(spec, physical_id):
    return {'physical_id': physical_id, 'labels': ['Entity', spec['type']],
            'properties': dict(copy.deepcopy(spec['properties']), id=spec['id'], name=spec['name'])}


class GraphReader:
    """Boundary-only fake; real verifier compares these physical records."""
    def __init__(self, nodes, edges):
        self.nodes = [graph_node(n, i) for i, n in enumerate(nodes)]
        self.edges = [dict(physical_id=i, predicate=e['tuple'][2], properties=e['properties'],
                           **{'from': self.nodes[0], 'to': self.nodes[1]}) for i, e in enumerate(edges)]
        self.index_rows = [dict(name=vector, type='VECTOR', state='ONLINE',
            labelsOrTypes=['VietRoadTraffic.' + local], properties=[vector],
            options={'indexConfig': {'vector.dimensions': 3072, 'vector.similarity_function': 'cosine'}})
            for local, targets in TARGETS.items() for _, vector in targets]
        self.max_batch = 0
        self.scans = 0

    def iter_nodes(self, namespace, batch_size):
        self.scans += 1
        for i in range(0, len(self.nodes), batch_size):
            batch = self.nodes[i:i + batch_size]
            self.max_batch = max(self.max_batch, len(batch))
            yield batch

    def iter_edges(self, namespace, batch_size):
        for i in range(0, len(self.edges), batch_size):
            yield self.edges[i:i + batch_size]

    def indexes(self):
        return self.index_rows

    def read_nodes(self, keys):
        return [n for n in self.nodes if any(label in n['labels'] and n['properties'].get('id') == identity
                                           for label, identity in keys)]

    def read_edges(self, keys):
        return [e for e in self.edges if any(k[0] in e['from']['labels'] and k[1] == e['from']['properties']['id']
                    and k[2] == e['predicate'] and k[3] in e['to']['labels'] and k[4] == e['to']['properties']['id']
                    for k in keys)]


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'expected.sqlite3'
        self.nodes, self.edges, self.jobs = fixture()
        self.reader = GraphReader(self.nodes, self.edges)

    def api(self):
        self.assertTrue((ROOT / 'kag/verify.py').is_file(), 'read-only verifier implementation missing')
        return importlib.import_module('kag.verify')

    def index(self, **kwargs):
        return self.api().index_expected(self.db, iter(self.nodes), iter(self.edges),
                    contract=CONTRACT, provenance=iter(kwargs.get('jobs', self.jobs)))

    def verify(self, **kwargs):
        return self.api().verify_graph(self.reader, db_path=self.db, contract=CONTRACT, batch_size=1, **kwargs)

    def test_exact_graph_vectors_provenance_and_sorted_fingerprint(self):
        self.index()
        first = self.verify()
        self.reader.nodes.reverse(); self.reader.edges.reverse()
        second = self.verify()
        self.assertEqual(first['fingerprint'], second['fingerprint'])
        self.assertEqual(first['nodes']['total'], 3)
        self.assertEqual(first['edges']['total'], 1)
        self.assertEqual(first['vectors'], {'candidates': 4, 'nonempty': 3, 'skipped_empty': 1, 'dimension': 3072})
        self.assertEqual(first['provenance'], {'DIRECT': 2, 'CHUNK_AGGREGATED': 1})
        self.assertLessEqual(self.reader.max_batch, 1)

    def test_missing_extra_and_duplicate_nodes_across_batch_boundaries_block(self):
        api = self.api()
        self.index()
        for kind in ('missing', 'extra', 'duplicate'):
            with self.subTest(kind=kind):
                self.reader = GraphReader(self.nodes, self.edges)
                if kind == 'missing': self.reader.nodes.pop()
                else:
                    extra = copy.deepcopy(self.reader.nodes[0]); extra['physical_id'] = 999
                    if kind == 'extra': extra['properties'].update(id='EXTRA', name='EXTRA')
                    self.reader.nodes.append(extra)
                with self.assertRaises(api.RunBlocked): self.verify()

    def test_missing_extra_duplicate_and_cross_namespace_edges_block(self):
        api = self.api()
        self.index()
        for kind in ('missing', 'extra', 'duplicate', 'foreign', 'orphan', 'stub', 'degraded'):
            with self.subTest(kind=kind):
                self.reader = GraphReader(self.nodes, self.edges)
                if kind == 'missing': self.reader.edges.clear()
                elif kind in ('extra', 'duplicate'):
                    extra = copy.deepcopy(self.reader.edges[0]); extra['physical_id'] = 999
                    if kind == 'extra': extra['predicate'] = 'citesUnit'
                    self.reader.edges.append(extra)
                else:
                    target = copy.deepcopy(self.reader.edges[0]['to'])
                    self.reader.edges[0]['to'] = target
                    if kind == 'foreign': target['labels'] = ['Foreign.LegalUnit']
                    if kind == 'orphan': target['physical_id'] = 999
                    if kind == 'stub': target['properties'] = {'id': 'D1::D1', 'name': 'D1::D1'}
                    if kind == 'degraded': target['properties']['degraded'] = True
                with self.assertRaises(api.RunBlocked): self.verify()

    def test_required_properties_native_integer_json_and_identity_are_exact(self):
        api = self.api()
        self.index()
        for mutation in ({'order': '7'}, {'order': True}, {'order': 7.0}, {'text': None},
                         {'name': 'WRONG'}, {'sourceRecord': '{bad'}, {'unitType': 'INVENTED'},
                         {'text': 'source changed'}, {'degraded': True}, {'stub': True}):
            with self.subTest(mutation=mutation):
                self.reader = GraphReader(self.nodes, self.edges)
                self.reader.nodes[1]['properties'].update(mutation)
                with self.assertRaises(api.RunBlocked): self.verify()

    def test_vectors_require_exact_finite_content_and_empty_fields_stay_empty(self):
        api = self.api()
        self.index()
        for kind in ('missing', 'short', 'nan', 'bool', 'changed', 'name', 'empty-source'):
            with self.subTest(kind=kind):
                self.reader = GraphReader(self.nodes, self.edges)
                props = self.reader.nodes[1]['properties']
                if kind == 'missing': props.pop('_text_vector')
                if kind == 'short': props['_text_vector'] = [0.1]
                if kind == 'nan': props['_text_vector'][0] = float('nan')
                if kind == 'bool': props['_text_vector'][0] = True
                if kind == 'changed': props['_text_vector'][0] = 0.99
                if kind == 'name': props['_name_vector'] = [0.01] * 3072
                if kind == 'empty-source': self.reader.nodes[2]['properties']['_ten_vector'] = [0.01] * 3072
                with self.assertRaises(api.RunBlocked): self.verify()

    def test_signed_zero_serialization_is_semantic_equal_without_numeric_tolerance(self):
        self.nodes[1]['properties']['_text_vector'][0] = -0.0
        self.index()
        self.reader = GraphReader(self.nodes, self.edges)
        self.reader.nodes[1]['properties']['_text_vector'][0] = 0.0
        result = self.verify()
        self.assertEqual(result['vectors']['nonempty'], 3)
        self.reader.nodes[1]['properties']['_text_vector'][0] = 1e-20
        with self.assertRaises(self.api().RunBlocked): self.verify()

    def test_all_four_online_content_indexes_are_required(self):
        api = self.api()
        self.index()
        for kind in ('missing', 'offline', 'dimension', 'bool-dimension', 'name-only', 'foreign-label'):
            with self.subTest(kind=kind):
                self.reader = GraphReader(self.nodes, self.edges)
                index = self.reader.index_rows[0]
                if kind == 'missing': self.reader.index_rows.pop(0)
                if kind == 'offline': index['state'] = 'POPULATING'
                if kind == 'dimension': index['options']['indexConfig']['vector.dimensions'] = 1536
                if kind == 'bool-dimension': index['options']['indexConfig']['vector.dimensions'] = True
                if kind == 'name-only': index['properties'] = ['_name_vector']
                if kind == 'foreign-label': index['labelsOrTypes'] = ['Foreign.LegalDocument']
                with self.assertRaises(api.RunBlocked): self.verify()

    def test_similarity_is_a_required_case_insensitive_string(self):
        api = self.api()
        for value in ('cosine', 'COSINE', 'Cosine'):
            for row in self.reader.index_rows:
                row['options']['indexConfig']['vector.similarity_function'] = value
            self.assertEqual(len(api._indexes(self.reader, CONTRACT)), 4)
        for value in (None, True, 3072, {}, [], 'euclidean', ''):
            with self.subTest(value=value):
                self.reader.index_rows[0]['options']['indexConfig']['vector.similarity_function'] = value
                with self.assertRaises(api.RunBlocked): api._indexes(self.reader, CONTRACT)
        del self.reader.index_rows[0]['options']['indexConfig']['vector.similarity_function']
        with self.assertRaises(api.RunBlocked): api._indexes(self.reader, CONTRACT)
        for value in (None, [], 'invalid'):
            self.reader.index_rows[0]['options'] = value
            with self.assertRaises(api.RunBlocked): api._indexes(self.reader, CONTRACT)

    def test_source_model_dimension_chunk_and_duplicate_provenance_block(self):
        api = self.api()
        for kind in ('source', 'model', 'dimension', 'method', 'chunk-hash', 'chunk-offset', 'missing', 'duplicate'):
            with self.subTest(kind=kind):
                jobs = copy.deepcopy(self.jobs)
                if kind == 'source': jobs[1]['source_sha256'] = '0' * 64
                if kind == 'model': jobs[1]['model_identity'] = 'other-model'
                if kind == 'dimension': jobs[1]['dimension'] = 1536
                if kind == 'method': jobs[1]['embedding_method'] = 'GUESSED'
                if kind == 'chunk-hash': jobs[1]['fallback']['chunks'][0]['chunk_sha256'] = '0' * 64
                if kind == 'chunk-offset': jobs[1]['fallback']['chunks'][0]['end_offset'] -= 1
                if kind == 'missing': jobs.pop(0)
                if kind == 'duplicate': jobs.append(copy.deepcopy(jobs[0]))
                with self.assertRaises(api.RunBlocked): self.index(jobs=jobs)

    def test_expected_duplicate_identity_and_wrong_edge_key_are_rejected(self):
        api = self.api()
        self.nodes.append(copy.deepcopy(self.nodes[0]))
        with self.assertRaises(api.RunBlocked): self.index()
        self.nodes.pop()
        self.edges[0]['application_edge_key'] = '0' * 64
        with self.assertRaises(api.RunBlocked): self.index()

    def test_aggregate_metadata_must_match_source_size_and_chunk_config(self):
        api = self.api()
        for field in ('source_chars', 'max_chunk_chars', 'overlap_chars', 'max_split_depth'):
            with self.subTest(field=field):
                jobs = copy.deepcopy(self.jobs)
                jobs[1]['fallback'][field] += 1
                with self.assertRaises(api.RunBlocked): self.index(jobs=jobs)

    def test_node_only_barrier_and_exact_batch_confirmation(self):
        self.index()
        self.reader.edges.clear()
        result = self.verify(nodes_only=True)
        self.assertEqual(result['nodes']['total'], 3)
        self.assertEqual(self.api().verify_batch(self.reader, self.nodes[:1], kind='nodes',
                                              contract=CONTRACT)['confirmed'], 1)
        with self.assertRaises(self.api().RunBlocked):
            self.api().verify_batch(self.reader, self.edges, kind='edges', contract=CONTRACT)

    def test_concurrent_graph_divergence_blocks_second_scan(self):
        self.index()
        original = self.reader.iter_nodes
        def divergent(namespace, batch_size):
            if self.reader.scans:
                self.reader.nodes[0]['properties']['title'] = 'changed during verify'
            yield from original(namespace, batch_size)
        self.reader.iter_nodes = divergent
        with self.assertRaises(self.api().RunBlocked): self.verify()

    def test_mutated_expected_ledger_cannot_publish_new_fingerprint_as_pass(self):
        self.index()
        changed = copy.deepcopy(self.nodes[0])
        changed['properties']['title'] = 'corrupted expected source'
        self.reader.nodes[0] = graph_node(changed, 0)
        key, payload, _ = self.api()._expected_node(changed, CONTRACT)
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE expected_nodes SET payload_hash=? WHERE key=?', (payload, key))
        with self.assertRaises(self.api().RunBlocked): self.verify()

    def test_mutated_job_source_and_method_are_detected_against_index_receipt(self):
        self.index()
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE expected_jobs SET method=\'DIRECT\',source=\'mutated\' WHERE method=\'CHUNK_AGGREGATED\'')
        with self.assertRaises(self.api().RunBlocked): self.verify()

    def test_missing_expected_database_blocks_without_creating_empty_file(self):
        api = self.api()
        with self.assertRaises(api.RunBlocked): self.verify()
        self.assertFalse(self.db.exists())


class Neo4jHttpTests(unittest.TestCase):
    def api(self):
        self.assertTrue((ROOT / 'kag/verify.py').is_file(), 'read-only verifier implementation missing')
        return importlib.import_module('kag.verify')

    def client(self, **kwargs):
        return self.api().Neo4jReadClient(kwargs.get('endpoint', 'http://127.0.0.1:27474'),
              kwargs.get('database', 'vietroadtraffic'), username='neo4j', password='SECRET_NEVER_LOG', timeout=5)

    def response(self, values):
        columns = list(values[0]) if values else ['physical_id', 'labels', 'properties']
        return io.BytesIO(json.dumps({'errors': [], 'results': [{'columns': columns,
            'data': [{'row': [row[key] for key in columns]} for row in values]}]}).encode())

    def test_physical_cursor_namespace_and_batch_limit_are_parameterized(self):
        client = self.client()
        requests = []
        rows = [{'physical_id': 17, 'labels': ['Entity', 'VietRoadTraffic.LegalUnit'], 'properties': {'id': 'x'}}]
        def transport(request, **kwargs):
            body = json.loads(request.data); requests.append(body['statements'][0])
            return self.response(rows if len(requests) == 1 else [])
        with patch.object(client._opener, 'open', side_effect=transport):
            batches = list(client.iter_nodes('VietRoadTraffic', 1))
        self.assertEqual(batches, [rows])
        self.assertEqual(requests[0]['parameters']['limit'], 1)
        self.assertEqual(requests[1]['parameters']['cursor'], 17)
        self.assertNotIn('SKIP', requests[0]['statement'])
        self.assertEqual(requests[0]['parameters']['namespace'], 'VietRoadTraffic.')
        self.assertNotIn('SECRET_NEVER_LOG', canonical_json(requests))

    def test_queries_are_allowlisted_and_invalid_targets_are_rejected(self):
        api = self.api()
        client = self.client()
        with self.assertRaises(api.RunBlocked): client._query('CREATE (n)')
        for endpoint in ('http://user:secret@localhost:27474', 'http://localhost:27474?key=secret'):
            with self.assertRaises(api.RunBlocked): self.client(endpoint=endpoint)
        with self.assertRaises(api.RunBlocked): self.client(database='../escape')

    def test_database_identity_requires_one_online_server_id(self):
        api = self.api()
        client = self.client()
        valid = {'name': 'vietroadtraffic', 'databaseID': 'actual-server-id', 'currentStatus': 'online'}
        with patch.object(client._opener, 'open', return_value=self.response([valid])):
            self.assertEqual(client.database_identity(), 'actual-server-id')
        for rows in ([], [dict(valid, databaseID=None)], [valid, valid], [dict(valid, currentStatus='offline')]):
            with self.subTest(rows=rows), patch.object(client._opener, 'open', return_value=self.response(rows)):
                with self.assertRaises(api.RunBlocked): client.database_identity()

    def test_transport_and_neo4j_errors_are_sanitized(self):
        client = self.client()
        with patch.object(client._opener, 'open', side_effect=TimeoutError('SECRET_NEVER_LOG')):
            with self.assertRaises(RuntimeError) as error: list(client.iter_nodes('VietRoadTraffic', 1))
        self.assertNotIn('SECRET_NEVER_LOG', str(error.exception))

    def test_openspg_storage_json_envelope_is_decoded_once_before_schema_checks(self):
        api = self.api(); client = self.client()
        nodes, edges, _ = fixture()
        raw = [graph_node(node, i) for i, node in enumerate(nodes)]
        for record in raw:
            record['properties'] = {key: value if key == 'id' or key.endswith('_vector') else canonical_json(value)
                                    for key, value in record['properties'].items()}
        with patch.object(client._opener, 'open', return_value=self.response(raw)):
            self.assertEqual(api.verify_batch(client, nodes, kind='nodes', contract=CONTRACT)['confirmed'], 3)
        raw[1]['properties']['order'] = canonical_json('7')  # decoded Text cannot satisfy native Integer
        with patch.object(client._opener, 'open', return_value=self.response(raw)):
            with self.assertRaises(api.RunBlocked): api.verify_batch(client, nodes, kind='nodes', contract=CONTRACT)
        raw[1]['properties']['order'] = '7'
        raw[0]['properties']['name'] = canonical_json(canonical_json(nodes[0]['name']))
        with patch.object(client._opener, 'open', return_value=self.response(raw)):
            with self.assertRaises(api.RunBlocked): api.verify_batch(client, nodes, kind='nodes', contract=CONTRACT)

    def test_edge_properties_and_compact_endpoint_names_use_same_storage_boundary(self):
        api = self.api(); client = self.client()
        nodes, edges, _ = fixture()
        edge = GraphReader(nodes, edges).edges[0]
        record = {'physical_id': edge['physical_id'], 'predicate': edge['predicate'],
                  'properties': {key: canonical_json(value) for key, value in edge['properties'].items()}}
        for side, column in (('from', 'from_node'), ('to', 'to_node')):
            node = edge[side]
            record[column] = dict(node, property_keys=list(node['properties']),
                properties={'id': node['properties']['id'], 'name': canonical_json(node['properties']['name']),
                            'stub': None, 'degraded': None})
        with patch.object(client._opener, 'open', return_value=self.response([record])):
            self.assertEqual(api.verify_batch(client, edges, kind='edges', contract=CONTRACT)['confirmed'], 1)
        response = io.BytesIO(b'{"errors":[{"message":"SECRET_NEVER_LOG"}],"results":[]}')
        with patch.object(client._opener, 'open', return_value=response):
            with self.assertRaises(RuntimeError) as error: client.indexes()
        self.assertNotIn('SECRET_NEVER_LOG', str(error.exception))


if __name__ == '__main__':
    unittest.main()
