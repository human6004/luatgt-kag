"""Offline provider gateway and exact query cache trust-boundary checks."""
import asyncio
import hashlib
import importlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from dataclasses import replace
from unittest.mock import patch
import unittest
import httpx


class SampleQueryTests(unittest.TestCase):
    def setUp(self):
        self.module = importlib.import_module('kag.http_api.sample_query')
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'attempts.json'

    def budget(self, **kwargs):
        from kag.http_api.provider_budget import ProviderBudget
        return ProviderBudget(self.path,embedding_url='https://api.vilao.ai/v1/embeddings',
            embedding_model='dg/text-embedding-3-large',chat_url='http://127.0.0.1:8317/v1/chat/completions',
            chat_model='gemini-3.8-flash-high',limits={'embedding':3,'chat':7},**kwargs)

    def test_extended_chat_cap_preserves_counts_and_embedding_cap(self):
        budget=self.budget()
        self.assertEqual([budget.reserve('chat') for _ in range(7)],list(range(1,8)))
        with self.assertRaises(Exception):budget.reserve('chat')
        self.assertEqual([budget.reserve('embedding') for _ in range(3)],[1,2,3])
        with self.assertRaises(Exception):budget.reserve('embedding')
        self.assertEqual(self.budget().counts(),{'embedding':3,'chat':7})

    def test_bound_file_write_keeps_inode_and_corruption_denies(self):
        budget=self.budget();budget.counts()
        inode=self.path.stat().st_ino
        bound=self.budget(in_place=True);bound.reserve('chat')
        self.assertEqual(self.path.stat().st_ino,inode)
        self.path.write_text('{broken',encoding='utf-8')
        with self.assertRaises(Exception):bound.reserve('chat')
        self.assertEqual(self.path.read_text(),'{broken')

    def test_unapproved_limits_deny(self):
        from kag.http_api.provider_budget import ProviderBudget
        for limits in ({'embedding':4,'chat':7},{'embedding':3,'chat':8},{'embedding':True,'chat':7}):
            with self.assertRaises(Exception):ProviderBudget(self.path,embedding_url='https://a/embeddings',
                embedding_model='a',chat_url='https://b/chat/completions',chat_model='b',limits=limits)

    def test_response_version_requires_applied_test_or_pinned_route_and_arbitrary_echo_denies(self):
        from types import SimpleNamespace
        route=dict(schema='h1-proxy-routing-1.0',requested_model=self.module.CHAT_MODEL,
            response_version='gemini-3.8-flash-n',upstream='https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
            proxy_binary_sha256='b'*64,proxy_config_sha256='c'*64,trace_sha256='d'*64,
            source_commit='1370789ee9bdc15b6f320499d24c0d37ca1889cf',exact_backend_identity_verified=False,
            identity_scope='REQUEST_ROUTE_AND_RESPONSE_VERSION')
        settings=SimpleNamespace(chat_model=self.module.CHAT_MODEL,development_policy=None)
        self.assertFalse(self.module.response_model_matches(settings,'gemini-3.8-flash-n'))
        settings.development_policy={'model_route':route}
        self.assertTrue(self.module.response_model_matches(settings,'gemini-3.8-flash-n'))
        self.assertFalse(self.module.response_model_matches(settings,'arbitrary'))
        route['requested_model']='other'
        with self.assertRaises(Exception):self.module.response_model_matches(settings,'gemini-3.8-flash-n')
        settings.development_policy=None
        settings.chat_response_model='tested-response-model'
        self.assertTrue(self.module.response_model_matches(settings,'tested-response-model'))
        self.assertFalse(self.module.response_model_matches(settings,'arbitrary'))

    def test_development_unlimited_preserves_consumed_ledger_and_binding(self):
        old=self.budget();old.reserve('embedding');old.reserve('chat')
        from kag.http_api.provider_budget import ProviderBudget
        options=dict(embedding_url=str(old.providers['embedding'][0]),embedding_model=old.providers['embedding'][1],
            chat_url=str(old.providers['chat'][0]),chat_model=old.providers['chat'][1],limits={'embedding':None,'chat':None})
        with self.assertRaises(Exception):ProviderBudget(self.path,**options)
        budget=ProviderBudget(self.path,development_only=True,**options)
        self.assertEqual(budget.binding,old.binding)
        self.assertEqual(budget.counts(),{'embedding':1,'chat':1})
        for kind in ('chat','embedding'):
            self.assertEqual([budget.reserve(kind) for _ in range(8)],list(range(2,10)))
        self.assertEqual(budget.counts(),{'embedding':9,'chat':9})
        self.path.unlink()
        with self.assertRaises(Exception):budget.counts()

    def test_gateway_sync_and_async_rewrite_after_budget_guard(self):
        budget=self.budget();seen=[]
        def send(request):
            seen.append((str(request.url),request.headers['x-kag-provider-token'],budget.counts()['chat']))
            return httpx.Response(200,json={'ok':True})
        url=budget.providers['chat'][0]
        guard=budget.guard_sync('chat',self.module.GatewayTransport(httpx.MockTransport(send),
            'http://kag-ingress:8898/v1','fixture-token',str(url)))
        guard.handle_request(httpx.Request('POST',url,json={'model':'gemini-3.8-flash-high'}))
        async def run():
            guard=budget.guard_async('chat',self.module.AsyncGatewayTransport(httpx.MockTransport(send),
                'http://kag-ingress:8898/v1','fixture-token',str(url)))
            await guard.handle_async_request(httpx.Request('POST',url,json={'model':'gemini-3.8-flash-high'}))
        asyncio.run(run())
        self.assertEqual(seen,[('http://kag-ingress:8898/v1/chat/completions','fixture-token',1),
                               ('http://kag-ingress:8898/v1/chat/completions','fixture-token',2)])

    def test_gateway_rejects_arbitrary_url_before_transport(self):
        seen=[]
        transport=self.module.GatewayTransport(httpx.MockTransport(lambda r:seen.append(r)),
            'http://kag-ingress:8898/v1','fixture-token','http://127.0.0.1:8317/v1/chat/completions')
        for url in ('https://evil.invalid/v1/chat/completions','http://127.0.0.1:8317/v1/chat/completions?q=x'):
            with self.assertRaises(Exception):transport.handle_request(httpx.Request('POST',url))
        self.assertEqual(seen,[])

    def test_exact_cache_hash_model_and_vector_are_required(self):
        vector=[0.1]*3072
        raw=json.dumps(dict(question='exact',question_sha256=hashlib.sha256(b'exact').hexdigest(),
            model='dg/text-embedding-3-large',endpoint='https://api.vilao.ai/v1',dimension=3072,vector=vector),
            separators=(',',':')).encode()
        cache=self.module.load_cache(raw,hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.module.cached_vector(cache,'exact'),vector)
        self.assertIsNone(self.module.cached_vector(cache,'different'))
        for invalid in (raw.replace(b'"exact"',b'"wrong"',1),raw.replace(b'0.1',b'NaN',1),
                        raw.replace(b'dg/text-embedding-3-large',b'other')):
            with self.assertRaises(Exception):self.module.load_cache(invalid,hashlib.sha256(invalid).hexdigest())
        with self.assertRaises(Exception):self.module.load_cache(raw,'0'*64)
        selected=raw.replace(b'dg/text-embedding-3-large',b'emb/text-embedding-3-large')
        selected_hash=hashlib.sha256(selected).hexdigest()
        with self.assertRaises(Exception):self.module.load_cache(selected,selected_hash)
        cache=self.module.load_cache(selected,selected_hash,model='emb/text-embedding-3-large')
        self.assertEqual(cache['model'],'emb/text-embedding-3-large')
        self.assertEqual(cache['vector'],vector)


class SampleQueryProofTests(unittest.TestCase):
    def budget(self,**kwargs):return SampleQueryTests.budget(self,**kwargs)
    def setUp(self):
        SampleQueryTests.setUp(self)
        from test_sample_serving import SampleFixture,SECRETS
        from kag.http_api import artifacts,runtime
        root=Path(self.temp.name)/'release';root.mkdir()
        self.fx=SampleFixture(root,model_identity=self.module.EMBEDDING_URL+'|'+self.module.EMBEDDING_MODEL)
        self.fx.descriptor['webapp_snapshot_id']='synthetic-webapp'
        self.fx.seal(publication=True)
        self.fx.release=artifacts.load_release(self.fx.root,'synthetic-release')
        sample={k:v for k,v in self.fx.proof.items() if k not in ('reader_username','reader_privileges_verified')}
        sample.update(schema='h1-community-sample-1.0',release_descriptor_sha256=self.fx.release.descriptor_sha256,
            broker_url='http://openspg-server:8899',broker_code_sha256='b'*64,isolation=dict(neo4j_ip='172.20.0.2',
            server_ip='172.20.0.3',api_has_database_credentials=False,api_has_docker_socket=False,
            api_container_id='a'*64,server_container_id='c'*64,neo4j_container_id='d'*64,
            read_network_id='e'*64,database_network_id='f'*64))
        raw=json.dumps(sample).encode();(self.fx.root/'sample-serving.json').write_bytes(raw);sample_pin=hashlib.sha256(raw).hexdigest()
        cache=json.dumps(dict(question='exact',question_sha256=hashlib.sha256(b'exact').hexdigest(),
            model=self.module.EMBEDDING_MODEL,endpoint=self.module.EMBEDDING_URL,dimension=3072,vector=[.1]*3072)).encode()
        (self.fx.root/'query-embedding.json').write_bytes(cache);(self.fx.root/'provider-gateway.cfg').write_bytes(b'offline-fixture')
        self.settings=runtime.RuntimeSettings(secrets=SECRETS,release_id='synthetic-release',source_snapshot_id='synthetic-source',
            webapp_snapshot_id='synthetic-webapp',embedding_url=self.module.EMBEDDING_URL,embedding_model=self.module.EMBEDDING_MODEL,
            embedding_key='offline-embedding',chat_url=self.module.CHAT_URL,chat_model=self.module.CHAT_MODEL,chat_key='offline-chat',
            sample_proof_sha256=sample_pin,broker_url=sample['broker_url'],broker_token='b'*43,query_proof_sha256='0'*64,
            provider_gateway=self.module.GATEWAY,provider_gateway_token='t'*43,attempt_ledger='/provider-state/attempts.json')
        self.proof=dict(self.fx.binding,schema='h1-community-query-1.0',release_descriptor_sha256=self.fx.release.descriptor_sha256,
            sample_proof_sha256=sample_pin,cache_sha256=hashlib.sha256(cache).hexdigest(),ledger_binding_sha256=self.budget().binding,
            limits=self.module.LIMITS,gateway_ip='172.20.0.4',gateway_token_sha256=hashlib.sha256(('t'*43).encode()).hexdigest(),
            gateway_config_sha256=hashlib.sha256(b'offline-fixture').hexdigest())
        self.seal()
        self.guard=patch.object(self.module,'provider_budget',side_effect=lambda settings:self.budget())
        self.guard.start();self.addCleanup(self.guard.stop)

    def seal(self):
        raw=json.dumps(self.proof).encode();(self.fx.root/'sample-query.json').write_bytes(raw)
        self.settings=replace(self.settings,query_proof_sha256=hashlib.sha256(raw).hexdigest())

    def load(self,settings=None,release=None,capability='query'):
        return self.module.load_proof(settings or self.settings,release or self.fx.release,capability=capability)

    def test_positive_proof_and_budget_exhaustion_retrieval_stays_independent(self):
        proof,cache,budget=self.load();self.assertEqual(cache['question'],'exact')
        for _ in range(4):budget.reserve('chat')
        with self.assertRaises(Exception):self.load()
        self.assertEqual(self.load(capability='retrieve')[2].counts()['chat'],4)

    def test_embedding_consumer_identity_matches_sealed_vector_provenance(self):
        from kag.http_api import artifacts
        identity=self.settings.embedding_url+'|'+self.settings.embedding_model
        artifacts._verify_sample_provenance(self.fx.root,model_identity=identity)
        with self.assertRaises(artifacts.ArtifactFailure):
            artifacts._verify_sample_provenance(self.fx.root,model_identity=identity+'-different-model')
        self.assertEqual(self.budget().counts(),{'embedding':0,'chat':0})

    def test_identity_fingerprint_caps_and_pins_deny_before_provider(self):
        for key,value in (('database_id','other'),('release_descriptor_sha256','0'*64),('graph_fingerprint','0'*64),
                ('cache_sha256','0'*64),('limits',{'embedding':3,'chat':8}),('gateway_ip','0.0.0.0'),
                ('gateway_token_sha256','0'*64),('gateway_config_sha256','0'*64),('ledger_binding_sha256','0'*64)):
            with self.subTest(key=key):
                original=self.proof[key];self.proof[key]=value;self.seal()
                with self.assertRaises(Exception):self.load()
                self.proof[key]=original;self.seal()
        self.assertEqual(self.budget().counts(),{'embedding':0,'chat':0})

    def test_production_missing_publication_wrong_model_or_direct_db_denied(self):
        for settings in (replace(self.settings,chat_model='other'),replace(self.settings,reader_username='neo4j'),
                         replace(self.settings,attempt_ledger='/tmp/reset.json'),
                         replace(self.settings,provider_gateway='http://other-gateway:8898/v1'),
                         replace(self.settings,provider_gateway_token='x'*43)):
            with self.assertRaises(Exception):self.load(settings=settings)
        for release in (replace(self.fx.release,release_kind='PRODUCTION'),replace(self.fx.release,publication=None)):
            with self.assertRaises(Exception):self.load(release=release)

    def test_pinned_development_policy_only_allows_sample_and_retained_counts(self):
        from kag.http_api.provider_budget import ProviderBudget
        self.guard.stop()
        self.settings=replace(self.settings,development_policy=dict(schema='h1-sample-development-policy-1.0',
            scope='SAMPLE_DEVELOPMENT',authorization_sha256='a'*64,baseline_attempts={'embedding':0,'chat':0}))
        self.proof.update(schema='h1-community-query-2.0',limits={'embedding':None,'chat':None},
                          development_policy=self.settings.development_policy)
        self.seal()
        with patch.object(self.module,'provider_budget',side_effect=lambda settings:ProviderBudget(self.path,
                embedding_url=self.module.EMBEDDING_URL+'/embeddings',embedding_model=self.module.EMBEDDING_MODEL,
                chat_url=self.module.CHAT_URL+'/chat/completions',chat_model=self.module.CHAT_MODEL,
                limits={'embedding':None,'chat':None},development_only=True)):
            proof,_,budget=self.load()
            for _ in range(8):budget.reserve('chat')
            self.assertEqual(self.load()[2].counts()['chat'],8)
            with self.assertRaises(Exception):self.load(release=replace(self.fx.release,release_kind='PRODUCTION'))
            with self.assertRaises(Exception):self.load(settings=replace(self.settings,development_policy=None))
            self.proof['development_policy']['baseline_attempts']['chat']=9;self.seal()
            with self.assertRaises(Exception):self.load()

    def test_gateway_metadata_auth_model_failure_and_ip_change_without_rebind(self):
        proof,_,_=self.load()
        retained_proof=(self.fx.root/'sample-query.json').read_bytes()
        retained_pin=self.settings.query_proof_sha256
        def response(status=200,model=self.module.CHAT_MODEL):return httpx.Response(status,json={'data':[{'id':model}]})
        def exercise(reply,ip='172.20.0.4'):
            def send(request):
                self.assertEqual(str(request.url),'http://kag-ingress:8898/v1/models')
                self.assertEqual(request.headers['X-KAG-Provider-Token'],'t'*43)
                self.assertEqual(request.headers['Authorization'],'Bearer offline-chat')
                return reply
            client=httpx.Client(transport=httpx.MockTransport(send),trust_env=False)
            with patch.object(self.module.socket,'gethostbyname',return_value=ip),patch.object(self.module.httpx,'Client',return_value=client):
                return self.module.verify_gateway(self.settings,proof)
        exercise(response())
        exercise(response(),ip='172.20.0.9')
        self.assertEqual((self.fx.root/'sample-query.json').read_bytes(),retained_proof)
        self.assertEqual(self.settings.query_proof_sha256,retained_pin)
        for reply,ip in ((response(401),'172.20.0.9'),(response(403),'172.20.0.9'),
                         (response(model='other'),'172.20.0.9'),(response(),'8.8.8.8')):
            with self.assertRaises(Exception):exercise(reply,ip)
        self.assertEqual(self.budget().counts(),{'embedding':0,'chat':0})

    def test_busy_readiness_returns_capacity_error_without_provider_calls(self):
        from kag.http_api import runtime
        from kag.http_api.app import create_app,ApiSettings
        from test_sample_serving import SECRETS
        async def exercise():
            app=create_app(ApiSettings(SECRETS),enable_sample_routes=True)
            app.state.serving_release=self.fx.release
            app.state.runtime_settings=self.settings
            supervisor=runtime.RuntimeSupervisor()
            supervisor._task=object()
            app.state.runtime_supervisor=supervisor
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture.invalid') as client:
                for capability,token in (('query-v1','q'),('retrieve','i'),('retrieve-vector','i')):
                    response=await client.get('/v1/health?mode=ready&capability='+capability,
                        headers={'Authorization':'Bearer '+token*43,'X-KAG-Release-ID':'synthetic-release'})
                    self.assertEqual(response.status_code,429,response.text)
                    self.assertEqual(response.json()['error']['code'],'CONCURRENCY_LIMIT')
                    self.assertEqual(response.headers['Retry-After'],'1')
            self.assertEqual(self.budget().counts(),{'embedding':0,'chat':0})
        asyncio.run(exercise())

    def test_real_iterative_sdk_api_query_uses_four_calls_and_exact_cache(self):
        from kag.http_api import artifacts,runtime
        from kag.http_api.app import create_app,ApiSettings
        from kag.http_api.security import ServiceSecrets
        from kag.verify import verify_graph
        from test_artifacts import AS_OF,IDENTITY
        from fixtures import USER
        question='Nguồn?'
        cache=json.loads((self.fx.root/'query-embedding.json').read_bytes())
        cache.update(question=question,question_sha256=hashlib.sha256(question.encode()).hexdigest())
        raw=json.dumps(cache).encode();(self.fx.root/'query-embedding.json').write_bytes(raw)
        self.proof['cache_sha256']=hashlib.sha256(raw).hexdigest();self.seal()
        source=next(r for r in self.fx.release.records if r.entity_type.endswith('.LegalUnit'))
        responses=[{'executor':{'name':name,'arguments':{} if name=='Finish' else {'query':question},'thought':'offline'}}
                   for name in ('Retriever','Deduce')]
        responses.append(dict(abstained=False,applicability='supported',effectivity='supported',conflict='none',
            selections=[dict(evidence_id=source.evidence_id,field='text',start=0,end=len(source.source_text))],support_selections=[]))
        responses.append({'executor':{'name':'Finish','arguments':{},'thought':'offline'}})
        seen=[]
        wrong_model=[True]
        def reply(request):
            self.assertEqual(str(request.url),self.module.GATEWAY+'/chat/completions')
            self.assertEqual(request.headers['x-kag-provider-token'],'t'*43)
            body=json.loads(request.content);self.assertEqual(body['model'],self.module.CHAT_MODEL)
            seen.append(self.budget().counts()['chat'])
            mismatch=wrong_model.pop() if wrong_model else False
            return httpx.Response(200,json=dict(id='offline',object='chat.completion',created=0,model='wrong-model' if mismatch else self.module.CHAT_MODEL,
                choices=[dict(index=0,message=dict(role='assistant',content=json.dumps(responses[0] if mismatch else responses.pop(0),ensure_ascii=False)),finish_reason='stop')],
                usage=dict(prompt_tokens=1,completion_tokens=1,total_tokens=2)))
        def integrity(release,pin,user,reader):
            self.assertIs(reader,self.fx)
            artifacts.load_sample_proof(release,pin,None)
            artifacts._backend(reader,release);artifacts._readback(reader,release.records,artifacts._json(release.contract_bytes))
            result=verify_graph(reader,db_path=self.fx.root/'expected.sqlite3',contract=artifacts._json(release.contract_bytes),batch_size=32)
            self.assertEqual(result['fingerprint'],release.descriptor['graph_fingerprint'])
        app=create_app(ApiSettings(self.settings.secrets),enable_sample_routes=True)
        app.state.serving_release=self.fx.release;app.state.runtime_settings=self.settings
        app.state.runtime_supervisor=runtime.RuntimeSupervisor()
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture.invalid') as client:
                headers={'authorization':'Bearer '+'q'*43,'x-kag-release-id':'synthetic-release',
                    'x-webapp-snapshot-id':'synthetic-webapp','x-kag-as-of':AS_OF.isoformat()}
                ready=await client.get('/v1/health?mode=ready&capability=query-v1',headers=headers)
                self.assertEqual(ready.status_code,200,ready.text)
                self.assertEqual(ready.json()['checks'],dict(auth='pass',runtime='pass',sources='pass',admission='pass'))
                denied=await client.post('/v1/query',headers=headers,json=dict(message=question,user_id=USER,context_id='',schema_contract=IDENTITY))
                self.assertEqual(denied.status_code,502,denied.text)
                self.assertEqual(denied.json()['error']['code'],'PROVIDER_ERROR')
                self.assertEqual(seen,[1])
                response=await client.post('/v1/query',headers=headers,json=dict(message=question,user_id=USER,context_id='',schema_contract=IDENTITY))
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.json()['citations'][0]['quote'],source.source_text)
                self.assertEqual(response.json()['answer'],'Căn cứ nguồn đã xác nhận:\n'+source.source_text)
                ready=await client.get('/v1/health?mode=ready&capability=query-v1',headers=headers)
                self.assertEqual(ready.status_code,503,ready.text)
                self.assertEqual(ready.json()['checks']['runtime'],'blocked')
        with patch.object(runtime,'_today',return_value=AS_OF),patch.object(runtime,'_new_reader',return_value=self.fx), \
             patch.object(runtime,'verify_sample_backend',side_effect=integrity), \
             patch.object(self.module,'verify_gateway'), \
             patch.object(self.module.httpx,'HTTPTransport',side_effect=lambda **kw:httpx.MockTransport(reply)), \
             patch.object(self.module.httpx,'AsyncHTTPTransport',side_effect=lambda **kw:httpx.MockTransport(reply)), \
             patch.object(runtime,'_new_embedding',side_effect=AssertionError('Exact cached query must not embed')):
            asyncio.run(exercise())
        self.assertEqual(seen,[1,2,3,4]);self.assertEqual(self.budget().counts(),{'embedding':0,'chat':4})
        metadata=json.loads(Path('/tmp/sample-provider-responses.json').read_bytes())
        self.assertTrue(metadata)
        self.assertTrue(all('content' not in row for row in metadata))
        self.assertTrue(self.fx.closed)


if __name__=='__main__':unittest.main()
