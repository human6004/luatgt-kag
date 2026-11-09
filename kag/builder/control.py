"""One private control thread around the existing Runner; GraphLock owns graph exclusion."""
from __future__ import annotations

import asyncio
import copy
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from kag.builder.production_scope import (ProductionSettings, _input_version, _spec_hash,
    validate_source_manifest, selection_limit, selection_summary, select_bounded_sources)
from kag.http_api.contract import ApiFailure
from kag.http_api.security import ServiceSecrets, authenticate, bounded_body
from kag.run_state import MESSAGES, STAGES, RunBlocked, GraphLock, graph_lock_status, _shared_lock_root, atomic_json, validate_run_directory
from kag.runner import _clients, _config, _files, _provider, preflight as runner_preflight, run
from kag.builder.projects import read_projects, selected_target, ProjectCatalogError


def inspect_inputs(value):
    """Read configured inputs only; full Runner preflight remains authoritative."""
    result = dict(contract_version='builder-inputs-v1', configuration='NOT_CONFIGURED',
                  error_code=None, scope=None, target=None, inputs=[], preflight='NOT_RUN',
                  source_validation=dict(state='NOT_RUN',error_code=None,plan_sha256=None,nodes=None,edges=None))
    if value is None:
        return result
    try:
        config = _config(value)
        if config['scope'] not in ('FRESH_SAMPLE', 'PRODUCTION'):
            raise RunBlocked('SCOPE')
    except (ValueError, KeyError, TypeError):
        result.update(configuration='INVALID', error_code='CONFIG')
        return result
    result.update(configuration='CONFIGURED', scope=config['scope'],
                  target={key: config[key] for key in ('project_id', 'database', 'namespace')})
    for name, digest in config['input_sha256'].items():
        try:
            if not Path(config['paths'][name]).is_file():
                state = 'MISSING'
            else:
                state = 'NOT_CHECKED'
        except (OSError, ValueError):
            state = 'UNAVAILABLE'
        result['inputs'].append(dict(name=name, sha256=digest, state=state))
    return result


def read_dataset(root,group,offset,limit):
    """Page through the packaged corpus; viewing never constructs or validates a plan."""
    from kag.builder.inputs import SOURCE_FILES
    from kag.http_api.contract import encode_retrieve
    files=dict(SOURCE_FILES)
    if group not in files or type(offset) is not int or not 0<=offset<=2147483647 or type(limit) is not int or not 1<=limit<=50:
        raise ApiFailure('INVALID_REQUEST')
    path=Path(root)/files[group]
    try:
        version=_input_version(path);items=[];total=0
        with path.open('rb') as stream:
            for line in stream:
                if not line.strip():continue
                if offset<=total<offset+limit:
                    value=json.loads(line)
                    if type(value) is not dict:raise ValueError
                    items.append(value)
                total+=1
        if _input_version(path)!=version:raise ValueError
        result=dict(contract_version='builder-dataset-v1',dataset='LuậtGT',group=group,source=files[group],
            offset=offset,limit=limit,total=total,items=items)
        encode_retrieve(result)
        return result
    except (OSError,ValueError,UnicodeError):raise ApiFailure('BACKEND_UNAVAILABLE') from None


def check_source_inputs(value):
    config = _config(value)
    contract = json.loads((Path(__file__).resolve().parents[1]/'schema/schema_contract.json').read_bytes())
    data = validate_source_manifest(contract, config['paths']['c3_manifest'])
    try:
        _files(dict(config,input_sha256={'c3_manifest':config['input_sha256']['c3_manifest']}))
        result = dict(state='VALID',error_code=None,plan_sha256=data['manifest']['plan_sha256'],
                      nodes=len(data['nodes']),edges=len(data['edges']),summary=selection_summary(data))
        checks = data['file_versions']
        if config['paths'].get('selection'):
            path=Path(config['paths']['selection'])
            _files(dict(config,input_sha256={'selection':config['input_sha256']['selection']}))
            checks=(*checks,(path,_input_version(path)))
        if any(_input_version(path) != version for path, version in checks):
            raise ValueError('Source changed during validation')
        return result,checks
    finally:
        data['index'].close()


def source_cache(state_dir, manifest_path=None, expected=()):
    """Read preview metadata only; Runner still validates source content before writing."""
    from kag.builder.inputs import SOURCE_FILES
    root=Path(__file__).resolve().parents[2];state=Path(state_dir);cache=state/'source.json'
    try:
        saved=json.loads(cache.read_bytes()) if cache.exists() and manifest_path is None else None
        if saved and not re.fullmatch('[0-9a-f]{64}',saved['plan_sha256']):return None
        candidates=([Path(manifest_path)] if manifest_path is not None else
            [state/'plans'/saved['plan_sha256']/'manifest.json'] if saved else
            sorted((state/'plans').glob('*/manifest.json'),key=lambda p:p.stat().st_mtime_ns,reverse=True))
        for path in candidates:
            manifest=json.loads(path.read_bytes())
            if not re.fullmatch('[0-9a-f]{64}',path.parent.name) or manifest['plan_sha256']!=path.parent.name:continue
            names={row['name'] for row in manifest['input_manifest']}
            required={name for _,name in SOURCE_FILES}|{p.relative_to(root).as_posix() for p in (root/'data/processed/documents').glob('*.md')}
            if not required<=names:continue
            sources=[root/name for name in names]+[root/'kag/schema'/name for name in ('VietRoadTraffic.schema','schema_contract.json')]
            if any(not p.resolve().is_relative_to(root) for p in sources):continue
            paths=sorted(set(sources+[path.parent/name for name in ('manifest.json','nodes.jsonl','edges.jsonl','plan.sha256')]))
            checks=tuple((p,_input_version(p)) for p in paths)
            directory=root/'data/processed/documents'
            if directory.exists():checks=(*checks,(directory,_input_version(directory)))
            if any(dict(checks).get(p)!=version for p,version in expected):return None
            files=[[str(p),v[3],v[4]] for p,v in checks if p!=directory]
            if saved and saved['files']!=files:return None
            # Older plans have no stat cache; reuse only previews whose inputs predate the plan.
            if manifest_path is None and not saved and any(p.stat().st_mtime_ns>path.stat().st_mtime_ns for p in sources):continue
            summary=selection_summary(dict(manifest=manifest,edge_hashes=range(sum(manifest['edge_unique_counts'].values()))))
            if not saved:atomic_json(cache,dict(plan_sha256=manifest['plan_sha256'],files=files),mode=0o600)
            return (dict(state='VALID',error_code=None,plan_sha256=manifest['plan_sha256'],
                nodes=summary['nodes'],edges=summary['edges'],summary=summary),checks)
    except (OSError,ValueError,KeyError,TypeError):pass
    return None


def prepare_source_inputs(state_dir):
    """Prepare only the corpus shipped with this release; publish a complete content-addressed plan."""
    from kag.builder.graph_plan import build_graph_plan, plan_hash, write_dry_run
    from kag.builder.inputs import load_inputs
    cached=source_cache(state_dir)
    if cached:return cached
    root = Path(__file__).resolve().parents[2]
    state = Path(state_dir)
    if not state.is_absolute() or state.resolve().is_relative_to(root):
        raise ValueError('Builder state must be outside the source checkout')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    plans = state / 'plans'
    plans.mkdir(exist_ok=True)
    contract = json.loads((root / 'kag/schema/schema_contract.json').read_bytes())
    inputs = load_inputs(root, contract)
    plan = build_graph_plan(inputs, contract, project_root=root)
    destination = plans / plan_hash(plan)
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix='prepare-', dir=state) as temporary:
            output = Path(temporary) / 'plan'
            write_dry_run(plan, output)
            data = validate_source_manifest(contract, output / 'manifest.json')
            data['index'].close()
            # Rename publishes all files together; existing plans and runs remain immutable.
            output.rename(destination)
    data = validate_source_manifest(contract, destination / 'manifest.json')
    try:
        checks = data['file_versions']
        if any(_input_version(path) != version for path, version in checks):
            raise ValueError('Source changed during preparation')
        cached=source_cache(state_dir,destination/'manifest.json',checks)
        if not cached:raise ValueError('Source changed during preparation')
        return cached
    finally:
        data['index'].close()


def _builder_model(secrets):
    from kag.http_api.runtime import RuntimeSupervisor
    store = RuntimeSupervisor()
    store.load_llm_config(secrets, read_only=True)
    if store._llm_error or not store._llm_config or not store._llm_config['embedding']:
        raise RunBlocked('CONFIG')
    state = store._llm_config
    return dict(revision=state['role_revisions']['embedding'], config=state['embedding'], test=state['tested']['embedding'])


def _builder_policy():
    from kag.http_api.server import provider_test_policy
    try:
        return provider_test_policy()
    except (OSError,ValueError,RuntimeError):
        raise RunBlocked('CONFIG') from None


def _builder_target():
    """Deployment grants the target; HTTP requests never choose a network or filesystem path."""
    try:
        target = dict(project_id=int(os.environ['KAG_BUILDER_PROJECT_ID']),
            project_name=os.environ['KAG_BUILDER_PROJECT_NAME'], database=os.environ['KAG_BUILDER_DATABASE'],
            namespace=os.environ.get('KAG_BUILDER_NAMESPACE','VietRoadTraffic'), runtime_location=os.environ.get('KAG_BUILDER_RUNTIME_LOCATION','container'),
            endpoints=dict(openspg=os.environ['KAG_BUILDER_OPENSPG_URL'],
                neo4j_http=os.environ['KAG_BUILDER_NEO4J_HTTP'], neo4j_uri=os.environ['KAG_BUILDER_NEO4J_URI']))
        # Target syntax only; scope discovery separately binds the actual plan before any write.
        ProductionSettings(scope='PRODUCTION',runtime_location=target['runtime_location'],
            host_addr=target['endpoints']['openspg'],neo4j_uri=target['endpoints']['neo4j_uri'],
            project_name=target['project_name'],namespace=target['namespace'],expected_project_id=target['project_id'],
            vector_dimensions=3072,confirmation=f'CONFIRM_PRODUCTION:{target["project_name"]}:{target["namespace"]}:{target["project_id"]}:{"0"*64}').validate()
        if (not 1<=target['project_id']<=2147483647 or len(target['project_name'])>255
                or not re.fullmatch(r'[a-z][a-z0-9.-]{0,62}',target['database'])):raise ValueError
        return target
    except (KeyError, ValueError):
        raise RunBlocked('CONFIG') from None


def _builder_config(state_dir, target, model, revision, batch_size, request_limit, node_limit=None, scope_preview=None, *, plan_sha256, vector_package=None):
    config = json.loads((Path(__file__).resolve().parents[1]/'config/runner.example.json').read_bytes())
    if not isinstance(plan_sha256,str) or not re.fullmatch('[0-9a-f]{64}',plan_sha256):raise RunBlocked('PLAN')
    manifest = Path(state_dir)/'plans'/plan_sha256/'manifest.json'
    config.update(target, scope='PRODUCTION', write_mode='WRITE', vector_policy='provider', batch_size=batch_size,
        vector_dimensions=model['test']['dimension'],
        request_limit=request_limit, model_identity=model['config']['base_url'].rstrip('/')+'|'+model['config']['model'],
        embedding_model=dict(type='openai', base_url=model['config']['base_url'],model=model['config']['model'],timeout=60),
        confirmation=f'CONFIRM_PRODUCTION:{target["project_name"]}:{target["namespace"]}:{target["project_id"]}:{plan_sha256}')
    config['paths'] = {name:None for name in config['paths']}
    config['paths'].update(c3_manifest=str(manifest),
        run_root=str(Path(os.environ.get('KAG_BUILDER_RUN_ROOT','/builder-runs'))/f'revision-{revision}'),
        lock_root=os.environ.get('KAG_BUILDER_LOCK_ROOT','/run/kag-locks'))
    config['input_sha256'] = dict(c3_manifest=hashlib.sha256(manifest.read_bytes()).hexdigest())
    if scope_preview is not None:
        config['selection'] = copy.deepcopy(scope_preview['selection'])
        if scope_preview['path'] is not None:
            config['paths']['selection'] = scope_preview['path']
            config['input_sha256']['selection'] = scope_preview['sha256']
    elif node_limit is not None:
        from kag.builder.production_scope import select_bounded_sources
        contract = json.loads((Path(__file__).resolve().parents[1]/'schema/schema_contract.json').read_bytes())
        data = validate_source_manifest(contract, manifest)
        try:
            config['selection'] = select_bounded_sources(data, node_limit)
            if target['namespace'] != contract['namespace']:
                config['selection']['node_keys'] = [[target['namespace']+'.'+key[0].rsplit('.',1)[-1],key[1]]
                    for key in config['selection']['node_keys']]
                config['selection']['edge_tuples'] = [[target['namespace']+'.'+key[0].rsplit('.',1)[-1],key[1],key[2],
                    target['namespace']+'.'+key[3].rsplit('.',1)[-1],key[4]] for key in config['selection']['edge_tuples']]
        finally:
            data['index'].close()
    if vector_package is not None:
        from kag.builder import packages
        if (type(vector_package) is not dict or set(vector_package) != {'name','sha256'}
                or not isinstance(vector_package['sha256'],str) or not packages.HASH.fullmatch(vector_package['sha256'])):
            raise RunBlocked('CONFIG')
        path = packages.package_path(vector_package['name'])
        packages.compatible(packages.read_manifest(path),model,plan_sha256)
        config.update(vector_policy='replay-existing',embedding_model=None,vector_package=copy.deepcopy(vector_package))
        config['paths']['graph_package'] = str(path)
        config['input_sha256']['graph_package'] = vector_package['sha256']
    return _config(config)


def browser_links():
    from urllib.parse import urlsplit
    values = dict(openspg=os.environ.get('KAG_OPENSPG_PUBLIC_URL','http://127.0.0.1:8887/'),
        neo4j=os.environ.get('KAG_NEO4J_BROWSER_URL','http://127.0.0.1:7474/browser/'),
        bolt=os.environ.get('KAG_NEO4J_PUBLIC_BOLT_URL','bolt://127.0.0.1:7687'))
    for name,value in values.items():
        parsed = urlsplit(value)
        if (parsed.scheme not in (('bolt','neo4j','bolt+s','neo4j+s') if name=='bolt' else ('http','https'))
                or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment):
            return None
    return values


def _builder_runner(model):
    """Bind a saved secret to one run without writing it into Runner config or environment."""
    from kag.http_api.provider_budget import (AsyncGatewayTransport, GATEWAY, GatewayTransport, provider_route)
    resources = []
    stop_event = None
    def vectorizer(config, verified):
        from kag.http_api.runtime import _CancellableTransport
        policy = _builder_policy()
        route = provider_route(model['config'], 'embedding', policy)
        batch = _provider(config, verified, api_key=model['config']['api_key'])
        resources.append(batch.vectorize_model)
        for name, wrapper in (('client',GatewayTransport),('aclient',AsyncGatewayTransport)):
            sdk = getattr(batch.vectorize_model,name)
            sdk.max_retries = 0
            sdk._client.follow_redirects = False
            transport = _CancellableTransport(stop_event=stop_event) if name=='client' else sdk._client._transport
            sdk._client._transport = wrapper(transport,GATEWAY,policy['token'],
                model['config']['base_url'].rstrip('/')+'/embeddings',route)
            sdk._client._mounts = {}
        return batch
    def execute(config, **kwargs):
        nonlocal stop_event
        stop_event = kwargs.get('stop_event')
        try:
            return run(config,vectorizer_factory=vectorizer,**kwargs)
        finally:
            for adapter in resources:
                try:
                    adapter.client.close()
                finally:
                    asyncio.run(adapter.aclient.close())
            resources.clear()
    return execute


class BuilderControl:
    def __init__(self, config, *, runner=run):
        self.config = _config(config)
        if self.config['write_mode'] != 'WRITE':
            raise RunBlocked('SCOPE')
        if self.config['scope'] == 'PRODUCTION':
            config=self.config
            try:
                ProductionSettings(scope=config['scope'],runtime_location=config['runtime_location'],
                    host_addr=config['endpoints']['openspg'],neo4j_uri=config['endpoints']['neo4j_uri'],
                    project_name=config['project_name'],namespace=config['namespace'],expected_project_id=config['project_id'],
                    vector_dimensions=config['vector_dimensions'],confirmation=config['confirmation']).validate()
            except ValueError:
                raise RunBlocked('SCOPE') from None
        elif (self.config['scope'] != 'FRESH_SAMPLE' or self.config['vector_policy'] != 'replay-existing'
                or not (re.fullmatch(r'freshsample[a-z0-9]{8,40}', self.config['database'])
                        or self.config['runtime_location'] == 'container' and self.config['database'] == 'vietroadtraffic')):
            raise RunBlocked('SCOPE')
        if self.config['scope'] == 'FRESH_SAMPLE' and self.config['runtime_location'] == 'container':
            from kag.backend_identity import BackendIdentityError, _isolated_builder_password
            try: _isolated_builder_password()
            except (BackendIdentityError, OSError): raise RunBlocked('SCOPE') from None
        self.runner = runner
        self.thread = None
        self.stop_event = threading.Event()
        self.run_id = None
        self.failed = False
        self.result = None
        self.previous_status = None
        # Protect the local HTTP/thread state only; this is not another database writer lock.
        self._monitor = threading.RLock()
        root = Path(self.config['paths']['run_root'])
        if root.exists():
            records = [(self._record(path.name), path.name) for path in root.iterdir()]
            if records:
                self.run_id = max(records, key=lambda row: row[0][0]['updated_at'])[1]
                self.failed = any(not (
                    status['state'] in ('ABANDONED','CLEARED')
                    or
                    status['state'] == 'PASS' and status['stage'] == 'release'
                    or status['state'] == 'ERROR' and (status['error_code'] == 'INTERRUPTED'
                        or status['stage'] == 'vectorize' and status['error_code'] in ('VECTORS','VECTORS_KEY')))
                    for (status, uncertain, _), _ in records)

    def _directory(self, run_id):
        return validate_run_directory(self.config['paths']['run_root'], run_id,
            read_only_paths=[path for name, path in self.config['paths'].items()
                             if path and name not in ('run_root', 'lock_root')])

    def _record(self, run_id):
        ledger = self._directory(run_id) / 'ledger.sqlite3'
        if ledger.is_symlink() or not ledger.is_file():
            raise RunBlocked('INTEGRITY')
        try:
            with closing(sqlite3.connect(ledger.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
                db.execute('BEGIN')
                meta = dict(db.execute("SELECT key,value FROM run_meta WHERE key IN ('identity','status','disposition')"))
                identity, status = json.loads(meta['identity']), json.loads(meta['status'])
                pending = db.execute("SELECT 1 FROM run_batches WHERE state='INTENT' "
                    "AND stage IN ('write-nodes','write-edges') LIMIT 1").fetchone() is not None
                stages = {name:json.loads(result) for name,result in db.execute('SELECT stage,result FROM run_stages')}
                exported = db.execute("SELECT COUNT(*) FROM run_batches WHERE stage='export-artifact' AND state='CONFIRMED'").fetchone()[0]
            if (identity['config_hash'] != _spec_hash(self.config) or identity['run_id'] != run_id
                    or any(identity[key]!=self.config[key] for key in ('scope','project_id','database','namespace','model_identity'))
                    or not isinstance(identity['database_id'], str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',identity['database_id'])
                    or not re.fullmatch(r'[0-9a-f]{64}',identity['c3']['plan_sha256'])
                    or status['run_id'] != run_id or status['error_code'] not in (None, *MESSAGES)
                    or status['state'] not in ('RUNNING','PASS','BLOCKED','ERROR')
                    or type(status['done']) is not int or type(status['total']) is not int
                    or not 0 <= status['done'] <= status['total']
                    or not isinstance(status['updated_at'], str) or not isinstance(status['started_at'], str)
                    or status['stage'] not in STAGES or set(stages)-set(STAGES)):
                raise ValueError
            if any(datetime.fromisoformat(status[key].replace('Z','+00:00')).tzinfo is None for key in ('started_at','updated_at')):
                raise ValueError
            if not (self.thread is not None and self.thread.is_alive()):
                if status['state']=='RUNNING':
                    status=dict(status,state='ERROR',error_code='INTERRUPTED')
                elif status['state']=='BLOCKED' and status['stage']=='vectorize' and status['error_code'] in ('VECTORS','VECTORS_KEY'):
                    status=dict(status,state='ERROR')
            rows = []
            for name in STAGES:
                done = total = None
                code = None
                if name==status['stage'] and status['error_code']:
                    state = 'STOPPED' if status['error_code']=='INTERRUPTED' or name=='vectorize' and status['error_code'] in ('VECTORS','VECTORS_KEY') else 'BLOCKED'
                    done,total,code = status['done'],status['total'],status['error_code']
                elif name in stages:
                    state = 'COMPLETE'
                    done = total = (stages[name]['nonempty'] if name=='vectorize' else stages[name]['count'] if name in ('write-nodes','write-edges')
                        else stages[name]['nodes']['total'] if name=='verify-nodes'
                        else exported if name=='export-artifact' else 1)
                elif name==status['stage']:
                    state,done,total = 'RUNNING',status['done'],status['total']
                else:
                    state = 'PENDING'
                if state!='PENDING' and (type(done) is not int or type(total) is not int or not 0<=done<=total):
                    raise ValueError
                rows.append(dict(name=name,state=state,done=done,total=total,error_code=code))
            result = None
            if status['state']=='PASS' and status['stage']=='release':
                verified,release,plan = stages['verify'],stages['release'],stages['plan']
                if (set(stages)!=set(STAGES) or verified['nodes_only'] is not False
                        or verified['fingerprint']!=release['fingerprint']
                        or _spec_hash({key:value for key,value in verified.items() if key!='fingerprint'})!=verified['fingerprint']
                        or verified['model_identity']!=identity['model_identity']
                        or verified['nodes']['total']!=plan['nodes'] or verified['edges']['total']!=plan['edges']
                        or verified['vectors']['dimension']!=self.config['vector_dimensions'] or len(verified['indexes'])!=4):
                    raise ValueError
                result = dict(nodes=verified['nodes']['total'],edges=verified['edges']['total'],
                    vectors=verified['vectors']['nonempty'],dimension=verified['vectors']['dimension'],
                    indexes=len(verified['indexes']),fingerprint=verified['fingerprint'],
                    verified_at=status['updated_at'],chat_activation='SEPARATE')
            detail = dict(stages=rows,timing={key:status[key] for key in ('started_at','updated_at')},
                binding=dict(run_id=run_id,scope=identity['scope'],plan_sha256=identity['c3']['plan_sha256'],
                    config_sha256=identity['config_hash'],model_identity=identity['model_identity'],
                    database_id=identity['database_id'],**{key:identity[key] for key in ('project_id','database','namespace')}),
                result=result)
            if 'selection' in self.config:
                detail['binding']['node_limit'] = self.config['selection']['node_limit']
            lock = Path(self.config['paths']['lock_root']) / (
                hashlib.sha256(identity['database_id'].encode()).hexdigest() + '.lock')
            if 'disposition' in meta:
                disposition=json.loads(meta['disposition'])
                if (set(disposition)!={'state','run_id','config_hash','updated_at'}
                        or disposition['state'] not in ('ABANDONED','CLEARED') or disposition['run_id']!=run_id
                        or disposition['config_hash']!=identity['config_hash']
                        or datetime.fromisoformat(disposition['updated_at']).tzinfo is None):raise ValueError
                status=dict(status,state=disposition['state'])
            lock_state = graph_lock_status(lock)['state']
            uncertain = ('UNCERTAIN_WRITE' if pending or lock_state == 'RETAINED'
                         else 'LOCK' if lock_state == 'HELD' else None)
            return status, uncertain, detail
        except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
            raise RunBlocked('INTEGRITY') from None

    def status(self):
        with self._monitor:
            alive = self.thread is not None and self.thread.is_alive()
            state, progress, code = 'IDLE', None, None
            detail = dict(stages=[],timing=None,binding=None,result=None)
            if alive:
                state = 'STOPPING' if self.stop_event.is_set() else 'RUNNING'
                try:
                    durable, _, detail = self._record(self.run_id)
                    progress = {key: durable[key] for key in ('stage', 'done', 'total')}
                except RunBlocked:
                    pass  # Preflight has not created its verified ledger yet.
            else:
                try:
                    _shared_lock_root(self.config['paths']['lock_root'])
                    if self.failed and self.run_id is None:
                        raise RunBlocked('INTEGRITY')
                    if self.run_id is not None:
                        durable, uncertain, detail = self._record(self.run_id)
                        progress = {key: durable[key] for key in ('stage', 'done', 'total')}
                        code = durable['error_code']
                        if uncertain:
                            raise RunBlocked(uncertain)
                        if self.failed and not (durable['state']=='ERROR' and code in ('INTERRUPTED','VECTORS','VECTORS_KEY')):
                            raise RunBlocked(code or 'INTEGRITY')
                        if self.result is not None and durable == self.previous_status:
                            raise RunBlocked('SCOPE' if self.result == 2 else 'RUNTIME')
                        if durable['state'] in ('ABANDONED','CLEARED'):
                            state = durable['state']
                        elif durable['state'] == 'ERROR' and code in ('INTERRUPTED','VECTORS','VECTORS_KEY'):
                            state = 'STOPPED'
                        elif self.result == 2:
                            state, code = 'BLOCKED', code or 'SCOPE'
                        elif durable['state'] == 'PASS' and durable['stage'] == 'release':
                            state = 'COMPLETE'
                        else:
                            state = 'BLOCKED'
                            code = code or 'INTEGRITY'
                except RunBlocked as error:
                    state, code = 'BLOCKED', error.code
            if state!='COMPLETE':detail['result']=None
            return dict(contract_version='builder-control-v3', state=state, run_id=self.run_id,
                target={key: self.config[key] for key in ('project_id', 'database', 'namespace')},
                progress=progress, error_code=code,
                actions=dict(build=state in ('IDLE', 'COMPLETE', 'ABANDONED','CLEARED'), stop=state == 'RUNNING',
                             resume=state == 'STOPPED', abandon=state == 'STOPPED', delete=False),
                delete_reason=None,
                production_write='CONFIGURED' if self.config['scope']=='PRODUCTION' else 'BLOCKED',**detail)

    def start(self, run_id, *, resume=False):
        with self._monitor:
            directory = self._directory(run_id)
            current = self.status()
            if (not current['actions']['resume' if resume else 'build']
                    or resume and run_id != self.run_id or not resume and directory.exists()):
                raise HTTPException(409, 'BUILDER_CONFLICT')
            self.run_id, self.failed = run_id, False
            self.result = None
            self.previous_status = self._record(run_id)[0] if resume else None
            self.stop_event = threading.Event()
            def execute():
                try:
                    self.result = self.runner(self.config, run_id=run_id, resume=resume, stop_event=self.stop_event)
                    if self.result not in (0, 1, 2):
                        self.failed = True
                except BaseException:
                    self.failed = True
            self.thread = threading.Thread(target=execute, name='kag-builder', daemon=False)
            self.thread.start()
            return self.status()

    def stop(self, run_id):
        with self._monitor:
            if (run_id != self.run_id or self.thread is None or not self.thread.is_alive()
                    or self.stop_event.is_set()):
                raise HTTPException(409, 'BUILDER_CONFLICT')
            self.stop_event.set()
            return self.status()

    def close(self):
        with self._monitor:
            self.stop_event.set()
            thread = self.thread
        if thread is not None:
            thread.join()  # Drain Runner; never cancel a remote write or delete its lock.

    def abandon(self, run_id, state):
        with self._monitor:
            current=self.status()
            if run_id!=self.run_id or current['state'] not in ('STOPPED','ABANDONED'):
                raise HTTPException(409,'BUILDER_ABANDON_BLOCKED')
            if current['state']=='ABANDONED':return current
            if (any(self.config[k]!=state['target'][k] for k in state['target'])
                    or current['binding']['database_id']!=state['proof'].physical_database_id):
                raise HTTPException(409,'BUILDER_TARGET_CHANGED')
            lock=GraphLock(self.config['paths']['lock_root'],state['proof'].physical_database_id,
                dict(scope='PRODUCTION',run_id=run_id,project_id=self.config['project_id'],namespace=self.config['namespace'],database=self.config['database']),
                backend_proof=state['proof'],backend_session=state['identity'])
            lock.acquire()
            try:
                with closing(sqlite3.connect(self._directory(run_id)/'ledger.sqlite3',timeout=2)) as db:
                    db.execute('BEGIN IMMEDIATE')
                    meta=dict(db.execute("SELECT key,value FROM run_meta WHERE key IN ('identity','status','disposition')"))
                    durable=json.loads(meta['status'])
                    if (json.loads(meta['identity'])['config_hash']!=_spec_hash(self.config)
                            or not (durable['state']=='RUNNING'
                                or durable['state']=='ERROR' and durable['error_code']=='INTERRUPTED'
                                or durable['state']=='BLOCKED' and durable['stage']=='vectorize' and durable['error_code'] in ('VECTORS','VECTORS_KEY'))
                            or db.execute("SELECT 1 FROM run_batches WHERE state='INTENT' AND stage IN ('write-nodes','write-edges') LIMIT 1").fetchone()):
                        raise HTTPException(409,'BUILDER_ABANDON_BLOCKED')
                    lock.assert_owned(state['proof'].physical_database_id);state['identity'].validate(state['proof'])
                    db.execute('INSERT OR IGNORE INTO run_meta VALUES (?,?)',('disposition',json.dumps(dict(
                        state='ABANDONED',run_id=run_id,config_hash=_spec_hash(self.config),updated_at=datetime.now(timezone.utc).isoformat()))))
                    db.commit()
            finally:lock.release()
            return self.status()


def create_app(*, control=None, token=None, state_dir=None):
    state_dir = state_dir or os.environ.get('KAG_BUILDER_STATE_DIR')
    if token is None:
        token = Path(os.environ['KAG_BUILDER_TOKEN_FILE']).read_text(encoding='utf-8').strip()
    # Reuse bearer validation; this app knows only its independent control secret.
    secrets = ServiceSecrets(inspect_tokens=(token,))
    setup = None
    setup_error = None
    setup_path = Path(state_dir)/'configuration.json' if state_dir else None
    failure = None
    configuration = control.config if control is not None else None
    if state_dir and setup_path.exists():
        try:
            from kag.http_api.runtime import RuntimeSupervisor
            RuntimeSupervisor()._config_storage(setup_path, private=True)
            with setup_path.open('rb') as stream:
                raw = stream.read(65537)
            if len(raw)>65536:raise ValueError
            saved = json.loads(raw)
            if (type(saved) is not dict or set(saved) not in ({'revision','embedding_revision','runner'},{'revision','embedding_revision','runner','clear'}) or type(saved['revision']) is not int
                    or not 1<=saved['revision']<=2147483647 or type(saved['embedding_revision']) is not int
                    or saved['embedding_revision']<1):raise ValueError
            configuration = _config(saved['runner'])
            setup = saved
            control = BuilderControl(configuration)
        except (OSError, ValueError, KeyError, TypeError):
            control, setup_error, failure = None, 'CONFIG', 'CONFIG'
    elif control is None:
        try:
            configuration = json.loads(Path(os.environ['KAG_BUILDER_CONFIG']).read_bytes())
        except (FileNotFoundError, KeyError):
            failure = 'CONFIG'
        except (OSError, ValueError):
            configuration, failure = {}, 'CONFIG'
        else:
            try:
                control = BuilderControl(configuration)
            except (OSError, KeyError, ValueError):
                failure = 'CONFIG'

    source_result=inspect_inputs(None)['source_validation']
    checked_files=()
    checked_config=None
    source_task=None
    package_export=dict(contract_version='builder-package-export-v1',state='NOT_RUN',name=None,size=None,code=None)
    readiness = dict(state='NOT_RUN',checks=[],checked_at=None)
    ready_binding = None
    scope_preview = None
    clear_result=dict(contract_version='builder-clear-v1',state='NOT_RUN',revision=setup['revision'] if setup else 0,
        preview_id=None,report=None,deleted=dict(nodes=0,edges=0),checked_at=None,code=None)
    if setup and 'clear' in setup:
        previous=setup['clear']
        if (type(previous) is not dict or set(previous)!=set(clear_result)
                or previous['contract_version']!='builder-clear-v1'
                or previous['state'] not in ('NOT_RUN','PREVIEW','APPLYING','COMPLETE','PARTIAL','INTERRUPTED','BLOCKED')):
            failure='CONFIG';control=None
        else:
            clear_result=previous
            if clear_result['state']=='APPLYING':clear_result=dict(clear_result,state='INTERRUPTED',code='CLEAR_UNCERTAIN')
    structure_path = Path(state_dir)/'structure.json' if state_dir else None
    structure_result = dict(contract_version='builder-structure-v1',state='NOT_RUN',revision=0,
        preview_id=None,checked_at=None,can_apply=False,report=None,code=None)
    if structure_path and structure_path.exists():
        try:
            with structure_path.open('rb') as stream:raw=stream.read(1048577)
            if len(raw)>1048576:raise ValueError
            saved_structure=json.loads(raw)
            if (type(saved_structure) is not dict or set(saved_structure)!=set(structure_result)
                    or saved_structure['contract_version']!='builder-structure-v1'
                    or saved_structure['state'] not in ('NOT_RUN','PREVIEW','APPLYING','COMPLETE','PARTIAL','INTERRUPTED','BLOCKED')
                    or type(saved_structure['revision']) is not int or saved_structure['revision']<0
                    or type(saved_structure['can_apply']) is not bool
                    or saved_structure['preview_id'] is not None and not re.fullmatch('[0-9a-f]{64}',saved_structure['preview_id'])):raise ValueError
            structure_result=saved_structure
            if structure_result['state']=='APPLYING':
                structure_result.update(state='INTERRUPTED',can_apply=False,code='STRUCTURE_INTERRUPTED')
        except (OSError,ValueError,TypeError):
            structure_result.update(state='BLOCKED',code='INTEGRITY')

    def structure_model():
        try:
            model=_builder_model(secrets)
            return _spec_hash(model)
        except (OSError,ValueError,KeyError,TypeError):
            return None

    def store_structure(value):
        nonlocal structure_result
        atomic_json(structure_path,value,mode=0o600)
        structure_result=value

    def structure_idle():
        return (state_dir and (source_task is None or source_task.done())
                and (control is None or control.status()['state'] in ('IDLE','COMPLETE','ABANDONED','CLEARED')))

    def store_clear(value):
        nonlocal setup,clear_result
        if setup:
            updated=dict(setup,clear=value)
            atomic_json(setup_path,updated,mode=0o600)
            setup=updated
        clear_result=value

    def binding(session=None):
        model = _builder_model(secrets)
        if (not setup or (configuration['vector_policy']=='provider'
                and model['config']['base_url'].rstrip('/')+'|'+model['config']['model']!=configuration['model_identity'])
                or configuration['vector_policy']!='provider' and model['revision']!=setup['embedding_revision']):
            raise RunBlocked('CONFIG')
        if session is not None:
            target = selected_target(configuration['project_id'],session)
        else:
            from kag.builder.projects import deployment_endpoints
            endpoints,location = deployment_endpoints()
            target = dict(endpoints=endpoints,runtime_location=location)
        if (any(configuration[key]!=value for key,value in target.items())
                or not model['test'] or model['test']['status']!='PASS'
                or model['test']['dimension']!=configuration['vector_dimensions']):
            raise RunBlocked('CONFIG')
        if not checked_files or any(_input_version(path)!=version for path,version in checked_files):
            raise RunBlocked('INTEGRITY')
        return (_spec_hash(configuration), model['revision'], model['test'],
                _builder_policy() if configuration['vector_policy']=='provider' else None,
                source_result['state'], source_result['plan_sha256'])

    def configuration_view():
        nonlocal readiness, ready_binding
        try:
            target = configuration if setup else _builder_target()
            target = {name:target[name] for name in ('project_id','project_name','database','namespace')}
        except ValueError:
            target = None
        try:
            model = _builder_model(secrets)
            embedding = {name:model['config'][name] for name in ('provider','base_url','model')}
            embedding.update(revision=model['revision'],key_configured=True,
                tested=bool(model['test'] and model['test']['status']=='PASS'),
                dimension=model['test']['dimension'] if model['test'] else None)
        except (OSError, ValueError, KeyError, TypeError):
            embedding = None
        if readiness['state']=='READY':
            try:
                if ready_binding!=binding():raise ValueError
            except (OSError, ValueError, KeyError, TypeError):
                readiness = dict(state='NOT_RUN',checks=[],checked_at=None)
                ready_binding = None
        selection = configuration.get('selection') if setup else None
        return dict(contract_version='builder-configuration-v5',revision=setup['revision'] if setup else 0,
            saved=setup is not None,error_code=setup_error,target=target,embedding=embedding,
            batch_size=configuration['batch_size'] if setup else 64,
            request_limit=configuration.get('request_limit') if setup else None,readiness=copy.deepcopy(readiness),
            vector_package=configuration.get('vector_package') if setup else None,
            links=browser_links(),selection=dict(node_limit=selection['node_limit'] if selection else None,
                nodes=selection['summary']['nodes'] if selection and 'summary' in selection else len(selection['node_keys']) if selection else source_result['nodes'],
                edges=selection['summary']['edges'] if selection and 'summary' in selection else len(selection['edge_tuples']) if selection else source_result['edges'],
                request=selection.get('request',dict(mode='COUNT',value=selection['node_limit'])) if selection else dict(mode='ALL',value=None),
                summary=selection.get('summary') if selection else source_result.get('summary')))

    @asynccontextmanager
    async def lifespan(app):
        yield
        await app.state.benchmark_runner.close()
        if source_task is not None:
            await source_task
        if control is not None:
            await asyncio.to_thread(control.close)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    from kag.http_api.benchmark_runner import install_worker_routes
    install_worker_routes(app)

    @app.exception_handler(ApiFailure)
    async def denied(request, error):
        return JSONResponse({'error': {'code': error.code}}, status_code=error.status)

    def authenticate_request(request):
        headers = request.headers.getlist('authorization')
        if len(headers) > 1:
            raise ApiFailure('AUTH_INVALID')
        authenticate(headers[0] if headers else None, secrets)
        if request.query_params:
            raise ApiFailure('INVALID_REQUEST')

    def session_token(request):
        values = request.headers.getlist('x-openspg-session')
        return values[0] if len(values)==1 else ''

    def serving_auth(request,*,write=False):
        from kag.http_api.security import authorize
        from kag.http_api.server import _secret
        name='CONFIG_APPLY' if write else 'INSPECT'
        value=_secret('KAG_HTTP_'+name+'_SECRET_FILE')
        if not value:raise ApiFailure('SCOPE_DENIED')
        scope='config-apply' if write else 'inspect'
        scoped=ServiceSecrets(**{('config_apply_tokens' if write else 'inspect_tokens'):(value,)})
        headers=request.headers.getlist('authorization')
        if len(headers)>1:raise ApiFailure('AUTH_INVALID')
        authorize(authenticate(headers[0] if headers else None,scoped),scope,None)
        if request.query_params:raise ApiFailure('INVALID_REQUEST')

    serving_busy=False
    serving_path=Path(state_dir)/'serving.json' if state_dir else None
    serving_result=dict(contract_version='builder-serving-operation-v1',state='NOT_RUN',project_id=None,run_id=None,code=None,result=None)
    if serving_path and serving_path.exists():
        try:
            saved=json.loads(serving_path.read_bytes())
            if (type(saved) is not dict or set(saved)!=set(serving_result)
                    or saved['contract_version']!=serving_result['contract_version']
                    or saved['state'] not in ('NOT_RUN','PREPARING','COMPLETE','FAILED','INTERRUPTED')):raise ValueError
            serving_result=saved
            if serving_result['state']=='PREPARING':
                serving_result=dict(serving_result,state='INTERRUPTED',code='NOT_READY')
                atomic_json(serving_path,serving_result)
        except (OSError,ValueError,TypeError):serving_result.update(state='FAILED',code='INTEGRITY')

    def store_serving(value):
        nonlocal serving_result
        if serving_path:atomic_json(serving_path,value)
        serving_result=value

    @app.get('/v1/serving')
    async def serving_catalog(request: Request):
        serving_auth(request)
        from kag.builder.serving import runs,active_selection
        try:
            rows=await asyncio.to_thread(runs,session_token(request))
            operation=serving_result if any(row['project_id']==serving_result['project_id'] for row in rows) else None
            return dict(contract_version='builder-serving-v1',active=await asyncio.to_thread(active_selection),busy=serving_busy,
                runs=rows,operation=copy.deepcopy(operation))
        except (ProjectCatalogError,RunBlocked) as error:
            raise HTTPException(409,error.code) from None

    @app.post('/v1/serving/{action}')
    async def serving_action(action: str,request: Request):
        nonlocal serving_busy,source_task
        if action not in ('preview','activate','deactivate','read','trial'):raise ApiFailure('INVALID_REQUEST')
        serving_auth(request,write=action in ('preview','activate','deactivate'))
        from kag.builder.serving import prepare,fixed_read,trial,deactivate
        if action=='deactivate' and control is not None and control.status()['state'] in ('RUNNING','STOPPING'):
            raise HTTPException(409,'LOCK')
        if action!='read' and serving_busy:raise ApiFailure('CONFIG_BUSY')
        if action!='read':serving_busy=True
        try:
            body=json.loads(await bounded_body(request,limit=32*1024*1024 if action!='read' else 256*1024))
            if action=='activate':
                if (type(body) is not dict or set(body)!={'project_id','run_id','preview_id'}
                        or type(body['project_id']) is not int or not 1<=body['project_id']<=2147483647
                        or not isinstance(body['run_id'],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',body['run_id'])
                        or not isinstance(body['preview_id'],str) or not re.fullmatch('[0-9a-f]{64}',body['preview_id'])):raise ApiFailure('INVALID_REQUEST')
                if not structure_idle():raise ApiFailure('CONFIG_BUSY')
                token=session_token(request)
                store_serving(dict(serving_result,state='PREPARING',project_id=body['project_id'],run_id=body['run_id'],code=None,result=None))
                async def activate():
                    nonlocal serving_busy
                    try:
                        result=await asyncio.to_thread(prepare,body,token,activate=True)
                        store_serving(dict(serving_result,state='COMPLETE',result=result))
                    except Exception as error:
                        code=error.code if isinstance(error,(ApiFailure,ProjectCatalogError,RunBlocked)) else 'NOT_READY'
                        store_serving(dict(serving_result,state='FAILED',code=code))
                    finally:serving_busy=False
                source_task=asyncio.create_task(activate())
                return JSONResponse(copy.deepcopy(serving_result),status_code=202)
            value=(await asyncio.to_thread(trial,body,session_token(request)) if action=='trial' else
                await asyncio.to_thread(fixed_read,body) if action=='read' else
                await asyncio.to_thread(deactivate,body,session_token(request)) if action=='deactivate' else
                await asyncio.to_thread(prepare,body,session_token(request),activate=action=='activate'))
            return value
        except (ProjectCatalogError,RunBlocked) as error:
            raise HTTPException(409,error.code) from None
        except ApiFailure:raise
        except Exception:raise ApiFailure('NOT_READY') from None
        finally:
            if action!='read' and not (action=='activate' and serving_result['state']=='PREPARING'):serving_busy=False

    @app.get('/v1/builder/projects')
    async def projects(request: Request):
        authenticate_request(request)
        return await asyncio.to_thread(read_projects,session_token(request))

    @app.get('/v1/builder/graph/{project_id}')
    async def graph_project(project_id: int, request: Request):
        authenticate_request(request)
        from kag.builder.projects import inspect_graph, ProjectCatalogError
        try:
            return await asyncio.to_thread(inspect_graph,project_id,session_token(request))
        except ProjectCatalogError as error:
            status=403 if error.code=='FORBIDDEN' else 404 if error.code=='NOT_FOUND' else 503
            raise HTTPException(status,'GRAPH_'+error.code) from None
        except (OSError,ValueError,KeyError,TypeError,RuntimeError):
            raise HTTPException(503,'GRAPH_UNAVAILABLE') from None

    @app.get('/v1/builder/sources/{project_id}/{run_id}')
    async def run_sources(project_id: int,run_id: str,request: Request):
        authenticate_request(request)
        from kag.builder.serving import sources
        try:
            return await asyncio.to_thread(sources,project_id,run_id,session_token(request))
        except ProjectCatalogError as error:
            raise HTTPException(403 if error.code=='FORBIDDEN' else 404 if error.code=='NOT_FOUND' else 503,'SOURCES_'+error.code) from None

    @app.get('/v1/builder/structure')
    async def structure_status(request: Request):
        authenticate_request(request)
        return copy.deepcopy(structure_result)

    @app.get('/v1/builder/clear')
    async def clear_status(request: Request):
        authenticate_request(request)
        return copy.deepcopy(clear_result)

    @app.post('/v1/builder/clear/apply',status_code=202)
    async def clear_operation(request: Request):
        nonlocal source_task,readiness,ready_binding,serving_busy
        authenticate_request(request)
        try:
            body=json.loads(await bounded_body(request))
            if (type(body) is not dict or set(body)!={'project_id','database_id'}
                    or type(body['project_id']) is not int or not 1<=body['project_id']<=2147483647
                    or not isinstance(body['database_id'],str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',body['database_id'])):raise ValueError
        except (ValueError,TypeError):raise ApiFailure('INVALID_REQUEST') from None
        current=control.status() if control is not None else None
        if (not state_dir or source_task is not None and not source_task.done() or serving_busy
                or current is not None and current['state'] in ('RUNNING','STOPPING')
                    and current['target']['project_id']!=body['project_id']
                or clear_result['state'] in ('PARTIAL','INTERRUPTED') and clear_result['report']
                    and clear_result['report']['database_id']!=body['database_id']):
            raise HTTPException(409,'LOCK')
        from kag.builder import structure
        token=session_token(request)
        try:
            with structure.target_state(body['project_id'],token,for_write=False) as state:
                if state['proof'].physical_database_id!=body['database_id']:raise RunBlocked('CLEAR_STALE')
                counts=state['reader']._query('structure_counts')[0]
                report=dict(target={k:state['target'][k] for k in ('project_id','project_name','namespace','database')},
                    database_id=body['database_id'],counts=counts,batch_size=500)
        except (ProjectCatalogError,RunBlocked) as error:raise HTTPException(409,error.code) from None
        readiness,ready_binding=dict(state='NOT_RUN',checks=[],checked_at=None),None
        store_clear(dict(contract_version='builder-clear-v1',state='APPLYING',revision=setup['revision'] if setup else 0,
            preview_id=None,report=report,deleted=dict(nodes=0,edges=0),checked_at=datetime.now(timezone.utc).isoformat(),code=None))
        serving_busy=True
        async def clear():
            nonlocal serving_busy
            try:
                if current is not None and current.get('target') and current['target']['project_id']==body['project_id']:
                    if current['state'] in ('RUNNING','STOPPING'):await asyncio.to_thread(control.close)
                    if control.status()['state']=='STOPPED':
                        def abandon():
                            with structure.target_state(body['project_id'],token,for_write=False) as state:
                                return control.abandon(current['run_id'],state)
                        await asyncio.to_thread(abandon)
                from kag.builder.serving import deactivate
                await asyncio.to_thread(deactivate,body,token)
                def progress(counts):store_clear(dict(clear_result,deleted=counts,checked_at=datetime.now(timezone.utc).isoformat()))
                after=await asyncio.to_thread(structure.apply_clear,body['project_id'],token,body['database_id'],
                    os.environ.get('KAG_BUILDER_LOCK_ROOT','/run/kag-locks'),
                    progress=progress)
                if any(after['report']['counts'].values()):raise RunBlocked('CLEAR_STALE')
                store_clear(dict(clear_result,state='COMPLETE',report=after['report'],code=None,checked_at=datetime.now(timezone.utc).isoformat()))
            except Exception as error:
                code=error.code if isinstance(error,(RunBlocked,ProjectCatalogError)) else error.detail if isinstance(error,HTTPException) else 'RUNTIME'
                store_clear(dict(clear_result,state='PARTIAL',code=code,checked_at=datetime.now(timezone.utc).isoformat()))
            finally:
                serving_busy=False
        source_task=asyncio.create_task(clear())
        return copy.deepcopy(clear_result)


    @app.post('/v1/builder/structure/{operation}',status_code=202)
    async def structure_operation(operation: str,request: Request):
        nonlocal source_task,readiness,ready_binding
        authenticate_request(request)
        try:
            body=json.loads(await bounded_body(request))
            fields={'project_id','revision'}|({'preview_id'} if operation=='apply' else set())
            if (operation not in ('preview','apply') or type(body) is not dict or set(body)!=fields
                    or type(body['project_id']) is not int or not 1<=body['project_id']<=2147483647
                    or type(body['revision']) is not int or body['revision']!=(setup['revision'] if setup else 0)
                    or operation=='apply' and (not isinstance(body['preview_id'],str) or not re.fullmatch('[0-9a-f]{64}',body['preview_id']))):raise ValueError
        except (ValueError,TypeError):raise ApiFailure('INVALID_REQUEST') from None
        if not structure_idle() or clear_result['state'] in ('APPLYING','PARTIAL','INTERRUPTED'):
            raise HTTPException(409,'BUILDER_STRUCTURE_BUSY')
        from kag.builder import structure
        token=session_token(request)
        model=structure_model()
        try:
            tested=_builder_model(secrets)['test']
            if not tested or tested['status']!='PASS':raise ValueError
            dimension=structure._dimension(tested['dimension'])
        except (OSError,ValueError,KeyError,TypeError,RunBlocked):
            raise HTTPException(409,'BUILDER_EMBEDDING_NOT_READY') from None
        def envelope(report,state,code=None):
            report=copy.deepcopy(report)
            signature=report.pop('signature',None) if report else None
            return dict(contract_version='builder-structure-v1',state=state,revision=body['revision'],
                preview_id=_spec_hash(dict(signature=signature,model=model,revision=body['revision'])),
                checked_at=datetime.now(timezone.utc).isoformat(),can_apply=state=='PREVIEW' and report['code'] is None
                    and bool(any(r['action']!='KEEP' for r in report['changes'])
                        or any(r['action'] in ('ADD','REBUILD') for r in report['indexes'])
                        or any(r['action']=='REMOVE' for r in report.get('index_changes',[]))),
                report=report,code=code)
        if operation=='preview':
            source_task=asyncio.current_task()
            try:
                report=await asyncio.to_thread(structure.preview,body['project_id'],token,dimension=dimension)
                if body['revision']!=(setup['revision'] if setup else 0) or model!=structure_model():
                    raise RunBlocked('STRUCTURE_STALE')
                # Hash includes the live schema/index/physical target and current saved model.
                store_structure(envelope(report,'PREVIEW'))
            except Exception as error:
                code=error.code if isinstance(error,(RunBlocked,ProjectCatalogError)) else 'RUNTIME'
                store_structure(envelope(None,'BLOCKED',code))
            finally:
                source_task=None
            return copy.deepcopy(structure_result)
        previous=copy.deepcopy(structure_result)
        if (previous['state']!='PREVIEW' or not previous['can_apply'] or previous['revision']!=body['revision']
                or previous['preview_id']!=body['preview_id'] or previous['report']['target']['project_id']!=body['project_id']):
            raise HTTPException(409,'BUILDER_STRUCTURE_STALE')
        readiness,ready_binding=dict(state='NOT_RUN',checks=[],checked_at=None),None
        store_structure(dict(previous,state='APPLYING',can_apply=False,code=None))
        async def prepare_structure():
            try:
                fresh=await asyncio.to_thread(structure.preview,body['project_id'],token,dimension=dimension)
                if envelope(copy.deepcopy(fresh),'PREVIEW')['preview_id']!=body['preview_id']:raise RunBlocked('STRUCTURE_STALE')
                report=await asyncio.to_thread(structure.apply,body['project_id'],token,fresh['signature'],
                    os.environ.get('KAG_BUILDER_LOCK_ROOT','/run/kag-locks'),dimension=dimension)
                if (report['code'] or any(r['action']!='KEEP' for r in report['changes'])
                        or any(r['action']!='KEEP' for r in report['indexes'])
                        or any(r['action']=='REMOVE' for r in report.get('index_changes',[]))):raise RunBlocked('SCHEMA')
                store_structure(envelope(report,'COMPLETE'))
            except Exception as error:
                code=error.code if isinstance(error,(RunBlocked,ProjectCatalogError)) else 'RUNTIME'
                try:report=await asyncio.to_thread(structure.preview,body['project_id'],token,dimension=dimension)
                except Exception:report=None
                store_structure(envelope(report,'PARTIAL',code))
        source_task=asyncio.create_task(prepare_structure())
        return copy.deepcopy(structure_result)

    @app.get('/v1/builder/inputs')
    async def inputs(request: Request):
        nonlocal source_result,checked_files,checked_config
        authenticate_request(request)
        result=await asyncio.to_thread(inspect_inputs, configuration)
        if state_dir:
            result['contract_version'] = 'builder-inputs-v3'
        cached_result = source_result
        if source_result['state']!='CHECKING':
            if checked_config is not None and checked_config!=_spec_hash(configuration):
                source_result=inspect_inputs(None)['source_validation']
                checked_files=()
            elif checked_files:
                try:
                    changed = await asyncio.to_thread(lambda:any(_input_version(path)!=version for path,version in checked_files))
                    if changed and source_result is cached_result:
                        raise ValueError
                except (OSError,ValueError):
                    if source_result is cached_result:
                        source_result=inspect_inputs(None)['source_validation']
                        checked_files=()
        if state_dir and source_result['state']=='NOT_RUN':
            cached=await asyncio.to_thread(source_cache,state_dir)
            if cached:
                source_result,checked_files=cached
                checked_config=_spec_hash(configuration)
        result['source_validation']=dict(source_result,summary=source_result.get('summary')) if state_dir else {k:v for k,v in source_result.items() if k!='summary'}
        if source_result['state']=='VALID':
            for row in result['inputs']:
                if row['name']=='c3_manifest':row['state']='MATCHED'
        return result

    @app.get('/v1/builder/dataset/{group}/{offset}/{limit}')
    async def dataset(group: str,offset: int,limit: int,request: Request):
        authenticate_request(request)
        return await asyncio.to_thread(read_dataset,Path(__file__).resolve().parents[2],group,offset,limit)

    async def prepare_package_inputs(snapshot,validated,versions):
        nonlocal setup,configuration,control,checked_config
        from kag.builder import packages
        try:model = _builder_model(secrets)
        except (OSError,ValueError,KeyError,TypeError):raise packages.PackageError('PACKAGE_MODEL') from None
        if model['revision'] != setup['embedding_revision']:raise packages.PackageError('PACKAGE_MODEL')
        destination = Path(state_dir)/'package-imports'/snapshot['vector_package']['sha256']/_spec_hash(
            [snapshot['namespace'],snapshot['model_identity']])
        paths = await asyncio.to_thread(packages.prepare_package,snapshot['paths']['graph_package'],destination,
            model=model,plan_sha256=validated['plan_sha256'],namespace=snapshot['namespace'],
            expected_sha256=snapshot['vector_package']['sha256'])
        prepared = copy.deepcopy(snapshot)
        prepared['paths'].update(paths)
        for name,path in paths.items():prepared['input_sha256'][name] = await asyncio.to_thread(packages.checksum,path)
        prepared = _config(prepared)
        if (checked_config != _spec_hash(configuration) or model['revision'] != _builder_model(secrets)['revision']
                or any(_input_version(path)!=version for path,version in versions)):
            raise RunBlocked('INTEGRITY')
        next_control = await asyncio.to_thread(BuilderControl,prepared)
        updated = dict(setup,runner=prepared)
        atomic_json(setup_path,updated,mode=0o600)
        setup,configuration,control = updated,prepared,next_control
        checked_config = _spec_hash(prepared)
        versions = (*versions,*[(Path(path),_input_version(path)) for name,path in prepared['paths'].items()
            if path and name not in ('run_root','lock_root','c3_manifest','selection')])
        return versions

    @app.post('/v1/builder/inputs',status_code=202)
    async def check_inputs(request: Request):
        nonlocal source_task,source_result,checked_files,checked_config
        authenticate_request(request)
        try:
            if json.loads(await bounded_body(request))!={}:
                raise ValueError
        except (ValueError,TypeError):
            raise ApiFailure('INVALID_REQUEST') from None
        result=await asyncio.to_thread(inspect_inputs,configuration)
        stopped = state_dir and control is not None and control.status()['state']=='STOPPED'
        if (source_task is not None and not source_task.done()
                or state_dir and control is not None and control.status()['state'] not in ('IDLE', 'COMPLETE', 'STOPPED','ABANDONED','CLEARED')
                or not state_dir and (result['configuration']!='CONFIGURED'
                    or not any(row['name']=='c3_manifest' and row['state']=='NOT_CHECKED' for row in result['inputs']))):
            raise HTTPException(409,'SOURCE_CHECK_BLOCKED')
        checked_files=()
        checked_config=_spec_hash(configuration)
        snapshot = copy.deepcopy(configuration)
        source_result=dict(state='CHECKING',error_code=None,plan_sha256=None,nodes=None,edges=None)
        async def check():
            nonlocal source_result,checked_files,checked_config,configuration,setup,control,readiness,ready_binding
            from kag.builder import packages
            validated,versions = None,()
            try:
                validated, versions = await asyncio.to_thread(
                    prepare_source_inputs if state_dir and not stopped else check_source_inputs,
                    state_dir if state_dir and not stopped else snapshot)
                if checked_config != _spec_hash(configuration):
                    raise ValueError('Configuration changed during validation')
                if state_dir and snapshot and snapshot.get('vector_package'):
                    versions=await prepare_package_inputs(snapshot,validated,versions)
                source_result, checked_files = validated, versions
            except packages.PackageError as error:
                stable = False
                try:stable = validated is not None and all(_input_version(path)==version for path,version in versions)
                except OSError:pass
                if stable:
                    source_result,checked_files = validated,versions
                    readiness = dict(state='BLOCKED',checked_at=datetime.now(timezone.utc).isoformat(),checks=[
                        dict(name='source',state='READY',code=None),dict(name='embedding',state='BLOCKED',code=error.code),
                        dict(name='target',state='NOT_CHECKED',code='WAIT_EMBEDDING'),dict(name='lock',state='NOT_CHECKED',code='WAIT_TARGET')])
                    ready_binding = None
                else:
                    source_result=dict(state='INVALID',error_code='INTEGRITY',plan_sha256=None,nodes=None,edges=None)
                    checked_files=()
            except ValueError:
                source_result=dict(state='INVALID',error_code='INTEGRITY',plan_sha256=None,nodes=None,edges=None)
            except Exception:
                source_result=dict(state='UNAVAILABLE',error_code='RUNTIME',plan_sha256=None,nodes=None,edges=None)
        source_task=asyncio.create_task(check())
        if state_dir:
            result['contract_version'] = 'builder-inputs-v3'
        result['source_validation']=dict(source_result,summary=source_result.get('summary')) if state_dir else {k:v for k,v in source_result.items() if k!='summary'}
        return result

    @app.post('/v1/builder/selection',status_code=202)
    async def preview_selection(request: Request):
        nonlocal source_task,scope_preview
        authenticate_request(request)
        try:
            body=json.loads(await bounded_body(request))
            if (type(body) is not dict or set(body)!={'revision','mode','value'}
                    or type(body['revision']) is not int):raise ValueError
            limit=selection_limit(source_result['nodes'],body['mode'],body['value'])
        except (ValueError,TypeError):raise ApiFailure('INVALID_REQUEST') from None
        if (source_task is not None and not source_task.done()
                or control is not None and control.status()['state'] in ('RUNNING','STOPPING')
                or source_result['state']!='VALID'
                or body['revision']!=(setup['revision'] if setup else 0)):
            raise HTTPException(409,'BUILDER_SELECTION_STALE')
        source_task=asyncio.current_task()
        before=tuple(checked_files)
        try:
            def select():
                manifest=Path(state_dir)/'plans'/source_result['plan_sha256']/'manifest.json'
                data=dict(manifest=json.loads(manifest.read_bytes()),edge_hashes=range(source_result['edges']))
                selected=None;path=None;digest=None
                if limit is not None:
                    directory=manifest.parent/'selections';directory.mkdir(exist_ok=True)
                    for candidate in directory.glob('*.json'):
                        value=json.loads(candidate.read_bytes())
                        if value.get('node_limit')==limit:
                            selected=value;path=candidate;break
                    if selected is None:
                        nodes=[json.loads(line) for line in (manifest.parent/'nodes.jsonl').read_bytes().splitlines() if line.strip()]
                        edges=[tuple(json.loads(line)['tuple']) for line in (manifest.parent/'edges.jsonl').read_bytes().splitlines() if line.strip()]
                        data.update(nodes=nodes,node_hashes={(n['type'],n['id']):None for n in nodes},edge_hashes=dict.fromkeys(edges))
                        selected=select_bounded_sources(data,limit,extended=True)
                        path=directory/(_spec_hash(selected)+'.json');atomic_json(path,selected,mode=0o600)
                    digest=hashlib.sha256(path.read_bytes()).hexdigest()
                summary=selection_summary(data,selected)
                return dict(selection=dict(node_limit=limit,request={k:body[k] for k in ('mode','value')},summary=summary),
                    path=str(path) if path else None,sha256=digest)
            preview=await asyncio.to_thread(select)
            if (not before or any(_input_version(path)!=version for path,version in before)
                    or body['revision']!=(setup['revision'] if setup else 0)):
                raise HTTPException(409,'BUILDER_SELECTION_STALE')
            files=before
            if preview['path']:files=(*files,(Path(preview['path']),_input_version(preview['path'])))
            preview.update(revision=body['revision'],files=files)
            preview['preview_id']=_spec_hash({k:v for k,v in preview.items() if k!='files'})
            scope_preview=preview
            return dict(contract_version='builder-selection-v1',revision=body['revision'],preview_id=preview['preview_id'],
                **preview['selection'])
        except ValueError as error:
            raise HTTPException(409,'BUILDER_SELECTION_INVALID') from None
        finally:source_task=None

    @app.get('/v1/builder/status')
    async def status(request: Request):
        authenticate_request(request)
        if control is None:
            return dict(contract_version='builder-control-v3', state='BLOCKED', run_id=None,
                target=None, progress=None, error_code=failure,
                actions=dict(build=False, stop=False, resume=False, abandon=False,delete=False),
                delete_reason=None, production_write='BLOCKED',
                stages=[],timing=None,binding=None,result=None)
        result = await asyncio.to_thread(control.status)
        if state_dir and (not setup or configuration_view()['readiness']['state']!='READY'):
            result['actions'].update(build=False,resume=bool(setup) and result['actions']['resume'])
        return result

    @app.get('/v1/builder/packages')
    async def graph_packages(request: Request):
        authenticate_request(request)
        from kag.builder import packages
        try:model = _builder_model(secrets)
        except (OSError,ValueError,KeyError,TypeError):model = None
        plan = source_result['plan_sha256'] if source_result['state']=='VALID' else None
        return await asyncio.to_thread(packages.catalog,model,plan)

    @app.get('/v1/builder/packages/export')
    async def graph_export_status(request: Request):
        authenticate_request(request)
        from kag.builder.packages import host_directory
        return dict(package_export,directory=host_directory())

    @app.post('/v1/builder/packages/export',status_code=202)
    async def graph_export(request: Request):
        nonlocal source_task,package_export
        authenticate_request(request)
        from kag.builder import packages,serving
        try:
            change = json.loads(await bounded_body(request))
            if (type(change) is not dict or set(change) != {'project_id','run_id'}
                    or type(change['project_id']) is not int or not 1<=change['project_id']<=2147483647
                    or not isinstance(change['run_id'],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',change['run_id'])):
                raise ValueError
        except (ValueError,TypeError):raise ApiFailure('INVALID_REQUEST') from None
        if not structure_idle():raise HTTPException(409,'SOURCE_CHECK_BLOCKED')
        session = session_token(request)
        owned = await asyncio.to_thread(serving.runs,session)
        if not any(row['run_id']==change['run_id'] and row['project_id']==change['project_id'] for row in owned):
            raise ApiFailure('SCOPE_DENIED')
        if not structure_idle():raise HTTPException(409,'SOURCE_CHECK_BLOCKED')
        package_export=dict(package_export,state='RUNNING',name=None,size=None,code=None)
        async def export():
            nonlocal package_export
            try:
                path,receipt = await asyncio.to_thread(serving._run_directory,change['run_id'],change['project_id'])
                result = await asyncio.to_thread(packages.export_package,path,receipt,_builder_model(secrets),packages.directory(),
                    application_version=os.environ.get('KAG_APPLICATION_VERSION','0.1.0'))
                package_export=dict(package_export,state='COMPLETE',code=None,**result)
            except packages.PackageError as error:
                package_export=dict(package_export,state='FAILED',name=None,size=None,code=error.code)
            except Exception:
                package_export=dict(package_export,state='FAILED',name=None,size=None,code='PACKAGE_UNAVAILABLE')
        source_task = asyncio.create_task(export())
        return await graph_export_status(request)

    @app.get('/v1/builder/configuration')
    async def get_configuration(request: Request):
        authenticate_request(request)
        return configuration_view()

    @app.post('/v1/builder/configuration',status_code=202)
    async def save_configuration(request: Request):
        nonlocal setup, setup_error, configuration, control, checked_config, checked_files, readiness, ready_binding, failure,source_result
        authenticate_request(request)
        try:
            body = json.loads(await bounded_body(request))
            if (not state_dir or type(body) is not dict
                    or not {'revision','embedding_revision','batch_size','request_limit'} <= set(body)
                    or set(body)-{'revision','embedding_revision','batch_size','request_limit','node_limit','project_id','selection_preview_id','vector_package'}
                    or any(type(body[name]) is not int for name in ('revision','embedding_revision','batch_size'))
                    or not 1<=body['batch_size']<=4096
                    or body['request_limit'] is not None and (type(body['request_limit']) is not int or not 1<=body['request_limit']<=1000000)
                    or body.get('node_limit') is not None and (type(body['node_limit']) is not int or not 3<=body['node_limit']<=128)
                    or 'selection_preview_id' in body and (not isinstance(body['selection_preview_id'],str)
                        or not re.fullmatch('[0-9a-f]{64}',body['selection_preview_id']))):
                raise ValueError
        except (ValueError, TypeError):
            raise ApiFailure('INVALID_REQUEST') from None
        if (body['revision']!=(setup['revision'] if setup else 0) or body['revision']>=2147483647
                or source_task is not None and not source_task.done()
                or control is not None and control.status()['state'] not in ('IDLE','COMPLETE','ABANDONED','CLEARED')
                or clear_result['state'] in ('APPLYING','PARTIAL','INTERRUPTED')
                or source_result['state']!='VALID'):
            raise HTTPException(409,'BUILDER_CONFIGURATION_CONFLICT')
        try:
            chosen=None
            if 'selection_preview_id' in body:
                chosen=scope_preview
                if (not chosen or body['selection_preview_id']!=chosen['preview_id'] or body['revision']!=chosen['revision']
                        or any(_input_version(p)!=v for p,v in chosen['files'])):raise ValueError
            model = _builder_model(secrets)
            if (model['revision']!=body['embedding_revision'] or not model['test'] or model['test']['status']!='PASS'
                    or type(model['test']['dimension']) is not int or not 1<=model['test']['dimension']<=65536):raise ValueError
            project_id = body['project_id'] if 'project_id' in body else configuration['project_id'] if setup else _builder_target()['project_id']
            target = await asyncio.to_thread(selected_target,project_id,session_token(request))
            next_revision = body['revision']+1
            config = await asyncio.to_thread(_builder_config,state_dir,target,model,next_revision,
                body['batch_size'],body['request_limit'],body.get('node_limit'),chosen,plan_sha256=source_result['plan_sha256'],
                vector_package=body.get('vector_package'))
            if (body['revision']!=(setup['revision'] if setup else 0)
                    or source_task is not None and not source_task.done()
                    or source_result['state']!='VALID'
                    or any(_input_version(path)!=version for path,version in checked_files)
                    or any(config[key]!=value for key,value in (await asyncio.to_thread(selected_target,target['project_id'],session_token(request))).items())
                    or control is not None and control.status()['state'] not in ('IDLE','COMPLETE','ABANDONED','CLEARED')
                    or model['revision']!=_builder_model(secrets)['revision']):
                raise ValueError
            next_control = BuilderControl(config)
            updated = dict(revision=next_revision,embedding_revision=model['revision'],runner=config)
            if setup and 'clear' in setup:updated['clear']=copy.deepcopy(clear_result)
            from kag.http_api.runtime import RuntimeSupervisor
            RuntimeSupervisor()._config_storage(setup_path,private=True)
            atomic_json(setup_path,updated,mode=0o600)
        except ProjectCatalogError as error:
            raise HTTPException(409,error.code) from None
        except (OSError, ValueError, KeyError, TypeError):
            raise HTTPException(409,'BUILDER_CONFIGURATION_UNAVAILABLE') from None
        setup, configuration, control = updated, config, next_control
        setup_error, failure = None, None
        checked_config = _spec_hash(configuration)
        if config.get('vector_package'):
            source_result=inspect_inputs(None)['source_validation']
            checked_files=()
        if config['paths'].get('selection'):
            path=Path(config['paths']['selection'])
            checked_files=(*checked_files,(path,_input_version(path)))
        readiness, ready_binding = dict(state='NOT_RUN',checks=[],checked_at=None), None
        return configuration_view()

    @app.post('/v1/builder/preflight',status_code=202)
    async def check_readiness(request: Request):
        nonlocal source_task, readiness, ready_binding
        authenticate_request(request)
        try:
            if json.loads(await bounded_body(request))!={}:raise ValueError
        except (ValueError, TypeError):
            raise ApiFailure('INVALID_REQUEST') from None
        await inputs(request)
        if (not setup or control is None or source_task is not None and not source_task.done()
                or control.status()['state'] not in ('IDLE','COMPLETE','STOPPED','ABANDONED','CLEARED')
                or clear_result['state'] in ('APPLYING','PARTIAL','INTERRUPTED')):
            raise HTTPException(409,'BUILDER_PREFLIGHT_BLOCKED')
        readiness = dict(state='CHECKING',checks=[],checked_at=None)
        ready_binding = None
        snapshot = copy.deepcopy(configuration)
        def inspect():
            verified = None
            before = None
            checks = []
            def record(name, valid, code):
                checks[:] = [row for row in checks if row['name']!=name]
                checks.append(dict(name=name,state='READY' if valid else 'BLOCKED',code=None if valid else code))
                return valid
            try:
                record('source',source_result['state']=='VALID','PLAN')
                before = binding(session_token(request))
                model = _builder_model(secrets)
                from kag.http_api.provider_budget import provider_route
                try:
                    if snapshot['vector_policy']=='provider':provider_route(model['config'],'embedding',_builder_policy())
                    valid = bool(model['test'] and model['test']['status']=='PASS' and model['test']['dimension']==snapshot['vector_dimensions'])
                except Exception:
                    valid = False
                record('embedding',valid,'CONFIG')
                if all(row['state']=='READY' for row in checks):
                    projects, reader = _clients(snapshot,None,None)
                    verified = runner_preflight(snapshot,project_client=projects,reader=reader)
                    from kag.verify import _indexes
                    _indexes(reader,verified['contract'],snapshot['vector_dimensions'])
                    record('target',True,None)
                    lock = Path(snapshot['paths']['lock_root'])/(hashlib.sha256(verified['database_id'].encode()).hexdigest()+'.lock')
                    lock_state = graph_lock_status(lock)['state']
                    if not record('lock',lock_state == 'FREE','UNCERTAIN_WRITE' if lock_state == 'RETAINED' else 'LOCK'):
                        try:
                            if lock.is_symlink():raise ValueError
                            with lock.open('rb') as stream:metadata = json.loads(stream.read(8193))
                            owner = metadata['owner']
                            if (metadata['database_id']!=verified['database_id'] or type(owner)!=dict
                                    or not isinstance(owner.get('run_id'),str)
                                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',owner['run_id'])
                                    or type(owner.get('project_id')) is not int or not 1<=owner['project_id']<=2147483647):raise ValueError
                            checks[-1]['owner'] = dict(run_id=owner['run_id'],project_id=owner['project_id'])
                        except (OSError,ValueError,KeyError,TypeError):
                            pass
                    if binding(session_token(request))!=before:raise ValueError
            except Exception as error:
                record('target',False,error.code if isinstance(error,(RunBlocked,ProjectCatalogError)) else 'CONFIG')
            finally:
                if verified:
                    verified['backend_session'].close()
                    verified['source_index'].close()
            for name in ('source','embedding','target','lock'):
                if not any(row['name']==name for row in checks):
                    waiting = {'source':'WAIT_SOURCE','embedding':'WAIT_SOURCE','target':'WAIT_EMBEDDING','lock':'WAIT_TARGET'}[name]
                    checks.append(dict(name=name,state='NOT_CHECKED',code=waiting))
            return checks, before
        async def check():
            nonlocal readiness, ready_binding,source_result,checked_files
            try:
                if snapshot.get('vector_package'):
                    validated,versions=await asyncio.to_thread(prepare_source_inputs,state_dir)
                    checked_files=await prepare_package_inputs(snapshot,validated,versions)
                    source_result=validated
                    snapshot.clear();snapshot.update(copy.deepcopy(configuration))
                checks, checked_binding = await asyncio.to_thread(inspect)
            except Exception as error:
                readiness=dict(state='BLOCKED',checked_at=datetime.now(timezone.utc).isoformat(),checks=[
                    dict(name='source',state='BLOCKED',code=getattr(error,'code','INTEGRITY'))])
                ready_binding=None
                return
            ready = all(row['state']=='READY' for row in checks)
            try:
                if ready and await asyncio.to_thread(binding,session_token(request))!=checked_binding:raise ValueError
                ready_binding = checked_binding if ready else None
            except (OSError,ValueError,KeyError,TypeError):
                ready = False
                ready_binding = None
            readiness = dict(state='READY' if ready else 'BLOCKED',checks=checks,
                checked_at=datetime.now(timezone.utc).isoformat())
        source_task = asyncio.create_task(check())
        return configuration_view()

    @app.post('/v1/builder/{action}', status_code=202)
    async def action(action: str, request: Request):
        authenticate_request(request)
        if action not in ('build', 'stop', 'resume','abandon'):
            raise HTTPException(404, 'UNKNOWN_ACTION')
        if action != 'stop' and source_task is not None and not source_task.done():
            raise HTTPException(409, 'SOURCE_CHECK_BLOCKED')
        if state_dir and action != 'stop':
            await inputs(request)
        try:
            body = json.loads(await bounded_body(request))
            if not isinstance(body, dict) or set(body) != {'run_id'}:
                raise ValueError
            if control is None:
                raise HTTPException(409, 'BUILDER_BLOCKED')
            control._directory(body['run_id'])
        except (ValueError, TypeError):
            raise ApiFailure('INVALID_REQUEST') from None
        if state_dir and action!='stop' and (not setup or request.headers.get('If-Match')!=f'"{setup["revision"]}"'):
            raise HTTPException(409,'BUILDER_CONFIGURATION_CHANGED')
        if action == 'stop':
            await asyncio.to_thread(control.stop, body['run_id'])
        elif action=='abandon':
            from kag.builder.structure import target_state
            def abandon():
                with target_state(configuration['project_id'],session_token(request)) as state:
                    return control.abandon(body['run_id'],state)
            try:await asyncio.to_thread(abandon)
            except (RunBlocked,ProjectCatalogError) as error:raise HTTPException(409,error.code) from None
        else:
            if state_dir:
                if configuration_view()['readiness']['state']!='READY':
                    raise HTTPException(409,'BUILDER_PREFLIGHT_REQUIRED')
                try:
                    if await asyncio.to_thread(binding,session_token(request))!=ready_binding:raise ValueError
                    model = _builder_model(secrets)
                    if model['revision']!=ready_binding[1]:raise ValueError
                    control.runner = _builder_runner(model) if configuration['vector_policy']=='provider' else run
                except (OSError,ValueError,KeyError,TypeError):
                    raise HTTPException(409,'BUILDER_CONFIGURATION_CHANGED') from None
            control.start(body['run_id'], resume=action == 'resume')
        return await status(request)

    return app


if __name__ == '__main__':
    import uvicorn
    uvicorn.run('kag.builder.control:create_app', factory=True, host='0.0.0.0', port=8010,
                workers=1, limit_concurrency=16, access_log=False)
