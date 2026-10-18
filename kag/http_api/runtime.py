"""Request-owned Core adapter. Live serving remains denied without operational proof.

No HTTP inference routes, provider probes, registry registrations or write clients.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from copy import deepcopy
from datetime import datetime
import inspect
import logging
import math
import os
import re
import stat
from pathlib import Path
import platform
import sys
import threading
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

from .app import ApiSettings
from .artifacts import (ArtifactFailure, ServingRelease, VerificationState,
                        _backend, _json, _readback, _unchanged, load_sample_proof,
                        verify_sample_backend, sample_source_vector)
from .contract import ApiFailure, RetrieveRequest, SampleVectorRequest
from .security import admit_request, authorize, request_principal

REQUEST_SECONDS = 25.0
TRANSPORT_SECONDS = 5.0
CHAT_CONFIG_PATH = Path('/provider-state/admin-config.json')
LLM_CONFIG_PATH = Path('/provider-state/llm-credentials.json')
_CURRENT = ContextVar('kag_admitted_runtime', default=None)


class RuntimeFailure(Exception):
    """Fixed internal errors; public HTTP mapping belongs to Step5."""
    _ERRORS = {
        'CONCURRENCY_LIMIT': (429, 'Request capacity unavailable.'),
        'SCHEMA_CONTRACT_MISMATCH': (409, 'Contract identity mismatch.'),
        'RELEASE_MISMATCH': (409, 'Release identity mismatch.'),
        'SOURCE_SNAPSHOT_MISMATCH': (409, 'Source snapshot identity mismatch.'),
        'DATE_MISMATCH': (409, 'Request date mismatch.'),
        'PROVIDER_ERROR': (502, 'Inference unavailable.'),
    }

    def __init__(self, code):
        self.status, self.message = self._ERRORS[code]
        self.code = code
        self.retry_after = 1 if code == 'CONCURRENCY_LIMIT' else None
        super().__init__(self.message)


@dataclass(frozen=True, repr=False)
class RuntimeSettings(ApiSettings):
    """Trusted process configuration, separate from request DTOs and env secrets."""
    release_id: str | None = None
    source_snapshot_id: str | None = None
    webapp_snapshot_id: str | None = None
    reader_username: str | None = None
    reader_password: str | None = None
    embedding_url: str | None = None
    embedding_model: str | None = None
    embedding_key: str | None = None
    chat_url: str | None = None
    chat_model: str | None = None
    chat_key: str | None = None
    chat_response_model: str | None = None
    sample_proof_sha256: str | None = None
    broker_url: str | None = None
    broker_token: str | None = None
    query_proof_sha256: str | None = None
    provider_gateway: str | None = None
    provider_gateway_token: str | None = None
    attempt_ledger: str | None = None
    development_policy: dict | None = None


class _Budget:
    def __init__(self, deadline, clock=time.monotonic):
        if type(deadline) not in (float,int) or not math.isfinite(deadline):
            raise ApiFailure('NOT_READY')
        self.deadline, self.clock = deadline, clock
        self.stopped = threading.Event()
        self.finished = False
        self.transport_seconds = TRANSPORT_SECONDS

    def remaining(self):
        if self.finished:
            raise ApiFailure('NOT_READY')
        return self.response_remaining()

    def response_remaining(self):
        left = self.deadline-self.clock()
        if self.stopped.is_set() or left <= 0:
            raise ApiFailure('QUERY_TIMEOUT')
        return left

    def stop(self):
        self.stopped.set()


class _ReaderBoundary:
    def __init__(self, opener, budget):
        self.opener, self.budget = opener, budget

    def open(self, request, *, timeout):
        return self.opener.open(request,timeout=min(timeout,TRANSPORT_SECONDS,self.budget.remaining()))

    def close(self):
        close = getattr(self.opener,'close',None)
        if callable(close):
            close()


def _timeout(request, budget):
    remaining = min(getattr(budget,'transport_seconds',TRANSPORT_SECONDS),budget.remaining())
    request.extensions['timeout'] = {'connect':min(2.0,remaining),
        'read':remaining,'write':remaining,'pool':remaining}


class _DeadlineTransport(httpx.BaseTransport):
    def __init__(self, transport, budget):
        self.transport, self.budget = transport, budget

    def handle_request(self, request):
        _timeout(request,self.budget)
        return self.transport.handle_request(request)

    def close(self):
        self.transport.close()


class _AsyncDeadlineTransport(httpx.AsyncBaseTransport):
    def __init__(self, transport, budget):
        self.transport, self.budget = transport, budget

    async def handle_async_request(self, request):
        _timeout(request,self.budget)
        return await self.transport.handle_async_request(request)

    async def aclose(self):
        await self.transport.aclose()


def _guard_sdk(model, budget):
    # SDK retries and proxy mounts must all traverse the same request deadline.
    for name, client_type, guard in (('client',httpx.Client,_DeadlineTransport),
                                     ('aclient',httpx.AsyncClient,_AsyncDeadlineTransport)):
        sdk = getattr(model,name)
        client = sdk._client
        if not isinstance(client,client_type):
            raise ApiFailure('NOT_READY')
        client._transport = guard(client._transport,budget)
        client._mounts = {pattern:guard(transport,budget) if transport else None
                          for pattern,transport in client._mounts.items()}


def initialize_runtime():
    """Bootstrap identity only; no dependency construction or remote probe."""
    if (sys.version_info[:3] != (3,10,16) or platform.system() != 'Linux'
            or platform.machine() != 'x86_64'):
        raise ApiFailure('NOT_READY')
    from kag.bootstrap import initialize
    initialize()
    from kag.common.registry import Registrable
    from kag.solver.pipeline.kag_iterative_pipeline import KAGIterativePipeline
    vendor = Path(__file__).resolve().parents[2]/'vendor/KAG'
    if any(not Path(inspect.getfile(cls)).resolve().is_relative_to(vendor)
           for cls in (Registrable,KAGIterativePipeline)):
        raise ApiFailure('NOT_READY')
    for name, logger in logging.Logger.manager.loggerDict.items():
        if isinstance(logger,logging.Logger) and name.startswith(('kag.','knext.','openai','httpx','httpcore')):
            logger.disabled = True


def _today():
    return datetime.now(ZoneInfo('Asia/Saigon')).date()


def _require_configuration(settings, *, capability='query'):
    if type(settings) is not RuntimeSettings or capability not in ('query','retrieve','retrieve-vector'):
        raise ApiFailure('NOT_READY')
    if settings.development_policy is not None and not settings.query_proof_sha256:
        raise ApiFailure('NOT_READY')
    if settings.query_proof_sha256 and capability in ('query','retrieve'):
        _require_configuration(settings,capability='retrieve-vector')
        fields=('embedding_url','embedding_model','embedding_key','chat_url','chat_model','chat_key',
                'provider_gateway','provider_gateway_token','attempt_ledger','query_proof_sha256')
        for name in fields+(('webapp_snapshot_id',) if capability=='query' else ()):
            value=getattr(settings,name)
            if type(value) is not str or not value.strip() or len(value)>4096:raise ApiFailure('NOT_READY')
        return
    if capability == 'retrieve-vector':
        credentials=('broker_url','broker_token') if settings.broker_url else ('reader_username','reader_password')
        for name in ('release_id','source_snapshot_id','sample_proof_sha256',*credentials):
            value = getattr(settings,name)
            if type(value) is not str or not value.strip() or len(value) > 4096:
                raise ApiFailure('NOT_READY')
        if settings.broker_url:
            if settings.reader_username is not None or settings.reader_password is not None:
                raise ApiFailure('NOT_READY')
        elif settings.reader_username.lower() in ('neo4j','root','admin') or settings.reader_password.lower() in ('dummy','abc123'):
            raise ApiFailure('NOT_READY')
        return
    query_only = {'webapp_snapshot_id','chat_url','chat_model','chat_key'} if capability=='retrieve' else set()
    for name in RuntimeSettings.__dataclass_fields__:
        if name not in ('secrets','sample_proof_sha256','broker_url','broker_token','query_proof_sha256',
                         'provider_gateway','provider_gateway_token','attempt_ledger','development_policy','chat_response_model') and name not in query_only:
            value = getattr(settings,name)
            if type(value) is not str or not value.strip() or len(value) > 4096:
                raise ApiFailure('NOT_READY')
    for name in ('embedding_key','reader_password') if capability=='retrieve' else ('embedding_key','chat_key','reader_password'):
        if getattr(settings,name).lower() in ('dummy','abc123'):
            raise ApiFailure('NOT_READY')
    for name in ('embedding_url',) if capability=='retrieve' else ('embedding_url','chat_url'):
        url = httpx.URL(getattr(settings,name))
        if url.scheme not in ('http','https') or not url.host or url.userinfo or url.query or url.fragment:
            raise ApiFailure('NOT_READY')


def _require_operational_proof(settings, release, *, capability='query'):
    if capability == 'retrieve-vector':
        return load_sample_proof(release,settings.sample_proof_sha256,settings.reader_username)
    if settings.query_proof_sha256:
        from .sample_query import load_proof
        from .provider_budget import BudgetError
        try:
            return load_proof(settings,release,capability=capability)
        except BudgetError:
            raise ApiFailure('NOT_READY') from None
    # shortcut: no independent operational attestation available; authorize it separately before live serving.
    raise ArtifactFailure(VerificationState.UNVERIFIED)


def _identity(request, settings, release, parsed, as_of=None, *, capability='query'):
    if type(release) is not ServingRelease:
        raise ApiFailure('NOT_READY')
    if parsed.schema_contract != release.schema_contract:
        raise RuntimeFailure('SCHEMA_CONTRACT_MISMATCH')
    if release.release_id != settings.release_id:
        raise RuntimeFailure('RELEASE_MISMATCH')
    if release.descriptor['source_snapshot_id'] != settings.source_snapshot_id:
        raise RuntimeFailure('SOURCE_SNAPSHOT_MISMATCH')
    if capability in ('retrieve','retrieve-vector'):
        if request.headers.getlist('x-kag-release-id') != [settings.release_id]:
            raise RuntimeFailure('RELEASE_MISMATCH')
        try:
            _unchanged(release)
        except OSError:
            raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
        return None
    as_of = _today() if as_of is None else as_of
    for name, expected, code in (
            ('x-kag-release-id',settings.release_id,'RELEASE_MISMATCH'),
            ('x-webapp-snapshot-id',settings.webapp_snapshot_id,'SOURCE_SNAPSHOT_MISMATCH'),
            ('x-kag-as-of',as_of.isoformat(),'DATE_MISMATCH')):
        values = request.headers.getlist(name)
        if values != [expected]:
            raise RuntimeFailure(code)
    publication = release.publication
    from .artifacts import publication_covers
    if (publication is None or publication['snapshot_id'] != settings.webapp_snapshot_id
            or not publication_covers(publication,as_of) or not release.records):
        raise ApiFailure('NOT_READY')
    try:
        _unchanged(release)
    except OSError:
        raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
    return as_of


@dataclass
class RequestRuntime:
    reader: object
    retriever: object
    pipeline: object
    deadline: float
    budget: _Budget = field(repr=False)
    question: str = field(repr=False)
    as_of: object
    sdk_models: list = field(default_factory=list,repr=False)
    closed: bool = False
    capability: str = 'query'
    request_id: str | None = None
    chat_retrieval: dict | None = None

    async def close(self):
        if self.closed:
            return
        self.budget.finished = True
        failed = False
        clients = [getattr(model,name,None) for model in self.sdk_models for name in ('client','aclient')]
        clients.append(self.reader if callable(getattr(self.reader,'close',None))
                       else getattr(self.reader,'_opener',None))
        for client in clients:
            close = getattr(client,'close',None)
            if callable(close):
                try:
                    result = close()
                    if inspect.isawaitable(result):
                        await result
                except Exception:
                    failed = True
        self.closed = not failed
        if failed:
            raise ApiFailure('INTERNAL_ERROR')


def _new_reader(settings, release, budget):
    if settings.broker_url:
        from .community import BrokerRetrievalClient
        proof=load_sample_proof(release,settings.sample_proof_sha256,None)
        if proof['broker_url']!=settings.broker_url or settings.reader_username or settings.reader_password:
            raise ApiFailure('NOT_READY')
        reader=BrokerRetrievalClient(release,proof,settings.broker_token,timeout=TRANSPORT_SECONDS)
        reader._opener=_ReaderBoundary(reader._opener,budget)
        return reader
    from kag.retriever.neo4j import Neo4jRetrievalClient
    reader = Neo4jRetrievalClient(release.backend['reader_endpoint'],release.descriptor['database'],
        username=settings.reader_username,password=settings.reader_password,namespace=release.schema_contract.namespace,
        timeout=TRANSPORT_SECONDS)
    reader._opener = _ReaderBoundary(reader._opener,budget)
    return reader


def _sdk_instance(cls, runtime, **kwargs):
    from kag.common.rate_limiter import RATE_LIMITER_MANGER, SYNC_RATE_LIMITER_MANAGER
    managers = (RATE_LIMITER_MANGER,SYNC_RATE_LIMITER_MANAGER)
    key = kwargs.get('name') or cls.generate_key(**kwargs)
    before = [key in manager.limiter_map for manager in managers]
    # Upstream embedding __new__ caches globally; allocate its exact class per request.
    model = object.__new__(cls)
    runtime.sdk_models.append(model)
    try:
        cls.__init__(model,**kwargs)
    finally:
        for manager, existed, attribute in zip(managers,before,('limiter','sync_limiter')):
            if not existed and manager.limiter_map.get(key) is getattr(model,attribute,None):
                manager.limiter_map.pop(key,None)
    _guard_sdk(model,runtime.budget)
    return model


def _embedding_response_metadata(response):
    import base64,json
    response.read()
    try:
        body=response.json()
        rows=body.get('data') if type(body) is dict else None
        value=rows[0].get('embedding') if type(rows) is list and rows and type(rows[0]) is dict else None
        dimension=len(value) if type(value) is list else len(base64.b64decode(value,validate=True))//4 if type(value) is str else None
    except (ValueError,TypeError):
        value=None;dimension=None
    print('SAMPLE_EMBEDDING '+json.dumps(dict(status=response.status_code,
        embedding_type=type(value).__name__,dimension=dimension)),flush=True)


def _new_embedding(settings, runtime):
    from kag.common.vectorize_model.openai_model import OpenAIVectorizeModel
    model = _sdk_instance(OpenAIVectorizeModel,runtime,model=settings.embedding_model,
        api_key=settings.embedding_key,base_url=settings.embedding_url,
        vector_dimensions=3072,timeout=TRANSPORT_SECONDS)
    if settings.query_proof_sha256:
        from .sample_query import configure_model
        configure_model(settings,model,'embedding',component='kag.'+getattr(runtime,'capability','query'),request_id=getattr(runtime,'request_id',None))
        _guard_sdk(model,runtime.budget)
        model.client._client.event_hooks['response'].append(_embedding_response_metadata)
    def embed(question):
        # Vendor vectorize swallows SDK errors and logs source text; keep its guarded client.
        import json
        from kag.vector_contract import valid_vector
        try:
            runtime.budget.remaining()
            response=model.client.embeddings.create(input=question,model=settings.embedding_model)
            vector=response.data[0].embedding if len(response.data)==1 else None
            if not valid_vector(vector,3072):
                raise ValueError('INVALID_VECTOR')
            runtime.budget.remaining()
            return vector
        except Exception as exc:
            print('SAMPLE_EMBEDDING_FAILURE '+json.dumps({'error_type':type(exc).__name__}),flush=True)
            runtime.budget.remaining()
            raise RuntimeFailure('PROVIDER_ERROR') from None
    return embed


def _new_llm(settings, runtime):
    from kag.common.llm.openai_client import OpenAIClient
    model = _sdk_instance(OpenAIClient,runtime,name='kag-'+uuid4().hex,model=settings.chat_model,
        api_key=settings.chat_key,base_url=settings.chat_url,enable_check=False,timeout=TRANSPORT_SECONDS)
    if settings.query_proof_sha256:
        from .sample_query import configure_model, provider_budget, response_model_matches
        configure_model(settings,model,'chat',component='kag.query',request_id=runtime.request_id)
        _guard_sdk(model,runtime.budget)
        responses=[]
        def response_metadata(response):
            import json
            response.read()
            try:
                body=response.json();observed_model=body.get('model')
            except (ValueError,AttributeError,IndexError,TypeError):observed_model=None
            accepted=response_model_matches(settings,observed_model)
            safe_model=observed_model if observed_model in (settings.chat_model,settings.chat_response_model,'gemini-3.8-flash-n') else 'UNVERIFIED'
            responses.append({'status':response.status_code,'model_matches_config':observed_model==settings.chat_model,
                'observed_model':safe_model,'route_version_matches_policy':accepted,
                'attempts':provider_budget(settings).counts()})
            Path('/tmp/sample-provider-responses.json').write_text(json.dumps(responses,ensure_ascii=False),encoding='utf-8')
            print('SAMPLE_PROVIDER '+json.dumps({'status':response.status_code,
                'model_matches_config':observed_model==settings.chat_model,'observed_model':safe_model,
                'route_version_matches_policy':accepted,
                'attempts':provider_budget(settings).counts()}),flush=True)
            if response.is_success and not accepted:
                from .provider_budget import BudgetError
                raise BudgetError('PROVIDER_RESPONSE_MODEL_MISMATCH')
        model.client._client.event_hooks['response'].append(response_metadata)
        async def async_response_metadata(response):
            await response.aread()
            response_metadata(response)
        model.aclient._client.event_hooks['response'].append(async_response_metadata)
        original=model.invoke
        def observed(variables,prompt_op,**kwargs):
            import json
            name=type(prompt_op).__name__
            print('SAMPLE_STAGE '+json.dumps({'stage':name,'state':'start','attempts':provider_budget(settings).counts()}),flush=True)
            try:
                result=original(variables,prompt_op,**kwargs)
            except Exception as exc:
                print('SAMPLE_STAGE '+json.dumps({'stage':name,'state':'error','type':type(exc).__name__,
                    'attempts':provider_budget(settings).counts()}),flush=True)
                raise
            print('SAMPLE_STAGE '+json.dumps({'stage':name,'state':'parsed','result_type':type(result).__name__,
                'executors':[getattr(task,'executor',None) if getattr(task,'executor',None) in ('Retriever','Deduce','Finish')
                             else 'UNVERIFIED' for task in result] if type(result) is list else None,
                'attempts':provider_budget(settings).counts()}),flush=True)
            return result
        model.invoke=observed
    return model


def make_runtime(settings: ApiSettings, release: ServingRelease, deadline: float) -> RequestRuntime:
    """Only the supervisor's authenticated, verified request may reach constructors."""
    ticket = _CURRENT.get()
    if ticket is None or (ticket[0] is not settings or ticket[1] is not release
                          or ticket[2].deadline != deadline):
        raise ApiFailure('NOT_READY')
    runtime = ticket[2]
    if runtime.capability not in ('query','retrieve'):
        raise ApiFailure('NOT_READY')
    runtime.budget.remaining()
    _unchanged(release)
    from kag.retriever.retriever import Retriever
    if settings.query_proof_sha256:
        from .sample_query import load_proof,cached_vector
        _,cache,_=load_proof(settings,release,capability=runtime.capability)
        fallback=None
        def embed(question):
            nonlocal fallback
            vector=cached_vector(cache,question)
            if vector is not None:return vector
            if fallback is None:fallback=_new_embedding(settings,runtime)
            return fallback(question)
    else:
        embed = _new_embedding(settings,runtime)
    runtime.budget.remaining()
    if runtime.capability=='query':
        from kag.legal_solver import build_pipeline
        llm = _new_llm(settings,runtime)
        runtime.budget.remaining()
    runtime.retriever = Retriever(runtime.reader,embed,_json(release.contract_bytes))
    if runtime.capability=='query':
        runtime.pipeline = build_pipeline(runtime.retriever,llm,retrieval=runtime.chat_retrieval)
        if settings.query_proof_sha256:
            from .provider_budget import disable_instance_retries
            disable_instance_retries(runtime.pipeline,llm)
    return runtime


def _query_failure_diagnostic(exc):
    """Keep exception provenance without messages, prompts, responses or locals."""
    import traceback
    root = Path(__file__).resolve().parents[2]
    def frames(error):
        result = []
        for frame in traceback.extract_tb(error.__traceback__):
            try:
                filename = Path(frame.filename).relative_to(root).as_posix()
            except ValueError:
                continue
            if filename.startswith(('kag/', 'vendor/KAG/kag/')):
                result.append(dict(file=filename, line=frame.lineno, function=frame.name))
        return result[-12:]
    value = dict(error_type=type(exc).__name__, frames=frames(exc), inner_errors=[])
    seen = {id(exc)}
    inner = exc.__cause__ if exc.__cause__ is not None else exc.__context__
    while inner is not None and id(inner) not in seen and len(value['inner_errors']) < 4:
        seen.add(id(inner))
        locations = frames(inner)
        stage, category = 'invocation', 'INVOCATION_FAILED'
        if any(f['file'] == 'kag/legal_prompts.py' for f in locations):
            stage = 'legal_parse'
            category = ('LEGAL_SUBQUERY_REJECTED' if any(f['function'] == 'validate_subquery' for f in locations)
                        else 'LEGAL_RESPONSE_INVALID')
        elif any(f['file'].startswith('vendor/KAG/kag/common/llm/') for f in locations):
            stage, category = 'model_call', 'MODEL_CALL_FAILED'
        elif any(f['function'] in ('call_with_json_parse', 'acall_with_json_parse') for f in locations):
            stage, category = 'json_parse', 'JSON_PARSE_FAILED'
        value['inner_errors'].append(dict(type=type(inner).__name__, stage=stage, category=category, frames=locations))
        inner = inner.__cause__ if inner.__cause__ is not None else inner.__context__
    return value


async def run_query(runtime: RequestRuntime, question: str, as_of):
    runtime.budget.remaining()
    if runtime.closed or question != runtime.question or as_of != runtime.as_of:
        raise ApiFailure('NOT_READY')
    from kag.legal_solver import aanswer
    try:
        result = await aanswer(question,pipeline=runtime.pipeline,as_of=as_of)
    except Exception as exc:
        import json
        print('SAMPLE_QUERY_FAILURE '+json.dumps(_query_failure_diagnostic(exc)),flush=True)
        runtime.budget.remaining()
        raise RuntimeFailure('PROVIDER_ERROR') from None
    runtime.budget.remaining()
    return result


async def run_retrieve(runtime: RequestRuntime, question: str, top_k=10, expand=False):
    runtime.budget.remaining()
    if runtime.closed or question != runtime.question:
        raise ApiFailure('NOT_READY')
    try:
        result = await asyncio.to_thread(runtime.retriever.retrieve,question,top_k=top_k,expand=expand)
    except Exception:
        runtime.budget.remaining()
        raise RuntimeFailure('PROVIDER_ERROR') from None
    runtime.budget.remaining()
    return result


class RuntimeSupervisor:
    """One process-owned slot; cancellation never cancels an in-flight Core task."""
    def __init__(self):
        self._task, self._budget = None, None
        self.closed = self.draining = False
        self._chat_config = None
        self._chat_error = None
        self._chat_persisted = False
        self._llm_config = None
        self._llm_error = None
        self._llm_secrets = ()
        self._llm_write_allowed = False
        self._llm_test_allowed = self._llm_apply_allowed = False
        self._provider_test_task = None
        self._llm_bound = {}
        self._llm_runtime_error = None
        self._llm_base_settings = None

    def _config_storage(self, path, *, private=False, writable=True):
        root = path.parent
        info = root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or root.resolve() != root or info.st_uid != os.geteuid()
                or info.st_mode & (0o077 if private else 0o022)
                or not os.access(root, os.R_OK | os.X_OK | (os.W_OK if writable else 0))):
            raise OSError('Configuration directory unavailable')
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_nlink != 1 or info.st_mode & 0o022
                    or private and stat.S_IMODE(info.st_mode) != 0o600):
                raise OSError('Configuration file unavailable')

    def load_chat_config(self, defaults):
        from .contract import retrieval_options
        self._chat_config = None
        self._chat_error = None
        self._chat_persisted = False
        try:
            defaults = retrieval_options(defaults)
            self._config_storage(CHAT_CONFIG_PATH)
            state = {'revision': 0, 'saved': defaults, 'active': dict(defaults), 'previous': None}
            if CHAT_CONFIG_PATH.exists():
                with CHAT_CONFIG_PATH.open('rb') as stream:
                    raw = stream.read(4097)
                if len(raw) > 4096:
                    raise ValueError('Configuration too large')
                state = _json(raw)
                if (type(state) is not dict or set(state) != {'revision', 'saved', 'active', 'previous'}
                        or type(state['revision']) is not int or not 0 <= state['revision'] <= 2147483647):
                    raise ValueError('Invalid configuration')
                for key in ('saved', 'active', 'previous'):
                    if key != 'previous' or state[key] is not None:
                        state[key] = retrieval_options(state[key])
                self._chat_persisted = True
            self._chat_config = state
        except OSError:
            self._chat_error = 'CONFIG_STORAGE_UNAVAILABLE'
        except (ApiFailure, ArtifactFailure, ValueError, TypeError, KeyError):
            self._chat_error = 'CONFIG_INVALID'

    def chat_config_view(self):
        state = self._chat_config
        idle = not (self.busy or self.closed or self.draining)
        available = state is not None and self._chat_error is None and state['revision'] < 2147483647
        pending = bool(state and state['saved'] != state['active'])
        return {'contract_version': 'chat-retrieval-v1', 'revision': state['revision'] if state else 0,
                'saved': dict(state['saved']) if state else None, 'active': dict(state['active']) if state else None,
                'previous': dict(state['previous']) if state and state['previous'] is not None else None,
                'persisted': self._chat_persisted, 'pending': pending, 'runtime_idle': idle,
                'actions': {'save': available, 'apply': available and idle and pending,
                            'restore': available and idle and state['previous'] is not None},
                'error_code': self._chat_error}

    def change_chat_config(self, action, change):
        from kag.run_state import atomic_json
        if action not in ('save', 'apply', 'restore') or (action == 'save') != (change.values is not None):
            raise ApiFailure('INVALID_REQUEST')
        if self._chat_error or self._chat_config is None:
            raise ApiFailure(self._chat_error or 'CONFIG_STORAGE_UNAVAILABLE')
        state = self._chat_config
        if change.revision != state['revision'] or state['revision'] >= 2147483647:
            raise ApiFailure('CONFIG_CONFLICT')
        if action != 'save' and (self.busy or self.closed or self.draining):
            raise ApiFailure('CONFIG_BUSY')
        if not self.chat_config_view()['actions'][action]:
            raise ApiFailure('CONFIG_CONFLICT')
        updated = dict(state, revision=state['revision'] + 1)
        if action == 'save':
            updated['saved'] = dict(change.values)
        else:
            target = state['saved'] if action == 'apply' else state['previous']
            updated.update(active=dict(target), previous=dict(state['active']))
            if action == 'restore':
                updated['saved'] = dict(target)
        try:
            self._config_storage(CHAT_CONFIG_PATH)
            atomic_json(CHAT_CONFIG_PATH, updated)
        except OSError:
            raise ApiFailure('CONFIG_STORAGE_UNAVAILABLE') from None
        # One enforced worker/event loop; no await between revision check, disk commit and swap.
        self._chat_config, self._chat_persisted = updated, True
        return self.chat_config_view()

    def _validate_llm_state(self, state):
        from .contract import llm_options
        legacy = {'revision', 'chat', 'embedding'}
        if (type(state) is not dict or set(state) not in (legacy, legacy | {'role_revisions', 'tested', 'active', 'blocked'})
                or type(state['revision']) is not int or not 1 <= state['revision'] <= 2147483647):
            raise ApiFailure('INVALID_REQUEST')
        if set(state) == legacy:
            state = dict(state, role_revisions={role: state['revision'] if state[role] else None for role in ('chat','embedding')},
                         tested=dict(chat=None, embedding=None), active=dict(chat=None, embedding=None), blocked=dict(chat=None, embedding=None))
        for role in ('chat', 'embedding'):
            if state[role] is None:
                continue
            state[role] = llm_options(state[role])
            if 'api_key' not in state[role]:
                raise ApiFailure('INVALID_REQUEST')
        configured = [state[role] for role in ('chat', 'embedding') if state[role] is not None]
        if not configured:
            raise ApiFailure('INVALID_REQUEST')
        for name in ('role_revisions', 'tested', 'active', 'blocked'):
            if type(state[name]) is not dict or set(state[name]) != {'chat','embedding'}:
                raise ApiFailure('INVALID_REQUEST')
        for role in ('chat','embedding'):
            revision = state['role_revisions'][role]
            if (state[role] is None) != (revision is None) or revision is not None and (
                    type(revision) is not int or not 1 <= revision <= state['revision']):
                raise ApiFailure('INVALID_REQUEST')
            tested, active = state['tested'][role], state['active'][role]
            if tested is not None:
                self._validate_provider_test(tested, revision, role)
            if active is not None:
                if (type(active) is not dict or set(active) != {'revision','config','test'}
                        or type(active['revision']) is not int or not 1 <= active['revision'] <= state['revision']):
                    raise ApiFailure('INVALID_REQUEST')
                active['config'] = llm_options(active['config'])
                if 'api_key' not in active['config']:
                    raise ApiFailure('INVALID_REQUEST')
                self._validate_provider_test(active['test'], active['revision'], role)
                if active['test']['status'] != 'PASS':
                    raise ApiFailure('INVALID_REQUEST')
                configured.append(active['config'])
            if state['blocked'][role] is not None and state['blocked'][role] not in (
                    'TEST_REQUIRED','TEST_IN_PROGRESS','RELEASE_UNAVAILABLE','RELEASE_MISMATCH',
                    'VECTOR_IDENTITY_MISMATCH','ACTIVE_CONFIG_INVALID','PROXY_POLICY_UNVERIFIED','BLOCKED'):
                raise ApiFailure('INVALID_REQUEST')
        secrets = (*self._llm_secrets, *(item['api_key'] for item in configured))
        if (any(secret in item[field] for secret in secrets for item in configured for field in ('model', 'base_url'))
                or any(test and test['observed_model'] and secret in test['observed_model']
                    for secret in secrets for role in ('chat','embedding')
                    for test in (state['tested'][role],state['active'][role]['test'] if state['active'][role] else None))):
            raise ApiFailure('INVALID_REQUEST')
        return state

    @staticmethod
    def _validate_provider_test(value, revision, role):
        if (type(value) is not dict or set(value) != {'revision','status','code','dimension','observed_model','client_attempts','output_chars','tested_at'}
                or type(value['revision']) is not int or value['revision'] != revision
                or value['status'] not in ('PASS','FAIL','BLOCKED')
                or value['code'] not in (None,'AUTH_FAILED','MODEL_NOT_FOUND','RATE_LIMITED','PROVIDER_ERROR','BLOCKED',
                    'PROXY_POLICY_UNVERIFIED','MODEL_MISMATCH','DIMENSION_MISMATCH','INVALID_RESPONSE','TIMEOUT','NETWORK_ERROR')
                or (value['status'] == 'PASS') != (value['code'] is None)
                or type(value['client_attempts']) is not int or not 0 <= value['client_attempts'] <= 1
                or type(value['output_chars']) is not int or not 0 <= value['output_chars'] <= 262144
                or value['dimension'] is not None and (type(value['dimension']) is not int or not 0 <= value['dimension'] <= 262144)
                or value['observed_model'] is not None and (type(value['observed_model']) is not str
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}', value['observed_model']))
                or type(value['tested_at']) is not str or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00', value['tested_at'])
                or value['status'] == 'PASS' and (value['client_attempts'] != 1 or
                    (value['dimension'] is None or not 1 <= value['dimension'] <= 65536 if role == 'embedding' else value['output_chars'] < 1))):
            raise ApiFailure('INVALID_REQUEST')

    def load_llm_config(self, secrets, *, read_only=False):
        self._llm_config, self._llm_error = None, None
        self._llm_secrets = (*secrets.query_tokens, *secrets.inspect_tokens, *secrets.credentials_write_tokens,
                            *secrets.provider_test_tokens, *secrets.config_apply_tokens)
        self._llm_write_allowed = bool(secrets.credentials_write_tokens)
        self._llm_test_allowed, self._llm_apply_allowed = bool(secrets.provider_test_tokens), bool(secrets.config_apply_tokens)
        self._llm_bound, self._llm_runtime_error = {}, None
        try:
            self._config_storage(LLM_CONFIG_PATH, private=True, writable=not read_only)
            if LLM_CONFIG_PATH.exists():
                with LLM_CONFIG_PATH.open('rb') as stream:
                    raw = stream.read(65537)
                if len(raw) > 65536:
                    raise ValueError('Configuration too large')
                self._llm_config = self._validate_llm_state(_json(raw))
        except OSError:
            self._llm_error = 'CONFIG_STORAGE_UNAVAILABLE'
        except (ApiFailure, ArtifactFailure, ValueError, TypeError, KeyError):
            self._llm_error = 'CONFIG_INVALID'

    def llm_config_view(self):
        state = self._llm_config
        def metadata(config):
            return ({key: config[key] for key in ('provider', 'base_url', 'model')}
                    | {'key_configured': True}) if config is not None else None
        revision = state['revision'] if state else 0
        roles = {}
        for role in ('chat','embedding'):
            saved_revision = state['role_revisions'][role] if state else None
            tested, active = (state['tested'][role], state['active'][role]) if state else (None, None)
            blocker = self._llm_runtime_error or (state['blocked'][role] if state else None)
            bound = self._llm_bound.get(role)
            applied = active is not None and active['revision'] == bound == saved_revision
            status = ('BLOCKED' if blocker else 'APPLIED' if applied else
                      'BLOCKED' if tested and tested['status'] == 'BLOCKED' else
                      'PENDING_APPLY' if tested and tested['status'] == 'PASS' else
                      'SAVED' if saved_revision else 'NOT_CONFIGURED')
            roles[role] = dict(saved_revision=saved_revision, test=deepcopy(tested), active_revision=bound,
                active=metadata(active['config']) if active else None, status=status,
                blocker=blocker or (tested['code'] if tested else None),
                actions=dict(test=bool(saved_revision and self._llm_test_allowed and not self._llm_error and self._provider_test_task is None),
                    apply=bool(saved_revision and tested and tested['status']=='PASS' and not applied and self._llm_apply_allowed
                               and not self._llm_error and not (self.busy or self.closed or self.draining or self._provider_test_task))))
        return {'contract_version': 'llm-credentials-v3', 'revision': revision, 'saved': state is not None,
                'chat': metadata(state['chat']) if state else None, 'embedding': metadata(state['embedding']) if state else None,
                'applied': any(row['status']=='APPLIED' for row in roles.values()),
                'connection_tested': any(row['test'] and row['test']['status']=='PASS' for row in roles.values()),
                'save_allowed': self._llm_write_allowed and self._llm_error is None and revision < 2147483647,
                'error_code': self._llm_error, 'roles': roles,
                'build_config': dict(state='SEPARATE', reason='BUILDER_CONFIGURATION_API')}

    def _persist_llm(self, updated):
        from kag.run_state import atomic_json
        updated = self._validate_llm_state(deepcopy(updated))
        try:
            self._config_storage(LLM_CONFIG_PATH, private=True)
            atomic_json(LLM_CONFIG_PATH, updated, mode=0o600)
        except OSError:
            raise ApiFailure('CONFIG_STORAGE_UNAVAILABLE') from None
        self._llm_config = updated

    def save_llm_config(self, change):
        if self._llm_error:
            raise ApiFailure(self._llm_error)
        state = self._llm_config
        if change.revision != (state['revision'] if state else 0) or change.revision >= 2147483647:
            raise ApiFailure('CONFIG_CONFLICT')
        updated = deepcopy(state) if state else {'chat':None, 'embedding':None,
            'role_revisions':dict(chat=None,embedding=None), 'tested':dict(chat=None,embedding=None),
            'active':dict(chat=None,embedding=None), 'blocked':dict(chat=None,embedding=None)}
        updated['revision'] = change.revision + 1
        for role in ('chat', 'embedding'):
            incoming = getattr(change, role)
            if incoming is None:
                updated[role] = dict(state[role]) if state and state[role] is not None else None
                continue
            updated[role] = dict(incoming)
            updated['role_revisions'][role] = updated['revision']
            updated['tested'][role], updated['blocked'][role] = None, None
            if 'api_key' not in updated[role] and state and state[role] is not None:
                updated[role]['api_key'] = state[role]['api_key']
        self._persist_llm(updated)
        return self.llm_config_view()

    def _llm_revision(self, role, revision):
        if self._llm_error:
            raise ApiFailure(self._llm_error)
        if (self._llm_config is None or role not in ('chat','embedding') or self._llm_config[role] is None
                or revision != self._llm_config['revision']):
            raise ApiFailure('CONFIG_CONFLICT')

    async def _run_provider_test(self, config, role, policy):
        from .provider_budget import test_provider
        return await asyncio.to_thread(test_provider, config, role, policy)

    async def test_llm_config(self, role, revision, policy):
        from datetime import timezone
        self._llm_revision(role, revision)
        if self._provider_test_task is not None:
            raise ApiFailure('CONFIG_BUSY')
        config = dict(self._llm_config[role])
        role_revision = self._llm_config['role_revisions'][role]
        updated = deepcopy(self._llm_config)
        updated['tested'][role], updated['blocked'][role] = None, 'TEST_IN_PROGRESS'
        self._persist_llm(updated)
        async def run():
            result = await self._run_provider_test(config, role, policy)
            if self._llm_config['role_revisions'][role] != role_revision:
                raise ApiFailure('CONFIG_CONFLICT')
            result.update(revision=role_revision, tested_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat())
            updated = deepcopy(self._llm_config)
            updated['tested'][role], updated['blocked'][role] = result, None
            self._persist_llm(updated)
            print('MODEL_CONFIG_ACTION role='+role+' revision='+str(role_revision)+' action=test result='+result['status'], flush=True)
            return self.llm_config_view()
        task = self._provider_test_task = asyncio.create_task(run())
        def done(finished):
            if not finished.cancelled():
                finished.exception()
            self._provider_test_task = None
        task.add_done_callback(done)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=22)
            return self.llm_config_view()
        except asyncio.TimeoutError:
            raise ApiFailure('QUERY_TIMEOUT') from None

    def _active_settings(self, settings, active):
        values = {}
        for role, item in active.items():
            if item is not None:
                # Provider Test measures any model; this serving consumer still requires 3072 dimensions.
                if role == 'embedding' and item['test']['dimension'] != 3072:
                    raise RuntimeFailure('RELEASE_MISMATCH')
                config = item['config']
                values.update({role+'_url':config['base_url'], role+'_model':config['model'], role+'_key':config['api_key']})
                if role == 'chat':
                    values['chat_response_model'] = item['test']['observed_model']
        return replace(settings, **values)

    def restore_llm_runtime(self, settings, release, policy=None):
        self._llm_base_settings = settings
        self._llm_bound, self._llm_runtime_error = {}, None
        if self._llm_error:
            return None
        active = self._llm_config['active'] if self._llm_config else {}
        if not any(active.values()):
            return settings
        try:
            from .provider_budget import BudgetError, provider_route
            for role, item in active.items():
                if item is not None:
                    provider_route(item['config'], role, policy)
            candidate = self._active_settings(settings, active)
            capability = 'query' if active.get('chat') else 'retrieve'
            _require_configuration(candidate, capability=capability)
            _require_operational_proof(candidate, release, capability=capability)
        except (ApiFailure, ArtifactFailure, RuntimeFailure, BudgetError, ValueError, TypeError, OSError):
            self._llm_runtime_error = 'ACTIVE_CONFIG_INVALID'
            return None
        self._llm_bound = {role:item['revision'] for role,item in active.items() if item is not None}
        return candidate

    def apply_llm_config(self, role, revision, settings, release, policy):
        from .provider_budget import BudgetError, provider_route
        self._llm_revision(role, revision)
        if self.busy or self.closed or self.draining or self._provider_test_task:
            raise ApiFailure('CONFIG_BUSY')
        updated = deepcopy(self._llm_config)
        tested = updated['tested'][role]
        blocker = None
        base = settings if settings is not None else self._llm_base_settings
        candidate = base
        if not tested or tested['status'] != 'PASS':
            blocker = 'TEST_REQUIRED'
        elif type(release) is not ServingRelease or type(base) is not RuntimeSettings:
            blocker = 'RELEASE_UNAVAILABLE'
        else:
            try:
                active = deepcopy(updated['active'])
                active[role] = dict(revision=updated['role_revisions'][role], config=dict(updated[role]), test=dict(tested))
                for consumer, item in active.items():
                    if item is not None:
                        provider_route(item['config'], consumer, policy)
                candidate = self._active_settings(base, active)
                capability = 'query' if active.get('chat') else 'retrieve'
                _require_configuration(candidate, capability=capability)
                _require_operational_proof(candidate, release, capability=capability)
                _unchanged(release)
            except BudgetError as error:
                blocker = error.code if error.code in ('PROXY_POLICY_UNVERIFIED','BLOCKED') else 'BLOCKED'
            except (ApiFailure, ArtifactFailure, RuntimeFailure, ValueError, TypeError, OSError):
                blocker = 'VECTOR_IDENTITY_MISMATCH' if role=='embedding' else 'RELEASE_MISMATCH'
        updated['blocked'][role] = blocker
        if blocker is None:
            updated['active'] = active
        self._persist_llm(updated)
        if blocker is None:
            self._llm_bound = {consumer:item['revision'] for consumer,item in active.items() if item is not None}
            self._llm_runtime_error = None
        print('MODEL_CONFIG_ACTION role='+role+' revision='+str(updated['role_revisions'][role])+' action=apply result='+(blocker or 'APPLIED'), flush=True)
        return settings if blocker else candidate

    @property
    def busy(self):
        return self._task is not None

    @property
    def live_ready(self):
        return False

    def readiness(self):
        return {'runtime':'blocked','sources':'unknown','admission':'blocked' if self.busy or self.closed else 'pass'}

    async def sample_inspect(self, request, settings, release):
        authorize(request_principal(request),'inspect',None)
        deadline=time.monotonic()+REQUEST_SECONDS
        request.state.request_deadline=deadline
        _require_configuration(settings,capability='retrieve-vector')
        if (type(release) is not ServingRelease or release.release_kind!='SAMPLE'
                or release.release_id!=settings.release_id or settings.secrets!=request.app.state.http_settings.secrets):
            raise ApiFailure('NOT_READY')
        if request.headers.getlist('x-kag-release-id')!=[release.release_id]:raise RuntimeFailure('RELEASE_MISMATCH')
        async def operation():
            reader=None
            try:
                _require_operational_proof(settings,release,capability='retrieve-vector')
                initialize_runtime()
                reader=await asyncio.to_thread(_new_reader,settings,release,self._budget)
                proof=await asyncio.to_thread(verify_sample_backend,release,settings.sample_proof_sha256,settings.reader_username,reader)
                from .inspection import sample_graph_view,dataset_readiness,provider_view
                value=await asyncio.to_thread(sample_graph_view,release,reader,proof)
                value['datasets']=await asyncio.to_thread(dataset_readiness,request.app.state.evaluation_root,release)
                value['providers']=provider_view(settings)
                await asyncio.to_thread(verify_sample_backend,release,settings.sample_proof_sha256,settings.reader_username,reader)
                _unchanged(release)
                return value
            finally:
                if reader is not None:(reader if callable(getattr(reader,'close',None)) else reader._opener).close()
        return await self.supervise(operation,deadline)

    async def sample_ready(self, request, settings, release, *, capability):
        deadline=time.monotonic()+REQUEST_SECONDS
        request.state.request_deadline=deadline
        _require_configuration(settings,capability=capability)
        async def operation():
            reader=None
            try:
                from .artifacts import publication_covers
                if capability=='query' and (type(release) is not ServingRelease or not publication_covers(release.publication,_today())):
                    raise ApiFailure('NOT_READY')
                proof,_,_=await asyncio.to_thread(_require_operational_proof,settings,release,capability=capability)
                initialize_runtime()
                reader=await asyncio.to_thread(_new_reader,settings,release,self._budget)
                await asyncio.to_thread(verify_sample_backend,release,settings.sample_proof_sha256,None,reader)
                from .sample_query import verify_gateway
                await asyncio.to_thread(verify_gateway,settings,proof)
                _unchanged(release)
                return {'status':'ready','capability':'query-v1' if capability=='query' else 'retrieve',
                    'checks':dict(auth='pass',runtime='pass',sources='pass',admission='pass'),
                    'release_kind':'SAMPLE','release_id':release.release_id,'provider_transport':'metadata_verified',
                    'production_write':'blocked'}
            finally:
                if reader is not None:
                    (reader if callable(getattr(reader,'close',None)) else reader._opener).close()
        return await self.supervise(operation,deadline)

    def _done(self, task):
        if not task.cancelled():
            task.exception()
        self._task = self._budget = None
        self.draining = False

    async def supervise(self, operation, deadline):
        if self.closed:
            raise ApiFailure('NOT_READY')
        if self.busy:
            raise RuntimeFailure('CONCURRENCY_LIMIT')
        budget = _Budget(deadline)
        budget.remaining()
        self._budget = budget

        async def run():
            try:
                return await operation()
            except (ApiFailure,RuntimeFailure):
                raise
            except Exception:
                raise ApiFailure('INTERNAL_ERROR') from None

        task = self._task = asyncio.create_task(run())
        task.add_done_callback(self._done)
        try:
            done, _ = await asyncio.wait({task},timeout=budget.remaining())
            if not done:
                budget.stop()
                self.draining = True
                raise ApiFailure('QUERY_TIMEOUT')
            budget.response_remaining()
            return task.result()
        except asyncio.CancelledError:
            budget.stop()
            self.draining = not task.done()
            raise

    async def query(self, request, settings, release, *, finalize=None, factory=None):
        # Entry precedes body consumption, so upload and every subsequent gate share 25s.
        deadline = time.monotonic()+(180.0 if settings.query_proof_sha256 else REQUEST_SECONDS)
        received_date = _today()
        request.state.request_deadline = deadline
        parsed = await admit_request(request,'query')
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        if _today() != received_date:
            raise ApiFailure('DATE_BOUNDARY_CHANGED')
        try:
            _require_configuration(settings)
        except (ValueError,httpx.InvalidURL):
            raise ApiFailure('NOT_READY') from None

        async def operation():
            runtime = RequestRuntime(None,None,None,deadline,self._budget,parsed.message,None)
            if self._chat_error:
                raise ApiFailure('NOT_READY')
            if self._chat_config is not None:
                runtime.chat_retrieval = dict(self._chat_config['active'])
            runtime.request_id=getattr(request.state,'request_id',None)
            token = None
            meter_context = None
            try:
                as_of = await asyncio.to_thread(_identity,request,settings,release,parsed,received_date)
                runtime.as_of = as_of
                if settings.query_proof_sha256:runtime.budget.transport_seconds=60.0
                runtime.budget.remaining()
                _require_operational_proof(settings,release)
                initialize_runtime()
                from kag.interface.common.llm_client import LLMCallCcontext, TokenMeterFactory
                meter_context = LLMCallCcontext('kag-'+uuid4().hex,True)
                meter_context.__enter__()
                runtime.reader = await asyncio.to_thread(_new_reader,settings,release,runtime.budget)
                def preflight():
                    runtime.budget.remaining()
                    if settings.query_proof_sha256:
                        verify_sample_backend(release,settings.sample_proof_sha256,None,runtime.reader)
                        from .sample_query import load_proof,verify_gateway
                        proof,_,_=load_proof(settings,release)
                        verify_gateway(settings,proof)
                    _backend(runtime.reader,release)
                    _readback(runtime.reader,release.records,_json(release.contract_bytes))
                    _backend(runtime.reader,release)
                    _unchanged(release)
                    runtime.budget.remaining()
                await asyncio.to_thread(preflight)
                if _today() != as_of:
                    raise ApiFailure('DATE_BOUNDARY_CHANGED')
                token = _CURRENT.set((settings,release,runtime))
                runtime = await asyncio.to_thread(factory or make_runtime,settings,release,deadline)
                if _today() != as_of:
                    raise ApiFailure('DATE_BOUNDARY_CHANGED')
                result = await run_query(runtime,parsed.message,as_of)
                if settings.query_proof_sha256:
                    await asyncio.to_thread(verify_sample_backend,release,settings.sample_proof_sha256,None,runtime.reader)
                    from dataclasses import asdict
                    import json
                    Path('/tmp/sample-answer.json').write_text(json.dumps(asdict(result),ensure_ascii=False),encoding='utf-8')
                return result if finalize is None else await finalize(runtime,result,parsed)
            finally:
                if token is not None:
                    _CURRENT.reset(token)
                try:
                    try:
                        await runtime.close()
                    finally:
                        if meter_context is not None:
                            try:
                                TokenMeterFactory().remove_meter(meter_context.task_id)
                            finally:
                                meter_context.__exit__(None,None,None)
                except Exception:
                    self.closed = True
                    raise ApiFailure('INTERNAL_ERROR') from None

        return await self.supervise(operation,deadline)

    async def retrieve(self, request, settings, release, *, finalize=None, factory=None):
        deadline = time.monotonic()+REQUEST_SECONDS
        request.state.request_deadline = deadline
        parsed = await admit_request(request,'inspect',RetrieveRequest)
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        try:
            _require_configuration(settings,capability='retrieve')
        except (ValueError,httpx.InvalidURL):
            raise ApiFailure('NOT_READY') from None

        async def operation():
            runtime = RequestRuntime(None,None,None,deadline,self._budget,parsed.message,None,
                                     capability='retrieve')
            runtime.request_id=getattr(request.state,'request_id',None)
            token = None
            try:
                await asyncio.to_thread(_identity,request,settings,release,parsed,capability='retrieve')
                runtime.budget.remaining()
                _require_operational_proof(settings,release,capability='retrieve')
                initialize_runtime()
                runtime.reader = await asyncio.to_thread(_new_reader,settings,release,runtime.budget)
                def integrity():
                    runtime.budget.remaining()
                    if settings.query_proof_sha256:
                        verify_sample_backend(release,settings.sample_proof_sha256,None,runtime.reader)
                    _backend(runtime.reader,release)
                    _readback(runtime.reader,release.records,_json(release.contract_bytes))
                    _backend(runtime.reader,release)
                    _unchanged(release)
                    runtime.budget.remaining()
                await asyncio.to_thread(integrity)
                token = _CURRENT.set((settings,release,runtime))
                runtime = await asyncio.to_thread(factory or make_runtime,settings,release,deadline)
                result = await run_retrieve(runtime,parsed.message,parsed.top_k,parsed.expand)
                await asyncio.to_thread(integrity)
                return result if finalize is None else await finalize(runtime,result,parsed)
            finally:
                if token is not None:
                    _CURRENT.reset(token)
                try:
                    await runtime.close()
                except Exception:
                    self.closed = True
                    raise ApiFailure('INTERNAL_ERROR') from None

        return await self.supervise(operation,deadline)

    async def sample_vector(self, request, settings, release, *, ready=False, finalize=None):
        deadline = time.monotonic()+REQUEST_SECONDS
        request.state.request_deadline = deadline
        if ready:
            authorize(request_principal(request),'inspect',None)
        parsed = None if ready else await admit_request(request,'inspect',SampleVectorRequest)
        if not ready and request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        _require_configuration(settings,capability='retrieve-vector')
        if settings.secrets != request.app.state.http_settings.secrets:
            raise ApiFailure('NOT_READY')

        async def operation():
            runtime = RequestRuntime(None,None,None,deadline,self._budget,'',None,capability='retrieve-vector')
            try:
                if ready:
                    if (type(release) is not ServingRelease or release.release_id != settings.release_id
                            or release.descriptor['source_snapshot_id'] != settings.source_snapshot_id
                            or request.headers.getlist('x-kag-release-id') != [settings.release_id]):
                        raise ApiFailure('NOT_READY')
                else:
                    _identity(request,settings,release,parsed,capability='retrieve-vector')
                _require_operational_proof(settings,release,capability='retrieve-vector')
                initialize_runtime()
                runtime.reader = await asyncio.to_thread(_new_reader,settings,release,runtime.budget)
                def integrity():
                    runtime.budget.response_remaining()
                    verify_sample_backend(release,settings.sample_proof_sha256,settings.reader_username,runtime.reader)
                    runtime.budget.response_remaining()
                await asyncio.to_thread(integrity)
                if ready:
                    result = {'status':'ready','capability':'retrieve-vector','release_kind':'SAMPLE',
                              'release_id':release.release_id,'provider_transport':'not_probed','production_write':'blocked'}
                else:
                    from kag.retriever.retriever import Retriever
                    vector = await asyncio.to_thread(sample_source_vector,release,runtime.reader,parsed.evidence_id)
                    runtime.retriever = Retriever(runtime.reader,None,_json(release.contract_bytes))
                    result = await asyncio.to_thread(runtime.retriever.retrieve_vector,vector,
                                                    top_k=parsed.top_k,expand=parsed.expand)
                    await asyncio.to_thread(integrity)
                return result if finalize is None else await finalize(runtime,result,parsed)
            finally:
                try:
                    await runtime.close()
                except Exception:
                    self.closed = True
                    raise ApiFailure('INTERNAL_ERROR') from None
        return await self.supervise(operation,deadline)

    async def close(self):
        self.closed = True
        if self._budget is not None:
            self._budget.stop()
        if self._provider_test_task is not None:
            await asyncio.shield(asyncio.gather(self._provider_test_task, return_exceptions=True))
        task = self._task
        if task is not None:
            try:
                await asyncio.shield(task)
            except (ApiFailure,RuntimeFailure):
                pass
            finally:
                if task.done() and self._task is task:
                    self._done(task)
