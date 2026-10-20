"""Publish verified Builder runs and protect the selected physical database."""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time

from kag.http_api import artifacts as a
from kag.http_api.contract import ApiFailure
from kag.http_api.security import ServiceSecrets
from kag.run_state import GraphLock, RunBlocked, validate_run_directory

_READ_RELEASE = None
_READ_VERIFICATION = None


def validate_selection(value):
    a._keys(value,('release_id','project_id','project_name','database','database_id','namespace','run_id','preview_id'))
    for field in ('release_id','run_id'):
        if not isinstance(value[field],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',value[field]): a._invalid()
    for field in ('project_name','database_id'): a._identity(value[field])
    if (type(value['project_id']) is not int or not 1<=value['project_id']<=2147483647
            or not re.fullmatch(r'[a-z][a-z0-9.-]{0,62}',value['database'])
            or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}',value['namespace'])
            or not re.fullmatch('[0-9a-f]{64}',value['preview_id'])): a._invalid()
    return value


def model_store():
    from kag.http_api.runtime import RuntimeSupervisor
    store=RuntimeSupervisor();store.load_llm_config(ServiceSecrets(),read_only=True)
    if store._llm_error: raise ApiFailure('NOT_READY')
    return store


def active_selection():
    from kag.http_api.runtime import LLM_CONFIG_PATH
    if not LLM_CONFIG_PATH.exists() and not LLM_CONFIG_PATH.is_symlink():return None
    state=model_store()._llm_config
    return deepcopy(state.get('serving')) if state else None


def release_root(release_id):
    if not isinstance(release_id,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',release_id): a._invalid()
    root=Path(os.environ.get('KAG_BUILDER_STATE_DIR','/builder-state'))/'releases'
    if not root.is_absolute() or any(p.is_symlink() for p in (root,*root.parents)): a._invalid()
    return root/release_id


def validate_active_release(release):
    selected=active_selection()
    if (type(release) is not a.ServingRelease or release.release_kind!='PRODUCTION' or selected is None
            or selected['release_id']!=release.release_id or selected['database_id']!=release.descriptor['database_id']
            or selected['database']!=release.descriptor['database'] or selected['namespace']!=release.schema_contract.namespace
            or str(selected['project_id'])!=release.backend['project_id']): a._invalid()
    a._unchanged(release)
    return selected


def protect_active(reader,physical):
    try:
        selected=active_selection()
        if selected and (selected['database_id']==physical
                or reader.protected_database_identity(selected['database'])==physical): raise RunBlocked('SCOPE')
    except RunBlocked: raise
    except Exception: raise RunBlocked('SCOPE') from None


def chat_blockers(release):
    if a.dataset_sources(release):
        return [] if release.records else ['SOURCE_MISSING']
    publication=release.publication
    if publication is None:return ['SOURCE_MISSING']
    source=dict(as_of=publication['as_of'],documents=[dict(row) for row in publication['documents']],
                units=[dict(row) for row in publication['units']])
    return a.bind_publication(source,dict(schema_contract=dict(release.descriptor['schema_contract']),
        source_snapshot_id=release.descriptor['source_snapshot_id']),release.records)[1]


def _record(path):
    receipt=a._json(a._read(path,'receipt.json'))
    identity=receipt['identity']
    if (path/'ledger.sqlite3').is_symlink() or not (path/'ledger.sqlite3').is_file(): a._invalid()
    with closing(sqlite3.connect((path/'ledger.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
        db.execute('BEGIN')
        meta={key:json.loads(value) for key,value in db.execute("SELECT key,value FROM run_meta WHERE key IN ('identity','status','disposition')")}
        stages={key:json.loads(value) for key,value in db.execute('SELECT stage,result FROM run_stages')}
    if ('disposition' in meta or meta['identity']!=identity or stages!=receipt['stages']
            or meta['status']['state']!='PASS' or meta['status']['stage']!='release'
            or identity['scope']!='PRODUCTION' or identity['write_mode']!='WRITE'
            or identity['run_id']!=path.name or stages['release']['fingerprint']!=stages['verify']['fingerprint']): a._invalid()
    return receipt


def runs(token):
    from kag.builder.projects import read_projects
    catalog=read_projects(token)
    if catalog['state'] not in ('AVAILABLE','EMPTY'):raise ApiFailure('SCOPE_DENIED')
    owned={row['project_id']:row for row in catalog['projects']}
    rows=[]
    root=Path(os.environ.get('KAG_BUILDER_RUN_ROOT','/builder-runs'))
    if root.exists():
        for directory in root.glob('revision-*/*'):
            if directory.is_symlink() or not directory.is_dir():continue
            try:
                path=validate_run_directory(directory.parent,directory.name)
                receipt=_record(path);identity=receipt['identity'];result=receipt['stages']['verify']
                project=owned.get(identity['project_id'])
                if not project or any(project[key]!=identity[key] for key in ('database','namespace')):continue
                rows.append(dict(run_id=path.name,project_id=project['project_id'],project_name=project['project_name'],
                    database=project['database'],namespace=project['namespace'],nodes=result['nodes']['total'],
                    edges=result['edges']['total'],vectors=result['vectors']['nonempty'],dimension=result['vectors']['dimension'],
                    model_identity=result['model_identity'],partial='selection' in identity['input_hashes']))
            except (OSError,ValueError,KeyError,TypeError,ApiFailure,sqlite3.Error):continue
    return rows


def _run_directory(run_id,project_id):
    root=Path(os.environ.get('KAG_BUILDER_RUN_ROOT','/builder-runs'))
    found=[]
    for revision in root.glob('revision-*'):
        path=validate_run_directory(revision,run_id)
        if path.is_dir():
            receipt=_record(path)
            if receipt['identity']['project_id']==project_id:found.append((path,receipt))
    if len(found)!=1:raise ApiFailure('NOT_READY')
    return found[0]


def sources(project_id,run_id,token):
    """Source snapshot of an owned, verified run; live graph checks remain in preview."""
    from kag.builder.projects import selected_target
    from kag.builder.codec import decode_properties,canonical_json
    target=selected_target(project_id,token,for_write=False)
    path,receipt=_run_directory(run_id,project_id)
    identity=receipt['identity']
    if any(target[key]!=identity[key] for key in ('project_id','project_name','database','namespace','endpoints')):a._invalid()
    contract=a._json(a.release_contract(identity['namespace'],production=True)[0])
    records=dict(documents=[],units=[])
    try:
        with closing(sqlite3.connect((path/'ledger.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
            db.execute('BEGIN')
            plan=json.loads(db.execute("SELECT value FROM runner_plan WHERE key='receipt'").fetchone()[0])
            if (plan!=receipt['stages']['plan'] or plan['identity_hash']!=a._sha(canonical_json(
                    {key:value for key,value in identity.items() if key!='run_id'}).encode())):a._invalid()
            for kind in ('nodes','edges'):
                count,digest=0,hashlib.sha256()
                for ordinal,key,source_hash,payload in db.execute(
                        'SELECT ordinal,key,source_hash,payload FROM runner_sources WHERE kind=? ORDER BY ordinal',(kind,)):
                    spec=a._json(payload.encode())
                    expected_key=[spec['type'],spec['id']] if kind=='nodes' else spec['tuple']
                    if (ordinal!=count or canonical_json(spec)!=payload or a._json(key.encode())!=expected_key
                            or a._sha(payload.encode())!=source_hash):a._invalid()
                    digest.update((payload+'\n').encode());count+=1
                    if kind=='nodes':
                        local=spec['type'].removeprefix(identity['namespace']+'.')
                        if local not in contract['node_properties'] or spec['type']!=identity['namespace']+'.'+local:a._invalid()
                        values=decode_properties(dict(spec['properties'],id=spec['id'],name=spec['name']),contract['node_properties'][local])
                        if local in ('LegalDocument','LegalUnit'):
                            values['doc_id' if local=='LegalDocument' else 'unit_id']=spec['id']
                            records['documents' if local=='LegalDocument' else 'units'].append(values)
                if count!=plan[kind] or digest.hexdigest()!=plan[kind+'_hash']:a._invalid()
        selected=active_selection();publication=None
        if selected and selected['project_id']==project_id and selected['run_id']==run_id:
            release=a.load_release(release_root(selected['release_id']),selected['release_id'])
            validate_active_release(release)
            if release.descriptor['database_id']!=identity['database_id']:a._invalid()
            publication=dict(release_id=release.release_id,documents=[],units=[])
            if release.publication:
                publication.update(documents=[dict(row) for row in release.publication['documents']],
                    units=[dict(row) for row in release.publication['units']])
        if _record(path)!=receipt or selected_target(project_id,token,for_write=False)!=target:a._invalid()
        return dict(contract_version='builder-sources-v1',target={key:target[key] for key in
            ('project_id','project_name','database','namespace')},run_id=run_id,
            partial='selection' in identity['input_hashes'],**records,release=publication)
    except (sqlite3.DatabaseError,KeyError,TypeError,ValueError):a._invalid()


def prepare(change,token,*,activate=False):
    """Recheck preview under the existing physical GraphLock; commit models and graph together."""
    from kag.builder.structure import target_state,inspect
    from kag.http_api.provider_budget import provider_route
    from kag.http_api.server import provider_test_policy
    a._keys(change,('project_id','run_id',*(('preview_id',) if activate else ())))
    if type(change['project_id']) is not int or not 1<=change['project_id']<=2147483647: a._invalid()
    path,receipt=_run_directory(change['run_id'],change['project_id'])
    with target_state(change['project_id'],token,for_write=False,check_structure=True) as state:
        target=state['target'];proof=state['proof'];identity=receipt['identity']
        if (proof.physical_database_id!=identity['database_id'] or any(target[k]!=identity[k]
                for k in ('project_id','project_name','database','namespace','endpoints'))): a._invalid()
        lock=GraphLock(os.environ.get('KAG_BUILDER_LOCK_ROOT','/run/kag-locks'),proof.physical_database_id,
            dict(run_id='publish-'+path.name,scope='PRODUCTION',**{k:target[k] for k in ('project_id','namespace','database')}),
            backend_proof=proof,backend_session=state['identity'])
        lock.acquire()
        try:
            report,_=inspect(state)
            if report['code'] or not report['build_ready']:raise ApiFailure('NOT_READY')
            store=model_store();models=store._llm_config
            if not models or not models['embedding'] or not models['tested']['embedding'] or models['tested']['embedding']['status']!='PASS':
                raise ApiFailure('NOT_READY')
            embedding=models['embedding'];test=models['tested']['embedding']
            if (embedding['base_url'].rstrip('/')+'|'+embedding['model']!=identity['model_identity']
                    or test['dimension']!=identity['dimension'] or report['dimension']!=identity['dimension']):
                raise ApiFailure('RELEASE_MISMATCH')
            policy=provider_test_policy();provider_route(embedding,'embedding',policy)
            source_id='source-'+identity['c3']['plan_sha256']
            revision=models['revision'];previous=models.get('serving')
            source_hash='dataset-snapshot-v1'
            release_id='builder-'+a._sha(a.canonical_json([identity['run_id'],receipt['stages']['verify']['fingerprint'],source_hash]).encode())
            root=release_root(release_id)
            proposal=a.publish_run(root.with_name('preview-'+release_id),path,state['reader'],release_id=release_id,
                source_snapshot_id=source_id,source_mode='dataset-snapshot-v1',release_kind='PRODUCTION')
            for key in ('release_root','operational_proof','status'):proposal.pop(key,None)
            blockers=proposal['chat_blockers']
            chat=models['chat'];chat_test=models['tested']['chat']
            chat_ready=bool(chat and chat_test and chat_test['status']=='PASS')
            if chat_ready:provider_route(chat,'chat',policy)
            if not chat_ready:blockers.append('CHAT_MODEL_REQUIRED')
            proposal.update(project_id=target['project_id'],project_name=target['project_name'],
                embedding={k:embedding[k] for k in ('provider','base_url','model')},
                chat={k:chat[k] for k in ('provider','base_url','model')} if chat else None,
                previous=previous,model_revision=revision,chat_ready=not blockers)
            preview_id=a._sha(a.canonical_json(dict(proposal,schema=report)).encode())
            proposal['preview_id']=preview_id
            if not activate:return proposal
            if change['preview_id']!=preview_id:raise ApiFailure('CONFIG_CONFLICT')
            lock.assert_owned(proof.physical_database_id);state['identity'].validate(proof)
            if active_selection()!=previous or model_store()._llm_config['revision']!=revision:raise ApiFailure('CONFIG_CONFLICT')
            root.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            if root.exists():
                release=a.load_release(root,release_id);a._unchanged(release)
                if release.descriptor['graph_fingerprint']!=proposal['graph_fingerprint']:a._invalid()
            else:
                a.publish_run(root,path,state['reader'],release_id=release_id,source_snapshot_id=source_id,
                    source_mode='dataset-snapshot-v1',release_kind='PRODUCTION',approve=True)
            selected=dict(release_id=release_id,project_id=target['project_id'],project_name=target['project_name'],
                database=target['database'],database_id=proof.physical_database_id,namespace=target['namespace'],
                run_id=path.name,preview_id=preview_id)
            updated=deepcopy(models);updated['revision']+=1;updated['serving']=selected
            for role in ('embedding','chat'):
                updated['active'][role]=(dict(revision=models['role_revisions'][role],config=models[role],test=models['tested'][role])
                    if role=='embedding' or chat_ready else None)
                updated['blocked'][role]=None
            store._persist_llm(updated)
            return dict(proposal,status='ACTIVE',active=selected)
        finally:lock.release()


def fixed_read(change):
    global _READ_RELEASE, _READ_VERIFICATION
    from kag.http_api.read_broker import _parameters,_BoundedOpener
    from kag.retriever.neo4j import Neo4jRetrievalClient
    a._keys(change,('release_id','operation','parameters'))
    selected=active_selection()
    if selected is None or selected['release_id']!=change['release_id']:raise ApiFailure('RELEASE_MISMATCH')
    root=release_root(selected['release_id'])
    release=_READ_RELEASE
    if release is None or (release.root,release.release_id)!=(root,selected['release_id']):
        release=a.load_release(root,selected['release_id'])
        _READ_VERIFICATION=None
    # Reuse parsing only; validation rereads every artifact byte before and after each read.
    try:
        validate_active_release(release)
    except Exception:
        _READ_VERIFICATION=None
        raise
    _READ_RELEASE=release
    descriptor=release.descriptor
    _parameters(change['operation'],change['parameters'],database=descriptor['database'],
        namespace=descriptor['namespace'],dimension=descriptor['dimension'],production=True)
    reader=Neo4jRetrievalClient(release.backend['reader_endpoint'],descriptor['database'],
        username=os.environ['KAG_NEO4J_USERNAME'],password=os.environ['KAG_NEO4J_PASSWORD'],
        namespace=descriptor['namespace'],dimension=descriptor['dimension'],timeout=5)
    reader._opener=_BoundedOpener()
    budget=None
    if change['operation']=='verify_graph':
        from kag.http_api.runtime import _Budget,_ReaderBoundary,REQUEST_SECONDS
        budget=_Budget(time.monotonic()+REQUEST_SECONDS)
        reader._opener=_ReaderBoundary(reader._opener,budget)
    try:
        access=a._backend(reader,release,include_access=True)
        if access!='read-only':_READ_VERIFICATION=None
        if change['operation']=='retrieval_vector':
            parameters=change['parameters'];found=[row for row in reader.indexes() if row['name']==parameters['index']]
            if (len(found)!=1 or found[0]['labelsOrTypes']!=[parameters['label']]
                    or found[0]['properties'] not in [[field] for _,field in a.TARGETS[parameters['label'].rsplit('.',1)[1]]]): a._invalid()
        if change['operation']=='verify_graph':
            from kag.verify import verify_graph
            if access=='read-only' and _READ_VERIFICATION is not None and _READ_VERIFICATION[0] is release:
                result=deepcopy(_READ_VERIFICATION[1])
            else:
                result=verify_graph(reader,db_path=release.root/'expected.sqlite3',
                    contract=a._json(release.contract_bytes),batch_size=64)
            if result['fingerprint']!=descriptor['graph_fingerprint']:a._invalid()
            budget.remaining()
            rows=[result]
        else:
            rows=reader._query(change['operation'],change['parameters'])
        if a._backend(reader,release,include_access=True)!=access:a._invalid('SOURCE_VALIDATION_FAILED')
        validate_active_release(release)
        if change['operation']=='verify_graph' and access=='read-only':
            # Native read-only protects this lifetime; maintenance must stop serving before reopening writes.
            _READ_VERIFICATION=(release,deepcopy(result))
        return dict(release_id=release.release_id,rows=rows)
    except Exception:
        _READ_VERIFICATION=None
        raise
    finally:
        close=getattr(reader._opener,'close',None)
        if callable(close):close()


def trial(change,token):
    """Retrieve one owned run without changing the selected Chat graph or models."""
    from kag.builder.structure import target_state
    from kag.retriever.neo4j import Neo4jRetrievalClient
    from kag.retriever.retriever import Retriever
    from kag.vector_contract import valid_vector
    from kag.verify import verify_graph
    from kag.http_api.read_broker import _BoundedOpener
    a._keys(change,('project_id','run_id','model_identity','vector','top_k','expand'))
    if (type(change['project_id']) is not int or not 1<=change['project_id']<=2147483647
            or type(change['top_k']) is not int or not 1<=change['top_k']<=10 or type(change['expand']) is not bool):
        raise ApiFailure('INVALID_REQUEST')
    path,receipt=_run_directory(change['run_id'],change['project_id'])
    identity=receipt['identity']
    if change['model_identity']!=identity['model_identity'] or not valid_vector(change['vector'],identity['dimension']):
        raise ApiFailure('RELEASE_MISMATCH')
    with target_state(change['project_id'],token,for_write=False) as state:
        target=state['target'];proof=state['proof']
        if (proof.physical_database_id!=identity['database_id'] or any(target[k]!=identity[k]
                for k in ('project_id','project_name','database','namespace','endpoints'))):a._invalid()
        lock=GraphLock(os.environ.get('KAG_BUILDER_LOCK_ROOT','/run/kag-locks'),proof.physical_database_id,
            dict(run_id='inspect-'+path.name,scope='PRODUCTION',**{k:target[k] for k in ('project_id','namespace','database')}),
            backend_proof=proof,backend_session=state['identity'])
        lock.acquire()
        reader=None
        try:
            raw,schema=a.release_contract(identity['namespace'],production=True);contract=a._json(raw)
            reader=Neo4jRetrievalClient(target['endpoints']['neo4j_http'],target['database'],
                username=os.environ['KAG_NEO4J_USERNAME'],password=os.environ['KAG_NEO4J_PASSWORD'],
                namespace=target['namespace'],dimension=identity['dimension'],timeout=5)
            reader._opener=_BoundedOpener()
            def verify():
                if (verify_graph(reader,db_path=path/'expected.sqlite3',contract=contract,batch_size=32)!=receipt['stages']['verify']
                        or _record(path)!=receipt):a._invalid('SOURCE_VALIDATION_FAILED')
                state['identity'].validate(proof)
            state['identity'].validate(proof)
            items=Retriever(reader,None,contract).retrieve_vector(change['vector'],top_k=change['top_k'],expand=change['expand'])
            verify()
            return dict(contract_version='builder-retrieval-v1',project_id=target['project_id'],run_id=change['run_id'],
                schema_contract=schema.__dict__,model_identity=identity['model_identity'],dimension=identity['dimension'],
                graph_fingerprint=receipt['stages']['verify']['fingerprint'],items=items)
        finally:
            if reader is not None:reader._opener.close()
            lock.release()
