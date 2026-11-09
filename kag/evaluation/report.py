"""Owned run directories and pre-execution snapshots; incomplete writes fail closed."""
from pathlib import Path
import math
import random
import statistics
from .dataset import canonical_line, canonical_protocol_bytes, dataset_from_records, sha256, utc_now
from .models import CATEGORIES, EvaluationProtocol, RunContext, ValidatedDataset, fail


def bootstrap_ci(values, samples=1000, seed=42, confidence=.95):
    """Percentile bootstrap CI of the mean; None when fewer than two values."""
    n = len(values)
    if n < 2:
        return None,None
    rng = random.Random(seed)
    means = sorted(statistics.mean(rng.choices(values,k=n)) for _ in range(samples))
    tail = (1-confidence)/2*(samples-1)
    return means[round(tail)],means[round((1-(1-confidence)/2)*(samples-1))]


def validate_inputs(dataset, protocol):
    if not isinstance(dataset,ValidatedDataset) or not isinstance(protocol,EvaluationProtocol):
        fail('dataset','VALIDATED_INPUT_REQUIRED')
    checked = dataset_from_records([r.to_dict() for r in dataset.records])
    if checked.canonical_bytes != dataset.canonical_bytes or checked.dataset_hash != dataset.dataset_hash:
        fail('dataset','SNAPSHOT_MISMATCH')
    if dataset.records[0].dataset_status == 'FROZEN' and not dataset.manifest_verified:
        fail('manifest','FROZEN_VERIFICATION_REQUIRED')
    if dataset.official_benchmark and (not dataset.manifest_verified or dataset.records[0].dataset_status != 'FROZEN'):
        fail('official_benchmark','VERIFIED_MANIFEST_REQUIRED')
    EvaluationProtocol.from_dict(protocol.to_dict())


def write_new(path, raw):
    with path.open('xb') as stream:
        stream.write(raw)


def start_run(dataset, protocol, mode, output_dir):
    validate_inputs(dataset,protocol)
    if mode not in ('G1','G2'):
        fail('mode')
    output = Path(output_dir)
    output.mkdir(parents=True,exist_ok=False)
    proto = canonical_protocol_bytes(protocol)
    stamp = utc_now()
    first = dataset.records[0]
    manifest = dict(schema_version='1.0',eval_version=protocol.eval_version,status='RUNNING',mode=mode,
                    dataset_version=first.dataset_version,dataset_status=first.dataset_status,
                    dataset_hash=dataset.dataset_hash,source_sha256=dataset.source_sha256,
                    protocol_hash=sha256(proto),requested_count=len(dataset.records),
                    official_benchmark=dataset.official_benchmark,paper_eligible=False,
                    started_at=stamp,snapshot_written_at=stamp,finished_at=None,
                    release_id=protocol.release_id,release_identity_verified=False,
                    judge_fingerprint=sha256(canonical_line(protocol.to_dict()['judge_config'])) if protocol.judge_config else None,
                    file_hashes={'dataset_snapshot.jsonl':dataset.dataset_hash,'protocol.json':sha256(proto)})
    raw = canonical_line(manifest)
    context = RunContext(output,dataset,protocol,mode,manifest,raw)
    write_new(output/'dataset_snapshot.jsonl',dataset.canonical_bytes)
    write_new(output/'protocol.json',proto)
    write_new(output/'run_manifest.json',raw)
    verify_snapshot(context)
    return context


def verify_snapshot(context):
    expected = {'dataset_snapshot.jsonl':context.dataset.canonical_bytes,
                'protocol.json':canonical_protocol_bytes(context.protocol),
                'run_manifest.json':context.manifest_bytes}
    for name,raw in expected.items():
        if (context.output_dir/name).read_bytes() != raw:
            fail(name,'RUN_ARTIFACT_TAMPERED')


def replace_manifest(context, manifest):
    path = context.output_dir/'run_manifest.json'
    if path.read_bytes() != context.manifest_bytes:
        fail('manifest','RUN_OWNERSHIP_MISMATCH')
    raw = canonical_line(manifest)
    temp = context.output_dir/'run_manifest.pending.json'
    write_new(temp,raw)
    temp.replace(path)
    context.manifest,context.manifest_bytes = manifest,raw


def mark_run_error(context, code):
    # Codes are fixed by the orchestration layer, never exception messages.
    if code not in ('STORAGE_ERROR','CANCELLED','RUN_ABORTED','RUN_ARTIFACT_TAMPERED'):
        code = 'RUN_ABORTED'
    replace_manifest(context,dict(context.manifest,status='ERROR',error_code=code,finished_at=utc_now()))


def summarize(run):
    names = sorted({name for row in run.rows for name in row.metrics})
    def aggregate(rows, ci=False):
        result = {}
        for name in names:
            def eligible(row):
                return row.status != 'INELIGIBLE' and name in row.metrics and row.eligibility.get('metric_eligibility',{}).get(name,row.metrics[name].status != 'NOT_APPLICABLE')
            values = [row.metrics[name] for row in rows if name in row.metrics]
            available = [m.value for m in values if m.status == 'OK' and m.value is not None]
            counts = {status:sum(m.status == status for m in values) for status in ('OK','NOT_APPLICABLE','UNAVAILABLE','UNKNOWN')}
            low,high = bootstrap_ci(available) if ci else (None,None)
            result[name] = dict(value=statistics.mean(available) if available else None,scored_count=len(available),
                                status_counts=counts,eligible_count=sum(eligible(row) for row in rows),
                                excluded_count=sum(not eligible(row) for row in rows),
                                failed_count=sum(row.status == 'ERROR' and eligible(row) for row in rows),
                                ci_low=low,ci_high=high)
        return result
    def latency(rows):
        values = sorted(row.latency_ms for row in rows if row.latency_ms is not None)
        return dict(count=len(values),min=min(values) if values else None,mean=statistics.mean(values) if values else None,
                    median=statistics.median(values) if values else None,p95=values[math.ceil(.95*len(values))-1] if values else None,max=max(values) if values else None)
    attempted = [row for row in run.rows if row.status in ('SUCCESS','ERROR')]
    success = [row for row in run.rows if row.status == 'SUCCESS']
    failed = sum(row.status == 'ERROR' for row in run.rows)
    result = dict(requested_count=len(run.context.dataset.records),completed_count=len(run.rows),attempted_count=len(attempted),
                failed_count=failed,ineligible_count=sum(row.status == 'INELIGIBLE' for row in run.rows),
                scored_count=sum(row.status == 'SUCCESS' and any(v.status == 'OK' for v in row.metrics.values()) for row in run.rows),
                failure_rate=dict(value=failed/len(attempted) if attempted else None,numerator=failed,denominator=len(attempted),status='OK' if attempted else 'UNAVAILABLE'),
                overall=aggregate(run.rows,ci=True),by_category={cat:aggregate([row for row in run.rows if row.category == cat]) for cat in CATEGORIES},
                by_source={source:aggregate([row for row in run.rows if (row.source_group or '') == source]) for source in sorted({row.source_group or '' for row in run.rows})},
                latency_ms=dict(successful=latency(success),all_attempted=latency(attempted)))
    if getattr(getattr(run.context,'protocol',None),'metric_policy_version',None) == '1.1':
        result['macro'] = {}
        for name in names:
            category_means = [group[name]['value'] for group in result['by_category'].values() if group[name]['value'] is not None]
            result['macro'][name] = dict(value=statistics.mean(category_means) if category_means else None,
                                        scored_category_count=len(category_means))
        result['execution_outcomes'] = dict(answered=sum('ANSWERED' in row.reasons for row in run.rows),
            abstained=sum('ABSTAINED' in row.reasons for row in run.rows),
            unanswered=sum('UNANSWERED' in row.reasons for row in run.rows),error=failed)
    return result


def write_report(run, output_dir):
    context = run.context
    if Path(output_dir).resolve() != context.output_dir.resolve() or context.manifest['status'] != 'RUNNING' or run.status != 'RUNNING':
        fail('output_dir','RUN_OWNERSHIP_MISMATCH')
    validate_inputs(context.dataset,context.protocol)
    verify_snapshot(context)
    records = {r.qid:r for r in context.dataset.records}
    qids = [row.qid for row in run.rows]
    if len(qids) != len(set(qids)) or set(qids) != set(records):
        fail('rows','EXACT_REQUESTED_COVERAGE_REQUIRED')
    summary = summarize(run)
    common = dict(schema_version='1.0',eval_version=context.protocol.eval_version,protocol_hash=context.protocol.protocol_hash,
                  dataset_hash=context.dataset.dataset_hash,dataset_version=context.dataset.records[0].dataset_version,
                  dataset_status=context.dataset.records[0].dataset_status,official_benchmark=context.dataset.official_benchmark,
                  paper_eligible=False,mode=context.mode,release_id=context.protocol.release_id)
    rows = []
    for row in sorted(run.rows,key=lambda row:row.qid.encode('utf-8')):
        record = records[row.qid]
        rows.append(dict(common,**row.to_dict(),question=record.question,as_of=record.as_of,
                         diagnostic_labels={'marker_coverage':'LEXICAL_ONLY','markers_all':'LEXICAL_ONLY'}))
    metrics = dict(common,**summary,rank_semantics=context.protocol.rank_semantics,top_k=context.protocol.top_k,ks=list(context.protocol.ks))
    body = [f"DATASET_STATUS={common['dataset_status']}",f"OFFICIAL_BENCHMARK={'YES' if common['official_benchmark'] else 'NO'}",'PAPER_ELIGIBLE=NO','',
            f"Mode: {context.mode}; requested: {summary['requested_count']}; attempted: {summary['attempted_count']}; failed: {summary['failed_count']}; scored: {summary['scored_count']}.",
            f"dataset_hash: {common['dataset_hash']}",f"protocol_hash: {common['protocol_hash']}",
            'Rank: channel_projected_returned_top_k; reciprocal rank bounded by returned seeds.',
            'Markers: lexical diagnostic only. Semantic correctness requires configured judge.',
            'Paper eligibility: runtime/release identity not attested by this offline adapter.','']
    for name,item in summary['overall'].items():
        body.append(f"{name}: {item['value']}; scored_count={item['scored_count']}; status_counts={item['status_counts']}")
    if context.protocol.metric_policy_version == '1.1':
        body.extend(['','Metric policy 1.1: source_span metrics use exact public identity and source-text containment; mixed returned-list ranks.',
                     'Macro: mean of available category means. No composite score or automatic quality PASS threshold.',
                     f"Native answer outcomes: {summary['execution_outcomes']}"])
    artifacts = {'results.jsonl':b''.join(canonical_line(row) for row in rows),
                 'metrics.json':canonical_line(metrics),'report.md':('\n'.join(body)+'\n').encode('utf-8')}
    for name in artifacts:
        if (context.output_dir/name).exists():
            raise FileExistsError(name)
    hashes = dict(context.manifest['file_hashes'],**{name:sha256(raw) for name,raw in artifacts.items()})
    try:
        for name,raw in artifacts.items():
            write_new(context.output_dir/name,raw)
        verify_snapshot(context)
        judge_ready = bool(context.protocol.judge_config and context.protocol.judge_config.calibrated and run.rows and
                           all(row.status == 'SUCCESS' and row.metrics.get('answer_correctness') and row.metrics['answer_correctness'].status == 'OK' for row in run.rows))
        manifest = dict(context.manifest,status='COMPLETE',finished_at=utc_now(),file_hashes=hashes,
                        completed_count=summary['completed_count'],attempted_count=summary['attempted_count'],
                        scored_count=summary['scored_count'],failed_count=summary['failed_count'],ineligible_count=summary['ineligible_count'],
                        top_k=context.protocol.top_k,ks=list(context.protocol.ks),rank_semantics=context.protocol.rank_semantics,
                        semantic_paper_ready=False,judge_decisions_calibrated=judge_ready,paper_eligibility_reason='RUNTIME_IDENTITY_NOT_ATTESTED')
        replace_manifest(context,manifest)
    except OSError:
        try:
            mark_run_error(context,'STORAGE_ERROR')
        except OSError:
            pass
        raise
    run.status = 'COMPLETE'
    return hashes
