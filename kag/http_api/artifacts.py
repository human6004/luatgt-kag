"""Operator-sealed immutable evidence; no runtime construction or HTTP routes.

The root and selected release are trusted configuration, never request inputs.
Hashes establish integrity within that trust boundary, not independent live proof.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sqlite3
import tempfile
from types import MappingProxyType
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from kag.builder.codec import canonical_json, decode_properties
from kag.vector_contract import TARGETS
from .contract import ApiFailure, SchemaIdentity, _json_value, _text

if TYPE_CHECKING:
    from kag.legal_solver import AnswerResult, Citation


class VerificationState(str, Enum):
    VERIFIED = 'verified'
    UNAVAILABLE = 'unavailable'
    INVALID = 'invalid'
    UNVERIFIED = 'unverified'


class ArtifactFailure(ApiFailure):
    """Internal state supplements fixed public errors; no raw cause details."""
    def __init__(self, state: VerificationState, code='NOT_READY'):
        self.state = state
        super().__init__(code)


def _invalid(code='NOT_READY'):
    raise ArtifactFailure(VerificationState.INVALID, code)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _freeze(value):
    if type(value) is dict:
        return MappingProxyType({k:_freeze(v) for k,v in value.items()})
    if type(value) is list:
        return tuple(_freeze(v) for v in value)
    return value


def _keys(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        _invalid()


def _identity(value):
    if not _text(value) or not value.strip() or len(value.encode('utf-8')) > 512:
        _invalid()
    return value


def _date(value):
    if not _text(value) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        _invalid()
    return date.fromisoformat(value)


def _json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                _invalid()
            value[key] = item
        return value

    def constant(value):
        _invalid()

    value = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                       parse_constant=constant)
    _json_value(value)
    return value


def _read(root, filename):
    # Reject symlinks at every component, including the operator's root.
    root = root.absolute()
    path = root/filename
    if any(p.is_symlink() for p in (path, root, *root.parents)):
        _invalid()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64*1024*1024:
            _invalid()
        raw = stream.read(64*1024*1024+1)
    if len(raw) > 64*1024*1024:
        _invalid()
    return raw


_BINDING = ('release_id','schema_contract','source_snapshot_id','graph_fingerprint',
            'database_id','server_id','database','namespace')
_FILES = {'source_catalog_sha256':'source-catalog.json', 'graph_receipt_sha256':'graph-receipt.json',
    'backend_receipt_sha256':'backend-receipt.json',
    'serving_authority_receipt_sha256':'serving-authority.json',
    'webapp_publication_sha256':'webapp-publication.json'}
_PRODUCTION = ('model_identity','dimension','run_id','partial','expected_graph_sha256','provenance_sha256')


def release_contract(namespace, *, production=False):
    root = Path(__file__).resolve().parents[1]/'schema'
    raw = _read(root,'schema_contract.json')
    if production:
        from kag.builder.production_scope import target_contract
        raw = canonical_json(target_contract(namespace)).encode('utf-8')
    contract = _json(raw)
    if namespace != contract['namespace']:
        _invalid()
    return raw, SchemaIdentity(namespace,_sha(_read(root,'VietRoadTraffic.schema')),_sha(raw))


@dataclass(frozen=True)
class SourceRecord:
    entity_type: str
    entity_id: str
    doc_id: str
    unit_id: str | None
    sign_id: str | None
    field: str
    physical_field: str
    source_text: str
    source_sha256: str
    metadata: MappingProxyType
    graph_context: tuple

    @property
    def evidence_id(self):
        return _sha(canonical_json([self.entity_type,self.entity_id,self.field]).encode('utf-8'))


@dataclass(frozen=True)
class ServingRelease:
    root: Path
    release_id: str
    release_kind: str
    schema_contract: SchemaIdentity
    descriptor_sha256: str
    descriptor: MappingProxyType
    records: tuple[SourceRecord, ...]
    artifacts: tuple[tuple[str, bytes], ...]
    contract_bytes: bytes
    backend: MappingProxyType
    publication: MappingProxyType | None


@dataclass(frozen=True)
class VerifiedSource:
    citation: Citation
    entity_type: str
    entity_id: str
    source_text: str
    java_eligible: bool
    source_sha256: str
    physical_field: str
    metadata: MappingProxyType | None = None
    document_metadata: MappingProxyType | None = None


@dataclass(frozen=True)
class VerifiedSources:
    citations: tuple[VerifiedSource, ...]
    release_id: str
    source_snapshot_id: str
    schema_contract: SchemaIdentity
    release_descriptor_sha256: str
    as_of: date
    webapp_snapshot_id: str | None
    publication_state: VerificationState
    state: VerificationState = VerificationState.VERIFIED
    source_mode: str = 'webapp-publication-v1'


def dataset_sources(release):
    return (release.release_kind == 'PRODUCTION' and release.descriptor.get('schema') == 'h1-release-1.1'
            and release.descriptor.get('source_mode') == 'dataset-snapshot-v1')


def _binding(receipt, descriptor):
    if any(receipt.get(key) != descriptor[key] for key in _BINDING):
        _invalid()


def _endpoint(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http','https') or not parsed.hostname or not parsed.port
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('','/') or value.strip() != value):
        _invalid()


def _catalog(value, descriptor, contract):
    _keys(value, ('schema',*_BINDING,'records'))
    _binding(value,descriptor)
    if value['schema'] != 'h1-source-catalog-1.0' or type(value['records']) is not list:
        _invalid()
    records, seen, entities = [], set(), {}
    for entry in value['records']:
        _keys(entry, SourceRecord.__dataclass_fields__)
        kind = entry['entity_type'].removeprefix(descriptor['namespace']+'.')
        if kind not in TARGETS or entry['entity_type'] != descriptor['namespace']+'.'+kind:
            _invalid()
        for field in ('entity_id','doc_id','field','physical_field'):
            _identity(entry[field])
        for field in ('unit_id','sign_id'):
            if entry[field] is not None:
                _identity(entry[field])
        rows = contract['node_properties'][kind]
        metadata = entry['metadata']
        if type(metadata) is not dict or set(metadata) - {r['logical_name'] for r in rows}:
            _invalid()
        physical = {r['schema_name']:canonical_json(metadata[r['logical_name']])
            if r['contract_type'] == 'JSON_TEXT' else metadata[r['logical_name']]
            for r in rows if r['logical_name'] in metadata}
        decoded = decode_properties(physical,rows)
        if (decoded != metadata or decoded['id'] != entry['entity_id'] or decoded['name'] != decoded['id']
                or kind == 'LegalUnit' and decoded.get('unit_type') not in contract['unit_type_values']):
            _invalid()
        expected = (decoded['id'],None,None) if kind == 'LegalDocument' else (
            decoded['doc_id'], decoded['id'] if kind == 'LegalUnit' else decoded.get('unit_id'),
            decoded['id'] if kind == 'TrafficSign' else None)
        if (entry['doc_id'],entry['unit_id'],entry['sign_id']) != expected:
            _invalid()
        row = next((r for r in rows if r['schema_name'] == entry['physical_field']), None)
        if (row is None or entry['field'] not in (row['logical_name'],row['schema_name'])
                or not _text(entry['source_text']) or not entry['source_text']
                or metadata.get(row['logical_name']) != entry['source_text']
                or _sha(entry['source_text'].encode('utf-8')) != entry['source_sha256']):
            _invalid()
        if type(entry['graph_context']) is not list:
            _invalid()
        relation_keys = set()
        for relation in entry['graph_context']:
            _keys(relation, ('from','predicate','to','properties'))
            rule = contract['relations'].get(relation['predicate'])
            if not rule or any(type(relation[s]) is not list or len(relation[s]) != 2 for s in ('from','to')):
                _invalid()
            for side in ('from','to'):
                _identity(relation[side][1])
                if relation[side][0] != descriptor['namespace']+'.'+rule[side+'_type']:
                    _invalid()
            if [entry['entity_type'],entry['entity_id']] not in (relation['from'],relation['to']):
                _invalid()
            if type(relation['properties']) is not dict:
                _invalid()
            relation_key = (*relation['from'],relation['predicate'],*relation['to'])
            if relation_key in relation_keys:
                _invalid()
            relation_keys.add(relation_key)
            relation_rows = contract['relation_properties'][relation['predicate']]
            if set(relation['properties']) - {r['logical_name'] for r in relation_rows}:
                _invalid()
            encoded = {r['schema_name']:canonical_json(relation['properties'][r['logical_name']])
                if r['contract_type'] == 'JSON_TEXT' else relation['properties'][r['logical_name']]
                for r in relation_rows if r['logical_name'] in relation['properties']}
            if decode_properties(encoded,relation_rows) != relation['properties']:
                _invalid()
        record = SourceRecord(**{**entry,'metadata':_freeze(metadata),
                                 'graph_context':_freeze(entry['graph_context'])})
        if record.evidence_id in seen:
            _invalid()
        seen.add(record.evidence_id)
        key = record.entity_type,record.entity_id
        identity = record.metadata,record.graph_context
        if key in entities and entities[key] != identity:
            _invalid()
        entities[key] = identity
        records.append(record)
    for record in records:
        if (descriptor['namespace']+'.LegalDocument',record.doc_id) not in entities:
            _invalid('SOURCE_VALIDATION_FAILED')
        linked_unit = record.unit_id if record.sign_id else record.metadata.get('parent_id')
        if linked_unit:
            unit = entities.get((descriptor['namespace']+'.LegalUnit',linked_unit))
            # Bounded SAMPLE may retain external metadata parents; actual edges stay closed below.
            if ((unit is None and descriptor['release_kind'] != 'SAMPLE' and descriptor.get('partial') is not True)
                    or (unit is not None and unit[0].get('doc_id') != record.doc_id)):
                _invalid()
        for relation in record.graph_context:
            if any(tuple(relation[s]) not in entities for s in ('from','to')):
                _invalid()
    return tuple(records)


def _publication(value, descriptor, records):
    if value is None:
        return None
    window = value.get('schema') == 'h1-webapp-publication-2.0' if type(value) is dict else False
    _keys(value, ('schema','snapshot_id','schema_contract','source_snapshot_id','as_of',
                  'timezone','documents','units',*(('serving_until',) if window else ())))
    if (value['schema'] not in ('h1-webapp-publication-1.0','h1-webapp-publication-2.0','h1-webapp-publication-3.0')
            or value['schema']=='h1-webapp-publication-3.0' and descriptor['release_kind']!='PRODUCTION'
            or value['timezone'] != 'Asia/Saigon'
            or value['snapshot_id'] != descriptor['webapp_snapshot_id']
            or value['schema_contract'] != descriptor['schema_contract']
            or value['source_snapshot_id'] != descriptor['source_snapshot_id']):
        _invalid()
    _date(value['as_of'])
    if window:
        _date(value['serving_until'])
        days=(date.fromisoformat(value['serving_until'])-date.fromisoformat(value['as_of'])).days
        if descriptor['release_kind']!='SAMPLE' or not 0<=days<=6:_invalid()
    documents = {r.entity_id:r for r in records if r.entity_type.endswith('.LegalDocument')}
    units = {r.entity_id:r for r in records if r.entity_type.endswith('.LegalUnit') and r.field == 'text'}
    for group in ('documents','units'):
        if type(value[group]) is not list:
            _invalid()
        seen = set()
        for entry in value[group]:
            fields = ('doc_id','published','version','effective_from','effective_to',
                'current_effective','replaces_eligible') if group == 'documents' else (
                'doc_id','unit_id','text_sha256','published','version')
            _keys(entry,fields)
            key = entry['doc_id'] if group == 'documents' else entry['unit_id']
            _identity(key)
            _identity(entry['version'])
            if key in seen or type(entry['published']) is not bool:
                _invalid()
            seen.add(key)
            record = (documents if group == 'documents' else units).get(key)
            if record is None or record.doc_id != entry['doc_id']:
                _invalid()
            if group == 'units':
                if entry['text_sha256'] != record.source_sha256:
                    _invalid()
            else:
                for field in ('current_effective','replaces_eligible'):
                    if type(entry[field]) is not bool:
                        _invalid()
                for field in ('effective_from','effective_to'):
                    if entry[field] != record.metadata.get(field):
                        _invalid()
                    if entry[field] is not None:
                        _date(entry[field])
    return _freeze(value)


def publication_covers(publication, as_of):
    """Snapshot date bounds sealed SAMPLE serving authority, never legal effectivity."""
    if publication is None or type(as_of) is not date:return False
    start=publication['as_of']
    if publication['schema']=='h1-webapp-publication-3.0':
        return start<=as_of.isoformat()
    end=publication['serving_until'] if publication['schema']=='h1-webapp-publication-2.0' else start
    return start<=as_of.isoformat()<=end


def bind_publication(source, binding, records):
    """Select actual WebApp approvals; missing/draft/changed sources stay unavailable to Chat."""
    _keys(source,('as_of','documents','units'))
    _date(source['as_of'])
    wanted = {'documents':{r.entity_id:r for r in records if r.entity_type.endswith('.LegalDocument')},
              'units':{r.entity_id:r for r in records if r.entity_type.endswith('.LegalUnit') and r.field=='text'}}
    selected, issues = {}, set()
    for group in ('documents','units'):
        rows=source[group]
        if type(rows) is not list: _invalid()
        key='doc_id' if group=='documents' else 'unit_id'
        found={}
        for row in rows:
            if type(row) is not dict or not isinstance(row.get(key),str) or row[key] in found: _invalid()
            found[row[key]]=row
        selected[group]=[]
        for identity,record in wanted[group].items():
            row=found.get(identity)
            if row is None:
                issues.add('SOURCE_MISSING');continue
            if row.get('doc_id')!=record.doc_id:
                issues.add('SOURCE_TEXT_MISMATCH');continue
            if group=='units' and row.get('text_sha256')!=record.source_sha256:
                issues.add('SOURCE_TEXT_MISMATCH');continue
            if group=='documents' and any(row.get(f)!=record.metadata.get(f) for f in ('effective_from','effective_to')):
                issues.add('SOURCE_TEXT_MISMATCH');continue
            selected[group].append(dict(row))
            if row.get('published') is not True: issues.add('SOURCE_NOT_PUBLISHED')
            if group=='documents' and (row.get('current_effective') is not True or row.get('replaces_eligible') is not True):
                issues.add('SOURCE_NOT_EFFECTIVE')
    if not wanted['units']: issues.add('SOURCE_MISSING')
    value=dict(schema='h1-webapp-publication-3.0',**binding,as_of=source['as_of'],timezone='Asia/Saigon',**selected)
    value={key:value[key] for key in ('schema','schema_contract','source_snapshot_id','as_of','timezone','documents','units')}
    value['snapshot_id']='webapp-'+_sha(canonical_json(value).encode())
    return value,sorted(issues)


def load_release(root: Path, expected_release_id: str) -> ServingRelease:
    """Load one operator-selected snapshot; never claim a live verified backend."""
    try:
        if not isinstance(root,Path):
            _invalid()
        _identity(expected_release_id)
        raw = _read(root,'release.json')
        descriptor = _json(raw)
        production=descriptor.get('release_kind')=='PRODUCTION'
        dataset=descriptor.get('schema')=='h1-release-1.1'
        _keys(descriptor, ('schema',*_BINDING,'release_kind',*_FILES,'serving_mode','sealed_at','webapp_snapshot_id',
                          *(_PRODUCTION if production else ()), *(('source_mode',) if dataset else ())))
        if (descriptor['schema'] not in ('h1-release-1.0','h1-release-1.1') or descriptor['release_id'] != expected_release_id
                or dataset and (not production or descriptor['source_mode']!='dataset-snapshot-v1'
                    or descriptor['webapp_snapshot_id'] is not None or descriptor['webapp_publication_sha256'] is not None)):
            _invalid()
        for field in (*_BINDING,'release_kind'):
            if field != 'schema_contract':
                _identity(descriptor[field])
        if not re.fullmatch(r'[0-9a-f]{64}',descriptor['graph_fingerprint']):
            _invalid()
        schema_root = Path(__file__).resolve().parents[1]/'schema'
        contract_bytes,identity=release_contract(descriptor['namespace'],production=production)
        contract = _json(contract_bytes)
        if (descriptor['schema_contract'] != identity.__dict__ or descriptor['namespace'] != identity.namespace
                or contract['runtime_contract']['schema_sha256'] != identity.schema_sha256):
            _invalid()
        if descriptor['serving_mode'] != ('guarded_worker' if production else 'sealed_read_only'):
            raise ArtifactFailure(VerificationState.UNVERIFIED)
        if production and (type(descriptor['dimension']) is not int or not 1<=descriptor['dimension']<=65536
                or type(descriptor['partial']) is not bool): _invalid()
        if production:
            _identity(descriptor['model_identity']);_identity(descriptor['run_id'])
        if not _text(descriptor['sealed_at']) or not re.fullmatch(
                r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z',descriptor['sealed_at']):
            _invalid()
        datetime.fromisoformat(descriptor['sealed_at'].replace('Z','+00:00'))
        if (descriptor['webapp_snapshot_id'] is None) != (descriptor['webapp_publication_sha256'] is None):
            _invalid()
        loaded, artifacts = {}, [('release.json',raw)]
        if production:
            for key,filename in (('expected_graph_sha256','expected.sqlite3'),('provenance_sha256','provenance.jsonl')):
                data=_read(root,filename)
                if _sha(data)!=descriptor[key]: _invalid()
                artifacts.append((filename,data))
        for field, filename in _FILES.items():
            expected = descriptor[field]
            if field == 'webapp_publication_sha256' and expected is None:
                continue
            if not _text(expected) or not re.fullmatch(r'[0-9a-f]{64}',expected):
                _invalid()
            data = _read(root,filename)
            if _sha(data) != expected:
                _invalid()
            loaded[filename] = _json(data)
            artifacts.append((filename,data))
        graph, backend, authority = [loaded[n] for n in
            ('graph-receipt.json','backend-receipt.json','serving-authority.json')]
        _keys(graph, ('schema',*_BINDING,'graph_verified','source_catalog_sha256'))
        _keys(backend, ('schema',*_BINDING,'reader_endpoint','project_id','identity_attested'))
        _keys(authority, ('schema',*_BINDING,'reader_endpoint','project_id','graph_frozen','schema_frozen',
            'read_only','catalog_complete','source_catalog_sha256','backend_receipt_sha256'))
        for receipt, schema in ((graph,'h1-graph-receipt-1.0'),(backend,'h1-backend-receipt-1.0'),
                               (authority,'h1-serving-authority-1.0')):
            if receipt['schema'] != schema:
                _invalid()
            _binding(receipt,descriptor)
        if (graph['source_catalog_sha256'] != descriptor['source_catalog_sha256']
                or authority['source_catalog_sha256'] != descriptor['source_catalog_sha256']
                or authority['backend_receipt_sha256'] != descriptor['backend_receipt_sha256']
                or authority['reader_endpoint'] != backend['reader_endpoint']
                or authority['project_id'] != backend['project_id']):
            _invalid()
        _endpoint(backend['reader_endpoint'])
        _identity(backend['project_id'])
        if (graph['graph_verified'] is not True or backend['identity_attested'] is not True
                or authority['catalog_complete'] is not True
                or any(authority[k] is not (not production) for k in ('graph_frozen','schema_frozen','read_only'))):
            raise ArtifactFailure(VerificationState.UNVERIFIED)
        records = _catalog(loaded['source-catalog.json'],descriptor,contract)
        publication = _publication(loaded.get('webapp-publication.json'),descriptor,records)
        return ServingRelease(root.absolute(),expected_release_id,descriptor['release_kind'],identity,
            _sha(raw),_freeze(descriptor),records,tuple(artifacts),contract_bytes,_freeze(backend),publication)
    except ArtifactFailure:
        raise
    except OSError:
        raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
    except ApiFailure:
        raise ArtifactFailure(VerificationState.INVALID) from None
    except (ValueError,TypeError,KeyError,AttributeError,RecursionError):
        raise ArtifactFailure(VerificationState.INVALID) from None


def publish_run(root, run_directory, reader, *, release_id, source_snapshot_id, approve=False, publication=None,
                release_kind='SAMPLE', source_mode='webapp-publication-v1'):
    """Preview by default; explicit operator approval publishes a frozen SAMPLE.

    This does not activate serving or attest network isolation/reader privileges.
    The existing operational proof and operator pin remain required at the API.
    """
    from kag.run_state import atomic_json
    from kag.verify import verify_graph

    root, run_directory = Path(root).absolute(), Path(run_directory).absolute()
    if root.exists():
        raise FileExistsError(root)
    if any(p.is_symlink() for p in (root, *root.parents)):
        _invalid()
    _identity(release_id); _identity(source_snapshot_id)
    receipt = _json(_read(run_directory,'receipt.json'))
    identity, stages = receipt['identity'], receipt['stages']
    status=_json(_read(run_directory,'status.json'))
    metadata = reader.database_metadata()
    contract_root = Path(__file__).resolve().parents[1]/'schema'
    production=release_kind=='PRODUCTION'
    if release_kind not in ('SAMPLE','PRODUCTION'): _invalid()
    dataset=source_mode=='dataset-snapshot-v1'
    if source_mode not in ('webapp-publication-v1','dataset-snapshot-v1') or dataset and (not production or publication is not None):_invalid()
    contract_bytes,schema_identity=release_contract(identity['namespace'],production=production)
    contract = _json(contract_bytes)
    scope='PRODUCTION' if production else 'FRESH_SAMPLE'
    if (identity['scope'] != scope or identity['write_mode'] != 'WRITE'
            or stages['release']['kind'] != scope+'/WRITE'
            or status['state']!='PASS' or status['stage']!='release' or status['run_id']!=identity['run_id']
            or identity['database'] != reader.database or identity['database_id'] != metadata['databaseID']
            or identity['namespace'] != contract['namespace']
            or identity['backend_identity']['runtime_identity'][0] != metadata['serverID']
            or metadata['name'] != reader.database or metadata['currentStatus'] != 'online'):
        _invalid()
    readonly = {'catalog':[{'name':reader.database,'access':'read-only','currentStatus':'online'}],
                'settings':[{'name':'server.databases.read_only','value':reader.database}]}
    if not production and reader.readonly_state() != readonly:
        raise ArtifactFailure(VerificationState.UNVERIFIED)
    for suffix in ('-wal','-shm','-journal'):
        if (run_directory/('expected.sqlite3'+suffix)).exists():
            _invalid()
    expected = _read(run_directory,'expected.sqlite3')
    provenance = _read(run_directory,'provenance.jsonl')
    _verify_sample_provenance(run_directory,model_identity=identity['model_identity'])
    verified = verify_graph(reader,db_path=run_directory/'expected.sqlite3',contract=contract,batch_size=32)
    counts = {'nodes':verified['nodes']['total'],'edges':verified['edges']['total'],
              'vectors':verified['vectors']['nonempty']}
    if (verified != stages['verify'] or verified['fingerprint'] != stages['release']['fingerprint']
            or verified['model_identity'] != identity['model_identity']
            or counts['nodes']<1 or counts['vectors']<1
            or not production and (counts['nodes']>32 or counts['edges']>22 or counts['vectors']>42)):
        _invalid()
    binding = dict(release_id=release_id,schema_contract=schema_identity.__dict__,
        source_snapshot_id=source_snapshot_id,graph_fingerprint=verified['fingerprint'],
        database_id=metadata['databaseID'],server_id=metadata['serverID'],database=reader.database,
        namespace=contract['namespace'])
    relations = []
    for batch in reader.iter_edges(contract['namespace'],32):
        for edge in batch:
            ends = [[next(label for label in edge[side]['labels'] if label.startswith(contract['namespace']+'.')),
                     edge[side]['properties']['id']] for side in ('from','to')]
            relations.append({'from':ends[0],'predicate':edge['predicate'],'to':ends[1],
                'properties':decode_properties(edge['properties'],contract['relation_properties'][edge['predicate']])})
    records = []
    for batch in reader.iter_nodes(contract['namespace'],32):
        for node in batch:
            entity_type = next(label for label in node['labels'] if label.startswith(contract['namespace']+'.'))
            kind = entity_type.rsplit('.',1)[1]
            rows = contract['node_properties'][kind]
            properties = decode_properties(node['properties'],rows)
            key = [entity_type,properties['id']]
            for field,_ in TARGETS[kind]:
                logical = next(row['logical_name'] for row in rows if row['schema_name']==field)
                text = properties.get(logical)
                if text:
                    records.append(dict(entity_type=entity_type,entity_id=properties['id'],
                        doc_id=properties['id'] if kind=='LegalDocument' else properties['doc_id'],
                        unit_id=properties['id'] if kind=='LegalUnit' else properties.get('unit_id'),
                        sign_id=properties['id'] if kind=='TrafficSign' else None,
                        field=logical,physical_field=field,source_text=text,source_sha256=_sha(text.encode()),
                        metadata=properties,graph_context=[r for r in relations if key in (r['from'],r['to'])]))
    catalog = dict(schema='h1-source-catalog-1.0',**binding,records=records)
    partial='selection' in identity.get('input_hashes',{})
    descriptor_kind=dict(binding,release_kind=release_kind,partial=partial)
    source_records = _catalog(catalog,descriptor_kind,contract)
    issues=[]
    if production and publication is not None:
        publication,issues=bind_publication(publication,binding,source_records)
    webapp_id = publication.get('snapshot_id') if type(publication) is dict else None
    _publication(publication,dict(descriptor_kind,webapp_snapshot_id=webapp_id),source_records)
    if len(records) != counts['vectors']:
        _invalid()
    proposal = dict(status='AWAITING_OPERATOR_APPROVAL',**binding,project_id=str(identity['project_id']),
        counts=counts,model_identity=verified['model_identity'],release_root=str(root),
        operational_proof='REQUIRED_SEPARATELY')
    if production:
        proposal.update(dimension=verified['vectors']['dimension'],run_id=identity['run_id'],partial=partial,
                        chat_blockers=[] if dataset and source_records else issues if publication is not None else ['SOURCE_MISSING'])
    if dataset:proposal['source_mode']=source_mode
    if publication is not None:
        proposal['webapp_snapshot_id'] = webapp_id
    # A preview cannot turn measured evidence into operator publication authority.
    if approve is not True:
        return proposal
    with tempfile.TemporaryDirectory(prefix='.release-',dir=root.parent) as temporary:
        staging = Path(temporary)/'release'; staging.mkdir()
        def write(name, value):
            atomic_json(staging/name,value)
            return _sha(_read(staging,name))
        (staging/'expected.sqlite3').write_bytes(expected)
        (staging/'provenance.jsonl').write_bytes(provenance)
        catalog_hash = write('source-catalog.json',catalog)
        backend_hash = write('backend-receipt.json',dict(schema='h1-backend-receipt-1.0',**binding,
            reader_endpoint=reader.endpoint,project_id=str(identity['project_id']),identity_attested=True))
        graph_hash = write('graph-receipt.json',dict(schema='h1-graph-receipt-1.0',**binding,
            graph_verified=True,source_catalog_sha256=catalog_hash))
        authority_hash = write('serving-authority.json',dict(schema='h1-serving-authority-1.0',**binding,
            reader_endpoint=reader.endpoint,project_id=str(identity['project_id']),graph_frozen=not production,
            schema_frozen=not production,read_only=not production,catalog_complete=True,source_catalog_sha256=catalog_hash,
            backend_receipt_sha256=backend_hash))
        publication_hash = write('webapp-publication.json',publication) if publication is not None else None
        extra=dict(model_identity=verified['model_identity'],dimension=verified['vectors']['dimension'],
            run_id=identity['run_id'],partial=partial,expected_graph_sha256=_sha(expected),provenance_sha256=_sha(provenance)) if production else {}
        if dataset:extra['source_mode']=source_mode
        write('release.json',dict(schema='h1-release-1.1' if dataset else 'h1-release-1.0',**binding,release_kind=release_kind,**extra,
            source_catalog_sha256=catalog_hash,backend_receipt_sha256=backend_hash,graph_receipt_sha256=graph_hash,
            serving_authority_receipt_sha256=authority_hash,webapp_publication_sha256=publication_hash,
            webapp_snapshot_id=webapp_id,serving_mode='guarded_worker' if production else 'sealed_read_only',
            sealed_at=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')))
        release = load_release(staging,release_id)
        _backend(reader,release)
        if production:
            if verify_graph(reader,db_path=staging/'expected.sqlite3',contract=contract,batch_size=32)!=verified: _invalid()
        else: _verify_sample_graph(release,dict(counts=counts),reader)
        _readback(reader,release.records,contract)
        if (not production and reader.readonly_state()!=readonly) or reader.database_metadata()!=metadata:
            _invalid()
        staging.rename(root)
    return dict(proposal,status='PUBLISHED')


publish_sample=publish_run


def _unchanged(release):
    if any(_read(release.root,name) != raw for name,raw in release.artifacts):
        _invalid()
    raw,identity=release_contract(release.schema_contract.namespace,production=release.descriptor['release_kind']=='PRODUCTION')
    if raw != release.contract_bytes or identity!=release.schema_contract:
        _invalid()


def _backend(reader, release):
    try:
        metadata = reader.database_metadata()
        indexes = reader.indexes()
    except Exception:
        raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
    descriptor = release.descriptor
    expected = {'name':descriptor['database'],'databaseID':descriptor['database_id'],
                'serverID':descriptor['server_id'],'currentStatus':'online'}
    if (metadata != expected or getattr(reader,'database',None) != descriptor['database']
            or getattr(reader,'endpoint',None) != release.backend['reader_endpoint']):
        _invalid('SOURCE_VALIDATION_FAILED')
    if type(indexes) is not list:
        _invalid('SOURCE_VALIDATION_FAILED')
    for kind, targets in TARGETS.items():
        for _, field in targets:
            found = [i for i in indexes if i.get('type') == 'VECTOR'
                and i.get('labelsOrTypes') == [descriptor['namespace']+'.'+kind]
                and i.get('properties') == [field]]
            if len(found) != 1:
                _invalid('SOURCE_VALIDATION_FAILED')
            config = found[0].get('options',{}).get('indexConfig',{})
            if (found[0].get('state') != 'ONLINE' or type(config.get('vector.dimensions')) is not int
                    or config['vector.dimensions'] != descriptor.get('dimension',3072)
                    or not isinstance(config.get('vector.similarity_function'), str)
                    or config['vector.similarity_function'].lower() != 'cosine'):
                _invalid('SOURCE_VALIDATION_FAILED')


def _readback(reader, records, contract):
    selected = {(r.entity_type,r.entity_id):r for r in records}
    keys = sorted(selected)
    try:
        nodes = [node for start in range(0,len(keys),32)
                 for node in reader.read_nodes([list(k) for k in keys[start:start+32]])]
    except Exception:
        raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
    seen = set()
    for node in nodes:
        kinds = [k for k in TARGETS if contract['namespace']+'.'+k in node['labels']]
        if len(kinds) != 1:
            _invalid('SOURCE_VALIDATION_FAILED')
        kind = kinds[0]
        props = node['properties']
        if (set(node['labels']) - {contract['namespace']+'.'+kind,'Entity'}
                or set(props) - {r['schema_name'] for r in contract['node_properties'][kind]}
                - {field for _,field in TARGETS[kind]}):
            _invalid('SOURCE_VALIDATION_FAILED')
        decoded = decode_properties(props,contract['node_properties'][kind])
        key = contract['namespace']+'.'+kind,decoded['id']
        if key in seen or key not in selected or _freeze(decoded) != selected[key].metadata:
            _invalid('SOURCE_VALIDATION_FAILED')
        seen.add(key)
        for record in records:
            if (record.entity_type,record.entity_id) == key and props.get(record.physical_field) != record.source_text:
                _invalid('SOURCE_VALIDATION_FAILED')
    if seen != set(keys):
        _invalid('SOURCE_VALIDATION_FAILED')
    relations = {}
    for record in records:
        for relation in record.graph_context:
            key = (*relation['from'],relation['predicate'],*relation['to'])
            if key in relations and relations[key] != relation:
                _invalid('SOURCE_VALIDATION_FAILED')
            relations[key] = relation
    try:
        keys=sorted(relations)
        edges = [edge for start in range(0,len(keys),32)
                 for edge in reader.read_edges([list(k) for k in keys[start:start+32]])]
    except Exception:
        raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
    seen = set()
    for edge in edges:
        endpoints = []
        for side in ('from','to'):
            labels = [l for l in edge[side]['labels'] if l in
                {contract['namespace']+'.'+k for k in TARGETS}]
            props = edge[side]['properties']
            if (len(labels) != 1 or set(edge[side]['labels']) - {labels[0],'Entity'}
                    or props.get('name') != props.get('id')
                    or any(props.get(flag) not in (None,False,'false') for flag in
                           ('stub','degraded','_stub','_degraded','isStub','isDegraded'))):
                _invalid('SOURCE_VALIDATION_FAILED')
            endpoints.extend((labels[0],props['id']))
        key = (*endpoints[:2],edge['predicate'],*endpoints[2:])
        if key not in relations or key in seen:
            _invalid('SOURCE_VALIDATION_FAILED')
        rows = contract['relation_properties'][edge['predicate']]
        if set(edge['properties']) - {r['schema_name'] for r in rows}:
            _invalid('SOURCE_VALIDATION_FAILED')
        properties = decode_properties(edge['properties'],rows)
        if _freeze(properties) != relations[key]['properties']:
            _invalid('SOURCE_VALIDATION_FAILED')
        seen.add(key)
    if seen != set(relations):
        _invalid('SOURCE_VALIDATION_FAILED')


def verify_native_sources(result: AnswerResult, release: ServingRelease, reader,
                          as_of: date, webapp_snapshot_id: str | None, *, question=None) -> VerifiedSources:
    """Verify all actual citation types; never repair or classify native roles."""
    from kag.legal_solver import AnswerResult, Citation, _META, _current, document_content_question, DOCUMENT_CONTENT_ANSWER

    if (type(result) is not AnswerResult or type(result.abstained) is not bool
            or not _text(result.answer) or not result.answer.strip()
            or type(result.citations) is not tuple or any(type(c) is not Citation for c in result.citations)
            or result.abstained == bool(result.citations)):
        _invalid('INVALID_NATIVE_RESULT')
    try:
        if type(release) is not ServingRelease or type(as_of) is not date:
            _invalid()
        if release.release_kind!=release.descriptor['release_kind']:_invalid('SOURCE_VALIDATION_FAILED')
        if reader is None:
            raise ArtifactFailure(VerificationState.UNAVAILABLE)
        _unchanged(release)
        publication = release.publication
        if publication is not None:
            if publication['snapshot_id'] != webapp_snapshot_id or not publication_covers(publication,as_of):
                _invalid()
        elif webapp_snapshot_id is not None:
            _invalid()
        _backend(reader,release)
        contract = _json(release.contract_bytes)
        lookup = {r.evidence_id:r for r in release.records}
        documents = {r.entity_id:r for r in release.records if r.entity_type.endswith('.LegalDocument')}
        content_question=document_content_question(question)
        if content_question and not result.abstained and (result.answer!=DOCUMENT_CONTENT_ANSWER+
                '\n\n'.join(c.quote for c in result.citations)):_invalid('SOURCE_VALIDATION_FAILED')
        resolved = []
        for citation in result.citations:
            record = lookup.get(citation.evidence_id)
            if (record is None or citation.doc_id != record.doc_id or citation.unit_id != record.unit_id
                    or citation.sign_id != record.sign_id or citation.field != record.field
                    or type(citation.start) is not int or type(citation.end) is not int
                    or citation.start != 0 or citation.end != len(record.source_text)
                    or not _text(citation.quote) or citation.quote != record.source_text):
                _invalid('SOURCE_VALIDATION_FAILED')
            kind = record.entity_type.rsplit('.',1)[1]
            allowed = {p for p,_ in TARGETS[kind]} | {row['logical_name'] for row in contract['node_properties'][kind]
                if row['schema_name'] in dict(TARGETS[kind])} | (_META[kind] if kind == 'LegalDocument' else set())
            if record.field not in allowed:
                _invalid('SOURCE_VALIDATION_FAILED')
            item = {'doc_id':record.doc_id,'sign_id':record.sign_id,'metadata':record.metadata}
            if content_question:
                from kag.legal_prompts import material_constraints
                requested=material_constraints(content_question)['documents']
                actual=material_constraints(documents[record.doc_id].metadata.get('so_hieu') or '')['documents']
                if not requested<=actual:_invalid('SOURCE_VALIDATION_FAILED')
            elif not _current(item,{key:r.metadata for key,r in documents.items()},as_of):
                _invalid('SOURCE_VALIDATION_FAILED')
            resolved.append(record)
        read_records = list(resolved)
        for record in resolved:
            read_records.append(documents[record.doc_id])
        _readback(reader,read_records,contract)
        verified = []
        for citation, record in zip(result.citations,resolved):
            eligible = False
            if publication is not None and record.entity_type.endswith('.LegalUnit') and record.field == 'text':
                doc = next((d for d in publication['documents'] if d['doc_id'] == record.doc_id),None)
                unit = next((u for u in publication['units'] if u['unit_id'] == record.entity_id),None)
                eligible = bool(doc and unit and doc['published'] and doc['current_effective']
                    and doc['replaces_eligible'] and unit['published'])
            verified.append(VerifiedSource(citation,record.entity_type,record.entity_id,record.source_text,
                eligible,record.source_sha256,record.physical_field,
                record.metadata if dataset_sources(release) else None,
                documents[record.doc_id].metadata if dataset_sources(release) else None))
        _backend(reader,release)
        _unchanged(release)
        return VerifiedSources(tuple(verified),release.release_id,release.descriptor['source_snapshot_id'],
            release.schema_contract,release.descriptor_sha256,as_of,webapp_snapshot_id,
            VerificationState.VERIFIED if publication is not None or dataset_sources(release) else VerificationState.UNVERIFIED,
            source_mode='dataset-snapshot-v1' if dataset_sources(release) else 'webapp-publication-v1')
    except ArtifactFailure:
        raise
    except OSError:
        raise ArtifactFailure(VerificationState.UNAVAILABLE) from None
    except (ValueError,TypeError,KeyError,AttributeError,RecursionError):
        raise ArtifactFailure(VerificationState.INVALID,'SOURCE_VALIDATION_FAILED') from None


def release_view(release: ServingRelease) -> dict:
    """Artifact integrity view only. Step4/5 own all actual runtime gates."""
    value = {'contract_version':'h1-read-v1.0','release_id':release.release_id,
        'release_kind':release.release_kind,'schema_contract':dict(release.schema_contract.__dict__),
        'source_snapshot_id':release.descriptor['source_snapshot_id'],
        'source_catalog_sha256':release.descriptor['source_catalog_sha256'],
        'release_descriptor_sha256':release.descriptor_sha256,
        'graph_fingerprint':release.descriptor['graph_fingerprint'],
        'backend_identity_verified':False,'source_identity_verified':False,'verified_at':None,
        'query_ready':False,'production_write':'blocked'}
    if release.release_kind=='PRODUCTION':
        value.update(contract_version='h1-read-v1.1',webapp_snapshot_id=release.descriptor['webapp_snapshot_id'])
        if dataset_sources(release):value.update(contract_version='h1-read-v1.2',source_mode='dataset-snapshot-v1')
    return value


def verify_production_backend(release,reader):
    from kag.verify import verify_graph
    from .community import WorkerRetrievalClient
    if release.release_kind!='PRODUCTION':_invalid()
    _unchanged(release)
    if isinstance(reader,WorkerRetrievalClient):
        # Keep exact graph scans beside the database, without relaying every vector through the API.
        rows=reader._query('verify_graph')
        if len(rows)!=1 or type(rows[0]) is not dict:_invalid()
        result=rows[0]
    else:
        _backend(reader,release)
        result=verify_graph(reader,db_path=release.root/'expected.sqlite3',
            contract=_json(release.contract_bytes),batch_size=32)
        _backend(reader,release)
    if result['fingerprint']!=release.descriptor['graph_fingerprint']:_invalid()
    _unchanged(release)


def load_sample_proof(release, expected_sha256, reader_username):
    """Operator pin permits only bounded SAMPLE vector reads; receipts alone never suffice."""
    try:
        if (type(release) is not ServingRelease or release.release_kind != 'SAMPLE'
                or release.descriptor['release_kind'] != 'SAMPLE'
                or type(expected_sha256) is not str or not re.fullmatch('[0-9a-f]{64}',expected_sha256)):
            _invalid()
        _unchanged(release)
        raw = _read(release.root,'sample-serving.json')
        if _sha(raw) != expected_sha256:
            _invalid()
        proof = _json(raw)
        from . import community
        if proof.get('schema') == community.SCHEMA:
            if reader_username is not None:
                _invalid()
            return community.load_proof(release,proof)
        _keys(proof, ('schema',*_BINDING,'release_descriptor_sha256','expected_graph_sha256',
                     'provenance_sha256','reader_username','reader_privileges_verified','counts'))
        _binding(proof,release.descriptor)
        if (proof['schema'] != 'h1-sample-serving-1.0'
                or proof['release_descriptor_sha256'] != release.descriptor_sha256
                or proof['reader_username'] != reader_username or proof['reader_privileges_verified'] is not True):
            _invalid()
        _identity(reader_username)
        _keys(proof['counts'],('nodes','edges','vectors'))
        for name,minimum,maximum in (('nodes',1,32),('edges',0,22),('vectors',1,42)):
            value = proof['counts'][name]
            if type(value) is not int or not minimum <= value <= maximum:
                _invalid()
        for filename,key in (('expected.sqlite3','expected_graph_sha256'),('provenance.jsonl','provenance_sha256')):
            if _sha(_read(release.root,filename)) != proof[key]:
                _invalid()
        if any((release.root/('expected.sqlite3'+suffix)).exists() for suffix in ('-wal','-shm','-journal')):
            _invalid()
        return _freeze(proof)
    except (OSError,ValueError,TypeError,KeyError,AttributeError,UnicodeError):
        raise ArtifactFailure(VerificationState.UNVERIFIED) from None


def verify_sample_backend(release, expected_sha256, reader_username, reader):
    """Verify actual RBAC and complete vector/graph fingerprint on every operation."""
    try:
        from kag.verify import verify_graph
        proof = load_sample_proof(release,expected_sha256,reader_username)
        from . import community
        if proof['schema'] == community.SCHEMA:
            community.verify_backend(release,proof,reader)
            load_sample_proof(release,expected_sha256,reader_username)
            return proof
        _backend(reader,release)
        principal, privileges = reader.reader_security()
        roles = principal.get('roles')
        if (principal.get('user') != reader_username or type(roles) is not list or 'reader' not in roles
                or set(roles)-{'reader','PUBLIC'} or principal.get('passwordChangeRequired') is not False
                or principal.get('suspended') is not False or type(privileges) is not list or not privileges):
            _invalid()
        # Unknown or boosted privileges fail closed; Community has no verifiable reader roles.
        allowed = {'access','match','read','traverse','show_index','execute','execute_function','execute_procedure'}
        grants = set()
        for row in privileges:
            if row.get('access') not in ('GRANTED','DENIED') or type(row.get('action')) is not str:
                _invalid()
            if row['access'] == 'GRANTED':
                if row['action'] not in allowed:
                    _invalid()
                grants.add(row['action'])
        if 'access' not in grants or not ('match' in grants or {'read','traverse'} <= grants):
            _invalid()
        _verify_sample_graph(release,proof,reader)
        _readback(reader,release.records,_json(release.contract_bytes))
        _backend(reader,release)
        load_sample_proof(release,expected_sha256,reader_username)
        return proof
    except Exception:
        raise ArtifactFailure(VerificationState.UNVERIFIED) from None


def _verify_sample_provenance(root, *, model_identity=None):
    db_path = root/'expected.sqlite3'
    with closing(sqlite3.connect(db_path.as_uri()+'?mode=ro',uri=True)) as db:
        jobs = dict(db.execute('SELECT key,provenance_hash FROM expected_jobs'))
    seen = set()
    for line in _read(root,'provenance.jsonl').splitlines():
        job = _json(line)
        key = canonical_json([job['node_type'],job['node_id'],job['property']])
        if (key in seen or jobs.get(key) != _sha(canonical_json(job).encode())
                or model_identity is not None and job.get('model_identity') != model_identity):
            _invalid()
        seen.add(key)
    if seen != set(jobs):
        _invalid()


def _verify_sample_graph(release,proof,reader):
    from kag.verify import verify_graph
    _verify_sample_provenance(release.root)
    db_path = release.root/'expected.sqlite3'
    result = verify_graph(reader,db_path=db_path,contract=_json(release.contract_bytes),batch_size=32)
    if (result['fingerprint'] != release.descriptor['graph_fingerprint']
            or dict(proof['counts']) != {'nodes':result['nodes']['total'],'edges':result['edges']['total'],
                                        'vectors':result['vectors']['nonempty']}):
        _invalid()


def sample_source_vector(release, reader, evidence_id):
    """Use the sealed node's exact content vector, with source/provenance and payload guards."""
    record = next((r for r in release.records if r.evidence_id == evidence_id),None)
    if record is None:
        raise ApiFailure('INVALID_REQUEST')
    kind = record.entity_type.rsplit('.',1)[1]
    field = dict(TARGETS[kind]).get(record.physical_field)
    if field is None:
        raise ApiFailure('INVALID_REQUEST')
    try:
        from kag.verify import _node
        nodes = reader.read_nodes([[record.entity_type,record.entity_id]])
        if len(nodes) != 1:
            _invalid()
        key,payload,_ = _node(nodes[0],_json(release.contract_bytes))
        with closing(sqlite3.connect((release.root/'expected.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
            expected = db.execute('SELECT payload_hash FROM expected_nodes WHERE key=?',(key,)).fetchone()
            job = db.execute('SELECT source_sha256,status FROM expected_jobs WHERE key=?',
                (canonical_json([record.entity_type,record.entity_id,record.physical_field]),)).fetchone()
        if (key != canonical_json([record.entity_type,record.entity_id]) or expected != (payload,)
                or job != (record.source_sha256,'SUCCESS')):
            _invalid()
        return nodes[0]['properties'][field]
    except Exception:
        raise ArtifactFailure(VerificationState.UNVERIFIED) from None


def main():
    """Operator CLI; existing broker credential files never enter release artifacts."""
    import argparse
    from .read_broker import BrokerNeo4jClient, _secret_file
    parser = argparse.ArgumentParser(description='Preview or publish a verified, read-only SAMPLE release')
    parser.add_argument('--run-directory',required=True,type=Path)
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--release-id',required=True)
    parser.add_argument('--source-snapshot-id',required=True)
    parser.add_argument('--webapp-publication',type=Path,
        help='Existing, approved WebApp publication snapshot; source identity must match this graph')
    parser.add_argument('--approve-sample',action='store_true',
        help='Operator approves publication of this exact SAMPLE; does not activate serving')
    args = parser.parse_args()
    publication = (_json(_read(args.webapp_publication.parent,args.webapp_publication.name))
                   if args.webapp_publication is not None else None)
    reader = BrokerNeo4jClient('http://openspg-neo4j:7474','vietroadtraffic',
        username=os.environ.get('KAG_BROKER_USERNAME','neo4j'),
        password=_secret_file('KAG_BROKER_PASSWORD_FILE'),timeout=5,namespace='VietRoadTraffic')
    try:
        result = publish_sample(args.root,args.run_directory,reader,release_id=args.release_id,
            source_snapshot_id=args.source_snapshot_id,approve=args.approve_sample,publication=publication)
        print(canonical_json(result))
    finally:
        reader._opener._opener.close()


if __name__ == '__main__':
    main()
