"""Small synthetic corpus exercises input gates, never the full C3 dataset."""
import copy
from dataclasses import replace
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import unicodedata


CONTRACT = json.loads((Path(__file__).resolve().parents[2] /
                       'kag/schema/schema_contract.json').read_text(encoding='utf-8'))
PATHS = {'documents': 'data/processed/meta/documents.jsonl',
         'units': 'data/processed/units/units.jsonl',
         'penalties': 'data/processed/penalties/penalties.jsonl',
         'signs': 'data/processed/signs/signs.jsonl',
         'relations': 'data/processed/meta/relations.jsonl',
         'xrefs': 'data/processed/meta/xrefs.jsonl'}


def document(doc_id='D', **changes):
    return dict(doc_id=doc_id, so_hieu='1/2026/NĐ-CP', title='Luật đường bộ',
                loai='Nghị định', co_quan='Chính phủ', scope='in_scope', tier='core',
                ngay_ban_hanh='2026-01-01', source_url='https://example.test/source',
                source_kind='OFFICIAL', **changes)


def unit(unit_id='D::1', doc_id='D', parent_id=None, **changes):
    return dict(unit_id=unit_id, doc_id=doc_id, so_hieu='1/2026/NĐ-CP',
                unit_type='Dieu', text='Điều 1. Đường bộ', order=0, parent_id=parent_id,
                **changes)


def wrap(module, record, family, line=1):
    return module.SourceRecord(copy.deepcopy(record),
                              dict(source_path=PATHS[family], file_sha256='a'*64, line=line))


def xref_record(**changes):
    record = dict(from_doc_id='D', from_so_hieu='1/2026/NĐ-CP', from_unit_id='D::1',
                  to_doc_id='D', to_so_hieu='1/2026/NĐ-CP', to_unit_id='D::2',
                  to_dieu=None, to_khoan=None, to_diem=None, evidence='Khoản 2',
                  scope='internal', is_exclusion=False, in_corpus=True)
    record.update(changes)
    return record


def ledger_record(module, record, classification='SAFE_EDGE'):
    return dict({k: copy.deepcopy(v) for k, v in record.items() if k != 'from_so_hieu'},
                record_fingerprint=module.xref_fingerprint(record), downstream_use=classification,
                provenance={'notes': ['nguồn nguyên trạng']}, source_order_index=0)


def synthetic_inputs(module, **changes):
    raw = xref_record()
    inputs = module.BuilderInputs(
        documents=tuple(wrap(module, document(doc), 'documents', i+1)
                        for i, doc in enumerate(('D', 'E'))),
        units=(wrap(module, unit(), 'units'),
               wrap(module, unit('D::2', parent_id='D::1'), 'units', 2),
               wrap(module, unit('E::1', 'E'), 'units', 3)),
        penalties=(wrap(module, {'penalty_id': 'D::2', 'unit_id': 'D::2', 'doc_id': 'D',
                                  'phat_tien_min': 0, 'phat_tien_max': 7, 'canh_cao': False,
                                  'tuoc_gplx_thang': [0, 7]}, 'penalties'),),
        signs=(wrap(module, {'sign_id': 'S::QCVN2024', 'unit_id': 'D::1', 'doc_id': 'D',
                            'so_hieu': 'QCVN 41:2024', 'ma_bien': 'P.101', 'nhom': 'Cấm',
                            'qcvn': 'QCVN 41:2024', 'ten': '', 'mo_ta': 'Đường cấm',
                            'bien_phu_variant': '', 'ngay_hieu_luc': '2025-01-01',
                            'ngay_het_hieu_luc': None}, 'signs'),),
        relations=(), xrefs=(wrap(module, raw, 'xrefs'),),
        ledger=(module.SourceRecord(ledger_record(module, raw),
                 dict(source_path='xref_a3g2_final_ledger.jsonl', file_sha256='b'*64, line=1)),),
        markdown_paths=frozenset(('data/processed/documents/D.md',
                                  'data/processed/documents/E.md')),
        artifact_hashes=dict(module.ARTIFACT_HASHES))
    return replace(inputs, **changes)


class InputsTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.builder.inputs'),
                             'C2 input integrity implementation missing')
        self.m = importlib.import_module('kag.builder.inputs')
        self.inputs = synthetic_inputs(self.m)

    def validate(self, **changes):
        return self.m.validate_input_integrity(replace(self.inputs, **changes), CONTRACT)

    def assert_bad(self, message, **changes):
        with self.assertRaisesRegex(self.m.InputIntegrityError, message):
            self.validate(**changes)

    def test_production_whitelist_scope_and_existing_markdown(self):
        excluded = wrap(self.m, document('22_VBHN_BXD', scope_marker='original'), 'documents', 3)
        excluded.record['scope'] = 'out_of_scope'
        missing = wrap(self.m, document('MISSING'), 'documents', 4)
        docs = self.inputs.documents + (excluded, missing)
        result = self.validate(documents=docs,
              markdown_paths=self.inputs.markdown_paths | {'data/processed/documents/22_VBHN_BXD.md'})
        self.assertEqual(set(result.documents), {'D', 'E'})
        self.assertEqual(result.penalties['D::2'].record['phat_tien_min'], 0)

    def test_exact_identity_preserved(self):
        exact = ' D::e\u0301 '
        raw = synthetic_inputs(self.m, units=(wrap(self.m, unit(exact), 'units'),),
                               penalties=(), signs=(), xrefs=(), ledger=())
        result = self.m.validate_input_integrity(raw, CONTRACT)
        self.assertEqual(list(result.units), [exact])
        self.assertEqual(result.units[exact].record['unit_id'], exact)

    def test_duplicate_doc_unit_sign_fail_including_excluded_docs(self):
        for family, identity in (('documents', 'doc_id'), ('units', 'unit_id'), ('signs', 'sign_id')):
            rows = getattr(self.inputs, family)
            duplicate = self.m.SourceRecord(copy.deepcopy(rows[0].record), dict(rows[0].locator, line=99))
            with self.subTest(family=family):
                self.assert_bad(f'{PATHS[family]}:99.*duplicate {identity}', **{family: rows+(duplicate,)})

    def test_missing_production_document_fails(self):
        bad = wrap(self.m, unit('OUT::1', 'OUT'), 'units', 4)
        self.assert_bad('units.jsonl:4.*production doc', units=self.inputs.units+(bad,))

    def test_parent_missing_and_missing_parent_key_fail(self):
        for parent in ('absent', ''):
            bad = wrap(self.m, unit('D::orphan', parent_id=parent), 'units', 4)
            self.assert_bad('parent', units=self.inputs.units+(bad,))
        bad = wrap(self.m, unit('D::orphan'), 'units', 4)
        del bad.record['parent_id']
        self.assert_bad('parent_id.*missing', units=self.inputs.units+(bad,))

    def test_cross_document_parent_fails(self):
        bad = wrap(self.m, unit('D::bad', parent_id='E::1'), 'units', 4)
        self.assert_bad('cross-document parent', units=self.inputs.units+(bad,))

    def test_cycle_and_self_cycle_fail(self):
        for parent in ('D::1', 'D::2'):
            root = wrap(self.m, unit(parent_id=parent), 'units')
            self.assert_bad('cycle', units=(root,)+self.inputs.units[1:])

    def test_deep_hierarchy_uses_no_recursion_limit(self):
        rows = tuple(wrap(self.m, unit(f'U{i}', parent_id=f'U{i-1}' if i else None),
                          'units', i+1) for i in range(1200))
        result = self.validate(units=rows, penalties=(), signs=(), xrefs=(), ledger=())
        self.assertEqual(len(result.units), 1200)

    def test_penalty_join_orphan_duplicate_mismatch_document_fail(self):
        original = self.inputs.penalties[0]
        for changes, reason in (({'unit_id': 'missing'}, 'orphan penalty'),
                                ({'penalty_id': 'other'}, 'penalty_id.*unit_id'),
                                ({'doc_id': 'E'}, 'document mismatch')):
            bad = wrap(self.m, dict(original.record, **changes), 'penalties', 8)
            with self.subTest(changes=changes):
                self.assert_bad('penalties.jsonl:8.*'+reason, penalties=(bad,))
        self.assert_bad('duplicate penalty target', penalties=(original, original))

    def test_penalty_invalid_integer_boolean_and_range_fail(self):
        original = self.inputs.penalties[0].record
        for changes in ({'phat_tien_min': True}, {'phat_tien_max': '7'}, {'tru_diem_gplx': 7.0},
                        {'canh_cao': 0}, {'tuoc_gplx_thang': [1]}, {'tuoc_gplx_thang': '1,2'},
                        {'tuoc_gplx_thang': [False, 7]}, {'tuoc_gplx_thang': [7, 0]},
                        {'phat_tien_min': 8, 'phat_tien_max': 7}, {'phat_tien_min': -1}):
            with self.subTest(changes=changes):
                self.assert_bad('penalties.jsonl:9.*penalty',
                       penalties=(wrap(self.m, dict(original, **changes), 'penalties', 9),))

    def test_penalty_null_range_and_sparse_values_valid(self):
        p = wrap(self.m, dict(self.inputs.penalties[0].record, tuoc_gplx_thang=None,
                              canh_cao=None, phat_tien_min=None), 'penalties')
        self.assertEqual(self.validate(penalties=(p,)).penalties['D::2'].record, p.record)

    def test_sign_orphan_and_document_mismatch_fail(self):
        for changes, reason in (({'unit_id': 'missing'}, 'orphan sign'),
                                ({'doc_id': 'E'}, 'document mismatch')):
            self.assert_bad(reason, signs=(wrap(self.m, dict(self.inputs.signs[0].record,
                                                            **changes), 'signs'),))

    def test_required_types_unit_enum_and_date_alias_conflicts_fail(self):
        for changes in ({'unit_type': 'dieu'}, {'order': True}, {'text': None}):
            self.assert_bad('units.jsonl:1', units=(wrap(self.m, dict(unit(), **changes), 'units'),
                                                   *self.inputs.units[1:]))
        bad = wrap(self.m, document('D', effective_from='2026-01-01',
                                    ngay_hieu_luc='2026-02-01'), 'documents')
        self.assert_bad('effective_from.*alias conflict', documents=(bad, self.inputs.documents[1]))

    def test_fingerprint_all_fields_exact_and_permutation_of_dict_keys(self):
        source = xref_record()
        expected = hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True,
                                  separators=(',', ':')).encode('utf-8')).hexdigest()
        self.assertEqual(self.m.xref_fingerprint(source), expected)
        self.assertEqual(self.m.xref_fingerprint(dict(reversed(list(source.items())))), expected)
        for key in source:
            changed = dict(source, **{key: 'changed'})
            self.assertNotEqual(self.m.xref_fingerprint(changed), expected, key)
        self.assertNotEqual(self.m.xref_fingerprint(dict(source, future_field=1)), expected)

    def test_fingerprint_no_trim_normalization_or_null_conversion(self):
        source = xref_record(from_so_hieu='Đường')
        for changed in (dict(source, from_so_hieu=' Đường '),
                        dict(source, from_so_hieu=unicodedata.normalize('NFD', 'Đường')),
                        {k:v for k,v in source.items() if k!='to_diem'}):
            self.assertNotEqual(self.m.xref_fingerprint(source), self.m.xref_fingerprint(changed))

    def test_ledger_missing_extra_duplicate_and_source_duplicate_fail_before_filter(self):
        self.assert_bad('ledger missing', ledger=())
        extra = self.m.SourceRecord(dict(self.inputs.ledger[0].record, record_fingerprint='c'*64),
                                    self.inputs.ledger[0].locator)
        self.assert_bad('ledger extra', ledger=self.inputs.ledger+(extra,))
        self.assert_bad('duplicate.*fingerprint', ledger=self.inputs.ledger*2)
        self.assert_bad('duplicate.*fingerprint', xrefs=self.inputs.xrefs*2)
        non_safe = self.m.SourceRecord(dict(self.inputs.ledger[0].record,
                                           downstream_use='EXTERNAL_REFERENCE_ONLY'),
                                       self.inputs.ledger[0].locator)
        distinct = wrap(self.m, xref_record(evidence='Nguồn khác'), 'xrefs', 2)
        self.assert_bad('ledger missing', xrefs=self.inputs.xrefs+(distinct,), ledger=(non_safe,))

    def test_ledger_shared_field_conflicts_fail_exactly(self):
        for changes in ({'scope': 'changed'}, {'in_corpus': 1}, {'evidence': 'Changed'}):
            bad = self.m.SourceRecord(dict(self.inputs.ledger[0].record, **changes),
                                      self.inputs.ledger[0].locator)
            self.assert_bad('source/ledger invariant conflict', ledger=(bad,))

    def test_all_four_classifications_accepted_unknown_fails(self):
        for classification in ('SAFE_EDGE', 'EXTERNAL_REFERENCE_ONLY',
                               'KEEP_UNRESOLVED_NO_EDGE', 'EXCLUDE_FROM_GRAPH_EDGE'):
            ledger = self.m.SourceRecord(dict(self.inputs.ledger[0].record,
                                              downstream_use=classification),
                                          self.inputs.ledger[0].locator)
            self.assertEqual(len(self.validate(ledger=(ledger,)).xref_ledger), 1)
        bad = self.m.SourceRecord(dict(self.inputs.ledger[0].record, downstream_use='safe_edge'),
                                  self.inputs.ledger[0].locator)
        self.assert_bad('classification', ledger=(bad,))

    def test_safe_edge_endpoint_document_bool_and_evidence_gate_fail(self):
        for changes in ({'is_exclusion': 'false'}, {'is_exclusion': 0}, {'in_corpus': 1},
                        {'in_corpus': False}, {'evidence': ' \t'}, {'to_unit_id': 'missing'},
                        {'from_unit_id': 'missing'}, {'to_doc_id': 'E'}, {'from_doc_id': 'E'}):
            source = xref_record(**changes)
            ledger = self.m.SourceRecord(ledger_record(self.m, source), self.inputs.ledger[0].locator)
            with self.subTest(changes=changes):
                self.assert_bad('SAFE_EDGE', xrefs=(wrap(self.m, source, 'xrefs'),), ledger=(ledger,))

    def test_non_safe_unresolved_endpoints_do_not_require_placeholder(self):
        source = xref_record(to_unit_id=None, to_doc_id='EXTERNAL')
        ledger = self.m.SourceRecord(ledger_record(self.m, source, 'EXTERNAL_REFERENCE_ONLY'),
                                    self.inputs.ledger[0].locator)
        result = self.validate(xrefs=(wrap(self.m, source, 'xrefs'),), ledger=(ledger,))
        self.assertEqual(set(result.units), {'D::1', 'D::2', 'E::1'})

    def test_validation_does_not_mutate_source(self):
        before = copy.deepcopy(self.inputs)
        self.validate()
        self.assertEqual(self.inputs, before)

    def disk_fixture(self, root):
        for family, relative in PATHS.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            # A blank line proves locators use original one-based file lines.
            path.write_text('\n'+''.join(json.dumps(row.record, ensure_ascii=False)+'\n'
                            for row in getattr(self.inputs, family)), encoding='utf-8')
        for relative in self.inputs.markdown_paths:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('production', encoding='utf-8')
        hashes = {}
        for name, _ in self.m.ARTIFACT_HASHES:
            path = root / name
            data = ('\n'.join(json.dumps(r.record, ensure_ascii=False) for r in self.inputs.ledger)
                    if name.endswith('.jsonl') else '{}')
            path.write_text(data, encoding='utf-8')
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        contract = copy.deepcopy(CONTRACT)
        contract['xref_contract']['xref_sha256'] = hashlib.sha256(
            (root / PATHS['xrefs']).read_bytes()).hexdigest()
        return contract, hashes

    def test_reviewed_sign_master_reproduces_builder_input(self):
        root = Path(__file__).resolve().parents[2]
        def records(relative):
            return [json.loads(line) for line in (root/relative).read_text(encoding='utf-8').split('\n') if line]
        master = json.loads((root/'data/processed/signs/signs_app.json').read_text(encoding='utf-8'))
        self.assertTrue(all(r['image_status'] in ('not_checked', 'not_applicable', 'needs_review',
                            'verified', 'missing', 'mismatch') for r in master))
        units = {r['unit_id']: r for r in records('data/processed/units/units.jsonl')}
        documents = {r['doc_id']: r for r in records('data/processed/meta/documents.jsonl')}
        self.assertEqual(self.m.convert_signs(master, units, documents),
                         records('data/processed/signs/signs.jsonl'))

    def test_sign_review_retains_specific_later_clauses_and_source_conflicts(self):
        root = Path(__file__).resolve().parents[2]
        master = json.loads((root/'data/processed/signs/signs_app.json').read_text(encoding='utf-8'))
        indexed = {r['sign_id']: r for r in master}
        for year, article in ((2019, 51), (2024, 47)):
            row = indexed[f'QCVN 41:{year}/BGTVT::IE.453c']
            self.assertEqual(row['description_scope'], 'specific')
            self.assertIn(f'{article}.4.2.', row['legal_description'])
            self.assertIn('IE.453c', row['legal_description'])
            self.assertNotIn('IE.453a', row['legal_description'])
            for code in ('IE.456a', 'IE.456b', 'IE.456c', 'W.242a', 'W.242b'):
                self.assertEqual(indexed[f'QCVN 41:{year}/BGTVT::{code}']['description_scope'], 'specific')
        for code in ('P.103', 'P.103a', 'W.239', 'W.239a'):
            self.assertEqual(indexed[f'QCVN 41:2019/BGTVT::{code}']['verification_status'], 'source_conflict')
            self.assertEqual(indexed[f'QCVN 41:2024/BGTVT::{code}']['verification_status'], 'verified_pdf')

    def test_load_inputs_relative_locator_and_whitelist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contract, hashes = self.disk_fixture(root)
            result = self.m.load_inputs(root, root/'xref_a3g2_final_ledger.jsonl',
                    root/'xref_a3g2_final_audit.json', root/'xref_a3g2_downstream_policy.json',
                    contract, expected_artifact_hashes=hashes)
            row = result.units['D::1']
            self.assertEqual(row.locator, {'source_path': PATHS['units'], 'line': 2,
                 'file_sha256': hashlib.sha256((root/PATHS['units']).read_bytes()).hexdigest()})
            self.assertEqual(set(result.documents), {'D', 'E'})

    def test_sha_mismatch_each_artifact_and_xref_fail_closed(self):
        for family in ('xref_a3g2_final_ledger.jsonl', 'xref_a3g2_final_audit.json',
                       'xref_a3g2_downstream_policy.json', PATHS['xrefs']):
            with self.subTest(family=family), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                contract, hashes = self.disk_fixture(root)
                with (root/family).open('ab') as handle:
                    handle.write(b' ')
                with self.assertRaisesRegex(self.m.InputIntegrityError, 'SHA256 mismatch'):
                    self.m.load_inputs(root, root/'xref_a3g2_final_ledger.jsonl',
                        root/'xref_a3g2_final_audit.json', root/'xref_a3g2_downstream_policy.json',
                        contract, expected_artifact_hashes=hashes)

    def test_jsonl_unicode_separators_inside_text_are_not_record_lines(self):
        row = self.inputs.units[0]
        text = 'Đường\u2028bộ\u2029Việt\u0085Nam'
        units = (self.m.SourceRecord(dict(row.record, text=text), row.locator), *self.inputs.units[1:])
        self.inputs = replace(self.inputs, units=units)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contract, hashes = self.disk_fixture(root)
            result = self.m.load_inputs(root, root/'xref_a3g2_final_ledger.jsonl',
                    root/'xref_a3g2_final_audit.json', root/'xref_a3g2_downstream_policy.json',
                    contract, expected_artifact_hashes=hashes)
            self.assertEqual(result.units['D::1'].record['text'], text)
            self.assertEqual(result.units['D::1'].locator['line'], 2)

    def test_default_sha_pins_and_no_old_ledger_fallback(self):
        self.assertEqual(dict(self.m.ARTIFACT_HASHES), {
            'xref_a3g2_final_ledger.jsonl': 'cb2770aa99f04d07f111078ee859d91f3b65fe5ec8126b6221a75202a7cfa226',
            'xref_a3g2_final_audit.json': 'f89db6fa09d3c3de1166837035e36965094d2e90127ee42d230c05bfcff38682',
            'xref_a3g2_downstream_policy.json': 'ce4614236ff3018516a5aa31b5b1086622ac86e28881a82eedbbbeee28cbc2a8'})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contract, _ = self.disk_fixture(root)
            with self.assertRaisesRegex(self.m.InputIntegrityError, 'SHA256 mismatch'):
                self.m.load_inputs(root, root/'xref_a3g2_final_ledger.jsonl',
                    root/'xref_a3g2_final_audit.json', root/'xref_a3g2_downstream_policy.json', contract)
            with self.assertRaisesRegex(self.m.InputIntegrityError, 'artifact name'):
                self.m.load_inputs(root, root/'xref_a3g_final_ledger.jsonl',
                    root/'xref_a3g2_final_audit.json', root/'xref_a3g2_downstream_policy.json', contract)


if __name__ == '__main__':
    unittest.main()
