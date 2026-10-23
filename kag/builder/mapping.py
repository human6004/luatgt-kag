"""Deterministic C2 plain graph specs; no SDK, vectors, timestamps or writes.

Specs are dictionaries, immutable by convention. Nodes have type/id/name and
physical properties. Relation rows have tuple/application_edge_key, logical
properties, source invariants and locator. Aggregated specs retain tuple/key
and complete physical properties. Tuple order is from type/id, predicate,
to type/id. Provenance arrays alone are canonical byte deduplicated and sorted.
"""
from collections.abc import Mapping, Sequence
from copy import deepcopy
import hashlib
from typing import Any

from .codec import BuilderContractError, canonical_json, encode_properties, validate_properties
from .inputs import ValidatedInputs, SourceRecord, _node_values, xref_fingerprint


class MappingError(BuilderContractError):
    """An invalid mapping cannot become a graph spec."""


class AggregationConflictError(MappingError):
    """Rows sharing an edge tuple disagree on semantics or scalar properties."""


def application_edge_key(tuple_fields: Sequence[str]) -> str:
    """Exact five-field canonical JSON SHA256; evidence never enters identity."""
    if len(tuple_fields) != 5 or any(not isinstance(value, str) or not value.strip() for value in tuple_fields):
        raise MappingError('edge tuple: expected five nonblank Text fields')
    return hashlib.sha256(canonical_json(list(tuple_fields)).encode('utf-8')).hexdigest()


def map_nodes(inputs: ValidatedInputs, contract: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Map validated exact indexes; content and native integers remain intact."""
    specs = []
    for node_type, index in (('LegalDocument', inputs.documents),
                             ('LegalUnit', inputs.units), ('TrafficSign', inputs.signs)):
        for identity, row in index.items():
            penalty = inputs.penalties.get(identity) if node_type == 'LegalUnit' else None
            try:
                logical = _node_values(node_type, row, penalty)
                validate_properties(logical, contract['node_properties'][node_type], contract['unit_type_values'])
                properties = encode_properties(logical, contract['node_properties'][node_type])
            except BuilderContractError as exc:
                raise MappingError(f"{row.locator['source_path']}:{row.locator['line']}: {exc}") from exc
            specs.append(dict(type=contract['namespace']+'.'+node_type,
                              id=properties.pop('id'), name=properties.pop('name'), properties=properties))
    return sorted(specs, key=lambda spec: (spec['type'].encode('utf-8'), spec['id'].encode('utf-8')))


def _relation_row(
    predicate: str, from_id: str, to_id: str, row: SourceRecord,
    properties: dict[str, Any], invariants: dict[str, Any], contract: Mapping[str, Any],
) -> dict[str, Any]:
    relation = contract['relations'][predicate]
    edge_tuple = (contract['namespace']+'.'+relation['from_type'], from_id, predicate,
                  contract['namespace']+'.'+relation['to_type'], to_id)
    return dict(tuple=edge_tuple, application_edge_key=application_edge_key(edge_tuple),
                properties=deepcopy(properties), invariants=deepcopy(invariants), locator=dict(row.locator))


def map_relation_rows(inputs: ValidatedInputs, contract: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Retain every approved source row until aggregation, including duplicates."""
    rows = []
    predicates = contract['logical_to_physical_predicates']
    for identity, row in inputs.units.items():
        parent = row.record['parent_id']
        predicate = predicates['HAS_UNIT'] if parent is None else predicates['HAS_CHILD']
        from_id = row.record['doc_id'] if parent is None else parent
        invariants = {key: row.record[key] for key in ('doc_id', 'unit_id', 'parent_id')}
        rows.append(_relation_row(predicate, from_id, identity, row,
                    {'source_record': [row.locator]}, invariants, contract))
    for identity, row in inputs.signs.items():
        invariants = {key: row.record[key] for key in ('doc_id', 'unit_id', 'sign_id')}
        rows.append(_relation_row(predicates['HAS_SIGN'], row.record['unit_id'], identity, row,
                    {'source_record': [row.locator]}, invariants, contract))
    document_predicates = {predicates[name] for name in ('CITES', 'AMENDS', 'REPEALS', 'REPLACES', 'IMPLEMENTS', 'CONSOLIDATES')}
    for row in inputs.raw.relations:
        record = row.record
        if not (record.get('from_in_corpus') is True and record.get('to_in_corpus') is True
                and record.get('from_doc_id') in inputs.documents and record.get('to_doc_id') in inputs.documents):
            continue
        predicate = record.get('rel_type')
        if predicate not in document_predicates:
            raise MappingError(f"{row.locator['source_path']}:{row.locator['line']}: invalid rel_type {predicate!r}")
        properties = {'evidence': record.get('evidence'), 'note': record.get('note'),
                      'source_record': [{'record': record, 'locator': row.locator}]}
        invariants = {key: value for key, value in record.items() if key not in ('evidence', 'note')}
        rows.append(_relation_row(predicate, record['from_doc_id'], record['to_doc_id'], row,
                                  properties, invariants, contract))
    xref = contract['xref_contract']
    for row in inputs.raw.xrefs:
        record = row.record
        fingerprint = xref_fingerprint(record)
        ledger = inputs.xref_ledger[fingerprint].record
        if ledger[xref['classification_field']] != xref['allowed_classification']:
            continue
        predicate = xref['exclusion_predicate'] if record['is_exclusion'] else xref['affirmative_predicate']
        properties = {
            'evidence_records': [dict(record, record_fingerprint=fingerprint, source_locator=row.locator)],
            'classification_provenance': [dict(ledger, artifact_name=xref['ledger_artifact_name'],
                      artifact_sha256=inputs.raw.artifact_hashes[xref['ledger_artifact_name']])],
            'source_record': [row.locator],
        }
        invariants = {key: value for key, value in record.items() if key != 'evidence'}
        rows.append(_relation_row(predicate, record['from_unit_id'], record['to_unit_id'], row,
                                  properties, invariants, contract))
    return sorted(rows, key=lambda r: (canonical_json(list(r['tuple'])).encode('utf-8'),
                                      canonical_json(r['properties']).encode('utf-8')))


def aggregate_relations(
    relation_rows: Sequence[Mapping[str, Any]], contract: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Collapse physical tuples; retain all distinct approved provenance items."""
    groups: dict[tuple[str, ...], list[Mapping[str, Any]]] = {}
    for row in relation_rows:
        edge_tuple = tuple(row['tuple'])
        key = application_edge_key(edge_tuple)
        locator = row['locator']
        context = f"{locator['source_path']}:{locator['line']} ({key})"
        if row['application_edge_key'] != key:
            raise MappingError(f'{context}: application edge key mismatch')
        predicate = edge_tuple[2]
        if predicate not in contract['relations']:
            raise MappingError(f'{context}: unknown predicate {predicate!r}')
        endpoints = contract['relations'][predicate]
        if (edge_tuple[0], edge_tuple[3]) != (contract['namespace']+'.'+endpoints['from_type'],
                                             contract['namespace']+'.'+endpoints['to_type']):
            raise MappingError(f'{context}: endpoint type mismatch')
        fields = {p['logical_name'] for p in contract['relation_properties'][predicate]}
        if row['properties'].keys() - fields:
            raise MappingError(f'{context}: undeclared relation properties')
        if not isinstance(row['properties'].get('source_record'), list) or not row['properties']['source_record']:
            raise MappingError(f'{context}: source_record must contain contributing provenance')
        groups.setdefault(edge_tuple, []).append(row)
    specs = []
    for edge_tuple in sorted(groups, key=lambda fields: canonical_json(list(fields)).encode('utf-8')):
        rows = groups[edge_tuple]
        predicate = edge_tuple[2]
        invariant_values = {canonical_json(row['invariants']) for row in rows}
        if len(invariant_values) != 1:
            locations = sorted(f"{r['locator']['source_path']}:{r['locator']['line']}" for r in rows)
            raise AggregationConflictError(f'{edge_tuple}: invariant conflict at {locations}')
        logical = {}
        for prop in contract['relation_properties'][predicate]:
            name = prop['logical_name']
            if prop['contract_type'] == 'JSON_TEXT':
                distinct = {}
                for row in rows:
                    items = row['properties'].get(name, [])
                    if not isinstance(items, list):
                        raise MappingError(f'{edge_tuple}: {name} requires provenance array')
                    for item in items:
                        distinct[canonical_json(item).encode('utf-8')] = item
                logical[name] = [deepcopy(distinct[key]) for key in sorted(distinct)]
            else:
                candidates = {canonical_json(row['properties'].get(name)) for row in rows}
                if len(candidates) != 1:
                    raise AggregationConflictError(f'{edge_tuple}: scalar conflict {name}')
                logical[name] = rows[0]['properties'].get(name)
        try:
            properties = encode_properties(logical, contract['relation_properties'][predicate])
        except BuilderContractError as exc:
            locator = rows[0]['locator']
            raise MappingError(f"{locator['source_path']}:{locator['line']}: {exc}") from exc
        specs.append(dict(tuple=edge_tuple, application_edge_key=application_edge_key(edge_tuple),
                          properties=properties))
    return specs
