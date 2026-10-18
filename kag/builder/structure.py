"""Prepare LuậtGT through the pinned SDK; replace only proven, unused native defaults."""
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import time

from kag.backend_identity import BackendIdentitySession, NativeBackendTransport, _store, bound_sdk_requests
from kag.builder.codec import canonical_json
from kag.builder.production_scope import target_contract, _spec_hash
from kag.builder.projects import selected_target
from urllib.parse import urlsplit
from kag.run_state import GraphLock, RunBlocked
from kag.verify import Neo4jReadClient, _valid_index, _indexes
from kag.vector_contract import TARGETS


# OpenSPG v0.8 SchemaController.getDefaultSchema/getBaseSPGType; also checked
# against the pinned server image. These types declare no relations.
DEFAULT_TYPES = dict(Chunk='文本块', ArtificialObject='人造物体', Astronomy='天文学',
    Building='建筑', Creature='生物', Concept='概念', Date='日期', GeographicLocation='地理位置',
    Keyword='关键词', Medicine='药物', NaturalScience='自然科学', Organization='组织机构',
    Person='人物', Transport='运输', Works='作品', Event='事件', Others='其他', SemanticConcept='语义概念')


def _default_type(actual, namespace):
    local = actual.name.removeprefix(namespace+'.')
    if (actual.name != namespace+'.'+local or local not in DEFAULT_TYPES
            or actual.spg_type_enum != 'ENTITY_TYPE' or actual.parent_type_name != 'Thing'
            or actual.name_zh != DEFAULT_TYPES[local] or actual.desc not in (None, '') or actual.relations):
        return False
    raw = actual.to_rest().to_dict()
    if (any(v not in (None, [], {}) for v in raw['advanced_config'].values())
            or raw['ext_info'] not in ({}, {'commonIndex': False})):
        return False
    field, index = ('content','TEXT_AND_VECTOR') if local == 'Chunk' else ('semanticType','TEXT')
    if set(actual.properties) != {'id','name','description',field}:return False
    for key, prop in actual.properties.items():
        data = prop.to_rest().to_dict(); config = data['advanced_config']
        constraint = config.get('constraint')
        empty_constraint = constraint in (None, {}) or (isinstance(constraint,dict)
            and set(constraint) <= {'id','constraint_items'} and constraint.get('constraint_items') in (None, []))
        builtin = key != field
        if (prop.object_type_name != 'Text' or prop.object_spg_type != 'BASIC_TYPE'
                or data['inherited'] is not builtin or config['index_type'] != (None if builtin else index)
                or not empty_constraint
                or any(v not in (None, [], {}) for k,v in config.items() if k not in ('index_type','constraint'))
                or data['ext_info'] not in ({}, {'valueType': 'BASIC_TYPE'})
                or not builtin and (prop.name_zh != key or prop.desc not in (None, ''))):
            return False
    return True


def _native_index_name(label, field):
    # Neo4jIndexUtils uses lower underscore names for both label and property.
    snake = lambda value: '_'.join(re.findall(r'[A-Za-z][a-z0-9]*',value)).lower()
    return '_'+snake(label)+'_'+snake(field).strip('_')+'_index'


def _dimension(value):
    # The pinned OpenSPG model catalog serializes this integer as decimal text.
    if isinstance(value,str) and re.fullmatch('[1-9][0-9]{0,4}',value):value=int(value)
    if type(value) is not int or not 1<=value<=65536:raise RunBlocked('CONFIG')
    return value


def schema_changes(current, desired):
    """Add missing LuậtGT fields; never delete or overwrite a user's definition."""
    changes, updates, conflicts = [], [], []
    for name, expected in desired.items():
        if name not in current:
            changes.append(dict(kind='type', action='ADD', name=name))
            updates.append(('create_type', copy.deepcopy(expected)))
            for relation in expected.relations:
                changes.append(dict(kind='relation', action='ADD', name=name+'.'+relation))
            continue
        actual = current[name]
        if (actual.spg_type_enum != expected.spg_type_enum or actual.parent_type_name != expected.parent_type_name):
            conflicts.append(name)
            continue
        updated, changed = copy.deepcopy(actual), False
        for field, method, kind in (('properties','add_property','property'), ('relations','add_relation','relation')):
            existing = getattr(actual, field)
            for key, value in getattr(expected, field).items():
                label = name+'.'+key
                old = existing.get(key)
                if old is None:
                    getattr(updated, method)(copy.deepcopy(value)); changed = True
                    changes.append(dict(kind=kind,action='ADD',name=label))
                elif (old.object_type_name != value.object_type_name or old.constraint != value.constraint
                        or old.index_type != value.index_type
                        or set(old.sub_properties) != set(value.sub_properties)
                        or any(old.sub_properties[k].object_type_name != v.object_type_name for k,v in value.sub_properties.items())):
                    conflicts.append(label)
        if changed:
            changes.append(dict(kind='type',action='UPDATE',name=name))
            updates.append(('update_type', updated))
    return changes, updates, conflicts


@contextmanager
def target_state(project_id, token):
    from kag.bootstrap import initialize
    initialize()
    from knext.project.client import ProjectClient
    from knext.schema.client import SchemaClient, SchemaSession
    from knext.schema.marklang.schema_ml import SPGSchemaMarkLang
    target = selected_target(project_id, token)
    projects = ProjectClient(host_addr=target['endpoints']['openspg']); bound_sdk_requests(projects)
    reader = Neo4jReadClient(target['endpoints']['neo4j_http'], target['database'],
        username=os.environ['KAG_NEO4J_USERNAME'], password=os.environ['KAG_NEO4J_PASSWORD'], timeout=60)
    identity = BackendIdentitySession(projects, reader, NativeBackendTransport(target['endpoints']['openspg']),
        project_id=project_id, project_name=target['project_name'], namespace=target['namespace'],
        openspg_endpoint=target['endpoints']['openspg'])
    try:
        proof = identity.prove()
        serving = Neo4jReadClient(reader.endpoint, os.environ.get('KAG_BUILDER_SERVING_DATABASE','neo4j'),
            username=os.environ['KAG_NEO4J_USERNAME'], password=os.environ['KAG_NEO4J_PASSWORD'], timeout=60)
        if serving.database_identity() == proof.physical_database_id:
            raise RunBlocked('SCOPE')
        record = projects.get(id=project_id)
        config = record.config if not isinstance(record, dict) else record['config']
        config = json.loads(config) if isinstance(config,str) else config
        dimension = _dimension(config.get('vectorizer',{}).get('vector_dimensions'))
        client = SchemaClient(target['endpoints']['openspg'], project_id); bound_sdk_requests(client)
        session = SchemaSession(client._rest_client, project_id)
        script = (Path(__file__).resolve().parents[1]/'schema/VietRoadTraffic.schema').read_text(encoding='utf-8')
        script = script.replace('namespace VietRoadTraffic','namespace '+target['namespace'],1)
        desired = SPGSchemaMarkLang('',with_server=False,script_data_str=script).types
        yield dict(target=target, reader=reader, identity=identity, proof=proof, session=session,
            desired=desired, dimension=dimension, store=_store(record)[0])
    finally:
        identity.close()


def inspect(state):
    target, reader, dimension = state['target'], state['reader'], state['dimension']
    current = state['session'].spg_types
    desired = state['desired']; namespace = target['namespace']
    changes, updates, conflicts = schema_changes(current,desired)
    defaults = {name: value for name,value in current.items() if _default_type(value,namespace)}
    system_types={'Text','Integer','Float','STD.Date','STD.ChinaMobile','STD.ChinaTelCode',
        'STD.Email','STD.Timestamp','STD.IdCardNo','STD.MacAddress'}
    custom = [name for name,value in current.items() if name not in defaults and name not in desired
        and not (name in system_types and (value.spg_type_enum=='BASIC_TYPE'
            or value.spg_type_enum=='STANDARD_TYPE' and value.parent_type_name=='Thing'))]
    for name, value in current.items():
        if name in desired and (set(value.properties)-set(desired[name].properties)-{'id','name','description'}
                or set(value.relations)-set(desired[name].relations)):
            custom.append(name)
    for name,value in sorted(defaults.items()):
        changes.append(dict(kind='type',action='REMOVE',name=name))
        for relation in value.relations:
            changes.append(dict(kind='relation',action='REMOVE',name=name+'.'+relation))
        definition=copy.deepcopy(value)
        # Native sync receives the draft, including DELETE entries. Empty their
        # fields so it cannot recreate indexes for the types being removed.
        definition.properties=[];definition.relations=[]
        updates.append(('delete_type',definition))
    rows = reader.indexes(); indexes = []
    for local, targets in TARGETS.items():
        for _, field in targets:
            label=target['namespace']+'.'+local
            candidates=[r for r in rows if r.get('type')=='VECTOR' and r.get('labelsOrTypes')==[label] and r.get('properties')==[field]]
            status='KEEP' if candidates and all(_valid_index(r,dimension) for r in candidates) else 'BLOCKED' if candidates else 'ADD'
            indexes.append(dict(label=label,property=field,action=status))
    default_labels={namespace+'.'+local for local in DEFAULT_TYPES}
    native_defaults={(_native_index_name(label,field),label,field) for label in default_labels
        for field in (['_name_vector','_content_vector'] if label.endswith('.Chunk') else ['_name_vector'])}
    obsolete=[]; unknown=[]
    for row in rows:
        labels, fields=row.get('labelsOrTypes') or [],row.get('properties') or []
        if set(labels)&default_labels:
            if (row.get('type')=='VECTOR' and len(labels)==len(fields)==1
                    and (row['name'],labels[0],fields[0]) in native_defaults and _valid_index(row,dimension)):
                obsolete.append(row)
            elif not (row.get('type')=='FULLTEXT' and row['name']=='_default_text_index'
                    and set(labels)<=default_labels|set(desired) and set(fields)<={'name','content','semanticType'}):
                unknown.append(row['name'])
    cleanup=bool(defaults or obsolete or any(r.get('type')=='FULLTEXT'
        and set(r.get('labelsOrTypes') or [])&default_labels for r in rows))
    if cleanup:
        conflicts.extend(custom+unknown)
        # Sync all retained LuậtGT types together: native fulltext sync uses only
        # the current draft, not the entire released schema.
        changed={v.name for method,v in updates if method!='delete_type'}
        for name in desired:
            if name in current and name not in changed:
                updates.append(('update_type',copy.deepcopy(current[name])))
    for name in sorted(current):
        if name not in defaults:
            changes.append(dict(kind='type',action='KEEP',name=name))
            for relation in current[name].relations:
                changes.append(dict(kind='relation',action='KEEP',name=name+'.'+relation))
    sync_names={value.name for method,value in updates if method!='delete_type'}
    native_vectors={(_native_index_name(label,field),label,field) for label in sync_names for field in
        ['_name_vector']+[field for _,field in TARGETS[label.rsplit('.',1)[1]]]}|{
        ('_entity_name_vector_index','Entity','_name_vector'),('_entity_desc_vector_index','Entity','_desc_vector')}
    index_changes=[]
    for row in rows:
        labels,fields=row.get('labelsOrTypes') or [],row.get('properties') or []
        action='KEEP'
        if row in obsolete:action='REMOVE'
        elif updates and row.get('type')=='VECTOR' and len(labels)==len(fields)==1 and (row['name'],labels[0],fields[0]) in native_vectors:
            action='REBUILD'
        elif updates and row.get('type')=='FULLTEXT' and row['name']=='_default_text_index' and set(labels)<=default_labels|set(desired) and set(fields)<={'name','content','semanticType'}:
            action='REBUILD'
        elif any(labels==[r['label']] and fields==[r['property']] for r in indexes) and _valid_index(row,dimension):
            pass
        elif cleanup and row.get('type')!='LOOKUP':
            conflicts.append(row['name']);action='BLOCKED'
        index_changes.append(dict(name=row['name'],type=row['type'],labels=labels,properties=fields,action=action))
    if updates:
        planned=[dict(name=name,type='VECTOR',labels=[label],properties=[field],action='ADD')
            for name,label,field in sorted(native_vectors)]
        planned.append(dict(name='_default_text_index',type='FULLTEXT',labels=sorted(sync_names),properties=['name'],action='ADD'))
        existing={r['name'] for r in index_changes}
        index_changes.extend(r for r in planned if r['name'] not in existing)
        for row in index_changes:
            if row['action']=='REBUILD' and row['type']=='FULLTEXT':
                row['labels']=sorted(sync_names);row['properties']=['name']
    else:
        for row in indexes:
            if row['action']=='ADD':
                index_changes.append(dict(name='luatgt_'+row['label'].replace('.','_')+row['property'],
                    type='VECTOR',labels=[row['label']],properties=[row['property']],action='ADD'))
    for row in indexes:
        if row['action']=='KEEP' and any(r['action']=='REBUILD' and r['labels']==[row['label']] and r['properties']==[row['property']] for r in index_changes):
            row['action']='REBUILD'
    counts=reader._query('structure_counts')[0]
    if any(type(counts.get(k)) is not int or counts[k]<0 for k in ('nodes','edges')):raise RunBlocked('INTEGRITY')
    # Native schema sync rebuilds indexes. It is restricted to an empty physical database.
    reason = ('SCHEMA_CUSTOM' if conflicts else 'SCHEMA_DATA' if (updates or obsolete) and any(counts.values())
        else 'INDEX' if any(r['action']=='BLOCKED' for r in indexes)
        else None)
    from kag.runner import validate_target_schema
    try:
        validate_target_schema(current,target_contract(namespace))
        build_ready=all(r['action'] in ('KEEP','REBUILD') for r in indexes)
    except RunBlocked:build_ready=False
    snapshot=dict(target={k:target[k] for k in ('project_id','project_name','namespace','database')},
        database_id=state['proof'].physical_database_id,dimension=dimension,counts=counts,
        changes=changes,indexes=indexes,conflicts=sorted(set(conflicts)),code=reason,
        build_ready=build_ready,default_types=sorted(defaults),index_changes=index_changes,
        native_rebuild=[r['name'] for r in index_changes if r['action']=='REBUILD'])
    signature=dict(snapshot=snapshot, schema={k:v.to_rest().to_dict() for k,v in current.items()}, indexes=rows,
        route=state['proof'].to_receipt(),store=state['store'])
    snapshot['signature']=_spec_hash(signature)
    return snapshot, updates


def preview(project_id, token):
    with target_state(project_id,token) as state:
        return inspect(state)[0]


def apply(project_id, token, expected, lock_root):
    from neo4j import GraphDatabase, Query
    from kag.runner import validate_target_schema
    with target_state(project_id,token) as state:
        proof=state['proof']
        lock=GraphLock(lock_root,proof.physical_database_id,
            dict(scope='PRODUCTION',project_id=project_id,namespace=state['target']['namespace'],database=state['target']['database']),
            backend_proof=proof,backend_session=state['identity'])
        lock.acquire()
        uncertain=False
        try:
            from knext.schema.client import SchemaSession
            state['session']=SchemaSession(state['session']._rest_client,project_id)
            before,updates=inspect(state)
            if before['signature']!=expected or before['code']:raise RunBlocked('STRUCTURE_STALE')
            if selected_target(project_id,token)!=state['target']:raise RunBlocked('STRUCTURE_STALE')
            state['identity'].validate(proof)
            lock.assert_owned(proof.physical_database_id)
            for method,definition in updates:getattr(state['session'],method)(definition)
            if updates:
                uncertain=True
                state['session'].commit()
                uncertain=False
            # Read again after native sync; it may already have created all four indexes.
            fresh=state['reader'].indexes();store=state['store']
            with GraphDatabase.driver(state['target']['endpoints']['neo4j_uri'],auth=(store['user'],store['password']),
                    connection_timeout=10,connection_acquisition_timeout=10,max_transaction_retry_time=0) as driver:
                for row in before['index_changes']:
                    if row['action']!='REMOVE':continue
                    lock.assert_owned(proof.physical_database_id);state['identity'].validate(proof)
                    if selected_target(project_id,token)!=state['target']:raise RunBlocked('STRUCTURE_STALE')
                    if any(state['reader']._query('structure_counts')[0].values()):raise RunBlocked('SCHEMA_DATA')
                    current_rows=state['reader'].indexes()
                    actual=[r for r in current_rows if r['name']==row['name']]
                    if not actual:continue
                    if (len(actual)!=1 or actual[0]['labelsOrTypes']!=row['labels'] or actual[0]['properties']!=row['properties']
                            or not _valid_index(actual[0],state['dimension'])):raise RunBlocked('STRUCTURE_STALE')
                    name=row['name'].replace('`','``')
                    with driver.session(database=state['target']['database']) as session:
                        session.run(Query(f'DROP INDEX `{name}` IF EXISTS',timeout=60)).consume()
                for row in before['indexes']:
                    existing=[r for r in fresh if r.get('type')=='VECTOR' and r.get('labelsOrTypes')==[row['label']] and r.get('properties')==[row['property']]]
                    if existing:continue
                    lock.assert_owned(proof.physical_database_id);state['identity'].validate(proof)
                    name='luatgt_'+row['label'].replace('.','_')+row['property']
                    query=(f'CREATE VECTOR INDEX `{name}` IF NOT EXISTS FOR (n:`{row["label"]}`) ON (n.`{row["property"]}`) '
                        'OPTIONS {indexConfig: {`vector.dimensions`: $dimension, `vector.similarity_function`: "cosine"}}')
                    with driver.session(database=state['target']['database']) as session:
                        session.run(Query(query,timeout=60),dimension=state['dimension']).consume()
            deadline=time.monotonic()+60
            while True:
                try:
                    _indexes(state['reader'],target_contract(state['target']['namespace']),state['dimension'])
                    rows={r['name']:r for r in state['reader'].indexes()}
                    for planned in before['index_changes']:
                        if planned['action'] not in ('ADD','REBUILD'):continue
                        actual=rows.get(planned['name'])
                        if (not actual or actual['type']!=planned['type'] or actual['state']!='ONLINE'
                                or set(actual['labelsOrTypes'])!=set(planned['labels'])
                                or set(actual['properties'])!=set(planned['properties'])
                                or actual['type']=='VECTOR' and not _valid_index(actual,state['dimension'])):
                            raise RunBlocked('INDEX')
                    break
                except RunBlocked:
                    if time.monotonic()>=deadline:raise
                    time.sleep(.5)
            current=SchemaSession(state['session']._rest_client,project_id).spg_types
            validate_target_schema(current,target_contract(state['target']['namespace']))
            if any(name in current for name in before['default_types']):raise RunBlocked('SCHEMA')
            state['session']=SchemaSession(state['session']._rest_client,project_id)
            after,_=inspect(state)
            if after['default_types'] or any(r['action']=='REMOVE' for r in after['index_changes']):raise RunBlocked('SCHEMA')
            state['identity'].validate(proof)
        finally:
            # A lost native sync response can leave remote index work in flight, as with Runner writes.
            if not uncertain:lock.release()
    return preview(project_id,token)


def clear_permissions(state):
    """Deployment grants destruction independently from OWNER and schema preparation."""
    from kag.backend_identity import _field
    from kag.builder.projects import _project_client
    target=state['target'];physical=state['proof'].physical_database_id
    try:
        grants=json.loads(os.environ.get('KAG_BUILDER_CLEAR_TARGETS','[]'))
        if (type(grants) is not list or len(grants)>256 or any(type(row) is not dict
                or set(row)!={'project_id','database_id'} or type(row['project_id']) is not int
                or not 1<=row['project_id']<=2147483647 or not isinstance(row['database_id'],str)
                or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',row['database_id']) for row in grants)
                or dict(project_id=target['project_id'],database_id=physical) not in grants):
            raise ValueError
    except (ValueError,TypeError):raise RunBlocked('CLEAR_DENIED') from None
    reader=state['reader']
    if reader.protected_database_identity(os.environ.get('KAG_BUILDER_SERVING_DATABASE','neo4j'))==physical:
        raise RunBlocked('CLEAR_SERVING')
    # The query runtime selects only this operator-configured immutable release.
    release_id=os.environ.get('KAG_HTTP_RELEASE_ID')
    if release_id:
        try:
            from kag.http_api.artifacts import load_release
            release=load_release(Path(os.environ['KAG_HTTP_RELEASE_ROOT']),release_id)
            if (release.descriptor['database_id']==physical
                    or reader.protected_database_identity(release.descriptor['database'])==physical):
                raise RunBlocked('CLEAR_SERVING')
        except RunBlocked:raise
        except Exception:raise RunBlocked('CLEAR_SERVING') from None
    endpoint=urlsplit(target['endpoints']['neo4j_uri'])
    records=_project_client(target['endpoints']['openspg'])._rest_client.project_get()
    try:
        for record in records:
            if str(_field(record,'id'))==str(target['project_id']):continue
            store,address=_store(record);other=urlsplit(address)
            # Unknown aliases/remote stores cannot prove this database is dedicated.
            if (other.hostname.lower(),other.port)!=(endpoint.hostname.lower(),endpoint.port):
                raise RunBlocked('CLEAR_SHARED')
            if reader.protected_database_identity(store['database'])==physical:raise RunBlocked('CLEAR_SHARED')
    except RunBlocked:raise
    except Exception:raise RunBlocked('CLEAR_SHARED') from None
    state['identity'].validate(state['proof'])
    return grants


def clear_snapshot(state):
    from neo4j import GraphDatabase, Query, READ_ACCESS
    from knext.schema.client import SchemaSession
    state['session']=SchemaSession(state['session']._rest_client,state['target']['project_id'])
    grants=clear_permissions(state)
    digest=hashlib.sha256();counts=dict(nodes=0,edges=0)
    store=state['store'];target=state['target']
    with GraphDatabase.driver(target['endpoints']['neo4j_uri'],auth=(store['user'],store['password']),
            connection_timeout=10,connection_acquisition_timeout=10,max_transaction_retry_time=0) as driver:
        with driver.session(database=target['database'],default_access_mode=READ_ACCESS,fetch_size=256) as session:
            for kind,query in [('nodes','MATCH (n) RETURN elementId(n) AS id,labels(n) AS labels,properties(n) AS properties ORDER BY id'),
                    ('edges','MATCH (a)-[r]->(b) RETURN elementId(r) AS id,elementId(a) AS source,elementId(b) AS target,type(r) AS relation,properties(r) AS properties ORDER BY id')]:
                for record in session.run(Query(query,timeout=60)):
                    row=record.data()
                    if 'labels' in row:row['labels']=sorted(row['labels'])
                    digest.update((kind+json.dumps(row,sort_keys=True,ensure_ascii=False,
                        default=lambda v:dict(type=type(v).__name__,value=repr(v)))+'\n').encode())
                    counts[kind]+=1
    schema={k:v.to_rest().to_dict() for k,v in state['session'].spg_types.items()}
    indexes=sorted(state['reader'].indexes(),key=lambda r:r['name'])
    structure_signature=_spec_hash(dict(schema=schema,indexes=indexes))
    report=dict(target={k:target[k] for k in ('project_id','project_name','namespace','database')},
        database_id=state['proof'].physical_database_id,counts=counts,batch_size=500)
    return dict(report=report,structure_signature=structure_signature,
        signature=_spec_hash(dict(report=report,structure=structure_signature,data=digest.hexdigest(),grants=grants)))


def preview_clear(project_id,token,lock_root):
    with target_state(project_id,token) as state:
        proof=state['proof']
        lock=GraphLock(lock_root,proof.physical_database_id,
            dict(scope='PRODUCTION',project_id=project_id,namespace=state['target']['namespace'],database=state['target']['database']),
            backend_proof=proof,backend_session=state['identity'])
        lock.acquire()
        try:return clear_snapshot(state)
        finally:lock.release()


def apply_clear(project_id,token,expected,lock_root,*,started,progress):
    """Empty only an explicitly dedicated database; retain all schema and run files."""
    from neo4j import GraphDatabase,Query
    with target_state(project_id,token) as state:
        proof=state['proof'];target=state['target']
        lock=GraphLock(lock_root,proof.physical_database_id,
            dict(scope='PRODUCTION',project_id=project_id,namespace=target['namespace'],database=target['database']),
            backend_proof=proof,backend_session=state['identity'])
        lock.acquire();uncertain=False
        try:
            before=clear_snapshot(state)
            if before['signature']!=expected:raise RunBlocked('CLEAR_STALE')
            if selected_target(project_id,token)!=target:raise RunBlocked('CLEAR_STALE')
            started(proof.physical_database_id)
            store=state['store'];deleted=dict(nodes=0,edges=0)
            with GraphDatabase.driver(target['endpoints']['neo4j_uri'],auth=(store['user'],store['password']),
                    connection_timeout=10,connection_acquisition_timeout=10,max_transaction_retry_time=0) as driver:
                with driver.session(database=target['database']) as session:
                    for kind,query in [('edges','MATCH ()-[r]->() WITH r LIMIT $batch DELETE r RETURN count(*) AS deleted'),
                            ('nodes','MATCH (n) WITH n LIMIT $batch DETACH DELETE n RETURN count(*) AS deleted')]:
                        while True:
                            clear_permissions(state)
                            if selected_target(project_id,token)!=target:raise RunBlocked('CLEAR_STALE')
                            lock.assert_owned(proof.physical_database_id)
                            uncertain=True
                            row=session.run(Query(query,timeout=60),batch=before['report']['batch_size']).single(strict=True)
                            uncertain=False
                            count=row['deleted']
                            if type(count) is not int or not 0<=count<=before['report']['batch_size']:raise RunBlocked('INTEGRITY')
                            deleted[kind]+=count;progress(dict(deleted))
                            if not count:break
            after=clear_snapshot(state)
            if any(after['report']['counts'].values()) or before['structure_signature']!=after['structure_signature']:
                raise RunBlocked('CLEAR_STALE')
            return after
        except Exception:
            if uncertain:raise RunBlocked('CLEAR_UNCERTAIN') from None
            raise
        finally:
            if not uncertain:lock.release()
