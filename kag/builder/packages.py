"""Portable vector archives; import adapts files to the existing Runner replay contract."""
from contextlib import contextmanager
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import uuid
import zipfile

from kag.builder.codec import canonical_json
from kag.builder.production_scope import _checksum as checksum, _input_version, map_spec
from kag.vector_contract import TARGETS, valid_vector

FORMAT = 'luatgt-vector-package-v1'
FILES = {'manifest.json', 'vectorized_nodes.jsonl', 'provenance.jsonl'}
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.zip')
HASH = re.compile(r'[0-9a-f]{64}')
MAX_LINE = 16 * 1024**2
JOB_FIELDS = ('node_type','node_id','property','source_sha256','source_chars','source_bytes',
              'model_identity','dimension','status','embedding_method')
FALLBACK_FIELDS = ('node_type','node_id','property','source_sha256','source_chars','model_identity','dimension',
    'max_chunk_chars','overlap_chars','min_chunk_chars','max_split_depth','chunking_version','chunk_count',
    'successful_chunks','failed_chunks','aggregation','normalization','aggregation_result')
CHUNK_FIELDS = ('start_offset','end_offset','chunk_sha256','chunk_chars','status','effective_weight')
CONFIG_FIELDS = ('enabled','max_chunk_chars','overlap_chars','min_chunk_chars','max_split_depth','chunking_version')


class PackageError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _safe(path):
    path = Path(path)
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise PackageError('PACKAGE_PATH')
    return path


def directory():
    return _safe(Path(os.environ.get('KAG_GRAPH_PACKAGES_DIR', '/graph-packages')))


def host_directory():
    return os.environ.get('KAG_GRAPH_PACKAGES_HOST_DIR', 'graph-packages')


def package_path(name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise PackageError('PACKAGE_NAME')
    return _safe(directory() / name)


def current_model(model):
    if (not model or not model.get('test') or model['test'].get('status') != 'PASS'
            or type(model['test'].get('dimension')) is not int):
        return None
    return dict(provider=model['config']['provider'], model=model['config']['model'], dimension=model['test']['dimension'])


def unpacked_limit(manifest):
    # JSON numbers and legal text vary; bound by declared workload, then cap hostile counts.
    return min(32 * 1024**3, MAX_LINE + manifest['nodes'] * 131072
               + manifest['vectors'] * (manifest['model_identity']['dimension'] * 40 + 65536))


def _manifest(value):
    fields = {'format_version','plan_sha256','selection','model_identity','nodes','edges','vectors',
              'fingerprint','application_version'}
    if (type(value) is not dict or set(value) != fields or value['format_version'] != FORMAT
            or any(not isinstance(value[k],str) or not HASH.fullmatch(value[k]) for k in ('plan_sha256','fingerprint'))
            or any(type(value[k]) is not int or not 0 <= value[k] <= 2147483647 for k in ('nodes','edges','vectors'))
            or value['nodes'] < 1 or not 0 < value['vectors'] <= value['nodes'] * 2
            or not isinstance(value['application_version'],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}',value['application_version'])):
        raise PackageError('PACKAGE_MANIFEST')
    identity = value['model_identity']
    if (type(identity) is not dict or set(identity) != {'provider','model','dimension'}
            or identity['provider'] != 'openai-compatible' or not isinstance(identity['model'],str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}',identity['model']) or type(identity['dimension']) is not int
            or not 1 <= identity['dimension'] <= 65536):
        raise PackageError('PACKAGE_MANIFEST')
    selection = value['selection']
    if selection is not None and (type(selection) is not dict or set(selection) != {'mode','value'}
            or selection['mode'] != 'COUNT' or type(selection['value']) is not int or selection['value'] != value['nodes']):
        raise PackageError('PACKAGE_MANIFEST')
    return value


@contextmanager
def _archive(path):
    path = _safe(path)
    try:
        version = _input_version(path)
        before = path.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > 32 * 1024**3:
            raise PackageError('PACKAGE_SIZE')
        with path.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise PackageError('PACKAGE_CHANGED')
            # ZipFile reads the entire central directory before exposing entries.
            end = zipfile._EndRecData(stream)
            if end is None or end[zipfile._ECD_ENTRIES_TOTAL] != len(FILES) or end[zipfile._ECD_SIZE] > 65536:
                raise PackageError('PACKAGE_FILES')
            with zipfile.ZipFile(stream) as archive:
                entries = archive.infolist()
                if len(entries) != len(FILES) or {i.filename for i in entries} != FILES:
                    raise PackageError('PACKAGE_FILES')
                for entry in entries:
                    mode = entry.external_attr >> 16
                    if (entry.flag_bits & 1 or entry.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                            or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                        raise PackageError('PACKAGE_FILES')
                if archive.getinfo('manifest.json').file_size > 65536:
                    raise PackageError('PACKAGE_SIZE')
                with archive.open('manifest.json') as source:
                    raw = source.read(65537)
                if len(raw) > 65536:raise PackageError('PACKAGE_SIZE')
                manifest = _manifest(json.loads(raw))
                if sum(i.file_size for i in entries) > unpacked_limit(manifest):
                    raise PackageError('PACKAGE_SIZE')
                yield archive, manifest
            if _input_version(path) != version:raise PackageError('PACKAGE_CHANGED')
    except PackageError:raise
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise PackageError('PACKAGE_INVALID') from None


def read_manifest(path):
    with _archive(path) as (_, manifest):
        return manifest


@lru_cache(maxsize=256)
def _digest(path, version):
    digest = checksum(path)
    if _input_version(path) != version:raise PackageError('PACKAGE_CHANGED')
    return digest


def compatible(manifest, model, plan_sha256):
    if plan_sha256 is None:raise PackageError('PACKAGE_SOURCE')
    if plan_sha256 != manifest['plan_sha256']:raise PackageError('PACKAGE_PLAN')
    if current_model(model) != manifest['model_identity']:raise PackageError('PACKAGE_MODEL')


def catalog(model, plan_sha256):
    rows = []
    root = directory()
    if root.exists():
        for path in sorted(root.glob('*.zip'))[:256]:
            row = dict(name=path.name, sha256=None, size=0, compatible=False, reason='PACKAGE_INVALID', manifest=None)
            try:
                package_path(path.name)
                version = _input_version(path)
                row['size'] = path.lstat().st_size
                row['manifest'] = read_manifest(path)
                compatible(row['manifest'], model, plan_sha256)
                digest = _digest(path,version)
                if _input_version(path) != version:raise PackageError('PACKAGE_CHANGED')
                row.update(sha256=digest, compatible=True, reason='PACKAGE_READY')
            except PackageError as error:row['reason'] = error.code
            except OSError:row['reason'] = 'PACKAGE_UNAVAILABLE'
            rows.append(row)
    return dict(contract_version='builder-packages-v1', directory=host_directory(),
                current_model=current_model(model), packages=rows)


def _jsonl(source, budget):
    while True:
        line = source.readline(MAX_LINE + 1)
        if not line:break
        budget[0] -= len(line)
        if len(line) > MAX_LINE or budget[0] < 0:raise PackageError('PACKAGE_SIZE')
        if not line.strip():raise PackageError('PACKAGE_INVALID')
        value = json.loads(line)
        if type(value) is not dict:raise PackageError('PACKAGE_INVALID')
        yield value


def _job(record, old_identity, new_identity, namespace):
    if record.get('model_identity') != old_identity:raise PackageError('PACKAGE_MODEL')
    result = {key:record[key] for key in JOB_FIELDS}
    result.update(node_type=namespace+'.'+record['node_type'].rsplit('.',1)[-1], model_identity=new_identity,attempts=[])
    if 'fallback' in record:
        fallback = record['fallback']
        if (fallback.get('model_identity') != old_identity or fallback.get('node_type') != record['node_type']
                or record['direct_failure'].get('node_type') != record['node_type']):
            raise PackageError('PACKAGE_MODEL')
        result['fallback'] = {key:fallback[key] for key in FALLBACK_FIELDS}
        result['fallback'].update(node_type=result['node_type'], model_identity=new_identity,
            chunks=[{key:chunk[key] for key in CHUNK_FIELDS} for chunk in fallback['chunks']])
        result['fallback_config'] = {key:record['fallback_config'][key] for key in CONFIG_FIELDS}
        result['direct_failure'] = _job(record['direct_failure'],old_identity,new_identity,namespace)
    return result


def export_package(path, receipt, model, root, *, application_version):
    """The caller checks ownership; recheck run artifact hashes before publishing any archive."""
    path, root = _safe(path), _safe(root)
    identity, result = receipt['identity'], receipt['stages']['verify']
    portable = current_model(model)
    expected = model['config']['base_url'].rstrip('/')+'|'+model['config']['model']
    if not portable or identity['model_identity'] != expected or identity['dimension'] != portable['dimension']:
        raise PackageError('PACKAGE_MODEL')
    exported = receipt['stages']['export-artifact']
    versions = []
    for key, filename in (('nodes','vectorized_nodes.jsonl'),('jobs','provenance.jsonl')):
        artifact = _safe(path / filename)
        if exported[key]['file'] != filename or checksum(artifact) != exported[key]['sha256']:
            raise PackageError('PACKAGE_INTEGRITY')
        versions.append((artifact, _input_version(artifact)))
    manifest = _manifest(dict(format_version=FORMAT, plan_sha256=identity['c3']['plan_sha256'],
        selection=dict(mode='COUNT',value=result['nodes']['total']) if 'selection' in identity['input_hashes'] else None,
        model_identity=portable, nodes=result['nodes']['total'], edges=result['edges']['total'],
        vectors=result['vectors']['nonempty'], fingerprint=result['fingerprint'], application_version=application_version))
    root.mkdir(parents=True, exist_ok=True)
    name = 'graph-'+uuid.uuid4().hex+'.zip'
    with tempfile.TemporaryDirectory(prefix='.export-', dir=root) as temporary:
        output = Path(temporary) / name
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as archive:
            archive.writestr('manifest.json',canonical_json(manifest))
            budget = [unpacked_limit(manifest)]
            for filename in ('vectorized_nodes.jsonl','provenance.jsonl'):
                with (path/filename).open('rb') as source, archive.open(filename,'w',force_zip64=True) as target:
                    for record in _jsonl(source,budget):
                        value = (map_spec({key:record[key] for key in ('type','id','name','properties')},'VietRoadTraffic')
                                 if filename.startswith('vectorized') else _job(record,expected,portable,'VietRoadTraffic'))
                        target.write((canonical_json(value)+'\n').encode())
        if any(_input_version(p)!=v for p,v in versions):raise PackageError('PACKAGE_CHANGED')
        output.rename(root/name)
    return dict(name=name,size=(root/name).stat().st_size)


def prepare_package(path, destination, *, model, plan_sha256, namespace, expected_sha256):
    """Stream into private state; produce only the old replay files, never an embedding client."""
    path, destination = _safe(path), _safe(destination)
    try:
        before = _input_version(path)
        if not isinstance(expected_sha256,str) or not HASH.fullmatch(expected_sha256) or checksum(path) != expected_sha256:
            raise PackageError('PACKAGE_CHANGED')
    except OSError:raise PackageError('PACKAGE_UNAVAILABLE') from None
    if not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,63}',namespace):raise PackageError('PACKAGE_INVALID')
    destination.parent.mkdir(parents=True, exist_ok=True)
    filenames = dict(vector_artifact='vectorized_nodes.jsonl', provenance='provenance.json',
                     chunk_manifest='chunk_manifest.json', source_checkpoint='source_checkpoint.sqlite3')
    with _archive(path) as (archive, manifest), tempfile.TemporaryDirectory(prefix='.import-', dir=destination.parent) as temporary:
        compatible(manifest,model,plan_sha256)
        temporary = Path(temporary)
        identity = model['config']['base_url'].rstrip('/')+'|'+model['config']['model']
        dimension = manifest['model_identity']['dimension']
        budget = [unpacked_limit(manifest)]
        db = sqlite3.connect(temporary/'source_checkpoint.sqlite3')
        try:
            db.execute('CREATE TABLE package_nodes (key TEXT PRIMARY KEY,payload TEXT)')
            db.execute('CREATE TABLE jobs (identity TEXT PRIMARY KEY,state TEXT NOT NULL)')
            nodes = vectors = candidates = 0
            with archive.open('vectorized_nodes.jsonl') as source, (temporary/filenames['vector_artifact']).open('w',encoding='utf-8',newline='\n') as output:
                for node in _jsonl(source,budget):
                    if set(node) != {'type','id','name','properties'}:raise PackageError('PACKAGE_INVALID')
                    node = map_spec(node,namespace)
                    targets = dict(TARGETS[node['type'].rsplit('.',1)[-1]])
                    if any(k.startswith('_') and k not in targets.values() for k in node['properties']):raise PackageError('PACKAGE_VECTORS')
                    for prop, field in targets.items():
                        text = node['properties'].get(prop)
                        if text is not None and not isinstance(text,str):raise PackageError('PACKAGE_VECTORS')
                        if text:
                            if not valid_vector(node['properties'].get(field),dimension):raise PackageError('PACKAGE_VECTORS')
                            vectors += 1
                        elif field in node['properties']:raise PackageError('PACKAGE_VECTORS')
                        candidates += 1
                    payload = canonical_json(node)
                    db.execute('INSERT INTO package_nodes VALUES (?,?)',(canonical_json([node['type'],node['id']]),payload))
                    output.write(payload+'\n');nodes += 1
                    if nodes > manifest['nodes']:raise PackageError('PACKAGE_VECTORS')
            job_count = aggregates = 0
            with archive.open('provenance.jsonl') as source, (temporary/filenames['provenance']).open('w',encoding='utf-8') as provenance, (temporary/filenames['chunk_manifest']).open('w',encoding='utf-8') as chunks:
                provenance.write('{"model_identity":'+canonical_json(identity)+',"dimension":'+str(dimension)+',"jobs":[')
                chunks.write('{"sources":[')
                for record in _jsonl(source,budget):
                    job = _job(record,manifest['model_identity'],identity,namespace)
                    row = db.execute('SELECT payload FROM package_nodes WHERE key=?',(canonical_json([job['node_type'],job['node_id']]),)).fetchone()
                    if row is None:raise PackageError('PACKAGE_VECTORS')
                    node = json.loads(row[0]);targets = dict(TARGETS[node['type'].rsplit('.',1)[-1]])
                    field = targets[job['property']];text = node['properties'].get(job['property']) or ''
                    if (job['dimension'] != dimension or job['source_sha256'] != hashlib.sha256(text.encode()).hexdigest()
                            or job['source_chars'] != len(text) or job['source_bytes'] != len(text.encode())
                            or job['status'] != ('SUCCESS' if text else 'SKIPPED_EMPTY')
                            or job['embedding_method'] not in ('DIRECT','CHUNK_AGGREGATED')):
                        raise PackageError('PACKAGE_PROVENANCE')
                    entry = dict(job,attempts=[],classification='IMPORTED_VALID_SUCCESS')
                    if text:entry['vector'] = node['properties'][field]
                    db.execute('INSERT INTO jobs VALUES (?,?)',(canonical_json([job['node_type'],job['node_id'],job['property']]),canonical_json(entry)))
                    if job_count:provenance.write(',')
                    provenance.write(canonical_json(job));job_count += 1
                    if job['embedding_method']=='CHUNK_AGGREGATED':
                        if aggregates:chunks.write(',')
                        chunks.write(canonical_json(job['fallback']));aggregates += 1
                    if job_count > candidates:raise PackageError('PACKAGE_VECTORS')
                provenance.write(']}');chunks.write('],"source_count":'+str(aggregates)+'}')
            if nodes != manifest['nodes'] or vectors != manifest['vectors'] or job_count != candidates:
                raise PackageError('PACKAGE_VECTORS')
            db.execute('DROP TABLE package_nodes');db.commit();db.execute('VACUUM')
        except (KeyError,TypeError,ValueError,sqlite3.Error) as error:
            if isinstance(error,PackageError):raise
            raise PackageError('PACKAGE_PROVENANCE') from None
        finally:db.close()
        if _input_version(path)!=before:raise PackageError('PACKAGE_CHANGED')
        # Reuse an immutable import only if every generated byte still matches it.
        if destination.exists():
            if any(checksum(destination/f)!=checksum(temporary/f) for f in filenames.values()):
                raise PackageError('PACKAGE_CHANGED')
        else:temporary.rename(destination)
    return {key:str(destination/filename) for key,filename in filenames.items()}
