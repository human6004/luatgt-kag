"""Step 4: aggregate saved evaluation fractions with explicit denominators and coverage."""
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from common import BENCH, dumps, load_csv, now, output_file, finite_number


def percentile(values, p):
    """Return a linearly interpolated quantile, or None when latency is unobserved."""
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * p
    lower, upper = math.floor(position), math.ceil(position)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def aggregate(rows):
    """Pool fraction numerators/denominators; report N/A counts, reasons and latency tails."""
    names = set().union(*(r['metrics'] for r in rows)) if rows else set()
    result = {}
    for name in sorted(names):
        if name == 'latency_ms':
            continue
        values = [r['metrics'][name] for r in rows if name in r['metrics']]
        known = [v for v in values if v['value'] is not None]
        n = sum(v['numerator'] for v in known)
        d = sum(v['denominator'] for v in known)
        result[name] = dict(value=n/d if d else None, numerator=n, denominator=d,
                            eligible_count=len(known), na_count=len(values)-len(known),
                            na_reasons=dict(Counter(v['reason'] for v in values if v['value'] is None)))
    latency = [r['metrics']['latency_ms']['value'] for r in rows
               if r['metrics']['latency_ms']['value'] is not None]
    for name, p in (('latency_p50_ms', .5), ('latency_p95_ms', .95)):
        result[name] = dict(value=percentile(latency, p), sample_count=len(latency),
                            reason='' if latency else 'NO_OBSERVED_LATENCIES')
    return result


def main():
    """Read one evaluation CSV and output a new aggregate JSON without chatbot requests."""
    from common import read_json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evaluation', type=Path, required=True)
    parser.add_argument('--output-dir', default=str(BENCH / 'output'))
    args = parser.parse_args()
    rows = load_csv(args.evaluation)
    if not rows or len({(r['run_id'], r['dataset_id'], r['evaluation_id']) for r in rows}) != 1:
        raise ValueError('Evaluation must contain exactly one run/dataset/evaluation')
    if len({r['qid'] for r in rows}) != len(rows):
        raise ValueError('Duplicate evaluation qid')
    for r in rows:
        for key in ('metrics', 'expression_tags', 'content_tags', 'provenance'):
            r[key] = json.loads(r[key])
        for value in r['metrics'].values():
            if value['value'] is not None and not finite_number(value['value']):
                raise ValueError('Invalid metric value')
    checkpoint = read_json(rows[0]['provenance']['checkpoint'])
    if checkpoint['run_id'] != rows[0]['run_id'] or checkpoint['dataset_id'] != rows[0]['dataset_id']:
        raise ValueError('Evaluation/checkpoint mismatch')
    groups = {}
    for key in ('category', 'case_group', 'reasoning_level', 'expected_behavior', 'conversation_type', 'expression_tags', 'content_tags'):
        grouped = defaultdict(list)
        for r in rows:
            labels = r[key] if isinstance(r[key], list) else [r[key]]
            for label in labels or ['none']:
                grouped[label].append(r)
        groups[key] = {label: dict(row_count=len(items), metrics=aggregate(items)) for label, items in grouped.items()}
    result = dict(run_id=rows[0]['run_id'], dataset_id=rows[0]['dataset_id'],
                  evaluation_id=rows[0]['evaluation_id'], created_at=now(),
                  evaluation_file=str(args.evaluation.resolve()), row_count=len(rows),
                  planned_row_count=len(checkpoint['selected_qids']),
                  status_counts=dict(Counter(r['status'] for r in rows)),
                  overall=aggregate(rows), groups=groups,
                  aggregation='Pooled numerators/denominators; tags can overlap. N/A excluded with coverage reported.')
    path = output_file(args.output_dir, 'aggregate', 'json')
    with path.open('x', encoding='utf-8') as stream:
        stream.write(dumps(result) + '\n')
    print(path)


if __name__ == '__main__':
    main()
