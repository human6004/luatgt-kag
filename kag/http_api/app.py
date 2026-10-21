"""Verified v1 HTTP adapter; independent live authorities remain unavailable."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from ipaddress import ip_address
import os
import math
from pathlib import Path
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response

from .contract import ApiFailure
from . import artifacts, contract
from .security import ServiceSecrets, admit_request, authorize, request_principal, authenticate, bounded_body


@dataclass(frozen=True)
class ApiSettings:
    secrets: ServiceSecrets = field(default_factory=ServiceSecrets, repr=False)

    def __post_init__(self):
        if type(self.secrets) is not ServiceSecrets:
            raise ApiFailure('NOT_READY')

    @classmethod
    def from_env(cls):
        def tokens(prefix):
            result = []
            for suffix in ('SECRET_FILE', 'PREVIOUS_SECRET_FILE'):
                path = os.environ.get(prefix+suffix)
                if path is None:
                    continue
                try:
                    with Path(path).open('rb') as stream:
                        raw = stream.read(515)
                    if len(raw) > 514:
                        raise ApiFailure('NOT_READY')
                    if raw.endswith(b'\r\n'):
                        raw = raw[:-2]
                    elif raw.endswith(b'\n'):
                        raw = raw[:-1]
                    result.append(raw.decode('ascii', errors='strict'))
                except (OSError, UnicodeError, ValueError):
                    raise ApiFailure('NOT_READY') from None
            return tuple(result)
        return cls(ServiceSecrets(tokens('KAG_HTTP_QUERY_'), tokens('KAG_HTTP_INSPECT_'),
                                  tokens('KAG_HTTP_CREDENTIALS_WRITE_'), tokens('KAG_HTTP_PROVIDER_TEST_'),
                                  tokens('KAG_HTTP_CONFIG_APPLY_')))


def _failure(request: Request, code: str, *, status=None, extra=None):
    failure = ApiFailure(code)
    body = {'request_id': request.state.request_id,
            'error': {'code': failure.code, 'message': failure.message, 'retryable': failure.retryable},
            'native_state': failure.native_state}
    if extra:
        body.update(extra)
    response_status = failure.status if status is None else status
    if request.method == 'POST' and request.scope['path'] in ('/v1/query', '/v1/query/stream'):
        print('KAG_QUERY_FAILURE '+json.dumps({
            'request_id': request.state.request_id, 'code': failure.code, 'status': response_status,
            'elapsed_ms': round(max(0, time.monotonic()-getattr(request.state, 'request_started', time.monotonic()))*1000, 3)
        }), flush=True)
    headers = {'WWW-Authenticate':'Bearer'} if response_status == 401 else (
        {'Retry-After':'1'} if failure.code == 'CONCURRENCY_LIMIT' else None)
    return JSONResponse(body,status_code=response_status,headers=headers)


class _SafeHTTP:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        from .runtime import RuntimeFailure
        scope.setdefault('state', {})['request_id'] = str(uuid4())
        scope['state']['request_started'] = time.monotonic()
        started = False

        async def authority():
            if time.monotonic() >= scope['state']['request_deadline']:
                raise ApiFailure('QUERY_TIMEOUT')
            if scope['state'].get('query_verified'):
                from .runtime import _today
                if _today() != scope['state']['query_as_of']:
                    raise ApiFailure('DATE_BOUNDARY_CHANGED')
            try:
                await asyncio.wait_for(asyncio.to_thread(scope['state']['authority_guard']),
                    scope['state']['request_deadline']-time.monotonic())
            except asyncio.TimeoutError:
                raise ApiFailure('QUERY_TIMEOUT') from None

        async def safe_send(message):
            nonlocal started
            verified = scope['state'].get('query_verified') or scope['state'].get('retrieve_verified')
            if verified:
                await authority()
            if message['type'] == 'http.response.start':
                started = True
                headers = [(k, v) for k, v in message.get('headers', [])
                           if k.lower() not in (b'x-request-id', b'cache-control')]
                message = {**message, 'headers': headers+[
                    (b'x-request-id', scope['state']['request_id'].encode('ascii')),
                    (b'cache-control', b'no-store')]}
            if verified:
                midnight_deadline = scope['state']['request_deadline']
                if scope['state'].get('query_verified'):
                    now = datetime.now(ZoneInfo('Asia/Saigon'))
                    midnight = datetime.combine(now.date()+timedelta(days=1),datetime.min.time(),now.tzinfo)
                    midnight_deadline = time.monotonic()+(midnight-now).total_seconds()
                delivery = asyncio.create_task(send(message))
                try:
                    while not delivery.done():
                        left = min(scope['state']['request_deadline'],midnight_deadline)-time.monotonic()
                        if left <= 0:
                            raise ApiFailure('DATE_BOUNDARY_CHANGED' if midnight_deadline < scope['state']['request_deadline']
                                             else 'QUERY_TIMEOUT')
                        await asyncio.wait({delivery},timeout=min(.02,left))
                        if not delivery.done():
                            await authority()
                    delivery.result()
                finally:
                    if not delivery.done():
                        delivery.cancel()
                    await asyncio.gather(delivery,return_exceptions=True)
            else:
                await send(message)

        try:
            await self.app(scope, receive, safe_send)
        except (ApiFailure, RuntimeFailure) as exc:
            if not started:
                scope['state']['query_verified'] = False
                scope['state']['retrieve_verified'] = False
                response = _failure(Request(scope), exc.code)
                await response(scope, receive, safe_send)
        except Exception:
            if not started:
                scope['state']['query_verified'] = False
                scope['state']['retrieve_verified'] = False
                response = _failure(Request(scope), 'INTERNAL_ERROR')
                await response(scope, receive, safe_send)


def _local(request: Request) -> bool:
    try:
        return request.client is not None and ip_address(request.client.host).is_loopback
    except ValueError:
        return False


def _verify_retrieve_items(items, release, reader):
    from kag.vector_contract import TARGETS
    if type(items) is not list:
        raise ApiFailure('INVALID_NATIVE_RESULT')
    if len(items) > 110:
        raise ApiFailure('RESULT_LIMIT_EXCEEDED')
    try:
        contract._json_value(items)
    except (ValueError,RecursionError):
        raise ApiFailure('INVALID_NATIVE_RESULT') from None
    catalog = {}
    relations = set()
    schema = artifacts._json(release.contract_bytes)
    for record in release.records:
        catalog.setdefault((record.entity_type,record.entity_id),{})[record.field] = record
        for relation in record.graph_context:
            relations.add((tuple(relation['from']),relation['predicate'],tuple(relation['to'])))
    indexes = reader.indexes()
    fields = {'entity_type','entity_id','doc_id','unit_id','sign_id','source_texts',
              'score','vector_sources','graph_context'}
    def score(value):
        return type(value) in (int,float) and 0<=value<=1 and math.isfinite(value)
    seen = set()
    for item in items:
        if (type(item) is not dict or set(item)!=fields
                or any(not contract._text(item[k]) or not item[k] for k in ('entity_type','entity_id'))
                or type(item['source_texts']) is not dict or type(item['vector_sources']) is not list
                or type(item['graph_context']) is not list
                or (item['score'] is not None and not score(item['score']))):
            raise ApiFailure('INVALID_NATIVE_RESULT')
        key = item['entity_type'],item['entity_id']
        records = catalog.get(key)
        if not records:
            raise ApiFailure('SOURCE_VALIDATION_FAILED')
        reference = next(iter(records.values()))
        if (any(item[k]!=getattr(reference,k) for k in ('doc_id','unit_id','sign_id'))
                or key in seen):
            raise ApiFailure('SOURCE_VALIDATION_FAILED')
        seen.add(key)
        kind = key[0].removeprefix(release.schema_contract.namespace+'.')
        targets = dict(TARGETS[kind])
        # Catalog metadata uses logical names; native preserves physical names and empty Text.
        texts = {row['schema_name']:reference.metadata.get(row['logical_name'])
                 for row in schema['node_properties'][kind] if row['schema_name'] in targets}
        if (set(item['source_texts'])!=set(targets)
                or item['source_texts']!=texts):
            raise ApiFailure('SOURCE_VALIDATION_FAILED')
        properties = set()
        for source in item['vector_sources']:
            if (type(source) is not dict or set(source)!={'property','score','index'}
                    or not contract._text(source['property']) or not score(source['score'])
                    or not contract._text(source['index']) or not source['index']):
                raise ApiFailure('INVALID_NATIVE_RESULT')
            prop = source['property']
            if prop not in targets or prop in properties:
                raise ApiFailure('SOURCE_VALIDATION_FAILED')
            properties.add(prop)
            matched = [i for i in indexes if i.get('labelsOrTypes')==[key[0]]
                       and i.get('properties')==[targets[prop]] and i.get('type')=='VECTOR']
            if len(matched)!=1 or matched[0].get('name')!=source['index']:
                raise ApiFailure('SOURCE_VALIDATION_FAILED')
        if ((item['score'] is None) != (not item['vector_sources'])
                or (item['vector_sources'] and item['score']!=max(s['score'] for s in item['vector_sources']))
                or (item['score'] is None and not item['graph_context'])):
            raise ApiFailure('INVALID_NATIVE_RESULT')
        contexts = set()
        for relation in item['graph_context']:
            if (type(relation) is not dict or set(relation)!={'from','predicate','to'}
                    or not contract._text(relation['predicate'])
                    or any(type(relation[s]) is not list or len(relation[s])!=2
                           or any(not contract._text(v) or not v for v in relation[s]) for s in ('from','to'))):
                raise ApiFailure('INVALID_NATIVE_RESULT')
            source,target = tuple(relation['from']),tuple(relation['to'])
            identity = source,relation['predicate'],target
            if (identity not in relations or key not in (source,target)
                    or source not in catalog or target not in catalog or identity in contexts):
                raise ApiFailure('SOURCE_VALIDATION_FAILED')
            contexts.add(identity)


def create_app(settings: ApiSettings | None = None, runtime_factory=None, *, enable_sample_routes=False) -> FastAPI:
    if type(enable_sample_routes) is not bool:
        raise ApiFailure('NOT_READY')
    settings = ApiSettings.from_env() if settings is None else settings
    if type(settings) is not ApiSettings:
        raise ApiFailure('NOT_READY')

    @asynccontextmanager
    async def lifespan(application):
        from .runtime import RuntimeSupervisor, initialize_runtime
        application.state.runtime_supervisor = RuntimeSupervisor()
        application.state.runtime_supervisor.load_llm_config(settings.secrets)
        try:
            initialize_runtime()
        except Exception:
            application.state.runtime_supervisor.closed = True
        try:
            from .inspection import solver_defaults
            application.state.solver_defaults = solver_defaults()
        except Exception:
            application.state.solver_defaults = None
        if application.state.solver_defaults is not None:
            defaults = application.state.solver_defaults
            application.state.runtime_supervisor.load_chat_config({key: defaults[key] for key in ('top_k', 'expand')})
        else:
            application.state.runtime_supervisor._chat_error = 'CONFIG_INVALID'
        restore_serving(application)
        application.state.runtime_settings = application.state.runtime_supervisor.restore_llm_runtime(
            application.state.runtime_settings, application.state.serving_release, application.state.provider_test_policy)
        try:
            yield
        finally:
            await application.state.runtime_supervisor.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, debug=False)
    app.state.http_settings = settings
    app.state.runtime_factory = runtime_factory
    app.state.serving_release = None
    app.state.runtime_settings = None
    app.state.evaluation_root = None
    app.state.provider_test_policy = None
    from .inspection import configuration_view
    app.state.config_snapshot = configuration_view({}, {})
    app.state.solver_defaults = None
    app.add_middleware(_SafeHTTP)

    def restore_serving(application):
        from .runtime import RuntimeSettings
        from kag.builder.serving import release_root
        supervisor=application.state.runtime_supervisor
        selected=(supervisor._llm_config or {}).get('serving')
        if selected is None:return
        try:
            release=artifacts.load_release(release_root(selected['release_id']),selected['release_id'])
            application.state.serving_release=release
            application.state.runtime_settings=RuntimeSettings(secrets=settings.secrets,production=True,
                dimension=release.descriptor['dimension'],release_id=release.release_id,
                source_snapshot_id=release.descriptor['source_snapshot_id'],webapp_snapshot_id=release.descriptor['webapp_snapshot_id'],
                broker_url='http://openspg-server:8010',broker_token=settings.secrets.inspect_tokens[0])
        except Exception:
            application.state.serving_release=None;application.state.runtime_settings=None

    def worker_request(path,request,body=None):
        import json
        from urllib.request import Request as Outgoing,build_opener,ProxyHandler
        from urllib.error import HTTPError
        from kag.verify import _NoRedirect
        values=request.headers.getlist('x-openspg-session')
        token=(settings.secrets.config_apply_tokens if body is not None and path!='/trial' else settings.secrets.inspect_tokens)
        if not token:raise ApiFailure('SCOPE_DENIED')
        outgoing=Outgoing('http://openspg-server:8010/v1/serving'+path,
            data=artifacts.canonical_json(body).encode() if body is not None else None,
            headers={'Authorization':'Bearer '+token[0],'Content-Type':'application/json',
                'X-OpenSPG-Session':values[0] if len(values)==1 else ''})
        try:
            with build_opener(ProxyHandler({}),_NoRedirect()).open(outgoing,timeout=120) as response:
                raw=response.read(245761)
            if len(raw)>245760:raise ApiFailure('RESULT_LIMIT_EXCEEDED')
            return artifacts._json(raw)
        except HTTPError as error:
            try:code=artifacts._json(error.read(65537)).get('error',{}).get('code')
            except Exception:code=None
            raise ApiFailure(code if code in ('CONFIG_BUSY','CONFIG_CONFLICT','SCOPE_DENIED','RELEASE_MISMATCH','NOT_READY') else 'NOT_READY') from None

    def sample_guard(request, release, runtime_settings):
        if (time.monotonic() >= request.state.request_deadline
                or app.state.serving_release is not release or app.state.runtime_settings is not runtime_settings
                or app.state.http_settings.secrets != runtime_settings.secrets):
            raise ApiFailure('NOT_READY')
        if request.headers.getlist('x-kag-release-id') != [release.release_id]:
            raise ApiFailure('RELEASE_MISMATCH')
        if runtime_settings.production:
            from kag.builder.serving import validate_active_release
            validate_active_release(release)
        else:artifacts.load_sample_proof(release,runtime_settings.sample_proof_sha256,runtime_settings.reader_username)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        response = _failure(request, 'INVALID_REQUEST', status=exc.status_code
                            if exc.status_code in (400, 404, 405, 422) else 500)
        if exc.status_code == 405 and exc.headers:
            allow = exc.headers.get('Allow', '')
            if (type(allow) is str and len(allow) <= 64
                    and all(method in {'GET', 'HEAD', 'POST', 'OPTIONS'} for method in allow.split(', '))):
                response.headers['Allow'] = allow
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return _failure(request, 'INVALID_REQUEST')

    @app.get('/v1/health')
    async def health(request: Request):
        params = list(request.query_params.multi_items())
        principal = None if not params and _local(request) else request_principal(request)
        if not params:
            return {'contract_version': 'h1-read-v1.0', 'status': 'alive'}
        if (len(params) != 2 or dict(params).get('mode') != 'ready'
                or set(dict(params)) != {'mode', 'capability'}
                or dict(params)['capability'] not in ('retrieve', 'retrieve-vector', 'query-v1')):
            raise ApiFailure('INVALID_REQUEST')
        capability = dict(params)['capability']
        authorize(principal, 'query' if capability == 'query-v1' else 'inspect', None)
        supervisor = getattr(app.state, 'runtime_supervisor', None)
        if capability == 'retrieve-vector' and enable_sample_routes:
            release, runtime_settings = app.state.serving_release, app.state.runtime_settings
            if type(release) is artifacts.ServingRelease and runtime_settings is not None and supervisor is not None:
                try:
                    result = await supervisor.sample_vector(request,runtime_settings,release,ready=True)
                except ApiFailure as failure:
                    if failure.code != 'NOT_READY':
                        raise
                else:
                    sample_guard(request,release,runtime_settings)
                    request.state.authority_guard = lambda:sample_guard(request,release,runtime_settings)
                    request.state.retrieve_verified = True
                    return JSONResponse(result)
        if capability in ('query-v1','retrieve'):
            release,runtime_settings=app.state.serving_release,app.state.runtime_settings
            if (type(release) is artifacts.ServingRelease and runtime_settings is not None
                    and (getattr(runtime_settings,'production',False) or enable_sample_routes and getattr(runtime_settings,'query_proof_sha256',None))
                    and supervisor is not None):
                try:
                    result=await supervisor.sample_ready(request,runtime_settings,release,
                        capability='query' if capability=='query-v1' else 'retrieve')
                except ApiFailure as failure:
                    if failure.code!='NOT_READY':raise
                    return _failure(request,'NOT_READY',extra={
                        'status':'unavailable','capability':capability,
                        'checks':{'auth':'pass',**supervisor.readiness()},
                        'provider_transport':'not_probed','production_write':'blocked'})
                sample_guard(request,release,runtime_settings)
                request.state.authority_guard=lambda:sample_guard(request,release,runtime_settings)
                return JSONResponse(result)
        checks = supervisor.readiness() if supervisor is not None else {
            'runtime': 'blocked', 'sources': 'unknown'}
        return _failure(request, 'NOT_READY', extra={
            'status': 'unavailable', 'capability': capability,
            'checks': {'auth': 'pass', **checks},
            'provider_transport': 'not_probed', 'production_write': 'blocked'})

    if not (settings.secrets.query_tokens or settings.secrets.inspect_tokens):
        return app

    @app.get('/v1/serving')
    async def serving_catalog(request: Request):
        authorize(request_principal(request),'inspect',None)
        if request.query_params:raise ApiFailure('INVALID_REQUEST')
        supervisor=app.state.runtime_supervisor
        value=await asyncio.to_thread(worker_request,'',request)
        if getattr(supervisor,'_serving_uncertain',False) and not value['busy']:
            supervisor.load_llm_config(settings.secrets);restore_serving(app)
            app.state.runtime_settings=supervisor.restore_llm_runtime(app.state.runtime_settings,
                app.state.serving_release,app.state.provider_test_policy)
            supervisor.closed=False;supervisor._serving_action=False;supervisor._serving_uncertain=False
        release=app.state.serving_release
        from kag.builder.serving import chat_blockers
        blockers=chat_blockers(release) if type(release) is artifacts.ServingRelease and release.release_kind=='PRODUCTION' else ['GRAPH_REQUIRED']
        models=supervisor._llm_config or {}
        if not models.get('active',{}).get('chat'):
            tested=models.get('tested',{}).get('chat')
            blockers.append('CHAT_MODEL_NOT_APPLIED' if models.get('chat') and tested and tested['status']=='PASS' else 'CHAT_MODEL_REQUIRED')
        return dict(value,runtime_ready=app.state.runtime_settings is not None,chat_blockers=blockers)

    @app.post('/v1/serving/{action}')
    async def serving_action(action: str,request: Request):
        authorize(request_principal(request),'config-apply',None)
        if action not in ('preview','activate') or request.query_params:raise ApiFailure('INVALID_REQUEST')
        body=artifacts._json(await bounded_body(request,limit=32*1024*1024))
        supervisor=app.state.runtime_supervisor
        if supervisor.busy or supervisor._provider_test_task or supervisor._serving_action:raise ApiFailure('CONFIG_BUSY')
        supervisor._serving_action=True
        async def operation():
            try:
                return await asyncio.to_thread(worker_request,'/'+action,request,body)
            except ApiFailure:raise
            except Exception:
                supervisor._serving_uncertain=True;supervisor.closed=True
                raise ApiFailure('BACKEND_UNAVAILABLE') from None
            finally:
                if not getattr(supervisor,'_serving_uncertain',False):
                    supervisor.load_llm_config(settings.secrets);restore_serving(app)
                    app.state.runtime_settings=supervisor.restore_llm_runtime(app.state.runtime_settings,
                        app.state.serving_release,app.state.provider_test_policy)
                    supervisor._serving_action=False
        try:return await supervisor.supervise(operation,time.monotonic()+180)
        except Exception:
            if not supervisor.busy and not getattr(supervisor,'_serving_uncertain',False):supervisor._serving_action=False
            raise

    @app.post('/v1/serving/trial/{project_id}/{run_id}')
    async def trial_graph(project_id: int,run_id: str,request: Request):
        from copy import deepcopy
        import re
        from .runtime import RequestRuntime,RuntimeSettings,_new_embedding,initialize_runtime,REQUEST_SECONDS
        authorize(request_principal(request),'inspect',None)
        if (request.query_params or not 1<=project_id<=2147483647
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',run_id)):
            raise ApiFailure('INVALID_REQUEST')
        body=artifacts._json(await bounded_body(request))
        artifacts._keys(body,('message','top_k','expand'))
        contract.retrieval_options(dict(top_k=body['top_k'],expand=body['expand']))
        if not contract._text(body['message']) or not body['message'].strip() or contract.utf16_units(body['message'])>4000:
            raise ApiFailure('INVALID_REQUEST')
        supervisor=app.state.runtime_supervisor
        if supervisor._serving_action or supervisor._provider_test_task:raise ApiFailure('CONFIG_BUSY')
        deadline=time.monotonic()+REQUEST_SECONDS
        async def operation():
            runtime=None
            try:
                catalog=await asyncio.to_thread(worker_request,'',request)
                rows=[r for r in catalog['runs'] if r['project_id']==project_id and r['run_id']==run_id]
                if len(rows)!=1:raise ApiFailure('SCOPE_DENIED')
                model=deepcopy(supervisor._llm_config or {})
                embedding=model.get('embedding');tested=model.get('tested',{}).get('embedding')
                if not embedding or not tested or tested['status']!='PASS':raise ApiFailure('NOT_READY')
                if (embedding['base_url'].rstrip('/')+'|'+embedding['model']!=rows[0]['model_identity']
                        or tested['dimension']!=rows[0]['dimension']):raise ApiFailure('RELEASE_MISMATCH')
                candidate=RuntimeSettings(secrets=settings.secrets,production=True,dimension=rows[0]['dimension'],
                    embedding_url=embedding['base_url'],embedding_model=embedding['model'],embedding_key=embedding['api_key'])
                initialize_runtime()
                runtime=RequestRuntime(None,None,None,deadline,supervisor._budget,body['message'],None,capability='retrieve')
                runtime.request_id=getattr(request.state,'request_id',None)
                embed=await asyncio.to_thread(_new_embedding,candidate,runtime)
                vector=await asyncio.to_thread(embed,body['message'])
                result=await asyncio.to_thread(worker_request,'/trial',request,dict(project_id=project_id,run_id=run_id,
                    model_identity=rows[0]['model_identity'],vector=vector,top_k=body['top_k'],expand=body['expand']))
                runtime.budget.response_remaining()
                return Response(contract.encode_retrieve(result),media_type='application/json',headers={'Cache-Control':'no-store'})
            finally:
                if runtime is not None:await runtime.close()
        return await supervisor.supervise(operation,deadline)

    @app.get('/v1/config')
    async def configuration(request: Request):
        authorize(request_principal(request), 'inspect', None)
        if request.query_params or request.headers.get('transfer-encoding') or request.headers.get('content-length', '0') != '0':
            raise ApiFailure('INVALID_REQUEST')
        from .inspection import validate_config
        snapshot = app.state.config_snapshot
        project = dict(snapshot['project'])
        if (type(app.state.serving_release) is artifacts.ServingRelease
                and app.state.serving_release.release_id == project['release_id']):
            project['release_state'] = 'LOADED'
        return validate_config(dict(snapshot, project=project, solver=app.state.solver_defaults))

    @app.get('/v1/config/retrieval')
    async def chat_retrieval_configuration(request: Request):
        authorize(request_principal(request), 'inspect', None)
        if request.query_params or request.headers.get('transfer-encoding') or request.headers.get('content-length', '0') != '0':
            raise ApiFailure('INVALID_REQUEST')
        supervisor = getattr(app.state, 'runtime_supervisor', None)
        if supervisor is None:
            raise ApiFailure('NOT_READY')
        return supervisor.chat_config_view()

    @app.get('/v1/config/models')
    async def llm_configuration(request: Request):
        authorize(request_principal(request), 'inspect', None)
        if request.query_params or request.headers.get('transfer-encoding') or request.headers.get('content-length', '0') != '0':
            raise ApiFailure('INVALID_REQUEST')
        supervisor = getattr(app.state, 'runtime_supervisor', None)
        if supervisor is None:
            raise ApiFailure('NOT_READY')
        return supervisor.llm_config_view()

    @app.post('/v1/config/models')
    async def save_llm_configuration(request: Request):
        authorize(request_principal(request), 'credentials-write', None)
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        change = contract.LLMCredentialsChange.from_json(await bounded_body(request))
        supervisor = getattr(app.state, 'runtime_supervisor', None)
        if supervisor is None:
            raise ApiFailure('NOT_READY')
        return supervisor.save_llm_config(change)

    @app.post('/v1/config/models/{role}/{action}')
    async def model_action(request: Request, role: str, action: str):
        if role not in ('chat', 'embedding') or action not in ('test', 'apply') or request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        principal = request_principal(request)
        authorize(principal, 'provider-test' if action == 'test' else 'config-apply', None)
        change = contract.ChatConfigChange.from_json(await bounded_body(request))
        if change.values is not None:
            raise ApiFailure('INVALID_REQUEST')
        supervisor = getattr(app.state, 'runtime_supervisor', None)
        if supervisor is None:
            raise ApiFailure('NOT_READY')
        if action == 'test':
            return await supervisor.test_llm_config(role, change.revision, app.state.provider_test_policy)
        app.state.runtime_settings = supervisor.apply_llm_config(role, change.revision,
            app.state.runtime_settings, app.state.serving_release, app.state.provider_test_policy)
        return supervisor.llm_config_view()

    @app.post('/v1/config/retrieval/{action}')
    async def change_chat_retrieval(request: Request, action: str):
        authorize(request_principal(request), 'inspect', None)
        # A read-only inspection credential alone cannot change runtime defaults.
        tokens = request.headers.getlist('x-kag-config-query-authorization')
        if len(tokens) > 1:
            raise ApiFailure('AUTH_INVALID')
        authorize(authenticate(tokens[0] if tokens else None, settings.secrets), 'query', None)
        if request.query_params or action not in ('save', 'apply', 'restore'):
            raise ApiFailure('INVALID_REQUEST')
        change = contract.ChatConfigChange.from_json(await bounded_body(request))
        supervisor = getattr(app.state, 'runtime_supervisor', None)
        if supervisor is None:
            raise ApiFailure('NOT_READY')
        return supervisor.change_chat_config(action, change)

    @app.get('/v1/pipeline/status')
    async def pipeline_status(request: Request):
        authorize(request_principal(request), 'inspect', None)
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        from .inspection import pipeline_view
        return pipeline_view(getattr(app.state, 'runtime_supervisor', None))

    @app.get('/v1/benchmark/datasets')
    async def benchmark_datasets(request: Request):
        authorize(request_principal(request), 'inspect', None)
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        from .inspection import dataset_catalog
        return await asyncio.to_thread(dataset_catalog, app.state.evaluation_root)

    @app.get('/v1/graph/release')
    async def graph_release(request: Request):
        principal = request_principal(request)
        authorize(principal,'query' if 'query' in principal.scopes else 'inspect',None)
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        release = app.state.serving_release
        if type(release) is not artifacts.ServingRelease:
            raise ApiFailure('RELEASE_UNAVAILABLE')
        try:
            await asyncio.to_thread(artifacts._unchanged,release)
        except Exception:
            raise ApiFailure('RELEASE_UNAVAILABLE') from None
        return artifacts.release_view(release)

    if enable_sample_routes:
        @app.get('/v1/operations/sample')
        async def sample_inspection(request: Request):
            authorize(request_principal(request),'inspect',None)
            if request.query_params:raise ApiFailure('INVALID_REQUEST')
            release,settings=app.state.serving_release,app.state.runtime_settings
            supervisor=getattr(app.state,'runtime_supervisor',None)
            if type(release) is not artifacts.ServingRelease or settings is None or supervisor is None:
                raise ApiFailure('NOT_READY')
            value=await supervisor.sample_inspect(request,settings,release)
            sample_guard(request,release,settings)
            request.state.authority_guard=lambda:sample_guard(request,release,settings)
            raw=artifacts.canonical_json(value).encode('utf-8')
            if len(raw)>245760:raise ApiFailure('RESULT_LIMIT_EXCEEDED')
            return Response(raw,media_type='application/json',headers={'X-KAG-Release-ID':release.release_id})

    async def verified_query(request: Request, *, stream=False):
        from . import runtime as core
        release, settings = app.state.serving_release, app.state.runtime_settings
        supervisor = getattr(app.state,'runtime_supervisor',None)
        if (type(release) is not artifacts.ServingRelease or settings is None or supervisor is None):
            await admit_request(request,'query')
            if request.query_params:
                raise ApiFailure('INVALID_REQUEST')
            raise ApiFailure('RELEASE_UNAVAILABLE' if type(release) is not artifacts.ServingRelease else 'NOT_READY')
        if settings.secrets != app.state.http_settings.secrets:
            await admit_request(request,'query')
            raise ApiFailure('NOT_READY')

        async def finalize(instance, result, parsed):
            def identity():
                instance.budget.response_remaining()
                if core._today() != instance.as_of:
                    raise ApiFailure('DATE_BOUNDARY_CHANGED')
                selected = app.state.serving_release
                if type(selected) is not artifacts.ServingRelease:
                    raise ApiFailure('RELEASE_UNAVAILABLE')
                if selected.schema_contract != release.schema_contract:
                    raise ApiFailure('SCHEMA_CONTRACT_MISMATCH')
                if selected.descriptor['source_snapshot_id'] != release.descriptor['source_snapshot_id']:
                    raise ApiFailure('SOURCE_SNAPSHOT_MISMATCH')
                if (selected.release_id != release.release_id or selected.descriptor_sha256 != release.descriptor_sha256
                        or app.state.runtime_settings != settings):
                    raise ApiFailure('RELEASE_MISMATCH')
                try:
                    raw,identity=artifacts.release_contract(release.schema_contract.namespace,production=release.release_kind=='PRODUCTION')
                    if identity!=release.schema_contract or raw!=release.contract_bytes:
                        raise ApiFailure('SCHEMA_CONTRACT_MISMATCH')
                    if artifacts._read(release.root,'release.json') != dict(release.artifacts)['release.json']:
                        raise ApiFailure('RELEASE_MISMATCH')
                    core._identity(request,settings,release,parsed,instance.as_of)
                except core.RuntimeFailure as exc:
                    raise ApiFailure(exc.code) from None
                except artifacts.ArtifactFailure as exc:
                    raise ApiFailure('RELEASE_UNAVAILABLE' if exc.state is artifacts.VerificationState.UNAVAILABLE
                                     else 'SOURCE_VALIDATION_FAILED') from None
                except OSError:
                    raise ApiFailure('RELEASE_UNAVAILABLE') from None
                instance.budget.response_remaining()

            def sources():
                identity()
                try:
                    verified = artifacts.verify_native_sources(result,release,instance.reader,
                        instance.as_of,settings.webapp_snapshot_id,question=parsed.message)
                except artifacts.ArtifactFailure as exc:
                    identity()
                    if exc.state is artifacts.VerificationState.UNAVAILABLE:
                        raise ApiFailure('BACKEND_UNAVAILABLE') from None
                    raise ApiFailure(exc.code if exc.code == 'INVALID_NATIVE_RESULT' else 'SOURCE_VALIDATION_FAILED') from None
                if (verified.state is not artifacts.VerificationState.VERIFIED
                        or verified.publication_state is not artifacts.VerificationState.VERIFIED
                        or (verified.release_id,verified.source_snapshot_id,verified.schema_contract,
                            verified.release_descriptor_sha256,verified.as_of,verified.webapp_snapshot_id)
                        != (release.release_id,settings.source_snapshot_id,release.schema_contract,
                            release.descriptor_sha256,instance.as_of,settings.webapp_snapshot_id)):
                    raise ApiFailure('SOURCE_VALIDATION_FAILED')
                identity()
                return verified

            def verified_bytes():
                verified = sources()
                payload = contract.project_v1(result,verified,namespace=release.schema_contract.namespace)
                try:
                    raw = contract.encode_v1(payload)
                except ApiFailure as exc:
                    if exc.code == 'V1_RESULT_UNREPRESENTABLE':
                        raise ApiFailure('RESULT_LIMIT_EXCEEDED') from None
                    raise
                if stream:
                    raw = b'event: done\ndata: '+raw+b'\n\n'
                    if len(raw) > 245760:
                        raise ApiFailure('RESULT_LIMIT_EXCEEDED')
                if sources() != verified:
                    raise ApiFailure('SOURCE_VALIDATION_FAILED')
                request.state.authority_guard = identity
                source_header=('X-KAG-Source-Snapshot-ID',settings.source_snapshot_id) if artifacts.dataset_sources(release) else (
                    'X-WebApp-Snapshot-ID',settings.webapp_snapshot_id)
                return raw, {'X-KAG-Release-ID':release.release_id,
                    source_header[0]:source_header[1],'X-KAG-As-Of':instance.as_of.isoformat()},instance.as_of
            return await asyncio.to_thread(verified_bytes)

        watching = True
        async def disconnected():
            while watching:
                if (hasattr(request.state,'delegated_user_id') and await request.is_disconnected()):
                    return True
                await asyncio.sleep(.02)

        operation = asyncio.create_task(supervisor.query(request,settings,release,
            finalize=finalize,factory=app.state.runtime_factory))
        watcher = asyncio.create_task(disconnected())
        try:
            done,_ = await asyncio.wait({operation,watcher},return_when=asyncio.FIRST_COMPLETED)
            if watcher in done and watcher.result():
                raise asyncio.CancelledError
            raw,headers,as_of = operation.result()
            if core._today() != as_of:
                raise ApiFailure('DATE_BOUNDARY_CHANGED')
            if time.monotonic() >= request.state.request_deadline:
                raise ApiFailure('QUERY_TIMEOUT')
            request.state.query_verified, request.state.query_as_of = True, as_of
            if stream:
                headers['X-Accel-Buffering'] = 'no'
                return Response(raw,media_type='text/event-stream',headers=headers)
            return Response(raw,media_type='application/json',headers=headers)
        except core.RuntimeFailure as exc:
            raise ApiFailure(exc.code) from None
        finally:
            watching = False
            for task in (operation,watcher):
                if not task.done():
                    task.cancel()
            await asyncio.gather(operation,watcher,return_exceptions=True)

    @app.post('/v1/query')
    async def query(request: Request):
        return await verified_query(request)

    if enable_sample_routes:
        @app.post('/v1/retrieve/vector')
        async def sample_vector(request: Request):
            release, runtime_settings = app.state.serving_release, app.state.runtime_settings
            supervisor = getattr(app.state,'runtime_supervisor',None)
            if type(release) is not artifacts.ServingRelease or runtime_settings is None or supervisor is None:
                await admit_request(request,'inspect',contract.SampleVectorRequest)
                raise ApiFailure('NOT_READY')

            async def finalize(instance,result,parsed):
                def verified():
                    sample_guard(request,release,runtime_settings)
                    _verify_retrieve_items(result,release,instance.reader)
                    raw = contract.encode_retrieve({'contract_version':'h1-sample-vector-1.0',
                        'request_id':request.state.request_id,'release_id':release.release_id,'release_kind':'SAMPLE',
                        'source_snapshot_id':runtime_settings.source_snapshot_id,
                        'schema_contract':asdict(release.schema_contract),'evidence_id':parsed.evidence_id,
                        'production_write':'blocked','items':result})
                    sample_guard(request,release,runtime_settings)
                    request.state.authority_guard = lambda:sample_guard(request,release,runtime_settings)
                    return raw
                return await asyncio.to_thread(verified)

            operation = asyncio.create_task(supervisor.sample_vector(request,runtime_settings,release,finalize=finalize))
            async def disconnected():
                while not operation.done():
                    if getattr(request,'_stream_consumed',False) and await request.is_disconnected():
                        return True
                    await asyncio.sleep(.02)
                return False
            watcher = asyncio.create_task(disconnected())
            try:
                done,_ = await asyncio.wait({operation,watcher},return_when=asyncio.FIRST_COMPLETED)
                if watcher in done and watcher.result():
                    raise asyncio.CancelledError
                raw = await operation
                request.state.retrieve_verified = True
                return Response(raw,media_type='application/json',headers={'X-KAG-Release-ID':release.release_id})
            finally:
                if not operation.done():
                    operation.cancel()
                watcher.cancel()
                await asyncio.gather(operation,watcher,return_exceptions=True)

        @app.post('/v1/query/stream')
        async def query_stream(request: Request):
            return await verified_query(request,stream=True)

        @app.post('/v1/retrieve')
        async def retrieve(request: Request):
            from . import runtime as core
            release, settings = app.state.serving_release, app.state.runtime_settings
            supervisor = getattr(app.state,'runtime_supervisor',None)
            if type(release) is not artifacts.ServingRelease or settings is None or supervisor is None:
                await admit_request(request,'inspect',contract.RetrieveRequest)
                if request.query_params:
                    raise ApiFailure('INVALID_REQUEST')
                raise ApiFailure('RELEASE_UNAVAILABLE' if type(release) is not artifacts.ServingRelease else 'NOT_READY')
            if settings.secrets != app.state.http_settings.secrets:
                await admit_request(request,'inspect',contract.RetrieveRequest)
                raise ApiFailure('NOT_READY')

            async def finalize(instance, result, parsed):
                def identity():
                    instance.budget.response_remaining()
                    selected = app.state.serving_release
                    if type(selected) is not artifacts.ServingRelease:
                        raise ApiFailure('RELEASE_UNAVAILABLE')
                    if selected.schema_contract != release.schema_contract:
                        raise ApiFailure('SCHEMA_CONTRACT_MISMATCH')
                    if selected.descriptor['source_snapshot_id'] != release.descriptor['source_snapshot_id']:
                        raise ApiFailure('SOURCE_SNAPSHOT_MISMATCH')
                    if (selected.release_id != release.release_id or selected.descriptor_sha256 != release.descriptor_sha256
                            or app.state.runtime_settings != settings or app.state.http_settings.secrets != settings.secrets):
                        raise ApiFailure('RELEASE_MISMATCH')
                    try:
                        if artifacts._read(release.root,'release.json') != dict(release.artifacts)['release.json']:
                            raise ApiFailure('RELEASE_MISMATCH')
                        core._identity(request,settings,release,parsed,capability='retrieve')
                    except core.RuntimeFailure as exc:
                        raise ApiFailure(exc.code) from None
                    except artifacts.ArtifactFailure as exc:
                        raise ApiFailure('BACKEND_UNAVAILABLE' if exc.state is artifacts.VerificationState.UNAVAILABLE
                                         else 'SOURCE_VALIDATION_FAILED') from None
                    instance.budget.response_remaining()

                def sources():
                    identity()
                    try:
                        artifacts._backend(instance.reader,release)
                        artifacts._readback(instance.reader,release.records,artifacts._json(release.contract_bytes))
                        _verify_retrieve_items(result,release,instance.reader)
                        artifacts._backend(instance.reader,release)
                        artifacts._unchanged(release)
                    except artifacts.ArtifactFailure as exc:
                        raise ApiFailure('BACKEND_UNAVAILABLE' if exc.state is artifacts.VerificationState.UNAVAILABLE
                                         else 'SOURCE_VALIDATION_FAILED') from None
                    identity()

                def verified_bytes():
                    sources()
                    payload = {'contract_version':'h1-read-v1.1','request_id':request.state.request_id,
                        'release_id':release.release_id,'source_snapshot_id':settings.source_snapshot_id,
                        'schema_contract':asdict(release.schema_contract),'items':result}
                    raw = contract.encode_retrieve(payload)
                    sources()
                    request.state.authority_guard = identity
                    return raw
                return await asyncio.to_thread(verified_bytes)

            watching = True
            async def disconnected():
                while watching:
                    if getattr(request,'_stream_consumed',False) and await request.is_disconnected():
                        return True
                    await asyncio.sleep(.02)
            operation = asyncio.create_task(supervisor.retrieve(request,settings,release,
                finalize=finalize,factory=app.state.runtime_factory))
            watcher = asyncio.create_task(disconnected())
            try:
                done,_ = await asyncio.wait({operation,watcher},return_when=asyncio.FIRST_COMPLETED)
                if watcher in done and watcher.result():
                    raise asyncio.CancelledError
                raw = operation.result()
                if time.monotonic() >= request.state.request_deadline:
                    raise ApiFailure('QUERY_TIMEOUT')
                request.state.retrieve_verified = True
                return Response(raw,media_type='application/json',headers={'X-KAG-Release-ID':release.release_id})
            except core.RuntimeFailure as exc:
                raise ApiFailure(exc.code) from None
            finally:
                watching = False
                for task in (operation,watcher):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(operation,watcher,return_exceptions=True)

    return app
