"""Read-only worker jobs around the unchanged evaluation adapters."""
import asyncio
from collections import Counter
from contextlib import contextmanager, nullcontext
from copy import deepcopy
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import threading
import time
from uuid import uuid4
from types import SimpleNamespace

from .contract import ApiFailure
from .inspection import dataset_catalog, _files
from kag.evaluation.dataset import load_dataset, canonical_dataset_bytes, sha256, utc_now, strict_json
from kag.evaluation.models import EvaluationProtocol, EvaluationRun
from kag.evaluation.evaluate import evaluate_g1, evaluate_g2
from kag.evaluation.report import start_run, write_report, replace_manifest
from kag.run_state import atomic_json


def subset(dataset, records):
    # Only records selected from the already load_dataset-verified source reach here.
    raw = canonical_dataset_bytes(records)
    return replace(dataset, records=tuple(records), canonical_bytes=raw, dataset_hash=sha256(raw),
                   official_benchmark=dataset.official_benchmark and raw == dataset.canonical_bytes)


def check_access(project_id, token):
    from kag.builder.projects import selected_target
    selected_target(project_id, token, for_write=False)


@contextmanager
def graph_session(change, token):
    from kag.builder.serving import _run_directory, _record, model_store
    from kag.builder.structure import target_state
    from kag.retriever.neo4j import Neo4jRetrievalClient
    from kag.http_api.read_broker import _BoundedOpener
    from kag.http_api.artifacts import release_contract
    from kag.run_state import GraphLock
    from kag.verify import verify_graph
    check_access(change['project_id'],token)
    path, receipt = _run_directory(change['run_id'], change['project_id'])
    identity = receipt['identity']
    models = model_store()._llm_config or {}
    active = deepcopy(models.get('active', {}))
    embedding = active.get('embedding')
    if not embedding:
        raise ApiFailure('NOT_READY')
    config, test = embedding['config'], embedding['test']
    if (config['base_url'].rstrip('/')+'|'+config['model'] != identity['model_identity']
            or test['dimension'] != identity['dimension']):
        raise ApiFailure('RELEASE_MISMATCH')
    if change['mode'] != 'G1' and not active.get('chat'):
        raise ApiFailure('NOT_READY')
    with target_state(change['project_id'], token, for_write=False) as state:
        target, proof = state['target'], state['proof']
        if (proof.physical_database_id != identity['database_id']
                or any(target[k] != identity[k] for k in ('project_id','project_name','database','namespace','endpoints'))):
            raise ApiFailure('RELEASE_MISMATCH')
        lock = GraphLock(os.environ.get('KAG_BUILDER_LOCK_ROOT','/run/kag-locks'), proof.physical_database_id,
            dict(run_id='benchmark-'+change['run_id'], scope='PRODUCTION',
                 **{k:target[k] for k in ('project_id','namespace','database')}),
            backend_proof=proof, backend_session=state['identity'])
        lock.acquire()
        reader = None
        try:
            contract = json.loads(release_contract(identity['namespace'], production=True)[0])
            reader = Neo4jRetrievalClient(target['endpoints']['neo4j_http'], target['database'],
                username=os.environ['KAG_NEO4J_USERNAME'], password=os.environ['KAG_NEO4J_PASSWORD'],
                namespace=target['namespace'], dimension=identity['dimension'], timeout=5)
            reader._opener = _BoundedOpener()
            def check():
                lock.assert_owned(proof.physical_database_id)
                state['identity'].validate(proof)
                if _record(path) != receipt:
                    raise ApiFailure('SOURCE_VALIDATION_FAILED')
            def verify():
                check()
                if verify_graph(reader,db_path=path/'expected.sqlite3',contract=contract,batch_size=32) != receipt['stages']['verify']:
                    raise ApiFailure('SOURCE_VALIDATION_FAILED')
                check()
            verify()
            yield dict(reader=reader, contract=contract, active=active, dimension=identity['dimension'],
                       check=check,verify=verify, fingerprint=receipt['stages']['verify']['fingerprint'])
        finally:
            if reader is not None:
                reader._opener.close()
            lock.release()


@contextmanager
def question_runtime(graph, mode, job):
    from kag.http_api.runtime import (RuntimeSettings, RequestRuntime, _Budget, REQUEST_SECONDS, BENCHMARK_TRANSPORT_SECONDS,
                                      _new_embedding, _new_llm, initialize_runtime,_ReaderBoundary)
    from kag.http_api.provider_budget import ProviderBudget,disable_instance_retries
    from kag.retriever.retriever import Retriever
    from kag.legal_solver import build_pipeline
    initialize_runtime()
    embedding = graph['active']['embedding']['config']
    chat = graph['active'].get('chat')
    config = chat['config'] if chat else {}
    settings = RuntimeSettings(production=True, dimension=graph['dimension'],
        embedding_url=embedding['base_url'], embedding_model=embedding['model'], embedding_key=embedding['api_key'],
        chat_url=config.get('base_url'), chat_model=config.get('model'), chat_key=config.get('api_key'),
        chat_response_model=chat['test'].get('observed_model') or config.get('model') if chat else None)
    deadline = time.monotonic()+REQUEST_SECONDS
    runtime = RequestRuntime(None,None,None,deadline,_Budget(deadline),'',None,capability='benchmark')
    runtime.budget.transport_seconds = BENCHMARK_TRANSPORT_SECONDS
    attempts = job['directory']/'provider-attempts'
    attempts.mkdir(exist_ok=True)
    runtime.provider_budget = ProviderBudget(attempts/f'{mode}-{job["index"]}.json',
        embedding_url=embedding['base_url']+'/embeddings', embedding_model=embedding['model'],
        chat_url=config.get('base_url',embedding['base_url'])+'/chat/completions',
        # Benchmark authorization permits unlimited attempts; gateway/binding/retry guards remain.
        chat_model=config.get('model',embedding['model']), limits=dict(embedding=None,chat=None),development_only=True)
    runtime.provider_budget.source_component='kag.benchmark'
    runtime.request_id=job['value']['run_id_job']
    runtime.provider_budget.request_id=runtime.request_id
    opener=graph['reader']._opener
    graph['reader']._opener=_ReaderBoundary(opener,runtime.budget,transport_seconds=BENCHMARK_TRANSPORT_SECONDS)
    try:
        retriever = Retriever(graph['reader'], _new_embedding(settings,runtime,timeout=BENCHMARK_TRANSPORT_SECONDS), graph['contract'])
        pipeline = None
        if mode == 'G2':
            llm = _new_llm(settings,runtime,timeout=BENCHMARK_TRANSPORT_SECONDS)
            pipeline = build_pipeline(retriever,llm)
            disable_instance_retries(pipeline,llm)
        elif retriever.namespace != 'VietRoadTraffic':
            # G1's unchanged wire validator uses the logical namespace; public IDs/ranks stay exact.
            native_retrieve, prefix = retriever.retrieve, retriever.namespace+'.'
            def retrieve(*args,**kwargs):
                return [dict(item,entity_type='VietRoadTraffic.'+item['entity_type'][len(prefix):])
                        if item['entity_type'].startswith(prefix) else item for item in native_retrieve(*args,**kwargs)]
            retriever = SimpleNamespace(search_k=retriever.search_k,retrieve=retrieve)
        yield retriever, pipeline
    finally:
        graph['reader']._opener=opener
        try:
            counts = runtime.provider_budget.counts()
            with job['guard']:
                for kind, count in counts.items():
                    job['value']['provider_requests'][kind] += count
        finally:
            asyncio.run(runtime.close())


class BenchmarkRunner:
    def __init__(self, root):
        self.root = Path(root) if root else None
        self.job = None
        self.task = None
        self.admission = asyncio.Lock()
        self.closed = False
        if self.root and self.root.is_dir() and not self.root.is_symlink():
            for path in self._job_paths():
                try:
                    value = self._read(path/'run_manifest.json')
                    if value['state'] == 'RUNNING':
                        value.update(state='FAILED',code='INTERRUPTED',finished_at=utc_now())
                        atomic_json(path/'run_manifest.json',value)
                        self._repair_manifests(path)
                except (ApiFailure,OSError,ValueError,KeyError,TypeError):
                    # An interrupted directory creation must not disable unrelated jobs.
                    continue

    def _roots(self):
        if not self.root or not self.root.is_absolute() or self.root.is_symlink() or not self.root.is_dir():
            raise ApiFailure('NOT_READY')
        return [p.parent/'runs' if p.parent != self.root else self.root/(p.name+'.runs') for p in _files(self.root)]

    def _job_paths(self):
        for root in self._roots():
            if root.is_symlink():
                continue
            if root.is_dir():
                for path in root.iterdir():
                    if re.fullmatch('[0-9a-f]{32}',path.name) and path.is_dir() and not path.is_symlink():
                        yield path

    @staticmethod
    def _read(path):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 2*1024*1024:
            raise ApiFailure('NOT_READY')
        return json.loads(path.read_bytes())

    @staticmethod
    def _repair_manifests(directory):
        for path in directory.rglob('run_manifest.json'):
            if path.parent == directory or any(p.is_symlink() for p in (path,*path.parents)):
                continue
            try:
                value = BenchmarkRunner._read(path)
                if value.get('status') == 'RUNNING':
                    atomic_json(path,dict(value,status='ERROR',error_code='RUN_ABORTED',finished_at=utc_now()))
            except (ApiFailure,OSError,ValueError,TypeError):
                continue

    def _prepare(self, change, token):
        if type(change) is not dict or set(change) != {'dataset_id','project_id','run_id','mode','limit'}:
            raise ApiFailure('INVALID_REQUEST')
        if (type(change['project_id']) is not int or not 1 <= change['project_id'] <= 2147483647
                or type(change['run_id']) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',change['run_id'])
                or change['mode'] not in ('G1','G2','BOTH')):
            raise ApiFailure('INVALID_REQUEST')
        catalog = dataset_catalog(self.root)
        matches = [r for r in catalog['datasets'] if r['id'] == change['dataset_id'] and r['dataset_hash']]
        if len(matches) != 1:
            raise ApiFailure('INVALID_REQUEST')
        path = self.root/change['dataset_id']
        if any(p.is_symlink() for p in (path,path.parent,self.root)):
            raise ApiFailure('INVALID_REQUEST')
        dataset = load_dataset(path)
        if dataset.dataset_hash != matches[0]['dataset_hash']:
            raise ApiFailure('CONFIG_CONFLICT')
        limit = change['limit']
        if limit is not None and (type(limit) is not int or not 1 <= limit <= len(dataset.records)):
            raise ApiFailure('INVALID_REQUEST')
        selected = subset(dataset,dataset.records[:limit])
        session = graph_session(change,token)
        graph = session.__enter__()
        try:
            roots = path.parent/'runs' if path.parent != self.root else self.root/(path.name+'.runs')
            if roots.is_symlink():
                raise ApiFailure('INVALID_REQUEST')
            roots.mkdir(exist_ok=True)
            job_id = uuid4().hex
            directory = roots/job_id
            directory.mkdir()
            modes = ('G1','G2') if change['mode'] == 'BOTH' else (change['mode'],)
            frozen_at = self._read(path.with_name('eval_questions.manifest.json'))['frozen_at'] if dataset.manifest_verified else None
            value = dict(run_id_job=job_id,dataset_id=change['dataset_id'],project_id=change['project_id'],run_id=change['run_id'],
                state='RUNNING',mode=change['mode'],done=0,total=len(selected.records)*len(modes),
                progress={mode:dict(done=0,total=len(selected.records)) for mode in modes},
                started_at=utc_now(),finished_at=None,code=None,metrics=None,
                dataset_status=dataset.records[0].dataset_status,dataset_hash=dataset.dataset_hash,frozen_at=frozen_at,
                category_counts=dict(Counter(r.category for r in selected.records)),graph_fingerprint=graph['fingerprint'],
                provider_requests=dict(embedding=0,chat=0))
            atomic_json(directory/'run_manifest.json',value)
            return dict(value=value,directory=directory,dataset=selected,session=session,graph=graph,
                        stop=threading.Event(),guard=threading.RLock(),index=0)
        except BaseException:
            session.__exit__(None,None,None)
            raise

    async def start(self, change, token):
        async with self.admission:
            if self.closed or self.task is not None and not self.task.done():
                raise ApiFailure('CONFIG_BUSY')
            preparing = asyncio.create_task(asyncio.to_thread(self._prepare,change,token))
            try:
                self.job = await asyncio.shield(preparing)
            except asyncio.CancelledError:
                prepared = await preparing
                self._abort_prepared(prepared)
                raise
            if self.closed:
                self._abort_prepared(self.job)
                raise ApiFailure('CONFIG_BUSY')
            self.task = asyncio.create_task(asyncio.to_thread(self._execute,self.job))
            return dict(run_id_job=self.job['value']['run_id_job'])

    @staticmethod
    def _abort_prepared(job):
        try:
            job['session'].__exit__(None,None,None)
        finally:
            job['value'].update(state='STOPPED',finished_at=utc_now())
            atomic_json(job['directory']/'run_manifest.json',job['value'])

    def _execute(self, job):
        value, directory, dataset = job['value'], job['directory'], job['dataset']
        reports = {}
        final_state, code = 'FAILED', 'EXECUTION_ERROR'
        protocol = EvaluationProtocol(metric_policy_version='1.1',identity_catalog_hash=None,judge_config=None)
        try:
            for mode in value['progress']:
                rows, records = [], []
                for index, record in enumerate(dataset.records):
                    if job['stop'].is_set():
                        break
                    job['graph']['check']()
                    job['index'] = index
                    runtime = nullcontext((None,None)) if mode == 'G2' and record.as_of is None else question_runtime(job['graph'],mode,job)
                    with runtime as (retriever,pipeline):
                        target = directory/'questions'/mode/str(index)
                        single = subset(dataset,(record,))
                        run = (evaluate_g1(single,retriever,protocol,output_dir=target) if mode == 'G1'
                               else evaluate_g2(single,pipeline,protocol,output_dir=target))
                    rows.extend(run.rows)
                    records.append(record)
                    with job['guard']:
                        value['progress'][mode]['done'] += 1
                        value['done'] += 1
                        atomic_json(directory/'run_manifest.json',value)
                if rows:
                    context = start_run(subset(dataset,records),protocol,mode,directory/mode)
                    combined = EvaluationRun(context,tuple(rows))
                    write_report(combined,context.output_dir)
                    if len(rows) != len(dataset.records):
                        replace_manifest(context,dict(context.manifest,status='STOPPED'))
                    reports[mode] = self._read(directory/mode/'metrics.json')
                if job['stop'].is_set():
                    break
            job['graph'].get('verify',job['graph']['check'])()
            final_state, code = ('COMPLETE' if value['done'] == value['total'] else 'STOPPED'), None
        except Exception as error:
            from kag.run_state import RunBlocked
            from kag.builder.projects import ProjectCatalogError
            code = error.code if isinstance(error,(ApiFailure,RunBlocked,ProjectCatalogError)) else 'EXECUTION_ERROR'
            self._repair_manifests(directory)
        finally:
            try:
                job['session'].__exit__(None,None,None)
            except Exception:
                final_state, code = 'FAILED', 'LOCK'
            with job['guard']:
                value.update(state=final_state,code=code,metrics=reports or None,finished_at=utc_now())
                atomic_json(directory/'run_manifest.json',value)

    async def status(self, job_id, token):
        if type(job_id) is not str or not re.fullmatch('[0-9a-f]{32}',job_id):
            raise ApiFailure('INVALID_REQUEST')
        if self.job and self.job['value']['run_id_job'] == job_id:
            with self.job['guard']:
                value = deepcopy(self.job['value'])
        else:
            paths = [p for p in self._job_paths() if p.name == job_id]
            if len(paths) != 1:
                raise ApiFailure('INVALID_REQUEST')
            value = await asyncio.to_thread(self._read,paths[0]/'run_manifest.json')
        await asyncio.to_thread(check_access,value['project_id'],token)
        return value

    async def stop(self, job_id, token):
        value = await self.status(job_id,token)
        if value['state'] == 'RUNNING' and self.job and self.job['value']['run_id_job'] == job_id:
            self.job['stop'].set()
        return value

    async def close(self):
        self.closed = True
        async with self.admission:
            if self.job:
                self.job['stop'].set()
            if self.task:
                await asyncio.shield(self.task)


def install_worker_routes(app):
    from fastapi import Request
    from starlette.responses import JSONResponse
    from .security import ServiceSecrets,authenticate,authorize,bounded_body
    from .server import _secret
    from kag.builder.projects import ProjectCatalogError
    from kag.run_state import RunBlocked
    from kag.evaluation.models import ValidationError
    manager = BenchmarkRunner(os.environ.get('KAG_HTTP_EVALUATION_ROOT'))
    app.state.benchmark_runner = manager
    def auth(request,write=False):
        scope = 'benchmark-write' if write else 'inspect'
        secret = _secret('KAG_HTTP_BENCHMARK_WRITE_SECRET_FILE' if write else 'KAG_HTTP_INSPECT_SECRET_FILE')
        if not secret:
            raise ApiFailure('SCOPE_DENIED')
        secrets = ServiceSecrets(**{('benchmark_write_tokens' if write else 'inspect_tokens'):(secret,)})
        headers = request.headers.getlist('authorization')
        sessions = request.headers.getlist('x-openspg-session')
        if len(headers) != 1 or len(sessions) != 1 or request.query_params:
            raise ApiFailure('INVALID_REQUEST')
        authorize(authenticate(headers[0],secrets),scope,None)
        return sessions[0]
    async def operation(action,*args):
        try:
            return await action(*args)
        except ProjectCatalogError as error:
            raise ApiFailure('SCOPE_DENIED' if error.code in ('FORBIDDEN','NOT_FOUND') else 'NOT_READY') from None
        except RunBlocked as error:
            raise ApiFailure('CONFIG_BUSY' if error.code == 'LOCK' else 'NOT_READY') from None
        except (OSError,ValueError,ValidationError,TypeError,KeyError):
            raise ApiFailure('INVALID_REQUEST') from None
    @app.post('/v1/benchmark/runs')
    async def start(request: Request):
        token = auth(request,True)
        try:
            value = strict_json((await bounded_body(request)).decode('utf-8'))
        except (ValueError,UnicodeError,ValidationError):
            raise ApiFailure('INVALID_JSON') from None
        return JSONResponse(await operation(manager.start,value,token),status_code=202)
    @app.get('/v1/benchmark/runs/{job_id}')
    async def status(job_id: str,request: Request):
        if request.headers.get('transfer-encoding') or request.headers.get('content-length','0') != '0':
            raise ApiFailure('INVALID_REQUEST')
        return await operation(manager.status,job_id,auth(request))
    @app.post('/v1/benchmark/runs/{job_id}/stop')
    async def stop(job_id: str,request: Request):
        token = auth(request,True)
        if request.headers.get('transfer-encoding') or request.headers.get('content-length','0') != '0':
            raise ApiFailure('INVALID_REQUEST')
        return await operation(manager.stop,job_id,token)
