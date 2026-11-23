"""Step 3: evaluate saved responses only; optional human reviews supply semantic scores.

Inputs: ketqua CSV, its checkpoint and an optional run-bound review JSON.
Output: a new evaluate timestamped CSV; neither input nor previous evaluations change.
"""
import argparse
from pathlib import Path

from common import (BENCH, dataset_id, dumps, finite_number, load_csv, now,
                    output_file, read_json, source_catalog, validate, write_csv)

SEMANTIC = ('correctness', 'completeness', 'hallucination_rate')
FIELDS = ('run_id', 'dataset_id', 'evaluation_id', 'qid', 'category', 'case_group',
          'conversation_id', 'turn_index', 'conversation_type', 'reasoning_level',
          'expression_tags', 'content_tags', 'status', 'expected_behavior',
          'actual_behavior', 'metrics', 'review', 'provenance')
BEHAVIORS = {'ANSWERED': 'ANSWER', 'CLARIFY': 'CLARIFY', 'KAG_ABSTAINED': 'ABSTAIN'}


def metric(n=None, d=None, *, reason='', method='rule'):
    """Represent a measured fraction or explicit N/A with its denominator and reason."""
    return dict(value=n/d if n is not None and d else None, numerator=n, denominator=d,
                reason=reason if n is None or not d else '', method=method)


def identity_matches(citation, gold):
    """Match source identity without forcing TrafficSign to inherit its anchor unit."""
    return citation.get('doc_id') == gold['doc_id'] and all(
        gold.get(k) is None or citation.get(k) == gold[k] for k in ('unit_id', 'sign_id'))


def citation_scores(citations, gold, catalog=None):
    """Score unique valid citations against alternative-aware evidence requirement groups.

    Matching requires identity and gold quote containment in a cited field. Offsets do
    not have to equal the author's span; a larger, correctly sourced quote is allowed.
    """
    groups = {g['requirement_group'] for g in gold}
    unique = {dumps({k: c.get(k) for k in ('doc_id', 'unit_id', 'sign_id', 'field', 'quote')}): c
              for c in citations if isinstance(c, dict)}
    predicted = list(unique.values())
    malformed = len(citations) - sum(isinstance(c, dict) for c in citations)
    def supports(c, g):
        if catalog is None:
            return False
        key = 'sign_id' if g['sign_id'] else 'unit_id' if g['unit_id'] else 'doc_id'
        source = catalog[key].get(g[key], {})
        field = {'moTa': 'mo_ta'}.get(g['field'], g['field'])
        quote = c.get('quote')
        return (identity_matches(c, g) and c.get('field') == g['field']
                and isinstance(quote, str) and g['quote'] in quote
                and quote in source.get(field, ''))
    if gold and catalog is None:
        return {k: metric(reason='SOURCE_CATALOG_REQUIRED', method='source_comparison')
                for k in ('citation_precision', 'citation_recall')}
    return {
        'citation_precision': metric(sum(any(supports(c, g) for g in gold) for c in predicted),
                                     len(predicted) + malformed, method='source_comparison',
                                     reason='NO_PREDICTED_CITATIONS') if gold else metric(reason='NO_GOLD_EVIDENCE', method='source_comparison'),
        'citation_recall': metric(sum(any(supports(c, g) for c in predicted for g in gold
                                                if g['requirement_group'] == group) for group in groups),
                                  len(groups), method='source_comparison', reason='NO_GOLD_EVIDENCE')}


def reviews_for(path, run):
    """Validate optional human review identity, rubric and scalar/fact/claim domains."""
    if path is None:
        return {}, None
    value = read_json(path)
    if set(value) != {'run_id', 'dataset_id', 'rubric_version', 'reviewer', 'reviews'}:
        raise ValueError('Invalid review document keys')
    if value['run_id'] != run['run_id'] or value['dataset_id'] != run['dataset_id'] or value['rubric_version'] != '1':
        raise ValueError('Review does not match this run/dataset/rubric')
    if not isinstance(value['reviewer'], str) or not value['reviewer'].strip():
        raise ValueError('Human reviewer name required')
    questions = {q['qid']: q for q in run['dataset_snapshot']}
    reviews = {}
    if not isinstance(value['reviews'], list):
        raise ValueError('reviews must be an array')
    for r in value['reviews']:
        keys = {'qid', 'correctness', 'relevance', 'fact_support', 'claim_count',
                'unsupported_claim_count', 'rationale'}
        if (not isinstance(r, dict) or not keys <= set(r) or set(r) - keys - {'false_premise_handled'}
                or r['qid'] not in run['results'] or r['qid'] in reviews):
            raise ValueError('Invalid, unknown or duplicate review qid')
        if not isinstance(r['rationale'], str) or not r['rationale'].strip():
            raise ValueError('Review rationale required, including reasons for uncertainty')
        for field in ('correctness', 'relevance', 'false_premise_handled'):
            if r.get(field) is not None and type(r[field]) is not bool:
                raise ValueError('Review verdict must be true/false/null: ' + field)
        facts = r['fact_support']
        if not isinstance(facts, list) or len(facts) != len(questions[r['qid']]['required_facts']) or any(v is not None and type(v) is not bool for v in facts):
            raise ValueError('fact_support must match required_facts in order')
        total, unsupported = r['claim_count'], r['unsupported_claim_count']
        if not (total is None and unsupported is None):
            if type(total) is not int or type(unsupported) is not int or not 0 <= unsupported <= total:
                raise ValueError('Invalid claim counts')
        reviews[r['qid']] = r
    return reviews, {k: value[k] for k in ('rubric_version', 'reviewer')}


def score(question, result, review=None, catalog=None):
    """Score selected chat metrics; relevance remains a review input for task success."""
    observed = result['status'] in BEHAVIORS
    attempted = result['attempts'] > 0
    resolved = result['status'] not in ('SENDING', 'PROCESSING', 'INTERRUPTED')
    actual = BEHAVIORS.get(result['status'])
    metrics = {k: metric(reason='HUMAN_REVIEW_REQUIRED', method='human_review') for k in SEMANTIC}
    metrics['behavior_accuracy'] = metric(int(actual == question['expected_behavior']), 1) if observed else metric(reason='NO_CHAT_BEHAVIOR_OBSERVED')
    response = result['response']
    if observed and question['expected_behavior'] == 'ANSWER':
        metrics.update(citation_scores(response.get('citations', []), question['gold_evidence'], catalog))
    else:
        metrics.update({k: metric(reason='NOT_APPLICABLE_OR_NO_RESPONSE', method='source_comparison')
                        for k in ('citation_precision', 'citation_recall')})
    if review and observed:
        if review['correctness'] is not None:
            metrics['correctness'] = metric(int(review['correctness']), 1, method='human_review')
        facts = review['fact_support']
        if all(v is not None for v in facts):
            metrics['completeness'] = metric(sum(facts), len(facts), method='human_review')
        total, unsupported = review['claim_count'], review['unsupported_claim_count']
        if total is not None and total:
            metrics['hallucination_rate'] = metric(unsupported, total, method='human_review')
        elif total == 0:
            metrics['hallucination_rate'] = metric(reason='NO_FACTUAL_CLAIMS', method='human_review')
    task = metric(reason='SEMANTIC_REVIEW_INCOMPLETE', method='combined')
    if not resolved:
        task = metric(reason='REQUEST_OUTCOME_UNRESOLVED', method='combined')
    elif (observed and actual != question['expected_behavior']) or (attempted and not observed):
        task = metric(0, 1, method='combined')
    elif not attempted:
        task = metric(reason='NOT_EXECUTED', method='combined')
    elif review:
        checks = [review['correctness'], review['relevance'], *review['fact_support']]
        if False in checks:
            task = metric(0, 1, method='combined')
        elif all(v is True for v in checks):
            task = metric(1, 1, method='combined')
    metrics['task_success_rate'] = task
    for name, numerator in (('api_success_rate', int(result['api_success'])),
                            ('timeout_rate', int(result['timeout']))):
        metrics[name] = (metric(numerator, 1) if attempted and (resolved or name == 'timeout_rate') else
                         metric(reason='REQUEST_OUTCOME_UNRESOLVED' if attempted else 'NOT_EXECUTED'))
    latency = result['latency_ms']
    metrics['latency_ms'] = (dict(value=latency, numerator=latency, denominator=1, reason='', method='measurement')
                             if attempted and finite_number(latency) else metric(reason='LATENCY_UNOBSERVED_OR_NOT_EXECUTED', method='measurement'))
    return actual, metrics


def main():
    """Bind results to a checkpoint and export a fresh evaluation plus a review template."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--reviews', type=Path)
    parser.add_argument('--output-dir', default=str(BENCH / 'output'))
    args = parser.parse_args()
    checkpoint = args.results.with_name(args.results.name.replace('ketqua_', 'checkpoint_')).with_suffix('.json')
    run = read_json(checkpoint)
    if dataset_id(run['dataset_snapshot']) != run['dataset_id']:
        raise ValueError('Checkpoint dataset snapshot changed')
    errors = validate(run['dataset_snapshot'])
    if errors:
        raise ValueError('\n'.join(errors))
    saved = load_csv(args.results)
    expected = list(run['results'].values())
    rendered = [{k: dumps(v) if isinstance(v, (dict, list)) else '' if v is None else str(v)
                 for k, v in row.items()} for row in expected]
    if saved != rendered:
        raise ValueError('Result CSV differs from checkpoint; resume step 2 to restore its snapshot')
    reviews, reviewer = reviews_for(args.reviews, run)
    path = output_file(args.output_dir, 'evaluate', 'csv')
    questions = {q['qid']: q for q in run['dataset_snapshot']}
    catalog = source_catalog(run['dataset_snapshot'])
    evaluated, template = [], []
    for result in expected:
        q = questions[result['qid']]
        actual, metrics = score(q, result, reviews.get(q['qid']), catalog)
        a = q['question_attributes']
        evaluated.append(dict(run_id=run['run_id'], dataset_id=run['dataset_id'], evaluation_id=path.stem,
                              qid=q['qid'], category=q['category'], case_group=q['case_group'],
                              conversation_id=q['conversation_id'], turn_index=q['turn_index'],
                              conversation_type=a['conversation_type'], reasoning_level=q['reasoning_level'],
                              expression_tags=a['expression_tags'], content_tags=a['content_tags'],
                              status=result['status'], expected_behavior=q['expected_behavior'], actual_behavior=actual,
                              metrics=metrics, review=reviews.get(q['qid'], {}),
                              provenance=dict(evaluated_at=now(), checkpoint=str(checkpoint.resolve()), reviewer=reviewer)))
        template.append(dict(qid=q['qid'], correctness=None, relevance=None,
                             fact_support=[None] * len(q['required_facts']), claim_count=None,
                             unsupported_claim_count=None,
                             rationale='CHƯA CHẤM: ghi lý do và căn cứ trước khi điền điểm.'))
    write_csv(path, evaluated, FIELDS)
    template_path = path.with_name(path.stem + '_review_template.json')
    with template_path.open('x', encoding='utf-8') as stream:
        stream.write(dumps(dict(run_id=run['run_id'], dataset_id=run['dataset_id'], rubric_version='1',
                               reviewer='', reviews=template)) + '\n')
    print(path)
    print(template_path)


if __name__ == '__main__':
    main()
