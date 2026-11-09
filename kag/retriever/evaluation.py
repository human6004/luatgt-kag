"""Frozen sample slice and exact-ID retrieval metrics; no answer generation."""
from collections import Counter
import hashlib
import json
from pathlib import Path


def _gold(record):
    ids = record.get('gold_unit_ids')
    if ids is None:
        return []
    if not isinstance(ids,list) or any(not isinstance(x,str) or not x for x in ids):
        raise ValueError('gold_unit_ids must be exact nonempty strings in a list')
    return list(dict.fromkeys(ids))


def _qid(record):
    value = record.get('qid',record.get('id'))
    if not isinstance(value,str) or not value:
        raise ValueError('exact question ID required')
    return value


def _category(record):
    return record.get('category',record.get('loai','unknown'))


def _source(record):
    return record.get('source',record.get('nguon','unknown'))


def _distribution(records):
    return {'category':dict(sorted(Counter(_category(r) for r in records).items())),
            'source':dict(sorted(Counter(_source(r) for r in records).items()))}


def build_eval_slice(eval_path, sample_keys, output_path):
    """Copy complete eligible source lines byte-for-byte, in original order."""
    source, target = Path(eval_path).resolve(), Path(output_path).resolve()
    if source == target or target.exists():
        raise ValueError('slice must be a new artifact, never overwrite source or frozen output')
    sample_ids = {identity for kind,identity in sample_keys
                  if kind.rsplit('.',1)[-1]=='LegalUnit'}
    original = source.read_bytes()
    records, eligible, excluded, selected, seen = [], [], [], [], set()
    with_gold = 0
    for line in original.splitlines(keepends=True):
        if not line.strip():
            continue
        record = json.loads(line)
        qid, gold = _qid(record), _gold(record)
        if qid in seen:
            raise ValueError('duplicate question ID')
        seen.add(qid)
        records.append(record)
        with_gold += bool(gold)
        missing = [identity for identity in gold if identity not in sample_ids]
        if not gold or missing:
            excluded.append({'qid':qid,'reason':'no_gold' if not gold else 'gold_outside_sample',
                             'missing_gold_unit_ids':missing})
        else:
            eligible.append(record)
            selected.append(line)
    target.parent.mkdir(parents=True,exist_ok=True)
    raw = b''.join(selected)
    with target.open('xb') as stream:
        stream.write(raw)
    identities = json.dumps(sorted(sample_ids),ensure_ascii=False,separators=(',',':')).encode()
    return {'original_questions':len(records),'questions_with_gold':with_gold,
            'eligible_questions':len(eligible),'excluded_questions':len(excluded),
            'excluded':excluded,'source_sha256':hashlib.sha256(original).hexdigest(),
            'sample_unit_identity_sha256':hashlib.sha256(identities).hexdigest(),
            'slice_sha256':hashlib.sha256(raw).hexdigest(),
            'selection':'nonempty gold_unit_ids subset of exact sample LegalUnit IDs',
            'distributions':{'original':_distribution(records),'eligible':_distribution(eligible)},
            'status':'PASS' if eligible else 'BLOCKED'}


def evaluate(questions, predictions, ks=(1,5,10)):
    """Macro Hit/Recall and MRR on ordered unique exact LegalUnit IDs.

    MRR uses the full provided ranking; MRR@k explicitly truncates at k.
    Missing/extra/duplicate predictions are input errors, never silent misses.
    """
    if not ks or len(set(ks))!=len(ks) or any(type(k) is not int or k<=0 for k in ks):
        raise ValueError('distinct positive integer cutoffs required')
    questions, predictions = list(questions), list(predictions)
    qids, predicted = [_qid(q) for q in questions], {}
    if len(set(qids))!=len(qids):
        raise ValueError('duplicate question ID')
    for prediction in predictions:
        qid, ids = _qid(prediction), prediction['unit_ids']
        if qid in predicted or not isinstance(ids,list) or any(not isinstance(x,str) or not x for x in ids):
            raise ValueError('duplicate prediction or malformed exact IDs')
        predicted[qid] = list(dict.fromkeys(ids))
    if set(qids)!=set(predicted):
        raise ValueError('predictions must cover exactly the frozen questions')
    scored = []
    for question,qid in zip(questions,qids):
        gold, ranked = set(_gold(question)), predicted[qid]
        if not gold:
            raise ValueError('metrics require nonempty exact gold')
        rank = next((i for i,identity in enumerate(ranked,1) if identity in gold),None)
        row = {'MRR':1/rank if rank else 0.0}
        for k in ks:
            matches = len(gold & set(ranked[:k]))
            row.update({f'Hit@{k}':float(matches>0),f'Recall@{k}':matches/len(gold),
                        f'MRR@{k}':1/rank if rank and rank<=k else 0.0})
        scored.append((question,row))

    names = ['MRR',*[name for k in ks for name in (f'Hit@{k}',f'Recall@{k}',f'MRR@{k}')]]
    def summary(rows):
        return {'questions':len(rows),**{name:sum(r[name] for r in rows)/len(rows)
                                        if rows else None for name in names}}
    def groups(field):
        keys = sorted({field(q) for q,_ in scored})
        return {key:summary([r for q,r in scored if field(q)==key]) for key in keys}
    return {'status':'PASS' if scored else 'BLOCKED','purpose':'DEMO_CODE_PATH_ONLY',
            'cutoffs':list(ks),'ranking':'unique exact LegalUnit IDs, evidence order',
            'overall':summary([r for _,r in scored]),
            'by_category':groups(_category),'by_source':groups(_source)}
