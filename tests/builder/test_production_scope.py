"""Production validation only: no embedding, no production graph requests."""
import copy
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_writer_adapter as sample


ADAPTER = sample.ADAPTER
ROOT = sample.ROOT
CONTRACT = sample.CONTRACT
PINS = {
    'nodes_jsonl_sha256': '03e929392b2b75d6ba8a381de94a3c0688e8ccc60dd59cb5bd048e9eeacff8e7',
    'edges_jsonl_sha256': '2e904697369d2e5d90e694cd5692041e83cfcb455ee529afcc1bf7a22d0bdb0f',
    'plan_sha256': '144a50be5705920628ae6ad826d77a81110782c8f605c6ba32d7aa28d27daca0',
}
INPUT_SHA = 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d'


class Projects:
    _host_addr = 'http://127.0.0.1:28887'

    def __init__(self, records=None, returned=None):
        self.records = records if records is not None else [
            {'id': '37', 'name': 'VietRoadTrafficProduction', 'namespace': 'VietRoadTraffic'}]
        self.returned = returned
        self._rest_client = self

    def project_get(self):
        return self.records

    def get(self, **conditions):
        if self.returned is not None:
            return self.returned
        return next((r for r in self.records if str(r['id']) == str(conditions['id'])), None)


class ProductionScopeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(callable(getattr(ADAPTER, 'discover_production_project', None)),
                        'production scope discovery is missing')
        # Existing SDK seam loads isolated modules, then restores sys.modules.
        self.code = SimpleNamespace(**ADAPTER.validate_production_scope.__globals__)
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.nodes = [sample._node_spec('PROD_A'), sample._node_spec('PROD_B')]
        for n in self.nodes:
            n['properties'].pop('_text_vector')
        self.edges = [sample._edge_spec('PROD_A', 'PROD_B')]
        canonical = lambda x: json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        for name, records in (('nodes', self.nodes), ('edges', self.edges)):
            (self.root / (name + '.jsonl')).write_bytes(
                ''.join(canonical(x) + '\n' for x in records).encode())
        (self.root / 'fixture.txt').write_bytes(b'fixture')
        (self.root / 'plan.sha256').write_bytes((PINS['plan_sha256'] + '\n').encode('ascii'))
        self.manifest = dict(PINS,
            schema_sha256=self.code.C3_IDENTITY['schema_sha256'],
            contract_sha256=self.code.C3_IDENTITY['contract_sha256'],
            input_manifest=[{'name': 'fixture.txt', 'sha256': INPUT_SHA}],
            node_counts={'LegalUnit': 2}, edge_unique_counts={'hasChild': 1})
        self.path = self.root / 'manifest.json'
        self.save_manifest()
        pin = patch.dict(self.code.C3_IDENTITY, PINS)
        pin.start()
        self.addCleanup(pin.stop)
        required = patch.dict(ADAPTER.validate_production_scope.__globals__,
                              ARTIFACT_HASHES=(('fixture.txt', INPUT_SHA),))
        required.start()
        self.addCleanup(required.stop)
        self.settings = self.code.ProductionSettings(
            scope='PRODUCTION', runtime_location='host',
            host_addr='http://127.0.0.1:28887', neo4j_uri='bolt://127.0.0.1:27687',
            project_name='VietRoadTrafficProduction', namespace='VietRoadTraffic',
            expected_project_id=37, vector_dimensions=3072,
            confirmation='CONFIRM_PRODUCTION:VietRoadTrafficProduction:VietRoadTraffic:37:' + PINS['plan_sha256'])

    def save_manifest(self):
        self.path.write_text(json.dumps(self.manifest), encoding='utf-8')

    def discover(self, settings=None, client=None, contract=None):
        client, settings = client or Projects(), settings or self.settings
        # Trusted offline transport fixture; never live identity evidence.
        session = sample._backend_session(client, settings.expected_project_id, settings.project_name)
        return ADAPTER.discover_production_project(client, settings,
            contract or CONTRACT, self.path, project_root=self.root, backend_session=session)

    def test_exact_c3_validation_resolves_and_verifies_native_project_id(self):
        config = self.discover()
        self.assertEqual((config.scope, config.project_id, config.project_name),
                         ('PRODUCTION', 37, 'VietRoadTrafficProduction'))
        self.assertIs(type(config.project_id), int)

    def test_discovery_requires_backend_session_after_offline_validation(self):
        with self.assertRaises(ValueError):
            ADAPTER.discover_production_project(Projects(), self.settings, CONTRACT,
                                               self.path, project_root=self.root)

    def test_wrong_nodes_hash_blocks(self):
        self.manifest['nodes_jsonl_sha256'] = '0' * 64
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'nodes_jsonl_sha256'): self.discover()

    def test_wrong_edges_hash_blocks(self):
        self.manifest['edges_jsonl_sha256'] = '0' * 64
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'edges_jsonl_sha256'): self.discover()

    def test_wrong_plan_hash_blocks(self):
        self.manifest['plan_sha256'] = '0' * 64
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'plan_sha256'): self.discover()

    def test_wrong_schema_blocks(self):
        self.manifest['schema_sha256'] = '0' * 64
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'schema_sha256'): self.discover()

    def test_changed_contract_blocks(self):
        contract = copy.deepcopy(CONTRACT)
        contract['runtime_contract']['vector_index_targets'] = {}
        with self.assertRaisesRegex(ValueError, 'contract'): self.discover(contract=contract)

    def test_sample_manifest_blocks(self):
        self.manifest = {'chosen_partition': 5, 'selected_node_identity_sha256': PINS['nodes_jsonl_sha256']}
        self.save_manifest()
        with self.assertRaises(ValueError): self.discover()

    def test_missing_project_blocks(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'): self.discover(client=Projects([]))

    def test_ambiguous_project_blocks(self):
        record = Projects().records[0]
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.discover(client=Projects([record, dict(record)]))
        self.assertEqual(self.discover(client=Projects([record, dict(record, id='38')])).project_id,37)

    def test_returned_id_is_verified(self):
        record = dict(Projects().records[0], id='38')
        with self.assertRaisesRegex(ValueError, 'ID'): self.discover(client=Projects(returned=record))

    def test_project_id_two_requires_same_identity_proof_as_every_other_id(self):
        settings = replace(self.settings, expected_project_id=2,
                           confirmation=self.settings.confirmation.replace(':37:', ':2:'))
        record = dict(Projects().records[0], id='2')
        settings.validate()
        self.assertEqual(self.discover(settings=settings,client=Projects([record])).project_id,2)
        with self.assertRaises(ValueError):
            self.discover(settings=settings,client=Projects([dict(record,namespace='Foreign')]))

    def test_expected_project_id_mismatch_blocks(self):
        with self.assertRaisesRegex(ValueError, 'ID'):
            self.discover(settings=replace(self.settings, expected_project_id=38,
                confirmation=self.settings.confirmation.replace(':37:', ':38:')))

    def test_wrong_project_name_namespace_and_sample_targets_block(self):
        for change in ({'project_name': 'Wrong'}, {'namespace': 'Wrong'},
                       {'project_name': 'VietRoadTrafficC43A10Pct'},
                       {'project_name': 'C4_1_SMOKE_OTHER'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.discover(settings=replace(self.settings, **change))

    def test_unknown_scope_blocks(self):
        with self.assertRaises(ValueError): self.discover(settings=replace(self.settings, scope='unknown'))

    def test_default_settings_deny(self):
        with self.assertRaises(ValueError): self.discover(settings=self.code.ProductionSettings())

    def test_official_config_defaults_to_deny(self):
        config = json.loads((ROOT / 'kag/config/writer_scope.example.json').read_bytes())
        for profile in ('host', 'container'):
            settings = self.code.ProductionSettings(scope=config['scope'],
                **config['profiles'][profile], **config['production'])
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                self.discover(settings=settings)

    def test_writer_config_defaults_to_deny_and_unknown_scope_blocks(self):
        good = sample._config()
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.WriterConfig(good.host_addr, good.project, good.namespace, good.contract)
        with self.assertRaises(ADAPTER.WriterAdapterError): replace(good, scope='unknown')

    def test_missing_confirmation_or_wrong_dimension_blocks(self):
        for change in ({'confirmation': None}, {'confirmation': 'yes'}, {'vector_dimensions': 0}, {'vector_dimensions':65537},
                       {'vector_dimensions': True}, {'expected_project_id': True}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.discover(settings=replace(self.settings, **change))

    def test_host_and_container_endpoints_are_explicit(self):
        settings = replace(self.settings, runtime_location='container',
            host_addr='http://openspg-server:8887', neo4j_uri='bolt://openspg-neo4j:7687')
        client = Projects()
        client._host_addr = settings.host_addr
        self.assertEqual(self.discover(settings=settings, client=client).host_addr, settings.host_addr)
        for change in ({'runtime_location': 'unknown'}, {'host_addr': 'http://openspg-server:8887'},
                       {'host_addr': 'http://user:secret@127.0.0.1:28887'},
                       {'neo4j_uri': None}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.discover(settings=replace(self.settings, **change))

    def test_required_runtime_input_checksum_blocks(self):
        (self.root / 'fixture.txt').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'): self.discover()

    def test_actual_nodes_edges_and_plan_files_are_checked(self):
        for name in ('nodes.jsonl', 'edges.jsonl', 'plan.sha256'):
            path = self.root / name
            original = path.read_bytes()
            path.write_bytes(original + b' ')
            with self.subTest(name=name), self.assertRaises(ValueError): self.discover()
            path.write_bytes(original)

    def test_semantic_plan_hash_is_recomputed(self):
        self.manifest['input_manifest'].append({'name': 'extra.txt', 'sha256': INPUT_SHA})
        (self.root / 'extra.txt').write_bytes(b'fixture')
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'plan'): self.discover()

    def test_scope_revalidates_mutated_inputs_before_graph_request(self):
        config = self.discover()
        client = sample.RecordingGraphClient(config)
        writer = ADAPTER.NativeIntegerKGWriter(config, client)
        node = copy.deepcopy(self.nodes[0])
        node['properties']['_text_vector'] = [0.25] * 3072
        graph = ADAPTER.to_subgraphs([node], 1, 'nodes', config)[0]
        (self.root / 'fixture.txt').write_bytes(b'changed')
        with self.assertRaises(ValueError): writer.write_subgraph(graph, 'nodes')
        self.assertEqual(client.calls, [])

    def test_production_scope_validates_payload_and_vectors_without_writing(self):
        config = self.discover()
        node = copy.deepcopy(self.nodes[0])
        node['properties']['_text_vector'] = [0.25] * 3072
        ADAPTER._check_writer_scope(ADAPTER.to_subgraphs([node], 1, 'nodes', config)[0], config)
        for change in ({'text': 'changed'}, {'_text_vector': [0.25]},
                       {'_name_vector': [0.25] * 3072}, {'_text_vector': [float('nan')] * 3072}):
            bad = copy.deepcopy(node)
            bad['properties'].update(change)
            graph = ADAPTER.to_subgraphs([bad], 1, 'nodes', config)[0]
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                ADAPTER._check_writer_scope(graph, config)

    def test_production_scope_cannot_be_used_for_delete_or_sample(self):
        config = self.discover()
        graph = ADAPTER.to_subgraphs(self.nodes, 2, 'nodes', config)[0]
        with self.assertRaises(ValueError): ADAPTER._check_writer_scope(graph, config, deleting=True)
        with self.assertRaises(ValueError): replace(config, scope='C4_3A_MANIFEST_SAMPLE')
        with self.assertRaises(ValueError): replace(sample._config(), scope='PRODUCTION')

    def test_all_inherited_entry_points_block_before_graph_request(self):
        config = self.discover()
        client = sample.RecordingGraphClient(config)
        writer = ADAPTER.NativeIntegerKGWriter(config, client)
        node = copy.deepcopy(self.nodes[0])
        node['properties']['_text_vector'] = [0.25]
        graph = ADAPTER.to_subgraphs([node], 1, 'nodes', config)[0]
        with self.assertRaises(ValueError): writer.invoke(graph)
        with self.assertRaises(ValueError): asyncio.run(writer.ainvoke(graph))
        with self.assertRaises(ValueError): writer._invoke(graph)
        with self.assertRaises(ValueError): writer.write_subgraph(graph, 'nodes')
        self.assertEqual(client.calls, [])

    def test_partial_staged_plan_blocks_before_any_graph_request(self):
        config = self.discover()
        writer = sample.RecordingWriter(config)
        with self.assertRaises(ValueError):
            ADAPTER.write_nodes_then_edges({'nodes': self.nodes[:1], 'edges': self.edges}, config,
                sample.Readback({}, config), writer=writer)
        self.assertEqual(writer.calls, [])


if __name__ == '__main__':
    unittest.main()
