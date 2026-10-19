"""Offline production preflight. Call before constructing any vectorizer/writer."""
from collections.abc import Mapping
from collections import Counter
from dataclasses import dataclass, field, replace
import hashlib
import ipaddress
import json
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
from types import SimpleNamespace
import sqlite3
import tempfile
from urllib.parse import urlsplit

from .codec import canonical_json
from .graph_plan import plan_hash
from .inputs import ARTIFACT_HASHES
from kag.vector_contract import TARGETS, valid_vector as _valid_vector


C3_IDENTITY = {
    'nodes_jsonl_sha256': '574552e8675e555f25c9627825db918b29f5362a0592b437cd23b88c2806c08e',
    'edges_jsonl_sha256': '159107dfa95ab859f0532f283a682e4064541be2578d8b0d097647f7e579d924',
    'plan_sha256': 'ebc80a11a3962e1f448cfea2db087f65135c73aadc74506a046362ac2588e365',
    'schema_sha256': '5c6c0f13b02203aad4155be3f9c6fadaee262c5379165d8717536c8bd9efaedb',
    'contract_sha256': '815cbbc7866fdc0801951e1a3e28577c1eeecf3a033fa1b476d37b90f6bfb73a',
}
ROOT = Path(__file__).resolve().parents[2]
SAMPLE_PROJECT_ID = 2
_PRODUCTION_PROOF = object()


class ProductionScopeError(ValueError):
    """Production preflight refused; no embedding or graph write is authorized."""


def _checksum(path):
    digest = hashlib.sha256()
    try:
        with Path(path).open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError:
        raise ProductionScopeError('required production file cannot be read') from None
    return digest.hexdigest()


def _input_version(path):
    path = Path(path)
    value = path.stat()
    return (str(path.resolve()), value.st_dev, value.st_ino, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


def _endpoint(value, schemes, location):
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or '').lower()
        port = parsed.port
        try:
            local = host == 'localhost' or ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = False
        if (not isinstance(value, str) or parsed.scheme not in schemes or not host or not port
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or value.strip() != value
                or (location == 'host' and not local)
                or (location == 'container' and local)):
            raise ValueError
    except (TypeError, ValueError, AttributeError):
        raise ProductionScopeError('endpoint must be explicit, credential-free and match runtime location') from None


@dataclass(frozen=True)
class ProductionSettings:
    scope: str = 'DENY'
    runtime_location: str | None = None
    host_addr: str | None = None
    neo4j_uri: str | None = None
    project_name: str | None = None
    namespace: str | None = None
    expected_project_id: int | None = None
    vector_dimensions: int | None = None
    confirmation: str | None = field(default=None, repr=False)

    def validate(self):
        if self.scope != 'PRODUCTION' or self.runtime_location not in ('host', 'container'):
            raise ProductionScopeError('explicit PRODUCTION scope and runtime location are required')
        if (not isinstance(self.project_name, str) or not self.project_name.strip()
                or self.project_name.strip() != self.project_name
                or len(self.project_name) > 255
                or not isinstance(self.namespace, str)
                or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', self.namespace)):
            raise ProductionScopeError('production project name/namespace is invalid')
        if type(self.expected_project_id) is not int or self.expected_project_id <= 0:
            raise ProductionScopeError('expected production project ID must be a positive native int')
        if type(self.vector_dimensions) is not int or not 1 <= self.vector_dimensions <= 65536:
            raise ProductionScopeError('production vector dimension must be between 1 and 65536')
        expected = (f'CONFIRM_PRODUCTION:{self.project_name}:{self.namespace}:'
                    f'{self.expected_project_id}:{C3_IDENTITY["plan_sha256"]}')
        if self.confirmation != expected:
            raise ProductionScopeError('explicit production confirmation must bind project identity and C3 plan')
        _endpoint(self.host_addr, ('http', 'https'), self.runtime_location)
        _endpoint(self.neo4j_uri, ('bolt', 'neo4j', 'bolt+s', 'neo4j+s'), self.runtime_location)


def _spec_hash(spec):
    return hashlib.sha256(canonical_json(spec).encode('utf-8')).hexdigest()


def target_contract(namespace):
    if not isinstance(namespace, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', namespace):
        raise ProductionScopeError('invalid target namespace')
    contract = json.loads((ROOT / 'kag/schema/schema_contract.json').read_bytes())
    contract['namespace'] = namespace
    contract['edge_application_key_contract']['type_qualification'] = namespace + '.<EntityType>'
    return contract


def map_spec(spec, namespace):
    """Requalify verified source types; leave corpus files and property values untouched."""
    from .mapping import application_edge_key
    if 'type' in spec:
        return dict(spec, type=namespace + '.' + spec['type'].rsplit('.', 1)[-1])
    fields = list(spec['tuple'])
    for position in (0, 3):
        fields[position] = namespace + '.' + fields[position].rsplit('.', 1)[-1]
    return dict(spec, tuple=fields, application_edge_key=application_edge_key(fields))


def selected_hashes(node_hashes, edge_hashes, selection, *, max_nodes=128, max_edges=256):
    """Restrict verified identities; legacy SAMPLE callers retain their limits."""
    try:
        if set(selection) != {'node_limit', 'node_keys', 'edge_tuples'}:
            raise ValueError
        keys = [tuple(key) for key in selection['node_keys']]
        edges = [tuple(key) for key in selection['edge_tuples']]
        chosen = set(keys)
        if (type(selection['node_limit']) is not int or not 1 <= len(keys) <= selection['node_limit'] <= max_nodes
                or len(keys) != len(chosen) or not 1 <= len(edges) <= max_edges or len(edges) != len(set(edges))
                or any(len(key) != 2 or key not in node_hashes for key in keys)
                or any(len(key) != 5 or key not in edge_hashes or key[:2] not in chosen or key[3:] not in chosen for key in edges)):
            raise ValueError
        return ({key: node_hashes[key] for key in keys}, {key: edge_hashes[key] for key in edges})
    except (KeyError, TypeError, ValueError):
        raise ProductionScopeError('bounded source selection is invalid or escapes the verified corpus') from None


def selection_limit(total, mode, value):
    """Percentages round up; never silently increase an undersized request."""
    if mode == 'ALL' and value is None:return None
    if type(value) is not int or mode not in ('COUNT','PERCENT'):
        raise ProductionScopeError('choose all, an integer count or an integer percentage')
    if mode == 'PERCENT':
        if not 1 <= value <= 100:raise ProductionScopeError('percentage must be between 1 and 100')
        value = (total*value+99)//100
    if not 3 <= value <= total:
        raise ProductionScopeError('selection must contain at least 3 nodes and cannot exceed the source')
    return value


def selection_summary(data, selection=None):
    if selection is None:
        nodes=data['manifest']['node_counts'];edges=data['manifest']['edge_unique_counts']
    else:
        nodes=Counter(key[0].rsplit('.',1)[-1] for key in selection['node_keys'])
        edges=Counter(key[2] for key in selection['edge_tuples'])
    return dict(nodes=sum(nodes.values()),edges=sum(edges.values()),node_counts=dict(sorted(nodes.items())),
        edge_counts=dict(sorted(edges.items())),excluded_edges=len(data['edge_hashes'])-sum(edges.values()))


def select_bounded_sources(data, node_limit, *, extended=False):
    """Choose short records with their documents/parents inside the requested limit."""
    maximum = len(data['node_hashes']) if extended else min(128,len(data['node_hashes']))
    if type(node_limit) is not int or not 3 <= node_limit <= maximum:
        raise ProductionScopeError('node limit must be between 3 and the permitted source count')
    nodes = {(n['type'], n['id']): n for n in data['nodes']}
    costs = {key: sum(len(n['properties'].get(prop) or '')
             for prop, _ in TARGETS[n['type'].rsplit('.', 1)[-1]]) for key,n in nodes.items()}
    edges = list(data['edge_hashes'])
    if not edges or not costs:
        raise ProductionScopeError('bounded selection requires nodes and relations')
    def sources(keys):
        pending, group = list(keys), set()
        while pending:
            key = pending.pop()
            if key in group: continue
            if key not in nodes or len(group) >= node_limit: return None
            group.add(key)
            props = nodes[key]['properties']; namespace = key[0].rsplit('.',1)[0]
            if not key[0].endswith('.LegalDocument'):
                pending.append((namespace+'.LegalDocument',props.get('docId')))
            parent = props.get('unitId') if key[0].endswith('.TrafficSign') else props.get('parentId')
            if parent: pending.append((namespace+'.LegalUnit',parent))
        return group
    groups = {key: sources((key,)) for key in nodes}
    edge_groups = {key: sources((key[:2],key[3:])) for key in edges}
    ordered = sorted((key for key in edges if edge_groups[key]),
        key=lambda key: (-len({k[0] for k in edge_groups[key]}),
                         sum(costs[k] for k in edge_groups[key]),key))
    if not ordered:
        raise ProductionScopeError('selection is too small to retain a relation and its document/parent sources')
    chosen = set(edge_groups[ordered[0]])
    for kind in sorted({key[0] for key in costs}):
        if not any(key[0] == kind for key in chosen):
            candidates = [key for key in nodes if key[0] == kind and groups[key]
                          and len(chosen | groups[key]) <= node_limit]
            if not candidates:
                raise ProductionScopeError('selection is too small to retain all source types and their document/parent sources')
            chosen.update(groups[min(candidates,key=lambda key:(sum(costs[k] for k in groups[key]-chosen),key))])
    for key in ordered:
        added = edge_groups[key] - chosen
        if len(chosen) + len(added) <= node_limit:
            chosen.update(added)
    for key in sorted(costs, key=lambda key: (costs[key], key)):
        if len(chosen) >= node_limit:
            break
        if groups[key] and len(chosen | groups[key]) <= node_limit:
            chosen.update(groups[key])
    selected_edges=[key for key in sorted(edges) if key[:2] in chosen and key[3:] in chosen]
    selection = dict(node_limit=node_limit, node_keys=sorted(chosen),edge_tuples=selected_edges if extended else selected_edges[:256])
    selected_hashes(data['node_hashes'], data['edge_hashes'], selection,
        max_nodes=maximum,max_edges=len(edges) if extended else 256)
    return selection


@dataclass(frozen=True)
class ProductionScope:
    settings: ProductionSettings
    file_checksums: tuple[tuple[Path, str], ...]
    node_hashes: Mapping
    edge_hashes: Mapping
    contract_hash: str
    _proof: object = field(repr=False, compare=False)

    @property
    def node_keys(self):
        return self.node_hashes.keys()

    def restrict(self, selection):
        nodes, edges = selected_hashes(self.node_hashes, self.edge_hashes, selection,
            max_nodes=len(self.node_hashes),max_edges=len(self.edge_hashes))
        return replace(self, node_hashes=nodes, edge_hashes=edges)

    def verify_files(self, contract):
        self.settings.validate()
        if self._proof is not _PRODUCTION_PROOF or _spec_hash(contract) != self.contract_hash:
            raise ProductionScopeError('production scope/schema contract proof differs')
        # ponytail: exact rehash per batch; optimize only with immutable input snapshots in a future runner.
        for path, expected in self.file_checksums:
            if _checksum(path) != expected:
                raise ProductionScopeError(f'{path.name}: production checksum changed after preflight')

    def validate_specs(self, nodes, edges, *, require_vectors=False, complete=False):
        node_keys, edge_keys = [], []
        for spec in nodes:
            props = dict(spec['properties'])
            targets = TARGETS.get(spec['type'].rsplit('.', 1)[-1], ())
            permitted = {vector for _, vector in targets}
            for name in list(props):
                if name.startswith('_'):
                    if name not in permitted or not _valid_vector(props[name], self.settings.vector_dimensions):
                        raise ProductionScopeError('production node contains an unauthorized or invalid vector')
                    props.pop(name)
            if require_vectors and any(spec['properties'].get(prop) and vector not in spec['properties']
                                       for prop, vector in targets):
                raise ProductionScopeError('production content requires its vector before writing')
            key = (spec['type'], spec['id'])
            if self.node_hashes.get(key) != _spec_hash(dict(spec, properties=props)):
                raise ProductionScopeError('production node payload differs from C3 golden plan')
            node_keys.append(key)
        for spec in edges:
            key = tuple(spec['tuple'])
            # SDK serializes JSON tuples as lists; canonical_json treats them identically.
            if self.edge_hashes.get(key) != _spec_hash(spec):
                raise ProductionScopeError('production edge payload differs from C3 golden plan')
            edge_keys.append(key)
        if len(set(node_keys)) != len(node_keys) or len(set(edge_keys)) != len(edge_keys):
            raise ProductionScopeError('production batches cannot contain duplicate identities')
        if complete and (set(node_keys) != set(self.node_hashes) or set(edge_keys) != set(self.edge_hashes)):
            raise ProductionScopeError('production staged plan must equal the complete C3 golden plan')


class _C3Index:
    """Run-owned (or temporary) SQLite storage; cache and counters stay bounded."""
    def __init__(self, db_path):
        self.temporary = tempfile.TemporaryDirectory(prefix='kag-c3-') if db_path is None else None
        self.path = Path(db_path) if db_path is not None else Path(self.temporary.name) / 'sources.sqlite3'
        if self.path.is_symlink() or self.path.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
            raise ProductionScopeError('C3 index must be outside the repository')
        self.db = sqlite3.connect(self.path)
        self.db.execute('PRAGMA cache_size=-2048')
        self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('''CREATE TABLE IF NOT EXISTS c3_sources (
            kind TEXT, ordinal INTEGER, key TEXT, source_hash TEXT, payload TEXT,
            from_key TEXT, to_key TEXT, PRIMARY KEY(kind,key), UNIQUE(kind,ordinal))''')
        self.counts = {}

    def seal(self):
        self.db.close()
        self.db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True)
        self.db.execute('PRAGMA cache_size=-2048')
        self.db.execute('PRAGMA temp_store=FILE')

    def close(self):
        if getattr(self, 'db', None) is not None:
            self.db.close()
            self.db = None
        if self.temporary is not None:
            self.temporary.cleanup()

    def __del__(self):
        try: self.close()
        except Exception: pass


class _DiskRecords:
    def __init__(self, index, kind):
        self.index, self.kind = index, kind

    def __len__(self):
        return self.index.counts[self.kind]

    def __iter__(self):
        for (payload,) in self.index.db.execute(
                'SELECT payload FROM c3_sources WHERE kind=? ORDER BY ordinal', (self.kind,)):
            yield json.loads(payload)


class _DiskHashes(Mapping):
    def __init__(self, index, kind):
        self.index, self.kind = index, kind

    def __len__(self):
        return self.index.counts[self.kind]

    def __iter__(self):
        for (key,) in self.index.db.execute('SELECT key FROM c3_sources WHERE kind=?', (self.kind,)):
            yield tuple(json.loads(key))

    def __getitem__(self, key):
        row = self.index.db.execute('SELECT source_hash FROM c3_sources WHERE kind=? AND key=?',
                                    (self.kind, canonical_json(key))).fetchone()
        if row is None: raise KeyError(key)
        return row[0]


def validate_c3_manifest(contract, manifest_path, *, project_root=None, db_path=None):
    """Verify C3 data only; returns no project/scope authorization or writer proof."""
    root = Path(project_root if project_root is not None else ROOT).resolve()
    path = Path(manifest_path).absolute()
    index = None
    try:
        versions = {path: _input_version(path)}
        documents_dir = root / 'data/processed/documents'
        if documents_dir.is_dir():
            versions[documents_dir] = _input_version(documents_dir)
        raw = path.read_bytes()
        manifest = json.loads(raw)
        if not isinstance(manifest, dict) or 'chosen_partition' in manifest:
            raise ProductionScopeError('production requires C3 manifest, never a sample manifest')
        for key, expected in C3_IDENTITY.items():
            if manifest.get(key) != expected:
                raise ProductionScopeError(f'C3 {key} mismatch')
        files = [(path, hashlib.sha256(raw).hexdigest())]
        schema_paths = (ROOT / 'kag/schema/VietRoadTraffic.schema', ROOT / 'kag/schema/schema_contract.json')
        for schema_path, key in zip(schema_paths, ('schema_sha256', 'contract_sha256')):
            versions[schema_path] = _input_version(schema_path)
            files.append((schema_path, C3_IDENTITY[key]))
        if json.loads(schema_paths[1].read_bytes()) != contract:
            raise ProductionScopeError('supplied schema contract differs from the approved contract')
        inputs = manifest['input_manifest']
        hashes = {}
        for row in inputs:
            name = row['name']
            if (not isinstance(name, str) or name in hashes or '\\' in name
                    or PurePosixPath(name).is_absolute() or PureWindowsPath(name).drive
                    or any(part in ('..', '.') for part in name.split('/')) or not name):
                raise ProductionScopeError('C3 input manifest has duplicate or escaping paths')
            hashes[name] = row['sha256']
            input_path = ((root / 'artifacts/inputs/xref-a3g2' / name)
                          if name in dict(ARTIFACT_HASHES) and name.startswith('xref_') else root / name)
            versions[input_path] = _input_version(input_path)
            resolved = input_path.resolve()
            if not resolved.is_relative_to(root):
                raise ProductionScopeError('production input escapes project root')
            files.append((resolved, row['sha256']))
        if any(hashes.get(name) != expected for name, expected in ARTIFACT_HASHES):
            raise ProductionScopeError('required runtime input checksum is absent or differs')
        if db_path is not None:
            target = Path(db_path).resolve()
            protected = [source for source, _ in files] + [path.parent / name
                for name in ('nodes.jsonl', 'edges.jsonl', 'plan.sha256')]
            if target in [source.resolve() for source in protected]:
                raise ProductionScopeError('C3 index overlaps protected inputs')
        index = _C3Index(db_path)
        with index.db:
            index.db.execute('DELETE FROM c3_sources')
            for name, key in (('nodes', 'nodes_jsonl_sha256'), ('edges', 'edges_jsonl_sha256')):
                record_path = path.parent / (name + '.jsonl')
                versions[record_path] = _input_version(record_path)
                files.append((record_path, C3_IDENTITY[key]))
                if _checksum(record_path) != C3_IDENTITY[key]:
                    raise ProductionScopeError(f'actual C3 {key} checksum mismatch')
                counts, total = Counter(), 0
                with record_path.open('rb') as stream:
                    for line in stream:
                        if line == b'\n': continue
                        spec = json.loads(line)
                        identity = (spec['type'], spec['id']) if name == 'nodes' else tuple(spec['tuple'])
                        if (any(not isinstance(part, str) or not part for part in identity)
                                or len(identity) != (2 if name == 'nodes' else 5)):
                            raise ProductionScopeError('invalid C3 source identity')
                        if name == 'nodes':
                            counts[spec['type'].rsplit('.', 1)[-1]] += 1
                            endpoints = (None, None)
                        else:
                            counts[identity[2]] += 1
                            endpoints = (canonical_json(identity[:2]), canonical_json(identity[3:]))
                        index.db.execute('INSERT INTO c3_sources VALUES (?,?,?,?,?,?,?)',
                            (name, total, canonical_json(identity), _spec_hash(spec), canonical_json(spec), *endpoints))
                        total += 1
                        del spec
                expected_counts = manifest['node_counts' if name == 'nodes' else 'edge_unique_counts']
                if (any(type(count) is not int or count < 0 for count in expected_counts.values())
                        or total != sum(expected_counts.values())
                        or any(counts[kind] != count for kind, count in expected_counts.items())):
                    raise ProductionScopeError('C3 manifest counts/uniqueness mismatch')
                index.counts[name] = total
            orphan = index.db.execute('''SELECT 1 FROM c3_sources e
                LEFT JOIN c3_sources f ON f.kind='nodes' AND f.key=e.from_key
                LEFT JOIN c3_sources t ON t.kind='nodes' AND t.key=e.to_key
                WHERE e.kind='edges' AND (f.key IS NULL OR t.key IS NULL) LIMIT 1''').fetchone()
            if orphan: raise ProductionScopeError('C3 edge endpoint missing')
        records = {name: _DiskRecords(index, name) for name in ('nodes', 'edges')}
        plan_path = path.parent / 'plan.sha256'
        versions[plan_path] = _input_version(plan_path)
        expected_plan_bytes = (C3_IDENTITY['plan_sha256'] + '\n').encode('ascii')
        files.append((plan_path, hashlib.sha256(expected_plan_bytes).hexdigest()))
        plan = SimpleNamespace(**records, input_manifest=inputs,
            schema_sha256=manifest['schema_sha256'], contract_sha256=manifest['contract_sha256'])
        if plan_hash(plan) != C3_IDENTITY['plan_sha256']:
            raise ProductionScopeError('recomputed semantic C3 plan hash mismatch')
        node_hashes, edge_hashes = _DiskHashes(index, 'nodes'), _DiskHashes(index, 'edges')
        for file_path, expected in files:
            if _checksum(file_path) != expected:
                raise ProductionScopeError(f'{file_path.name}: C3 checksum mismatch')
        if any(_input_version(source) != version for source, version in versions.items()):
            raise ProductionScopeError('C3 inputs changed during validation')
        index.seal()
        files.append((index.path.resolve(), _checksum(index.path)))
        return dict(records, manifest=manifest, file_checksums=tuple(files), index=index,
                    file_versions=tuple(versions.items()),
                    node_hashes=node_hashes, edge_hashes=edge_hashes,
                    contract_hash=_spec_hash(contract))
    except ProductionScopeError:
        if index is not None: index.close()
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError, sqlite3.DatabaseError):
        if index is not None: index.close()
        raise ProductionScopeError('invalid or unreadable production C3 manifest/input') from None


def validate_production_scope(settings, contract, manifest_path, *, project_root=None):
    """Grant production proof only after explicit settings and verified C3 data."""
    if not isinstance(settings, ProductionSettings):
        raise ProductionScopeError('explicit production settings are required')
    settings.validate()
    canonical = json.loads((ROOT / 'kag/schema/schema_contract.json').read_bytes())
    if contract != target_contract(settings.namespace):
        raise ProductionScopeError('target contract differs from the supplied LuatGT schema')
    data = validate_c3_manifest(canonical, manifest_path, project_root=project_root)
    index = data['index']
    if settings.namespace != canonical['namespace']:
        index.db.close()
        index.db = sqlite3.connect(index.path)
        with index.db:
            for kind in ('nodes', 'edges'):
                rows = index.db.execute('SELECT ordinal,payload FROM c3_sources WHERE kind=? ORDER BY ordinal', (kind,))
                for ordinal, payload in rows:
                    spec = map_spec(json.loads(payload), settings.namespace)
                    key = (spec['type'], spec['id']) if kind == 'nodes' else tuple(spec['tuple'])
                    endpoints = (None, None) if kind == 'nodes' else (canonical_json(key[:2]), canonical_json(key[3:]))
                    index.db.execute('UPDATE c3_sources SET key=?,source_hash=?,payload=?,from_key=?,to_key=? WHERE kind=? AND ordinal=?',
                        (canonical_json(key), _spec_hash(spec), canonical_json(spec), *endpoints, kind, ordinal))
        index.seal()
        data['file_checksums'] = tuple((path, _checksum(path) if path == index.path.resolve() else digest)
            for path, digest in data['file_checksums'])
    scope = ProductionScope(settings, data['file_checksums'], data['node_hashes'],
                            data['edge_hashes'], _spec_hash(contract), _PRODUCTION_PROOF)
    scope.verify_files(contract)
    return scope
