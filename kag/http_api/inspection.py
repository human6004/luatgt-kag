"""Read-only process/dataset inspection. No graph client, execution or provider access."""
from itertools import islice
from collections import Counter
from pathlib import Path
import re
import json
from urllib.parse import urlsplit

from kag.evaluation.dataset import load_dataset
from kag.evaluation.models import ValidationError

LIMIT_BYTES = 8 * 1024 * 1024


def configuration_view(environment, provider_keys, secrets=()):
    """Project only public startup metadata; never retain credentials or URL paths."""
    def text(value, pattern):
        return value if (isinstance(value, str) and re.fullmatch(pattern, value)
                         and not any(secret and secret in value for secret in secrets)) else None

    models = {'source': 'startup_environment', 'identity_verified': False}
    for role in ('chat', 'embedding'):
        prefix = 'KAG_HTTP_' + role.upper()
        raw_model, raw_url = environment.get(prefix + '_MODEL'), environment.get(prefix + '_URL')
        model = text(raw_model, r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}')
        endpoint, valid_url = None, False
        if raw_url:
            try:
                url = urlsplit(raw_url)
                if (len(raw_url) <= 2048 and not re.search(r'\s', raw_url)
                        and url.scheme in ('http', 'https') and url.hostname):
                    host = '[' + url.hostname + ']' if ':' in url.hostname else url.hostname
                    origin = url.scheme + '://' + host + (':' + str(url.port) if url.port is not None else '')
                    endpoint = text(origin, r'https?://[A-Za-z0-9.\[\]:-]{1,260}')
                    valid_url = (endpoint is not None and url.port != 0
                                 and not (url.username or url.password or url.query or url.fragment))
            except (ValueError, TypeError):
                pass
        key_present = bool(provider_keys.get(role))
        state = ('INVALID' if raw_model and model is None or raw_url and not valid_url else
                 'CONFIGURED' if model and valid_url and key_present else
                 'INCOMPLETE' if raw_model or raw_url or key_present else 'NOT_CONFIGURED')
        models[role] = {'state': state, 'model': model, 'endpoint': endpoint}
    release_id = text(environment.get('KAG_HTTP_RELEASE_ID'), r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}')
    return {'contract_version': 'kag-config-v1',
            'project': {'source': 'startup_environment', 'release_id': release_id,
                        'release_state': 'UNAVAILABLE' if environment.get('KAG_HTTP_RELEASE_ID') else 'NOT_CONFIGURED'},
            'models': models}


def solver_defaults():
    """Inspect the shipped constructors, without creating a solver or model."""
    from inspect import signature
    from kag.legal_solver import LegalRetrieverExecutor, KAGIterativePipeline, KAGIterativePlanner
    from kag.retriever.retriever import Retriever
    executor = signature(LegalRetrieverExecutor).parameters
    retriever = signature(Retriever).parameters
    return {'source': 'source_defaults', 'pipeline': KAGIterativePipeline.__name__,
            'planner': KAGIterativePlanner.__name__,
            'top_k': executor['top_k'].default, 'expand': executor['expand'].default,
            'max_evidence_chars': executor['max_evidence_chars'].default,
            'max_iteration': signature(KAGIterativePipeline).parameters['max_iteration'].default,
            'search_k': retriever['search_k'].default, 'expansion_limit': retriever['expansion_limit'].default,
            # HTTP embeddings and Retriever both enforce this dimension, not a provider measurement.
            'required_vector_dimensions': 3072}


def validate_config(value):
    from .contract import ApiFailure
    def shape(item, fields):
        return type(item) is dict and set(item) == set(fields.split())
    def optional_text(item, pattern):
        return item is None or type(item) is str and re.fullmatch(pattern, item) is not None
    if (not shape(value, 'contract_version project models solver') or value['contract_version'] != 'kag-config-v1'
            or not shape(value['project'], 'source release_id release_state')
            or value['project']['source'] != 'startup_environment'
            or value['project']['release_state'] not in ('NOT_CONFIGURED', 'LOADED', 'UNAVAILABLE')
            or not optional_text(value['project']['release_id'], r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}')
            or value['project']['release_state'] == 'LOADED' and value['project']['release_id'] is None
            or not shape(value['models'], 'source identity_verified chat embedding')
            or value['models']['source'] != 'startup_environment' or value['models']['identity_verified'] is not False):
        raise ApiFailure('INVALID_NATIVE_RESULT')
    for role in ('chat', 'embedding'):
        model = value['models'][role]
        if (not shape(model, 'state model endpoint')
                or model['state'] not in ('CONFIGURED', 'NOT_CONFIGURED', 'INCOMPLETE', 'INVALID')
                or not optional_text(model['model'], r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}')
                or not optional_text(model['endpoint'], r'https?://[A-Za-z0-9.\[\]:-]{1,260}')
                or model['state'] == 'CONFIGURED' and None in (model['model'], model['endpoint'])
                or model['state'] == 'NOT_CONFIGURED' and (model['model'] is not None or model['endpoint'] is not None)):
            raise ApiFailure('INVALID_NATIVE_RESULT')
    solver = value['solver']
    if solver is not None and (not shape(solver, 'source pipeline planner top_k expand max_evidence_chars max_iteration search_k expansion_limit required_vector_dimensions')
            or solver['source'] != 'source_defaults' or solver['pipeline'] != 'KAGIterativePipeline'
            or solver['planner'] != 'KAGIterativePlanner' or type(solver['expand']) is not bool
            or any(type(solver[key]) is not int or not 1 <= solver[key] <= 1000000 for key in
                   ('top_k', 'max_evidence_chars', 'max_iteration', 'search_k', 'expansion_limit', 'required_vector_dimensions'))
            or solver['top_k'] > solver['search_k']):
        raise ApiFailure('INVALID_NATIVE_RESULT')
    return value


def pipeline_view(supervisor):
    busy = supervisor.busy if supervisor is not None else None
    closed = supervisor.closed if supervisor is not None else None
    draining = supervisor.draining if supervisor is not None else None
    phase = ('unavailable' if supervisor is None else 'closed' if closed
             else 'draining' if draining else 'running' if busy else 'idle')
    return {'contract_version': 'h1-inspect-v1.0', 'phase': phase,
            'active_requests': int(busy) if busy is not None else None,
            'draining': draining, 'closed': closed,
            # The upstream pipeline has no verified stage/percentage reporter.
            'progress': None, 'execution_allowed': False,
            'operational_proof': 'DENY', 'production_write': 'BLOCKED', 'provider_egress': 'DENY'}


def _files(root):
    candidates = []
    entries = list(islice(root.iterdir(), 513))
    if len(entries) > 512:
        raise OverflowError
    for entry in sorted(entries):
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', entry.name) or entry.is_symlink():
            continue
        if entry.is_file() and entry.suffix == '.jsonl':
            candidates.append(entry)
        elif entry.is_dir():
            path = entry/'eval_questions.jsonl'
            if path.is_file() and not path.is_symlink():
                candidates.append(path)
        if len(candidates) > 20:
            raise OverflowError
    return candidates


def _dataset(path, root):
    row = {'id': path.relative_to(root).as_posix(), 'dataset_status': None,
           'dataset_eligibility': 'BLOCKED', 'reason': 'INVALID_DATASET',
           'dataset_hash': None, 'record_count': None, 'official_benchmark': False}
    try:
        if path.stat().st_size > LIMIT_BYTES:
            row['reason'] = 'DATASET_TOO_LARGE'
            return row
        manifest = path.with_name('eval_questions.manifest.json')
        if manifest.exists() and (manifest.is_symlink() or not manifest.is_file()
                                  or manifest.stat().st_size > LIMIT_BYTES):
            return row
        dataset = load_dataset(path)
        status = dataset.records[0].dataset_status
        # Only the existing framework can establish canonical FROZEN integrity.
        official = dataset.official_benchmark
        gold = any(record.gold_doc_ids or record.gold_unit_ids or record.gold_sign_ids
                   or record.expected_abstain for record in dataset.records)
        eligible = status == 'FROZEN' and gold
        row.update(dataset_status=status, dataset_hash=dataset.dataset_hash,
                   record_count=len(dataset.records), official_benchmark=official,
                   dataset_eligibility='ELIGIBLE' if eligible else 'BLOCKED',
                   reason=None if eligible else 'PROVISIONAL_DATASET' if status == 'PROVISIONAL' else 'NO_GOLD')
    except (OSError, ValueError, ValidationError, KeyError, RecursionError):
        pass
    return row


def dataset_catalog(root=None):
    result = {'contract_version': 'h1-inspect-v1.0', 'state': 'NOT_CONFIGURED',
              'datasets': [], 'execution_allowed': False,
              'execution_blockers': ['OPERATIONAL_PROOF_REQUIRED', 'BENCHMARK_EXECUTION_NOT_AUTHORIZED'],
              'metrics': None}
    if root is None:
        return result
    try:
        root = Path(root)
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            raise OSError
        files = _files(root)
        result.update(state='AVAILABLE', datasets=[_dataset(path, root) for path in files])
    except OverflowError:
        result['state'] = 'LIMIT_EXCEEDED'
    except (OSError, ValueError):
        result['state'] = 'UNAVAILABLE'
    return result


def dataset_readiness(root, release):
    """Gold identity coverage only; neither solver applicability nor execution proof."""
    from kag.evaluation.dataset import strict_json
    result=dataset_catalog(root)
    identities={'document':set(),'unit':set(),'sign':set()}
    for record in release.records:
        channel={'LegalDocument':'document','LegalUnit':'unit','TrafficSign':'sign'}[record.entity_type.rsplit('.',1)[1]]
        identities[channel].add(record.entity_id)
    for row in result['datasets']:
        row.update(eligible_count=0,ineligible_count=0,invalid_count=None,gold_count=None,
                   metadata={'dataset_version':None,'category_counts':{},'generation_method':None},
                   missing_gold={'document':[],'unit':[],'sign':[]},eligibility_scope='G1_RETRIEVAL_GOLD_COVERAGE',
                   smoke={'state':'NOT_RUN','review_status':'NOT_ATTESTED','g1_eligible_count':0,
                          'graph_fingerprint':release.descriptor['graph_fingerprint'],
                          'official_benchmark':row['official_benchmark'],'runs':{'G1':None,'G2':None}})
        path=Path(root)/row['id']
        if row['reason']=='DATASET_TOO_LARGE':continue
        try:
            # Invalid legacy rows remain invalid; raw gold IDs are diagnostic only.
            lines=[line for line in path.read_bytes().splitlines() if line.strip()]
            row['record_count']=len(lines);row['invalid_count']=len(lines)
            values=[]
            for line in lines:
                try:value=strict_json(line.decode('utf-8'))
                except (ValueError,UnicodeError,ValidationError):value={}
                values.append(value if type(value) is dict else {})
            missing={channel:set() for channel in identities};gold_count=0
            for value in values:
                has_gold=False
                for channel,field in (('document','gold_doc_ids'),('unit','gold_unit_ids'),('sign','gold_sign_ids')):
                    ids=value.get(field,[])
                    if type(ids) is list:
                        ids=[v for v in ids if type(v) is str and 0<len(v)<=512]
                        has_gold|=bool(ids);missing[channel].update(set(ids)-identities[channel])
                gold_count+=has_gold
            row.update(gold_count=gold_count,missing_gold={k:sorted(v) for k,v in missing.items()})
            dataset=load_dataset(path)
            row['invalid_count']=0
            row['metadata'].update(dataset_version=dataset.records[0].dataset_version,
                                   category_counts=dict(Counter(r.category for r in dataset.records)))
            from kag.evaluation.generation import METHOD
            if all('EVIDENCE_FIRST' in r.tags for r in dataset.records):
                row['metadata']['generation_method']=METHOD
            row['smoke']['review_status']=row['dataset_status']
            for record in dataset.records:
                channels=[(record.gold_doc_ids,identities['document']),
                          (record.gold_unit_ids,identities['unit']),(record.gold_sign_ids,identities['sign'])]
                covered=any(gold and not set(gold)-catalog for gold,catalog in channels)
                row['smoke']['g1_eligible_count']+=int(covered)
                if row['dataset_status']=='FROZEN' and covered:row['eligible_count']+=1
                else:row['ineligible_count']+=1
            if row['dataset_status']=='FROZEN' and not row['eligible_count']:
                row.update(dataset_eligibility='BLOCKED',reason='NO_ELIGIBLE_QUESTIONS')
            _smoke_results(path,dataset,release,row['smoke'])
        except (OSError,ValueError,ValidationError,KeyError,RecursionError):pass
    return result


def _smoke_results(path,dataset,release,view):
    """Inspect operator-pinned framework outputs; never authorize execution/review."""
    from kag.evaluation.dataset import strict_json,sha256
    from kag.evaluation.report import summarize
    from kag.evaluation.models import EvaluationRun,QuestionResult,MetricValue
    from kag.evaluation.models import EvaluationProtocol
    from types import SimpleNamespace
    receipt=path.parent/'sample-smoke.json'
    if not receipt.exists():return
    def read(file):
        if file.is_symlink() or not file.is_file() or file.stat().st_size>LIMIT_BYTES:raise ValueError
        raw=file.read_bytes()
        return raw,strict_json(raw.decode('utf-8'))
    try:
        _,pin=read(receipt)
        if (type(pin) is not dict or type(pin.get('runs')) is not dict
            or path.name!='eval_questions.jsonl'
            or set(pin)!={'schema_version','dataset_hash','graph_fingerprint','source_catalog_sha256','review_status','runs'}
            or pin['schema_version']!='1.0' or pin['review_status']!=dataset.records[0].dataset_status or pin['dataset_hash']!=dataset.dataset_hash
            or pin['graph_fingerprint']!=release.descriptor['graph_fingerprint']
            or pin['source_catalog_sha256']!=release.descriptor['source_catalog_sha256'] or set(pin['runs'])!={'G1','G2'}):raise ValueError
        runs={}
        for mode,expected in pin['runs'].items():
            runs[mode]=None
            if expected is None:continue
            folder=path.parent/mode
            if folder.is_symlink():raise ValueError
            raw,manifest=read(folder/'run_manifest.json')
            if (sha256(raw)!=expected or manifest['status']!='COMPLETE' or manifest['mode']!=mode
                or manifest['dataset_hash']!=dataset.dataset_hash or manifest['dataset_status']!=dataset.records[0].dataset_status
                or manifest['release_id']!=release.release_id or manifest['official_benchmark'] is not dataset.official_benchmark
                or manifest['paper_eligible'] is not False or manifest['requested_count']!=len(dataset.records)
                or set(manifest['file_hashes'])!={'dataset_snapshot.jsonl','protocol.json','results.jsonl','metrics.json','report.md'}):raise ValueError
            blobs={}
            for name,digest in manifest['file_hashes'].items():
                file=folder/name
                if file.is_symlink() or not file.is_file() or file.stat().st_size>LIMIT_BYTES:raise ValueError
                blobs[name]=file.read_bytes()
                if sha256(blobs[name])!=digest:raise ValueError
            if blobs['dataset_snapshot.jsonl']!=dataset.canonical_bytes:raise ValueError
            protocol=EvaluationProtocol.from_dict(strict_json(blobs['protocol.json'].decode('utf-8')))
            if protocol.protocol_hash!=manifest['protocol_hash']:raise ValueError
            metrics=strict_json(blobs['metrics.json'].decode('utf-8'))
            results=[strict_json(line) for line in blobs['results.jsonl'].decode('utf-8').splitlines() if line.strip()]
            if (len(results)!=len(dataset.records) or {r['qid'] for r in results}!={r.qid for r in dataset.records}
                or any(r['dataset_hash']!=dataset.dataset_hash or r['mode']!=mode for r in results)
                or metrics['dataset_hash']!=dataset.dataset_hash or metrics['mode']!=mode):raise ValueError
            rows=[]
            for result in results:
                row=QuestionResult(result['qid'],result['category'],result['source_group'],status=result['status'],
                    eligibility=result['eligibility'],latency_ms=result['latency_ms'],reasons=result['reasons'],
                    metrics={k:MetricValue(**v) for k,v in result['metrics'].items()})
                rows.append(row)
            summary=summarize(EvaluationRun(SimpleNamespace(dataset=dataset,protocol=protocol),tuple(rows)))
            if any(metrics[k]!=v for k,v in summary.items()):raise ValueError
            runs[mode]={'status':manifest['status'],'started_at':manifest['started_at'],'finished_at':manifest['finished_at'],
                        'requested_count':metrics['requested_count'],'attempted_count':metrics['attempted_count'],
                        'failed_count':metrics['failed_count'],'ineligible_count':metrics['ineligible_count'],
                        'metrics':metrics['overall'],'latency_ms':metrics['latency_ms']}
            runs[mode]['configuration']=protocol.to_dict()
        if not any(runs.values()):raise ValueError
        view.update(state='AVAILABLE',runs=runs)
    except (OSError,ValueError,KeyError,TypeError,AttributeError,RecursionError):
        view.update(state='INVALID_RECEIPT',runs={'G1':None,'G2':None})


def sample_graph_view(release, reader, proof):
    """Return only actual bounded reads matching every sealed expected payload."""
    from contextlib import closing
    from dataclasses import asdict
    from datetime import datetime, timezone
    import sqlite3
    from kag.builder.codec import decode_properties
    from kag.verify import _node, _edge
    from . import artifacts as a
    if release.release_kind!='SAMPLE':a._invalid()
    contract=a._json(release.contract_bytes)
    nodes=list(islice((node for batch in reader.iter_nodes(contract['namespace'],32) for node in batch),33))
    edges=list(islice((edge for batch in reader.iter_edges(contract['namespace'],32) for edge in batch),23))
    if len(nodes)!=proof['counts']['nodes'] or len(edges)!=proof['counts']['edges']:a._invalid()
    projected=[];seen=set();relations=[]
    with closing(sqlite3.connect((release.root/'expected.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
        for node in nodes:
            key,payload,_=_node(node,contract)
            if key in seen or db.execute('SELECT payload_hash FROM expected_nodes WHERE key=?',(key,)).fetchone()!=(payload,):a._invalid()
            seen.add(key);kind,identity=json.loads(key)
            props=decode_properties(node['properties'],contract['node_properties'][kind.rsplit('.',1)[1]])
            sources=[{'evidence_id':r.evidence_id,'field':r.field,'source_sha256':r.source_sha256}
                     for r in release.records if (r.entity_type,r.entity_id)==(kind,identity)]
            projected.append({'entity_type':kind,'entity_id':identity,'properties':props,'sources':sources})
        seen_edges=set()
        for edge in edges:
            key,payload=_edge(edge,contract)
            if key in seen_edges or db.execute('SELECT payload_hash FROM expected_edges WHERE key=?',(key,)).fetchone()!=(payload,):a._invalid()
            seen_edges.add(key);fields=json.loads(key)
            if any(json.dumps([fields[i],fields[i+1]],ensure_ascii=False,separators=(',',':')) not in seen for i in (0,3)):a._invalid()
            relations.append({'from':fields[:2],'predicate':fields[2],'to':fields[3:],
                'properties':decode_properties(edge['properties'],contract['relation_properties'][fields[2]])})
    return {'contract_version':'h1-sample-inspection-1.0','release_id':release.release_id,'release_kind':'SAMPLE',
        'source_snapshot_id':release.descriptor['source_snapshot_id'],'source_catalog_sha256':release.descriptor['source_catalog_sha256'],
        'schema_contract':asdict(release.schema_contract),'graph_fingerprint':release.descriptor['graph_fingerprint'],
        'backend':{'database':release.descriptor['database'],'namespace':release.descriptor['namespace'],
            'database_id':release.descriptor['database_id'],'server_id':release.descriptor['server_id'],'read_only':True,'verified':True},
        'counts':dict(proof['counts']),'nodes':projected,'edges':relations,
        'verified_at':datetime.now(timezone.utc).isoformat(),'execution_allowed':False,'production_write':'BLOCKED',
        'sample_receipt':{'stage':'GRAPH_VERIFIED','sealed_at':release.descriptor['sealed_at'],
            'receipt_sha256':release.descriptor['graph_receipt_sha256'],'build_run_id':None,'progress':None}}


def provider_view(settings):
    from .sample_query import provider_budget
    from .provider_budget import receipt_view
    result={'state':'NOT_CONFIGURED','attempts':None,'receipt_window':None,
        'configured_chat_model':settings.chat_model,'configured_embedding_model':settings.embedding_model,
        'policy_response_version':None,'exact_backend_identity_verified':False,
        'upstream_attempts':None,'proxy_retries':None}
    if settings.query_proof_sha256:
        budget=provider_budget(settings)
        result.update(state='OBSERVED',attempts=budget.counts(),receipt_window=receipt_view(budget.binding))
        route=settings.development_policy.get('model_route') if settings.development_policy else None
        if route:result['policy_response_version']=route['response_version']
    return result
