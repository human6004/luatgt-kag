"""Deterministic offline graph plan built from the C2 transformations."""
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
import hashlib
import json
import math
import ntpath
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import statistics
from typing import Any

from .codec import BuilderContractError, canonical_json, decode_properties
from .inputs import BuilderInputs, ValidatedInputs, validate_input_integrity
from .mapping import (aggregate_relations, application_edge_key, map_nodes,
                      map_relation_rows)


class GraphPlanError(ValueError):
    """An invalid or non-deterministic graph plan cannot be written."""


@dataclass(frozen=True)
class GraphPlan:
    nodes: tuple[dict[str, Any], ...]
    edges: tuple[dict[str, Any], ...]
    input_manifest: tuple[dict[str, str], ...]
    schema_sha256: str
    contract_sha256: str
    node_counts: dict[str, int]
    edge_source_counts: dict[str, int]
    edge_unique_counts: dict[str, int]
    collapsed_counts: dict[str, int]
    validation: dict[str, Any]


_RUNTIME_VECTOR = re.compile(r'^_[a-z0-9]+(?:_[a-z0-9]+)*_(?:vector|sparse)$')
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_SOURCE_COLLECTIONS = ('documents', 'units', 'penalties', 'signs', 'relations', 'xrefs')


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _contract_hashes(contract: Mapping[str, Any]) -> tuple[str, str]:
    schema_path = _PROJECT_ROOT / 'kag/schema/VietRoadTraffic.schema'
    contract_path = _PROJECT_ROOT / 'kag/schema/schema_contract.json'
    try:
        contract_bytes = contract_path.read_bytes()
        schema_sha = _file_sha256(schema_path)
        disk_contract = json.loads(contract_bytes)
    except (OSError, json.JSONDecodeError) as exc:
        raise GraphPlanError(f'cannot read current schema contract: {exc}') from exc
    if disk_contract != contract:
        raise GraphPlanError('provided contract differs from kag/schema/schema_contract.json')
    if contract.get('runtime_contract', {}).get('schema_sha256') != schema_sha:
        raise GraphPlanError('schema contract SHA does not match VietRoadTraffic.schema')
    return schema_sha, hashlib.sha256(contract_bytes).hexdigest()


def _logical_name(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise GraphPlanError('input manifest name must be non-empty Text')
    name = value.replace('\\', '/')
    if (PurePosixPath(name).is_absolute() or PureWindowsPath(name).is_absolute()
            or '..' in PurePosixPath(name).parts):
        raise GraphPlanError(f'absolute or escaping input manifest name: {value!r}')
    return name


def _input_manifest(inputs: ValidatedInputs, project_root: Path) -> tuple[dict[str, str], ...]:
    hashes: dict[str, str] = {}

    def add(name: str, digest: str) -> None:
        name = _logical_name(name)
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise GraphPlanError(f'{name}: invalid input SHA256')
        if name in hashes and hashes[name] != digest:
            raise GraphPlanError(f'{name}: inconsistent input SHA256 values')
        hashes[name] = digest

    for family in _SOURCE_COLLECTIONS:
        for row in getattr(inputs.raw, family):
            add(row.locator.get('source_path'), row.locator.get('file_sha256'))
    for name, digest in inputs.raw.source_hashes.items():
        add(name, digest)

    for relative in inputs.raw.markdown_paths:
        name = _logical_name(relative)
        path = project_root.joinpath(*PurePosixPath(name).parts)
        if not path.is_file():
            raise GraphPlanError(f'{name}: source Markdown file is missing')
        add(name, _file_sha256(path))

    return tuple({'name': name, 'sha256': hashes[name]}
                 for name in sorted(hashes, key=lambda item: item.encode('utf-8')))


def _node_sort_key(node: Mapping[str, Any]) -> tuple[bytes, bytes]:
    return node['type'].encode('utf-8'), node['id'].encode('utf-8')


def _edge_sort_key(edge: Mapping[str, Any]) -> tuple[bytes, ...]:
    return tuple(part.encode('utf-8') for part in edge['tuple'])


def _validate_text_preservation(
    inputs: ValidatedInputs, nodes: Sequence[Mapping[str, Any]], contract: Mapping[str, Any],
) -> None:
    legal_units = {node['id']: node for node in nodes
                   if node['type'] == contract['namespace'] + '.LegalUnit'}
    if legal_units.keys() != inputs.units.keys():
        raise GraphPlanError('LegalUnit source identities differ from the node plan')
    for identity, source in inputs.units.items():
        if legal_units[identity]['properties'].get('text') != source.record.get('text'):
            raise GraphPlanError(f'LegalUnit {identity}: text differs from exact source value')


def _walk(value: Any):
    if isinstance(value, Mapping):
        for key, item in value.items():
            yield key
            yield from _walk(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _walk(item)
    elif isinstance(value, str):
        yield value


def _is_absolute_path(value: str) -> bool:
    if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', value):
        return False
    return (ntpath.isabs(value) or PureWindowsPath(value).is_absolute()
            or PurePosixPath(value).is_absolute())


def _audit_aggregation(
    source_rows: Sequence[Mapping[str, Any]],
    edges: Sequence[Mapping[str, Any]],
    contract: Mapping[str, Any],
) -> dict[str, int]:
    """Independently check every collapsed group against C2's aggregated output."""
    groups: dict[tuple[str, ...], list[Mapping[str, Any]]] = {}
    for row in source_rows:
        groups.setdefault(tuple(row['tuple']), []).append(row)
    final = {tuple(edge['tuple']): edge for edge in edges}
    if len(final) != len(edges) or final.keys() != groups.keys():
        raise GraphPlanError('source tuple groups and unique aggregated edges differ')

    conflicts = dropped_provenance = 0
    for edge_tuple, rows in groups.items():
        if len(rows) < 2:
            continue
        edge = final[edge_tuple]
        predicate = edge_tuple[2]
        relation = contract['relations'][predicate]
        expected_types = (contract['namespace'] + '.' + relation['from_type'],
                          contract['namespace'] + '.' + relation['to_type'])
        if (edge_tuple[0], edge_tuple[3]) != expected_types:
            conflicts += 1
        if len({canonical_json(row['invariants']) for row in rows}) != 1:
            conflicts += 1
        if len({row.get('application_edge_key') for row in rows}) != 1:
            conflicts += 1
        try:
            logical = decode_properties(edge['properties'], contract['relation_properties'][predicate])
        except BuilderContractError as exc:
            raise GraphPlanError(f'collapsed edge {edge_tuple!r}: {exc}') from exc

        for prop in contract['relation_properties'][predicate]:
            name = prop['logical_name']
            if not prop['required'] and not any(name in row['properties'] for row in rows):
                continue
            values = [row['properties'].get(name) for row in rows]
            if prop['contract_type'] == 'JSON_TEXT':
                expected_items: dict[bytes, Any] = {}
                for value in values:
                    if not isinstance(value, list):
                        conflicts += 1
                        continue
                    for item in value:
                        expected_items[canonical_json(item).encode('utf-8')] = item
                expected = [expected_items[key] for key in sorted(expected_items)]
                if canonical_json(logical.get(name)) != canonical_json(expected):
                    dropped_provenance += 1
            else:
                if len({canonical_json(value) for value in values}) != 1:
                    conflicts += 1
                if canonical_json(logical.get(name)) != canonical_json(values[0]):
                    conflicts += 1

        xref = contract['xref_contract']
        if predicate in (xref['affirmative_predicate'], xref['exclusion_predicate']):
            for row in rows:
                polarity = row['invariants'].get('is_exclusion')
                expected_predicate = (xref['exclusion_predicate'] if polarity is True
                                      else xref['affirmative_predicate'])
                if type(polarity) is not bool or predicate != expected_predicate:
                    conflicts += 1
                if row['invariants'].get('downstream_use') != 'SAFE_EDGE':
                    conflicts += 1

    if conflicts:
        raise GraphPlanError(f'collapsed semantic conflict groups or rows: {conflicts}')
    if dropped_provenance:
        raise GraphPlanError(f'collapsed provenance arrays lost source evidence: {dropped_provenance}')
    return {
        'collapsed_rows': sum(len(rows) - 1 for rows in groups.values()),
        'collapsed_groups': sum(len(rows) > 1 for rows in groups.values()),
        'semantic_conflicts': conflicts,
        'dropped_provenance_items': dropped_provenance,
    }


def _validate_plan(plan: GraphPlan, contract: Mapping[str, Any]) -> dict[str, Any]:
    node_keys = [(node.get('type'), node.get('id')) for node in plan.nodes]
    if len(set(node_keys)) != len(node_keys):
        raise GraphPlanError('duplicate (type, id) node identity')
    if list(plan.nodes) != sorted(plan.nodes, key=_node_sort_key):
        raise GraphPlanError('nodes are not in canonical UTF-8 order')

    node_counts = Counter(node['type'].rsplit('.', 1)[-1] for node in plan.nodes)
    if dict(node_counts) != plan.node_counts:
        raise GraphPlanError('node_counts do not match node plan')
    known_types = {contract['namespace'] + '.' + kind for kind in contract['node_types']}
    integer_count = json_text_count = double_encoding_count = 0
    vector_count = node_provenance_missing = 0
    for node in plan.nodes:
        if node.get('type') not in known_types:
            raise GraphPlanError(f"unknown node type {node.get('type')!r}")
        if not all(isinstance(node.get(field), str) and node[field].strip()
                   for field in ('id', 'name')) or node['id'] != node['name']:
            raise GraphPlanError('node id/name must be the same nonblank exact Text')
        props = node.get('properties')
        if not isinstance(props, dict):
            raise GraphPlanError('node properties must be an object')
        vector_count += sum(1 for key in props if _RUNTIME_VECTOR.fullmatch(key))
        physical = dict(props, id=node['id'], name=node['name'])
        kind = node['type'].rsplit('.', 1)[-1]
        properties = contract['node_properties'][kind]
        try:
            logical = decode_properties(physical, properties, server_encoded=False)
        except BuilderContractError as exc:
            raise GraphPlanError(f"node {node['type']}:{node['id']}: {exc}") from exc
        if not isinstance(logical.get('source_record'), dict):
            node_provenance_missing += 1
        for prop in properties:
            name = prop['schema_name']
            if name not in physical:
                continue
            value = physical[name]
            if prop['contract_type'] in ('INTEGER', 'OPTIONAL_INTEGER'):
                integer_count += 1
                if type(value) is not int:
                    raise GraphPlanError(f"node {node['id']}:{name}: expected native int")
            if prop['contract_type'] == 'JSON_TEXT':
                json_text_count += 1
                if isinstance(logical.get(prop['logical_name']), str):
                    double_encoding_count += 1

    edge_tuples = [tuple(edge.get('tuple', ())) for edge in plan.edges]
    if len(set(edge_tuples)) != len(edge_tuples):
        raise GraphPlanError('duplicate final physical edge tuple')
    if list(plan.edges) != sorted(plan.edges, key=_edge_sort_key):
        raise GraphPlanError('edges are not in canonical UTF-8 tuple order')
    if sum(plan.edge_unique_counts.values()) != len(plan.edges):
        raise GraphPlanError('edge_unique_counts do not match final edges')
    unique_counts = Counter(edge['tuple'][2] for edge in plan.edges)
    if {name: unique_counts[name] for name in plan.edge_unique_counts} != plan.edge_unique_counts:
        raise GraphPlanError('edge_unique_counts do not match predicates')
    source_total = sum(plan.edge_source_counts.values())
    if source_total - len(plan.edges) != plan.collapsed_counts.get('rows'):
        raise GraphPlanError('collapsed row count does not match source and unique edges')

    node_key_set = set(node_keys)
    edge_keys: dict[str, tuple[str, ...]] = {}
    missing_from = missing_to = edge_provenance_missing = 0
    for edge in plan.edges:
        edge_tuple = edge.get('tuple')
        if (not isinstance(edge_tuple, (list, tuple)) or len(edge_tuple) != 5
                or any(not isinstance(part, str) for part in edge_tuple)):
            raise GraphPlanError('edge tuple must contain five Text fields')
        edge_tuple = tuple(edge_tuple)
        key = application_edge_key(edge_tuple)
        if edge.get('application_edge_key') != key:
            raise GraphPlanError(f'edge key mismatch for {edge_tuple!r}')
        if key in edge_keys and edge_keys[key] != edge_tuple:
            raise GraphPlanError('application edge key collision across physical tuples')
        edge_keys[key] = edge_tuple
        if (edge_tuple[0], edge_tuple[1]) not in node_key_set:
            missing_from += 1
        if (edge_tuple[3], edge_tuple[4]) not in node_key_set:
            missing_to += 1
        predicate = edge_tuple[2]
        if predicate not in contract['relations']:
            raise GraphPlanError(f'unknown relation predicate {predicate!r}')
        relation = contract['relations'][predicate]
        if (edge_tuple[0] != contract['namespace'] + '.' + relation['from_type']
                or edge_tuple[3] != contract['namespace'] + '.' + relation['to_type']):
            raise GraphPlanError(f'edge endpoint types do not match relation {predicate!r}')
        declared = {p['logical_name']: p for p in contract['relation_properties'][predicate]}
        source_prop = declared.get('source_record')
        raw_props = edge.get('properties')
        if not isinstance(raw_props, dict):
            raise GraphPlanError('edge properties must be an object')
        vector_count += sum(1 for prop in raw_props if _RUNTIME_VECTOR.fullmatch(prop))
        try:
            logical = decode_properties(raw_props, contract['relation_properties'][predicate])
        except BuilderContractError as exc:
            raise GraphPlanError(f'edge {edge_tuple!r}: {exc}') from exc
        source_records = logical.get('source_record')
        if source_prop is None or not isinstance(source_records, list) or not source_records:
            edge_provenance_missing += 1
        for prop in contract['relation_properties'][predicate]:
            physical_name = prop['schema_name']
            if physical_name not in raw_props:
                continue
            value = raw_props[physical_name]
            if prop['contract_type'] in ('INTEGER', 'OPTIONAL_INTEGER'):
                integer_count += 1
                if type(value) is not int:
                    raise GraphPlanError(f'edge {edge_tuple!r}:{physical_name}: expected native int')
            if prop['contract_type'] == 'JSON_TEXT':
                json_text_count += 1
                if isinstance(logical.get(prop['logical_name']), str):
                    double_encoding_count += 1

    if missing_from or missing_to:
        raise GraphPlanError(f'edge endpoint missing: from={missing_from}, to={missing_to}')
    if node_provenance_missing or edge_provenance_missing:
        raise GraphPlanError('node or edge is missing required source provenance')
    if vector_count:
        raise GraphPlanError(f'runtime vector properties found: {vector_count}')
    if double_encoding_count:
        raise GraphPlanError(f'JSON_TEXT double-encoding anomalies: {double_encoding_count}')

    payload = _hash_payload(plan)
    absolute_paths = sum(1 for value in _walk(payload)
                         if isinstance(value, str) and _is_absolute_path(value))
    if absolute_paths:
        raise GraphPlanError(f'absolute paths found in plan: {absolute_paths}')
    if tuple(plan.input_manifest) != tuple(sorted(
            plan.input_manifest, key=lambda item: item['name'].encode('utf-8'))):
        raise GraphPlanError('input manifest is not in canonical UTF-8 order')

    max_text = None
    for node in plan.nodes:
        if node['type'] == contract['namespace'] + '.LegalUnit':
            text_value = node['properties'].get('text')
            if not isinstance(text_value, str):
                raise GraphPlanError(f"LegalUnit {node['id']}: text missing or not Text")
            candidate = {'id': node['id'], 'chars': len(text_value),
                         'utf8_bytes': len(text_value.encode('utf-8')),
                         'sha256': hashlib.sha256(text_value.encode('utf-8')).hexdigest()}
            if max_text is None or candidate['chars'] > max_text['chars']:
                max_text = candidate

    return {
        'missing_from_endpoints': missing_from,
        'missing_to_endpoints': missing_to,
        'duplicate_node_keys': 0,
        'duplicate_edge_tuples': 0,
        'duplicate_edge_key_collisions': 0,
        'edge_key_mismatches': 0,
        'integer_property_value_count': integer_count,
        'invalid_integer_count': 0,
        'json_text_property_count': json_text_count,
        'json_text_decode_errors': 0,
        'double_encoding_anomalies': double_encoding_count,
        'runtime_vector_value_count': vector_count,
        'absolute_path_contamination_count': absolute_paths,
        'nodes_missing_provenance': node_provenance_missing,
        'edges_missing_provenance': edge_provenance_missing,
        'semantic_conflicts': 0,
        'max_legal_unit_text': max_text,
    }


def build_graph_plan(
    inputs: ValidatedInputs | BuilderInputs,
    contract: Mapping[str, Any],
    *,
    project_root: str | Path | None = None,
) -> GraphPlan:
    """Map, aggregate, validate, and sort the complete offline graph plan."""
    if isinstance(inputs, BuilderInputs):
        inputs = validate_input_integrity(inputs, contract)
    if not isinstance(inputs, ValidatedInputs):
        raise GraphPlanError('inputs must be BuilderInputs or ValidatedInputs')
    root = Path(project_root) if project_root is not None else _PROJECT_ROOT
    schema_sha, contract_sha = _contract_hashes(contract)
    manifest = _input_manifest(inputs, root)
    mapped_nodes = map_nodes(inputs, contract)
    _validate_text_preservation(inputs, mapped_nodes, contract)
    nodes = tuple(sorted(mapped_nodes, key=_node_sort_key))
    source_rows = map_relation_rows(inputs, contract)
    edges_list = aggregate_relations(source_rows, contract)
    aggregation = _audit_aggregation(source_rows, edges_list, contract)
    edges = tuple(sorted(edges_list, key=_edge_sort_key))
    node_counts = dict(sorted(Counter(node['type'].rsplit('.', 1)[-1] for node in nodes).items()))
    predicates = set(contract['relations'])
    source_counts = Counter(row['tuple'][2] for row in source_rows)
    unique_counts = Counter(edge['tuple'][2] for edge in edges)
    edge_source_counts = {name: source_counts[name] for name in sorted(predicates)}
    edge_unique_counts = {name: unique_counts[name] for name in sorted(predicates)}
    collapsed_counts = {
        'rows': aggregation['collapsed_rows'],
        'groups': aggregation['collapsed_groups'],
    }
    if collapsed_counts['rows'] != len(source_rows) - len(edges):
        raise GraphPlanError('aggregation audit row count is inconsistent')
    plan = GraphPlan(nodes, edges, manifest, schema_sha, contract_sha, node_counts,
                     edge_source_counts, edge_unique_counts, collapsed_counts, {})
    validation = _validate_plan(plan, contract)
    validation.update(aggregation)
    return replace(plan, validation=validation)


def _hash_payload(plan: GraphPlan) -> dict[str, Any]:
    """Return only semantic fields covered by the C3 SHA256 contract."""
    return {
        'schema_sha256': plan.schema_sha256,
        'contract_sha256': plan.contract_sha256,
        'inputs': list(plan.input_manifest),
        'nodes': list(plan.nodes),
        'edges': list(plan.edges),
    }


def plan_hash(plan: GraphPlan) -> str:
    """Hash the same canonical semantic object, consuming source iterables once."""
    digest = hashlib.sha256()
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    fields = {'schema_sha256': plan.schema_sha256, 'contract_sha256': plan.contract_sha256,
              'inputs': plan.input_manifest, 'nodes': plan.nodes, 'edges': plan.edges}
    digest.update(b'{')
    for ordinal, name in enumerate(sorted(fields)):
        if ordinal: digest.update(b',')
        digest.update((encoder.encode(name) + ':').encode('utf-8'))
        if name in ('inputs', 'nodes', 'edges'):
            digest.update(b'[')
            for position, record in enumerate(fields[name]):
                if position: digest.update(b',')
                for chunk in encoder.iterencode(record): digest.update(chunk.encode('utf-8'))
            digest.update(b']')
        else:
            digest.update(encoder.encode(fields[name]).encode('utf-8'))
    digest.update(b'}')
    return digest.hexdigest()


def _write_jsonl(path: Path, records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    digest = hashlib.sha256()
    size = count = 0
    with path.open('wb') as stream:
        for record in records:
            line = (canonical_json(record) + '\n').encode('utf-8')
            stream.write(line)
            digest.update(line)
            size += len(line)
            count += 1
    return {'record_count': count, 'bytes': size, 'sha256': digest.hexdigest()}


def write_dry_run(plan: GraphPlan, output_dir: str | Path) -> dict[str, Any]:
    """Write one compact UTF-8/LF artifact set; output paths never enter its hash."""
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    nodes = _write_jsonl(output / 'nodes.jsonl', plan.nodes)
    edges = _write_jsonl(output / 'edges.jsonl', plan.edges)
    plan_sha = plan_hash(plan)
    manifest = {
        'schema_sha256': plan.schema_sha256,
        'contract_sha256': plan.contract_sha256,
        'input_manifest': list(plan.input_manifest),
        'node_counts': plan.node_counts,
        'edge_source_counts': plan.edge_source_counts,
        'edge_unique_counts': plan.edge_unique_counts,
        'collapsed_counts': plan.collapsed_counts,
        'semantic_conflicts': plan.validation.get('semantic_conflicts', 0),
        'nodes_jsonl_sha256': nodes['sha256'],
        'edges_jsonl_sha256': edges['sha256'],
        'plan_sha256': plan_sha,
    }
    (output / 'manifest.json').write_bytes((canonical_json(manifest) + '\n').encode('utf-8'))
    (output / 'plan.sha256').write_bytes((plan_sha + '\n').encode('ascii'))
    return {'manifest': manifest, 'nodes': nodes, 'edges': edges}


def vector_input_length_stats(plan: GraphPlan, contract: Mapping[str, Any]) -> dict[str, Any]:
    """Measure approved content fields offline; lengths are Unicode characters."""
    targets = (('LegalDocument', 'title', 'title'), ('LegalUnit', 'text', 'text'),
               ('TrafficSign', 'ten', 'ten'), ('TrafficSign', 'mo_ta', 'moTa'))
    result = {}
    for node_type, logical_name, display_name in targets:
        prop = next(item for item in contract['node_properties'][node_type]
                    if item['logical_name'] == logical_name)
        physical_name = prop['schema_name']
        nodes = [node for node in plan.nodes
                 if node['type'] == contract['namespace'] + '.' + node_type]
        values = [node['properties'][physical_name] for node in nodes
                  if physical_name in node['properties']]
        lengths = sorted(len(value) for value in values)
        nonempty = [value for value in values if value]
        duplicates = Counter(nonempty)

        def percentile(p: float) -> int | None:
            if not lengths:
                return None
            return lengths[max(0, math.ceil(p * len(lengths)) - 1)]

        present_nodes = [node for node in nodes if physical_name in node['properties']]
        max_chars_node = max(present_nodes,
                             key=lambda node: len(node['properties'][physical_name]), default=None)
        max_bytes_node = max(present_nodes,
                             key=lambda node: len(node['properties'][physical_name].encode('utf-8')),
                             default=None)
        max_chars_value = (max_chars_node['properties'][physical_name]
                           if max_chars_node is not None else None)
        max_bytes_value = (max_bytes_node['properties'][physical_name]
                           if max_bytes_node is not None else None)
        result[f'{node_type}.{display_name}'] = {
            'total_nodes': len(nodes),
            'present': len(values),
            'missing': len(nodes) - len(values),
            'explicit_empty': sum(value == '' for value in values),
            'nonempty': len(nonempty),
            'min_chars': min(lengths) if lengths else None,
            'median_chars': statistics.median(lengths) if lengths else None,
            'p90_chars': percentile(0.90),
            'p95_chars': percentile(0.95),
            'p99_chars': percentile(0.99),
            'max_chars': len(max_chars_value) if max_chars_value is not None else None,
            'max_chars_id': max_chars_node['id'] if max_chars_node is not None else None,
            'max_utf8_bytes': len(max_bytes_value.encode('utf-8')) if max_bytes_value is not None else None,
            'max_utf8_bytes_id': max_bytes_node['id'] if max_bytes_node is not None else None,
            'duplicate_nonempty_groups': sum(count > 1 for count in duplicates.values()),
            'duplicate_nonempty_extra_rows': sum(count - 1 for count in duplicates.values()),
            'percentile_method': 'nearest_rank',
        }
    return result
