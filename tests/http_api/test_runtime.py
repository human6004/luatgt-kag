"""SYNTHETIC runtime admission and drain; actual native aanswer, no network."""
import asyncio
from datetime import date
from dataclasses import replace
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import httpx
from starlette.requests import Request
from kag.http_api.app import ApiSettings, create_app
from kag.http_api.contract import ApiFailure
from kag.http_api.security import ServiceSecrets
from test_artifacts import EvidenceFixture, AS_OF, IDENTITY, sha, raw_json

QUESTION = 'Xe mô tô phải đội mũ bảo hiểm?'
TEXT = 'Người điều khiển xe mô tô phải đội mũ bảo hiểm.'
USER = '00000000-0000-4000-8000-000000000001'
SECRETS = ServiceSecrets(('q'*43,), ('i'*43,))


def api():
    assert importlib.util.find_spec('kag.http_api.runtime') is not None, 'Step4 runtime missing'
    return importlib.import_module('kag.http_api.runtime')


class ReadFixture(EvidenceFixture):
    def __init__(self, root, events):
        super().__init__(root)
        self.events, self.closed = events, False
        self.nodes[('VietRoadTraffic.LegalUnit','unit-1')]['properties']['text'] = TEXT
        for record in self.catalog['records']:
            if record['entity_type'].endswith('.LegalUnit'):
                record['source_text'] = TEXT
                record['source_sha256'] = sha(TEXT.encode())
                record['metadata']['text'] = TEXT
        self.publication['units'][0]['text_sha256'] = sha(TEXT.encode())
        self.seal()

    def database_metadata(self):
        self.events.append('backend')
        return super().database_metadata()

    def read_nodes(self, keys):
        self.events.append('source')
        return super().read_nodes(keys)

    def vector_search(self, kind, prop, vector, k):
        self.events.append('vector')
        return [{'id':'unit-1','score':0.9,'index':'synthetic'}] if kind=='LegalUnit' else []

    def expand(self, *args):
        return []

    def close(self):
        self.closed = True
        self.events.append('reader.close')


def action(executor):
    return {'executor':{'name':executor,'arguments':{} if executor=='Finish' else {'query':QUESTION},
                        'thought':'Synthetic'}}


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_embedding_sdk_errors_propagate_safely_without_source_logging(self):
        import io
        from contextlib import redirect_stdout
        from types import SimpleNamespace
        module=api()
        runtime=SimpleNamespace(budget=module._Budget(time.monotonic()+10),sdk_models=[])
        embed=module._new_embedding(self.settings(),runtime)
        model=runtime.sdk_models[0]
        model.client.max_retries=0
        model.client._client._transport=httpx.MockTransport(lambda request:httpx.Response(503,json={'error':{'message':'PRIVATE_BODY'}}))
        output=io.StringIO()
        try:
            with redirect_stdout(output):
                with self.assertRaises(module.RuntimeFailure) as caught: embed('PRIVATE_SOURCE')
            self.assertEqual(caught.exception.code,'PROVIDER_ERROR')
            self.assertNotIn('PRIVATE',output.getvalue()+str(caught.exception))
            self.assertIn('SAMPLE_EMBEDDING_FAILURE',output.getvalue())
        finally:
            model.client.close();await model.aclient.close()

    async def test_embedding_rejects_malformed_dimensions_nonfinite_and_zero_without_retry(self):
        from types import SimpleNamespace
        module=api()
        for vector in ([1.0]*3071,[0.0]*3072,[1.0]*3071+[float('inf')]):
            runtime=SimpleNamespace(budget=module._Budget(time.monotonic()+10),sdk_models=[])
            embed=module._new_embedding(self.settings(),runtime);model=runtime.sdk_models[0];calls=[]
            model.client._client._transport=httpx.MockTransport(lambda request:calls.append(True) or httpx.Response(200,content=json.dumps({'data':[{'embedding':vector}]}).encode(),headers={'Content-Type':'application/json'}))
            try:
                with self.assertRaises(module.RuntimeFailure):embed('TEST ONLY')
                self.assertEqual(len(calls),1)
            finally:
                model.client.close();await model.aclient.close()

    async def test_embedding_keeps_sdk_base64_decoding_and_exact_valid_vector(self):
        import base64,struct
        from types import SimpleNamespace
        module=api();runtime=SimpleNamespace(budget=module._Budget(time.monotonic()+10),sdk_models=[])
        embed=module._new_embedding(self.settings(),runtime);model=runtime.sdk_models[0]
        encoded=base64.b64encode(struct.pack('<3072f',1.0,*([0.0]*3071))).decode()
        model.client._client._transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'data':[{'embedding':encoded}]}))
        try:self.assertEqual(embed('TEST ONLY'),[1.0]+[0.0]*3071)
        finally:model.client.close();await model.aclient.close()

    async def test_embedding_diagnostics_exclude_provider_body_and_input(self):
        import io
        from contextlib import redirect_stdout
        secret='PRIVATE_PROVIDER_BODY_AND_INPUT'
        output=io.StringIO()
        for status,body,kind,dimension in ((200,{'data':[{'embedding':[1.0]*3072}], 'private':secret},'list',3072),
                                         (503,{'error':secret},'NoneType',None)):
            response=httpx.Response(status,json=body,request=httpx.Request('POST','http://fixture.invalid',json={'input':secret}))
            with redirect_stdout(output):api()._embedding_response_metadata(response)
            row=json.loads(output.getvalue().splitlines()[-1].removeprefix('SAMPLE_EMBEDDING '))
            self.assertEqual(row,dict(status=status,embedding_type=kind,dimension=dimension))
        self.assertNotIn(secret,output.getvalue())

    async def test_query_failure_diagnostics_hide_exception_and_question(self):
        import io
        from contextlib import redirect_stdout
        from types import SimpleNamespace
        module=api()
        secret='PRIVATE_EXCEPTION_AND_QUESTION'
        request=SimpleNamespace(budget=module._Budget(time.monotonic()+10),closed=False,
            question=secret,as_of=AS_OF,pipeline=object())
        async def fail(*args,**kwargs):raise ValueError(secret)
        output=io.StringIO()
        with patch('kag.legal_solver.aanswer',fail),redirect_stdout(output):
            with self.assertRaises(module.RuntimeFailure) as caught:
                await module.run_query(request,secret,AS_OF)
        self.assertEqual(caught.exception.code,'PROVIDER_ERROR')
        self.assertNotIn(secret,output.getvalue())
        self.assertIn('"error_type": "ValueError"',output.getvalue())

    async def test_query_failure_preserves_inner_legal_parse_without_sensitive_text(self):
        import io
        from contextlib import redirect_stdout
        from types import SimpleNamespace
        from kag.interface import LLMClient
        from kag.legal_prompts import LegalPlanningPrompt
        module=api();secret='PRIVATE_PROMPT_RESPONSE_EXCEPTION'
        class Model(LLMClient):
            model='offline-fixture'
            def call_with_json_parse(self, **kwargs):return {'private':secret}
        model=Model(name='chain-fixture',enable_check=False)
        async def fail(*args,**kwargs):
            model.invoke(dict(query=secret,context=[],executors=[]),LegalPlanningPrompt(language='vi'))
        request=SimpleNamespace(budget=module._Budget(time.monotonic()+10),closed=False,
            question=secret,as_of=AS_OF,pipeline=object())
        output=io.StringIO()
        with patch('kag.legal_solver.aanswer',fail),redirect_stdout(output):
            with self.assertRaises(module.RuntimeFailure) as caught:await module.run_query(request,secret,AS_OF)
        row=json.loads(output.getvalue().splitlines()[-1].removeprefix('SAMPLE_QUERY_FAILURE '))
        self.assertEqual(caught.exception.code,'PROVIDER_ERROR')
        self.assertNotIn(secret,output.getvalue())
        self.assertEqual(row['inner_errors'][0]['type'],'ValueError')
        self.assertEqual(row['inner_errors'][0]['stage'],'legal_parse')
        self.assertEqual(row['inner_errors'][0]['category'],'LEGAL_RESPONSE_INVALID')
        self.assertTrue(any(f['file']=='kag/legal_prompts.py' and f['function']=='parse_response'
                            for f in row['inner_errors'][0]['frames']))

    def test_query_failure_chain_prefers_cause_and_bounds_cycles(self):
        secret='PRIVATE_CHAIN_MESSAGE'
        cause=ValueError(secret);context=TypeError(secret);outer=RuntimeError(secret)
        outer.__cause__=cause;outer.__context__=context;cause.__context__=outer
        row=api()._query_failure_diagnostic(outer)
        self.assertEqual([item['type'] for item in row['inner_errors']],['ValueError'])
        self.assertNotIn(secret,json.dumps(row))

    def test_query_failure_stage_uses_source_frames_only(self):
        root=Path(api().__file__).resolve().parents[2]
        cases=[('kag/legal_prompts.py','validate_subquery','legal_parse','LEGAL_SUBQUERY_REJECTED'),
               ('vendor/KAG/kag/interface/common/llm_client.py','call_with_json_parse','json_parse','JSON_PARSE_FAILED'),
               ('vendor/KAG/kag/common/llm/openai_client.py','__call__','model_call','MODEL_CALL_FAILED')]
        for filename,function,stage,category in cases:
            namespace={}
            exec(compile('def '+function+'():\n raise ValueError("PRIVATE_FRAME_MESSAGE")',str(root/filename),'exec'),namespace)
            try:namespace[function]()
            except ValueError as inner:
                outer=RuntimeError('PRIVATE_WRAPPER');outer.__cause__=inner
                item=api()._query_failure_diagnostic(outer)['inner_errors'][0]
                self.assertEqual((item['stage'],item['category']),(stage,category))
                self.assertNotIn('PRIVATE',json.dumps(item))

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runtime-synthetic-')
        self.root = Path(self.temp.name)
        self.events = []
        self.reader = ReadFixture(self.root,self.events)
        from kag.http_api.artifacts import load_release
        self.release = load_release(self.root,'synthetic-release')
        self.shell = create_app(ApiSettings(SECRETS))

    async def asyncTearDown(self):
        self.temp.cleanup()

    def settings(self):
        return api().RuntimeSettings(secrets=SECRETS,release_id='synthetic-release',
            source_snapshot_id='synthetic-source',webapp_snapshot_id='synthetic-webapp',
            reader_username='synthetic-reader',reader_password='synthetic-password',
            embedding_url='http://embedding.invalid/v1',embedding_model='synthetic-3072',
            embedding_key='synthetic-embedding-secret',chat_url='http://chat.invalid/v1',
            chat_model='synthetic-chat',chat_key='synthetic-chat-secret')

    def request(self, token='q'*43, body=None, headers=None, raw=None):
        payload = {'user_id':USER,'message':QUESTION,'context_id':'','schema_contract':IDENTITY}
        if body:
            payload.update(body)
        raw = json.dumps(payload).encode() if raw is None else raw
        fields = {'authorization':'Bearer '+token,'content-type':'application/json',
            'content-length':str(len(raw)),'x-kag-release-id':'synthetic-release',
            'x-webapp-snapshot-id':'synthetic-webapp','x-kag-as-of':AS_OF.isoformat()}
        fields.update(headers or {})
        messages = [{'type':'http.request','body':raw,'more_body':False}]
        async def receive():
            return messages.pop(0)
        return Request({'type':'http','asgi':{'version':'3.0'},'method':'POST','path':'/internal',
            'raw_path':b'/internal','query_string':b'', 'headers':[(k.encode(),v.encode()) for k,v in fields.items()],
            'app':self.shell,'state':{},'client':('127.0.0.1',1234),'server':('fixture.invalid',8000)},receive)

    def synthetic(self, abstain=False, sdk=False):
        module = api()
        from kag.interface import LLMClient
        events = self.events
        class FakeLLM(LLMClient):
            def __init__(self):
                super().__init__(name='synthetic-test-llm',enable_check=False)
                self.model = 'synthetic'
                self.responses = [action('Retriever'),action('Deduce'),'candidate',action('Finish')]
            def __call__(self,prompt,**kwargs):
                response = self.responses.pop(0)
                if response=='candidate':
                    value = json.loads(prompt)['evidence']['items'][0]
                    response = {'abstained':abstain,'applicability':'insufficient' if abstain else 'supported',
                        'effectivity':'uncertain' if abstain else 'supported','conflict':'none',
                        'selections':[] if abstain else [{'evidence_id':value['evidence_ids']['text'],
                            'field':'text','start':0,'end':len(TEXT)}],'support_selections':[]}
                return json.dumps(response,ensure_ascii=False)
        def proof(settings,release,*,capability='query'):
            events.append('SYNTHETIC.proof')
        def reader(*args):
            events.append('reader.constructor')
            return self.reader
        def embedding(*args):
            events.append('embedding.constructor')
            return lambda question:[1.0]+[0.0]*3071
        def llm(*args):
            events.append('llm.constructor')
            return FakeLLM()
        from contextlib import ExitStack
        stack=ExitStack()
        for name,value in (('_require_operational_proof',proof),('_new_reader',reader),
                           ('_new_embedding',embedding),('_new_llm',llm),('_today',lambda:AS_OF)):
            if sdk and name in ('_new_embedding','_new_llm'):
                continue
            stack.enter_context(patch.object(module,name,value))
        return stack

    async def rejection(self, request=None, code='NOT_READY', release=None, settings=None):
        module=api()
        supervisor=module.RuntimeSupervisor()
        settings=self.settings() if settings is None else settings
        with self.synthetic():
            with self.assertRaises((ApiFailure,module.RuntimeFailure)) as caught:
                await supervisor.query(request or self.request(),settings,release or self.release)
        self.assertEqual(caught.exception.code,code)
        self.assertNotIn('embedding.constructor',self.events)
        self.assertNotIn('llm.constructor',self.events)
        self.assertFalse(supervisor.busy)
        await supervisor.close()

    async def test_real_native_answer_and_constructor_order(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        with self.synthetic():
            result=await supervisor.query(self.request(),self.settings(),self.release)
        self.assertFalse(result.abstained)
        self.assertEqual(result.citations[0].quote,TEXT)
        self.assertEqual(result.answer,'Căn cứ nguồn đã xác nhận:\n'+TEXT)
        for first,second in (('SYNTHETIC.proof','reader.constructor'),('backend','embedding.constructor'),
                             ('source','embedding.constructor'),('embedding.constructor','llm.constructor')):
            self.assertLess(self.events.index(first),self.events.index(second))
        self.assertTrue(self.reader.closed)
        self.assertFalse(supervisor.busy)
        await supervisor.close()

    async def test_real_native_abstention_preserved(self):
        supervisor=api().RuntimeSupervisor()
        with self.synthetic(abstain=True):
            result=await supervisor.query(self.request(),self.settings(),self.release)
        self.assertTrue(result.abstained)
        self.assertEqual(result.citations,())
        self.assertEqual(result.answer,'Chưa đủ bằng chứng để kết luận pháp lý cho câu hỏi này.')
        await supervisor.close()

    async def test_default_live_proof_denies_synthetic_artifacts(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        with patch.object(module,'_today',lambda:AS_OF), patch.object(module,'_new_reader') as constructor:
            with self.assertRaises(ApiFailure) as caught:
                await supervisor.query(self.request(),self.settings(),self.release)
            self.assertEqual(caught.exception.code,'NOT_READY')
            constructor.assert_not_called()
        self.assertFalse(supervisor.live_ready)
        await supervisor.close()

    async def test_direct_factory_cannot_bypass_admission(self):
        with self.assertRaises(ApiFailure) as caught:
            api().make_runtime(self.settings(),self.release,time.monotonic()+25)
        self.assertEqual(caught.exception.code,'NOT_READY')
        self.assertEqual(self.events,[])

    async def test_missing_auth_denied_before_constructor(self):
        await self.rejection(self.request(token=''),'AUTH_INVALID')

    async def test_inspect_query_scope_denied_before_constructor(self):
        await self.rejection(self.request(token='i'*43),'SCOPE_DENIED')

    async def test_unknown_request_field_denied_before_constructor(self):
        await self.rejection(self.request(body={'write':True}),'INVALID_REQUEST')

    async def test_duplicate_json_key_denied_before_constructor(self):
        await self.rejection(self.request(raw=b'{"user_id":1,"user_id":2}'),'INVALID_JSON')

    async def test_oversize_body_denied_before_constructor(self):
        await self.rejection(self.request(raw=b' '*65537),'REQUEST_TOO_LARGE')

    async def test_nonempty_context_denied_before_constructor(self):
        await self.rejection(self.request(body={'context_id':'session'}),'CONTEXT_NOT_SUPPORTED')

    async def test_schema_mismatch_before_constructor(self):
        await self.rejection(self.request(body={'schema_contract':{**IDENTITY,'schema_sha256':'a'*64}}),
                             'SCHEMA_CONTRACT_MISMATCH')

    async def test_release_header_mismatch_before_constructor(self):
        await self.rejection(self.request(headers={'x-kag-release-id':'foreign'}),'RELEASE_MISMATCH')

    async def test_snapshot_header_mismatch_before_constructor(self):
        await self.rejection(self.request(headers={'x-webapp-snapshot-id':'foreign'}),'SOURCE_SNAPSHOT_MISMATCH')

    async def test_date_mismatch_before_constructor(self):
        await self.rejection(self.request(headers={'x-kag-as-of':'2000-01-01'}),'DATE_MISMATCH')

    async def test_sample_publication_window_admits_next_day_and_keeps_request_header_gate(self):
        from datetime import timedelta
        from types import SimpleNamespace
        from kag.http_api.artifacts import load_release
        next_day=AS_OF+timedelta(days=1)
        self.reader.publication.update(schema='h1-webapp-publication-2.0',serving_until=(AS_OF+timedelta(days=6)).isoformat())
        self.reader.seal();release=load_release(self.root,'synthetic-release')
        request=self.request(headers={'x-kag-as-of':next_day.isoformat()})
        parsed=SimpleNamespace(schema_contract=release.schema_contract)
        self.assertEqual(api()._identity(request,self.settings(),release,parsed,next_day),next_day)
        with self.assertRaises(api().RuntimeFailure) as caught:
            api()._identity(self.request(),self.settings(),release,parsed,next_day)
        self.assertEqual(caught.exception.code,'DATE_MISMATCH')

    async def test_query_readiness_rejects_expired_publication_before_broker_or_gateway(self):
        from datetime import timedelta
        from kag.http_api.artifacts import load_release
        module=api()
        self.reader.publication.update(schema='h1-webapp-publication-2.0',serving_until=(AS_OF+timedelta(days=6)).isoformat())
        self.reader.seal();release=load_release(self.root,'synthetic-release')
        supervisor=module.RuntimeSupervisor()
        with patch.object(module,'_today',lambda:AS_OF+timedelta(days=7)),patch.object(module,'_require_operational_proof') as proof:
            with self.assertRaises(ApiFailure) as caught:
                await supervisor.sample_ready(self.request(),self.settings(),release,capability='query')
            self.assertEqual(caught.exception.code,'NOT_READY')
            proof.assert_not_called()
        await supervisor.close()

    async def test_missing_release_fail_closed(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        with self.synthetic(), self.assertRaises(ApiFailure):
            await supervisor.query(self.request(),self.settings(),None)
        self.assertNotIn('reader.constructor',self.events)
        await supervisor.close()

    async def test_changed_release_bytes_before_constructor(self):
        (self.root/'source-catalog.json').write_bytes(b'{}')
        await self.rejection()

    async def test_backend_identity_change_before_provider_constructor(self):
        self.reader.metadata['databaseID']='foreign'
        await self.rejection(code='SOURCE_VALIDATION_FAILED')
        self.assertTrue(self.reader.closed)

    async def test_index_change_before_provider_constructor(self):
        self.reader.vector_indexes[0]['state']='POPULATING'
        await self.rejection(code='SOURCE_VALIDATION_FAILED')

    async def test_source_readback_change_before_provider_constructor(self):
        self.reader.nodes[('VietRoadTraffic.LegalUnit','unit-1')]['properties']['text']='changed'
        await self.rejection(code='SOURCE_VALIDATION_FAILED')

    async def test_missing_publication_before_provider_constructor(self):
        from dataclasses import replace
        await self.rejection(release=replace(self.release,publication=None))

    async def test_missing_provider_secret_before_any_constructor(self):
        from dataclasses import replace
        await self.rejection(settings=replace(self.settings(),embedding_key=None))
        self.assertNotIn('reader.constructor',self.events)

    async def test_fresh_pipeline_and_executor_list(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        pipelines=[]
        original=module.make_runtime
        def factory(*args):
            runtime=original(*args)
            pipelines.append(runtime.pipeline)
            return runtime
        with self.synthetic(),patch.object(module,'make_runtime',factory):
            await supervisor.query(self.request(),self.settings(),self.release)
            self.reader.closed=False
            await supervisor.query(self.request(),self.settings(),self.release)
        self.assertIsNot(pipelines[0],pipelines[1])
        self.assertIsNot(pipelines[0].executors,pipelines[1].executors)
        await supervisor.close()

    async def test_shared_supervisor_failfast_concurrency(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        started=asyncio.Event()
        release=asyncio.Event()
        calls=[]
        async def query():
            calls.append('query')
            started.set()
            await release.wait()
            return 'safe'
        async def retrieve():
            calls.append('retrieve')
            return []
        first=asyncio.create_task(supervisor.supervise(query,time.monotonic()+25))
        await started.wait()
        try:
            with self.assertRaises(module.RuntimeFailure) as caught:
                await supervisor.supervise(retrieve,time.monotonic()+25)
            self.assertEqual((caught.exception.code,caught.exception.status,caught.exception.retry_after),
                             ('CONCURRENCY_LIMIT',429,1))
            self.assertEqual(calls,['query'])
        finally:
            release.set()
            self.assertEqual(await first,'safe')
            await supervisor.close()

    async def drain_case(self, cancel=False):
        module=api()
        supervisor=module.RuntimeSupervisor()
        entered=threading.Event()
        finish=threading.Event()
        closed=[]
        def worker():
            entered.set()
            finish.wait(2)
            return 'late secret'
        async def operation():
            try:
                return await asyncio.to_thread(worker)
            finally:
                closed.append('closed')
        task=asyncio.create_task(supervisor.supervise(operation,time.monotonic()+(.04 if not cancel else 25)))
        while not entered.is_set():
            await asyncio.sleep(.001)
        try:
            if cancel:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            else:
                with self.assertRaises(ApiFailure) as caught:
                    await task
                self.assertEqual(caught.exception.code,'QUERY_TIMEOUT')
            self.assertTrue(supervisor.busy)
            self.assertTrue(supervisor.draining)
            self.assertEqual(closed,[])
            with self.assertRaises(module.RuntimeFailure):
                await supervisor.supervise(operation,time.monotonic()+25)
        finally:
            finish.set()
            await supervisor.close()
        self.assertEqual(closed,['closed'])
        self.assertFalse(supervisor.busy)

    async def test_timeout_holds_slot_and_clients_until_thread_drains(self):
        await self.drain_case()

    async def test_cancellation_holds_slot_and_clients_until_thread_drains(self):
        await self.drain_case(cancel=True)

    async def test_shutdown_denies_new_work_and_drains(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        await supervisor.close()
        called=[]
        async def operation():
            called.append(True)
        with self.assertRaises(ApiFailure):
            await supervisor.supervise(operation,time.monotonic()+25)
        self.assertEqual(called,[])

    async def test_unexpected_error_sanitized_and_slot_released(self):
        supervisor=api().RuntimeSupervisor()
        async def operation():
            raise RuntimeError('token provider host raw traceback')
        with self.assertRaises(ApiFailure) as caught:
            await supervisor.supervise(operation,time.monotonic()+25)
        self.assertEqual(caught.exception.code,'INTERNAL_ERROR')
        self.assertNotIn('token',str(caught.exception))
        self.assertFalse(supervisor.busy)
        await supervisor.close()

    async def test_reader_guard_blocks_expired_dispatch(self):
        module=api()
        calls=[]
        class Opener:
            def open(self,*args,**kwargs):
                calls.append(kwargs['timeout'])
                return 'fixture'
        budget=module._Budget(time.monotonic()+25)
        guard=module._ReaderBoundary(Opener(),budget)
        self.assertEqual(guard.open('request',timeout=100),'fixture')
        self.assertLessEqual(calls[0],5)
        budget.stop()
        with self.assertRaises(ApiFailure):
            guard.open('request',timeout=100)
        self.assertEqual(len(calls),1)

    async def test_sdk_transport_guard_every_retry_and_remaining(self):
        module=api()
        clock=[0.0]
        budget=module._Budget(25.0,clock=lambda:clock[0])
        calls=[]
        def transport(request):
            calls.append(request.extensions['timeout'])
            return httpx.Response(200,json={'synthetic':True})
        guard=module._DeadlineTransport(httpx.MockTransport(transport),budget)
        with httpx.Client(transport=guard) as client:
            client.get('http://fixture.invalid')
            clock[0]=24.5
            client.get('http://fixture.invalid')
            clock[0]=25
            with self.assertRaises(ApiFailure):
                client.get('http://fixture.invalid')
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[0]['connect'],2)
        self.assertEqual(calls[0]['read'],5)
        self.assertEqual(calls[1]['read'],.5)

    async def test_readiness_never_promoted_by_synthetic_runtime(self):
        module=api()
        app=create_app(ApiSettings(SECRETS))
        async with app.router.lifespan_context(app):
            self.assertIsInstance(app.state.runtime_supervisor,module.RuntimeSupervisor)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=('127.0.0.1',1)),
                                         base_url='http://fixture.invalid') as client:
                ready=await client.get('/v1/health?mode=ready&capability=query-v1',
                                       headers={'authorization':'Bearer '+'q'*43})
                self.assertEqual(ready.status_code,503)
                self.assertEqual(ready.json()['provider_transport'],'not_probed')
                alive=await client.get('/v1/health')
                self.assertEqual(alive.json()['status'],'alive')
        self.assertTrue(app.state.runtime_supervisor.closed)

    async def test_bootstrap_registry_and_origins_unchanged(self):
        module=api()
        from kag.bootstrap import initialize
        from kag.common.registry import Registrable
        from kag.solver.pipeline.kag_iterative_pipeline import KAGIterativePipeline
        import inspect
        registry=Registrable._registry
        before={key:dict(value) for key,value in registry.items()}
        module.initialize_runtime()
        module.initialize_runtime()
        self.assertIs(Registrable._registry,registry)
        self.assertEqual(before,{key:dict(value) for key,value in registry.items()})
        self.assertIn('/vendor/KAG/',inspect.getfile(KAGIterativePipeline))

    async def test_exact_existing_reader_constructor_and_no_probe(self):
        module=api()
        module.initialize_runtime()
        try:
            reader=module._new_reader(self.settings(),self.release,module._Budget(time.monotonic()+25))
        except Exception as exc:
            self.fail('Existing reader constructor rejected: '+type(exc).__name__)
        self.assertEqual(reader.read_requests,0)
        self.assertEqual(reader.database,self.release.descriptor['database'])
        self.assertIsInstance(reader._opener,module._ReaderBoundary)

    async def test_real_sdk_instances_fresh_closed_no_global_cache_mutation(self):
        module=api()
        module.initialize_runtime()
        from kag.interface import VectorizeModelABC
        from kag.common.rate_limiter import RATE_LIMITER_MANGER, SYNC_RATE_LIMITER_MANAGER
        before=dict(VectorizeModelABC._instances)
        rates=[dict(manager.limiter_map) for manager in (RATE_LIMITER_MANGER,SYNC_RATE_LIMITER_MANAGER)]
        models=[]
        for _ in range(2):
            budget=module._Budget(time.monotonic()+25)
            runtime=module.RequestRuntime(None,None,None,budget.deadline,budget,QUESTION,AS_OF)
            try:
                embed=module._new_embedding(self.settings(),runtime)
                llm=module._new_llm(self.settings(),runtime)
                self.assertFalse(llm.enable_check)
                self.assertEqual(runtime.sdk_models[0].get_vector_dimensions(),3072)
                self.assertTrue(all(isinstance(model.client._client._transport,module._DeadlineTransport)
                                    for model in runtime.sdk_models))
                self.assertTrue(all(isinstance(model.aclient._client._transport,module._AsyncDeadlineTransport)
                                    for model in runtime.sdk_models))
                models.append((runtime.sdk_models[0],llm))
            finally:
                await runtime.close()
            self.assertTrue(all(model.client.is_closed() and model.aclient.is_closed()
                                for model in runtime.sdk_models))
        self.assertIsNot(models[0][0],models[1][0])
        self.assertIsNot(models[0][1],models[1][1])
        self.assertEqual(VectorizeModelABC._instances,before)
        self.assertEqual(rates,[dict(manager.limiter_map) for manager in (RATE_LIMITER_MANGER,SYNC_RATE_LIMITER_MANAGER)])

    async def test_internal_retrieve_calls_existing_retriever(self):
        module=api()
        captured=[]
        original=module.make_runtime
        def factory(*args):
            runtime=original(*args)
            captured.append(runtime)
            return runtime
        original_run=module.run_query
        async def query(runtime,question,as_of):
            items=await module.run_retrieve(runtime,question,top_k=1,expand=False)
            self.assertEqual(items[0]['source_texts']['text'],TEXT)
            return await original_run(runtime,question,as_of)
        supervisor=module.RuntimeSupervisor()
        with self.synthetic(),patch.object(module,'make_runtime',factory),patch.object(module,'run_query',query):
            result=await supervisor.query(self.request(),self.settings(),self.release)
        self.assertFalse(result.abstained)
        self.assertTrue(captured[0].closed)
        await supervisor.close()

    async def test_fake_clock_25s_timeout_rejects_late_output(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        clock=[100.0]
        original_budget=module._Budget
        def budget(deadline):
            return original_budget(deadline,clock=lambda:clock[0])
        async def operation():
            clock[0]=125.0
            return 'late result'
        with patch.object(module,'_Budget',budget),self.assertRaises(ApiFailure) as caught:
            await supervisor.supervise(operation,125.0)
        self.assertEqual(caught.exception.code,'QUERY_TIMEOUT')
        with patch.dict('os.environ',{'KAG_QUERY_TIMEOUT_SECONDS':'30'}):
            self.assertEqual(module._request_seconds(),25)
        self.assertFalse(supervisor.busy)
        await supervisor.close()

    async def test_async_sdk_guard_expired_dispatch_denied(self):
        module=api()
        calls=[]
        budget=module._Budget(time.monotonic()+25)
        async def handler(request):
            calls.append(request.extensions['timeout'])
            return httpx.Response(200,json={'synthetic':True})
        async with httpx.AsyncClient(transport=module._AsyncDeadlineTransport(httpx.MockTransport(handler),budget)) as client:
            await client.get('http://fixture.invalid')
            budget.stop()
            with self.assertRaises(ApiFailure):
                await client.get('http://fixture.invalid')
        self.assertEqual(len(calls),1)

    async def test_drain_releases_permit_for_next_operation(self):
        module=api()
        supervisor=module.RuntimeSupervisor()
        entered=asyncio.Event()
        finish=asyncio.Event()
        async def operation():
            entered.set()
            await finish.wait()
            return 'late'
        task=asyncio.create_task(supervisor.supervise(operation,time.monotonic()+.03))
        await entered.wait()
        with self.assertRaises(ApiFailure):
            await task
        self.assertTrue(supervisor.busy)
        finish.set()
        while supervisor.busy:
            await asyncio.sleep(0)
        self.assertFalse(supervisor.draining)
        async def next_operation():
            return 'safe'
        self.assertEqual(await supervisor.supervise(next_operation,time.monotonic()+25),'safe')
        await supervisor.close()

    async def test_client_cleanup_attempts_all_on_error_and_blocks_factory(self):
        module=api()
        calls=[]
        class Client:
            def close(self):
                calls.append('sync')
                raise RuntimeError('raw secret')
        class AsyncClient:
            async def close(self):
                calls.append('async')
        class Model:
            client=Client()
            aclient=AsyncClient()
        runtime=module.RequestRuntime(self.reader,None,None,time.monotonic()+25,
            module._Budget(time.monotonic()+25),QUESTION,AS_OF,[Model()])
        with self.assertRaises(ApiFailure) as caught:
            await runtime.close()
        self.assertEqual(caught.exception.code,'INTERNAL_ERROR')
        self.assertEqual(calls,['sync','async'])
        self.assertTrue(self.reader.closed)
        with self.assertRaises(ApiFailure):
            await module.run_retrieve(runtime,QUESTION)

    def real_sdk(self, *, entered=None, finish=None):
        """Real upstream methods, only HTTPX I/O replaced with SYNTHETIC replies."""
        module=api()
        original_embed, original_llm = module._new_embedding,module._new_llm
        from kag.interface.common.llm_client import CURRENT_TASK_ID, TOKEN_METER_IN_MEMORY
        self.sdk_models=[]
        self.meter_contexts=[]
        def replace_transport(model, runtime, handler):
            model.client._client.close()
            model.client._client=httpx.Client(trust_env=False,
                transport=module._DeadlineTransport(httpx.MockTransport(handler),runtime.budget))
            self.sdk_models.append(model)
        def embedding(settings,runtime):
            embed=original_embed(settings,runtime)
            def reply(request):
                return httpx.Response(200,json={'object':'list','model':'synthetic-3072',
                    'data':[{'object':'embedding','index':0,'embedding':[1.0]+[0.0]*3071}],
                    'usage':{'prompt_tokens':1,'total_tokens':1}})
            replace_transport(runtime.sdk_models[-1],runtime,reply)
            return embed
        def llm(settings,runtime):
            model=original_llm(settings,runtime)
            responses=[action('Retriever'),action('Deduce'),{
                'abstained':False,'applicability':'supported','effectivity':'supported',
                'conflict':'none','selections':[{'evidence_id':next(r.evidence_id for r in self.release.records
                    if r.entity_type.endswith('.LegalUnit') and r.field=='text'),
                    'field':'text','start':0,'end':len(TEXT)}],'support_selections':[]},action('Finish')]
            def reply(request):
                self.meter_contexts.append((CURRENT_TASK_ID.get(),TOKEN_METER_IN_MEMORY.get()))
                if entered is not None and not entered.is_set():
                    entered.set()
                    if not finish.wait(5):
                        raise AssertionError('Synthetic worker must be released')
                return httpx.Response(200,json={'id':'synthetic','object':'chat.completion',
                    'created':0,'model':'synthetic-chat','choices':[{'index':0,'finish_reason':'stop',
                        'message':{'role':'assistant','content':json.dumps(responses.pop(0),ensure_ascii=False)}}],
                    'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})
            replace_transport(model,runtime,reply)
            return model
        from contextlib import ExitStack
        stack=ExitStack()
        stack.enter_context(patch.object(module,'_new_embedding',embedding))
        stack.enter_context(patch.object(module,'_new_llm',llm))
        stack.enter_context(patch('openai._base_client.time.sleep',lambda seconds:None))
        return stack

    async def test_real_sdk_request_meters_owned_and_cleaned(self):
        module=api()
        from kag.interface.common.llm_client import (CURRENT_TASK_ID,TOKEN_METER_IN_MEMORY,TokenMeterFactory)
        factory=TokenMeterFactory()
        anchor=factory.get_meter('synthetic-existing',True)
        anchor.update(10,11,21)
        before=dict(factory.get_all_meters())
        parent_id=CURRENT_TASK_ID.set('synthetic-inherited')
        parent_memory=TOKEN_METER_IN_MEMORY.set(False)
        supervisor=module.RuntimeSupervisor()
        try:
            with self.synthetic(sdk=True),self.real_sdk():
                first=await supervisor.query(self.request(),self.settings(),self.release)
                first_contexts=list(self.meter_contexts)
                self.meter_contexts.clear()
                self.reader.closed=False
                second=await supervisor.query(self.request(),self.settings(),self.release)
                second_contexts=list(self.meter_contexts)
            self.assertFalse(first.abstained)
            self.assertEqual(first,second)
            self.assertTrue(first_contexts and second_contexts)
            self.assertTrue(all(memory is True for _,memory in first_contexts+second_contexts))
            self.assertEqual(len({identity for identity,_ in first_contexts}),1)
            self.assertEqual(len({identity for identity,_ in second_contexts}),1)
            self.assertNotEqual(first_contexts[0][0],second_contexts[0][0])
            self.assertEqual(factory.get_all_meters(),before)
            self.assertEqual(anchor.total_tokens,21)
            self.assertEqual(CURRENT_TASK_ID.get(),'synthetic-inherited')
            self.assertIs(TOKEN_METER_IN_MEMORY.get(),False)
            self.assertTrue(all(model.client.is_closed() and model.aclient.is_closed() for model in self.sdk_models))
        finally:
            await supervisor.close()
            CURRENT_TASK_ID.reset(parent_id)
            TOKEN_METER_IN_MEMORY.reset(parent_memory)
            factory.remove_meter('synthetic-existing')

    async def sdk_drain(self, cancel):
        module=api()
        from kag.interface.common.llm_client import TokenMeterFactory
        before=dict(TokenMeterFactory().get_all_meters())
        supervisor=module.RuntimeSupervisor()
        entered,finish=threading.Event(),threading.Event()
        with self.synthetic(sdk=True),self.real_sdk(entered=entered,finish=finish),patch.object(module,'REQUEST_SECONDS',2.0):
            task=asyncio.create_task(supervisor.query(self.request(),self.settings(),self.release))
            try:
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(.001)
                self.assertTrue(entered.is_set(),'SDK dispatch must actually start')
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertRaises(ApiFailure) as caught:
                        await task
                    self.assertEqual(caught.exception.code,'QUERY_TIMEOUT')
                self.assertTrue(supervisor.busy)
                self.assertTrue(supervisor.draining)
                self.assertFalse(self.reader.closed)
                self.assertTrue(all(not model.client.is_closed() for model in self.sdk_models))
                self.assertTrue(all(memory is True for _,memory in self.meter_contexts))
            finally:
                finish.set()
                await supervisor.close()
                if not task.done():
                    await asyncio.gather(task,return_exceptions=True)
        self.assertTrue(self.reader.closed)
        self.assertFalse(supervisor.busy)
        self.assertTrue(all(model.client.is_closed() and model.aclient.is_closed() for model in self.sdk_models))
        self.assertEqual(TokenMeterFactory().get_all_meters(),before)

    async def test_actual_sdk_cancel_drains_clients_and_request_meter(self):
        await self.sdk_drain(True)

    async def test_actual_sdk_timeout_drains_clients_and_request_meter(self):
        await self.sdk_drain(False)

    async def test_actual_sdk_sync_retry_cannot_dispatch_after_deadline(self):
        module=api()
        module.initialize_runtime()
        clock=[0.0]
        budget=module._Budget(25.0,clock=lambda:clock[0])
        runtime=module.RequestRuntime(None,None,None,25.0,budget,QUESTION,AS_OF)
        calls=[]
        try:
            model=module._new_llm(self.settings(),runtime)
            def reply(request):
                calls.append(request.extensions['timeout'])
                clock[0]=25.0
                return httpx.Response(500,json={'error':{'message':'synthetic retryable'}})
            model.client._client.close()
            model.client._client=httpx.Client(trust_env=False,
                transport=module._DeadlineTransport(httpx.MockTransport(reply),budget))
            from kag.interface.common.llm_client import LLMCallCcontext,TokenMeterFactory
            with LLMCallCcontext('synthetic-retry',True),patch('openai._base_client.time.sleep',lambda seconds:None):
                with self.assertRaises(Exception):
                    await asyncio.to_thread(model,'synthetic')
            TokenMeterFactory().remove_meter('synthetic-retry')
            self.assertEqual(len(calls),1)
            self.assertLessEqual(calls[0]['read'],5)
        finally:
            await runtime.close()

    async def test_actual_sdk_async_retry_cannot_dispatch_after_deadline(self):
        module=api()
        module.initialize_runtime()
        clock=[0.0]
        budget=module._Budget(25.0,clock=lambda:clock[0])
        runtime=module.RequestRuntime(None,None,None,25.0,budget,QUESTION,AS_OF)
        calls=[]
        try:
            model=module._new_llm(self.settings(),runtime)
            async def reply(request):
                calls.append(request.extensions['timeout'])
                clock[0]=25.0
                return httpx.Response(500,json={'error':{'message':'synthetic retryable'}})
            await model.aclient._client.aclose()
            model.aclient._client=httpx.AsyncClient(trust_env=False,
                transport=module._AsyncDeadlineTransport(httpx.MockTransport(reply),budget))
            from kag.interface.common.llm_client import LLMCallCcontext,TokenMeterFactory
            async def no_backoff(seconds):
                return None
            with LLMCallCcontext('synthetic-async-retry',True),patch('openai._base_client.anyio.sleep',no_backoff):
                with self.assertRaises(Exception):
                    await model.acall('synthetic')
            TokenMeterFactory().remove_meter('synthetic-async-retry')
            self.assertEqual(len(calls),1)
        finally:
            await runtime.close()

    async def test_sdk_proxy_mount_guard_cannot_bypass_deadline(self):
        module=api()
        module.initialize_runtime()
        budget=module._Budget(time.monotonic()+25)
        runtime=module.RequestRuntime(None,None,None,budget.deadline,budget,QUESTION,AS_OF)
        calls=[]
        try:
            model=module._new_llm(self.settings(),runtime)
            model.client._client.close()
            from httpx._utils import URLPattern
            transport=httpx.MockTransport(lambda request:(calls.append(True) or httpx.Response(200)))
            model.client._client=httpx.Client(trust_env=False,transport=httpx.MockTransport(
                lambda request:(_ for _ in ()).throw(AssertionError('must use mount'))),
                mounts={'http://mounted.invalid':transport})
            module._guard_sdk(model,budget)
            self.assertIsInstance(model.client._client._mounts[URLPattern('http://mounted.invalid')],
                                  module._DeadlineTransport)
            model.client._client.get('http://mounted.invalid')
            budget.stop()
            with self.assertRaises(ApiFailure):
                model.client._client.get('http://mounted.invalid')
            self.assertEqual(calls,[True])
        finally:
            await runtime.close()


class RetrieveRuntimeTests(unittest.IsolatedAsyncioTestCase):
    """Owned inspect retrieval: actual Retriever, synthetic proof and I/O only."""
    asyncTearDown = RuntimeTests.asyncTearDown
    settings = RuntimeTests.settings
    request = RuntimeTests.request
    synthetic = RuntimeTests.synthetic
    real_sdk = RuntimeTests.real_sdk

    async def asyncSetUp(self):
        await RuntimeTests.asyncSetUp(self)
        self.reader.seal(publication=False)
        from kag.http_api.artifacts import load_release
        self.release = load_release(self.root,'synthetic-release')
        self.calls = []

    def retrieve_settings(self, **changes):
        return replace(self.settings(),chat_url=None,chat_model=None,chat_key=None,
                       webapp_snapshot_id=None,**changes)

    def retrieve_request(self, token='i'*43, body=None, headers=None):
        payload = {'message':QUESTION,'schema_contract':IDENTITY}
        payload.update(body or {})
        request = self.request(token=token,raw=json.dumps(payload).encode(),headers=headers)
        request.scope['headers'] = [(k,v) for k,v in request.scope['headers']
            if k not in (b'x-webapp-snapshot-id',b'x-kag-as-of') or k.decode() in (headers or {})]
        return request

    def retrieve_synthetic(self, vector=None, sdk=False):
        module = api()
        stack = self.synthetic(sdk=sdk)
        def embedding(settings,runtime):
            self.events.append('embedding.constructor')
            self.captured_runtime = runtime
            def embed(question):
                self.calls.append(('embed',question))
                return [1.0]+[0.0]*3071 if vector is None else vector
            return embed
        if not sdk:
            stack.enter_context(patch.object(module,'_new_embedding',embedding))
        self.forbidden = []
        for target in ('kag.http_api.runtime._new_llm','kag.legal_solver.build_pipeline',
                       'kag.legal_solver.aanswer','kag.http_api.runtime.uuid4',
                       'kag.http_api.runtime._today'):
            mock = stack.enter_context(patch(target,side_effect=AssertionError('Retrieve crossed query boundary')))
            self.forbidden.append(mock)
        return stack

    async def retrieve(self, supervisor=None, request=None, settings=None, release=None):
        supervisor = supervisor or api().RuntimeSupervisor()
        self.assertTrue(callable(getattr(supervisor,'retrieve',None)),
                        'P2 owned embedding-only retrieve entrypoint missing')
        try:
            return await supervisor.retrieve(request or self.retrieve_request(),
                self.retrieve_settings() if settings is None else settings,
                self.release if release is None else release)
        finally:
            if not supervisor.busy:
                await supervisor.close()

    async def reject(self, code='NOT_READY', **kwargs):
        module = api()
        supervisor = module.RuntimeSupervisor()
        with self.retrieve_synthetic(),self.assertRaises((ApiFailure,module.RuntimeFailure)) as caught:
            await self.retrieve(supervisor,**kwargs)
        self.assertEqual(caught.exception.code,code)
        self.assertEqual(self.calls,[])
        self.assertNotIn('embedding.constructor',self.events)
        self.assertFalse(supervisor.busy)
        await supervisor.close()

    async def test_service_only_no_chat_publication_date_or_delegated_uuid(self):
        request = self.retrieve_request(headers={'x-kag-as-of':'not-a-date'})
        with self.retrieve_synthetic():
            result = await self.retrieve(request=request)
        self.assertEqual(result[0]['source_texts']['text'],TEXT)
        self.assertEqual(request.state.service_principal.service_id,'inspect')
        self.assertNotIn('delegated_user_id',request.state._state)
        self.assertIsNone(self.captured_runtime.pipeline)
        self.assertIsNone(self.captured_runtime.as_of)
        self.assertTrue(self.captured_runtime.closed)
        self.assertTrue(self.reader.closed)
        self.assertEqual(self.calls,[('embed',QUESTION)])
        self.assertTrue(all(mock.call_count==0 for mock in self.forbidden))
        for first,second in (('SYNTHETIC.proof','reader.constructor'),('backend','embedding.constructor'),
                             ('source','embedding.constructor')):
            self.assertLess(self.events.index(first),self.events.index(second))

    async def test_native_order_scores_four_targets_and_expansion_nulls(self):
        from kag.vector_contract import TARGETS
        def search(kind,prop,vector,k):
            self.calls.append(('vector',kind,prop,len(vector),k))
            self.assertEqual(vector,[1.0]+[0.0]*3071)
            return [{'id':'unit-1','score':0.9,'index':'native-index'}] if kind=='LegalUnit' else []
        def expand(keys,predicates,limit):
            self.calls.append(('expand',keys,limit))
            return [self.reader.relation]
        with self.retrieve_synthetic(),patch.object(self.reader,'vector_search',search),patch.object(self.reader,'expand',expand):
            result = await self.retrieve(request=self.retrieve_request(body={'top_k':1,'expand':True}))
        self.assertEqual([(r['entity_id'],r['score']) for r in result],[('unit-1',0.9),('document-1',None)])
        self.assertEqual(result[0]['vector_sources'],[{'property':'text','score':0.9,'index':'native-index'}])
        self.assertEqual(result[1]['vector_sources'],[])
        self.assertEqual(result[0]['graph_context'],[self.reader.relation])
        self.assertEqual([c[1:3] for c in self.calls if c[0]=='vector'],
                         [(kind,prop) for kind,targets in TARGETS.items() for prop,_ in targets])
        self.assertTrue(all(c[3:]==(3072,10) for c in self.calls if c[0]=='vector'))
        self.assertEqual(self.calls[-1],('expand',[['VietRoadTraffic.LegalUnit','unit-1']],50))
        self.assertEqual(sum(c[0]=='embed' for c in self.calls),1)
        self.assertTrue(all(mock.call_count==0 for mock in self.forbidden))

    async def test_empty_native_retrieval_preserved(self):
        with self.retrieve_synthetic(),patch.object(self.reader,'vector_search',return_value=[]) as search:
            self.assertEqual(await self.retrieve(),[])
        self.assertEqual(search.call_count,4)
        self.assertEqual(self.calls,[('embed',QUESTION)])
        self.assertTrue(self.reader.closed)

    async def test_query_credential_cannot_retrieve(self):
        await self.reject('SCOPE_DENIED',request=self.retrieve_request(token='q'*43))

    async def test_missing_auth_cannot_retrieve(self):
        await self.reject('AUTH_INVALID',request=self.retrieve_request(token=''))

    async def test_delegated_body_and_identity_header_rejected(self):
        for request in (self.retrieve_request(body={'user_id':USER}),
                        self.retrieve_request(headers={'x-user-id':USER})):
            with self.subTest(request=request):
                await self.reject('INVALID_REQUEST',request=request)

    async def test_query_parameters_cannot_control_runtime(self):
        request = self.retrieve_request()
        request.scope['query_string'] = b'capability=query'
        await self.reject('INVALID_REQUEST',request=request)

    async def test_wrong_schema_before_reader_and_embedding(self):
        await self.reject('SCHEMA_CONTRACT_MISMATCH',request=self.retrieve_request(
            body={'schema_contract':{**IDENTITY,'schema_sha256':'a'*64}}))
        self.assertNotIn('reader.constructor',self.events)

    async def test_wrong_release_before_reader_and_embedding(self):
        await self.reject('RELEASE_MISMATCH',settings=self.retrieve_settings(release_id='foreign'))
        self.assertNotIn('reader.constructor',self.events)

    async def test_missing_release_header_before_reader_and_embedding(self):
        request = self.retrieve_request()
        request.scope['headers'] = [(k,v) for k,v in request.scope['headers'] if k!=b'x-kag-release-id']
        await self.reject('RELEASE_MISMATCH',request=request)
        self.assertNotIn('reader.constructor',self.events)

    async def test_wrong_release_header_before_reader_and_embedding(self):
        await self.reject('RELEASE_MISMATCH',request=self.retrieve_request(headers={'x-kag-release-id':'foreign'}))
        self.assertNotIn('reader.constructor',self.events)

    async def test_duplicate_release_header_before_reader_and_embedding(self):
        request = self.retrieve_request()
        request.scope['headers'].append((b'x-kag-release-id',b'synthetic-release'))
        await self.reject('RELEASE_MISMATCH',request=request)
        self.assertNotIn('reader.constructor',self.events)

    async def test_wrong_source_snapshot_before_reader_and_embedding(self):
        await self.reject('SOURCE_SNAPSHOT_MISMATCH',settings=self.retrieve_settings(source_snapshot_id='foreign'))
        self.assertNotIn('reader.constructor',self.events)

    async def test_missing_release_denied(self):
        module = api()
        supervisor = module.RuntimeSupervisor()
        self.assertTrue(callable(getattr(supervisor,'retrieve',None)),'P2 owned retrieve missing')
        with self.retrieve_synthetic(),self.assertRaises(ApiFailure) as caught:
            await supervisor.retrieve(self.retrieve_request(),self.retrieve_settings(),None)
        self.assertEqual(caught.exception.code,'NOT_READY')
        self.assertEqual(self.calls,[])
        await supervisor.close()

    async def test_missing_reader_or_embedding_configuration_denied(self):
        for field in ('reader_username','reader_password','embedding_url','embedding_model','embedding_key'):
            with self.subTest(field=field):
                await self.reject(settings=self.retrieve_settings(**{field:None}))
        self.assertNotIn('reader.constructor',self.events)

    async def test_invalid_embedding_configuration_denied(self):
        for changes in ({'embedding_key':'dummy'},{'embedding_url':'http://user:secret@fixture.invalid'},
                        {'embedding_url':'not a url'},{'embedding_model':''}):
            with self.subTest(changes=changes):
                await self.reject(settings=self.retrieve_settings(**changes))

    async def test_artifact_drift_before_work_denied(self):
        (self.root/'source-catalog.json').write_bytes(b'{}')
        await self.reject()
        self.assertNotIn('reader.constructor',self.events)

    async def test_default_operational_proof_still_denies(self):
        module = api()
        supervisor = module.RuntimeSupervisor()
        self.assertTrue(callable(getattr(supervisor,'retrieve',None)),'P2 owned retrieve missing')
        with patch.object(module,'_new_reader') as constructor,self.assertRaises(ApiFailure) as caught:
            await supervisor.retrieve(self.retrieve_request(),self.retrieve_settings(),self.release)
        self.assertEqual(caught.exception.code,'NOT_READY')
        constructor.assert_not_called()
        self.assertFalse(supervisor.live_ready)
        await supervisor.close()

    async def test_backend_physical_identity_denied_before_embedding(self):
        self.reader.metadata['databaseID'] = 'foreign'
        await self.reject('SOURCE_VALIDATION_FAILED')
        self.assertTrue(self.reader.closed)

    async def test_vector_index_identity_denied_before_embedding(self):
        self.reader.vector_indexes[0]['options']['indexConfig']['vector.dimensions'] = 1536
        await self.reject('SOURCE_VALIDATION_FAILED')
        self.assertTrue(self.reader.closed)

    async def test_source_readback_denied_before_embedding(self):
        self.reader.nodes[('VietRoadTraffic.LegalUnit','unit-1')]['properties']['text'] = 'changed'
        await self.reject('SOURCE_VALIDATION_FAILED')
        self.assertTrue(self.reader.closed)

    async def test_unavailable_read_capability_denied_before_embedding(self):
        with patch.object(self.reader,'read_nodes',side_effect=OSError('private endpoint')):
            await self.reject()
        self.assertTrue(self.reader.closed)

    async def post_drift(self, change, code):
        module = api()
        original = self.reader.vector_search
        def search(*args):
            rows = original(*args)
            change()
            return rows
        with self.retrieve_synthetic(),patch.object(self.reader,'vector_search',search),self.assertRaises(
                (ApiFailure,module.RuntimeFailure)) as caught:
            await self.retrieve()
        self.assertEqual(caught.exception.code,code)
        self.assertEqual(self.calls,[('embed',QUESTION)])
        self.assertTrue(self.reader.closed)

    async def test_artifact_drift_after_work_rejects_output(self):
        await self.post_drift(lambda:(self.root/'source-catalog.json').write_bytes(b'{}'),'NOT_READY')

    async def test_backend_drift_after_work_rejects_output(self):
        await self.post_drift(lambda:self.reader.metadata.update(databaseID='foreign'),'SOURCE_VALIDATION_FAILED')

    async def test_index_drift_after_work_rejects_output(self):
        await self.post_drift(lambda:self.reader.vector_indexes[0].update(state='POPULATING'),'SOURCE_VALIDATION_FAILED')

    async def test_source_drift_after_work_rejects_output(self):
        await self.post_drift(lambda:self.reader.nodes[('VietRoadTraffic.LegalUnit','unit-1')]['properties'].update(
            text='changed'),'SOURCE_VALIDATION_FAILED')

    async def test_invalid_vectors_fail_native_contract_and_cleanup(self):
        module = api()
        for vector in ([],[1.0]*1536,[0.0]*3072,[float('nan')]+[0.0]*3071,
                       [float('inf')]+[0.0]*3071,'unsupported'):
            with self.subTest(vector_type=type(vector).__name__,length=len(vector)):
                self.reader.closed = False
                with self.retrieve_synthetic(vector=vector),self.assertRaises(module.RuntimeFailure) as caught:
                    await self.retrieve()
                self.assertEqual(caught.exception.code,'PROVIDER_ERROR')
                self.assertTrue(self.reader.closed)
                self.assertTrue(self.captured_runtime.closed)

    async def test_invalid_vector_rows_fail_native_contract(self):
        module = api()
        for rows in ([{'id':'unit-1','score':float('nan')}],['unsupported'],[{'id':'unit-1','score':2}]):
            with self.subTest(rows=rows):
                with self.retrieve_synthetic(),patch.object(self.reader,'vector_search',return_value=rows),self.assertRaises(
                        module.RuntimeFailure) as caught:
                    await self.retrieve()
                self.assertEqual(caught.exception.code,'PROVIDER_ERROR')
                self.assertTrue(self.reader.closed)

    async def test_query_still_requires_chat_configuration(self):
        module = api()
        supervisor = module.RuntimeSupervisor()
        with self.synthetic(),self.assertRaises(ApiFailure) as caught:
            await supervisor.query(self.request(),self.retrieve_settings(),self.release)
        self.assertEqual(caught.exception.code,'NOT_READY')
        self.assertNotIn('reader.constructor',self.events)
        await supervisor.close()

    async def test_retrieve_cleanup_failure_closes_supervisor(self):
        module = api()
        supervisor = module.RuntimeSupervisor()
        def close():
            self.events.append('reader.close.failed')
            raise OSError('raw private detail')
        with self.retrieve_synthetic(),patch.object(self.reader,'close',close),self.assertRaises(ApiFailure) as caught:
            await self.retrieve(supervisor)
        self.assertEqual(caught.exception.code,'INTERNAL_ERROR')
        self.assertTrue(supervisor.closed)
        self.assertFalse(supervisor.busy)

    async def drain(self, cancel=False, shutdown=False):
        module = api()
        supervisor = module.RuntimeSupervisor()
        self.assertTrue(callable(getattr(supervisor,'retrieve',None)),'P2 owned retrieve missing')
        entered,finish = threading.Event(),threading.Event()
        original = self.reader.vector_search
        def search(*args):
            entered.set()
            if not finish.wait(5):
                raise AssertionError('Synthetic retrieve worker must be released')
            return original(*args)
        with self.retrieve_synthetic(sdk=True),self.real_sdk(),patch.object(self.reader,'vector_search',search),patch.object(
                module,'REQUEST_SECONDS',1.0):
            task = asyncio.create_task(supervisor.retrieve(self.retrieve_request(),self.retrieve_settings(),self.release))
            closing = None
            try:
                while not entered.is_set() and not task.done():
                    await asyncio.sleep(.001)
                if task.done() and not entered.is_set():
                    await task
                self.assertTrue(entered.is_set(),'Actual Retriever worker must start')
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                elif shutdown:
                    closing = asyncio.create_task(supervisor.close())
                    await asyncio.sleep(0)
                    self.assertFalse(closing.done())
                else:
                    with self.assertRaises(ApiFailure) as caught:
                        await task
                    self.assertEqual(caught.exception.code,'QUERY_TIMEOUT')
                self.assertTrue(supervisor.busy)
                self.assertFalse(self.reader.closed)
                self.assertTrue(all(not model.client.is_closed() for model in self.sdk_models))
                if not shutdown:
                    self.assertTrue(supervisor.draining)
                    with patch.object(module,'_today',lambda:AS_OF),self.assertRaises(module.RuntimeFailure) as caught:
                        await supervisor.query(self.request(),self.settings(),self.release)
                    self.assertEqual(caught.exception.code,'CONCURRENCY_LIMIT')
                    with self.assertRaises(module.RuntimeFailure):
                        await supervisor.retrieve(self.retrieve_request(),self.retrieve_settings(),self.release)
            finally:
                finish.set()
                await supervisor.close()
                await asyncio.gather(task,return_exceptions=True)
                if closing is not None:
                    await closing
        self.assertFalse(supervisor.busy)
        self.assertTrue(self.reader.closed)
        self.assertTrue(all(model.client.is_closed() and model.aclient.is_closed() for model in self.sdk_models))
        self.assertEqual(len(self.sdk_models),1)
        self.assertEqual(self.meter_contexts,[])

    async def test_retrieve_timeout_retains_slot_and_real_sdk_until_worker_drains(self):
        await self.drain()

    async def test_retrieve_cancel_retains_slot_and_real_sdk_until_worker_drains(self):
        await self.drain(cancel=True)

    async def test_retrieve_shutdown_waits_for_actual_worker(self):
        await self.drain(shutdown=True)

    async def test_active_query_blocks_owned_retrieve_before_constructors(self):
        module = api()
        supervisor = module.RuntimeSupervisor()
        started,finish = asyncio.Event(),asyncio.Event()
        original = module.run_query
        async def run(*args):
            started.set()
            await finish.wait()
            return await original(*args)
        self.reader.descriptor['webapp_snapshot_id'] = 'synthetic-webapp'
        self.reader.seal()
        from kag.http_api.artifacts import load_release
        release = load_release(self.root,'synthetic-release')
        self.assertTrue(callable(getattr(supervisor,'retrieve',None)),'P2 owned retrieve missing')
        with self.synthetic(),patch.object(module,'run_query',run):
            task = asyncio.create_task(supervisor.query(self.request(),self.settings(),release))
            try:
                await started.wait()
                before = list(self.events)
                with self.assertRaises(module.RuntimeFailure) as caught:
                    await supervisor.retrieve(self.retrieve_request(),self.retrieve_settings(),release)
                self.assertEqual(caught.exception.code,'CONCURRENCY_LIMIT')
                self.assertEqual(self.events,before)
            finally:
                finish.set()
                result = await task
                await supervisor.close()
        self.assertFalse(result.abstained)
