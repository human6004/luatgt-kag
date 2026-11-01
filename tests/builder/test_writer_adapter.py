"""Offline C4.1 writer adapter contracts; upstream KAG source is loaded, no network."""
import copy
import ast
import asyncio
import importlib
import json
from pathlib import Path
import sys
import types
import unittest
import uuid
from contextlib import contextmanager
from tempfile import TemporaryDirectory
from dataclasses import replace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / 'vendor/KAG'
CONTRACT = json.loads((ROOT / 'kag/schema/schema_contract.json').read_text(encoding='utf-8'))


def _load_upstream_adapter():
    """Load pinned Node/Edge/SubGraph/KGWriter definitions with dependency seams stubbed."""
    with patch.dict(sys.modules):
        for name in list(sys.modules):
            if name == 'kag' or name.startswith(('kag.', 'knext')):
                del sys.modules[name]

        def package(name, paths=()):
            value = types.ModuleType(name)
            value.__path__ = [str(path) for path in paths]
            sys.modules[name] = value
            return value

        package('kag', [ROOT / 'kag', UPSTREAM / 'kag'])
        package('kag.builder', [ROOT / 'kag/builder', UPSTREAM / 'kag/builder'])
        package('kag.builder.model', [UPSTREAM / 'kag/builder/model'])
        package('kag.builder.component', [UPSTREAM / 'kag/builder/component'])
        package('kag.builder.component.writer', [UPSTREAM / 'kag/builder/component/writer'])
        package('kag.common', [UPSTREAM / 'kag/common'])
        utils = types.ModuleType('kag.common.utils')
        utils.generate_hash_id = lambda value: str(value)
        sys.modules[utils.__name__] = utils

        spg_record = types.ModuleType('kag.builder.model.spg_record')
        spg_record.SPGRecord = type('SPGRecord', (), {})
        sys.modules[spg_record.__name__] = spg_record

        class SinkWriterABC:
            @classmethod
            def register(cls, *args, **kwargs):
                return lambda target: target

        # Keep native inherited entry-point behavior: default checkpoint access
        # and async dispatch must not disappear behind the dependency seam.
        base_path = UPSTREAM / 'kag/interface/builder/base.py'
        base_class = next(n for n in ast.parse(base_path.read_text(encoding='utf-8')).body
                          if isinstance(n, ast.ClassDef) and n.name == 'BuilderComponent')
        methods = [n for n in base_class.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                   and n.name in ('checkpointer', 'inherit_input_key', '_ainvoke')]
        native_methods = {'Input': object, 'Output': object, 'List': list, 'asyncio': asyncio}
        exec(compile(ast.Module(body=methods, type_ignores=[]), str(base_path), 'exec'), native_methods)
        for name in ('checkpointer', 'inherit_input_key', '_ainvoke'):
            setattr(SinkWriterABC, name, native_methods[name])

        interface = package('kag.interface', [UPSTREAM / 'kag/interface'])
        interface.SinkWriterABC = SinkWriterABC
        package('kag.interface.common', [UPSTREAM / 'kag/interface/common'])
        package('kag.interface.common.model', [UPSTREAM / 'kag/interface/common/model'])
        package('kag.interface.builder', [UPSTREAM / 'kag/interface/builder'])
        builder_base = types.ModuleType('kag.interface.builder.base')
        class BuilderComponentData:
            def __init__(self, data, hash_key=None):
                self.data, self.hash_key = data, hash_key
        builder_base.BuilderComponentData = BuilderComponentData
        sys.modules[builder_base.__name__] = builder_base

        package('knext', [UPSTREAM / 'knext'])
        package('knext.schema', [UPSTREAM / 'knext/schema'])
        package('knext.schema.model', [UPSTREAM / 'knext/schema/model'])
        schema_client = types.ModuleType('knext.schema.client')
        schema_client.BASIC_TYPES = {}
        sys.modules[schema_client.__name__] = schema_client
        schema_base = types.ModuleType('knext.schema.model.base')
        schema_base.BaseSpgType = type('BaseSpgType', (), {})
        sys.modules[schema_base.__name__] = schema_base
        package('knext.graph', [UPSTREAM / 'knext/graph'])
        graph_client = types.ModuleType('knext.graph.client')
        graph_client.GraphClient = type('GraphClient', (), {
            '__init__': lambda self, **kwargs: None,
            'write_graph': lambda self, **kwargs: None,
        })
        sys.modules[graph_client.__name__] = graph_client
        package('knext.common', [UPSTREAM / 'knext/common'])
        package('knext.common.base', [UPSTREAM / 'knext/common/base'])
        runnable = types.ModuleType('knext.common.base.runnable')
        runnable.Input = object
        runnable.Output = object
        sys.modules[runnable.__name__] = runnable

        from kag.builder.model.sub_graph import Edge, Node, SubGraph
        from kag.builder.component.writer.kg_writer import KGWriter
        adapter = importlib.import_module('kag.builder.writer_adapter')
        return adapter, KGWriter, Node, Edge, SubGraph, sys.modules['kag.backend_identity']


ADAPTER, PINNED_KG_WRITER, NODE, EDGE, SUBGRAPH, BACKEND = _load_upstream_adapter()


class RecordingGraphClient:
    def __init__(self, config=None, fail_at=None):
        config = config or _config()
        self.config = config
        self._host_addr = config.host_addr
        self._project_id = config.project_id
        self.calls = []
        self.fail_at = fail_at

    def write_graph(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        if self.fail_at == len(self.calls):
            raise RuntimeError('synthetic writer failure')


class RecordingWriter:
    def __init__(self, config, fail_at=None):
        self.config = config
        self.client = RecordingGraphClient(config)
        self.calls = []
        self.fail_at = fail_at

    def write_subgraph(self, graph, stage):
        self.calls.append((stage, graph))
        if self.fail_at == len(self.calls):
            raise RuntimeError('synthetic writer failure')

    def delete_subgraph(self, graph, stage):
        self.calls.append(('delete_' + stage, graph))


class Readback:
    def __init__(self, rows, config=None):
        self.rows = rows
        self.config = config or _config()
        self.calls = []

    def query_node(self, node_type, node_id):
        self.calls.append((node_type, node_id))
        return self.rows.get((node_type, node_id))


def _node_spec(identity='C4_1_SMOKE_NODE_001', order=7, text='Điều khoản tiếng Việt ạ.'):
    props = {}
    for row in CONTRACT['node_properties']['LegalUnit']:
        name, kind = row['schema_name'], row['contract_type']
        if row['logical_name'] in ('id', 'name') or not row['required']:
            continue
        if kind == 'INTEGER':
            value = order
        elif kind == 'BOOLEAN_ENCODING':
            value = 'false'
        elif kind == 'JSON_TEXT':
            value = '[1,2]'
        elif row['logical_name'] == 'unit_type':
            value = 'Khoan'
        elif row['logical_name'] == 'text':
            value = text
        elif row['logical_name'] == 'so_hieu':
            value = '007'
        else:
            value = ''
        props[name] = value
    props['sourceRecord'] = '[1,2]'
    props['penaltyCanhCao'] = 'true'
    props['parentId'] = '-1'
    props['dieuNumber'] = '1.0'
    props['_text_vector'] = [0.25, 0.5]
    return {'type': CONTRACT['namespace'] + '.LegalUnit', 'id': identity,
            'name': identity, 'properties': props}


def _edge_spec(from_id='C4_1_SMOKE_NODE_001', to_id='C4_1_SMOKE_NODE_002'):
    edge_tuple = (CONTRACT['namespace'] + '.LegalUnit', from_id, 'hasChild',
                  CONTRACT['namespace'] + '.LegalUnit', to_id)
    return {'tuple': edge_tuple, 'application_edge_key': ADAPTER.application_edge_key(edge_tuple),
            'properties': {'sourceRecord': '[{"line":1,"source":"synthetic"}]'}}


class FakeProjectClient:
    def __init__(self, record, host_addr='http://127.0.0.1:28887'):
        self.record = record
        self._host_addr = host_addr
        self._rest_client = self

    def project_get(self):
        return [self.record]

    def get(self, **conditions):
        return self.record if str(conditions.get('id')) == str(self.record.get('id')) else None


def _backend_session(client, project_id, name, database_id='physical-fixture-db'):
    from types import SimpleNamespace
    metadata = {'name':'vietroadtraffic','databaseID':database_id,
                'serverID':'fixture-server','currentStatus':'online'}
    records = client.project_get()
    for record in records:
        record.setdefault('config', {'graph_store':{'uri':'neo4j://neo:7687',
            'database':'VietRoadTraffic','user':'fixture','password':'fixture-secret'}})
    reader = SimpleNamespace(database_metadata=lambda: dict(metadata))
    transport = SimpleNamespace(read=lambda store, verifier: (dict(metadata), ('fixture-runtime',)))
    return ADAPTER.BackendIdentitySession(client, reader, transport, project_id=project_id,
        project_name=name, namespace='VietRoadTraffic', openspg_endpoint=client._host_addr)


def _config(contract=CONTRACT, project_id=17, project_name='C4_1_SMOKE_OFFLINE_TEST'):
    record = {'id': project_id, 'name': project_name, 'namespace': contract['namespace']}
    client = FakeProjectClient(record)
    project = ADAPTER.discover_smoke_project(client, project_id,
                                             project_name, 'http://127.0.0.1:28887', contract)
    session = _backend_session(client, project_id, project_name, 'offline-' + uuid.uuid4().hex)
    return ADAPTER.WriterConfig('http://127.0.0.1:28887', project,
        contract['namespace'], contract, scope='C4_1_SMOKE',
        backend_session=session, backend_proof=session.prove())


def _lock_config(config):
    lock = ADAPTER.GraphLock('/run/kag-locks', config.backend_proof.physical_database_id,
        {'run_id': 'offline-writer'}, backend_session=config.backend_session,
        backend_proof=config.backend_proof)
    lock.acquire()
    return replace(config, graph_lock=lock), lock


def _writer(contract=CONTRACT, client=None, project_id=17):
    config = _config(contract, project_id=project_id)
    return ADAPTER.NativeIntegerKGWriter(
        config, graph_client=client if client is not None else RecordingGraphClient(config))


def _readback(rows, project_id=17):
    return Readback(rows, _config(project_id=project_id))


def _recording_client(project_id=17):
    return RecordingGraphClient(_config(project_id=project_id))


def _server_row(spec, contract=CONTRACT, *, type_name=None, id_value=None, changes=None):
    rows = contract['node_properties'][spec['type'].rsplit('.', 1)[-1]]
    values = dict(spec['properties'])
    values.update({'id': spec['id'], 'name': spec['name']})
    if changes:
        values.update(changes)
    encoded = {}
    for row in rows:
        physical = row['schema_name']
        if physical in values:
            value = values[physical]
            encoded[physical] = value if physical in ('id', 'name') else json.dumps(value, ensure_ascii=False)
    return {'type': type_name or spec['type'], 'id': id_value or spec['id'], 'properties': encoded}


class WriterAdapterTest(unittest.TestCase):
    def setUp(self):
        backend = patch.dict(sys.modules, {'kag.backend_identity': BACKEND})
        backend.start()
        self.addCleanup(backend.stop)
        original = _config
        configs = {}
        def owned_config(contract=CONTRACT, project_id=17, project_name='C4_1_SMOKE_OFFLINE_TEST'):
            key = (json.dumps(contract, sort_keys=True), project_id, project_name)
            if key in configs: return configs[key]
            config, lock = _lock_config(original(contract, project_id, project_name))
            self.addCleanup(lambda: lock.release() if lock.acquired else None)
            self.addCleanup(config.backend_session.close)
            configs[key] = config
            return config
        patched = patch(__name__ + '._config', side_effect=owned_config)
        patched.start()
        self.addCleanup(patched.stop)

    def test_direct_writer_requires_owned_graph_lock(self):
        config = replace(_config(), graph_lock=None)
        writer = ADAPTER.NativeIntegerKGWriter(config, RecordingGraphClient(config))
        graph = ADAPTER.to_subgraphs([_node_spec()], 1, 'nodes', writer.config)[0]
        with self.assertRaises(ValueError): writer.write_subgraph(graph, 'nodes')
        self.assertEqual(writer.client.calls, [])

    def test_staged_write_and_cleanup_cannot_bypass_lock_with_custom_writer(self):
        config = replace(_config(), graph_lock=None)
        writer = RecordingWriter(config)
        nodes = [_node_spec()]
        for invoke in (lambda: ADAPTER.write_nodes_then_edges({'nodes': nodes, 'edges': []},
                            config, Readback({}, config), writer=writer),
                       lambda: ADAPTER.cleanup_synthetic(writer, nodes, [], 'C4_1_SMOKE_', config)):
            with self.assertRaises(ValueError): invoke()
        self.assertEqual(writer.calls, [])

    def test_released_lock_blocks_inherited_sync_async_and_cleanup(self):
        config = _config()
        writer = ADAPTER.NativeIntegerKGWriter(config, RecordingGraphClient(config))
        graph = ADAPTER.to_subgraphs([_node_spec()], 1, 'nodes', config)[0]
        config.graph_lock.release()
        for invoke in (lambda: writer.write_subgraph(graph, 'nodes'), lambda: writer.invoke(graph),
                       lambda: asyncio.run(writer.ainvoke(graph)),
                       lambda: ADAPTER.cleanup_synthetic(writer, [_node_spec()], [],
                                                         'C4_1_SMOKE_', config)):
            with self.assertRaises(ValueError): invoke()
        self.assertEqual(writer.client.calls, [])

    def test_foreign_physical_database_lock_is_refused(self):
        config = _config()
        other = _config(project_id=18)
        config = replace(config, graph_lock=other.graph_lock)
        writer = ADAPTER.NativeIntegerKGWriter(config, RecordingGraphClient(config))
        graph = ADAPTER.to_subgraphs([_node_spec()], 1, 'nodes', config)[0]
        with self.assertRaises(ValueError): writer.write_subgraph(graph, 'nodes')
        self.assertEqual(writer.client.calls, [])

    def test_uses_pinned_writer_and_structures(self):
        self.assertTrue(issubclass(ADAPTER.NativeIntegerKGWriter, PINNED_KG_WRITER))
        node_graph = ADAPTER.to_subgraphs([_node_spec()], 2, 'nodes', CONTRACT)[0]
        self.assertIsInstance(node_graph, SUBGRAPH)
        self.assertIsInstance(node_graph.nodes[0], NODE)

    def test_integer_values_survive_pinned_normalization(self):
        for value in (0, 7, 10 ** 40):
            client = RecordingGraphClient()
            writer = _writer(client=client)
            graph = ADAPTER.to_subgraphs([_node_spec(order=value)], 10, 'nodes', CONTRACT)[0]
            writer.write_subgraph(graph, 'nodes')
            payload = client.calls[0]['sub_graph']['resultNodes'][0]['properties']['order']
            self.assertEqual(payload, value)
            self.assertIs(type(payload), int)

    def test_writer_replay_uses_stable_upsert_payload(self):
        client = RecordingGraphClient()
        writer = _writer(client=client)
        graph = ADAPTER.to_subgraphs([_node_spec()], 10, 'nodes', CONTRACT)[0]
        writer.write_subgraph(graph, 'nodes')
        writer.write_subgraph(graph, 'nodes')
        self.assertEqual(client.calls[0]['operation'], client.calls[1]['operation'])
        self.assertEqual(client.calls[0]['operation'].value, 'UPSERT')
        self.assertEqual(client.calls[0]['sub_graph'], client.calls[1]['sub_graph'])

    def test_optional_integer_none_is_omitted(self):
        spec = _node_spec()
        spec['properties']['penaltyPhatTienMin'] = None
        graph = ADAPTER.to_subgraphs([spec], 10, 'nodes', CONTRACT)[0]
        client = RecordingGraphClient()
        _writer(client=client).write_subgraph(graph, 'nodes')
        self.assertNotIn('penaltyPhatTienMin', client.calls[0]['sub_graph']['resultNodes'][0]['properties'])

    def test_integer_rejects_bool_numeric_text_and_float(self):
        for value in (True, False, '7', 7.0):
            with self.subTest(value=value), self.assertRaises(ADAPTER.WriterAdapterError):
                ADAPTER.to_subgraphs([_node_spec(order=value)], 10, 'nodes', CONTRACT)

    def test_text_boolean_json_unicode_and_vector_values_survive(self):
        spec = _node_spec(text='Luật giao thông – tiếng Việt 🚦')
        graph = ADAPTER.to_subgraphs([spec], 10, 'nodes', CONTRACT)[0]
        client = RecordingGraphClient()
        _writer(client=client).write_subgraph(graph, 'nodes')
        payload = client.calls[0]['sub_graph']['resultNodes'][0]['properties']
        self.assertEqual(payload['soHieu'], '007')
        self.assertIs(type(payload['soHieu']), str)
        self.assertEqual((payload['parentId'], payload['dieuNumber']), ('-1', '1.0'))
        self.assertEqual(payload['penaltyCanhCao'], 'true')
        self.assertEqual(payload['sourceRecord'], '[1,2]')
        self.assertEqual(payload['text'], 'Luật giao thông – tiếng Việt 🚦')
        self.assertEqual(payload['_text_vector'], [0.25, 0.5])

        spec['properties']['penaltyCanhCao'] = 'false'
        false_graph = ADAPTER.to_subgraphs([spec], 10, 'nodes', CONTRACT)[0]
        false_client = RecordingGraphClient()
        _writer(client=false_client).write_subgraph(false_graph, 'nodes')
        self.assertEqual(false_client.calls[0]['sub_graph']['resultNodes'][0]['properties']
                         ['penaltyCanhCao'], 'false')

    def test_config_and_writer_reject_non_local_or_foreign_scope(self):
        good_config = _writer().config
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.WriterConfig('https://example.com', good_config.project,
                                 CONTRACT['namespace'], CONTRACT)
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.discover_smoke_project(
                FakeProjectClient({'id': 17, 'name': 'production', 'namespace': CONTRACT['namespace']}),
                17, 'production', 'http://127.0.0.1:28887', CONTRACT)
        writer = _writer()
        foreign = ADAPTER.to_subgraphs([_node_spec('outside_scope')], 10, 'nodes', CONTRACT)[0]
        with self.assertRaises(ADAPTER.WriterAdapterError):
            writer.write_subgraph(foreign, 'nodes')

        bad_graph = ADAPTER.to_subgraphs([_node_spec()], 10, 'nodes', CONTRACT)[0]
        bad_graph.nodes[0].properties['undeclared'] = 'payload'
        client = RecordingGraphClient()
        with self.assertRaises(ADAPTER.WriterAdapterError):
            _writer(client=client).write_subgraph(bad_graph, 'nodes')
        self.assertEqual(client.calls, [])

        edge_graph = ADAPTER.to_subgraphs([_edge_spec()], 10, 'edges', CONTRACT)[0]
        with self.assertRaises(ADAPTER.WriterAdapterError):
            writer.write_subgraph(edge_graph, 'edges')

    def test_project_discovery_binds_server_id_name_and_namespace(self):
        for record in (
                {'id': 18, 'name': 'C4_1_SMOKE_OFFLINE_TEST', 'namespace': CONTRACT['namespace']},
                {'id': 17, 'name': 'C4_1_SMOKE_OTHER', 'namespace': CONTRACT['namespace']},
                {'id': 17, 'name': 'C4_1_SMOKE_OFFLINE_TEST', 'namespace': 'Other'},
                *({'id': value, 'name': 'C4_1_SMOKE_OFFLINE_TEST', 'namespace': CONTRACT['namespace']}
                  for value in (True, '017', '17.0', ' 17', '18'))):
            with self.subTest(record=record), self.assertRaises(ADAPTER.WriterAdapterError):
                ADAPTER.discover_smoke_project(FakeProjectClient(record), 17,
                    'C4_1_SMOKE_OFFLINE_TEST', 'http://127.0.0.1:28887', CONTRACT)
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.discover_smoke_project(
                FakeProjectClient({'id': 17, 'name': 'C4_1_SMOKE_OFFLINE_TEST',
                                   'namespace': CONTRACT['namespace']},
                                  'http://127.0.0.2:28887'),
                17, 'C4_1_SMOKE_OFFLINE_TEST', 'http://127.0.0.1:28887', CONTRACT)

    def test_smoke_discovery_accepts_exact_sdk_text_id_as_native_integer(self):
        record = {'id': '17', 'name': 'C4_1_SMOKE_OFFLINE_TEST', 'namespace': CONTRACT['namespace']}
        project = ADAPTER.discover_smoke_project(FakeProjectClient(record), 17,
            record['name'], 'http://127.0.0.1:28887', CONTRACT)
        self.assertIs(type(project.project_id), int)
        self.assertEqual(project.project_id, 17)

    def test_default_native_invoke_preserves_integer_without_implicit_checkpoint(self):
        client = RecordingGraphClient(); writer = _writer(client=client)
        graph = ADAPTER.to_subgraphs([_node_spec()], 1, 'nodes', writer.config)[0]
        result = writer.invoke(graph)
        self.assertEqual(len(result), 1)
        self.assertIs(result[0].data, graph)
        self.assertIsNone(writer.checkpointer)
        self.assertIs(type(client.calls[0]['sub_graph']['resultNodes'][0]['properties']['order']), int)

    def test_default_native_ainvoke_preserves_integer_without_implicit_checkpoint(self):
        client = RecordingGraphClient(); writer = _writer(client=client)
        graph = ADAPTER.to_subgraphs([_node_spec()], 1, 'nodes', writer.config)[0]
        result = asyncio.run(writer.ainvoke(graph))
        self.assertEqual(len(result), 1)
        self.assertIs(result[0].data, graph)
        self.assertIsNone(writer.checkpointer)
        self.assertIs(type(client.calls[0]['sub_graph']['resultNodes'][0]['properties']['order']), int)

    def test_node_and_edge_stages_have_no_stub_endpoint_nodes(self):
        nodes = ADAPTER.to_subgraphs([_node_spec()], 10, 'nodes', CONTRACT)[0]
        edges = ADAPTER.to_subgraphs([_edge_spec()], 10, 'edges', CONTRACT)[0]
        self.assertEqual(len(nodes.nodes), 1)
        self.assertEqual(nodes.edges, [])
        self.assertEqual(edges.nodes, [])
        self.assertEqual(len(edges.edges), 1)
        self.assertEqual(edges.edges[0].id, _edge_spec()['application_edge_key'])

    def test_batching_is_deterministic_and_retains_c3_order(self):
        specs = [_node_spec(f'C4_1_SMOKE_NODE_{index:03d}') for index in range(5)]
        first = ADAPTER.to_subgraphs(specs, 2, 'nodes', CONTRACT)
        second = ADAPTER.to_subgraphs(specs, 2, 'nodes', CONTRACT)
        batches = [[node.id for node in graph.nodes] for graph in first]
        self.assertEqual(batches, [[node.id for node in graph.nodes] for graph in second])
        self.assertEqual(batches, [[spec['id'] for spec in specs[:2]],
                                   [spec['id'] for spec in specs[2:4]], [specs[4]['id']]])

    def test_node_readback_barrier_failure_blocks_edges(self):
        plan = {'nodes': [_node_spec(), _node_spec('C4_1_SMOKE_NODE_002')],
                'edges': [_edge_spec()]}
        writer = RecordingWriter(_writer().config)
        with self.assertRaises(ADAPTER.NodeReadbackError):
            ADAPTER.write_nodes_then_edges(plan, writer.config, Readback({}),
                                           writer=writer, batch_size=10)
        self.assertEqual([stage for stage, _ in writer.calls], ['nodes'])

    def test_readback_mismatch_blocks_edges(self):
        node = _node_spec()
        node2 = _node_spec('C4_1_SMOKE_NODE_002')
        bad = _server_row(node, changes={'order': 8})
        writer = RecordingWriter(_writer().config)
        with self.assertRaises(ADAPTER.NodeReadbackError):
            ADAPTER.write_nodes_then_edges({'nodes': [node, node2], 'edges': [_edge_spec()]},
                                           writer.config, Readback({(node['type'], node['id']): bad}),
                                           writer=writer, batch_size=10)
        self.assertEqual([stage for stage, _ in writer.calls], ['nodes'])

    def test_successful_barrier_precedes_edge_batches(self):
        node = _node_spec()
        node2 = _node_spec('C4_1_SMOKE_NODE_002')
        writer = RecordingWriter(_writer().config)
        result = ADAPTER.write_nodes_then_edges(
            {'nodes': [node, node2], 'edges': [_edge_spec()]}, writer.config,
            Readback({(node['type'], node['id']): _server_row(node),
                      (node2['type'], node2['id']): _server_row(node2)}),
            writer=writer, batch_size=10)
        self.assertEqual([stage for stage, _ in writer.calls], ['nodes', 'edges'])
        self.assertEqual(result['nodes_verified'], 2)
        self.assertEqual(result['edges_written'], 1)

    def test_pinned_writer_allows_edge_only_write_after_verified_barrier(self):
        nodes = [_node_spec(), _node_spec('C4_1_SMOKE_NODE_002')]
        edges = [_edge_spec()]
        client = RecordingGraphClient()
        writer = _writer(client=client)
        result = ADAPTER.write_nodes_then_edges(
            {'nodes': nodes, 'edges': edges}, writer.config,
            Readback({(node['type'], node['id']): _server_row(node) for node in nodes}),
            writer=writer, batch_size=10)
        self.assertEqual(result['nodes_verified'], 2)
        self.assertEqual([call['operation'].value for call in client.calls], ['UPSERT', 'UPSERT'])
        self.assertEqual(client.calls[0]['sub_graph']['resultEdges'], [])
        self.assertEqual(client.calls[1]['sub_graph']['resultNodes'], [])

    def test_writer_exception_blocks_edges(self):
        writer = RecordingWriter(_writer().config, fail_at=1)
        with self.assertRaises(RuntimeError):
            ADAPTER.write_nodes_then_edges(
                {'nodes': [_node_spec(), _node_spec('C4_1_SMOKE_NODE_002')],
                 'edges': [_edge_spec()]}, writer.config,
                Readback({}), writer=writer, batch_size=10)
        self.assertEqual([stage for stage, _ in writer.calls], ['nodes'])

    def test_orchestration_rejects_writer_bound_to_another_project(self):
        nodes = [_node_spec(), _node_spec('C4_1_SMOKE_NODE_002')]
        client = RecordingGraphClient(_config(project_id=18))
        writer = _writer(project_id=18, client=client)
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.write_nodes_then_edges(
                {'nodes': nodes, 'edges': [_edge_spec()]}, _config(project_id=17),
                Readback({(node['type'], node['id']): _server_row(node) for node in nodes}),
                writer=writer, batch_size=10)
        self.assertEqual(client.calls, [])

    def test_readback_checks_identity_type_name_and_required_values(self):
        node = _node_spec()
        valid = _server_row(node)
        config = _config()
        self.assertEqual(ADAPTER.verify_nodes(
            [node], Readback({(node['type'], node['id']): valid}, config), config)['verified'], 1)
        for changed in ({'type': 'VietRoadTraffic.TrafficSign'}, {'id': 'other'},
                        {'properties': {'name': 'other'}},
                        {'properties': {'order': json.dumps(9)}},
                        {'type': None}, {'id': None}):
            row = _server_row(node)
            row.update(changed)
            if 'properties' in changed:
                row['properties'].update(changed['properties'])
            with self.subTest(changed=changed), self.assertRaises(ADAPTER.NodeReadbackError):
                ADAPTER.verify_nodes([node], Readback({(node['type'], node['id']): row}, config), config)

    def test_reasoner_json_string_name_decodes_once_with_exact_identity(self):
        node = _node_spec('C4_1_SMOKE_Luật_đường_bộ')
        config = _config()
        row = _server_row(node, changes={'name': json.dumps(node['name'], ensure_ascii=False)})
        reader = Readback({(node['type'], node['id']): row}, config)
        self.assertEqual(ADAPTER.verify_nodes([node], reader, config)['verified'], 1)
        for wrong in ('"other"', '123', 'true', '[]', json.dumps(json.dumps(node['name']))):
            row = _server_row(node, changes={'name': wrong})
            with self.subTest(name=wrong), self.assertRaises(ADAPTER.NodeReadbackError):
                ADAPTER.verify_nodes([node], Readback({(node['type'], node['id']): row}, config), config)

    def test_cleanup_deletes_exact_edges_before_exact_nodes(self):
        nodes = [_node_spec('C4_1_SMOKE_NODE_001'), _node_spec('C4_1_SMOKE_NODE_002')]
        edge = _edge_spec(nodes[0]['id'], nodes[1]['id'])
        config = _config()
        writer = RecordingWriter(config)
        result = ADAPTER.cleanup_synthetic(writer, nodes, [edge], 'C4_1_SMOKE_', config, 10)
        self.assertEqual([stage for stage, _ in writer.calls], ['delete_edges', 'delete_nodes'])
        self.assertEqual(writer.calls[0][1].nodes, [])
        self.assertEqual(writer.calls[1][1].edges, [])
        self.assertEqual(result['edges_deleted'], 1)
        self.assertEqual(result['nodes_deleted'], 2)

    def test_cleanup_refuses_foreign_or_wildcard_ids_before_deleting(self):
        for identity, prefix in (('other_project_node', 'C4_1_SMOKE_'),
                                 ('C4_1_SMOKE_*', 'C4_1_SMOKE_')):
            config = _config()
            writer = RecordingWriter(config)
            with self.subTest(identity=identity), self.assertRaises(ADAPTER.WriterAdapterError):
                ADAPTER.cleanup_synthetic(writer, [_node_spec(identity)], [], prefix, config, 10)
            self.assertEqual(writer.calls, [])

    def test_graph_and_readback_clients_must_match_verified_target(self):
        config = _config(project_id=17)
        other = _config(project_id=18)
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.NativeIntegerKGWriter(config, graph_client=RecordingGraphClient(other))
        claimed_config_but_foreign_host = RecordingGraphClient(config)
        claimed_config_but_foreign_host._host_addr = 'http://127.0.0.2:28887'
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.NativeIntegerKGWriter(config, graph_client=claimed_config_but_foreign_host)

        nodes = [_node_spec(), _node_spec('C4_1_SMOKE_NODE_002')]
        reader = Readback({(node['type'], node['id']): _server_row(node) for node in nodes}, other)
        writer = RecordingWriter(config)
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.write_nodes_then_edges(
                {'nodes': nodes, 'edges': [_edge_spec()]}, config, reader,
                writer=writer, batch_size=10)
        self.assertEqual(writer.calls, [])

    def test_openspg_read_client_preserves_reasoner_metadata(self):
        config = _config()
        request_module = types.ModuleType('knext.reasoner.rest')
        class QueryRequest:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
        request_module.SpgTypeQueryRequest = QueryRequest

        class Reasoner:
            _host_addr = config.host_addr
            _project_id = str(config.project_id)
            def __init__(self):
                self.calls = []
                self._rest_client = self
            def query_spg_type_post(self, **kwargs):
                self.calls.append(kwargs['spg_type_query_request'])
                return [types.SimpleNamespace(spg_type='VietRoadTraffic.LegalUnit',
                                              id='C4_1_SMOKE_NODE_001',
                                              properties={'name': 'C4_1_SMOKE_NODE_001'})]

        reasoner = Reasoner()
        with patch.dict(sys.modules, {'knext.reasoner.rest': request_module}):
            reader = ADAPTER.OpenSPGReadClient(config, reasoner)
            result = reader.query_node('VietRoadTraffic.LegalUnit', 'C4_1_SMOKE_NODE_001')
        self.assertEqual(reasoner.calls[0].kwargs, {
            'project_id': str(config.project_id),
            'spg_type': 'VietRoadTraffic.LegalUnit',
            'ids': ['C4_1_SMOKE_NODE_001'],
        })
        self.assertEqual(result, {'type': 'VietRoadTraffic.LegalUnit',
                                 'id': 'C4_1_SMOKE_NODE_001',
                                 'properties': {'name': 'C4_1_SMOKE_NODE_001'}})

    def test_cleanup_requires_writer_bound_to_verified_target(self):
        config = _config(project_id=17)
        foreign = RecordingWriter(_config(project_id=18))
        nodes = [_node_spec('C4_1_SMOKE_NODE_001'), _node_spec('C4_1_SMOKE_NODE_002')]
        with self.assertRaises(ADAPTER.WriterAdapterError):
            ADAPTER.cleanup_synthetic(foreign, nodes, [_edge_spec()], 'C4_1_SMOKE_', config, 10)
        self.assertEqual(foreign.calls, [])


class ManifestWriterScopeTest(unittest.TestCase):
    # Small independently hashed fixture exercises the policy gates without
    # embedding the corpus in unit tests. Counts/hashes belong to each manifest.
    POLICY = {'nodes': 2, 'edges': 1,
        'nodes_sha256': 'ab13b605831a61a06fb0bcf602ccdb47620f94735950e363037662321e0d851f',
        'edges_sha256': '51998cc0c1fb095c8b18c1dd3d6ec49b461a457e3cf636279e5eb24ee12d2120'}

    @contextmanager
    def fixture(self, changes=None, project_changes=None, node_change=None, edge_change=None):
        self.assertTrue(callable(getattr(ADAPTER, 'discover_manifest_project', None)),
                        'manifest-scoped project discovery is missing')
        nodes = [_node_spec('REAL_A'), _node_spec('REAL_B')]
        edges = [_edge_spec('REAL_A', 'REAL_B')]
        manifest = {'chosen_partition': 5, 'counts_by_type': {'total': 2}, 'total_edges': 1,
            'selected_node_identity_sha256': self.POLICY['nodes_sha256'],
            'selected_edge_tuple_sha256': self.POLICY['edges_sha256']}
        manifest.update(changes or {})
        record = {'id': 2, 'name': 'VietRoadTrafficC43A10Pct', 'namespace': 'VietRoadTraffic'}
        record.update(project_changes or {})
        if node_change:
            nodes[0].update(node_change)
        if edge_change:
            edges[0].update(edge_change)
        with TemporaryDirectory() as folder, patch.dict(ADAPTER._C43A_POLICY, self.POLICY), \
                patch.dict(sys.modules, {'kag.backend_identity': BACKEND}):
            path = Path(folder) / 'sample_manifest.json'
            path.write_text(json.dumps(manifest), encoding='utf-8')
            client = FakeProjectClient(record)
            session = _backend_session(client, 2, 'VietRoadTrafficC43A10Pct')
            config = ADAPTER.discover_manifest_project(client,
                'http://127.0.0.1:28887', CONTRACT, path, nodes, edges, backend_session=session)
            config, lock = _lock_config(config)
            try:
                yield config, nodes, edges, path
            finally:
                lock.release()
                session.close()

    def test_exact_project_manifest_writes_real_nodes_with_native_integer(self):
        with self.fixture() as (config, nodes, edges, _):
            client = RecordingGraphClient(config)
            writer = ADAPTER.NativeIntegerKGWriter(config, client)
            result = ADAPTER.write_nodes_then_edges({'nodes': nodes, 'edges': edges}, config,
                Readback({(n['type'],n['id']): _server_row(n) for n in nodes}, config),
                writer=writer, batch_size=1)
            self.assertEqual(config.scope, 'C4_3A_MANIFEST_SAMPLE')
            self.assertEqual(result['nodes_verified'], 2)
            self.assertEqual(result['edges_written'], 1)
            self.assertIs(type(client.calls[0]['sub_graph']['resultNodes'][0]['properties']['order']), int)
            self.assertEqual(client.calls[-1]['sub_graph']['resultNodes'], [])

    def test_pinned_sdk_string_project_id_is_bound_as_native_integer(self):
        with self.fixture(project_changes={'id':'2'}) as (config, _, _, _):
            self.assertEqual(config.project_id,2)
            self.assertIs(type(config.project_id),int)

    def test_inherited_invoke_cannot_bypass_foreign_barrier_or_delete_guards(self):
        with self.fixture() as (config, nodes, edges, _):
            client=RecordingGraphClient(config)
            writer=ADAPTER.NativeIntegerKGWriter(config,client)
            cases=[(ADAPTER.to_subgraphs([_node_spec('FOREIGN')],1,'nodes',config)[0],
                    ADAPTER.AlterOperationEnum.Upsert),
                   (ADAPTER.to_subgraphs(edges,1,'edges',config)[0],ADAPTER.AlterOperationEnum.Upsert),
                   (ADAPTER.to_subgraphs(nodes,2,'nodes',config)[0],ADAPTER.AlterOperationEnum.Delete)]
            class Data:
                def __init__(self,data,*args): self.data=data; self.hash_key=None
            with patch.dict(PINNED_KG_WRITER.invoke.__globals__,{'BuilderComponentData':Data}):
                for graph,operation in cases:
                    with self.subTest(operation=operation),self.assertRaises(ADAPTER.WriterAdapterError):
                        writer.invoke(graph,alter_operation=operation)
                    with self.subTest(async_operation=operation),self.assertRaises(ADAPTER.WriterAdapterError):
                        asyncio.run(writer.ainvoke(graph,alter_operation=operation))
            self.assertEqual(client.calls,[])

    def test_wrong_project_id_namespace_and_name_fail_closed(self):
        for change in ({'id': 3}, {'id': True}, {'namespace': 'Other'},
                       {'name': 'Production'}, {'name': 'C4_1_SMOKE_OTHER'}):
            with self.subTest(change=change), self.assertRaises(ADAPTER.WriterAdapterError):
                with self.fixture(project_changes=change): pass

    def test_wrong_partition_hash_and_counts_fail_closed(self):
        for change in ({'chosen_partition': 4}, {'chosen_partition': True},
                       {'selected_node_identity_sha256': '0'*64},
                       {'selected_edge_tuple_sha256': '0'*64},
                       {'counts_by_type': {'total': 3}}, {'total_edges': 2}):
            with self.subTest(change=change), self.assertRaises(ADAPTER.WriterAdapterError):
                with self.fixture(changes=change): pass

    def test_actual_identity_hash_must_match_manifest(self):
        with self.assertRaises(ADAPTER.WriterAdapterError):
            with self.fixture(node_change={'id': 'FOREIGN', 'name': 'FOREIGN'}): pass

    def test_actual_edge_hash_must_match_manifest(self):
        with self.assertRaises(ADAPTER.WriterAdapterError):
            with self.fixture(edge_change={'tuple': ('VietRoadTraffic.LegalUnit','REAL_B',
                    'hasChild','VietRoadTraffic.LegalUnit','REAL_A')}): pass

    def test_foreign_node_batch_rejected_before_graph_request(self):
        with self.fixture() as (config, _, _, _):
            client = RecordingGraphClient(config)
            writer = ADAPTER.NativeIntegerKGWriter(config, client)
            graph = ADAPTER.to_subgraphs([_node_spec('FOREIGN')], 1, 'nodes', config)[0]
            with self.assertRaises(ADAPTER.WriterAdapterError): writer.write_subgraph(graph,'nodes')
            self.assertEqual(client.calls, [])

    def test_foreign_edge_between_allowed_nodes_rejected(self):
        with self.fixture() as (config, nodes, _, _):
            client = RecordingGraphClient(config)
            writer = ADAPTER.NativeIntegerKGWriter(config, client)
            writer._mark_nodes_verified(nodes)
            graph = ADAPTER.to_subgraphs([_edge_spec('REAL_B','REAL_A')],1,'edges',config)[0]
            with self.assertRaises(ADAPTER.WriterAdapterError): writer.write_subgraph(graph,'edges')
            self.assertEqual(client.calls, [])

    def test_manifest_change_after_discovery_rejected_before_write(self):
        with self.fixture() as (config, nodes, _, path):
            path.write_text('{}',encoding='utf-8')
            client = RecordingGraphClient(config)
            with self.assertRaises(ADAPTER.WriterAdapterError): ADAPTER.NativeIntegerKGWriter(config,client)
            self.assertEqual(client.calls, [])

    def test_scopes_cannot_be_confused_or_used_for_real_data_delete(self):
        with self.fixture() as (config, nodes, _, _):
            with self.assertRaises(ADAPTER.WriterAdapterError): replace(config,scope='C4_1_SMOKE')
            with self.assertRaises(ADAPTER.WriterAdapterError): replace(_config(),scope='C4_3A_MANIFEST_SAMPLE')
            writer = ADAPTER.NativeIntegerKGWriter(config,RecordingGraphClient(config))
            with self.assertRaises(ADAPTER.WriterAdapterError):
                writer.delete_subgraph(ADAPTER.to_subgraphs(nodes,2,'nodes',config)[0],'nodes')

    def test_partial_node_barrier_cannot_unlock_any_edges(self):
        with self.fixture() as (config, nodes, edges, _):
            client = RecordingGraphClient(config)
            writer = ADAPTER.NativeIntegerKGWriter(config,client)
            writer._mark_nodes_verified(nodes[:1])
            with self.assertRaises(ADAPTER.WriterAdapterError):
                writer.write_subgraph(ADAPTER.to_subgraphs(edges,1,'edges',config)[0],'edges')
            self.assertEqual(client.calls, [])

    def test_staged_plan_must_include_entire_manifest_before_first_write(self):
        with self.fixture() as (config, nodes, edges, _):
            writer = RecordingWriter(config)
            with self.assertRaises(ADAPTER.WriterAdapterError):
                ADAPTER.write_nodes_then_edges({'nodes':nodes[:1],'edges':edges},config,
                    Readback({},config),writer=writer)
            self.assertEqual(writer.calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
