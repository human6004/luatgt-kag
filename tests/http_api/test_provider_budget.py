"""Offline transport fixtures; no provider calls or credentials."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import httpx
from tenacity import retry, stop_after_attempt


class ProviderBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'attempts.json'
        self.module = importlib.import_module('kag.http_api.provider_budget')

    def budget(self):
        return self.module.ProviderBudget(self.path,
            embedding_url='https://embedding.invalid/v1/embeddings',
            embedding_model='fixture-embedding',
            chat_url='https://chat.invalid/v1/chat/completions', chat_model='fixture-chat')

    def request(self, kind='chat', **kwargs):
        endpoint = 'https://chat.invalid/v1/chat/completions' if kind=='chat' else 'https://embedding.invalid/v1/embeddings'
        return httpx.Request('POST', kwargs.get('url',endpoint),
            json={'model':kwargs.get('model','fixture-'+kind), 'input':'fixture'})

    def test_receipts_attribute_attempt_outcome_without_payload_or_billed_count_claims(self):
        import io
        from contextlib import redirect_stdout
        budget=self.budget(); output=io.StringIO()
        def reply(request):
            if budget.counts()['chat']==1:raise httpx.ReadTimeout('PRIVATE_EXCEPTION',request=request)
            return httpx.Response(200,headers={'x-request-id':'fixture-request-2'},json={'private':'PRIVATE_BODY'})
        guard=budget.guard_sync('chat',httpx.MockTransport(reply))
        with redirect_stdout(output):
            with self.assertRaises(httpx.ReadTimeout):guard.handle_request(self.request())
            guard.handle_request(self.request())
        rows=[json.loads(line.removeprefix('PROVIDER_REQUEST ')) for line in output.getvalue().splitlines()]
        self.assertEqual([r['outcome'] for r in rows],['attempted','transport_error','attempted','http_success'])
        self.assertEqual([r['attempt'] for r in rows],[1,1,2,2])
        self.assertEqual(rows[-1]['provider_request_id'],'fixture-request-2')
        self.assertEqual(rows[-1]['configured_model'],'fixture-chat')
        self.assertIsNone(rows[-1]['upstream_attempts'])
        self.assertIsNone(rows[-1]['proxy_retries'])
        self.assertFalse(rows[-1]['client_retry'])
        self.assertGreaterEqual(rows[-1]['latency_ms'],0)
        self.assertNotIn('PRIVATE',output.getvalue())

    def test_async_receipts_record_cancellation_and_safe_request_id(self):
        import io
        from contextlib import redirect_stdout
        output=io.StringIO();budget=self.budget()
        async def reply(request):raise asyncio.CancelledError('PRIVATE_EXCEPTION')
        async def run():
            guard=budget.guard_async('embedding',httpx.MockTransport(reply))
            with self.assertRaises(asyncio.CancelledError):await guard.handle_async_request(self.request('embedding'))
        with redirect_stdout(output):asyncio.run(run())
        rows=[json.loads(line.removeprefix('PROVIDER_REQUEST ')) for line in output.getvalue().splitlines()]
        self.assertEqual([r['outcome'] for r in rows],['attempted','cancelled'])
        self.assertNotIn('PRIVATE',output.getvalue())

    def test_shared_instances_count_failure_timeout_and_success_before_send(self):
        budget = self.budget()
        seen = []
        def send(request):
            seen.append(self.budget().counts()['chat'])
            if len(seen)==1: raise httpx.ReadTimeout('fixture',request=request)
            return httpx.Response(500 if len(seen)==2 else 200)
        guard = budget.guard_sync('chat',httpx.MockTransport(send))
        with self.assertRaises(httpx.ReadTimeout): guard.handle_request(self.request())
        self.assertEqual(guard.handle_request(self.request()).status_code,500)
        self.assertEqual(guard.handle_request(self.request()).status_code,200)
        with self.assertRaises(self.module.BudgetError):
            self.budget().guard_sync('chat',httpx.MockTransport(send)).handle_request(self.request())
        self.assertEqual(seen,[1,2,3])
        self.assertEqual(budget.counts(),{'chat':3,'embedding':0})

    def test_concurrent_instances_reserve_only_three(self):
        def reserve(_):
            try: return self.budget().reserve('embedding')
            except self.module.BudgetError: return None
        with ThreadPoolExecutor(max_workers=12) as pool:
            values=list(pool.map(reserve,range(24)))
        self.assertEqual(sorted(x for x in values if x is not None),[1,2,3])
        self.assertEqual(self.budget().counts()['embedding'],3)

    def test_wrong_url_or_model_denied_without_attempt(self):
        sent=[]; budget=self.budget()
        guard=budget.guard_sync('chat',httpx.MockTransport(lambda r: sent.append(r)))
        for request in (self.request(url='https://other.invalid/v1/chat/completions'),
                        self.request(url='https://chat.invalid/v1/chat/completions?x=1'),
                        self.request(model='other-model')):
            with self.assertRaises(self.module.BudgetError): guard.handle_request(request)
        self.assertEqual(sent,[])
        self.assertEqual(budget.counts(),{'chat':0,'embedding':0})

    def test_duplicate_model_keys_denied_without_attempt(self):
        budget=self.budget(); seen=[]
        guard=budget.guard_sync('chat',httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200)))
        request=httpx.Request('POST','https://chat.invalid/v1/chat/completions',
            content=b'{"model":"other","model":"fixture-chat"}')
        with self.assertRaises(self.module.BudgetError): guard.handle_request(request)
        self.assertEqual(seen,[])
        self.assertEqual(budget.counts()['chat'],0)

    def test_deleted_ledger_does_not_reset_consumed_attempts(self):
        self.budget().reserve('chat')
        self.path.unlink()
        with self.assertRaises(self.module.BudgetError): self.budget().reserve('chat')
        self.assertFalse(self.path.exists())

    def test_redirect_denied_and_counted_once(self):
        budget=self.budget(); sent=[]
        def reply(r):
            sent.append(r)
            return httpx.Response(307,headers={'location':'https://other.invalid/'})
        with httpx.Client(transport=budget.guard_sync('chat',httpx.MockTransport(reply)),follow_redirects=True) as client:
            with self.assertRaises(self.module.BudgetError): client.send(self.request())
        self.assertEqual(len(sent),1)
        self.assertEqual(budget.counts()['chat'],1)

    def test_async_failures_share_the_sync_cap(self):
        budget=self.budget(); seen=[]
        async def send(request):
            seen.append(budget.counts()['embedding'])
            raise httpx.ConnectTimeout('fixture',request=request)
        async def run():
            guard=budget.guard_async('embedding',httpx.MockTransport(send))
            for _ in range(3):
                with self.assertRaises(httpx.ConnectTimeout):
                    await guard.handle_async_request(self.request('embedding'))
            with self.assertRaises(self.module.BudgetError):
                await guard.handle_async_request(self.request('embedding'))
            await guard.aclose()
        asyncio.run(run())
        self.assertEqual(seen,[1,2,3])
        self.assertEqual(self.budget().counts()['embedding'],3)

    def test_corrupt_or_different_binding_never_resets_ledger(self):
        budget=self.budget(); budget.reserve('chat')
        original=self.path.read_bytes()
        with self.assertRaises(self.module.BudgetError):
            self.module.ProviderBudget(self.path,embedding_url='https://embedding.invalid/v1/embeddings',
                embedding_model='other',chat_url='https://chat.invalid/v1/chat/completions',
                chat_model='fixture-chat').reserve('chat')
        self.assertEqual(self.path.read_bytes(),original)
        self.path.write_text('{broken',encoding='utf-8')
        with self.assertRaises(self.module.BudgetError): budget.reserve('chat')
        self.assertEqual(self.path.read_text(encoding='utf-8'),'{broken')

    def test_configure_both_sdk_clients_disables_retry_and_redirect(self):
        budget=self.budget()
        model=SimpleNamespace(client=SimpleNamespace(_client=httpx.Client(),max_retries=2),
                              aclient=SimpleNamespace(_client=httpx.AsyncClient(),max_retries=2))
        budget.configure_sdk(model,'chat')
        for sdk in (model.client,model.aclient):
            self.assertEqual(sdk.max_retries,0)
            self.assertFalse(sdk._client.follow_redirects)
        model.client._client.close()
        asyncio.run(model.aclient._client.aclose())

    def test_real_sdk_failure_has_one_sync_and_one_async_attempt(self):
        from openai import OpenAI, AsyncOpenAI, APIStatusError
        budget=self.budget(); seen=[]
        def reply(request):
            seen.append(budget.counts()['chat'])
            return httpx.Response(500,json={'error':{'message':'offline fixture'}})
        model=SimpleNamespace(
            client=OpenAI(api_key='offline-fixture',base_url='https://chat.invalid/v1',
                http_client=httpx.Client(transport=httpx.MockTransport(reply))),
            aclient=AsyncOpenAI(api_key='offline-fixture',base_url='https://chat.invalid/v1',
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(reply))))
        budget.configure_sdk(model,'chat')
        try:
            with self.assertRaises(APIStatusError):
                model.client.chat.completions.create(model='fixture-chat',messages=[])
            async def run():
                with self.assertRaises(APIStatusError):
                    await model.aclient.chat.completions.create(model='fixture-chat',messages=[])
            asyncio.run(run())
            self.assertEqual(seen,[1,2])
            self.assertEqual(budget.counts()['chat'],2)
        finally:
            model.client.close()
            asyncio.run(model.aclient.close())
