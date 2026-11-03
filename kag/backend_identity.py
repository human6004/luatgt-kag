"""Live, read-only backend identity. Receipts are evidence, never authorization."""
from collections.abc import Mapping
from dataclasses import dataclass
import json
import io
import re
import subprocess
import os
import socket
import base64
import hmac
from urllib.parse import urlsplit


_DNS_SCRIPT = ('import json,socket,sys; print(json.dumps(sorted({x[4][0] '
               'for x in socket.getaddrinfo(sys.argv[1],None)})))')
_CATALOG_HTTP_SCRIPT = '''import json,sys,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
p=json.load(sys.stdin)
r=urllib.request.Request(p['url'],data=p['data'].encode(),headers=p['headers'],method='POST')
with urllib.request.build_opener(NoRedirect()).open(r,timeout=p['timeout']) as response:
 sys.stdout.write(response.read().decode())
'''


class BackendIdentityError(ValueError):
    def __init__(self):
        super().__init__('Backend identity missing, ambiguous, changed or unbound.')


class BackendIdentityTransportError(RuntimeError):
    def __init__(self):
        super().__init__('Graph transport unavailable.')


def _field(record, name):
    return record.get(name) if isinstance(record, Mapping) else getattr(record, name, None)


def _target(record):
    identity = _field(record, 'id')
    if type(identity) not in (str, int) or not str(identity).isdigit() or int(identity) <= 0:
        raise BackendIdentityError()
    return int(identity), _field(record, 'name'), _field(record, 'namespace')


def client_route(client, endpoint):
    """Bind the actual pinned REST dispatch route, not just client metadata."""
    rest = getattr(client, '_rest_client', None)
    api = vars(rest).get('api_client') if rest is not None and hasattr(rest, '__dict__') else None
    if api is not None and (api.configuration.host != endpoint or api.url_prefix != '/public/v1'):
        raise BackendIdentityError()
    return rest, api


def bound_sdk_requests(client):
    """Bound the pinned SDK transport without replacing GraphClient/KGWriter."""
    api = vars(client._rest_client).get('api_client')
    if api is None:
        return
    request = api.request
    def bounded(*args, **kwargs):
        if kwargs.get('_request_timeout') is None:
            kwargs['_request_timeout'] = (10, 60)
        return request(*args, **kwargs)
    api.request = bounded
    # Never retry an ambiguous graph POST behind the Runner intent/readback ledger.
    api.rest_client.pool_manager.connection_pool_kw['retries'] = False


def _store(record):
    config = _field(record, 'config')
    if isinstance(config, str): config = json.loads(config)
    store = config['graph_store']
    uri, database = store['uri'], store['database']
    parsed = urlsplit(uri)
    if (parsed.scheme not in ('neo4j', 'neo4j+s', 'neo4j+ssc', 'bolt', 'bolt+s', 'bolt+ssc')
            or not parsed.hostname or not parsed.port or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment or uri.strip() != uri
            or store.get('type', 'neo4j').lower() != 'neo4j'
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,62}', database)):
        raise BackendIdentityError()
    host = parsed.hostname
    if ':' in host: host = '[' + host + ']'
    endpoint = parsed.scheme + '://' + host + ':' + str(parsed.port)
    # Pass only the graph transport fields. All raw config stays out of the proof.
    return {key: store[key] for key in ('uri', 'database', 'user', 'password') if key in store}, endpoint


def _metadata(value, database):
    if (not isinstance(value, Mapping) or value.get('name') != database.lower()
            or value.get('currentStatus') != 'online'
            or any(not isinstance(value.get(k), str) or not value[k].strip()
                   for k in ('name', 'databaseID', 'serverID'))):
        raise BackendIdentityError()
    return value['name'], value['databaseID'], value['serverID']


@dataclass(frozen=True)
class BackendIdentityProof:
    proof_version: int
    project_id: int
    project_name: str
    namespace: str
    openspg_endpoint: str
    backend_type: str
    backend_endpoint: str
    canonical_database_name: str
    physical_database_id: str
    verifier_database_id: str
    lock_database_id: str
    runtime_identity: tuple[str, ...]

    def to_receipt(self):
        # Explicit allowlist. No session token, transport, credentials or config.
        return {key: getattr(self, key) for key in (
            'proof_version', 'project_id', 'project_name', 'namespace', 'openspg_endpoint',
            'backend_type', 'backend_endpoint', 'canonical_database_name',
            'physical_database_id', 'verifier_database_id', 'lock_database_id', 'runtime_identity')}


class BackendIdentitySession:
    """One preflight authority; transport must attest URI routing on every read.

    transport.read(graph_store, verifier) -> (backend catalog metadata, runtime tuple).
    Runtime tuple must come from live routing evidence, not an endpoint/name guess.
    Dependencies are trusted in-process transports, never receipt/config inputs.
    """
    def __init__(self, project_client, verifier, transport, *, project_id, project_name,
                 namespace, openspg_endpoint):
        parsed = urlsplit(openspg_endpoint)
        if (type(project_id) is not int or project_id <= 0
                or any(not isinstance(x, str) or not x.strip() for x in (project_name, namespace))
                or parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise BackendIdentityError()
        self._project_client, self._verifier, self._transport = project_client, verifier, transport
        self._project_route = client_route(project_client, openspg_endpoint)
        self._target = project_id, project_name, namespace
        self._endpoint = openspg_endpoint
        self._active, self._issued, self._snapshot = True, None, None

    def _read(self):
        try:
            if not self._active or self._project_client._host_addr != self._endpoint:
                raise BackendIdentityError()
            route = client_route(self._project_client, self._endpoint)
            if any(a is not b for a, b in zip(route, self._project_route)):
                raise BackendIdentityError()
            records = self._project_client._rest_client.project_get()
            ids = [r for r in records if _target(r)[0] == self._target[0]]
            if len(ids) != 1 or _target(ids[0]) != self._target:
                raise BackendIdentityError()
            record = self._project_client.get(id=self._target[0])
            if _target(record) != self._target:
                raise BackendIdentityError()
            store, endpoint = _store(record)
            listed_store, _ = _store(ids[0])
            if store != listed_store: raise BackendIdentityError()
            backend, runtime = self._transport.read(store, self._verifier)
            verified = self._verifier.database_metadata()
            identity = _metadata(backend, store['database'])
            if identity != _metadata(verified, store['database']): raise BackendIdentityError()
            if (type(runtime) is not tuple or not runtime
                    or any(type(x) is not str or not x.strip() for x in runtime)):
                raise BackendIdentityError()
            return BackendIdentityProof(1, *self._target, self._endpoint, 'neo4j', endpoint,
                identity[0], identity[1], identity[1], identity[1], (identity[2], *runtime))
        except (TimeoutError, ConnectionError, RuntimeError):
            raise BackendIdentityTransportError() from None
        except Exception:
            raise BackendIdentityError() from None

    def prove(self):
        if self._issued is not None:
            self.validate(self._issued)
            return self._issued
        proof = self._read()
        self._issued, self._snapshot = proof, proof.to_receipt()
        return proof

    def validate(self, proof):
        if (not self._active or proof is not self._issued or proof is None
                or proof.to_receipt() != self._snapshot):
            raise BackendIdentityError()
        if self._read().to_receipt() != self._snapshot: raise BackendIdentityError()

    def close(self):
        self._active = False
        self._issued = self._snapshot = None
        self._project_client = self._verifier = self._transport = None
        self._project_route = None


def _isolated_builder_password():
    password = os.environ.get('KAG_ISOLATED_BUILDER_PASSWORD', '')
    # A deployment credential plus a loopback-only kernel namespace, never a manifest grant.
    if len(password) < 32 or {name for _, name in socket.if_nameindex()} != {'lo'}:
        raise BackendIdentityError()
    return password


class NativeBackendTransport:
    """Read the actual graph-store Bolt catalog in the OpenSPG service namespace."""
    def __init__(self, openspg_endpoint):
        self.openspg_endpoint = openspg_endpoint

    def read(self, store, verifier):
        try:
            from neo4j import GraphDatabase, Query, READ_ACCESS
            parsed = urlsplit(store['uri'])
            host = '[' + parsed.hostname + ']' if ':' in parsed.hostname else parsed.hostname
            endpoint = parsed.scheme + '://' + host + ':' + str(parsed.port)
            if verifier.database.lower() != store['database'].lower():
                raise BackendIdentityError()
            # Credentials are never placed in the driver URI or identity receipt.
            auth = (store.get('user') or parsed.username, store.get('password') or parsed.password)
            if not all(isinstance(value, str) and value for value in auth):
                raise BackendIdentityError()
            marker = 'native-bolt-v1'
            if 'KAG_ISOLATED_BUILDER_PASSWORD' in os.environ:
                password = _isolated_builder_password()
                routes = (self.openspg_endpoint, endpoint, verifier.endpoint)
                expected_auth = 'Basic ' + base64.b64encode((auth[0] + ':' + password).encode()).decode()
                if (not all(urlsplit(route).hostname in ('127.0.0.1', '::1') for route in routes)
                        or not hmac.compare_digest(auth[1].encode(), password.encode())
                        or not hmac.compare_digest(getattr(verifier, '_auth', ''), expected_auth)):
                    raise BackendIdentityError()
                marker = 'native-bolt-isolated-v1'
            with GraphDatabase.driver(endpoint, auth=auth, connection_timeout=10,
                    connection_acquisition_timeout=10, max_transaction_retry_time=0) as driver:
                with driver.session(database='system', default_access_mode=READ_ACCESS) as session:
                    rows = session.run(Query('SHOW DATABASES YIELD name,databaseID,serverID,currentStatus '
                        'RETURN name,databaseID,serverID,currentStatus', timeout=60),
                        database=store['database']).data()
            matches = [row for row in rows if row.get('name') == store['database'].lower()]
            if len(matches) != 1:
                raise BackendIdentityError()
            row = matches[0]
            _metadata(row, store['database'])
            if sum(other.get('databaseID') == row['databaseID'] for other in rows) != 1:
                raise BackendIdentityError()
            return row, (marker, self.openspg_endpoint, endpoint, verifier.endpoint)
        except BackendIdentityError:
            raise
        except Exception:
            raise BackendIdentityTransportError() from None


class DockerBackendTransport:
    """Attest Docker routing, then read catalog inside the OpenSPG namespace.

    Requires local Docker inspection/exec access. No route fallback. Other runtime
    deployments supply their own trusted read transport to the same session.
    """
    def __init__(self, openspg_endpoint):
        self.openspg_endpoint = openspg_endpoint

    def _docker(self, args, *, input=None):
        result = subprocess.run(['rtk', 'proxy', 'docker', *args], input=input,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        if result.returncode: raise BackendIdentityError()
        return result.stdout

    @staticmethod
    def _published(container, endpoint, internal_port):
        parsed = urlsplit(endpoint)
        if (parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1')
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/')):
            return False
        mappings = container['NetworkSettings']['Ports'].get(str(internal_port)+'/tcp') or []
        return any(row['HostIp'] in ('127.0.0.1', '0.0.0.0')
                   and row['HostPort'] == str(parsed.port) for row in mappings)

    def read(self, store, verifier):
        try:
            uri = urlsplit(store['uri'])
            if uri.scheme not in ('neo4j', 'bolt') or uri.port != 7687:
                raise BackendIdentityError()
            ids = self._docker(['ps', '-q']).split()
            if not ids: raise BackendIdentityError()
            containers = json.loads(self._docker(['inspect', *ids]))
            servers = [c for c in containers if self._published(c, self.openspg_endpoint, 8887)]
            databases = [c for c in containers if self._published(c, verifier.endpoint, 7474)]
            if len(servers) != 1 or len(databases) != 1: raise BackendIdentityError()
            server, database = servers[0], databases[0]
            if not server['State']['Running'] or not database['State']['Running']:
                raise BackendIdentityError()
            common = set(server['NetworkSettings']['Networks']) & set(database['NetworkSettings']['Networks'])
            networks = [n for n in common if uri.hostname in
                (database['NetworkSettings']['Networks'][n].get('Aliases') or [])]
            if len(networks) != 1: raise BackendIdentityError()
            network = networks[0]
            attachment = database['NetworkSettings']['Networks'][network]
            if server['NetworkSettings']['Networks'][network]['NetworkID'] != attachment['NetworkID']:
                raise BackendIdentityError()
            if '7687/tcp' not in database['Config']['ExposedPorts']:
                raise BackendIdentityError()
            dns = json.loads(self._docker(['exec', server['Id'], 'python3', '-c',
                _DNS_SCRIPT,
                uri.hostname]))
            if dns != [attachment['IPAddress']]: raise BackendIdentityError()
            from kag.verify import Neo4jReadClient
            reader = Neo4jReadClient('http://' + uri.hostname + ':7474', store['database'],
                username=store.get('user') or uri.username,
                password=store.get('password') or uri.password, timeout=60)
            # Credentials travel over stdin only. No secrets in argv, receipts or errors.
            reader._opener = _DockerReadOpener(self, server['Id'])
            metadata = reader.database_metadata()
            runtime = (server['Id'], server['Image'], database['Id'], database['Image'], attachment['NetworkID'])
            return metadata, runtime
        except Exception:
            raise BackendIdentityError() from None


class _DockerReadOpener:
    def __init__(self, transport, server):
        self.transport, self.server = transport, server

    def open(self, request, *, timeout):
        output = self.transport._docker(['exec', '-i', self.server, 'python3', '-c', _CATALOG_HTTP_SCRIPT],
            input=json.dumps({'url':request.full_url, 'data':request.data.decode(),
                              'headers':dict(request.header_items()), 'timeout':timeout}))
        return io.BytesIO(output.encode())


class DockerPrivateBackendTransport:
    """Read Docker identity over the local socket; no published admin ports required.

    The runner must share the exact new OpenSPG network namespace. Docker access
    here performs GET inspection only; serving containers never mount this socket.
    """
    def __init__(self, project, server_id, database_id, runtime_id, storage_revision=''):
        if (not re.fullmatch(r'kag(?:-[a-z0-9][a-z0-9-]*)?',project)
                or not isinstance(storage_revision,str)
                or storage_revision and not re.fullmatch(r'-fresh-[a-z0-9-]{1,40}',storage_revision)):
            raise BackendIdentityError()
        self.project=project
        self.storage_revision=storage_revision
        self.server_id,self.database_id,self.runtime_id=server_id,database_id,runtime_id

    @staticmethod
    def _inspect(container_id, *, kind='containers'):
        import http.client
        import socket
        if (kind not in ('containers', 'volumes') or not isinstance(container_id, str)
                or not re.fullmatch(r'(?:[0-9a-f]{12}|[0-9a-f]{64})' if kind == 'containers'
                                    else r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', container_id)):
            raise BackendIdentityError()
        class Connection(http.client.HTTPConnection):
            def connect(inner):
                inner.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                inner.sock.settimeout(10)
                inner.sock.connect('/var/run/docker.sock')
        connection=Connection('localhost',timeout=10)
        try:
            connection.request('GET', '/'+kind+'/'+container_id+('/json' if kind == 'containers' else ''))
            response=connection.getresponse()
            if response.status != 200: raise BackendIdentityError()
            return json.loads(response.read())
        finally: connection.close()

    def read(self, store, verifier):
        import socket
        try:
            server,database,runtime=(self._inspect(key) for key in
                (self.server_id,self.database_id,self.runtime_id))
            if (server['Id'] != self.server_id or database['Id'] != self.database_id
                    or runtime['Id'] != self.runtime_id
                    or not all(c['State']['Running'] for c in (server,database,runtime))
                    or runtime['HostConfig']['NetworkMode'] != 'container:'+self.server_id):
                raise BackendIdentityError()
            for container,service in ((server,'openspg-server'),(database,'openspg-neo4j')):
                labels=container['Config']['Labels']
                if (labels.get('com.docker.compose.project') != self.project
                        or labels.get('com.docker.compose.service') != service): raise BackendIdentityError()
            volume=self.project+'_openspg-neo4j-data'+self.storage_revision
            mounts={(m['Destination'],m.get('Name'),m['Type']) for m in database['Mounts']}
            if mounts != {('/data',volume,'volume'),('/logs',self.project+'_openspg-neo4j-logs','volume')} or server['Mounts']:
                raise BackendIdentityError()
            network=self.project+'_private'
            if any(set(c['NetworkSettings']['Networks']) != {network} for c in (server,database)):
                raise BackendIdentityError()
            attachment=database['NetworkSettings']['Networks'][network]
            if server['NetworkSettings']['Networks'][network]['NetworkID'] != attachment['NetworkID']:
                raise BackendIdentityError()
            parsed=urlsplit(store['uri'])
            if (parsed.scheme not in ('bolt','neo4j') or parsed.port != 7687
                    or parsed.hostname not in attachment['Aliases']
                    or verifier.endpoint != 'http://'+parsed.hostname+':7474'
                    or verifier.database != store['database']): raise BackendIdentityError()
            dns=sorted({x[4][0] for x in socket.getaddrinfo(parsed.hostname,None)})
            if dns != [attachment['IPAddress']]: raise BackendIdentityError()
            from kag.verify import Neo4jReadClient
            reader=Neo4jReadClient(verifier.endpoint,store['database'],
                username=store['user'],password=store['password'],timeout=60)
            metadata=reader.database_metadata()
            return metadata,(server['Id'],server['Image'],database['Id'],database['Image'],
                             attachment['NetworkID'],volume)
        except Exception:
            raise BackendIdentityError() from None
