"""Official schema contract checks; pinned parser/models, no network or server.

Run from any cwd: python -B tests/schema/test_schema_contract.py
Requires six (already an upstream KAG SDK dependency).
"""
import ast
from contextlib import contextmanager
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / 'vendor/KAG'
SCHEMA = ROOT / 'kag/schema/VietRoadTraffic.schema'
CONTRACT = ROOT / 'kag/schema/schema_contract.json'
PIN = 'fdab15b3929d2ee40dfcdd388f90233096a6afc9'
SCHEMA_SHA256 = '4f9afe2e877b0926416b2cb29dd562cbe17805f053a090a5d6d7c618fdc69fde'
NODE_COUNTS = {'LegalDocument': 29, 'LegalUnit': 32, 'TrafficSign': 18}
DECLARED_COUNTS = {'LegalDocument': 27, 'LegalUnit': 30, 'TrafficSign': 16}
PREDICATES = {
    'HAS_UNIT': 'hasUnit', 'HAS_CHILD': 'hasChild', 'HAS_SIGN': 'hasSign',
    'CITES_UNIT': 'citesUnit', 'EXCLUDES_UNIT': 'excludesUnit', 'CITES': 'cites',
    'AMENDS': 'amends', 'REPEALS': 'repeals', 'REPLACES': 'replaces', 'IMPLEMENTS': 'implements',
    'CONSOLIDATES': 'consolidates',
}
UNIT_TYPES = ['Dieu', 'Khoan', 'Diem', 'QCVN', 'QCVN_Muc', 'PhuLuc', 'Muc', 'Bang', 'Hinh', 'MauBieu']


@contextmanager
def offline_parse(text):
    """Load unchanged upstream definitions, bypass SDK package startup only.

    Real REST models and parser run. Configuration is a validation boundary;
    SchemaClient raises on construction. Restore imports after parsing.
    """
    with patch.dict(sys.modules):
        for name in list(sys.modules):
            if name == 'knext' or name.startswith('knext.'):
                del sys.modules[name]

        def package(name, path):
            module = types.ModuleType(name)
            module.__path__ = [str(path)]
            sys.modules[name] = module
            return module

        for name in ('knext', 'knext.schema', 'knext.schema.model',
                     'knext.schema.marklang', 'knext.common', 'knext.common.rest'):
            package(name, UPSTREAM / name.replace('.', '/'))
        configuration = types.ModuleType('knext.common.rest.configuration')
        configuration.Configuration = type('OfflineConfiguration', (),
                                           {'client_side_validation': True})
        sys.modules[configuration.__name__] = configuration
        rest = package('knext.schema.rest', UPSTREAM / 'knext/schema/rest')
        model_root = UPSTREAM / 'knext/schema/rest/models'
        package('knext.schema.rest.models', model_root)
        for folder in model_root.rglob('*'):
            if folder.is_dir():
                package('knext.schema.rest.models.' +
                        folder.relative_to(model_root).as_posix().replace('/', '.'), folder)
        exports = {}
        source = (UPSTREAM / 'knext/schema/rest/__init__.py').read_text(encoding='utf-8')
        for node in ast.parse(source).body:
            if isinstance(node, ast.ImportFrom) and node.module.startswith('knext.schema.rest.models.'):
                for alias in node.names:
                    exports[alias.asname or alias.name] = (node.module, alias.name)

        def rest_getattr(name):
            if name not in exports:
                raise AttributeError(name)
            module, attribute = exports[name]
            value = getattr(importlib.import_module(module), attribute)
            setattr(rest, name, value)
            return value

        rest.__getattr__ = rest_getattr
        sys.modules['knext.schema'].rest = rest

        class NoServerClient:
            def __init__(self, *args, **kwargs):
                raise AssertionError('Server access prohibited in offline schema tests')

        client = types.ModuleType('knext.schema.client')
        client.SchemaClient = NoServerClient
        sys.modules[client.__name__] = client
        parser = importlib.import_module('knext.schema.marklang.schema_ml')
        base = importlib.import_module('knext.schema.model.base')
        parsed = parser.SPGSchemaMarkLang('', with_server=False, script_data_str=text)
        yield parsed, base


class SchemaContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SCHEMA.is_file() or not CONTRACT.is_file():
            return
        cls.contract = json.loads(CONTRACT.read_text(encoding='utf-8'))
        context = offline_parse(SCHEMA.read_text(encoding='utf-8'))
        cls.parsed, cls.base = context.__enter__()
        cls.addClassCleanup(context.__exit__, None, None, None)

    def test_schema_files_exist(self):
        self.assertTrue(SCHEMA.is_file(), 'Official VietRoadTraffic.schema is missing')
        self.assertTrue(CONTRACT.is_file(), 'Official schema_contract.json is missing')

    def test_pinned_parser_namespace_and_exact_entity_types(self):
        commit = subprocess.check_output(
            ['git', '-C', str(UPSTREAM), 'rev-parse', 'HEAD'], text=True).strip()
        self.assertEqual(commit, PIN)
        self.assertEqual(self.parsed.namespace, 'VietRoadTraffic')
        self.assertEqual(self.contract['namespace'], 'VietRoadTraffic')
        self.assertEqual(set(self.contract['node_types']), set(NODE_COUNTS))
        self.assertEqual(set(self.parsed.types), {'VietRoadTraffic.' + n for n in NODE_COUNTS})
        for node in self.parsed.types.values():
            self.assertEqual(node.spg_type_enum, self.base.SpgTypeEnum.Entity)
        names = {n.split('.')[-1] for n in self.parsed.types}
        for forbidden in ('Penalty', 'Evidence', 'Dieu', 'Khoan', 'Diem', 'QCVN',
                          'ExternalDocument', 'ExternalReference', 'Placeholder'):
            self.assertNotIn(forbidden, names)

    def test_exact_properties_types_mappings_and_optional_constraints(self):
        rows = self.contract['node_properties']
        # Golden digest of the four approved contract fields, not computed from this schema.
        approved = {t: [{k: p[k] for k in ('logical_name', 'schema_name',
                    'contract_type', 'physical_type')} for p in properties]
                    for t, properties in rows.items()}
        digest = hashlib.sha256(json.dumps(approved, ensure_ascii=False, sort_keys=True,
                                separators=(',', ':')).encode('utf-8')).hexdigest()
        self.assertEqual(digest, '9837eaad1e00701178aace532bae24b6442089edfe07a70055dd79487484e7bd')
        for name, count in NODE_COUNTS.items():
            properties = self.parsed.types['VietRoadTraffic.' + name].properties
            declared = [p for p in rows[name] if p['logical_name'] not in ('id', 'name')]
            self.assertEqual(len(rows[name]), count)
            self.assertEqual(len(properties), DECLARED_COUNTS[name])
            self.assertEqual(set(properties), {p['schema_name'] for p in declared})
            self.assertEqual(self.contract['logical_to_physical_properties'][name],
                             {p['logical_name']: p['schema_name'] for p in rows[name]})
            for p in declared:
                prop = properties[p['schema_name']]
                self.assertNotIn('_', prop.name)
                self.assertEqual(prop.object_type_name, p['physical_type'])
                self.assertNotIn(self.base.ConstraintTypeEnum.MultiValue, prop.constraint)
                self.assertEqual(self.base.ConstraintTypeEnum.NotNull in prop.constraint,
                                 p['required'])
                if p['contract_type'].startswith('OPTIONAL_') or p['logical_name'].startswith('penalty_'):
                    self.assertFalse(p['required'])

    def test_identity_properties_inherited_from_thing_without_redeclaration(self):
        inherited_count = 0
        for name in NODE_COUNTS:
            properties = self.parsed.types['VietRoadTraffic.' + name].properties
            self.assertTrue({'id', 'name', 'description'}.isdisjoint(properties))
            rows = self.contract['node_properties'][name]
            inherited = [p for p in rows if p['logical_name'] in ('id', 'name')]
            self.assertEqual({p['logical_name'] for p in inherited}, {'id', 'name'})
            self.assertEqual(len(inherited), 2)
            for p in inherited:
                self.assertEqual(p['schema_name'], p['logical_name'])
                self.assertEqual(p['physical_type'], 'Text')
                self.assertIs(p.get('intrinsic'), True)
                self.assertEqual(p.get('inherited_from'), 'Thing')
                self.assertIs(p.get('declared_in_entity_schema'), False)
                self.assertIs(p['required'], True)  # Logical requirement, not schema NotNull.
            self.assertNotIn('description', self.contract['logical_to_physical_properties'][name])
            self.assertEqual({p['logical_name'] for p in rows if p['intrinsic']}, {'id', 'name'})
            inherited_count += len(inherited)
        self.assertEqual(inherited_count, 6)

    def test_logical_and_declared_property_count_metadata(self):
        self.assertEqual(self.contract['node_property_count'], 79)
        self.assertEqual(self.contract.get('logical_property_count'), 79)
        self.assertEqual(self.contract.get('declared_project_property_count'), 73)
        self.assertEqual(self.contract.get('built_in_properties_inherited'), ['id', 'name'])
        self.assertEqual(sum(len(rows) for rows in self.contract['node_properties'].values()), 79)
        self.assertEqual(sum(len(node.properties) for node in self.parsed.types.values()), 73)

    def test_domain_contract_invariants(self):
        # Golden digest covers the complete domain model, including Thing inheritance.
        domain_fields = (
            'namespace',
            'node_types', 'node_properties', 'node_property_count', 'logical_property_count',
            'declared_project_property_count', 'built_in_properties_inherited',
            'logical_to_physical_predicates', 'logical_to_physical_properties',
            'property_codec_contract', 'unit_type_values', 'relations', 'relation_properties',
            'relation_provenance_contract', 'identity_strategy', 'xref_contract',
            'graph_inclusion_policy', 'edge_application_key_contract',
        )
        approved = json.loads(json.dumps({k: self.contract[k] for k in domain_fields}))
        # Runtime encoding and local-key roles have separate assertions below.
        for key in ('integer_encoding', 'codec_implementation'):
            approved['property_codec_contract'].pop(key)
        approved['xref_contract'].pop('runtime_path_source')
        key_fields = ('tuple_fields', 'canonical_json', 'algorithm', 'type_qualification',
                      'evidence_in_identity', 'merge_provenance_deterministically')
        approved['edge_application_key_contract'] = {
            k: approved['edge_application_key_contract'][k] for k in key_fields}
        digest = hashlib.sha256(json.dumps(approved, ensure_ascii=False, sort_keys=True,
                                separators=(',', ':')).encode('utf-8')).hexdigest()
        self.assertEqual(digest, '202d2f4d7de188565d8433b95c8a972506dd8a05819788f89a2e7b35cec30ec8')

    def test_exact_predicates_endpoints_and_relation_provenance(self):
        self.assertEqual(self.contract['logical_to_physical_predicates'], PREDICATES)
        actual = {}
        for node in self.parsed.types.values():
            for relation in node.relations.values():
                self.assertNotIn('_', relation.name)
                self.assertNotIn(relation.name, actual)
                actual[relation.name] = (node.name, relation.object_type_name)
                fields = self.contract['relation_properties'][relation.name]
                self.assertEqual(set(relation.sub_properties), {p['schema_name'] for p in fields})
                for p in fields:
                    self.assertEqual(relation.sub_properties[p['schema_name']].object_type_name, 'Text')
        self.assertEqual(set(actual), set(PREDICATES.values()))
        self.assertEqual(sum(len(relation.sub_properties)
                             for node in self.parsed.types.values()
                             for relation in node.relations.values()), 27)
        for name in PREDICATES.values():
            owner = 'LegalDocument' if name in ('hasUnit', 'cites', 'amends', 'repeals', 'replaces', 'implements', 'consolidates') else 'LegalUnit'
            target = 'TrafficSign' if name == 'hasSign' else ('LegalDocument' if owner == 'LegalDocument' and name != 'hasUnit' else 'LegalUnit')
            self.assertEqual(actual[name], ('VietRoadTraffic.' + owner, 'VietRoadTraffic.' + target))
        for name in ('citesUnit', 'excludesUnit'):
            self.assertEqual({p['schema_name'] for p in self.contract['relation_properties'][name]},
                             {'evidenceRecords', 'classificationProvenance', 'sourceRecord'})
        for name in ('hasUnit', 'hasChild', 'hasSign'):
            self.assertEqual({p['schema_name'] for p in self.contract['relation_properties'][name]},
                             {'sourceRecord'})
        for name in ('cites', 'amends', 'repeals', 'replaces', 'implements', 'consolidates'):
            self.assertEqual({p['schema_name'] for p in self.contract['relation_properties'][name]},
                             {'evidence', 'note', 'sourceRecord'})

    def test_unit_type_values(self):
        self.assertEqual(self.contract['unit_type_values'], UNIT_TYPES)
        prop = self.parsed.types['VietRoadTraffic.LegalUnit'].properties['unitType']
        self.assertEqual(prop.constraint[self.base.ConstraintTypeEnum.Enum], UNIT_TYPES)

    def test_xref_integrity_gate(self):
        xref = self.contract['xref_contract']
        expected = {
            'xref_sha256': '4a408fc2bdac1868c7099256657056c378c4fc922514512ad7edd6e29d250f6e',
            'required_safe_edge_ledger_sha256': 'd2a8a70f4f91d04cac4e935e063fb6f3077d0bbc845f1ddaa3d9905e11ec8c89',
            'join_contract': 'EXISTING_RECORD_FINGERPRINT_SHA256_CANONICAL_JSON',
            'classification_total': 21724, 'safe_edge_total': 12554,
            'safe_edge_affirmative': 11144, 'safe_edge_exclusion': 1410,
        }
        self.assertEqual({k:xref[k] for k in expected}, expected)
        self.assertEqual(xref['ledger_artifact_name'], 'xref_a3g2_final_ledger.jsonl')
        self.assertNotIn('D:', json.dumps(xref))
        self.assertTrue(xref['fail_closed'])

    def test_codec_and_edge_server_boundaries(self):
        codec = self.contract['property_codec_contract']
        self.assertEqual(codec['boolean_values'], ['true', 'false'])
        self.assertFalse(codec['schema_multivalue_used'])
        key = self.contract['edge_application_key_contract']
        self.assertEqual(key['tuple_fields'], ['fully_qualified_from_type', 'from_id',
                         'physical_predicate', 'fully_qualified_to_type', 'to_id'])
        self.assertFalse(key['evidence_in_identity'])
        self.assertTrue(key['merge_provenance_deterministically'])
        self.assertEqual(key.get('uses'), ['reproducibility', 'logging',
                         'local_deduplication', 'evidence_aggregation'])
        self.assertIs(key.get('controls_server_uniqueness'), False)
        self.assertEqual(codec['integer_encoding'],
                         'exact native int (type(value) is int), excluding bool; schema Integer; '
                         'project writer preserves native int through GraphClient serialization; '
                         'native integer after server property JSON decoding')
        self.assertEqual(codec['codec_implementation'], 'Builder owns property encoding and decoding.')
        self.assertEqual(self.contract['xref_contract']['runtime_path_source'],
                         'Runtime configuration; no absolute path dependency.')

    def test_content_vector_metadata_and_native_integer_writer_contract(self):
        expected = {
            'LegalDocument': {'title': 'Vector'},
            'LegalUnit': {'text': 'Vector'},
            'TrafficSign': {'ten': 'Vector', 'moTa': 'Vector'},
        }
        actual = {}
        for name in NODE_COUNTS:
            properties = self.parsed.types['VietRoadTraffic.' + name].properties
            indexed = {key: prop.index_type for key, prop in properties.items()
                       if prop.index_type is not None}
            actual[name] = indexed
            self.assertEqual(indexed,
                             {key: self.base.IndexTypeEnum.Vector for key in expected[name]})
            for relation in self.parsed.types['VietRoadTraffic.' + name].relations.values():
                self.assertTrue(all(prop.index_type is None
                                    for prop in relation.sub_properties.values()))
        self.assertEqual(sum(len(props) for props in actual.values()), 4)
        runtime = self.contract['runtime_contract']
        self.assertEqual(runtime.get('vector_index_targets'), expected)
        self.assertEqual(runtime.get('vectorizer_disable_generation'),
                         ['LegalDocument.name', 'LegalUnit.name',
                          'TrafficSign.name', 'Entity.name'])
        self.assertEqual(runtime.get('integer_writer_transport'),
                         'PROJECT_NATIVE_INTEGER_KGWRITER')
        serialized = SCHEMA.read_text(encoding='utf-8') + json.dumps(self.contract)
        for forbidden in ('schema_version', 'dataset_version', 'datasetVersion',
                          'LOCKED R2', 'pinned_kag_commit'):
            self.assertNotIn(forbidden, serialized)

    def test_runtime_requirements_bound_to_official_schema(self):
        self.assertIn('runtime_contract', self.contract)
        runtime = self.contract['runtime_contract']
        self.assertEqual(hashlib.sha256(SCHEMA.read_bytes()).hexdigest(),
                         SCHEMA_SHA256)
        self.assertEqual(runtime.get('schema_sha256'), SCHEMA_SHA256)
        self.assertEqual(runtime.get('constraint_enforcement'), 'DECLARATIVE_ONLY')
        for flag in ('builder_schema_validation_required', 'builder_unit_type_validation_required',
                     'builder_integer_validation_required'):
            self.assertIs(runtime.get(flag), True)
        self.assertEqual(runtime.get('integer_input'), 'NATIVE_INT_EXCLUDING_BOOL')
        self.assertEqual(runtime.get('integer_storage'), 'NATIVE_INTEGER')
        self.assertEqual(runtime.get('property_read_decoding'), 'JSON_DECODE_NON_ID_PROPERTIES')
        self.assertEqual(runtime.get('json_text_read_decoding'), 'ADDITIONAL_SEMANTIC_JSON_DECODE')
        self.assertEqual(runtime.get('json_text_write_encoding'), 'ONCE_BEFORE_WRITER')
        self.assertEqual(runtime.get('node_write_order'), 'NODES_BEFORE_EDGES')
        self.assertEqual(runtime.get('edge_identity'), 'FROM_PREDICATE_TO_TUPLE')
        self.assertEqual(runtime.get('edge_property_update'), 'LAST_WRITE_WINS')
        self.assertEqual(runtime.get('edge_provenance_aggregation'),
                         'DETERMINISTIC_CANONICAL_JSON_BEFORE_WRITE')
        self.assertEqual(runtime.get('edge_property_write'), 'COMPLETE_PROPERTIES_AFTER_AGGREGATION')
        self.assertEqual(runtime.get('text_payload_support'), 'CURRENT_DATASET_MAXIMUM_TEXT_SIZE')


if __name__ == '__main__':
    unittest.main(verbosity=2)
