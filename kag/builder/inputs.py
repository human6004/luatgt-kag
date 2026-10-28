"""Offline source loading and fail-closed integrity checks.

Frozen containers and their dictionaries are immutable by convention. Locators
are repository-relative for corpus files and artifact names for external ledger.
No full-source runner or count-based production-plan verification lives here.
"""
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from .codec import BuilderContractError, canonical_json, validate_properties


ARTIFACT_HASHES = (
    ('xref_a3g2_final_ledger.jsonl', 'd2a8a70f4f91d04cac4e935e063fb6f3077d0bbc845f1ddaa3d9905e11ec8c89'),
    ('xref_a3g2_final_audit.json', 'f970e340351991112f6196719a94e692c1cad3328f30956b75011cec51e0d210'),
    ('xref_a3g2_downstream_policy.json', 'f95528824d231363be684f68ab09b9df8e7a52379dc286e3448deaca20b39098'),
)
SOURCE_FILES = (
    ('documents', 'data/processed/meta/documents.jsonl'),
    ('units', 'data/processed/units/units.jsonl'),
    ('penalties', 'data/processed/penalties/penalties.jsonl'),
    ('signs', 'data/processed/signs/signs.jsonl'),
    ('relations', 'data/processed/meta/relations.jsonl'),
    ('xrefs', 'data/processed/meta/xrefs.jsonl'),
)
CLASSIFICATIONS = ('SAFE_EDGE', 'EXTERNAL_REFERENCE_ONLY',
                   'KEEP_UNRESOLVED_NO_EDGE', 'EXCLUDE_FROM_GRAPH_EDGE')
SIGN_RECORD_TYPES = ('family', 'variant', 'standalone', 'unverified_code')
SIGN_DESCRIPTION_SCOPES = ('specific', 'family_shared', 'contextual', 'unverified')
SIGN_VERIFICATION_STATES = ('verified_pdf', 'source_conflict', 'reference_only', 'review_required')


class InputIntegrityError(BuilderContractError):
    """Invalid source identity, hierarchy, join or artifact integrity."""


def convert_signs(records, units, documents):
    """Convert the reviewed sign master without repairing identities or legal text."""
    result, indexed = [], {}
    for line, record in enumerate(records, 1):
        context = f'sign master:{line}'
        if not isinstance(record, dict):
            raise InputIntegrityError(f'{context}: expected object')
        for field in ('sign_id', 'sign_code', 'qcvn', 'category', 'name', 'unit_id'):
            if not isinstance(record.get(field), str) or not record[field].strip():
                raise InputIntegrityError(f'{context}: {field} missing/non-text/blank')
        identity = record['sign_id']
        if identity in indexed:
            raise InputIntegrityError(f'{context}: duplicate sign_id {identity!r}')
        if identity != record['qcvn'] + '::' + record['sign_code']:
            raise InputIntegrityError(f'{context}: QCVN/code identity mismatch')
        for field, allowed in (('record_type', SIGN_RECORD_TYPES),
                               ('description_scope', SIGN_DESCRIPTION_SCOPES),
                               ('verification_status', SIGN_VERIFICATION_STATES)):
            if record.get(field) not in allowed:
                raise InputIntegrityError(f'{context}: invalid {field}')
        text = record.get('legal_description')
        if not isinstance(text, str):
            raise InputIntegrityError(f'{context}: legal_description must be Text')
        if record['verification_status'] == 'verified_pdf' and (
                not text.strip() or record['description_scope'] == 'unverified'
                or not isinstance(record.get('source_evidence'), list) or not record['source_evidence']):
            raise InputIntegrityError(f'{context}: verified legal source missing')
        unit = units.get(record['unit_id'])
        document = documents.get(unit.get('doc_id')) if unit else None
        if not unit or not document or document.get('scope') == 'out_of_scope':
            raise InputIntegrityError(f'{context}: production unit/document missing')
        qcvn = unit.get('scope') or unit.get('qcvn_id')
        if not isinstance(qcvn, str) or re.sub(r'\s+', '', qcvn) != re.sub(r'\s+', '', record['qcvn']):
            raise InputIntegrityError(f'{context}: QCVN version differs from source unit')
        parent = record.get('parent_code')
        if parent is not None and (not isinstance(parent, str) or not parent.strip()):
            raise InputIntegrityError(f'{context}: invalid parent_code')
        children = record.get('children_codes')
        if (not isinstance(children, list) or any(not isinstance(v, str) or not v for v in children)
                or len(set(children)) != len(children)):
            raise InputIntegrityError(f'{context}: invalid children_codes')
        values = dict(sign_id=identity, doc_id=unit['doc_id'], unit_id=record['unit_id'],
            so_hieu=document['so_hieu'], ma_bien=record['sign_code'], nhom=record['category'],
            qcvn=record['qcvn'], ten=record['name'], bien_phu_variant=record.get('bien_phu_variant', ''),
            mo_ta=text, ngay_hieu_luc=document.get('effective_from', document.get('ngay_hieu_luc')),
            ngay_het_hieu_luc=document.get('effective_to', document.get('ngay_het_hieu_luc')),
            record_type=record['record_type'], description_scope=record['description_scope'],
            verification_status=record['verification_status'],
            parent_sign_id=record['qcvn']+'::'+parent if parent else None,
            source_evidence={'record': deepcopy(record)})
        result.append(values)
        indexed[identity] = record
    for row in result:
        record = indexed[row['sign_id']]
        parent = indexed.get(row['parent_sign_id']) if row['parent_sign_id'] else None
        if record['record_type'] == 'variant' and parent is None:
            raise InputIntegrityError(f"{row['sign_id']}: missing source parent")
        if row['parent_sign_id'] and (parent is None or parent['record_type'] not in ('family', 'standalone')
                or record['record_type'] != 'variant' or record['sign_code'] not in parent['children_codes']):
            raise InputIntegrityError(f"{row['sign_id']}: missing/inconsistent source parent")
        for child in record['children_codes']:
            target = indexed.get(record['qcvn']+'::'+child)
            if not target or target.get('parent_code') != record['sign_code']:
                raise InputIntegrityError(f"{row['sign_id']}: missing/inconsistent family child {child}")
    return result


@dataclass(frozen=True)
class SourceRecord:
    record: dict[str, Any]
    locator: dict[str, Any]


@dataclass(frozen=True)
class BuilderInputs:
    documents: tuple[SourceRecord, ...]
    units: tuple[SourceRecord, ...]
    penalties: tuple[SourceRecord, ...]
    signs: tuple[SourceRecord, ...]
    relations: tuple[SourceRecord, ...]
    xrefs: tuple[SourceRecord, ...]
    ledger: tuple[SourceRecord, ...]
    markdown_paths: frozenset[str]
    artifact_hashes: dict[str, str]


@dataclass(frozen=True)
class ValidatedInputs:
    raw: BuilderInputs
    documents: dict[str, SourceRecord]
    units: dict[str, SourceRecord]
    signs: dict[str, SourceRecord]
    penalties: dict[str, SourceRecord]
    xref_ledger: dict[str, SourceRecord]


def _error(row: SourceRecord, reason: str) -> InputIntegrityError:
    return InputIntegrityError(f"{row.locator['source_path']}:{row.locator['line']}: {reason}")


def xref_fingerprint(source_record: Mapping[str, Any]) -> str:
    """Hash ALL untouched original fields, before gates or property preparation."""
    return hashlib.sha256(canonical_json(source_record).encode('utf-8')).hexdigest()


def _index(rows: tuple[SourceRecord, ...], field: str) -> dict[str, SourceRecord]:
    result = {}
    for row in rows:
        value = row.record.get(field)
        if not isinstance(value, str) or not value.strip():
            raise _error(row, f'{field}: missing/non-text/blank identity')
        if value in result:
            raise _error(row, f'duplicate {field} {value!r}')
        result[value] = row
    return result


def _node_values(
    node_type: str, row: SourceRecord, penalty: SourceRecord | None = None,
) -> dict[str, Any]:
    """Prepare logical properties once for validation and mapping; never mutate source."""
    record = row.record
    id_field = {'LegalDocument': 'doc_id', 'LegalUnit': 'unit_id', 'TrafficSign': 'sign_id'}[node_type]
    values = dict(record, id=record[id_field], name=record[id_field], source_record=dict(row.locator))
    if 'source_evidence' in record:
        values['source_record']['origin'] = deepcopy(record['source_evidence'])
    if node_type == 'LegalDocument':
        values['markdown_path'] = f"data/processed/documents/{record['doc_id']}.md"
        for primary, alias in (('effective_from', 'ngay_hieu_luc'), ('effective_to', 'ngay_het_hieu_luc')):
            if record.get(primary) is not None and record.get(alias) is not None and record[primary] != record[alias]:
                raise _error(row, f'{primary}: date alias conflict with {alias}')
            values[primary] = record[primary] if primary in record else record.get(alias)
    elif node_type == 'LegalUnit':
        # Penalty properties are derived exclusively from the joined penalty row.
        values = {key: value for key, value in values.items() if not key.startswith('penalty_')}
        if penalty is not None:
            for key in ('penalty_id', 'dieu_title', 'doi_tuong', 'hanh_vi', 'phat_tien_min',
                        'phat_tien_max', 'canh_cao', 'tru_diem_gplx', 'tich_thu'):
                logical = key if key == 'penalty_id' else 'penalty_' + key
                values[logical] = penalty.record.get(key)
            span = penalty.record.get('tuoc_gplx_thang')
            if span is not None:
                if not isinstance(span, list) or len(span) != 2 or any(type(x) is not int for x in span):
                    raise _error(penalty, 'penalty tuoc_gplx_thang: expected two native ints')
                values['penalty_tuoc_gplx_thang_min'], values['penalty_tuoc_gplx_thang_max'] = span
            values['penalty_source_record'] = {'record': penalty.record, 'locator': penalty.locator}
    return values


def _validate_node(node_type: str, row: SourceRecord, contract: Mapping[str, Any],
                   penalty: SourceRecord | None = None) -> None:
    try:
        validate_properties(_node_values(node_type, row, penalty),
                            contract['node_properties'][node_type], contract['unit_type_values'])
    except BuilderContractError as exc:
        raise _error(row, str(exc)) from exc


def validate_input_integrity(inputs: BuilderInputs, contract: Mapping[str, Any]) -> ValidatedInputs:
    """Validate the complete source/ledger join before inspecting SAFE_EDGE rows."""
    documents = _index(inputs.documents, 'doc_id')
    documents = {key: row for key, row in documents.items()
                 if row.record.get('scope') != 'out_of_scope'
                 and f'data/processed/documents/{key}.md' in inputs.markdown_paths}
    units = _index(inputs.units, 'unit_id')
    signs = _index(inputs.signs, 'sign_id')
    for row in documents.values():
        _validate_node('LegalDocument', row, contract)
    for identity, row in units.items():
        record = row.record
        if record.get('doc_id') not in documents:
            raise _error(row, f'unit {identity!r}: missing production doc {record.get("doc_id")!r}')
        if 'parent_id' not in record:
            raise _error(row, f'unit {identity!r}: parent_id key missing')
        parent = record['parent_id']
        if parent is not None:
            if not isinstance(parent, str) or parent not in units:
                raise _error(row, f'unit {identity!r}: parent {parent!r} missing')
            if units[parent].record['doc_id'] != record['doc_id']:
                raise _error(row, f'unit {identity!r}: cross-document parent {parent!r}')
        _validate_node('LegalUnit', row, contract)
    # Iterative parent walk: linear in the number of units, safe for deep trees.
    complete = set()
    for identity in units:
        path = set()
        current = identity
        while current is not None and current not in complete:
            if current in path:
                raise _error(units[current], f'hierarchy cycle at unit_id {current!r}')
            path.add(current)
            current = units[current].record['parent_id']
        complete.update(path)
    penalties = {}
    for row in inputs.penalties:
        record = row.record
        target = record.get('unit_id')
        if not isinstance(target, str) or target not in units:
            raise _error(row, f'orphan penalty unit_id {target!r}')
        if target in penalties:
            raise _error(row, f'duplicate penalty target {target!r}')
        if record.get('penalty_id') != target:
            raise _error(row, f'penalty_id {record.get("penalty_id")!r} != unit_id {target!r}')
        if record.get('doc_id') != units[target].record['doc_id']:
            raise _error(row, f'penalty {target!r}: document mismatch')
        _validate_node('LegalUnit', row=units[target], contract=contract)
        try:
            values = _node_values('LegalUnit', units[target], row)
            validate_properties(values, contract['node_properties']['LegalUnit'], contract['unit_type_values'])
        except BuilderContractError as exc:
            raise _error(row, f'penalty {target!r}: {exc}') from exc
        for low, high in (('penalty_phat_tien_min', 'penalty_phat_tien_max'),
                          ('penalty_tuoc_gplx_thang_min', 'penalty_tuoc_gplx_thang_max')):
            minimum, maximum = values.get(low), values.get(high)
            if ((minimum is not None and minimum < 0) or (maximum is not None and maximum < 0)
                    or (minimum is not None and maximum is not None and minimum > maximum)):
                raise _error(row, f'penalty {target!r}: invalid range {low}/{high}')
        penalties[target] = row
    for identity, row in signs.items():
        target = row.record.get('unit_id')
        if not isinstance(target, str) or target not in units:
            raise _error(row, f'orphan sign {identity!r}: unit_id {target!r}')
        if row.record.get('doc_id') != units[target].record['doc_id']:
            raise _error(row, f'sign {identity!r}: document mismatch')
        _validate_node('TrafficSign', row, contract)
        record = row.record
        semantics = (('record_type', SIGN_RECORD_TYPES),
                     ('description_scope', SIGN_DESCRIPTION_SCOPES),
                     ('verification_status', SIGN_VERIFICATION_STATES))
        if any(field in record for field, _ in semantics):
            for field, allowed in semantics:
                if record.get(field) not in allowed:
                    raise _error(row, f'invalid sign {field}')
            parent_id = record.get('parent_sign_id')
            parent = signs.get(parent_id) if isinstance(parent_id, str) else None
            if record['record_type'] == 'variant':
                if (parent is None or parent.record.get('record_type') not in ('family', 'standalone')
                        or parent.record.get('doc_id') != record['doc_id']
                        or parent.record.get('qcvn') != record.get('qcvn')):
                    raise _error(row, 'variant requires a source parent in the same QCVN')
            elif parent_id is not None:
                raise _error(row, 'only variants may have a source parent')
    source_by_hash = {}
    for row in inputs.xrefs:
        fingerprint = xref_fingerprint(row.record)
        if fingerprint in source_by_hash:
            raise _error(row, f'duplicate source fingerprint {fingerprint}')
        source_by_hash[fingerprint] = row
    ledger = _index(inputs.ledger, 'record_fingerprint')
    missing = source_by_hash.keys() - ledger.keys()
    extra = ledger.keys() - source_by_hash.keys()
    if missing:
        fingerprint = min(missing)
        raise _error(source_by_hash[fingerprint], f'ledger missing fingerprint {fingerprint}')
    if extra:
        fingerprint = min(extra)
        raise _error(ledger[fingerprint], f'ledger extra fingerprint {fingerprint}')
    classification_field = contract['xref_contract']['classification_field']
    for fingerprint, source in source_by_hash.items():
        approved = ledger[fingerprint]
        record = source.record
        for key in sorted(record.keys() & approved.record.keys()):
            if canonical_json(record[key]) != canonical_json(approved.record[key]):
                raise _error(source, f'source/ledger invariant conflict {key}: {fingerprint}')
        classification = approved.record.get(classification_field)
        if classification not in CLASSIFICATIONS:
            raise _error(approved, f'invalid classification {classification!r}')
        if classification != contract['xref_contract']['allowed_classification']:
            continue
        if type(record.get('is_exclusion')) is not bool or record.get('in_corpus') is not True:
            raise _error(source, 'SAFE_EDGE requires exact bool polarity and in_corpus=True')
        evidence = record.get('evidence')
        if not isinstance(evidence, str) or not evidence.strip():
            raise _error(source, 'SAFE_EDGE evidence missing/blank')
        for side in ('from', 'to'):
            identity, document = record.get(side+'_unit_id'), record.get(side+'_doc_id')
            if not isinstance(identity, str) or identity not in units or document not in documents:
                raise _error(source, f'SAFE_EDGE {side} endpoint missing/non-production {identity!r}')
            if units[identity].record['doc_id'] != document:
                raise _error(source, f'SAFE_EDGE {side} document mismatch {identity!r}')
    return ValidatedInputs(inputs, documents, units, signs, penalties, ledger)


def _read(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as exc:
        raise InputIntegrityError(f'{path.name}: cannot read input: {exc}') from exc


def _jsonl(data: bytes, relative_path: str) -> tuple[SourceRecord, ...]:
    digest = hashlib.sha256(data).hexdigest()
    result = []
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise InputIntegrityError(f'{relative_path}: invalid UTF-8: {exc}') from exc
    # JSONL uses LF; Unicode LS/PS/NEL inside JSON strings are source Text.
    for line, raw in enumerate(text.split('\n'), 1):
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise InputIntegrityError(f'{relative_path}:{line}: invalid JSON: {exc.msg}') from exc
        if not isinstance(record, dict):
            raise InputIntegrityError(f'{relative_path}:{line}: expected JSON object')
        result.append(SourceRecord(record, dict(source_path=relative_path, file_sha256=digest, line=line)))
    return tuple(result)


def load_inputs(
    project_root: str | Path, ledger_path: str | Path, audit_path: str | Path,
    policy_path: str | Path, contract: Mapping[str, Any],
    *, expected_artifact_hashes: Mapping[str, str] | None = None,
) -> ValidatedInputs:
    """Load only whitelisted source families; verify all artifacts before parsing.

    Defaults pin the approved production artifacts. Synthetic disk fixtures must
    explicitly supply expected_artifact_hashes and their own xref contract SHA.
    Counts and full-source plan verification are deferred to C3.
    """
    root = Path(project_root)
    expected = dict(ARTIFACT_HASHES) if expected_artifact_hashes is None else expected_artifact_hashes
    artifacts = {}
    hashes = {}
    for (name, _), path in zip(ARTIFACT_HASHES, (ledger_path, audit_path, policy_path)):
        path = Path(path)
        if path.name != name:
            raise InputIntegrityError(f'{path.name}: expected artifact name {name}')
        data = _read(path)
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected.get(name):
            raise InputIntegrityError(f'{name}: SHA256 mismatch')
        artifacts[name], hashes[name] = data, digest
    for name, _ in ARTIFACT_HASHES[1:]:
        try:
            metadata = json.loads(artifacts[name])
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise InputIntegrityError(f'{name}: invalid JSON') from exc
        if not isinstance(metadata, dict):
            raise InputIntegrityError(f'{name}: expected JSON object')
    source_data = {family: _read(root / relative) for family, relative in SOURCE_FILES}
    if hashlib.sha256(source_data['xrefs']).hexdigest() != contract['xref_contract']['xref_sha256']:
        raise InputIntegrityError('data/processed/meta/xrefs.jsonl: SHA256 mismatch')
    rows = {family: _jsonl(source_data[family], relative) for family, relative in SOURCE_FILES}
    markdown = frozenset(path.relative_to(root).as_posix()
                         for path in (root/'data/processed/documents').glob('*.md') if path.is_file())
    inputs = BuilderInputs(**rows, ledger=_jsonl(artifacts[ARTIFACT_HASHES[0][0]], ARTIFACT_HASHES[0][0]),
                           markdown_paths=markdown, artifact_hashes=hashes)
    return validate_input_integrity(inputs, contract)
