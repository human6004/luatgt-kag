"""Golden plain specs and permutation-invariant provenance, synthetic only."""
import copy
from dataclasses import replace
import hashlib
import importlib
import importlib.util
import itertools
import json
import unittest

from test_inputs import CONTRACT, synthetic_inputs, wrap, xref_record, ledger_record


class MappingTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.builder.mapping'),
                             'C2 deterministic mapping implementation missing')
        self.m = importlib.import_module('kag.builder.mapping')
        self.i = importlib.import_module('kag.builder.inputs')
        self.raw = synthetic_inputs(self.i)
        self.inputs = self.i.validate_input_integrity(self.raw, CONTRACT)

    def nodes(self, **changes):
        inputs = self.i.validate_input_integrity(replace(self.raw, **changes), CONTRACT)
        return self.m.map_nodes(inputs, CONTRACT)

    def relations(self, **changes):
        inputs = self.i.validate_input_integrity(replace(self.raw, **changes), CONTRACT)
        return self.m.map_relation_rows(inputs, CONTRACT)

    def node(self, identity, **changes):
        return next(n for n in self.nodes(**changes) if n['id'] == identity)

    def test_document_golden_full_mapping(self):
        row = self.raw.documents[0]
        rich = dict(row.record, official_so_hieu='1/2026/NĐ-CP', identity_note='',
                    document_role='historical', legal_domains=['đường bộ', 'vận tải'],
                    current_status='Superseded', status_hint='', phan_lien_quan='',
                    effective_from='2026-02-01', effective_to='2027-01-01',
                    hieu_luc_note='một phần', het_hieu_luc_note='',
                    ngay_hieu_luc_bo_phan=['2026-04-01', '2026-03-01'],
                    consolidation_as_of='2026-05-01', underlying_effective_from='2020-01-01',
                    source_quality='OFFICIAL', source_note='nguyên bản')
        expected = {'soHieu': '1/2026/NĐ-CP', 'title': 'Luật đường bộ', 'loai': 'Nghị định',
                    'coQuan': 'Chính phủ', 'scope': 'in_scope', 'tier': 'core',
                    'ngayBanHanh': '2026-01-01', 'sourceUrl': 'https://example.test/source',
                    'sourceKind': 'OFFICIAL', 'markdownPath': 'data/processed/documents/D.md',
                    'sourceRecord': json.dumps(row.locator, sort_keys=True, separators=(',', ':')),
                    'officialSoHieu': '1/2026/NĐ-CP', 'identityNote': '', 'documentRole': 'historical',
                    'legalDomains': '["đường bộ","vận tải"]', 'currentStatus': 'Superseded',
                    'statusHint': '', 'phanLienQuan': '', 'effectiveFrom': '2026-02-01',
                    'effectiveTo': '2027-01-01', 'hieuLucNote': 'một phần', 'hetHieuLucNote': '',
                    'ngayHieuLucBoPhan': '["2026-04-01","2026-03-01"]',
                    'consolidationAsOf': '2026-05-01', 'underlyingEffectiveFrom': '2020-01-01',
                    'sourceQuality': 'OFFICIAL', 'sourceNote': 'nguyên bản'}
        docs = (self.i.SourceRecord(rich, row.locator), self.raw.documents[1])
        self.assertEqual(self.node('D', documents=docs),
                         {'type': 'VietRoadTraffic.LegalDocument', 'id': 'D', 'name': 'D',
                          'properties': expected})

    def test_unit_golden_full_mapping_and_penalty_merge(self):
        row = self.raw.units[1]
        rich = dict(row.record, title='', dieu_number='1a', khoan_number='02', diem_letter='đ',
                    dieu_occurrence=0, khoan_occurrence=7, diem_occurrence=1,
                    qcvn_id='QCVN 41:2024', scope='internal', section_number='A.1', section_occurrence=2)
        p = dict(self.raw.penalties[0].record, dieu_title='Điều 1', doi_tuong='',
                 hanh_vi='Không chấp hành biển báo', tru_diem_gplx=0, tich_thu='tang vật')
        penalty = wrap(self.i, p, 'penalties')
        expected = {'docId': 'D', 'soHieu': '1/2026/NĐ-CP', 'unitType': 'Dieu',
                    'text': 'Điều 1. Đường bộ', 'order': 0, 'parentId': 'D::1', 'title': '',
                    'dieuNumber': '1a', 'khoanNumber': '02', 'diemLetter': 'đ',
                    'dieuOccurrence': 0, 'khoanOccurrence': 7, 'diemOccurrence': 1,
                    'qcvnId': 'QCVN 41:2024', 'scope': 'internal', 'sectionNumber': 'A.1',
                    'sectionOccurrence': 2, 'penaltyId': 'D::2', 'penaltyDieuTitle': 'Điều 1',
                    'penaltyDoiTuong': '', 'penaltyHanhVi': 'Không chấp hành biển báo',
                    'penaltyPhatTienMin': 0, 'penaltyPhatTienMax': 7, 'penaltyCanhCao': 'false',
                    'penaltyTruDiemGplx': 0, 'penaltyTuocGplxThangMin': 0,
                    'penaltyTuocGplxThangMax': 7, 'penaltyTichThu': 'tang vật',
                    'sourceRecord': json.dumps(row.locator, sort_keys=True, separators=(',', ':')),
                    'penaltySourceRecord': json.dumps({'record': p, 'locator': penalty.locator},
                                    ensure_ascii=False, sort_keys=True, separators=(',', ':'))}
        units = (self.raw.units[0], self.i.SourceRecord(rich, row.locator), self.raw.units[2])
        node = self.node('D::2', units=units, penalties=(penalty,))
        self.assertEqual(node, {'type': 'VietRoadTraffic.LegalUnit', 'id': 'D::2',
                                'name': 'D::2', 'properties': expected})
        for key in ('order', 'penaltyPhatTienMin', 'penaltyPhatTienMax',
                    'penaltyTruDiemGplx', 'penaltyTuocGplxThangMin', 'penaltyTuocGplxThangMax'):
            self.assertIs(type(node['properties'][key]), int)

    def test_sign_golden_version_unicode_empty_and_null(self):
        row = self.raw.signs[0]
        node = self.node('S::QCVN2024')
        self.assertEqual(node, {'type': 'VietRoadTraffic.TrafficSign',
                    'id': 'S::QCVN2024', 'name': 'S::QCVN2024', 'properties': {
                    'docId': 'D', 'unitId': 'D::1', 'soHieu': 'QCVN 41:2024',
                    'maBien': 'P.101', 'nhom': 'Cấm', 'qcvn': 'QCVN 41:2024',
                    'ten': '', 'moTa': 'Đường cấm', 'bienPhuVariant': '',
                    'ngayHieuLuc': '2025-01-01',
                    'sourceRecord': json.dumps(row.locator, sort_keys=True, separators=(',', ':'))}})

    def test_dates_primary_presence_precedence_and_alias_fallback(self):
        for changes, present, expected in (({'effective_from': None, 'ngay_hieu_luc': '2025-01-01'}, False, None),
                    ({'effective_from': ''}, True, ''),
                    ({'ngay_hieu_luc': '2025-01-01'}, True, '2025-01-01'),
                    ({'effective_to': None, 'ngay_het_hieu_luc': '2027-03-01'}, False, None),
                    ({'ngay_het_hieu_luc': '2027-03-01'}, True, '2027-03-01')):
            row = self.raw.documents[0]
            docs = (self.i.SourceRecord(dict(row.record, **changes), row.locator), self.raw.documents[1])
            key = 'effectiveTo' if any('to' in k or 'het' in k for k in changes) else 'effectiveFrom'
            props = self.node('D', documents=docs)['properties']
            self.assertEqual(key in props, present)
            if present:
                self.assertEqual(props[key], expected)

    def test_identity_exact_id_name_no_normalization(self):
        exact = ' D::e\u0301 '
        row = self.i.SourceRecord(dict(self.raw.units[0].record, unit_id=exact), self.raw.units[0].locator)
        nodes = self.nodes(units=(row,), penalties=(), signs=(), xrefs=(), ledger=())
        n = next(n for n in nodes if n['type'].endswith('LegalUnit'))
        self.assertEqual((n['id'], n['name']), (exact, exact))

    def test_all_five_unit_types_and_no_vectors(self):
        for unit_type in CONTRACT['unit_type_values']:
            row = self.raw.units[0]
            units = (self.i.SourceRecord(dict(row.record, unit_type=unit_type), row.locator), *self.raw.units[1:])
            self.assertEqual(self.node('D::1', units=units)['properties']['unitType'], unit_type)
        for node in self.nodes():
            self.assertFalse(any(k.startswith('_') for k in node['properties']))
            self.assertNotIn('Penalty', node['type'])

    def test_penalty_absent_omits_all_penalty_properties(self):
        for n in self.nodes(penalties=()):
            self.assertFalse(any(k.startswith('penalty') for k in n['properties']))

    def test_penalty_sparse_null_omits_no_zero_or_false_default(self):
        p = wrap(self.i, dict(self.raw.penalties[0].record, phat_tien_min=None,
                             canh_cao=None, tuoc_gplx_thang=None), 'penalties')
        props = self.node('D::2', penalties=(p,))['properties']
        self.assertNotIn('penaltyPhatTienMin', props)
        self.assertNotIn('penaltyCanhCao', props)
        self.assertNotIn('penaltyTuocGplxThangMin', props)
        self.assertEqual(props['penaltyPhatTienMax'], 7)

    def test_long_unicode_text_preserved(self):
        text = ('Đường e\u0301\n'*100000)[:757423]
        row = self.raw.units[0]
        units = (self.i.SourceRecord(dict(row.record, text=text), row.locator), *self.raw.units[1:])
        self.assertEqual(self.node('D::1', units=units)['properties']['text'], text)
        self.assertEqual(len(text), 757423)

    def test_node_order_independent_of_dict_and_record_order(self):
        def reverse(rows):
            return tuple(self.i.SourceRecord(dict(reversed(list(r.record.items()))), r.locator)
                         for r in reversed(rows))
        self.assertEqual(self.nodes(), self.nodes(documents=reverse(self.raw.documents),
                                  units=reverse(self.raw.units), signs=reverse(self.raw.signs)))

    def test_hierarchy_and_sign_tuples_exact(self):
        tuples = [r['tuple'] for r in self.relations()]
        self.assertIn(('VietRoadTraffic.LegalDocument', 'D', 'hasUnit', 'VietRoadTraffic.LegalUnit', 'D::1'), tuples)
        self.assertIn(('VietRoadTraffic.LegalUnit', 'D::1', 'hasChild', 'VietRoadTraffic.LegalUnit', 'D::2'), tuples)
        self.assertIn(('VietRoadTraffic.LegalUnit', 'D::1', 'hasSign', 'VietRoadTraffic.TrafficSign', 'S::QCVN2024'), tuples)
        self.assertEqual(sum(t[2]=='hasSign' for t in tuples), 1)

    def test_safe_polarity_and_non_safe_excludes_edges(self):
        for classification, polarity, predicate in (
            ('SAFE_EDGE', False, 'citesUnit'), ('SAFE_EDGE', True, 'excludesUnit'),
            ('EXTERNAL_REFERENCE_ONLY', False, None), ('KEEP_UNRESOLVED_NO_EDGE', False, None),
            ('EXCLUDE_FROM_GRAPH_EDGE', False, None)):
            source = xref_record(is_exclusion=polarity)
            ledger = self.i.SourceRecord(ledger_record(self.i, source, classification), self.raw.ledger[0].locator)
            rows = self.relations(xrefs=(wrap(self.i, source, 'xrefs'),), ledger=(ledger,))
            actual = [r['tuple'][2] for r in rows if r['tuple'][2] in ('citesUnit', 'excludesUnit')]
            self.assertEqual(actual, [predicate] if predicate else [])

    def test_document_gate_five_predicates_and_exact_direction(self):
        records = tuple(wrap(self.i, {'from_doc_id': 'E', 'to_doc_id': 'D', 'rel_type': p,
                         'from_in_corpus': True, 'to_in_corpus': True, 'evidence': '', 'note': None},
                         'relations', i+1) for i,p in enumerate(('cites', 'amends', 'repeals', 'replaces', 'implements', 'consolidates')))
        exclusion = xref_record(is_exclusion=True)
        ledger = self.i.SourceRecord(ledger_record(self.i, exclusion), dict(self.raw.ledger[0].locator, line=2))
        rows = self.relations(relations=records,
                xrefs=self.raw.xrefs+(wrap(self.i, exclusion, 'xrefs', 2),), ledger=self.raw.ledger+(ledger,))
        self.assertEqual({r['tuple'][2] for r in rows}, set(CONTRACT['relations']))
        for r in rows:
            if r['tuple'][2] in ('cites', 'amends', 'repeals', 'replaces', 'implements', 'consolidates'):
                self.assertEqual(r['tuple'][1::3], ('E', 'D'))
                spec = self.m.aggregate_relations([r], CONTRACT)[0]
                self.assertEqual(spec['properties']['evidence'], '')
                self.assertNotIn('note', spec['properties'])

    def test_document_gate_external_oos_and_truthy_flags_no_placeholder(self):
        for changes in ({'to_doc_id': 'EXT'}, {'from_doc_id': '22_VBHN_BXD'},
                        {'from_in_corpus': 1}, {'to_in_corpus': 'true'}, {'from_in_corpus': False}):
            source = dict(from_doc_id='E', to_doc_id='D', rel_type='cites',
                          from_in_corpus=True, to_in_corpus=True)
            source.update(changes)
            rows = self.relations(relations=(wrap(self.i, source, 'relations'),))
            self.assertFalse(any(r['tuple'][2]=='cites' for r in rows))
        self.assertEqual(len(self.nodes()), 6)

    def test_document_gate_invalid_included_predicate_raises(self):
        row = wrap(self.i, dict(from_doc_id='D', to_doc_id='E', rel_type='CITES',
                               from_in_corpus=True, to_in_corpus=True), 'relations')
        with self.assertRaisesRegex(self.m.MappingError, 'relations.jsonl:1.*rel_type'):
            self.relations(relations=(row,))

    def test_edge_key_exact_golden_and_predicate_identity(self):
        fields = ('VietRoadTraffic.LegalUnit', '100_2019_ND_CP::D30', 'citesUnit',
                  'VietRoadTraffic.LegalUnit', '100_2019_ND_CP::D24::K2::Pb')
        key = self.m.application_edge_key(fields)
        self.assertEqual(key, 'd5959dd54304f52ec86d8f71d342e5f22780240bc4f1a98849390635ed3851ff')
        self.assertEqual(key, self.m.application_edge_key(list(fields)))
        changed = list(fields)
        changed[2] = 'excludesUnit'
        self.assertNotEqual(key, self.m.application_edge_key(changed))
        unicode_fields = ('VietRoadTraffic.LegalUnit', ' Đường e\u0301 ', 'citesUnit',
                          'VietRoadTraffic.LegalUnit', ' đích ')
        expected = hashlib.sha256(json.dumps(list(unicode_fields), ensure_ascii=False,
                                  separators=(',', ':')).encode('utf-8')).hexdigest()
        self.assertEqual(self.m.application_edge_key(unicode_fields), expected)

    def xref_rows(self, records):
        sources = tuple(wrap(self.i, record, 'xrefs', i+1) for i,record in enumerate(records))
        ledger = tuple(self.i.SourceRecord(ledger_record(self.i, record), dict(self.raw.ledger[0].locator, line=i+1))
                       for i,record in enumerate(records))
        return [r for r in self.relations(xrefs=sources, ledger=ledger) if r['tuple'][2]=='citesUnit']

    def test_evidence_outside_identity_and_distinct_evidence_aggregated(self):
        records = [xref_record(), xref_record(evidence='Khoản 2 Điều 1')]
        rows = self.xref_rows(records)
        self.assertEqual(rows[0]['application_edge_key'], rows[1]['application_edge_key'])
        specs = self.m.aggregate_relations(rows, CONTRACT)
        self.assertEqual(len(specs), 1)
        props = specs[0]['properties']
        evidence = json.loads(props['evidenceRecords'])
        classification = json.loads(props['classificationProvenance'])
        self.assertEqual({e['evidence'] for e in evidence}, {'Khoản 2', 'Khoản 2 Điều 1'})
        self.assertEqual(len(classification), 2)
        for e in evidence:
            original = records[0] if e['evidence']=='Khoản 2' else records[1]
            self.assertEqual({k:e[k] for k in original}, original)
            self.assertEqual(e['record_fingerprint'], self.i.xref_fingerprint(original))
            self.assertEqual(e['source_locator']['source_path'], 'data/processed/meta/xrefs.jsonl')
        for c in classification:
            self.assertEqual(c['artifact_name'], 'xref_a3g2_final_ledger.jsonl')
            self.assertEqual(c['artifact_sha256'], dict(self.i.ARTIFACT_HASHES)[c['artifact_name']])
            self.assertEqual(c['provenance'], {'notes': ['nguồn nguyên trạng']})

    def test_permutation_invariant_and_byte_identical_provenance_dedup_only(self):
        rows = self.xref_rows([xref_record(evidence='Z'), xref_record(evidence='á'), xref_record(evidence='A')])
        expected = self.m.aggregate_relations(rows, CONTRACT)
        for permutation in itertools.permutations(rows):
            self.assertEqual(self.m.aggregate_relations(list(permutation), CONTRACT), expected)
        self.assertEqual(self.m.aggregate_relations(rows+[copy.deepcopy(rows[0])], CONTRACT), expected)
        evidence = json.loads(expected[0]['properties']['evidenceRecords'])
        serialized = [json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8') for x in evidence]
        self.assertEqual(serialized, sorted(serialized))

    def test_same_evidence_with_distinct_locator_and_ledger_not_deduped(self):
        row = self.xref_rows([xref_record()])[0]
        other = copy.deepcopy(row)
        other['properties']['evidence_records'][0]['source_locator']['line'] = 8
        other['properties']['source_record'][0]['line'] = 8
        other['properties']['classification_provenance'][0]['provenance']['notes'].append('khác')
        props = self.m.aggregate_relations([row, other], CONTRACT)[0]['properties']
        self.assertEqual(len(json.loads(props['evidenceRecords'])), 2)
        self.assertEqual(len(json.loads(props['classificationProvenance'])), 2)

    def test_source_invariant_conflicts_raise_including_missing_vs_null(self):
        for changes in ({'scope': 'different'}, {'from_so_hieu': 'different'}, {'future': None}):
            rows = self.xref_rows([xref_record(), xref_record(evidence='Other', **changes)])
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(self.m.AggregationConflictError, 'invariant conflict'):
                    self.m.aggregate_relations(rows, CONTRACT)

    def test_document_scalar_conflict_raises(self):
        for changes in ({'evidence': 'other'}, {'note': ''}):
            source = dict(from_doc_id='E', to_doc_id='D', rel_type='cites',
                          from_in_corpus=True, to_in_corpus=True, evidence='original', note=None)
            rows = self.relations(relations=(wrap(self.i, source, 'relations'),
                 wrap(self.i, dict(source, **changes), 'relations', 2)))
            rows = [r for r in rows if r['tuple'][2]=='cites']
            with self.assertRaisesRegex(self.m.AggregationConflictError, 'scalar conflict'):
                self.m.aggregate_relations(rows, CONTRACT)

    def test_structural_and_document_provenance_exact(self):
        source = dict(from_doc_id='E', to_doc_id='D', rel_type='cites', from_in_corpus=True,
                      to_in_corpus=True, evidence=None, note='')
        record = wrap(self.i, source, 'relations')
        specs = self.m.aggregate_relations(self.relations(relations=(record,)), CONTRACT)
        structural = next(s for s in specs if s['tuple'][2]=='hasChild')
        self.assertEqual(json.loads(structural['properties']['sourceRecord']), [self.raw.units[1].locator])
        doc = next(s for s in specs if s['tuple'][2]=='cites')
        self.assertEqual(json.loads(doc['properties']['sourceRecord']),
                         [{'record': source, 'locator': record.locator}])
        self.assertNotIn('evidence', doc['properties'])
        self.assertEqual(doc['properties']['note'], '')

    def test_empty_aggregation_and_no_source_relation_rejected(self):
        self.assertEqual(self.m.aggregate_relations([], CONTRACT), [])
        row = self.relations()[0]
        row['properties']['source_record'] = []
        with self.assertRaisesRegex(self.m.MappingError, 'source_record'):
            self.m.aggregate_relations([row], CONTRACT)

    def test_mapping_output_does_not_mutate_or_alias_sources(self):
        before = copy.deepcopy(self.raw)
        rows = self.m.map_relation_rows(self.inputs, CONTRACT)
        xref = next(r for r in rows if r['tuple'][2]=='citesUnit')
        xref['properties']['classification_provenance'][0]['provenance']['notes'].append('changed output')
        self.assertEqual(self.raw, before)
        self.m.map_nodes(self.inputs, CONTRACT)
        self.assertEqual(self.raw, before)


if __name__ == '__main__':
    unittest.main()
