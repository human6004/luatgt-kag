"""Community SAMPLE authority: isolated broker reads, never Neo4j RBAC claims."""
import hashlib
from ipaddress import ip_address
import json
from pathlib import Path
import re
import socket
from urllib.request import Request, ProxyHandler, build_opener

from kag.retriever.neo4j import Neo4jRetrievalClient
from kag.verify import _NoRedirect, QUERIES

SCHEMA='h1-community-sample-1.0'

def load_proof(release, proof):
    from . import artifacts as a
    a._keys(proof,('schema',*a._BINDING,'release_descriptor_sha256','expected_graph_sha256',
        'provenance_sha256','counts','broker_url','broker_code_sha256','isolation'))
    a._binding(proof,release.descriptor)
    if (proof['schema']!=SCHEMA or proof['release_descriptor_sha256']!=release.descriptor_sha256
            or proof['broker_url']!='http://openspg-server:8899'
            or not re.fullmatch('[0-9a-f]{64}',proof['broker_code_sha256'])):
        a._invalid()
    a._keys(proof['isolation'],('neo4j_ip','server_ip','api_has_database_credentials','api_has_docker_socket',
        'api_container_id','server_container_id','neo4j_container_id','read_network_id','database_network_id'))
    control=proof['isolation']
    if control['api_has_database_credentials'] is not False or control['api_has_docker_socket'] is not False:
        a._invalid()
    for key in ('neo4j_ip','server_ip'):
        ip=ip_address(control[key])
        if (ip.version!=4 or not ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_unspecified or ip.is_multicast or ip.is_reserved):a._invalid()
    for key in ('api_container_id','server_container_id','neo4j_container_id','read_network_id','database_network_id'):
        if not re.fullmatch('[0-9a-f]{64}',control[key]):a._invalid()
    a._keys(proof['counts'],('nodes','edges','vectors'))
    for name,minimum,maximum in (('nodes',1,32),('edges',0,22),('vectors',1,42)):
        if type(proof['counts'][name]) is not int or not minimum<=proof['counts'][name]<=maximum:a._invalid()
    for filename,key in (('expected.sqlite3','expected_graph_sha256'),('provenance.jsonl','provenance_sha256')):
        if hashlib.sha256(a._read(release.root,filename)).hexdigest()!=proof[key]:a._invalid()
    if any((release.root/('expected.sqlite3'+suffix)).exists() for suffix in ('-wal','-shm','-journal')):a._invalid()
    return a._freeze(proof)

def verify_isolation(backend_ip):
    # Historical proof IPs are observations; probe the backend reported by the verified broker.
    server_ip=socket.gethostbyname('openspg-server')
    for value in (backend_ip,server_ip):
        if type(value) is not str:raise ValueError('invalid backend address')
        ip=ip_address(value)
        if (ip.version!=4 or not ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_unspecified or ip.is_multicast or ip.is_reserved):
            raise ValueError('invalid backend address')
    for host,port in ((backend_ip,7474),(backend_ip,7687),(server_ip,8887)):
        try:
            connection=socket.create_connection((host,port),timeout=.3)
        except OSError:
            continue
        close=getattr(connection,'close',None)
        if callable(close):close()
        raise ValueError('direct backend access denied')

class BrokerRetrievalClient(Neo4jRetrievalClient):
    """Keep verifier/retriever semantics; only broker operation DTO crosses network."""
    def __init__(self,release,proof,token,*,timeout):
        if type(token) is not str or not re.fullmatch('[A-Za-z0-9_-]{43,128}',token):
            raise ValueError('broker credential unavailable')
        self.endpoint=release.backend['reader_endpoint']
        self.database=release.descriptor['database']
        self.namespace=release.schema_contract.namespace
        self.dimension=release.descriptor.get('dimension',3072)
        self.timeout=timeout;self.read_requests=0
        self.proof=proof;self._token=token;self._descriptor=release.descriptor
        self._opener=build_opener(ProxyHandler({}),_NoRedirect())

    def _query(self,name,parameters=None,*,database=None):
        from kag.retriever.neo4j import READS
        target='system' if name in ('databases','database_metadata','reader_identity','reader_privileges') else self.database
        if name not in (*QUERIES,*READS,'readonly_state') or database not in (None,target):
            raise ValueError('unapproved broker operation')
        request=Request(self.proof['broker_url']+'/read',data=json.dumps({'operation':name,
            'parameters':parameters or {}},allow_nan=False).encode(),method='POST',
            headers={'Authorization':'Bearer '+self._token,'Content-Type':'application/json'})
        self.read_requests+=1
        try:
            address=ip_address(socket.gethostbyname('openspg-server'))
            if (address.version!=4 or not address.is_private or address.is_loopback or address.is_link_local
                    or address.is_unspecified or address.is_multicast or address.is_reserved):
                raise ValueError('invalid broker address')
            with self._opener.open(request,timeout=self.timeout) as response:
                result=json.load(response)
            expected={'database':self.database,'database_id':self._descriptor['database_id'],
                'server_id':self._descriptor['server_id'],'access':'read-only','setting':self.database}
            if (set(result)!={'rows','readonly','broker_code_sha256','backend_ip'} or result['readonly']!=expected
                    or result['broker_code_sha256']!=self.proof['broker_code_sha256'] or type(result['rows']) is not list):
                raise ValueError('broker authority changed')
            if type(result['backend_ip']) is not str:raise ValueError('invalid backend address')
            address=ip_address(result['backend_ip'])
            if (address.version!=4 or not address.is_private or address.is_loopback or address.is_link_local
                    or address.is_unspecified or address.is_multicast or address.is_reserved):
                raise ValueError('invalid backend address')
            if name=='readonly_state':verify_isolation(result['backend_ip'])
            return result['rows']
        except Exception:
            from .artifacts import ArtifactFailure,VerificationState
            raise ArtifactFailure(VerificationState.UNVERIFIED) from None

    def verify_controls(self):
        self._query('readonly_state')


class WorkerRetrievalClient(Neo4jRetrievalClient):
    """Approved read DTOs only; the private Worker retains database credentials."""
    def __init__(self,release,token,*,timeout):
        if not isinstance(token,str) or not re.fullmatch('[A-Za-z0-9_-]{43,128}',token):
            raise ValueError('reader credential unavailable')
        self.endpoint=release.backend['reader_endpoint'];self.database=release.descriptor['database']
        self.namespace=release.schema_contract.namespace;self.dimension=release.descriptor['dimension']
        self.timeout=timeout;self.read_requests=0;self._release_id=release.release_id;self._token=token
        self._opener=build_opener(ProxyHandler({}),_NoRedirect())

    def _query(self,name,parameters=None,*,database=None):
        from kag.http_api.read_broker import _parameters
        from kag.http_api.artifacts import ArtifactFailure,VerificationState
        from kag.http_api.runtime import REQUEST_SECONDS
        try:
            _parameters(name,parameters or {},database=self.database,namespace=self.namespace,
                dimension=self.dimension,production=True)
            if database not in (None,'system' if name=='database_metadata' else self.database):raise ValueError()
            request=Request('http://openspg-server:8010/v1/serving/read',method='POST',
                headers={'Authorization':'Bearer '+self._token,'Content-Type':'application/json'},
                data=json.dumps(dict(release_id=self._release_id,operation=name,parameters=parameters or {}),allow_nan=False).encode())
            self.read_requests+=1
            with self._opener.open(request,timeout=REQUEST_SECONDS if name=='verify_graph' else self.timeout) as response:
                raw=response.read(8*1024*1024+1)
            if len(raw)>8*1024*1024:raise ValueError()
            value=json.loads(raw)
            if set(value)!={'release_id','rows'} or value['release_id']!=self._release_id or type(value['rows']) is not list:raise ValueError()
            return value['rows']
        except Exception:raise ArtifactFailure(VerificationState.UNVERIFIED) from None

def verify_backend(release,proof,reader):
    from . import artifacts as a
    from kag.verify import verify_graph
    if not isinstance(reader,BrokerRetrievalClient) or reader.proof!=proof:
        a._invalid()
    reader.verify_controls()
    a._backend(reader,release)
    a._verify_sample_graph(release,proof,reader)
    a._readback(reader,release.records,a._json(release.contract_bytes))
    a._backend(reader,release)
    reader.verify_controls()
