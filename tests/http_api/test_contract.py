"""Step 1 pure contract policy; no HTTP/core invocation or source verifier."""
from dataclasses import FrozenInstanceError, asdict, replace
import importlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

from fixtures import AnswerResult, Citation, SCHEMA, USER, VerifiedSources, answered, metadata, query, sign, source

ROOT = Path(__file__).resolve().parents[2]


class ContractTests(unittest.TestCase):
    def setUp(self):
        try:
            self.api = importlib.import_module('kag.http_api.contract')
        except ModuleNotFoundError as exc:
            if exc.name not in ('kag.http_api', 'kag.http_api.contract'):
                raise
            self.fail('Step 1 pure HTTP contract module missing')

    def failure(self, code, call, *args, status=None, state=None):
        with self.assertRaises(self.api.ApiFailure) as caught:
            call(*args)
        error = caught.exception
        self.assertEqual(error.code, code)
        if status is not None:
            self.assertEqual(error.status, status)
        self.assertEqual(error.native_state, state)
        return error

    def unrepresentable(self, result, verified):
        return self.failure('V1_RESULT_UNREPRESENTABLE', self.api.project_v1, result, verified,
                            status=503, state='answered')

    def test_import_is_pure_in_fresh_process(self):
        code = '''
import sys
import kag.http_api.contract
assert 'kag.legal_solver' not in sys.modules
assert 'kag.interface' not in sys.modules
assert 'knext' not in sys.modules
assert 'openai' not in sys.modules
assert 'kag.bootstrap' not in sys.modules or not sys.modules['kag.bootstrap']._initialized
'''
        run = subprocess.run([sys.executable, '-B', '-c', code], cwd=ROOT,
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def test_query_exact_text_and_frozen_dto(self):
        value = self.api.QueryV1Request.from_dict(query())
        self.assertEqual(value.user_id, USER)
        self.assertEqual(value.message, query()['message'])
        self.assertEqual(value.context_id, '')
        self.assertEqual(asdict(value.schema_contract), SCHEMA)
        with self.assertRaises(FrozenInstanceError):
            value.message = 'changed'

    def test_query_required_fields(self):
        for key in query():
            with self.subTest(key=key):
                value = query()
                del value[key]
                self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict, value, status=422)

    def test_unknown_keys_rejected_at_both_levels(self):
        values = (query(model='other'), query(schema_contract={**SCHEMA, 'extra': True}))
        for value in values:
            with self.subTest(value=value):
                self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict, value, status=422)

    def test_no_scalar_coercion_or_nulls(self):
        for key in ('user_id', 'message', 'context_id', 'schema_contract'):
            for invalid in (None, False, 1, [], 'raw' if key == 'schema_contract' else {}):
                with self.subTest(key=key, invalid=invalid):
                    self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict,
                                 query(**{key: invalid}), status=422)

    def test_canonical_uuid_only(self):
        for invalid in ('not-uuid', USER.replace('-', ''), '{' + USER + '}',
                        'ABCDEF00-0000-4000-8000-000000000001', ' ' + USER):
            with self.subTest(invalid=invalid):
                self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict,
                             query(user_id=invalid), status=422)

    def test_schema_strict_hashes_and_namespace(self):
        for key, invalid in (('schema_sha256', 'A' * 64), ('contract_sha256', 'b' * 63),
                             ('namespace', ''), ('namespace', None), ('schema_sha256', 7)):
            with self.subTest(key=key, invalid=invalid):
                self.failure('INVALID_REQUEST', self.api.SchemaIdentity.from_dict,
                             {**SCHEMA, key: invalid}, status=422)
        self.assertNotEqual(self.api.SchemaIdentity.from_dict(SCHEMA),
                            self.api.SchemaIdentity.from_dict({**SCHEMA, 'schema_sha256': 'c' * 64}))

    def test_direct_dto_construction_also_validates(self):
        self.failure('INVALID_REQUEST', self.api.SchemaIdentity, 'VietRoadTraffic', 'bad', 'b'*64, status=422)
        schema = self.api.SchemaIdentity.from_dict(SCHEMA)
        self.failure('INVALID_REQUEST', self.api.QueryV1Request, USER, 123, '', schema, status=422)
        self.failure('INVALID_REQUEST', self.api.RetrieveRequest, 'q', schema, True, False, status=422)

    def test_empty_or_blank_message_rejected(self):
        for message in ('', ' \n\t'):
            self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict, query(message=message), status=422)

    def test_message_4000_utf16_passes(self):
        message = '😀' * 2000
        value = self.api.QueryV1Request.from_dict(query(message=message))
        self.assertEqual(value.message, message)
        self.assertEqual(self.api.utf16_units(message), 4000)

    def test_message_4001_utf16_fails(self):
        self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict,
                     query(message='😀' * 2000 + 'a'), status=422)

    def test_utf16_combining_marks_not_normalized(self):
        value = 'e\u0301' * 2000
        self.assertEqual(self.api.utf16_units(value), 4000)
        self.assertEqual(self.api.QueryV1Request.from_dict(query(message=value)).message, value)

    def test_context_nonempty_not_supported(self):
        self.failure('CONTEXT_NOT_SUPPORTED', self.api.QueryV1Request.from_dict,
                     query(context_id='a' * 250), status=422)

    def test_context_251_utf16_invalid_request(self):
        self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict,
                     query(context_id='a' * 251), status=422)

    def test_lone_surrogate_dto_rejected(self):
        self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_dict, query(message='\ud800'), status=422)
        self.failure('INVALID_REQUEST', self.api.utf16_units, '\udfff', status=422)

    def test_valid_json_utf8_roundtrip(self):
        for request in (query(), query(search_queries=['Giấy phép lái xe mô tô','Giấy phép lái xe ô tô'])):
            with self.subTest(request=request):
                raw = json.dumps(request, ensure_ascii=False).encode('utf-8')
                self.assertEqual(asdict(self.api.QueryV1Request.from_json(raw)), {'search_queries': [], **request})

    def test_duplicate_keys_rejected_nested_and_top_level(self):
        raws = (b'{"message":"q","message":"q"}',
                b'{"schema_contract":{"namespace":"x","namespace":"x"}}')
        for raw in raws:
            with self.subTest(raw=raw):
                self.failure('INVALID_JSON', self.api.QueryV1Request.from_json, raw, status=400)

    def test_json_nonfinite_and_overflow_rejected(self):
        for number in (b'NaN', b'Infinity', b'-Infinity', b'1e999'):
            with self.subTest(number=number):
                self.failure('INVALID_JSON', self.api.QueryV1Request.from_json,
                             b'{"x":' + number + b'}', status=400)

    def test_json_bom_bad_utf8_syntax_and_surrogate_rejected(self):
        for raw in (b'\xef\xbb\xbf{}', b'\xff', b'{', b'{"message":"\\ud800"}', b'{"\\udfff":1}'):
            with self.subTest(raw=raw):
                self.failure('INVALID_JSON', self.api.QueryV1Request.from_json, raw, status=400)

    def test_json_nonobject_or_wrong_input_type_rejected(self):
        for raw in (b'[]', b'null', b'"text"'):
            self.failure('INVALID_REQUEST', self.api.QueryV1Request.from_json, raw, status=422)
        self.failure('INVALID_JSON', self.api.QueryV1Request.from_json, '{}', status=400)

    def test_retrieve_defaults_and_explicit_values(self):
        payload = {'message': query()['message'], 'schema_contract': SCHEMA}
        try:
            value = self.api.RetrieveRequest.from_dict(payload)
        except self.api.ApiFailure as exc:
            self.fail('Service-only retrieve rejected: ' + exc.code)
        self.assertEqual((value.top_k, value.expand), (10, False))
        self.assertEqual(asdict(value), {**payload, 'top_k': 10, 'expand': False})
        for top_k in (1, 10):
            explicit = self.api.RetrieveRequest.from_dict({**payload, 'top_k': top_k, 'expand': True})
            self.assertEqual((explicit.top_k, explicit.expand), (top_k, True))
        with self.assertRaises(FrozenInstanceError):
            value.message = 'changed'

    def test_retrieve_strict_limits_and_no_extra_fields(self):
        payload = {'message': 'q', 'schema_contract': SCHEMA}
        for changes in ({'top_k': True}, {'top_k': 0}, {'top_k': 11}, {'top_k': '10'},
                        {'top_k': 1.0}, {'top_k': None}, {'top_k': []}, {'expand': 1},
                        {'expand': 'false'}, {'expand': None}, {'expand': []}, {'context_id': ''}):
            with self.subTest(changes=changes):
                self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_dict,
                             {**payload, **changes}, status=422)

    def test_retrieve_user_id_forbidden_even_null_at_both_boundaries(self):
        for user_id in (USER, None, False, ''):
            payload = {'message': 'q', 'schema_contract': SCHEMA, 'user_id': user_id}
            with self.subTest(user_id=user_id):
                self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_dict, payload, status=422)
                self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_json,
                             json.dumps(payload).encode(), status=422)

    def test_retrieve_required_fields_and_unknown_fields(self):
        payload = {'message': 'q', 'schema_contract': SCHEMA}
        for key in payload:
            self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_dict,
                         {k: v for k, v in payload.items() if k != key}, status=422)
        for value in ({**payload, 'model': 'other'},
                      {**payload, 'schema_contract': {**SCHEMA, 'extra': True}}):
            self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_dict, value, status=422)

    def test_retrieve_utf8_roundtrip_preserves_exact_text_without_user(self):
        payload = {'message': ' e\u0301😀\n ', 'schema_contract': SCHEMA, 'top_k': 1, 'expand': True}
        try:
            value = self.api.RetrieveRequest.from_json(json.dumps(payload, ensure_ascii=False).encode())
        except self.api.ApiFailure as exc:
            self.fail('Service-only UTF-8 retrieve rejected: ' + exc.code)
        self.assertEqual(asdict(value), payload)

    def test_retrieve_message_utf16_boundary_and_wrong_types(self):
        payload = {'message': '😀' * 2000, 'schema_contract': SCHEMA}
        try:
            value = self.api.RetrieveRequest.from_dict(payload)
        except self.api.ApiFailure as exc:
            self.fail('Valid 4000 UTF-16 retrieve rejected: ' + exc.code)
        self.assertEqual(value.message, payload['message'])
        for invalid in ('😀' * 2000 + 'a', '', ' \n\t', None, False, 7, [], {}, '\ud800'):
            self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_dict,
                         {**payload, 'message': invalid}, status=422)

    def test_retrieve_schema_identity_strict(self):
        for invalid in (None, [], 'raw', {**SCHEMA, 'namespace': ''},
                        {**SCHEMA, 'schema_sha256': 'A' * 64},
                        {**SCHEMA, 'contract_sha256': 'b' * 63}):
            self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_dict,
                         {'message': 'q', 'schema_contract': invalid}, status=422)

    def test_retrieve_invalid_json_utf8_bom_surrogates_duplicates_nonfinite(self):
        for raw in (b'{', b'\xff', b'\xef\xbb\xbf{}', b'{"message":"\\ud800"}',
                    b'{"\\udfff":1}', b'{"message":"q","message":"q"}',
                    b'{"schema_contract":{"namespace":"x","namespace":"x"}}',
                    b'{"top_k":NaN}', b'{"top_k":Infinity}', b'{"top_k":-Infinity}',
                    b'{"top_k":1e999}'):
            with self.subTest(raw=raw):
                self.failure('INVALID_JSON', self.api.RetrieveRequest.from_json, raw, status=400)

    def test_retrieve_nonobjects_and_wrong_json_input_type(self):
        for raw in (b'null', b'[]', b'"text"'):
            self.failure('INVALID_REQUEST', self.api.RetrieveRequest.from_json, raw, status=422)
        self.failure('INVALID_JSON', self.api.RetrieveRequest.from_json, '{}', status=400)

    def test_projection_preserves_answer_all_citations_and_order(self):
        parent = source(identity='unit-parent', unit_id='unit-parent', text='Nguồn cha.')
        result, verified = answered(source(), parent)
        projected = self.api.project_v1(result, verified)
        self.assertEqual(projected, {'answer': result.answer, 'citations': [asdict(c) for c in result.citations]})
        self.assertEqual(result.citations, tuple(s.citation for s in verified.citations))
        self.assertNotIn('abstained', projected)
        self.assertNotIn('reason', projected)

    def test_offsets_remain_codepoints_not_utf16_or_bytes(self):
        result, verified = answered(source(text='e\u0301😀'))
        citation = self.api.project_v1(result, verified)['citations'][0]
        self.assertEqual(citation['end'], 3)
        self.assertEqual(self.api.utf16_units(citation['quote']), 4)
        self.assertEqual(len(citation['quote'].encode()), 7)

    def test_abstention_is_failure_without_fabricated_answer(self):
        result = AnswerResult('Chưa đủ bằng chứng để kết luận pháp lý cho câu hỏi này.', (), True,
                              'private credential and internal reason')
        error = self.failure('KAG_ABSTAINED', self.api.project_v1, result, VerifiedSources(()),
                             status=503, state='abstained')
        self.assertNotIn('private credential', str(error) + repr(error))
        self.assertFalse(hasattr(error, 'answer'))

    def test_malformed_abstention_with_citations_rejected(self):
        result, verified = answered()
        self.failure('INVALID_NATIVE_RESULT', self.api.project_v1, replace(result, abstained=True), verified, status=502)

    def test_native_result_types_and_invariants_rejected(self):
        result, verified = answered()
        invalids = (result.to_dict(), replace(result, abstained=0), replace(result, answer=None),
                    replace(result, answer=' '), replace(result, answer='\ud800'),
                    replace(result, citations=list(result.citations)), replace(result, citations=()),
                    replace(result, citations=({},)))
        for invalid in invalids:
            with self.subTest(invalid=invalid):
                self.failure('INVALID_NATIVE_RESULT', self.api.project_v1, invalid, verified, status=502)

    def test_sign_result_cannot_be_projected(self):
        self.unrepresentable(*answered(sign()))

    def test_sign_with_unit_and_identical_text_cannot_be_projected(self):
        sign_source = replace(sign(), citation=replace(sign().citation, unit_id='unit-1'))
        self.unrepresentable(*answered(sign_source))

    def test_document_metadata_support_rejects_entire_result(self):
        result, verified = answered(source(), metadata())
        self.unrepresentable(result, verified)
        self.assertEqual(len(result.citations), 2)

    def test_whitespace_metadata_support_is_unrepresentable_not_invalid_source(self):
        support = source('LegalDocument', 'document-1', 'hieu_luc_note', ' ', unit_id=None)
        self.unrepresentable(*answered(source(), support))

    def test_unpublished_or_historical_certificate_rejects_v1(self):
        self.unrepresentable(*answered(source(java_eligible=False)))

    def test_missing_or_incomplete_certificate_fails_closed(self):
        result, verified = answered()
        for invalid in (None, {}, VerifiedSources(()), replace(verified, citations=list(verified.citations))):
            with self.subTest(invalid=invalid):
                self.failure('SOURCE_VALIDATION_FAILED', self.api.project_v1, result, invalid, status=502)

    def test_certificate_order_and_binding_must_match_native(self):
        result, verified = answered(source(), source(identity='unit-2', unit_id='unit-2'))
        invalid = replace(verified, citations=tuple(reversed(verified.citations)))
        self.failure('SOURCE_VALIDATION_FAILED', self.api.project_v1, result, invalid, status=502)
        invalid_result = replace(result, citations=(replace(result.citations[0], doc_id='other'), result.citations[1]))
        self.failure('SOURCE_VALIDATION_FAILED', self.api.project_v1, invalid_result, verified, status=502)

    def test_source_text_or_identity_changed_rejected(self):
        result, verified = answered()
        record = verified.citations[0]
        for changes in ({'source_text': record.source_text + ' changed'}, {'entity_id': 'other'},
                        {'entity_type': 'Unknown.LegalUnit'}, {'java_eligible': 1}):
            with self.subTest(changes=changes):
                self.failure('SOURCE_VALIDATION_FAILED', self.api.project_v1, result,
                             VerifiedSources((replace(record, **changes),)), status=502)

    def test_missing_doc_or_unit_identity_rejected(self):
        result, verified = answered()
        for changes in ({'doc_id': ''}, {'unit_id': None}, {'evidence_id': ''}):
            with self.subTest(changes=changes):
                bad = replace(result.citations[0], **changes)
                bound = replace(verified.citations[0], citation=bad)
                self.failure('SOURCE_VALIDATION_FAILED', self.api.project_v1,
                             replace(result, citations=(bad,)), VerifiedSources((bound,)), status=502)

    def test_wrong_hash_field_and_whole_source_spans_rejected(self):
        result, verified = answered()
        for changes in ({'evidence_id': '0'*64}, {'field': 'title'}, {'start': 1}, {'start': False},
                        {'end': True}, {'end': -1}, {'end': len(result.citations[0].quote)-1},
                        {'quote': result.citations[0].quote[:-1]}):
            with self.subTest(changes=changes):
                bad = replace(result.citations[0], **changes)
                bound = replace(verified.citations[0], citation=bad)
                self.failure('SOURCE_VALIDATION_FAILED', self.api.project_v1,
                             replace(result, citations=(bad,)), VerifiedSources((bound,)), status=502)

    def test_answer_20000_utf16_passes_20001_fails(self):
        result, verified = answered(source(text='a'), answer='😀'*10000)
        self.assertEqual(self.api.project_v1(result, verified)['answer'], result.answer)
        self.unrepresentable(replace(result, answer=result.answer + 'a'), verified)

    def test_quote_20000_utf16_passes_20001_fails(self):
        result, verified = answered(source(text='😀'*10000), answer='a')
        self.assertEqual(self.api.project_v1(result, verified)['citations'][0]['quote'], result.citations[0].quote)
        self.unrepresentable(*answered(source(text='😀'*10000 + 'a'), answer='a'))

    def test_twenty_citations_preserved_twenty_one_rejected(self):
        sources = tuple(source(identity=f'unit-{i}', unit_id=f'unit-{i}', text='a') for i in range(21))
        result, verified = answered(*sources[:20])
        self.assertEqual(len(self.api.project_v1(result, verified)['citations']), 20)
        self.unrepresentable(*answered(*sources))

    def test_strict_json_output_preserves_unicode_and_null(self):
        result, verified = answered()
        payload = self.api.project_v1(result, verified)
        wire = self.api.encode_v1(payload)
        self.assertIs(type(wire), bytes)
        self.assertIn('😀'.encode(), wire)
        self.assertEqual(json.loads(wire), payload)
        self.assertIn(b'"sign_id":null', wire)

    def test_wire_245760_bytes_passes_one_over_fails(self):
        payload = {'x': 'a' * (245760 - 8)}
        self.assertEqual(len(self.api.encode_v1(payload)), 245760)
        self.failure('V1_RESULT_UNREPRESENTABLE', self.api.encode_v1,
                     {'x': payload['x'] + 'a'}, status=503, state='answered')

    def test_wire_counts_escaped_json_bytes(self):
        payload = {'x': '\x00'*100 + 'a'*(245760 - 608)}
        self.assertEqual(len(self.api.encode_v1(payload)), 245760)
        self.failure('V1_RESULT_UNREPRESENTABLE', self.api.encode_v1,
                     {'x': payload['x'] + '😀'}, status=503, state='answered')

    def test_encoder_rejects_non_json_coercions_and_surrogates(self):
        for value in ({'x': float('nan')}, {'x': float('inf')}, {'x': object()},
                      {'x': ('tuple',)}, {1: 'int-key'}, {'x': '\ud800'}, {'\udfff': 1}, []):
            with self.subTest(value=value):
                self.failure('INVALID_NATIVE_RESULT', self.api.encode_v1, value, status=502)


if __name__ == '__main__':
    unittest.main()
