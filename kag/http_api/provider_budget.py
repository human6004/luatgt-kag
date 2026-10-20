"""Persistent, provider-specific attempt limits for an authorized direct runner."""
from contextlib import contextmanager
from collections import Counter, deque
from datetime import datetime, timezone
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from types import MethodType
from threading import Lock
import time
from uuid import uuid4

import httpx
import portalocker

_RECEIPTS = deque(maxlen=50)
_OUTCOMES = Counter()
_RECEIPT_LOCK = Lock()
_STARTED_AT = datetime.now(timezone.utc).isoformat()
GATEWAY = 'http://kag-ingress:8898/v1'


def receipt_view(binding):
    with _RECEIPT_LOCK:
        return {'since':_STARTED_AT,'outcomes':{kind:{outcome:_OUTCOMES[binding,kind,outcome]
                    for outcome in ('http_success','http_error','transport_error','cancelled')}
                for kind in ('embedding','chat')},
                'recent':[dict(row) for key,row in _RECEIPTS if key==binding]}


class BudgetError(RuntimeError):
    """Fixed messages contain no credentials, request bodies or endpoints."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def provider_route(config, role, policy):
    """Approve a saved endpoint; the isolated gateway resolves and pins its public IP."""
    if (role not in ('chat', 'embedding') or type(policy) is not dict or policy.get('enabled') is not True
            or not policy.get('token') or config.get('provider','openai-compatible') != 'openai-compatible'):
        raise BudgetError('BLOCKED')
    url = httpx.URL(config['base_url'])
    if (url.query or url.fragment or url.userinfo or not url.host
            or url.path != '/' and not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*', url.path)
            or b'%' in url.raw_path or '..' in config['base_url']):
        raise BudgetError('BLOCKED')
    proxy = policy.get('proxy')
    if proxy and config['base_url'] == proxy['base_url']:
        if not proxy.get('safe') and not proxy.get('allow_upstream_retries'):
            raise BudgetError('PROXY_POLICY_UNVERIFIED')
        return dict(mode='proxy', base_url=config['base_url'])
    if (url.scheme != 'https' or url.port not in (None,443) or url.host not in policy.get('allowed_hosts',())
            or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*',url.host)):
        raise BudgetError('BLOCKED')
    return dict(mode='public', base_url=config['base_url'])


def _forward(request, gateway, token, upstream, route=None):
    if gateway != GATEWAY or request.url != httpx.URL(upstream):
        raise BudgetError('PROVIDER_REQUEST_DENIED')
    suffix = '/embeddings' if request.url.path.endswith('/embeddings') else '/chat/completions'
    headers = request.headers.copy()
    headers.pop('X-KAG-Trace-ID', None)
    trace_id = request.extensions.get('kag_trace_id')
    if isinstance(trace_id, str) and re.fullmatch(r'[a-f0-9-]{36}\.[a-f0-9]{32}', trace_id):
        headers['X-KAG-Trace-ID'] = trace_id
    for name in ('host','X-KAG-Provider-Token','X-KAG-Provider-Route','X-KAG-Provider-Host','X-KAG-Provider-Path','X-KAG-Provider-Base'):
        headers.pop(name,None)
    headers['X-KAG-Provider-Token'] = token
    if route is not None:
        headers.update({'X-KAG-Provider-Route':route['mode'],'X-KAG-Provider-Host':request.url.host,
                        'X-KAG-Provider-Path':request.url.path,'X-KAG-Provider-Base':route['base_url']})
    return httpx.Request(request.method,gateway+suffix,headers=headers,content=request.content,extensions=request.extensions)


class GatewayTransport(httpx.BaseTransport):
    def __init__(self, transport, gateway, token, upstream, route=None):
        self.transport,self.gateway,self.token,self.upstream,self.route = transport,gateway,token,upstream,route
    def handle_request(self, request):
        return self.transport.handle_request(_forward(request,self.gateway,self.token,self.upstream,self.route))
    def close(self):self.transport.close()


class AsyncGatewayTransport(httpx.AsyncBaseTransport):
    def __init__(self, transport, gateway, token, upstream, route=None):
        self.transport,self.gateway,self.token,self.upstream,self.route = transport,gateway,token,upstream,route
    async def handle_async_request(self, request):
        return await self.transport.handle_async_request(_forward(request,self.gateway,self.token,self.upstream,self.route))
    async def aclose(self):await self.transport.aclose()


def test_provider(config, role, policy):
    """One client request; upstream proxy retries require explicit operator acceptance."""
    from kag.vector_contract import valid_vector
    result = dict(status='FAIL', code=None, dimension=None, observed_model=None,
                  client_attempts=0, output_chars=0)
    try:
        route = provider_route(config, role, policy)
        suffix = '/chat/completions' if role == 'chat' else '/embeddings'
        upstream = config['base_url'] + suffix
        transport = GatewayTransport(httpx.HTTPTransport(retries=0), GATEWAY, policy['token'], upstream, route)
        payload = dict(model=config['model'])
        if role == 'chat':
            payload.update(messages=[dict(role='user', content='Reply with OK.')], max_tokens=32, stream=False)
        else:
            payload.update(input=['Kiểm tra kết nối.'], encoding_format='float')
        deadline = time.monotonic() + 20
        with httpx.Client(transport=transport, timeout=httpx.Timeout(15, connect=3),
                          trust_env=False, follow_redirects=False) as client:
            result['client_attempts'] = 1
            with client.stream('POST', upstream, json=payload,
                               headers={'Authorization': 'Bearer ' + config['api_key']}) as response:
                if response.headers.get('X-KAG-Provider-Blocked') == '1':
                    raise BudgetError('BLOCKED')
                if response.status_code != 200:
                    raise BudgetError({401:'AUTH_FAILED',403:'AUTH_FAILED',404:'MODEL_NOT_FOUND',
                        429:'RATE_LIMITED'}.get(response.status_code,
                        'BLOCKED' if 300 <= response.status_code < 400 else 'PROVIDER_ERROR'))
                raw = bytearray()
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 262144:
                        raise BudgetError('INVALID_RESPONSE')
                    if time.monotonic() >= deadline:
                        raise BudgetError('TIMEOUT')
        body = json.loads(raw, object_pairs_hook=_object)
        observed = body.get('model')
        if (type(observed) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}',observed)
                and not any(secret and secret in observed for secret in (config['api_key'],policy['token']))):
            result['observed_model'] = observed
        if role == 'chat':
            content = body['choices'][0]['message']['content']
            if type(content) is not str or not content.strip():
                raise BudgetError('INVALID_RESPONSE')
            result['output_chars'] = len(content)
        else:
            rows = body['data']
            vector = rows[0]['embedding'] if type(rows) is list and len(rows) == 1 else None
            result['dimension'] = len(vector) if type(vector) is list else None
            if not result['dimension'] or result['dimension'] > 65536:
                raise BudgetError('DIMENSION_MISMATCH')
            if not valid_vector(vector, result['dimension']):
                raise BudgetError('INVALID_RESPONSE')
        result['status'] = 'PASS'
    except BudgetError as error:
        result.update(status='BLOCKED' if error.code in ('BLOCKED','PROXY_POLICY_UNVERIFIED') else 'FAIL', code=error.code)
    except httpx.TimeoutException:
        result['code'] = 'TIMEOUT'
    except httpx.RequestError:
        result['code'] = 'NETWORK_ERROR'
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        result['code'] = 'INVALID_RESPONSE'
    return result


def _object(pairs):
    value = {}
    for key,item in pairs:
        if key in value:
            raise ValueError('duplicate JSON key')
        value[key] = item
    return value


class ProviderBudget:
    CAP = 3

    def __init__(self, path, *, embedding_url, embedding_model, chat_url, chat_model, limits=None, in_place=False, development_only=False):
        self.path = Path(path).absolute()
        self.lock_path = self.path.with_name(self.path.name+'.lock')
        self.limits = {'embedding':self.CAP,'chat':self.CAP} if limits is None else dict(limits)
        if (type(development_only) is not bool or set(self.limits)!={'embedding','chat'}
                or (self.limits!={'embedding':None,'chat':None} if development_only else
                    any(type(n) is not int or not 1<=n<=maximum
                        for n,maximum in ((self.limits['embedding'],3),(self.limits['chat'],7))))
                or type(in_place) is not bool):
            raise BudgetError('PROVIDER_BINDING_INVALID')
        self.in_place = in_place
        self.source_component = 'direct_runner'
        self.request_id = None
        self.providers = {}
        for kind, endpoint, model in (('embedding',embedding_url,embedding_model),
                                       ('chat',chat_url,chat_model)):
            try:
                url = httpx.URL(endpoint)
                suffix = '/embeddings' if kind=='embedding' else '/chat/completions'
                valid = (type(endpoint) is str and url.scheme in ('http','https')
                    and bool(url.host) and not url.userinfo and not url.query
                    and not url.fragment and url.path.endswith(suffix)
                    and type(model) is str and re.fullmatch(r'[A-Za-z0-9_./:-]{1,256}',model))
            except (TypeError,ValueError):
                valid = False
            if not valid:
                raise BudgetError('PROVIDER_BINDING_INVALID')
            self.providers[kind] = (url,model)
        binding = {k:[str(url),model] for k,(url,model) in self.providers.items()}
        self.binding = hashlib.sha256(json.dumps(binding,sort_keys=True,separators=(',',':')).encode()).hexdigest()

    @contextmanager
    def _locked(self):
        try:
            if self.path.is_symlink() or self.lock_path.is_symlink():
                raise BudgetError('ATTEMPT_LEDGER_UNAVAILABLE')
            with portalocker.Lock(str(self.lock_path),mode='a+',timeout=5) as lock:
                lock.seek(0)
                marker = lock.read()
                if marker and marker != self.binding+'\n':
                    raise BudgetError('ATTEMPT_LEDGER_INVALID')
                if not self.path.exists():
                    # A consumed ledger must never be silently recreated after deletion.
                    if marker:
                        raise BudgetError('ATTEMPT_LEDGER_UNAVAILABLE')
                    state = {'version':1,'binding_sha256':self.binding,
                             'attempts':{'embedding':0,'chat':0}}
                    self._write(state)
                else:
                    state = json.loads(self.path.read_text(encoding='utf-8'),object_pairs_hook=_object)
                if (type(state) is not dict or set(state)!={'version','binding_sha256','attempts'}
                        or type(state['version']) is not int or state['version']!=1
                        or state['binding_sha256']!=self.binding
                        or type(state['attempts']) is not dict
                        or set(state['attempts'])!={'embedding','chat'}
                        or any(type(n) is not int or n<0 or self.limits[k] is not None and n>self.limits[k]
                               for k,n in state['attempts'].items())):
                    raise BudgetError('ATTEMPT_LEDGER_INVALID')
                if not marker:
                    lock.write(self.binding+'\n')
                    lock.flush()
                    os.fsync(lock.fileno())
                yield state
        except BudgetError:
            raise
        except (OSError,ValueError,portalocker.exceptions.LockException):
            raise BudgetError('ATTEMPT_LEDGER_UNAVAILABLE') from None

    def _write(self, state):
        if self.in_place:
            # Exact bind-mounted files cannot be replaced. Crash-corrupted JSON denies all later sends.
            with self.path.open('r+',encoding='utf-8') as stream:
                stream.seek(0)
                json.dump(state,stream,sort_keys=True,separators=(',',':'))
                stream.truncate()
                stream.flush()
                os.fsync(stream.fileno())
            return
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=self.path.name+'.',suffix='.tmp',dir=self.path.parent)
            with os.fdopen(fd,'w',encoding='utf-8') as stream:
                json.dump(state,stream,sort_keys=True,separators=(',',':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary,self.path)
            temporary = None
            if os.name=='posix':
                directory = os.open(self.path.parent,os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def counts(self):
        with self._locked() as state:
            return dict(state['attempts'])

    def reserve(self, kind):
        if kind not in self.providers:
            raise BudgetError('PROVIDER_BINDING_INVALID')
        with self._locked() as state:
            if self.limits[kind] is not None and state['attempts'][kind]>=self.limits[kind]:
                raise BudgetError('PROVIDER_ATTEMPT_BUDGET_EXHAUSTED')
            state['attempts'][kind]+=1
            self._write(state)
            return state['attempts'][kind]

    def _admit(self, kind, request):
        if kind not in self.providers:
            raise BudgetError('PROVIDER_BINDING_INVALID')
        url, model = self.providers[kind]
        try:
            body = json.loads(request.content,object_pairs_hook=_object)
            valid = (request.method=='POST' and request.url==url
                     and type(body) is dict and body.get('model')==model)
        except (ValueError,TypeError,httpx.RequestNotRead):
            valid = False
        if not valid:
            raise BudgetError('PROVIDER_REQUEST_DENIED')
        return self.reserve(kind)

    def _receipt(self, kind, attempt, outbound_id, outcome, started, response=None):
        request_id=response.headers.get('x-request-id') or response.headers.get('request-id') if response is not None else None
        if request_id is not None and not re.fullmatch('[A-Za-z0-9_.:-]{1,128}',request_id):request_id=None
        row={'kind':kind,'attempt':attempt,'outbound_id':outbound_id,'request_id':self.request_id,
             'source_component':self.source_component,'configured_model':self.providers[kind][1],
             'timestamp':datetime.now(timezone.utc).isoformat(),'outcome':outcome,
             'status':response.status_code if response is not None else None,'provider_request_id':request_id,
             'latency_ms':round((time.monotonic()-started)*1000,3) if outcome!='attempted' else None,
             'client_retry':False,'proxy_retries':None,'upstream_attempts':None}
        with _RECEIPT_LOCK:
            _RECEIPTS.append((self.binding,row))
            if outcome!='attempted':_OUTCOMES[self.binding,kind,outcome]+=1
        print('PROVIDER_REQUEST '+json.dumps(row,separators=(',',':')),flush=True)

    def guard_sync(self, kind, transport):
        return _SyncTransport(self,kind,transport)

    def guard_async(self, kind, transport):
        return _AsyncTransport(self,kind,transport)

    def configure_sdk(self, model, kind):
        """Call before any SDK invocation; both clients and proxy mounts are guarded."""
        if kind not in self.providers:
            raise BudgetError('PROVIDER_BINDING_INVALID')
        for name, client_type, guard in (('client',httpx.Client,self.guard_sync),
                                         ('aclient',httpx.AsyncClient,self.guard_async)):
            sdk = getattr(model,name,None)
            client = getattr(sdk,'_client',None)
            if not isinstance(client,client_type):
                raise BudgetError('PROVIDER_BINDING_INVALID')
            sdk.max_retries = 0
            client.follow_redirects = False
            client._transport = guard(kind,client._transport)
            client._mounts = {pattern:guard(kind,transport) if transport else None
                              for pattern,transport in client._mounts.items()}


class _SyncTransport(httpx.BaseTransport):
    def __init__(self, budget, kind, transport):
        self.budget,self.kind,self.transport = budget,kind,transport

    def handle_request(self, request):
        attempt=self.budget._admit(self.kind,request);started=time.monotonic();outbound_id=uuid4().hex
        if getattr(self.budget, 'trace_id', None):
            request.extensions['kag_trace_id'] = self.budget.trace_id+'.'+outbound_id
        self.budget._receipt(self.kind,attempt,outbound_id,'attempted',started)
        try:response = self.transport.handle_request(request)
        except Exception:
            self.budget._receipt(self.kind,attempt,outbound_id,'transport_error',started)
            raise
        self.budget._receipt(self.kind,attempt,outbound_id,'http_success' if response.is_success else 'http_error',started,response)
        if 300<=response.status_code<400:
            response.close()
            raise BudgetError('PROVIDER_REDIRECT_DENIED')
        return response

    def close(self):
        self.transport.close()


class _AsyncTransport(httpx.AsyncBaseTransport):
    def __init__(self, budget, kind, transport):
        self.budget,self.kind,self.transport = budget,kind,transport

    async def handle_async_request(self, request):
        attempt=self.budget._admit(self.kind,request);started=time.monotonic();outbound_id=uuid4().hex
        if getattr(self.budget, 'trace_id', None):
            request.extensions['kag_trace_id'] = self.budget.trace_id+'.'+outbound_id
        self.budget._receipt(self.kind,attempt,outbound_id,'attempted',started)
        try:response = await self.transport.handle_async_request(request)
        except (Exception,asyncio.CancelledError) as exc:
            self.budget._receipt(self.kind,attempt,outbound_id,'cancelled' if isinstance(exc,asyncio.CancelledError) else 'transport_error',started)
            raise
        self.budget._receipt(self.kind,attempt,outbound_id,'http_success' if response.is_success else 'http_error',started,response)
        if 300<=response.status_code<400:
            await response.aclose()
            raise BudgetError('PROVIDER_REDIRECT_DENIED')
        return response

    async def aclose(self):
        await self.transport.aclose()


def disable_instance_retries(pipeline, llm):
    """Unwrap only this request's methods; preserve upstream classes and five iterations."""
    methods = [(pipeline,'planning'),(llm,'call_with_json_parse'),(llm,'acall_with_json_parse')]
    if getattr(pipeline,'max_iteration',None)!=5:
        raise BudgetError('PIPELINE_BINDING_INVALID')
    unwrapped = []
    for instance,name in methods:
        original = getattr(type(instance),name,None)
        function = getattr(original,'__wrapped__',None)
        if not callable(function):
            raise BudgetError('PIPELINE_BINDING_INVALID')
        unwrapped.append((instance,name,function))
    for instance,name,function in unwrapped:
        setattr(instance,name,MethodType(function,instance))
