"""SYNTHETIC ASGI query/release, real native Core for integration cases, no I/O."""
import asyncio
from contextlib import AsyncExitStack, contextmanager
import copy
from dataclasses import replace
from datetime import datetime, timedelta
import io
import inspect
import json
import logging
import threading
import unittest
from unittest.mock import patch
from uuid import UUID

import httpx
import test_runtime as native
from kag.http_api.app import ApiSettings, create_app
from kag.http_api import artifacts, contract, runtime, security
from kag.legal_solver import AnswerResult, Citation
OPERATIONAL_PROOF = runtime._require_operational_proof


class RetrieveAdmissionTests(unittest.IsolatedAsyncioTestCase):
    """Real admission callable only; no test or production retrieve route."""
    def setUp(self):
        self.app = create_app(ApiSettings(native.SECRETS))
        self.received = 0

    async def admit(self, *, body=None, raw=None, headers=None, chunks=None,
                    scope='inspect', dto=contract.RetrieveRequest, receive=None):
        from starlette.requests import Request
        if raw is None:
            raw = json.dumps({'message': native.QUESTION, 'schema_contract': native.IDENTITY}
                             if body is None else body).encode()
        header_pairs = [('authorization', 'Bearer ' + 'i' * 43), ('content-type', 'application/json')]
        if headers is not None:
            header_pairs = headers
        parts = list(chunks if chunks is not None else [raw])
        async def next_chunk():
            self.received += 1
            value = parts.pop(0)
            return {'type': 'http.request', 'body': value, 'more_body': bool(parts)}
        request = Request({'type': 'http', 'method': 'POST', 'path': '/p1-admission-boundary',
            'headers': [(k.lower().encode(), v.encode()) for k, v in header_pairs],
            'app': self.app}, receive or next_chunk)
        self.request = request
        return await security.admit_request(request, scope, dto)

    async def failure(self, status, code, **arguments):
        with self.assertRaises(contract.ApiFailure) as caught:
            await self.admit(**arguments)
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    async def test_inspect_service_only_admission_without_delegated_uuid(self):
        with patch.object(security, 'authorize', wraps=security.authorize) as authorization:
            try:
                parsed = await self.admit()
            except contract.ApiFailure as exc:
                self.fail('Valid inspect service-only admission rejected: ' + exc.code)
        self.assertIs(type(parsed), contract.RetrieveRequest)
        self.assertEqual((parsed.message, parsed.top_k, parsed.expand), (native.QUESTION, 10, False))
        principal = self.request.state.service_principal
        self.assertEqual((principal.service_id, principal.scopes, principal.can_delegate_user),
                         ('inspect', frozenset({'inspect'}), False))
        self.assertFalse(hasattr(parsed, 'user_id'))
        self.assertFalse(hasattr(self.request.state, 'delegated_user_id'))
        self.assertTrue(authorization.call_args_list)
        self.assertTrue(all(c.args == (principal, 'inspect', None) for c in authorization.call_args_list))

    async def test_inspect_accepts_explicit_top_k_and_expand(self):
        for top_k in (1, 10):
            try:
                parsed = await self.admit(body={'message': ' q ', 'schema_contract': native.IDENTITY,
                                               'top_k': top_k, 'expand': True})
            except contract.ApiFailure as exc:
                self.fail('Valid explicit retrieve rejected: ' + exc.code)
            self.assertEqual((parsed.message, parsed.top_k, parsed.expand), (' q ', top_k, True))

    async def test_inspect_body_user_id_supplied_or_null_rejected(self):
        for user_id in (native.USER, None):
            await self.failure(422, 'INVALID_REQUEST', body={'message': 'q',
                'schema_contract': native.IDENTITY, 'user_id': user_id})

    async def test_inspect_unknown_body_fields_rejected(self):
        for field in ('context_id', 'service_id', 'model'):
            await self.failure(422, 'INVALID_REQUEST', body={'message': 'q',
                'schema_contract': native.IDENTITY, field: 'forged'})

    async def test_inspect_strict_top_k_and_expand(self):
        for key, value in (('top_k', True), ('top_k', 0), ('top_k', 11), ('top_k', '10'),
                           ('top_k', 1.0), ('expand', 1), ('expand', 'false'), ('expand', None)):
            await self.failure(422, 'INVALID_REQUEST', body={'message': 'q',
                'schema_contract': native.IDENTITY, key: value})

    async def test_inspect_forbidden_identity_headers_before_body(self):
        for field in ('X-User-Id', 'user_id', 'X-Service-Id'):
            self.received = 0
            await self.failure(422, 'INVALID_REQUEST', raw=b'{', headers=[
                ('authorization', 'Bearer ' + 'i' * 43), ('content-type', 'application/json'), (field, native.USER)])
            self.assertEqual(self.received, 0)

    async def test_authentication_first_401_before_scope_headers_media_or_body(self):
        for authorization in (None, 'Bearer invalid', 'Bearer eyJhbGciOiJIUzI1NiJ9.browser.jwt'):
            self.received = 0
            headers = [('content-type', 'text/plain'), ('x-user-id', native.USER), ('content-length', '65537')]
            if authorization is not None:
                headers.append(('authorization', authorization))
            await self.failure(401, 'AUTH_REQUIRED' if authorization is None else 'AUTH_INVALID',
                               raw=b'{', headers=headers)
            self.assertEqual(self.received, 0)

    async def test_scope_first_403_before_forged_identity_media_or_body(self):
        for additions in ([], [('x-service-id', 'forged')], [('content-length', '65537')]):
            self.received = 0
            await self.failure(403, 'SCOPE_DENIED', raw=b'{', headers=[
                ('authorization', 'Bearer ' + 'q' * 43), ('content-type', 'text/plain'), *additions])
            self.assertEqual(self.received, 0)

    async def test_duplicate_bearer_is_401_before_body(self):
        await self.failure(401, 'AUTH_INVALID', headers=[('authorization', 'Bearer ' + 'i' * 43),
            ('authorization', 'Bearer ' + 'i' * 43), ('content-type', 'application/json')])
        self.assertEqual(self.received, 0)

    async def test_query_token_cannot_admit_retrieve_with_query_scope(self):
        await self.failure(403, 'SCOPE_DENIED', scope='query', headers=[
            ('authorization', 'Bearer ' + 'q' * 43), ('content-type', 'application/json')])
        self.assertEqual(self.received, 0)

    async def test_inspect_cannot_query_or_delegate_or_gain_admin_write(self):
        await self.failure(403, 'SCOPE_DENIED', scope='query', dto=contract.QueryV1Request)
        self.assertEqual(self.received, 0)
        principal = security.authenticate('Bearer ' + 'i' * 43, native.SECRETS)
        with self.assertRaises(contract.ApiFailure) as caught:
            security.authorize(principal, 'inspect', UUID(native.USER))
        self.assertEqual((caught.exception.status, caught.exception.code), (403, 'DELEGATION_DENIED'))
        for scope in ('query', 'write', 'admin-control'):
            with self.assertRaises(contract.ApiFailure) as denied:
                security.authorize(principal, scope, None)
            self.assertEqual(denied.exception.code, 'SCOPE_DENIED')

    async def test_query_canonical_uuid_delegation_unchanged(self):
        payload = {'user_id': native.USER, 'message': native.QUESTION, 'context_id': '',
                   'schema_contract': native.IDENTITY}
        parsed = await self.admit(body=payload, scope='query', dto=contract.QueryV1Request, headers=[
            ('authorization', 'Bearer ' + 'q' * 43), ('content-type', 'application/json')])
        self.assertEqual(parsed.user_id, native.USER)
        self.assertEqual(self.request.state.delegated_user_id, UUID(native.USER))
        self.assertTrue(self.request.state.service_principal.can_delegate_user)
        self.assertEqual(self.request.state.service_principal.scopes, frozenset({'query'}))
        for user_id in (None, 'not-uuid', native.USER.replace('-', '')):
            await self.failure(422, 'INVALID_REQUEST', body={**payload, 'user_id': user_id},
                scope='query', dto=contract.QueryV1Request, headers=[
                ('authorization', 'Bearer ' + 'q' * 43), ('content-type', 'application/json')])

    async def test_inspect_malformed_json_utf8_and_duplicate_keys(self):
        for raw in (b'{', b'\xff', b'\xef\xbb\xbf{}', b'{"message":"\\ud800"}',
                    b'{"message":"q","message":"q"}', b'{"top_k":NaN}', b'{"top_k":1e999}'):
            await self.failure(400, 'INVALID_JSON', raw=raw)

    async def test_inspect_media_and_encoding_gates(self):
        for additional in ([('content-type', 'text/plain')], [('content-type', 'application/json; charset=latin-1')],
                           [('content-type', 'application/json'), ('content-encoding', 'gzip')]):
            self.received = 0
            await self.failure(415, 'UNSUPPORTED_MEDIA_TYPE', headers=[
                ('authorization', 'Bearer ' + 'i' * 43), *additional])
            self.assertEqual(self.received, 0)

    async def test_inspect_64k_body_boundary_and_chunked_overflow(self):
        raw = json.dumps({'message': 'q', 'schema_contract': native.IDENTITY}).encode()
        padded = raw + b' ' * (65536 - len(raw))
        try:
            parsed = await self.admit(raw=padded, chunks=[padded[:32000], padded[32000:]])
        except contract.ApiFailure as exc:
            self.fail('Valid 64KiB service-only body rejected: ' + exc.code)
        self.assertEqual(parsed.message, 'q')
        await self.failure(413, 'REQUEST_TOO_LARGE', chunks=[padded, b' '])
        await self.failure(413, 'REQUEST_TOO_LARGE', headers=[('authorization', 'Bearer ' + 'i' * 43),
            ('content-type', 'application/json'), ('content-length', '65537')])

    async def test_inspect_length_and_upload_deadline_guards(self):
        await self.failure(422, 'INVALID_REQUEST', headers=[('authorization', 'Bearer ' + 'i' * 43),
            ('content-type', 'application/json'), ('content-length', '1')])
        original = asyncio.wait_for
        deadlines = []
        async def fast_clock(operation, timeout):
            deadlines.append(timeout)
            return await original(operation, timeout=.01)
        async def stalled():
            await asyncio.Future()
        with patch.object(security.asyncio, 'wait_for', fast_clock):
            await self.failure(504, 'QUERY_TIMEOUT', receive=stalled)
        self.assertEqual(deadlines, [5])

    async def test_retrieve_route_remains_unmounted(self):
        self.assertNotIn('/v1/retrieve', {route.path for route in self.app.routes})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://asgi.invalid') as client:
            self.assertEqual((await client.post('/v1/retrieve')).status_code, 404)


class AppTests(unittest.IsolatedAsyncioTestCase):
    enable_sample_routes = False
    async def asyncSetUp(self):
        self.fixture = native.RuntimeTests()
        await self.fixture.asyncSetUp()
        self.reader, self.release = self.fixture.reader, self.fixture.release
        self.stack = AsyncExitStack()
        self.stack.enter_context(self.fixture.synthetic())
        self.made = []
        def factory(*args):
            value = runtime.make_runtime(*args)
            self.made.append(value)
            return value
        self.app = create_app(ApiSettings(native.SECRETS),runtime_factory=factory,
                              enable_sample_routes=self.enable_sample_routes)
        # Only tests install synthetic authorities; normal app has none.
        self.app.state.serving_release = self.release
        self.app.state.runtime_settings = self.fixture.settings()
        await self.stack.enter_async_context(self.app.router.lifespan_context(self.app))
        self.client = await self.stack.enter_async_context(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),base_url='http://asgi.invalid'))
        self.supervisor = self.app.state.runtime_supervisor

    async def asyncTearDown(self):
        await self.stack.aclose()
        await self.fixture.asyncTearDown()

    def headers(self, **changes):
        return {'Authorization':'Bearer '+'q'*43,'Content-Type':'application/json',
            'X-KAG-Release-ID':'synthetic-release','X-WebApp-Snapshot-ID':'synthetic-webapp',
            'X-KAG-As-Of':native.AS_OF.isoformat(),**changes}

    def body(self, **changes):
        return {'user_id':native.USER,'message':native.QUESTION,'context_id':'',
            'schema_contract':native.IDENTITY,**changes}

    async def post(self, *, body=None, headers=None, raw=None, path='/v1/query'):
        return await self.client.post(path,headers=self.headers() if headers is None else headers,
            content=json.dumps(self.body() if body is None else body).encode() if raw is None else raw)

    def error(self, response, status, code, state=None):
        self.assertEqual(response.status_code,status,response.text)
        body = response.json()
        self.assertEqual(set(body),{'request_id','error','native_state'})
        self.assertEqual(set(body['error']),{'code','message','retryable'})
        self.assertEqual(body['error']['code'],code)
        self.assertEqual(body['native_state'],state)
        self.assertEqual(str(UUID(body['request_id'])),body['request_id'])
        self.assertEqual(response.headers['x-request-id'],body['request_id'])
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertLessEqual(len(response.content),4096)
        self.assertNotIn('citations',body)
        self.assertNotIn('answer',body)

    def citation(self, kind='LegalUnit', field='text', identity='unit-1'):
        record = next(r for r in self.app.state.serving_release.records
            if r.entity_type=='VietRoadTraffic.'+kind and r.entity_id==identity and r.field==field)
        return Citation(record.doc_id,record.unit_id,record.sign_id,record.evidence_id,
                        record.field,0,len(record.source_text),record.source_text)

    @contextmanager
    def result(self, value):
        """Typed edge fixtures at the native-return boundary, never production code."""
        async def call(*args):
            return value
        with patch.object(runtime,'run_query',call):
            yield

    @contextmanager
    def after_core(self, mutate):
        original = runtime.run_query
        async def call(*args):
            value = await original(*args)
            mutate()
            return value
        with patch.object(runtime,'run_query',call):
            yield

    def reload(self):
        self.reader.seal()
        self.release = artifacts.load_release(self.fixture.root,'synthetic-release')
        self.app.state.serving_release = self.release

    def units(self, text, count=1):
        row = self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']
        record = next(r for r in self.reader.catalog['records'] if r['entity_type'].endswith('.LegalUnit'))
        row['properties']['text'] = text
        record.update(source_text=text,source_sha256=native.sha(text.encode()))
        record['metadata']['text'] = text
        self.reader.publication['units'][0]['text_sha256'] = native.sha(text.encode())
        for number in range(2,count+1):
            identity = 'unit-'+str(number)
            node = copy.deepcopy(row)
            node['properties'].update(id=identity,name=identity)
            self.reader.nodes['VietRoadTraffic.LegalUnit',identity] = node
            item = copy.deepcopy(record)
            item.update(entity_id=identity,unit_id=identity,graph_context=[])
            item['metadata'].update(id=identity,name=identity)
            self.reader.catalog['records'].append(item)
            self.reader.publication['units'].append({'doc_id':'document-1','unit_id':identity,
                'text_sha256':native.sha(text.encode()),'published':True,'version':'synthetic-v1'})
        self.reload()
        return tuple(self.citation(identity='unit-'+str(i)) for i in range(1,count+1))

    async def test_real_native_answer_exact_v1_and_identity_echoes(self):
        response = await self.post()
        self.assertEqual(response.status_code,200,response.text)
        citation = self.citation()
        self.assertEqual(response.json(),{'answer':'Căn cứ nguồn đã xác nhận:\n'+native.TEXT,
            'citations':[{'doc_id':'document-1','unit_id':'unit-1','sign_id':None,
                'evidence_id':citation.evidence_id,'field':'text','start':0,'end':len(native.TEXT),'quote':native.TEXT}]})
        self.assertEqual(response.headers['x-kag-release-id'],'synthetic-release')
        self.assertEqual(response.headers['x-webapp-snapshot-id'],'synthetic-webapp')
        self.assertEqual(response.headers['x-kag-as-of'],'2026-10-08')
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertTrue(self.reader.closed and self.made[0].closed)
        self.assertFalse(self.supervisor.busy)

    async def test_real_native_abstention_never_becomes_success(self):
        with self.fixture.synthetic(abstain=True):
            response = await self.post()
        self.error(response,503,'KAG_ABSTAINED','abstained')
        self.assertTrue(self.reader.closed)

    async def test_missing_bearer_before_factory(self):
        headers = self.headers(); headers.pop('Authorization')
        self.error(await self.post(headers=headers),401,'AUTH_REQUIRED')
        self.assertEqual(self.made,[])

    async def test_invalid_bearer_before_factory(self):
        for token in ('Basic x','Bearer invalid','Bearer '+('q'*43)+' extra'):
            with self.subTest(token=token):
                self.error(await self.post(headers=self.headers(Authorization=token)),401,'AUTH_INVALID')
        self.assertEqual(self.made,[])

    async def test_wrong_scope_before_factory(self):
        self.error(await self.post(headers=self.headers(Authorization='Bearer '+'i'*43)),403,'SCOPE_DENIED')
        self.assertEqual(self.made,[])

    async def test_delegation_denied_before_factory(self):
        principal = security.ServicePrincipal('query-no-delegation',frozenset({'query'}),False)
        with patch.object(security,'authenticate',return_value=principal):
            self.error(await self.post(),403,'DELEGATION_DENIED')
        self.assertEqual(self.made,[])

    async def test_forged_identity_header_rejected(self):
        self.error(await self.post(headers=self.headers(**{'X-User-ID':native.USER})),422,'INVALID_REQUEST')
        self.assertEqual(self.made,[])

    async def test_json_duplicate_nonfinite_bom_surrogate_utf8_rejected(self):
        for raw in (b'{"user_id":1,"user_id":2}',b'{"x":NaN}',b'{"x":Infinity}',
                    b'\xef\xbb\xbf{}',b'{"x":"\\ud800"}',b'\xff',b'not-json'):
            with self.subTest(raw=raw):
                self.error(await self.post(raw=raw),400,'INVALID_JSON')
        self.assertEqual(self.made,[])

    async def test_unknown_uuid_and_type_fields_rejected(self):
        for body in (self.body(write=True),self.body(user_id='not-uuid'),self.body(message=1),
                     self.body(context_id=None),self.body(as_of='2020-01-01')):
            with self.subTest(body=body):
                self.error(await self.post(body=body),422,'INVALID_REQUEST')
        self.assertEqual(self.made,[])

    async def test_context_rejected_without_core_session_fallback(self):
        self.error(await self.post(body=self.body(context_id='session')),422,'CONTEXT_NOT_SUPPORTED')
        self.assertEqual(self.made,[])

    async def test_unsupported_media_and_encoding(self):
        for changes in ({'Content-Type':'text/plain'},{'Content-Type':'application/json; charset=utf-16'},
                        {'Content-Encoding':'gzip'}):
            with self.subTest(changes=changes):
                self.error(await self.post(headers=self.headers(**changes)),415,'UNSUPPORTED_MEDIA_TYPE')
        self.assertEqual(self.made,[])

    async def test_oversized_streamed_body_before_factory(self):
        async def chunks():
            yield b' '*65536
            yield b' '
        self.error(await self.post(raw=chunks()),413,'REQUEST_TOO_LARGE')
        self.assertEqual(self.made,[])

    async def test_strict_dto_single_path(self):
        original = contract.QueryV1Request.from_json
        with patch.object(contract.QueryV1Request,'from_json',wraps=original) as parser:
            response = await self.post(raw=b'{"user_id":1,"user_id":2}')
        self.error(response,400,'INVALID_JSON')
        self.assertEqual(parser.call_count,1)
        self.assertEqual(self.made,[])

    async def test_schema_mismatch_before_factory(self):
        self.error(await self.post(body=self.body(schema_contract={**native.IDENTITY,'schema_sha256':'f'*64})),
                   409,'SCHEMA_CONTRACT_MISMATCH')
        self.assertEqual(self.made,[])

    async def test_release_snapshot_date_headers_before_factory(self):
        for key,value,code in (('X-KAG-Release-ID','foreign','RELEASE_MISMATCH'),
            ('X-WebApp-Snapshot-ID','foreign','SOURCE_SNAPSHOT_MISMATCH'),
            ('X-KAG-As-Of','2000-01-01','DATE_MISMATCH')):
            with self.subTest(key=key):
                self.error(await self.post(headers=self.headers(**{key:value})),409,code)
        self.assertEqual(self.made,[])

    async def test_missing_release_unavailable(self):
        self.app.state.serving_release = None
        self.error(await self.post(),503,'RELEASE_UNAVAILABLE')
        self.assertEqual(self.made,[])

    async def test_missing_publication_unavailable(self):
        self.app.state.serving_release = replace(self.release,publication=None)
        self.error(await self.post(),503,'NOT_READY')
        self.assertEqual(self.made,[])

    async def test_default_operational_proof_still_denies_synthetic(self):
        with patch.object(runtime,'_require_operational_proof',OPERATIONAL_PROOF):
            self.error(await self.post(),503,'NOT_READY')
        self.assertEqual(self.made,[])

    async def test_normal_app_without_injection_cannot_serve(self):
        app = create_app(ApiSettings(native.SECRETS))
        async with app.router.lifespan_context(app),httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),base_url='http://asgi.invalid') as client:
            response = await client.post('/v1/query',headers=self.headers(),content=json.dumps(self.body()).encode())
        self.error(response,503,'RELEASE_UNAVAILABLE')

    async def test_sign_native_support_cannot_become_unit(self):
        value = AnswerResult('Nguồn biển báo.',(self.citation('TrafficSign','moTa','sign-1'),),False)
        before = value.to_dict()
        with self.result(value):
            self.error(await self.post(),503,'V1_RESULT_UNREPRESENTABLE','answered')
        self.assertEqual(value.to_dict(),before)

    async def test_document_native_support_unrepresentable(self):
        value = AnswerResult('Nguồn văn bản.',(self.citation('LegalDocument','title','document-1'),),False)
        with self.result(value):
            self.error(await self.post(),503,'V1_RESULT_UNREPRESENTABLE','answered')

    async def test_mixed_metadata_all_support_preserved_and_refused(self):
        value = AnswerResult('Nguồn gồm metadata.',(self.citation(),
            self.citation('LegalDocument','effective_from','document-1')),False)
        before = value.to_dict()
        with self.result(value):
            self.error(await self.post(),503,'V1_RESULT_UNREPRESENTABLE','answered')
        self.assertEqual(value.to_dict(),before)

    async def test_invalid_citation_source_ids_quote_and_spans(self):
        original = self.citation()
        for changes in ({'unit_id':'foreign'},{'doc_id':'foreign'},{'evidence_id':'a'*64},
                        {'quote':'forged'},{'start':True},{'start':1},{'end':original.end-1}):
            with self.subTest(changes=changes),self.result(AnswerResult('Nguồn.',(replace(original,**changes),),False)):
                self.reader.closed = False
                self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_invalid_native_shape_no_guessed_state(self):
        with self.result({'answer':'fake','citations':[]}):
            self.error(await self.post(),502,'INVALID_NATIVE_RESULT')

    async def test_changed_source_after_actual_core_fails_final_proof(self):
        with self.after_core(lambda:self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']['properties'].update(text='changed')):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')
        self.assertTrue(self.reader.closed)

    async def test_changed_graph_relation_after_core_fails(self):
        with self.after_core(lambda:self.reader.edges.clear()):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_changed_backend_after_core_fails(self):
        with self.after_core(lambda:self.reader.metadata.update(databaseID='foreign')):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_changed_index_after_core_fails(self):
        with self.after_core(lambda:self.reader.vector_indexes[0].update(state='POPULATING')):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_source_catalog_tamper_after_core_fails(self):
        with self.after_core(lambda:(self.fixture.root/'source-catalog.json').write_bytes(b'{}')):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_release_artifact_changed_after_core_conflict(self):
        with self.after_core(lambda:(self.fixture.root/'release.json').write_bytes(b'{}')):
            self.error(await self.post(),409,'RELEASE_MISMATCH')

    async def test_selected_schema_changed_after_core_conflict(self):
        changed = replace(self.release,schema_contract=contract.SchemaIdentity('VietRoadTraffic','f'*64,'b'*64))
        with self.after_core(lambda:setattr(self.app.state,'serving_release',changed)):
            self.error(await self.post(),409,'SCHEMA_CONTRACT_MISMATCH')

    async def test_selected_snapshot_changed_after_core_conflict(self):
        descriptor = dict(self.release.descriptor,source_snapshot_id='foreign')
        changed = replace(self.release,descriptor=descriptor)
        with self.after_core(lambda:setattr(self.app.state,'serving_release',changed)):
            self.error(await self.post(),409,'SOURCE_SNAPSHOT_MISMATCH')

    async def test_publication_tamper_after_core_fails(self):
        with self.after_core(lambda:(self.fixture.root/'webapp-publication.json').write_bytes(b'{}')):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_unpublished_or_replaced_authority_unrepresentable(self):
        self.reader.publication['documents'][0]['replaces_eligible'] = False
        self.reload()
        self.error(await self.post(),503,'V1_RESULT_UNREPRESENTABLE','answered')

    async def test_effectivity_rejected_before_projection(self):
        # Legitimate immutable fixture at current date; typed result cites expired source.
        self.reader.nodes['VietRoadTraffic.LegalDocument','document-1']['properties']['effectiveTo'] = '2020-12-31'
        for record in self.reader.catalog['records']:
            if record['entity_type'].endswith('.LegalDocument'):
                record['metadata']['effective_to'] = '2020-12-31'
        self.reader.publication['documents'][0]['effective_to'] = '2020-12-31'
        self.reload()
        with self.result(AnswerResult('Nguồn.',(self.citation(),),False)):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_midnight_after_core_aborts_without_success(self):
        with self.after_core(lambda:self.stack.enter_context(patch.object(runtime,'_today',lambda:native.AS_OF+timedelta(days=1)))):
            self.error(await self.post(),409,'DATE_BOUNDARY_CHANGED')

    async def test_midnight_during_serialization_aborts(self):
        original = contract.encode_v1
        def encode(value):
            result = original(value)
            self.stack.enter_context(patch.object(runtime,'_today',lambda:native.AS_OF+timedelta(days=1)))
            return result
        with patch.object(contract,'encode_v1',encode):
            self.error(await self.post(),409,'DATE_BOUNDARY_CHANGED')

    async def test_answer_utf16_exact_limit_and_overflow(self):
        for count,status in ((10000,200),(10001,503)):
            value = AnswerResult('😀'*count,(self.citation(),),False)
            with self.subTest(count=count),self.result(value):
                self.reader.closed = False
                response = await self.post()
                if status == 200:
                    self.assertEqual(response.status_code,200,response.text)
                    self.assertEqual(response.json()['answer'],value.answer)
                else:
                    self.error(response,503,'V1_RESULT_UNREPRESENTABLE','answered')

    async def test_quote_utf16_limit_refuses_whole_result(self):
        citations = self.units('😀'*10001)
        with self.result(AnswerResult('Nguồn.',citations,False)):
            self.error(await self.post(),503,'V1_RESULT_UNREPRESENTABLE','answered')

    async def test_citation_count_limit_refuses_whole_result(self):
        citations = self.units(native.TEXT,21)
        with self.result(AnswerResult('Nguồn.',citations,False)):
            self.error(await self.post(),503,'V1_RESULT_UNREPRESENTABLE','answered')

    async def test_wire_byte_limit_502_without_truncation(self):
        citations = self.units('法'*20000,8)
        value = AnswerResult('Nguồn.',citations,False)
        before = value.to_dict()
        with self.result(value):
            self.error(await self.post(),502,'RESULT_LIMIT_EXCEEDED')
        self.assertEqual(value.to_dict(),before)

    async def test_native_answer_and_as_of_forwarded_unchanged(self):
        seen = []
        original = runtime.run_query
        async def call(instance,question,as_of):
            seen.append((question,as_of))
            return await original(instance,question,as_of)
        message = ' '+native.QUESTION+' '
        with patch.object(runtime,'run_query',call):
            response = await self.post(body=self.body(message=message))
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(seen,[(message,native.AS_OF)])

    async def test_provider_error_sanitized(self):
        async def call(*args):
            raise runtime.RuntimeFailure('PROVIDER_ERROR')
        with patch.object(runtime,'run_query',call):
            self.error(await self.post(),502,'PROVIDER_ERROR')

    async def test_unexpected_exception_no_secret_or_trace_in_output_logs(self):
        secret = 'synthetic-secret-do-not-log'
        async def call(*args):
            raise RuntimeError(secret)
        stream = io.StringIO(); handler = logging.StreamHandler(stream)
        logging.getLogger().addHandler(handler)
        try:
            with patch.object(runtime,'run_query',call):
                response = await self.post()
        finally:
            logging.getLogger().removeHandler(handler)
        self.error(response,500,'INTERNAL_ERROR')
        self.assertNotIn(secret,response.text+stream.getvalue())
        self.assertNotIn('Traceback',response.text+stream.getvalue())

    async def test_missing_backend_after_core_unavailable(self):
        def mutate():
            self.stack.enter_context(patch.object(self.reader,'database_metadata',side_effect=RuntimeError('synthetic-secret')))
        with self.after_core(mutate):
            self.error(await self.post(),503,'BACKEND_UNAVAILABLE')

    @contextmanager
    def blocked_core(self, entered, finish):
        original = runtime._new_llm
        def model(*args):
            base = type(original(*args))
            class BlockingLLM(base):
                def __call__(self,*arguments,**kwargs):
                    if not entered.is_set():
                        entered.set()
                        if not finish.wait(5):
                            raise AssertionError('Test must release synthetic SDK worker')
                    return super().__call__(*arguments,**kwargs)
            return BlockingLLM()
        with patch.object(runtime,'_new_llm',model):
            yield

    async def test_http_timeout_contention_and_long_worker_drain(self):
        entered,finish = threading.Event(),threading.Event()
        with self.blocked_core(entered,finish),patch.object(runtime,'REQUEST_SECONDS',1):
            task = asyncio.create_task(self.post())
            try:
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(.001)
                self.assertTrue(entered.is_set())
                self.error(await task,504,'QUERY_TIMEOUT')
                self.assertTrue(self.supervisor.busy and self.supervisor.draining)
                self.assertFalse(self.reader.closed)
                response = await self.post()
                self.error(response,429,'CONCURRENCY_LIMIT')
                self.assertEqual(response.headers['retry-after'],'1')
                self.assertEqual((await self.client.get('/v1/health')).status_code,200)
            finally:
                finish.set()
                await self.supervisor.close()
        self.assertTrue(self.reader.closed)
        self.assertFalse(self.supervisor.busy)

    async def test_http_handler_cancel_keeps_owned_worker_until_drain(self):
        entered,finish = threading.Event(),threading.Event()
        with self.blocked_core(entered,finish):
            task = asyncio.create_task(self.post())
            try:
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(.001)
                self.assertTrue(entered.is_set())
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(self.supervisor.busy and self.supervisor.draining)
                self.assertFalse(self.reader.closed)
            finally:
                finish.set()
                await self.supervisor.close()
        self.assertTrue(self.reader.closed)
        self.assertFalse(self.supervisor.busy)

    async def test_timeout_during_final_readback_holds_reader_and_no_success(self):
        entered,finish = threading.Event(),threading.Event()
        done_core = threading.Event()
        original = self.reader.read_nodes
        def read(keys):
            if done_core.is_set():
                entered.set()
                if not finish.wait(5):
                    raise AssertionError('Test must release final proof')
            return original(keys)
        with self.after_core(done_core.set),patch.object(self.reader,'read_nodes',read),patch.object(runtime,'REQUEST_SECONDS',1):
            task = asyncio.create_task(self.post())
            try:
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(.001)
                self.assertTrue(entered.is_set())
                self.error(await task,504,'QUERY_TIMEOUT')
                self.assertTrue(self.supervisor.busy)
                self.assertFalse(self.reader.closed)
            finally:
                finish.set()
                await self.supervisor.close()
        self.assertTrue(self.reader.closed)

    async def test_readiness_stays_unavailable_after_positive_query(self):
        self.assertEqual((await self.post()).status_code,200)
        response = await self.client.get('/v1/health?mode=ready&capability=query-v1',headers=self.headers())
        self.assertEqual(response.status_code,503)
        self.assertEqual(response.json()['checks']['runtime'],'blocked')
        self.assertEqual(response.json()['provider_transport'],'not_probed')

    async def test_graph_release_artifact_view_no_live_claims(self):
        response = await self.client.get('/v1/graph/release',headers=self.headers())
        self.assertEqual(response.status_code,200,response.text)
        value = response.json()
        self.assertEqual(value['release_id'],'synthetic-release')
        self.assertEqual(value['release_kind'],'SAMPLE')
        self.assertFalse(value['backend_identity_verified'] or value['source_identity_verified'] or value['query_ready'])
        self.assertIsNone(value['verified_at'])
        self.assertEqual(self.made,[])
        self.assertEqual(self.fixture.events,[])

    async def test_graph_release_missing_or_tampered_unavailable(self):
        self.app.state.serving_release = None
        self.error(await self.client.get('/v1/graph/release',headers=self.headers()),503,'RELEASE_UNAVAILABLE')
        self.app.state.serving_release = self.release
        (self.fixture.root/'release.json').write_bytes(b'{}')
        self.error(await self.client.get('/v1/graph/release',headers=self.headers()),503,'RELEASE_UNAVAILABLE')

    async def test_graph_release_auth_and_query_selector_rejection(self):
        self.error(await self.client.get('/v1/graph/release'),401,'AUTH_REQUIRED')
        self.error(await self.client.get('/v1/graph/release?run_id=foreign',headers=self.headers()),422,'INVALID_REQUEST')
        response = await self.client.get('/v1/graph/release',headers=self.headers(Authorization='Bearer '+'i'*43))
        self.assertEqual(response.status_code,200)

    async def test_only_step5_approved_public_routes_and_methods(self):
        paths = self.app.openapi()['paths']
        self.assertEqual(set(paths),{'/v1/health','/v1/graph/release','/v1/query',
                                    '/v1/pipeline/status','/v1/benchmark/datasets',
                                    '/v1/config','/v1/config/retrieval','/v1/config/models',
                                    '/v1/config/models/{role}/{action}',
                                    '/v1/config/retrieval/{action}',
                                    '/v1/serving','/v1/serving/{action}', '/v1/serving/trial/{project_id}/{run_id}'})
        self.assertEqual(set(paths['/v1/query']),{'post'})
        for path in ('/v1/pipeline/status','/v1/benchmark/datasets'):
            self.assertEqual(set(paths[path]),{'get'})
            self.assertEqual((await self.client.post(path)).status_code,405)
        for path, methods in {
                '/v1/config': {'get'}, '/v1/config/retrieval': {'get'},
                '/v1/config/models': {'get','post'},
                '/v1/config/models/{role}/{action}': {'post'},
                '/v1/config/retrieval/{action}': {'post'},
                '/v1/serving': {'get'}, '/v1/serving/{action}': {'post'}, '/v1/serving/trial/{project_id}/{run_id}': {'post'}}.items():
            self.assertEqual(set(paths[path]),methods)
        protected = [('get',path) for path in (
            '/v1/config','/v1/config/retrieval','/v1/config/models','/v1/serving')]
        protected += [('post','/v1/config/models')]
        protected += [('post',f'/v1/config/models/{role}/{action}')
                      for role in ('chat','embedding') for action in ('test','apply')]
        protected += [('post','/v1/config/retrieval/'+action) for action in ('save','apply','restore')]
        protected += [('post','/v1/serving/'+action) for action in ('preview','activate')]
        protected += [('post','/v1/serving/trial/17/run-B')]
        for method, path in protected:
            with self.subTest(method=method,path=path):
                self.error(await self.client.request(method,path),401,'AUTH_REQUIRED')
                self.error(await self.client.request(method,path,headers=self.headers()),403,'SCOPE_DENIED')
                self.assertEqual((await self.client.put(path)).status_code,405)
        self.assertEqual(self.made,[])
        self.assertEqual(self.fixture.events,[])
        for path in ('/v1/query/stream','/v1/retrieve','/v1/jobs','/v1/benchmarks','/v2/query','/write','/docs','/openapi.json'):
            self.assertEqual((await self.client.post(path)).status_code,404)

    async def test_query_unknown_url_options_rejected_before_factory(self):
        self.error(await self.post(path='/v1/query?model=foreign'),422,'INVALID_REQUEST')
        self.assertEqual(self.made,[])

    async def test_server_generated_request_id_cannot_be_forged(self):
        response = await self.post(headers=self.headers(**{'X-Request-ID':'forged'}))
        self.assertEqual(response.status_code,200,response.text)
        self.assertNotEqual(response.headers['x-request-id'],'forged')
        self.assertEqual(str(UUID(response.headers['x-request-id'])),response.headers['x-request-id'])

    async def test_disconnect_probe_swallowed_cancellation_cannot_hold_response(self):
        swallowed = asyncio.Event()
        async def probe(request):
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                if swallowed.is_set():
                    raise
                swallowed.set()
            return False
        with patch('starlette.requests.Request.is_disconnected',probe):
            task = asyncio.create_task(self.post())
            done,_ = await asyncio.wait({task},timeout=3)
            if not done:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
            self.assertTrue(done,'Disconnect probe swallowed cancellation and held response')
            self.assertEqual(task.result().status_code,200)
            self.assertTrue(swallowed.is_set())

    async def test_unconfigured_secret_policy_remains_liveness_only(self):
        app = create_app(ApiSettings())
        self.assertEqual({route.path for route in app.routes},{'/v1/health'})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://asgi.invalid') as client:
            self.assertEqual((await client.post('/v1/query')).status_code,404)
            self.assertEqual((await client.get('/v1/graph/release')).status_code,404)

    async def raw_asgi(self, send=None, disconnect=None, path='/v1/query'):
        body = json.dumps(self.body()).encode()
        headers = {**self.headers(),'Content-Length':str(len(body))}
        scope = {'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','scheme':'http',
            'method':'POST','path':path,'raw_path':path.encode(),'query_string':b'',
            'root_path':'','headers':[(k.lower().encode(),v.encode()) for k,v in headers.items()],
            'server':('asgi.invalid',80),'client':('127.0.0.1',1234)}
        received = False
        messages = []
        async def receive():
            nonlocal received
            if not received:
                received = True
                return {'type':'http.request','body':body,'more_body':False}
            if disconnect is None:
                await asyncio.Future()
            else:
                await disconnect.wait()
            return {'type':'http.disconnect'}
        async def capture(message):
            if send is not None:
                await send(message)
            messages.append(dict(message))
        await self.app(scope,receive,capture)
        return messages

    async def test_midnight_in_preflight_denies_factory_and_public_inference(self):
        original = runtime._readback
        def readback(*args):
            value = original(*args)
            self.stack.enter_context(patch.object(runtime,'_today',lambda:native.AS_OF+timedelta(days=1)))
            return value
        with patch.object(runtime,'_readback',readback),patch.object(runtime,'run_query',wraps=runtime.run_query) as core:
            self.error(await self.post(),409,'DATE_BOUNDARY_CHANGED')
        self.assertEqual(self.made,[])
        self.assertEqual(core.call_count,0)
        self.assertNotIn('embedding.constructor',self.fixture.events)
        self.assertNotIn('llm.constructor',self.fixture.events)

    async def test_midnight_inside_factory_denies_public_inference(self):
        original = self.app.state.runtime_factory
        def factory(*args):
            value = original(*args)
            self.stack.enter_context(patch.object(runtime,'_today',lambda:native.AS_OF+timedelta(days=1)))
            return value
        self.app.state.runtime_factory = factory
        with patch.object(runtime,'run_query',wraps=runtime.run_query) as core:
            self.error(await self.post(),409,'DATE_BOUNDARY_CHANGED')
        self.assertEqual(core.call_count,0)
        self.assertTrue(self.reader.closed)

    async def test_reader_source_backend_index_relations_changed_by_encoder_rejected(self):
        original = contract.encode_v1
        states = copy.deepcopy((self.reader.nodes,self.reader.metadata,self.reader.vector_indexes,self.reader.edges))
        for mutation in (lambda:self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']['properties'].update(text='changed'),
            lambda:self.reader.metadata.update(databaseID='foreign'),
            lambda:self.reader.vector_indexes[0].update(state='POPULATING'),lambda:self.reader.edges.clear()):
            def encode(payload):
                raw = original(payload)
                mutation()
                return raw
            with self.subTest(mutation=mutation.__code__.co_firstlineno),patch.object(contract,'encode_v1',encode):
                self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')
            self.reader.nodes,self.reader.metadata,self.reader.vector_indexes,self.reader.edges = copy.deepcopy(states)
            self.reader.closed = False

    async def test_selected_release_changed_during_cleanup_rejected(self):
        original = runtime.RequestRuntime.close
        async def close(instance):
            self.app.state.serving_release = replace(self.release,release_id='foreign')
            await asyncio.sleep(.01)
            await original(instance)
        with patch.object(runtime.RequestRuntime,'close',close):
            self.error(await self.post(),409,'RELEASE_MISMATCH')
        self.assertTrue(self.reader.closed)

    async def test_publication_changed_during_cleanup_rejected(self):
        original = runtime.RequestRuntime.close
        async def close(instance):
            (self.fixture.root/'webapp-publication.json').write_bytes(b'{}')
            await asyncio.sleep(.01)
            await original(instance)
        with patch.object(runtime.RequestRuntime,'close',close):
            self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')
        self.assertTrue(self.reader.closed)

    async def test_pending_body_send_crosses_midnight_never_completes_success(self):
        async def send(message):
            if message['type'] == 'http.response.body':
                self.stack.enter_context(patch.object(runtime,'_today',lambda:native.AS_OF+timedelta(days=1)))
                await asyncio.sleep(.2)
        messages = await self.raw_asgi(send)
        self.assertEqual(messages[0]['status'],200)
        self.assertFalse(any(m['type']=='http.response.body' for m in messages))

    async def test_authority_changes_after_headers_prevent_complete_body(self):
        async def send(message):
            if message['type'] == 'http.response.start':
                (self.fixture.root/'webapp-publication.json').write_bytes(b'{}')
        messages = await self.raw_asgi(send)
        self.assertEqual(messages[0]['status'],200)
        self.assertFalse(any(m['type']=='http.response.body' for m in messages))

    async def test_pending_body_send_publication_change_never_completes(self):
        async def send(message):
            if message['type'] == 'http.response.body':
                (self.fixture.root/'webapp-publication.json').write_bytes(b'{}')
                await asyncio.sleep(.2)
        messages = await self.raw_asgi(send)
        self.assertEqual(messages[0]['status'],200)
        self.assertFalse(any(m['type']=='http.response.body' for m in messages))

    async def test_actual_asgi_disconnect_holds_worker_clients_and_slot(self):
        entered,finish = threading.Event(),threading.Event()
        disconnect = asyncio.Event()
        with self.blocked_core(entered,finish):
            task = asyncio.create_task(self.raw_asgi(disconnect=disconnect))
            try:
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(.001)
                self.assertTrue(entered.is_set())
                disconnect.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task,1)
                self.assertTrue(self.supervisor.busy and self.supervisor.draining)
                self.assertFalse(self.reader.closed)
            finally:
                finish.set()
                await self.supervisor.close()
        self.assertTrue(self.reader.closed)

    async def test_http_cleanup_failure_blocks_later_admission(self):
        original = self.reader.close
        def close():
            original()
            raise RuntimeError('synthetic-private-cleanup-error')
        with patch.object(self.reader,'close',close):
            self.error(await self.post(),500,'INTERNAL_ERROR')
        self.assertTrue(self.supervisor.closed)
        self.error(await self.post(),503,'NOT_READY')

    async def test_pending_body_send_deadline_never_completes(self):
        async def send(message):
            if message['type'] == 'http.response.body':
                await asyncio.sleep(2)
        with patch.object(runtime,'REQUEST_SECONDS',1):
            messages = await self.raw_asgi(send)
        self.assertEqual(messages[0]['status'],200)
        self.assertFalse(any(m['type']=='http.response.body' for m in messages))

    async def test_post_start_send_exception_has_no_complete_or_error_body(self):
        async def send(message):
            if message['type'] == 'http.response.body':
                raise OSError('synthetic-private-send-error')
        messages = await self.raw_asgi(send)
        self.assertEqual(messages[0]['status'],200)
        self.assertFalse(any(m['type']=='http.response.body' for m in messages))


class RetrieveHTTPTests(unittest.IsolatedAsyncioTestCase):
    """P3 actual owned Retriever/ASGI, synthetic artifacts and transport only."""
    error = AppTests.error

    async def asyncSetUp(self):
        self.fixture = native.RetrieveRuntimeTests()
        await self.fixture.asyncSetUp()
        self.reader, self.release = self.fixture.reader, self.fixture.release
        self.stack = AsyncExitStack()
        self.stack.enter_context(self.fixture.retrieve_synthetic())
        self.made = []
        def factory(*args):
            result = runtime.make_runtime(*args)
            self.made.append(result)
            return result
        options = {'enable_sample_routes':True} if 'enable_sample_routes' in inspect.signature(create_app).parameters else {}
        self.app = create_app(ApiSettings(native.SECRETS),runtime_factory=factory,**options)
        self.app.state.serving_release = self.release
        self.app.state.runtime_settings = self.fixture.retrieve_settings()
        from kag.vector_contract import TARGETS
        def search(kind,prop,vector,k):
            self.assertEqual((len(vector),k),(3072,10))
            identity = {'LegalDocument':'document-1','LegalUnit':'unit-1','TrafficSign':'sign-1'}[kind]
            score = {'title':0.7,'text':0.9,'ten':0.8,'moTa':0.6}[prop]
            return [{'id':identity,'score':score,'index':'synthetic-'+dict(TARGETS[kind])[prop]}]
        self.stack.enter_context(patch.object(self.reader,'vector_search',search))
        self.stack.enter_context(patch.object(self.reader,'expand',return_value=[
            {k:v for k,v in self.reader.relation.items() if k!='properties'}]))
        await self.stack.enter_async_context(self.app.router.lifespan_context(self.app))
        self.client = await self.stack.enter_async_context(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),base_url='http://asgi.invalid'))
        self.supervisor = self.app.state.runtime_supervisor

    async def asyncTearDown(self):
        await self.stack.aclose()
        await self.fixture.asyncTearDown()

    def headers(self, **changes):
        return {'Authorization':'Bearer '+'i'*43,'Content-Type':'application/json',
                'X-KAG-Release-ID':'synthetic-release',**changes}

    def body(self, **changes):
        return {'message':native.QUESTION,'schema_contract':native.IDENTITY,**changes}

    async def post(self, *, body=None, headers=None, raw=None, path='/v1/retrieve'):
        return await self.client.post(path,headers=self.headers() if headers is None else headers,
            content=json.dumps(self.body() if body is None else body).encode() if raw is None else raw)

    def item(self, kind='LegalUnit', identity='unit-1'):
        from kag.vector_contract import TARGETS
        records = [r for r in self.app.state.serving_release.records
            if (r.entity_type,r.entity_id)==('VietRoadTraffic.'+kind,identity)]
        record = records[0]
        prop,field = TARGETS[kind][0]
        return {'entity_type':record.entity_type,'entity_id':identity,'doc_id':record.doc_id,
            'unit_id':record.unit_id,'sign_id':record.sign_id,
            'source_texts':{p:next(r.source_text for r in records if r.field==p) for p,_ in TARGETS[kind]},
            'score':0.9,'vector_sources':[{'property':prop,'score':0.9,'index':'synthetic-'+field}],
            'graph_context':[]}

    @contextmanager
    def result(self, items):
        async def retrieve(*args): return copy.deepcopy(items)
        with patch.object(runtime,'run_retrieve',retrieve): yield

    def units(self, text, count=1):
        row = self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']
        record = next(r for r in self.reader.catalog['records'] if r['field']=='text')
        row['properties']['text'] = text
        record.update(source_text=text,source_sha256=native.sha(text.encode()))
        record['metadata']['text'] = text
        for number in range(2,count+1):
            identity = 'unit-'+str(number)
            node,entry = copy.deepcopy(row),copy.deepcopy(record)
            node['properties'].update(id=identity,name=identity)
            entry.update(entity_id=identity,unit_id=identity,graph_context=[])
            entry['metadata'].update(id=identity,name=identity)
            self.reader.nodes['VietRoadTraffic.LegalUnit',identity] = node
            self.reader.catalog['records'].append(entry)
        self.reader.seal(publication=False)
        self.release = artifacts.load_release(self.fixture.root,'synthetic-release')
        self.app.state.serving_release = self.release

    async def test_trusted_switch_registers_step7_sample_routes(self):
        self.assertIn('enable_sample_routes',inspect.signature(create_app).parameters)
        self.assertIn('/v1/retrieve',{r.path for r in self.app.routes})
        self.assertIn('/v1/query/stream',{r.path for r in self.app.routes})
        for value in (None,0,1,'true',[],{}):
            with self.subTest(value=value),self.assertRaises(contract.ApiFailure) as caught:
                create_app(ApiSettings(native.SECRETS),enable_sample_routes=value)
            self.assertEqual(caught.exception.code,'NOT_READY')

    async def test_default_disabled_cannot_be_enabled_by_client_or_env(self):
        with patch.dict('os.environ',{'ENABLE_SAMPLE_ROUTES':'true','KAG_HTTP_ENABLE_SAMPLE_ROUTES':'true'}):
            app = create_app(ApiSettings(native.SECRETS))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://asgi.invalid') as client:
            for path in ('/v1/retrieve','/v1/query/stream','/v1/retrieve?enable_sample_routes=true'):
                response = await client.post(path,headers=self.headers(**{'Enable-Sample-Routes':'true'}),
                    json=self.body(enable_sample_routes=True))
                self.assertEqual(response.status_code,404)

    async def test_service_only_actual_native_fields_order_and_identity(self):
        response = await self.post(headers=self.headers(**{'X-Request-ID':'forged','X-KAG-As-Of':'not-a-date'}))
        self.assertEqual(response.status_code,200,response.text)
        value = response.json()
        self.assertEqual(set(value),{'contract_version','request_id','release_id','source_snapshot_id','schema_contract','items'})
        self.assertEqual(value['contract_version'],'h1-read-v1.1')
        self.assertEqual((value['release_id'],value['source_snapshot_id']),('synthetic-release','synthetic-source'))
        self.assertEqual(value['schema_contract'],native.IDENTITY)
        self.assertEqual(response.headers['x-request-id'],value['request_id'])
        self.assertEqual(str(UUID(value['request_id'])),value['request_id'])
        self.assertNotEqual(value['request_id'],'forged')
        self.assertEqual([(r['entity_id'],r['score']) for r in value['items']],
                         [('unit-1',0.9),('sign-1',0.8),('document-1',0.7)])
        self.assertEqual(set(value['items'][1]['source_texts']),{'ten','moTa'})
        self.assertEqual(value['items'][0]['source_texts'],{'text':native.TEXT})
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertTrue(self.reader.closed and self.made[0].closed)
        self.assertIsNone(self.made[0].pipeline)
        self.assertEqual(self.fixture.calls,[('embed',native.QUESTION)])
        self.assertTrue(all(mock.call_count==0 for mock in self.fixture.forbidden))

    async def test_expansion_preserves_null_score_and_native_relation_without_properties(self):
        response = await self.post(body=self.body(top_k=1,expand=True))
        self.assertEqual(response.status_code,200,response.text)
        items = response.json()['items']
        self.assertEqual([(r['entity_id'],r['score']) for r in items],[('unit-1',0.9),('document-1',None)])
        self.assertEqual(items[1]['vector_sources'],[])
        self.assertEqual(set(items[1]['graph_context'][0]),{'from','predicate','to'})

    async def test_empty_native_items_preserved(self):
        with patch.object(self.reader,'vector_search',return_value=[]):
            response = await self.post()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['items'],[])

    async def test_auth_first_precedence_before_body_and_factory(self):
        for headers,status,code in (({'X-User-ID':native.USER},401,'AUTH_REQUIRED'),
            ({'Authorization':'Bearer invalid','Content-Type':'text/plain'},401,'AUTH_INVALID'),
            (self.headers(Authorization='Bearer '+'q'*43,**{'X-User-ID':native.USER}),403,'SCOPE_DENIED'),
            (self.headers(**{'X-User-ID':native.USER}),422,'INVALID_REQUEST')):
            with self.subTest(code=code): self.error(await self.post(headers=headers,raw=b'{'),status,code)
        self.assertEqual(self.made,[])

    async def test_strict_dto_and_top_k_expand_boundaries(self):
        for body in (self.body(user_id=None),self.body(context_id=''),self.body(top_k=True),self.body(top_k=0),
                     self.body(top_k=11),self.body(top_k='10'),self.body(expand=1),self.body(write=True)):
            with self.subTest(body=body): self.error(await self.post(body=body),422,'INVALID_REQUEST')
        for top_k,expand in ((1,False),(10,True)):
            self.reader.closed=False
            self.assertEqual((await self.post(body=self.body(top_k=top_k,expand=expand))).status_code,200)

    async def test_media_encoding_body_size_and_upload_deadline(self):
        for headers,status,code in ((self.headers(**{'Content-Type':'text/plain'}),415,'UNSUPPORTED_MEDIA_TYPE'),
            (self.headers(**{'Content-Encoding':'gzip'}),415,'UNSUPPORTED_MEDIA_TYPE'),
            (self.headers(**{'Content-Length':'65537'}),413,'REQUEST_TOO_LARGE')):
            self.error(await self.post(headers=headers),status,code)
        self.error(await self.post(raw=b'{"message":"q","message":"q"}'),400,'INVALID_JSON')
        self.error(await self.post(raw=b'\xff'),400,'INVALID_JSON')

    async def test_default_operational_proof_denies_enabled_route(self):
        with patch.object(runtime,'_require_operational_proof',OPERATIONAL_PROOF):
            self.error(await self.post(),503,'NOT_READY')
        self.assertEqual(self.made,[])

    async def test_release_schema_source_and_missing_configuration_denied(self):
        self.error(await self.post(headers=self.headers(**{'X-KAG-Release-ID':'foreign'})),409,'RELEASE_MISMATCH')
        self.error(await self.post(body=self.body(schema_contract={**native.IDENTITY,'schema_sha256':'a'*64})),
                   409,'SCHEMA_CONTRACT_MISMATCH')
        original=self.app.state.runtime_settings
        self.app.state.runtime_settings=replace(original,source_snapshot_id='foreign')
        self.error(await self.post(),409,'SOURCE_SNAPSHOT_MISMATCH')
        self.app.state.runtime_settings=replace(original,embedding_key=None)
        self.error(await self.post(),503,'NOT_READY')
        self.assertEqual(self.made,[])

    async def test_unknown_native_identity_and_linked_ids_reject_entire_response(self):
        for change in ({'entity_id':'foreign'},{'doc_id':'foreign'},{'unit_id':None},{'sign_id':'foreign'}):
            with self.subTest(change=change),self.result([self.item(),{**self.item(),**change}]):
                self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_native_shape_and_finite_scores_reject_entire_response(self):
        item=self.item()
        for items in (None,{},[1],[{**item,'extra':'forged'}],[{**item,'score':float('nan')}],
                      [{**item,'score':True}],[{**item,'score':None}],[{k:v for k,v in item.items() if k!='doc_id'}]):
            with self.subTest(items_type=type(items).__name__),self.result(items):
                self.error(await self.post(),502,'INVALID_NATIVE_RESULT')

    async def test_exact_source_fields_and_index_provenance(self):
        for item in ({**self.item(),'source_texts':{'text':'forged'}},
                     {**self.item('TrafficSign','sign-1'),'source_texts':{'title':'invented alias'}},
                     {**self.item(),'vector_sources':[{'property':'text','score':0.9,'index':'foreign'}]}):
            with self.result([item]): self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_logical_catalog_description_preserves_native_moTa(self):
        for record in self.reader.catalog['records']:
            if record['entity_type']=='VietRoadTraffic.TrafficSign' and record['physical_field']=='moTa':
                record['field']='mo_ta'
        self.reader.seal(publication=False)
        self.app.state.serving_release=artifacts.load_release(self.fixture.root,'synthetic-release')
        response=await self.post()
        self.assertEqual(response.status_code,200,response.text)
        sign=next(item for item in response.json()['items'] if item['sign_id']=='sign-1')
        self.assertEqual(sign['source_texts'],{p:self.reader.nodes['VietRoadTraffic.TrafficSign','sign-1']['properties'][p]
                                              for p in ('ten','moTa')})
        self.assertEqual(self.fixture.calls,[('embed',native.QUESTION)])

    async def test_empty_sign_name_exact_metadata_without_empty_source_record(self):
        self.reader.nodes['VietRoadTraffic.TrafficSign','sign-1']['properties']['ten']=''
        for record in self.reader.catalog['records']:
            if record['entity_type']=='VietRoadTraffic.TrafficSign':
                record['metadata']['ten']=''
        self.reader.catalog['records']=[r for r in self.reader.catalog['records']
            if not (r['entity_type']=='VietRoadTraffic.TrafficSign' and r['physical_field']=='ten')]
        self.reader.seal(publication=False)
        self.app.state.serving_release=artifacts.load_release(self.fixture.root,'synthetic-release')
        response=await self.post()
        self.assertEqual(response.status_code,200,response.text)
        sign=next(item for item in response.json()['items'] if item['sign_id']=='sign-1')
        self.assertEqual(sign['source_texts']['ten'],'')
        self.assertEqual(sign['source_texts']['moTa'],self.reader.nodes['VietRoadTraffic.TrafficSign','sign-1']['properties']['moTa'])
        sign['source_texts']['ten']='invented'
        with self.result([sign]): self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_relation_ids_predicate_and_supported_provenance(self):
        relation={k:v for k,v in self.reader.relation.items() if k!='properties'}
        for change in ({'to':['VietRoadTraffic.LegalUnit','foreign']},{'predicate':'invented'},
                       {'from':['VietRoadTraffic.TrafficSign','sign-1']}):
            item=self.item(); item['graph_context']=[{**relation,**change}]
            with self.result([item]): self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')
        item=self.item(); item['graph_context']=[dict(relation,properties={})]
        with self.result([item]): self.error(await self.post(),502,'INVALID_NATIVE_RESULT')

    async def test_backend_index_source_metadata_and_physical_relation_fail_before_embedding(self):
        for mutate,restore in (
            (lambda:self.reader.metadata.update(databaseID='foreign'),lambda:self.reader.metadata.update(databaseID='physical-fixture-db')),
            (lambda:self.reader.vector_indexes[0].update(state='POPULATING'),lambda:self.reader.vector_indexes[0].update(state='ONLINE')),
            (lambda:self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']['properties'].update(soHieu='foreign'),
             lambda:self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']['properties'].update(soHieu='synthetic-document')),
            (lambda:self.reader.edges.clear(),lambda:self.reader.edges.append({'physical_id':1,'predicate':'hasUnit','properties':{},
                'from':{'labels':['VietRoadTraffic.LegalDocument'],'properties':{'id':'document-1','name':'document-1'}},
                'to':{'labels':['VietRoadTraffic.LegalUnit'],'properties':{'id':'unit-1','name':'unit-1'}}}))):
            mutate()
            try: self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')
            finally: restore()
        self.assertEqual(self.made,[])

    async def test_artifact_and_catalog_drift_after_retrieval_abort(self):
        original=runtime.run_retrieve
        async def retrieve(*args):
            items=await original(*args)
            (self.fixture.root/'source-catalog.json').write_bytes(b'{}')
            return items
        with patch.object(runtime,'run_retrieve',retrieve): self.error(await self.post(),503,'NOT_READY')
        self.assertTrue(self.reader.closed)

    async def test_selected_release_swap_after_retrieval_abort(self):
        original=runtime.run_retrieve
        async def retrieve(*args):
            items=await original(*args)
            self.app.state.serving_release=replace(self.release,release_id='foreign')
            return items
        with patch.object(runtime,'run_retrieve',retrieve): self.error(await self.post(),409,'RELEASE_MISMATCH')

    async def test_maximum_110_items_and_111_rejected_without_dropping(self):
        self.units(native.TEXT,110)
        items=[self.item(identity='unit-'+str(i)) for i in range(1,111)]
        with self.result(items):
            response=await self.post(body=self.body(expand=True))
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['items'],items)
        with self.result(items+[items[-1]]): self.error(await self.post(),502,'RESULT_LIMIT_EXCEEDED')

    async def test_entire_utf8_envelope_exact_cap_and_one_over(self):
        with patch('kag.http_api.app.uuid4',return_value=UUID(native.USER)):
            with self.result([self.item()]): response=await self.post()
            self.assertEqual(response.status_code,200,response.text)
            slack=245760-len(response.content)
            # Whole envelope overhead measured, then source resealed byte-exact.
            self.units(native.TEXT+'😀'*(slack//4)+'x'*(slack%4))
            with self.result([self.item()]): response=await self.post()
            self.assertEqual((response.status_code,len(response.content)),(200,245760))
            self.assertEqual(response.json()['items'][0]['source_texts']['text'],
                             self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']['properties']['text'])
            self.units(self.item()['source_texts']['text']+'x')
            with self.result([self.item()]): self.error(await self.post(),502,'RESULT_LIMIT_EXCEEDED')

    async def raw_asgi(self, send=None, disconnect=None):
        body=json.dumps(self.body()).encode()
        headers=self.headers(**{'Content-Length':str(len(body))})
        scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','scheme':'http','method':'POST',
            'path':'/v1/retrieve','raw_path':b'/v1/retrieve','query_string':b'','root_path':'',
            'headers':[(k.lower().encode(),v.encode()) for k,v in headers.items()],
            'server':('asgi.invalid',80),'client':('127.0.0.1',1234)}
        received=False
        messages=[]
        async def receive():
            nonlocal received
            if not received:
                received=True
                return {'type':'http.request','body':body,'more_body':False}
            if disconnect is None: await asyncio.Future()
            else: await disconnect.wait()
            return {'type':'http.disconnect'}
        async def capture(message):
            if send is not None: await send(message)
            messages.append(dict(message))
        await self.app(scope,receive,capture)
        return messages

    async def drain(self, cancel=False, disconnect=False):
        entered,finish=threading.Event(),threading.Event()
        original=self.reader.vector_search
        def search(*args):
            entered.set()
            if not finish.wait(5): raise AssertionError('Synthetic worker must be released')
            return original(*args)
        lost=asyncio.Event()
        messages=[]
        async def send(message): messages.append(dict(message))
        with patch.object(self.reader,'vector_search',search),patch.object(runtime,'REQUEST_SECONDS',1):
            task=asyncio.create_task(self.raw_asgi(send, lost if disconnect else None))
            try:
                while not entered.is_set() and not task.done(): await asyncio.sleep(.001)
                self.assertTrue(entered.is_set(),'Owned retrieve worker must start')
                self.assertEqual(messages,[],'No headers/body while worker is unverified')
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task
                elif disconnect:
                    lost.set()
                    with self.assertRaises(asyncio.CancelledError): await task
                else:
                    await task
                    self.assertEqual(messages[0]['status'],504)
                self.assertTrue(self.supervisor.busy)
                self.assertFalse(self.reader.closed)
                with patch.object(runtime,'_today',lambda:native.AS_OF):
                    query_body={'user_id':native.USER,'message':native.QUESTION,'context_id':'','schema_contract':native.IDENTITY}
                    self.app.state.runtime_settings=self.fixture.settings()
                    query=await self.client.post('/v1/query',headers={'Authorization':'Bearer '+'q'*43,
                        'X-KAG-Release-ID':'synthetic-release','X-WebApp-Snapshot-ID':'synthetic-webapp',
                        'X-KAG-As-Of':native.AS_OF.isoformat()},json=query_body)
                    self.error(query,429,'CONCURRENCY_LIMIT')
            finally:
                finish.set()
                await self.supervisor.close()
                await asyncio.gather(task,return_exceptions=True)
        self.assertTrue(self.reader.closed)
        self.assertFalse(self.supervisor.busy)

    async def test_http_timeout_holds_shared_slot_until_actual_worker_drains(self): await self.drain()
    async def test_http_cancellation_holds_shared_slot_until_actual_worker_drains(self): await self.drain(cancel=True)
    async def test_http_disconnect_holds_shared_slot_until_actual_worker_drains(self): await self.drain(disconnect=True)

    async def test_slow_final_source_verification_emits_no_success_headers(self):
        self.assertTrue(hasattr(contract,'encode_retrieve'),'P3 bounded encoder missing')
        entered,finish=threading.Event(),threading.Event()
        original=contract.encode_retrieve
        sent=[]
        def encode(value):
            entered.set()
            if not finish.wait(5): raise AssertionError('Synthetic encoder must be released')
            return original(value)
        with patch.object(contract,'encode_retrieve',encode),patch.object(runtime,'REQUEST_SECONDS',1):
            task=asyncio.create_task(self.raw_asgi(_capture_messages(sent)))
            try:
                while not entered.is_set() and not task.done(): await asyncio.sleep(.001)
                self.assertTrue(entered.is_set())
                self.assertEqual(sent,[])
                await task
                self.assertEqual(sent[0]['status'],504)
                self.assertTrue(self.supervisor.busy)
                self.assertFalse(self.reader.closed)
            finally:
                finish.set()
                await self.supervisor.close()

    async def test_serialization_failure_and_post_encode_proof_drift_abort(self):
        self.assertTrue(hasattr(contract,'encode_retrieve'),'P3 bounded encoder missing')
        with patch.object(contract,'encode_retrieve',side_effect=contract.ApiFailure('INVALID_NATIVE_RESULT')):
            self.error(await self.post(),502,'INVALID_NATIVE_RESULT')
        original=contract.encode_retrieve
        def encode(value):
            raw=original(value)
            self.reader.nodes['VietRoadTraffic.LegalUnit','unit-1']['properties']['text']='changed'
            return raw
        with patch.object(contract,'encode_retrieve',encode): self.error(await self.post(),502,'SOURCE_VALIDATION_FAILED')

    async def test_preheader_release_drift_never_sends_success(self):
        self.assertTrue(hasattr(contract,'encode_retrieve'),'P3 bounded encoder missing')
        def close():
            self.reader.closed=True
            (self.fixture.root/'release.json').write_bytes(b'{}')
        with patch.object(self.reader,'close',close): messages=await self.raw_asgi()
        self.assertEqual(messages[0]['status'],409)
        self.assertFalse(any(m.get('status')==200 for m in messages))

    async def test_sample_enablement_never_promotes_readiness(self):
        self.assertEqual((await self.post()).status_code,200)
        response=await self.client.get('/v1/health?mode=ready&capability=retrieve',headers=self.headers())
        self.assertEqual(response.status_code,503)
        self.assertEqual(response.json()['checks']['runtime'],'blocked')


class TerminalSSETests(unittest.IsolatedAsyncioTestCase):
    """P4 real public native answer/finalizer, synthetic I/O and raw ASGI delivery."""
    enable_sample_routes = True
    asyncSetUp = AppTests.asyncSetUp
    asyncTearDown = AppTests.asyncTearDown
    headers = AppTests.headers
    body = AppTests.body
    error = AppTests.error
    citation = AppTests.citation
    result = AppTests.result
    after_core = AppTests.after_core
    reload = AppTests.reload
    units = AppTests.units
    blocked_core = AppTests.blocked_core

    async def post(self, **kwargs):
        kwargs.setdefault('path','/v1/query/stream')
        return await AppTests.post(self, **kwargs)

    async def raw_asgi(self, send=None, disconnect=None):
        return await AppTests.raw_asgi(self,send,disconnect,path='/v1/query/stream')

    async def test_exact_done_frame_matches_rest_bytes_citations_order_and_headers(self):
        rest = await self.post(path='/v1/query')
        self.reader.closed = False
        stream = await self.post()
        self.assertEqual(stream.status_code,200,stream.text)
        self.assertEqual(stream.content,b'event: done\ndata: '+rest.content+b'\n\n')
        self.assertEqual(stream.headers['content-type'],'text/event-stream; charset=utf-8')
        self.assertEqual(stream.headers['cache-control'],'no-store')
        self.assertEqual(stream.headers['x-accel-buffering'],'no')
        for header in ('x-kag-release-id','x-webapp-snapshot-id','x-kag-as-of'):
            self.assertEqual(stream.headers[header],rest.headers[header])
        self.assertEqual(str(UUID(stream.headers['x-request-id'])),stream.headers['x-request-id'])
        self.assertEqual(stream.content.count(b'event: '),1)
        self.assertTrue(self.reader.closed and self.made[-1].closed)
        self.assertFalse(self.supervisor.busy)

    async def test_whole_frame_exact_cap_and_one_byte_over_preserves_rest(self):
        citations = self.units('界'*10000,8)
        base = AnswerResult('A',citations,False)
        with self.result(base):
            rest = await self.post(path='/v1/query')
        self.assertEqual(rest.status_code,200,rest.text)
        for size in (245739,245740,245741,245760):
            answer='A'*(1+size-len(rest.content))
            self.assertLessEqual(len(answer),10000)
            with self.subTest(raw_json_bytes=size),self.result(AnswerResult(answer,citations,False)):
                self.reader.closed=False
                plain=await self.post(path='/v1/query')
                self.assertEqual((plain.status_code,len(plain.content)),(200,size))
                self.reader.closed=False
                stream=await self.post()
                if size<=245740:
                    self.assertEqual(stream.status_code,200,stream.text)
                    self.assertEqual(stream.content,b'event: done\ndata: '+plain.content+b'\n\n')
                    self.assertLessEqual(len(stream.content),245760)
                else:
                    self.error(stream,502,'RESULT_LIMIT_EXCEEDED')
                    self.assertEqual(stream.headers['content-type'],'application/json')

    async def test_slow_core_source_projection_serialization_emit_nothing_until_verified(self):
        for stage in ('core','source','projection','serialization'):
            entered,finish=threading.Event(),threading.Event()
            sent=[]
            if stage=='core':
                blocked=self.blocked_core(entered,finish)
            else:
                owner,name=(artifacts,'verify_native_sources') if stage=='source' else (
                    (contract,'project_v1') if stage=='projection' else (contract,'encode_v1'))
                original=getattr(owner,name)
                def call(*args,original=original,**kwargs):
                    entered.set()
                    if not finish.wait(10): raise AssertionError('Synthetic stage must be released')
                    return original(*args,**kwargs)
                blocked=patch.object(owner,name,call)
            with self.subTest(stage=stage),blocked:
                self.reader.closed=False
                task=asyncio.create_task(self.raw_asgi(_capture_messages(sent)))
                try:
                    while not entered.is_set() and not task.done(): await asyncio.sleep(.001)
                    self.assertTrue(entered.is_set())
                    self.assertEqual(sent,[])
                    finish.set()
                    await task
                    self.assertEqual(sent[0]['status'],200)
                    self.assertEqual(sum(m['type']=='http.response.body' for m in sent),1)
                    self.assertTrue(sent[-1]['body'].endswith(b'\n\n'))
                finally:
                    finish.set()
                    await asyncio.gather(task,return_exceptions=True)

    async def test_partial_frame_delivery_failure_never_adds_error_or_late_done(self):
        delivered=[]
        async def send(message):
            if message['type']=='http.response.body':
                delivered.append(message['body'][:19])
                raise OSError('synthetic partial transport failure')
        messages=await self.raw_asgi(send)
        self.assertEqual(messages[0]['status'],200)
        self.assertEqual(delivered,[b'event: done\ndata: {'])
        self.assertFalse(any(m['type']=='http.response.body' for m in messages))
        self.assertNotIn(b'\n\n',b''.join(delivered))

    async def test_invalid_serialization_stays_json_before_success_headers(self):
        with patch.object(contract,'encode_v1',side_effect=contract.ApiFailure('INVALID_NATIVE_RESULT')):
            messages=await self.raw_asgi()
        self.assertEqual(messages[0]['status'],502)
        self.assertEqual(dict(messages[0]['headers'])[b'content-type'],b'application/json')
        self.assertNotIn(b'event:',messages[-1]['body'])

    test_abstention_never_success = AppTests.test_real_native_abstention_never_becomes_success
    test_missing_bearer_before_factory = AppTests.test_missing_bearer_before_factory
    test_wrong_scope_before_factory = AppTests.test_wrong_scope_before_factory
    test_delegation_denied_before_factory = AppTests.test_delegation_denied_before_factory
    async def test_options_rejected_before_factory(self):
        self.error(await self.post(path='/v1/query/stream?model=foreign'),422,'INVALID_REQUEST')
        self.assertEqual(self.made,[])

    test_uuid_fields_rejected_before_factory = AppTests.test_unknown_uuid_and_type_fields_rejected
    test_schema_mismatch_before_factory = AppTests.test_schema_mismatch_before_factory
    test_invalid_citations_source_quote_spans = AppTests.test_invalid_citation_source_ids_quote_and_spans
    test_source_drift_after_native_core = AppTests.test_changed_source_after_actual_core_fails_final_proof
    test_frozen_source_catalog_drift = AppTests.test_source_catalog_tamper_after_core_fails
    test_schema_drift_after_native_core = AppTests.test_selected_schema_changed_after_core_conflict
    test_publication_drift_after_native_core = AppTests.test_publication_tamper_after_core_fails
    test_provider_error_sanitized = AppTests.test_provider_error_sanitized
    test_expired_citation_before_projection = AppTests.test_effectivity_rejected_before_projection
    test_midnight_after_core = AppTests.test_midnight_after_core_aborts_without_success
    test_midnight_during_serialization = AppTests.test_midnight_during_serialization_aborts
    test_final_readback_timeout_owns_worker = AppTests.test_timeout_during_final_readback_holds_reader_and_no_success
    test_cleanup_release_drift = AppTests.test_selected_release_changed_during_cleanup_rejected
    test_cleanup_publication_drift = AppTests.test_publication_changed_during_cleanup_rejected
    test_cleanup_failure_blocks_admission = AppTests.test_http_cleanup_failure_blocks_later_admission
    test_disconnect_owns_worker_until_drain = AppTests.test_actual_asgi_disconnect_holds_worker_clients_and_slot
    test_handler_cancel_owns_worker_until_drain = AppTests.test_http_handler_cancel_keeps_owned_worker_until_drain
    test_postheader_midnight_cancels_body = AppTests.test_pending_body_send_crosses_midnight_never_completes_success
    test_postheader_proof_drift_blocks_body = AppTests.test_authority_changes_after_headers_prevent_complete_body
    test_pending_body_proof_drift_cancels_delivery = AppTests.test_pending_body_send_publication_change_never_completes
    test_pending_body_deadline_cancels_delivery = AppTests.test_pending_body_send_deadline_never_completes
    test_postheader_send_failure_no_replacement = AppTests.test_post_start_send_exception_has_no_complete_or_error_body


def _capture_messages(messages):
    async def send(message): messages.append(dict(message))
    return send
