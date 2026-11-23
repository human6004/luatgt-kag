"""Shared dataset, source verification and durable UTF-8 artifact helpers.

Inputs are the 13-column CSV/JSON and repository corpus; no inference or network.
"""
import csv
import hashlib
import json
import math
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / 'benchmark'
VN = timezone(timedelta(hours=7), 'Asia/Ho_Chi_Minh')
COLUMNS = ('qid', 'case_group', 'conversation_id', 'turn_index', 'question',
           'category', 'question_attributes', 'reasoning_level', 'legal_reference_date',
           'expected_behavior', 'expected_answer', 'required_facts', 'gold_evidence')
JSON_COLUMNS = ('question_attributes', 'required_facts', 'gold_evidence')
STYLES = {'standard', 'noisy', 'verbose'}
CONTENTS = {'false_premise', 'underspecified', 'multi_request'}
CONVERSATIONS = {'standalone', 'follow_up', 'correction', 'topic_switch'}
TERMINAL = {'ANSWERED', 'CLARIFY', 'KAG_ABSTAINED', 'UNAVAILABLE', 'CANCELLED'}


def now():
    """Return a Vietnam-time ISO timestamp for checkpoint and run metadata."""
    return datetime.now(VN).isoformat()


def stamp():
    """Return the requested YYYYMMDD_HHMMSS filename component in Vietnam time."""
    return datetime.now(VN).strftime('%Y%m%d_%H%M%S')


def dumps(value):
    """Serialize JSON without ASCII escaping or non-finite numbers."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def read_json(path):
    """Read UTF-8 JSON and reject non-finite numbers and duplicate keys."""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key: ' + key)
            result[key] = value
        return result
    def invalid(value):
        raise ValueError('Non-finite JSON: ' + value)
    return json.loads(Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=pairs,
                      parse_constant=invalid)


def atomic_json(path, value):
    """Replace one owned checkpoint atomically after flushing it to disk."""
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        stream.write(dumps(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def write_csv(path, rows, fields, *, replace=False):
    """Write JSON-valued cells losslessly; new exports never overwrite old files."""
    path = Path(path)
    target = path.with_name(path.name + '.tmp') if replace else path
    with target.open('w' if replace else 'x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='raise')
        writer.writeheader()
        for row in rows:
            writer.writerow({key: dumps(value) if isinstance(value, (dict, list)) else value
                             for key, value in row.items()})
        stream.flush()
        os.fsync(stream.fileno())
    if replace:
        os.replace(target, path)


def load_rows(path):
    """Load exact-schema JSON or CSV and decode structured cells to native values."""
    path = Path(path)
    if path.suffix.lower() == '.json':
        rows = read_json(path)
    elif path.suffix.lower() == '.csv':
        with path.open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames != list(COLUMNS):
                raise ValueError('CSV must have exactly the 13 documented columns, in order')
            rows = list(reader)
        for row in rows:
            for key in JSON_COLUMNS:
                row[key] = json.loads(row[key])
            row['turn_index'] = int(row['turn_index'])
    else:
        raise ValueError('Dataset must be .csv or .json')
    if not isinstance(rows, list) or not rows:
        raise ValueError('Dataset must be a nonempty array')
    return rows


def dataset_id(rows):
    """Identify the exact ordered input records, independently of CSV/JSON formatting."""
    return hashlib.sha256(dumps(rows).encode('utf-8')).hexdigest()


def source_catalog(rows):
    """Load only corpus records named by gold; return indexed documents/units/signs."""
    evidence = [g for r in rows for g in r.get('gold_evidence', []) if isinstance(g, dict)]
    result = {}
    paths = {'doc_id': 'meta/documents.jsonl', 'unit_id': 'units/units.jsonl',
             'sign_id': 'signs/signs.jsonl'}
    for key, relative in paths.items():
        wanted = {g.get(key) for g in evidence if g.get(key)}
        found = {}
        if wanted:
            with (ROOT / 'data/processed' / relative).open(encoding='utf-8') as stream:
                for line in stream:
                    record = json.loads(line)
                    if record.get(key) in wanted:
                        found[record[key]] = record
        result[key] = found
    return result


def validate(rows, *, check_sources=True):
    """Reject schema/domain/order/source errors; return all row-scoped error messages.

    Source checks prove IDs and quoted text exist, not legal applicability or graph presence.
    """
    errors, qids, turns, closed = [], set(), {}, set()
    previous = None
    for index, r in enumerate(rows, 1):
        prefix = f'row {index} ({r.get("qid", "?") if isinstance(r, dict) else "?"}): '
        def error(message):
            errors.append(prefix + message)
        if not isinstance(r, dict) or set(r) != set(COLUMNS):
            error('exactly 13 columns required')
            continue
        for key in ('qid', 'case_group', 'conversation_id', 'question', 'expected_answer'):
            if not isinstance(r[key], str) or not r[key].strip():
                error(key + ' must be nonempty text')
        if not all(isinstance(r[k], str) for k in ('qid', 'conversation_id')):
            continue
        if r['qid'] in qids:
            error('duplicate qid')
        qids.add(r['qid'])
        cid, turn = r['conversation_id'], r['turn_index']
        if cid != previous:
            if cid in closed:
                error('conversation rows must be contiguous')
            if previous is not None:
                closed.add(previous)
            previous = cid
        expected = turns.get(cid, 0) + 1
        if type(turn) is not int or turn != expected:
            error(f'turn_index must be {expected}, without gaps or duplicates')
        if type(turn) is int:
            turns[cid] = turn
        if not isinstance(r['category'], str) or r['category'] not in {f'C{i}' for i in range(1, 8)}:
            error('invalid category')
        if r['reasoning_level'] not in ('direct', 'single_step', 'multi_step'):
            error('invalid reasoning_level')
        if r['expected_behavior'] not in ('ANSWER', 'CLARIFY', 'ABSTAIN'):
            error('invalid expected_behavior')
        try:
            if date.fromisoformat(r['legal_reference_date']).isoformat() != r['legal_reference_date']:
                raise ValueError()
        except (ValueError, TypeError):
            error('legal_reference_date must be YYYY-MM-DD')
        attrs = r['question_attributes']
        if not isinstance(attrs, dict) or set(attrs) != {'expression_tags', 'content_tags', 'conversation_type'}:
            error('invalid question_attributes structure')
        else:
            for key, allowed, nonempty in (('expression_tags', STYLES, True), ('content_tags', CONTENTS, False)):
                values = attrs[key]
                if (not isinstance(values, list) or (nonempty and not values)
                        or any(not isinstance(v, str) or v not in allowed for v in values)
                        or len(set(v for v in values if isinstance(v, str))) != len(values)):
                    error('invalid ' + key)
            if isinstance(attrs['expression_tags'], list) and 'standard' in attrs['expression_tags'] and len(attrs['expression_tags']) != 1:
                error('standard must be used alone')
            kind = attrs['conversation_type']
            if not isinstance(kind, str) or kind not in CONVERSATIONS or (turn == 1 and kind != 'standalone') or (turn != 1 and kind == 'standalone'):
                error('conversation_type does not match turn position')
        facts, gold = r['required_facts'], r['gold_evidence']
        if not isinstance(facts, list) or not facts or any(not isinstance(f, str) or not f.strip() for f in facts):
            error('required_facts must be a nonempty list of text')
        if not isinstance(gold, list):
            error('gold_evidence must be a list')
            continue
        if r['expected_behavior'] == 'ANSWER' and not gold:
            error('ANSWER requires source evidence')
        groups = set()
        for g in gold:
            required = {'doc_id', 'unit_id', 'sign_id', 'field', 'quote', 'source_url', 'requirement_group'}
            if not isinstance(g, dict) or set(g) != required:
                error('invalid gold_evidence keys')
                continue
            if any(not isinstance(g[k], str) or not g[k].strip() for k in ('doc_id', 'field', 'quote', 'source_url', 'requirement_group')):
                error('gold evidence has empty required fields')
            if any(g[k] is not None and (not isinstance(g[k], str) or not g[k].strip()) for k in ('unit_id', 'sign_id')):
                error('unit_id/sign_id must be nonempty text or null')
            allowed_fields = ('moTa', 'ten') if g['sign_id'] else ('text',) if g['unit_id'] else ('title',)
            if g['field'] not in allowed_fields:
                error('gold field does not match document/unit/sign type')
            if isinstance(g['requirement_group'], str):
                groups.add(g['requirement_group'])
        if r['reasoning_level'] == 'multi_step' and r['expected_behavior'] == 'ANSWER' and len(groups) < 2:
            error('multi_step requires at least two distinct evidence requirement groups')
        if isinstance(r['question'], str) and len(r['question'].encode('utf-16-le')) // 2 > 4000:
            error('question exceeds WebApp 4000 UTF-16 unit limit')
    if errors or not check_sources:
        return errors
    catalog = source_catalog(rows)
    for r in rows:
        for g in r['gold_evidence']:
            prefix = r['qid'] + ': '
            doc = catalog['doc_id'].get(g['doc_id'])
            key = 'sign_id' if g['sign_id'] else 'unit_id' if g['unit_id'] else 'doc_id'
            record = catalog[key].get(g[key])
            field = {'moTa': 'mo_ta'}.get(g['field'], g['field'])
            if not doc or not record:
                errors.append(prefix + 'gold ID not found in corpus')
                continue
            if key != 'doc_id' and record.get('doc_id') != g['doc_id']:
                errors.append(prefix + 'gold ID belongs to a different document')
            if key == 'sign_id' and g['unit_id'] and record.get('unit_id') != g['unit_id']:
                errors.append(prefix + 'sign/unit binding differs from corpus; use separate evidence entries')
            if g['quote'] not in record.get(field, ''):
                errors.append(prefix + 'gold quote does not exist verbatim in source field')
            if g['source_url'] != doc.get('source_url'):
                errors.append(prefix + 'source_url differs from corpus provenance')
    return errors


def checked_rows(path):
    """Load and validate dataset, raising a readable error before any API request."""
    rows = load_rows(path)
    errors = validate(rows)
    if errors:
        raise ValueError('\n'.join(errors))
    return rows


def load_csv(path):
    """Read an artifact CSV without coercing text or JSON cells."""
    with Path(path).open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def output_file(root, prefix, extension):
    """Reserve a new timestamped artifact name; refuse second-resolution collisions."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    path = root / f'{prefix}_{stamp()}.{extension}'
    if path.exists():
        raise FileExistsError(f'Output already exists: {path}; retry in another second')
    return path


def finite_number(value):
    """Return whether an external metric value is a finite real number, excluding bool."""
    return type(value) in (int, float) and math.isfinite(value)
