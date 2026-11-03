"""C3 graph-plan contracts using the real C2 mapper and tiny source fixtures."""
import copy
from dataclasses import replace
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from test_inputs import CONTRACT, synthetic_inputs, wrap, xref_record


class GraphPlanTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.builder.graph_plan'),
                             'C3 graph planner implementation missing')
        self.gp = importlib.import_module('kag.builder.graph_plan')
        self.inputs_module = importlib.import_module('kag.builder.inputs')
        self.mapping = importlib.import_module('kag.builder.mapping')
        self.raw = synthetic_inputs(self.inputs_module)
        self.inputs = self.inputs_module.validate_input_integrity(self.raw, CONTRACT)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for relative in self.raw.markdown_paths:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Nguồn luật tiếng Việt.\n', encoding='utf-8', newline='\n')
        self.plan = self.gp.build_graph_plan(self.inputs, CONTRACT, project_root=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_nodes_and_edges_use_utf8_tuple_order(self):
        node_keys = [(row['type'].encode('utf-8'), row['id'].encode('utf-8'))
                     for row in self.plan.nodes]
        edge_keys = [tuple(part.encode('utf-8') for part in row['tuple'])
                     for row in self.plan.edges]
        self.assertEqual(node_keys, sorted(node_keys))
        self.assertEqual(edge_keys, sorted(edge_keys))

    def test_same_content_and_dict_insertion_order_have_same_plan_hash(self):
        reversed_nodes = tuple(dict(reversed(list(row.items()))) for row in self.plan.nodes)
        reversed_edges = []
        for row in self.plan.edges:
            changed = dict(reversed(list(row.items())))
            changed['properties'] = dict(reversed(list(row['properties'].items())))
            reversed_edges.append(changed)
        changed = replace(self.plan, nodes=reversed_nodes, edges=tuple(reversed_edges))
        self.assertEqual(self.gp.plan_hash(self.plan), self.gp.plan_hash(changed))
        self.assertEqual(self.gp.plan_hash(self.plan), self.gp.plan_hash(self.plan))

    def test_plan_hash_is_independent_of_source_iterable_order(self):
        shuffled = replace(self.raw, documents=tuple(reversed(self.raw.documents)),
                           units=tuple(reversed(self.raw.units)),
                           penalties=tuple(reversed(self.raw.penalties)),
                           signs=tuple(reversed(self.raw.signs)),
                           relations=tuple(reversed(self.raw.relations)),
                           xrefs=tuple(reversed(self.raw.xrefs)))
        validated = self.inputs_module.validate_input_integrity(shuffled, CONTRACT)
        other = self.gp.build_graph_plan(validated, CONTRACT, project_root=self.root)
        self.assertEqual(self.gp.plan_hash(self.plan), self.gp.plan_hash(other))

    def test_duplicate_group_counts_and_all_evidence_are_preserved(self):
        pairs = (('D::1', 'D::2'), ('D::2', 'E::1'), ('E::1', 'D::1'))
        xrefs = []
        line = 1
        for from_id, to_id in pairs:
            for evidence in ('Evidence A', 'Evidence B'):
                record = xref_record(from_unit_id=from_id, from_doc_id=from_id.split('::')[0],
                                     to_unit_id=to_id, to_doc_id=to_id.split('::')[0],
                                     evidence=evidence)
                xrefs.append(wrap(self.inputs_module, record, 'xrefs', line))
                line += 1
        raw = replace(self.raw, xrefs=tuple(xrefs))
        validated = self.inputs_module.validate_input_integrity(raw, CONTRACT)
        plan = self.gp.build_graph_plan(validated, CONTRACT, project_root=self.root)
        self.assertEqual(plan.collapsed_counts, {'rows': 3, 'groups': 3})
        self.assertEqual(plan.edge_source_counts['citesUnit'], 6)
        self.assertEqual(plan.edge_unique_counts['citesUnit'], 3)
        self.assertEqual(plan.validation['semantic_conflicts'], 0)
        for edge in (item for item in plan.edges if item['tuple'][2] == 'citesUnit'):
            evidence = json.loads(edge['properties']['evidenceRecords'])
            provenance = json.loads(edge['properties']['sourceRecord'])
            self.assertEqual(len(evidence), 2)
            self.assertEqual(len(provenance), 2)
        source_rows = self.mapping.map_relation_rows(validated, CONTRACT)
        aggregated = self.mapping.aggregate_relations(source_rows, CONTRACT)
        damaged = copy.deepcopy(aggregated)
        cites_unit = next(item for item in damaged if item['tuple'][2] == 'citesUnit')
        evidence = json.loads(cites_unit['properties']['evidenceRecords'])
        cites_unit['properties']['evidenceRecords'] = self.gp.canonical_json(evidence[:-1])
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._audit_aggregation(source_rows, damaged, CONTRACT)

    def test_evidence_changes_plan_hash_without_changing_edge_identity(self):
        edge = next(row for row in self.plan.edges if row['tuple'][2] == 'citesUnit')
        changed_edges = []
        for row in self.plan.edges:
            item = copy.deepcopy(row)
            if item['tuple'] == edge['tuple']:
                records = json.loads(item['properties']['evidenceRecords'])
                records[0]['evidence'] = 'Evidence changed.'
                item['properties']['evidenceRecords'] = self.gp.canonical_json(records)
            changed_edges.append(item)
        changed = replace(self.plan, edges=tuple(changed_edges))
        self.assertEqual(edge['application_edge_key'],
                         self.mapping.application_edge_key(edge['tuple']))
        self.assertEqual(edge['application_edge_key'],
                         next(row for row in changed.edges if row['tuple'] == edge['tuple'])
                         ['application_edge_key'])
        self.assertNotEqual(self.gp.plan_hash(self.plan), self.gp.plan_hash(changed))

    def test_input_file_hash_changes_plan_hash(self):
        manifest = [dict(row) for row in self.plan.input_manifest]
        manifest[0]['sha256'] = ('0' if manifest[0]['sha256'][0] != '0' else '1') + manifest[0]['sha256'][1:]
        changed = replace(self.plan, input_manifest=tuple(manifest))
        self.assertNotEqual(self.gp.plan_hash(self.plan), self.gp.plan_hash(changed))

    def test_streaming_hash_matches_canonical_json_hash(self):
        payload = self.gp._hash_payload(self.plan)
        expected = hashlib.sha256(self.gp.canonical_json(payload).encode('utf-8')).hexdigest()
        self.assertEqual(self.gp.plan_hash(self.plan), expected)

    def test_dry_run_is_utf8_lf_canonical_and_re_readable(self):
        output = self.root / 'artifacts'
        self.gp.write_dry_run(self.plan, output)
        nodes = (output / 'nodes.jsonl').read_bytes()
        edges = (output / 'edges.jsonl').read_bytes()
        self.assertNotIn(b'\r', nodes)
        self.assertNotIn(b'\r', edges)
        self.assertTrue(nodes.endswith(b'\n'))
        self.assertTrue(edges.endswith(b'\n'))
        parsed_nodes = [json.loads(line) for line in nodes.decode('utf-8').splitlines()]
        parsed_edges = [json.loads(line) for line in edges.decode('utf-8').splitlines()]
        self.assertEqual(parsed_nodes,
                         [json.loads(self.gp.canonical_json(row)) for row in self.plan.nodes])
        self.assertEqual(parsed_edges,
                         [json.loads(self.gp.canonical_json(row)) for row in self.plan.edges])
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['plan_sha256'], self.gp.plan_hash(self.plan))
        self.assertEqual((output / 'plan.sha256').read_text(encoding='ascii').strip(),
                         self.gp.plan_hash(self.plan))

    def test_deterministic_hash_payload_has_no_runtime_metadata_or_absolute_root(self):
        payload = self.gp._hash_payload(self.plan)
        self.assertEqual(set(payload), {'schema_sha256', 'contract_sha256', 'inputs', 'nodes', 'edges'})
        serialized = self.gp.canonical_json(payload)
        self.assertNotIn('timestamp', serialized.lower())
        self.assertNotIn(str(self.root), serialized)
        for item in self.plan.input_manifest:
            self.assertNotIn(':\\', item['name'])
            self.assertFalse(item['name'].startswith('/'))

    def test_plan_contains_no_runtime_vectors(self):
        vector_names = {'_name_vector', '_title_vector', '_text_vector', '_ten_vector',
                        '_mo_ta_vector', '_text_sparse', '_ten_sparse', '_mo_ta_sparse'}
        for row in (*self.plan.nodes, *self.plan.edges):
            self.assertFalse(vector_names & row.get('properties', {}).keys())

    def test_text_preservation_rejects_changed_source_value(self):
        nodes = self.mapping.map_nodes(self.inputs, CONTRACT)
        node = next(row for row in nodes if row['type'].endswith('.LegalUnit'))
        node['properties']['text'] += ' changed'
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._validate_text_preservation(self.inputs, nodes, CONTRACT)

    def test_vector_stats_measure_max_utf8_bytes_separately_and_use_schema_name(self):
        nodes = [copy.deepcopy(row) for row in self.plan.nodes]
        units = [row for row in nodes if row['type'].endswith('.LegalUnit')]
        units[0]['properties']['text'] = 'aaaa'
        units[1]['properties']['text'] = 'ééé'
        units[2]['properties']['text'] = 'x'
        stats = self.gp.vector_input_length_stats(replace(self.plan, nodes=tuple(nodes)), CONTRACT)
        unit_stats = stats['LegalUnit.text']
        self.assertEqual(unit_stats['max_chars'], 4)
        self.assertEqual(unit_stats['max_chars_id'], units[0]['id'])
        self.assertEqual(unit_stats['max_utf8_bytes'], 6)
        self.assertEqual(unit_stats['max_utf8_bytes_id'], units[1]['id'])
        self.assertIn('TrafficSign.moTa', stats)

    def test_validation_rejects_missing_endpoint_duplicate_node_and_duplicate_edge(self):
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._validate_plan(replace(self.plan, nodes=self.plan.nodes[:-1]), CONTRACT)
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._validate_plan(replace(self.plan, nodes=self.plan.nodes + (self.plan.nodes[0],)), CONTRACT)
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._validate_plan(replace(self.plan, edges=self.plan.edges + (self.plan.edges[0],)), CONTRACT)

    def test_validation_rejects_edge_key_mismatch_and_missing_provenance(self):
        bad_key = copy.deepcopy(self.plan.edges[0])
        bad_key['application_edge_key'] = '0' * 64
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._validate_plan(replace(self.plan, edges=(bad_key, *self.plan.edges[1:])), CONTRACT)
        no_provenance = copy.deepcopy(self.plan.edges[0])
        no_provenance['properties'].pop('sourceRecord', None)
        with self.assertRaises(self.gp.GraphPlanError):
            self.gp._validate_plan(replace(self.plan, edges=(no_provenance, *self.plan.edges[1:])), CONTRACT)

    def test_validation_rejects_runtime_vector_property(self):
        for field in ('_text_vector', '_mo_ta_vector', '_mo_ta_sparse'):
            with self.subTest(field=field):
                node = copy.deepcopy(self.plan.nodes[0])
                node['properties'][field] = [0.1, 0.2]
                with self.assertRaises(self.gp.GraphPlanError):
                    self.gp._validate_plan(replace(self.plan, nodes=(node, *self.plan.nodes[1:])), CONTRACT)


if __name__ == '__main__':
    unittest.main()
