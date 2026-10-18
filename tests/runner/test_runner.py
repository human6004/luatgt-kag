"""Runner preflight uses real pinned SDK discovery and builder scope proofs."""
import copy
import hashlib
import importlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from kag.builder.codec import canonical_json
from kag.builder.graph_plan import plan_hash
from kag.builder import production_scope as scope
from kag.run_state import GraphLock, RunBlocked
from test_verify import CONTRACT, MODEL, fixture, GraphReader


ROOT = Path(__file__).resolve().parents[2]


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Projects:
    def __init__(self, endpoint, records):
        self._host_addr = endpoint
        self.records = records
        for record in self.records:
            record.setdefault('config', {'graph_store':{'uri':'neo4j://neo:7687',
                'database':'VietRoadTraffic','user':'fixture','password':'fixture-secret'}})
        self._rest_client = self
        self.reads = 0

    def get(self, **conditions):
        self.reads += 1
        return next((r for r in self.records if str(r['id']) == str(conditions['id'])), None)

    def project_get(self):
        self.reads += 1
        return self.records


class Database:
    def __init__(self, identity='physical-fixture-db'):
        self.identity = identity

    def database_identity(self):
        return self.identity

    def database_metadata(self):
        return {'name':'vietroadtraffic','databaseID':self.identity,
                'serverID':'fixture-server','currentStatus':'online'}


class RunnerPreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from kag.bootstrap import initialize
        initialize()
        cls.adapter = importlib.import_module('kag.builder.writer_adapter')

    def setUp(self):
        schema = patch('kag.runner._check_target_layout')
        schema.start(); self.addCleanup(schema.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.nodes, self.edges, self.jobs = fixture()
        document = next('D' + str(i) for i in range(100)
                        if int(hashlib.sha256(('D' + str(i)).encode()).hexdigest(), 16) % 10 == 5)
        replacements = {'D1': document, 'D1::D1': document + '::D1'}
        for node in self.nodes:
            node['id'] = node['name'] = replacements.get(node['id'], node['id'])
            if 'docId' in node['properties']: node['properties']['docId'] = document
            if 'unitId' in node['properties']: node['properties']['unitId'] = document + '::D1'
        from kag.builder.mapping import application_edge_key
        self.edges[0]['tuple'][1], self.edges[0]['tuple'][4] = document, document + '::D1'
        self.edges[0]['application_edge_key'] = application_edge_key(self.edges[0]['tuple'])
        self.originals = [dict(n, properties={k: v for k, v in n['properties'].items() if not k.startswith('_')})
                          for n in self.nodes]
        for name, records in (('nodes', self.originals), ('edges', self.edges)):
            (self.root / (name + '.jsonl')).write_text(''.join(canonical_json(r) + '\n' for r in records),
                                                     encoding='utf-8', newline='\n')
        schema_dir = self.root / 'kag/schema'
        schema_dir.mkdir(parents=True)
        for filename in ('VietRoadTraffic.schema', 'schema_contract.json'):
            (schema_dir / filename).write_bytes((ROOT / 'kag/schema' / filename).read_bytes())
        (self.root / 'fixture.txt').write_bytes(b'fixture')
        inputs = [{'name': 'fixture.txt', 'sha256': checksum(self.root / 'fixture.txt')}]
        pins = dict(scope.C3_IDENTITY)
        pins.update(nodes_jsonl_sha256=checksum(self.root / 'nodes.jsonl'),
                    edges_jsonl_sha256=checksum(self.root / 'edges.jsonl'))
        pins['plan_sha256'] = plan_hash(SimpleNamespace(nodes=self.originals, edges=self.edges,
            input_manifest=inputs, schema_sha256=pins['schema_sha256'], contract_sha256=pins['contract_sha256']))
        manifest = dict(pins, input_manifest=inputs, node_counts={'LegalDocument': 1, 'LegalUnit': 1, 'TrafficSign': 1},
                        edge_unique_counts={'hasUnit': 1})
        (self.root / 'manifest.json').write_text(canonical_json(manifest), encoding='utf-8')
        (self.root / 'plan.sha256').write_text(pins['plan_sha256'] + '\n', encoding='ascii')
        policy = dict(self.adapter._C43A_POLICY, nodes=3, edges=1,
            nodes_sha256=hashlib.sha256(''.join('\t'.join(k) + '\n' for k in
                        sorted((n['type'], n['id']) for n in self.originals)).encode()).hexdigest(),
            edges_sha256=hashlib.sha256(''.join(canonical_json(tuple(e['tuple'])) + '\n'
                        for e in sorted(self.edges, key=lambda e: e['tuple'])).encode()).hexdigest())
        sample = dict(chosen_partition=5, partition_algorithm="int(sha256(doc_id.encode('utf-8')).hexdigest(),16) % 10",
            selected_document_ids=[document], counts_by_type=dict(manifest['node_counts'], total=3), total_edges=1,
            selected_node_identity_sha256=policy['nodes_sha256'], selected_edge_tuple_sha256=policy['edges_sha256'],
            c3_sha256={'nodes': pins['nodes_jsonl_sha256'], 'edges': pins['edges_jsonl_sha256'], 'plan': pins['plan_sha256']})
        (self.root / 'sample.json').write_text(canonical_json(sample), encoding='utf-8')
        (self.root / 'vectors.jsonl').write_text(''.join(canonical_json(n) + '\n' for n in self.nodes), encoding='utf-8')
        for job in self.jobs:
            job['node_id'] = replacements.get(job['node_id'], job['node_id'])
            if job.get('embedding_method') == 'CHUNK_AGGREGATED':
                for key in ('fallback', 'direct_failure'):
                    job[key]['node_id'] = job['node_id']
        (self.root / 'provenance.json').write_text(canonical_json({'model_identity': MODEL, 'dimension': 3072,
                                                              'jobs': self.jobs}), encoding='utf-8')
        (self.root / 'chunks.json').write_text(canonical_json({'version': 'boundary_offsets_v1',
            'sources': [job['fallback'] for job in self.jobs if 'fallback' in job], 'source_count': 1}), encoding='utf-8')
        with sqlite3.connect(self.root / 'old-checkpoint.sqlite3') as db:
            db.execute('CREATE TABLE jobs (identity TEXT PRIMARY KEY,state TEXT NOT NULL)')
        paths = {'c3_manifest': str(self.root / 'manifest.json'), 'sample_manifest': str(self.root / 'sample.json'),
            'vector_artifact': str(self.root / 'vectors.jsonl'), 'provenance': str(self.root / 'provenance.json'),
            'chunk_manifest': str(self.root / 'chunks.json'), 'source_checkpoint': str(self.root / 'old-checkpoint.sqlite3'),
            'run_root': str(self.root / 'runs'), 'lock_root': '/run/kag-locks'}
        self.config = dict(scope='C4_3A_MANIFEST_SAMPLE', runtime_location='host',
            endpoints={'openspg': 'http://127.0.0.1:28887', 'neo4j_http': 'http://127.0.0.1:27474',
                       'neo4j_uri': 'bolt://127.0.0.1:27687'}, database='vietroadtraffic', project_id=2,
            project_name='VietRoadTrafficC43A10Pct', namespace='VietRoadTraffic', vector_dimensions=3072,
            confirmation=None, paths=paths, input_sha256={k: checksum(Path(paths[k])) for k in paths
                                                         if k not in ('run_root', 'lock_root')},
            batch_size=2, heartbeat_seconds=5, write_mode='NO_OP', vector_policy='replay-existing',
            model_identity=MODEL, embedding_model=None, fallback_config=self.jobs[1]['fallback_config'],
            credential_env={'neo4j_username': 'TEST_NEO4J_USER', 'neo4j_password': 'TEST_NEO4J_PASSWORD',
                            'embedding_key': 'TEST_EMBEDDING_KEY'})
        self.pins = pins
        self.projects = Projects(self.config['endpoints']['openspg'], [{'id': '2',
            'name': self.config['project_name'], 'namespace': 'VietRoadTraffic'}])
        from kag.backend_identity import DockerBackendTransport
        metadata = Database().database_metadata()
        binding = patch.object(DockerBackendTransport, 'read',
            side_effect=lambda transport_store, verifier: (dict(metadata), ('fixture-runtime',)))
        binding.start(); self.addCleanup(binding.stop)
        for target in (patch.object(scope, 'C3_IDENTITY', pins), patch.object(scope, 'ROOT', self.root),
                       patch.object(scope, 'ARTIFACT_HASHES', (('fixture.txt', inputs[0]['sha256']),)),
                       patch.object(self.adapter, '_C43A_POLICY', policy)):
            target.start(); self.addCleanup(target.stop)

    def api(self):
        self.assertTrue((ROOT / 'kag/runner.py').is_file(), 'runner preflight implementation missing')
        return importlib.import_module('kag.runner')

    def preflight(self, config=None, reader=None):
        return self.api().preflight(config or self.config, project_client=self.projects, reader=reader or Database())

    def test_common_c3_validator_has_no_production_authority(self):
        helper = getattr(scope, 'validate_c3_manifest', None)
        self.assertTrue(callable(helper), 'shared data-only C3 validator missing')
        verified = helper(CONTRACT, self.root / 'manifest.json')
        self.assertEqual(list(verified['nodes']), self.originals)
        self.assertNotIn('settings', verified)
        self.assertNotIn('_proof', verified)

    def test_preflight_returns_shared_backend_proof(self):
        verified = self.preflight()
        self.assertIs(verified['backend_proof'], verified['writer_config'].backend_proof)
        self.assertEqual(verified['identity']['backend_identity']['physical_database_id'],
                         verified['database_id'])

    def test_c3_streams_jsonl_into_disk_sequences_and_hash_mappings(self):
        original = Path.read_bytes
        def no_whole_jsonl(path):
            if path.name in ('nodes.jsonl', 'edges.jsonl'):
                raise AssertionError('whole corpus read_bytes is forbidden')
            return original(path)
        with patch.object(Path, 'read_bytes', no_whole_jsonl):
            data = scope.validate_c3_manifest(CONTRACT, self.root / 'manifest.json',
                                              db_path=self.root / 'validation.sqlite3')
        for kind in ('nodes', 'edges'):
            self.assertNotIsInstance(data[kind], (list, tuple))
            self.assertNotIsInstance(data[kind[:-1] + '_hashes'], dict)
        self.assertEqual(list(data['nodes']), self.originals)
        self.assertEqual(list(data['edges']), self.edges)
        self.assertTrue((self.root / 'validation.sqlite3').is_file())

    def test_streaming_plan_hash_equals_old_canonical_semantic_bytes(self):
        plan = SimpleNamespace(nodes=iter(self.originals), edges=iter(self.edges),
            input_manifest=[{'name': 'fixture.txt', 'sha256': checksum(self.root / 'fixture.txt')}],
            schema_sha256=self.pins['schema_sha256'], contract_sha256=self.pins['contract_sha256'])
        old_payload = dict(nodes=self.originals, edges=self.edges, inputs=list(plan.input_manifest),
            schema_sha256=plan.schema_sha256, contract_sha256=plan.contract_sha256)
        old_hash = hashlib.sha256(canonical_json(old_payload).encode()).hexdigest()
        from kag.builder import graph_plan
        with patch.object(graph_plan, '_hash_payload', side_effect=AssertionError('no corpus lists')):
            self.assertEqual(graph_plan.plan_hash(plan), old_hash)

    def test_disk_hash_proof_is_read_only_after_validation(self):
        data = scope.validate_c3_manifest(CONTRACT, self.root / 'manifest.json')
        with self.assertRaises(sqlite3.OperationalError):
            data['index'].db.execute("UPDATE c3_sources SET source_hash=?", ('0'*64,))

    def test_external_disk_hash_proof_tamper_blocks_production_revalidation(self):
        config = self.production(); config['write_mode'] = 'NO_OP'
        proof = self.preflight(config)['writer_config'].production_scope
        with sqlite3.connect(proof.node_hashes.index.path) as db:
            db.execute("UPDATE c3_sources SET source_hash=?", ('0'*64,))
        with self.assertRaises(ValueError): proof.verify_files(CONTRACT)

    def test_disk_validation_rejects_duplicates_and_orphan_after_hash_rebinding(self):
        for kind in ('duplicate-node', 'duplicate-edge', 'orphan'):
            nodes, edges = copy.deepcopy(self.originals), copy.deepcopy(self.edges)
            if kind == 'duplicate-node': nodes.append(copy.deepcopy(nodes[0]))
            if kind == 'duplicate-edge': edges.append(copy.deepcopy(edges[0]))
            if kind == 'orphan': edges[0]['tuple'][4] = 'missing-endpoint'
            for name, records in (('nodes', nodes), ('edges', edges)):
                (self.root / (name + '.jsonl')).write_text(''.join(canonical_json(r)+'\n' for r in records), encoding='utf-8')
                self.pins[name + '_jsonl_sha256'] = checksum(self.root / (name + '.jsonl'))
            self.pins['plan_sha256'] = plan_hash(SimpleNamespace(nodes=nodes, edges=edges,
                input_manifest=[{'name': 'fixture.txt', 'sha256': checksum(self.root / 'fixture.txt')}],
                schema_sha256=self.pins['schema_sha256'], contract_sha256=self.pins['contract_sha256']))
            manifest = json.loads((self.root / 'manifest.json').read_bytes())
            manifest.update(self.pins)
            manifest['node_counts'] = {'LegalDocument': sum(n['type'].endswith('.LegalDocument') for n in nodes),
                'LegalUnit': sum(n['type'].endswith('.LegalUnit') for n in nodes),
                'TrafficSign': sum(n['type'].endswith('.TrafficSign') for n in nodes)}
            manifest['edge_unique_counts'] = {'hasUnit': len(edges)}
            (self.root / 'manifest.json').write_text(canonical_json(manifest), encoding='utf-8')
            (self.root / 'plan.sha256').write_text(self.pins['plan_sha256']+'\n', encoding='ascii')
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                scope.validate_c3_manifest(CONTRACT, self.root / 'manifest.json')

    def test_sample_preflight_binds_real_sdk_scope_and_persisted_source_batches(self):
        api = self.api()
        verified = self.preflight()
        self.assertEqual(verified['writer_config'].scope, 'C4_3A_MANIFEST_SAMPLE')
        self.assertEqual(verified['database_id'], 'physical-fixture-db')
        db_path = self.root / 'planned.sqlite3'
        result = api.plan_sources(self.config, db_path=db_path, verified=verified)
        self.assertEqual((result['nodes'], result['edges']), (3, 1))
        batches = list(api.iter_source_batches(db_path, 'nodes', 2))
        self.assertEqual([len(b) for b in batches], [2, 1])
        self.assertEqual([n for b in batches for n in b], self.originals)
        self.assertTrue(all(not any(k.startswith('_') for k in n['properties']) for b in batches for n in b))

    def test_reordered_source_ledger_cannot_change_resume_batch_boundaries(self):
        api = self.api()
        verified = self.preflight()
        db_path = self.root / 'planned.sqlite3'
        api.plan_sources(self.config, db_path=db_path, verified=verified)
        with sqlite3.connect(db_path) as db:
            db.execute('UPDATE runner_sources SET ordinal=ordinal+100 WHERE kind=\'nodes\'')
            db.execute('UPDATE runner_sources SET ordinal=102-ordinal WHERE kind=\'nodes\'')
        with self.assertRaises(RunBlocked):
            api.plan_sources(self.config, db_path=db_path, verified=verified)

    def test_missing_or_foreign_lock_bind_is_blocked(self):
        api = self.api()
        for mount in ('', '430 421 0:68 /some/other/directory /run/kag-locks rw - 9p D:\\134 rw'):
            with self.subTest(mount=mount), patch('kag.runner.Path.read_text', return_value=mount):
                with self.assertRaises(RunBlocked): api._shared_lock_root('/run/kag-locks')

    def test_deny_unknown_config_secret_endpoints_and_bad_batch_block(self):
        api = self.api()
        for kind in ('DENY', 'unknown', 'secret', 'no-profile', 'bad-batch', 'bool-dimension', 'write-sample'):
            with self.subTest(kind=kind):
                config = copy.deepcopy(self.config)
                if kind == 'DENY': config.pop('scope')
                if kind == 'unknown': config['api_key'] = 'NEVER_LOG_SECRET'
                if kind == 'secret': config['endpoints']['openspg'] = 'http://user:secret@localhost:28887'
                if kind == 'no-profile': config.pop('runtime_location')
                if kind == 'bad-batch': config['batch_size'] = True
                if kind == 'bool-dimension': config['vector_dimensions'] = True
                if kind == 'write-sample': config['write_mode'] = 'WRITE'
                path = self.root / 'config.json'; path.write_text(canonical_json(config), encoding='utf-8')
                with self.assertRaises(RunBlocked): api.load_config(path)

    def test_source_and_artifact_hash_mutations_block_before_discovery(self):
        self.api()
        for field in ('c3_manifest', 'sample_manifest', 'vector_artifact', 'provenance', 'source_checkpoint'):
            with self.subTest(field=field):
                config = copy.deepcopy(self.config); config['input_sha256'][field] = '0' * 64
                before = self.projects.reads
                with self.assertRaises(RunBlocked): self.preflight(config)
                self.assertEqual(self.projects.reads, before)
        (self.root / 'fixture.txt').write_bytes(b'mutated')
        with self.assertRaises(RunBlocked): self.preflight()

    def test_wrong_sample_server_identity_and_database_id_block(self):
        for field, value in (('id', '37'), ('name', 'Production'), ('namespace', 'Foreign')):
            with self.subTest(field=field):
                old = copy.deepcopy(self.projects.records)
                self.projects.records[0][field] = value
                with self.assertRaises(RunBlocked): self.preflight()
                self.projects.records = old
        with self.assertRaises(RunBlocked): self.preflight(reader=Database(None))

    def test_openspg_transport_is_error_for_sample_and_production_discovery(self):
        from knext.common.rest.exceptions import ApiException
        from urllib3.exceptions import ReadTimeoutError
        api = self.api()
        for production in (False, True):
            config = self.production() if production else self.config
            if production: config['write_mode'] = 'NO_OP'
            method = 'project_get' if production else 'get'
            for error in (TimeoutError('NEVER_LOG_TRANSPORT_SECRET'), ConnectionError('NEVER_LOG_TRANSPORT_SECRET'),
                          ReadTimeoutError(None, '/private', 'NEVER_LOG_TRANSPORT_SECRET'),
                          ApiException(status=503, reason='NEVER_LOG_TRANSPORT_SECRET')):
                with self.subTest(production=production, error=type(error).__name__), \
                        patch.object(self.projects, method, side_effect=error):
                    with self.assertRaises(RuntimeError) as failure:
                        api.preflight(config, project_client=self.projects, reader=Database())
                    self.assertNotIn('NEVER_LOG_TRANSPORT_SECRET', str(failure.exception))

    def production(self):
        config = copy.deepcopy(self.config)
        config.update(scope='PRODUCTION', project_id=37, project_name='VietRoadTrafficProduction',
                      write_mode='WRITE', confirmation='CONFIRM_PRODUCTION:VietRoadTrafficProduction:VietRoadTraffic:37:'
                      + self.pins['plan_sha256'])
        self.projects.records = [{'id': '37', 'name': config['project_name'], 'namespace': config['namespace'],
            'config':{'graph_store':{'uri':'neo4j://neo:7687','database':'VietRoadTraffic',
                'user':'fixture','password':'fixture-secret'}}}]
        return config

    def test_production_resolves_name_namespace_then_binds_expected_id(self):
        config = self.production(); config['write_mode'] = 'NO_OP'
        verified = self.preflight(config)
        self.assertEqual(verified['writer_config'].project_id, 37)
        self.assertEqual(verified['writer_config'].scope, 'PRODUCTION')
        self.assertGreaterEqual(self.projects.reads, 2)

    def test_confirmed_production_write_uses_existing_scope_authority(self):
        try:
            verified = self.preflight(self.production())
        except RunBlocked as error:
            self.fail('Confirmed production scope refused: ' + error.code)
        self.assertEqual(verified['identity']['write_mode'], 'WRITE')
        self.assertEqual(verified['writer_config'].scope, 'PRODUCTION')

    def test_production_ambiguous_missing_reserved_id_and_confirmation_block(self):
        for kind in ('missing', 'duplicate', 'reserved', 'confirmation'):
            with self.subTest(kind=kind):
                config = self.production()
                if kind == 'missing': self.projects.records.clear()
                if kind == 'duplicate': self.projects.records *= 2
                if kind == 'reserved': config['project_id'] = 2
                if kind == 'confirmation': config['confirmation'] = None
                with self.assertRaises(RunBlocked): self.preflight(config)

    def test_host_and_container_aliases_share_physical_database_lock(self):
        first = self.preflight()
        config = copy.deepcopy(self.config)
        config.update(runtime_location='container')
        config['endpoints']['neo4j_uri'] = 'bolt://openspg-neo4j:7687'
        config['endpoints']['neo4j_http'] = 'http://openspg-neo4j:7474'
        second = self.preflight(config)
        lock = GraphLock(self.config['paths']['lock_root'], first['database_id'], {'run_id': 'first'})
        lock.acquire()
        try:
            with self.assertRaises(RunBlocked):
                GraphLock(config['paths']['lock_root'], second['database_id'], {'run_id': 'second'}).acquire()
        finally:
            lock.release()

    def test_lock_and_run_roots_cannot_overlap_repo_or_old_inputs(self):
        for field, path in (('run_root', ROOT), ('lock_root', ROOT), ('run_root', self.root),
                            ('lock_root', self.root / 'vectors.jsonl'), ('lock_root', self.root / 'other-locks')):
            with self.subTest(field=field, path=path):
                config = copy.deepcopy(self.config); config['paths'][field] = str(path)
                with self.assertRaises(RunBlocked): self.preflight(config)

    def test_official_config_example_defaults_to_deny_without_credentials(self):
        path = ROOT / 'kag/config/runner.example.json'
        self.assertTrue(path.is_file(), 'official runner configuration missing')
        config = json.loads(path.read_bytes())
        self.assertEqual(config['scope'], 'DENY')
        self.assertEqual(config['write_mode'], 'DENY')
        self.assertNotIn('api_key', canonical_json(config))


class RunnerExecutionTests(unittest.TestCase):
    setUpClass = RunnerPreflightTests.__dict__['setUpClass']
    api = RunnerPreflightTests.api
    production = RunnerPreflightTests.production

    def setUp(self):
        RunnerPreflightTests.setUp(self)
        from kag.builder.resilient_vectorizer import ResilientVectorizer
        for job in self.jobs:
            job.update(attempts=[], classification=None)
        (self.root / 'provenance.json').write_text(canonical_json({'model_identity': MODEL, 'dimension': 3072,
                                                                'jobs': self.jobs}), encoding='utf-8')
        engine = ResilientVectorizer(None, model_identity=MODEL, dimension=3072,
            checkpoint_path=self.root / 'old-checkpoint.sqlite3', embedding_fallback=self.config['fallback_config'])
        try:
            engine.import_successes(self.originals, self.nodes, artifact_model_identity=MODEL,
                                    artifact_dimension=3072, artifact_jobs=self.jobs)
            engine.run(self.originals).require_complete()
        finally:
            engine.close()
        for field in ('provenance', 'source_checkpoint'):
            self.config['input_sha256'][field] = checksum(Path(self.config['paths'][field]))
        self.reader = GraphReader(self.nodes, self.edges)
        self.reader.database_identity = lambda: 'physical-fixture-db'
        self.reader.database_metadata = Database().database_metadata
        self.calls = []
        # The fixture starts with graph data; retain its same-model readback history.
        from kag.verify import index_expected
        prior = Path(self.config['paths']['run_root']) / 'model-origin'
        prior.mkdir(parents=True)
        with sqlite3.connect(prior / 'ledger.sqlite3') as db:
            db.execute('CREATE TABLE run_meta(key TEXT PRIMARY KEY,value TEXT)')
            db.execute('INSERT INTO run_meta VALUES (?,?)', ('identity', canonical_json(dict(
                database_id='physical-fixture-db', namespace=self.config['namespace'],
                model_identity=MODEL, dimension=3072))))
        index_expected(prior / 'expected.sqlite3', self.nodes, self.edges,
                       contract=CONTRACT, provenance=self.jobs)

    def execute(self, run_id='fixture-run', **kwargs):
        api = self.api()
        self.assertTrue(callable(getattr(api, 'run', None)), 'shared stage runner missing')
        def forbidden(*args, **kw):
            self.calls.append('side-effect-factory')
            raise AssertionError('NO_OP/replay constructed provider or graph writer')
        return api.run(self.config, run_id=run_id, reader=self.reader, project_client=self.projects,
                       vectorizer_factory=forbidden, writer_factory=forbidden, **kwargs)

    def record(self, filename='receipt.json', run_id='fixture-run'):
        return json.loads((self.root / 'runs' / run_id / filename).read_bytes())

    def test_nine_stages_stream_existing_vectors_without_side_effect_factories(self):
        self.assertEqual(self.execute(), 0)
        from kag.run_state import STAGES
        receipt = self.record()
        self.assertEqual(list(receipt['stages']), sorted(STAGES))
        events = [json.loads(line) for line in (self.root / 'runs/fixture-run/events.jsonl').read_text().splitlines()]
        stages = list(dict.fromkeys(e['stage'] for e in events))
        self.assertEqual(stages, list(STAGES))
        release = receipt['stages']['release']
        self.assertEqual(release['kind'], 'SAMPLE/NO_OP')
        self.assertEqual((release['embedding_calls'], release['graph_writes']), (0, 0))
        self.assertEqual(self.calls, [])
        self.assertLessEqual(self.reader.max_batch, self.config['batch_size'])
        self.assertEqual(receipt['stages']['vectorize']['provenance']['CHUNK_AGGREGATED'], 1)

    def test_interrupted_batches_resume_without_repeating_vectorization(self):
        from kag.builder.resilient_vectorizer import ResilientVectorizer
        for stage in ('vectorize', 'export-artifact', 'write-nodes', 'write-edges'):
            with self.subTest(stage=stage):
                run_id = 'interrupt-' + stage
                self.assertEqual(self.execute(run_id, stop_after_batch=(stage, 1)), 1)
                self.assertEqual(self.record('status.json', run_id)['error_code'], 'INTERRUPTED')
                calls = []
                original = ResilientVectorizer.run
                def bounded(engine, nodes, **kwargs):
                    calls.append(len(nodes)); self.assertLessEqual(len(nodes), 2)
                    return original(engine, nodes, **kwargs)
                with patch.object(ResilientVectorizer, 'run', bounded):
                    self.assertEqual(self.execute(run_id, resume=True), 0)
                self.assertEqual(len(calls), 1 if stage == 'vectorize' else 0)
                self.assertEqual(self.record('status.json', run_id)['state'], 'PASS')
                self.assertGreater(self.record(run_id=run_id)['stages']['release']['skipped_batches'], 0)

    def test_missing_cached_vector_blocks_without_provider_or_graph_write(self):
        nodes = copy.deepcopy(self.nodes); nodes[0]['properties'].pop('_title_vector')
        path = self.root / 'vectors.jsonl'
        path.write_text(''.join(canonical_json(n) + '\n' for n in nodes), encoding='utf-8')
        self.config['input_sha256']['vector_artifact'] = checksum(path)
        self.assertEqual(self.execute(), 2)
        self.assertEqual(self.calls, [])
        self.assertNotIn('write-nodes', self.record()['stages'])

    def test_missing_historical_checkpoint_job_blocks(self):
        with sqlite3.connect(self.root / 'old-checkpoint.sqlite3') as db: db.execute('DELETE FROM jobs')
        self.config['input_sha256']['source_checkpoint'] = checksum(self.root / 'old-checkpoint.sqlite3')
        self.assertEqual(self.execute(), 2)
        self.assertEqual(self.calls, [])

    def test_chunk_sidecar_and_fallback_config_mismatch_block(self):
        self.config['fallback_config']['max_chunk_chars'] = 7000
        self.assertEqual(self.execute(), 2)
        self.assertEqual(self.calls, [])

    def test_resume_rejects_changed_batch_config_and_durable_output(self):
        self.assertEqual(self.execute(stop_after_batch=('write-nodes', 1)), 1)
        original = self.config['batch_size']; self.config['batch_size'] = 1
        self.assertEqual(self.execute(resume=True), 2)
        self.config['batch_size'] = original
        path = self.root / 'runs/fixture-run/vectorized_nodes.jsonl'
        path.write_bytes(path.read_bytes()[:-1])
        self.assertEqual(self.execute(resume=True), 2)
        self.assertEqual(self.calls, [])

    def test_full_node_readback_failure_prevents_every_edge_stage(self):
        from kag import verify
        original = verify.verify_graph
        def barrier(reader, **kwargs):
            if kwargs.get('nodes_only'):
                status=self.record('status.json')
                self.assertEqual((status['stage'],status['state'],status['done']),('verify-nodes','RUNNING',0))
                raise RunBlocked('NODES')
            return original(reader, **kwargs)
        with patch.object(verify, 'verify_graph', barrier):
            self.assertEqual(self.execute(), 2)
        self.assertNotIn('write-edges', self.record()['stages'])

    def test_verify_command_shares_expected_artifact_and_read_only_verifier(self):
        self.assertEqual(self.execute(), 0)
        api = self.api()
        self.assertTrue(callable(getattr(api, 'verify_run', None)), 'shared verify entrypoint missing')
        self.assertEqual(api.verify_run(self.config, run_id='fixture-run', reader=self.reader,
                                      project_client=self.projects), 0)
        receipt = self.record()
        for log in ('events', 'batches'):
            records = [json.loads(line) for line in (self.root / 'runs/fixture-run' / (log + '.jsonl')).read_text().splitlines()]
            self.assertEqual(receipt['audit'][log], {'sequence': records[-1]['sequence'], 'hash': records[-1]['record_hash']})
        self.reader.nodes[0]['properties']['title'] = 'changed'
        self.assertEqual(api.verify_run(self.config, run_id='fixture-run', reader=self.reader,
                                      project_client=self.projects), 2)

    def test_production_real_writer_barrier_and_ambiguous_ack_resume(self):
        self.config = self.production()
        api = self.api()
        self.assertTrue(callable(getattr(api, 'run', None)), 'shared stage runner missing')
        writes, writers = [], []
        class Graph:
            _host_addr = self.config['endpoints']['openspg']
            _project_id = 37
            def write_graph(client, **kwargs):
                writes.append(kwargs['sub_graph'])
                if len(writes) == 1: raise TimeoutError('NEVER_LOG_RAW_PROVIDER_BODY')
        def factory(config):
            writer = self.adapter.NativeIntegerKGWriter(config, graph_client=Graph())
            writers.append(writer)
            return writer
        options = dict(run_id='production-fixture', reader=self.reader, project_client=self.projects,
                       writer_factory=factory)
        self.assertEqual(api.run(self.config, **options), 1)
        self.assertEqual(len(writes), 1)
        lock = writers[0].config.graph_lock
        self.addCleanup(lambda: lock.release() if lock.acquired else None)
        retained = lock.path.read_bytes()
        self.assertEqual(api.run(self.config, resume=True, **options), 2)
        self.assertEqual(lock.path.read_bytes(), retained)
        self.assertEqual(len(writes), 1)
        # Fixture-only recovery: the mocked writer has ended; never clear a live stale lock.
        lock.release()
        self.assertEqual(api.run(self.config, resume=True, **options), 0)
        self.assertEqual(len(writes), 3)  # uncertain first node batch read back, remaining node and edge sent once
        self.assertEqual(self.record(run_id='production-fixture')['stages']['release']['graph_writes'], len(writes))
        self.assertTrue(writes[-1]['resultEdges'])
        self.assertEqual(writers[-1]._verified_node_keys, {(n['type'], n['id']) for n in self.nodes})
        self.assertNotIn('NEVER_LOG_RAW_PROVIDER_BODY', canonical_json(self.record('status.json', 'production-fixture')))

    def test_graph_ack_before_confirmation_recovers_without_resend(self):
        self.config = self.production()
        api = self.api()
        self.assertTrue(callable(getattr(api, 'run', None)), 'shared stage runner missing')
        from kag.run_state import RunState
        writes = []
        class Graph:
            _host_addr = self.config['endpoints']['openspg']
            _project_id = 37
            def write_graph(client, **kwargs): writes.append(kwargs['sub_graph'])
        locks = []
        def factory(config):
            locks.append(config.graph_lock)
            self.addCleanup(lambda: config.graph_lock.release() if config.graph_lock.acquired else None)
            return self.adapter.NativeIntegerKGWriter(config, graph_client=Graph())
        original = RunState.confirm_batch
        def crash(state, stage, key, result):
            if stage == 'write-nodes': raise RuntimeError('synthetic crash before ledger confirmation')
            return original(state, stage, key, result)
        options = dict(run_id='ack-fixture', reader=self.reader, project_client=self.projects, writer_factory=factory)
        with patch.object(RunState, 'confirm_batch', crash): self.assertEqual(api.run(self.config, **options), 1)
        self.assertEqual(len(writes), 1)
        retained = locks[0].path.read_bytes()
        self.assertEqual(api.run(self.config, resume=True, **options), 2)
        self.assertEqual(locks[0].path.read_bytes(), retained)
        self.assertEqual(len(writes), 1)
        # Recovery is explicit and confined to the finished in-memory writer fixture.
        locks[0].release()
        self.assertEqual(api.run(self.config, resume=True, **options), 0)
        self.assertEqual(len(writes), 3)
        self.assertEqual(self.record(run_id='ack-fixture')['stages']['release']['graph_writes'], len(writes))

    def test_unproven_production_backend_blocks_before_provider_writer_or_lock(self):
        self.config = self.production()
        for provider in (False, True):
            with self.subTest(provider=provider):
                config = copy.deepcopy(self.config)
                if provider:
                    config.update(vector_policy='provider', embedding_model={'type': 'openai',
                        'base_url': 'https://embedding.invalid/v1', 'model': 'example-model', 'timeout': 60})
                calls = []
                with patch.object(self.reader, 'database_metadata', return_value={}), \
                        patch('kag.runner.GraphLock.acquire', side_effect=lambda *args: calls.append('lock')):
                    code = self.api().run(config, run_id='unproven-backend-' + str(provider),
                        project_client=self.projects, reader=self.reader,
                        vectorizer_factory=lambda *args: calls.append('provider'),
                        writer_factory=lambda *args: calls.append('writer'))
                self.assertEqual((code, calls), (2, []))

    def test_blocked_preflight_keeps_factories_unused_and_lock_can_be_reused(self):
        self.config['input_sha256']['provenance'] = '0' * 64
        self.assertEqual(self.execute(), 2)
        self.assertEqual(self.calls, [])
        lock = GraphLock('/run/kag-locks', 'physical-fixture-db', {'run_id': 'other'})
        lock.acquire(); lock.release()

    def test_failed_lock_release_still_closes_backend_authority(self):
        api = self.api()
        preflight = api.preflight
        release = GraphLock.release
        verified, rejected = [], []
        def capture(*args, **kwargs):
            result = preflight(*args, **kwargs)
            verified.append(result)
            return result
        def unavailable(lock):
            rejected.append(lock)
            raise RunBlocked('LOCK_MOUNT')
        self.addCleanup(lambda: release(rejected[0]) if rejected and rejected[0].acquired else None)
        with patch.object(api, 'preflight', side_effect=capture), \
                patch.object(GraphLock, 'release', autospec=True, side_effect=unavailable):
            with self.assertRaises(RunBlocked): self.execute(run_id='release-unavailable')
        with self.assertRaises(ValueError):
            verified[0]['backend_session'].validate(verified[0]['backend_proof'])

    def test_invalid_provider_fallback_blocks_before_model_factory(self):
        self.config = self.production()
        self.config.update(vector_policy='provider', embedding_model={'type': 'openai',
            'base_url': 'https://embedding.invalid/v1', 'model': 'example-model', 'timeout': 60})
        self.config['fallback_config']['max_chunk_chars'] = 0
        calls = []
        result = self.api().run(self.config, run_id='invalid-provider', reader=self.reader, project_client=self.projects,
            vectorizer_factory=lambda *args: calls.append('provider'))
        self.assertEqual((result, calls), (2, []))

    def test_default_provider_uses_pinned_adapter_and_bounded_content_targets(self):
        self.config = self.production()
        self.config.update(write_mode='NO_OP', vector_policy='provider', embedding_model={'type': 'openai',
            'base_url': 'https://embedding.invalid/v1', 'model': 'example-model', 'timeout': 60})
        from kag.common.vectorize_model import openai_model
        requests = []
        def create(**kwargs):
            requests.append(kwargs['input'])
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.01] * 3072) for _ in kwargs['input']])
        client = SimpleNamespace(embeddings=SimpleNamespace(create=create))
        client.with_options = lambda **kwargs: client
        with patch.dict('os.environ', {'TEST_EMBEDDING_KEY': 'synthetic-fixture-key'}), \
                patch.object(openai_model, 'OpenAI', return_value=client), \
                patch.object(openai_model, 'AsyncOpenAI', return_value=SimpleNamespace()):
            self.assertEqual(self.api().run(self.config, run_id='provider-fixture', reader=self.reader,
                project_client=self.projects), 0)
        self.assertTrue(requests)
        self.assertTrue(all(len(batch) <= self.config['batch_size'] * 2 for batch in requests))
        receipt = self.record(run_id='provider-fixture')
        self.assertGreater(receipt['stages']['release']['embedding_calls'], 0)
        self.assertEqual(receipt['stages']['release']['graph_writes'], 0)

    def test_provider_attempts_survive_checkpoint_before_batch_confirmation(self):
        from kag.run_state import RunState
        from kag.common.vectorize_model import openai_model
        self.config = self.production()
        self.config.update(write_mode='NO_OP', vector_policy='provider', embedding_model={'type': 'openai',
            'base_url': 'https://embedding.invalid/v1', 'model': 'example-model', 'timeout': 60})
        requests = []
        def create(**kwargs):
            requests.append(kwargs['input'])
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.01] * 3072) for _ in kwargs['input']])
        client = SimpleNamespace(embeddings=SimpleNamespace(create=create))
        client.with_options = lambda **kwargs: client
        confirm = RunState.confirm_batch
        def crash(state, stage, key, result):
            if stage == 'vectorize': raise RuntimeError('crash-after-provider-checkpoint')
            return confirm(state, stage, key, result)
        options = dict(run_id='provider-crash', reader=self.reader, project_client=self.projects)
        with patch.dict('os.environ', {'TEST_EMBEDDING_KEY': 'synthetic-fixture-key'}), \
                patch.object(openai_model, 'OpenAI', return_value=client), \
                patch.object(openai_model, 'AsyncOpenAI', return_value=SimpleNamespace()):
            with patch.object(RunState, 'confirm_batch', crash):
                self.assertEqual(self.api().run(self.config, **options), 1)
            before = len(requests)
            self.assertGreater(before, 0)
            self.assertEqual(self.api().run(self.config, resume=True, **options), 0)
        self.assertEqual(self.record(run_id='provider-crash')['stages']['release']['embedding_calls'], len(requests))

    def test_expected_index_spill_cannot_lock_source_or_replay_reader(self):
        connect = sqlite3.connect
        def small_cache(*args, **kwargs):
            db = connect(*args, **kwargs)
            db.execute('PRAGMA cache_size=1')
            return db
        with patch('sqlite3.connect', small_cache):
            self.assertEqual(self.execute(), 0)


if __name__ == '__main__':
    unittest.main()
