"""Private SAMPLE read broker. Database credentials stay in the OpenSPG backend.

Network isolation, sealed graph/source verification and an operator-pinned broker
proof remain mandatory at the API. This module never claims Neo4j reader RBAC.
"""
import base64
from contextlib import contextmanager
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
from ipaddress import ip_address
import io
import json
import os
from pathlib import Path
import re
import socket
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from kag.builder.codec import canonical_json
from kag.retriever.neo4j import APPROVED, READS, Neo4jRetrievalClient
from kag.vector_contract import TARGETS, valid_vector
from kag.verify import QUERIES, _NoRedirect

DATABASE = 'vietroadtraffic'
NAMESPACE = 'VietRoadTraffic'
LABELS = tuple(NAMESPACE+'.'+kind for kind in TARGETS)
BODY_LIMIT = 128*1024
RESPONSE_LIMIT = 8*1024*1024
CODE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
_READONLY = {
    'readonly_catalog': ('SHOW DATABASES YIELD name,access,currentStatus WHERE name=$database '
                         'RETURN name,access,currentStatus'),
    'readonly_settings': ("SHOW SETTINGS YIELD name,value WHERE name='server.databases.read_only' "
                          'RETURN name,value'),
}


class BrokerFailure(Exception):
    def __init__(self,status=400):
        self.status = status
        super().__init__('Sample read denied.')


def _exact(value,keys):
    if type(value) is not dict or set(value) != set(keys):
        raise BrokerFailure()


def _integer(value,minimum,maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise BrokerFailure()


def _identity(value):
    if (type(value) is not str or not value.strip() or len(value) > 512
            or any(ord(c)<32 or ord(c)==127 for c in value)):
        raise BrokerFailure()
    try: value.encode('utf-8')
    except UnicodeError: raise BrokerFailure() from None


def _keys(value,*,edges=False):
    if type(value) is not list:
        raise BrokerFailure()
    _integer(len(value),1,22 if edges else 32)
    seen = set()
    for key in value:
        if type(key) is not list or len(key) != (5 if edges else 2):
            raise BrokerFailure()
        positions = (0,3) if edges else (0,)
        for offset in positions:
            if key[offset] not in LABELS:
                raise BrokerFailure()
            _identity(key[offset+1])
        if edges and key[2] not in APPROVED:
            raise BrokerFailure()
        item = tuple(key)
        if item in seen:
            raise BrokerFailure()
        seen.add(item)


def _parameters(operation,value):
    if type(operation) is not str or operation not in {*QUERIES,*READS,'readonly_state'}:
        raise BrokerFailure()
    if operation in ('indexes','reader_identity','reader_privileges','readonly_state'):
        _exact(value,())
    elif operation in ('databases','database_metadata'):
        _exact(value,('database',))
        if value['database'] != DATABASE: raise BrokerFailure()
    elif operation in ('nodes','edges'):
        _exact(value,('namespace','cursor','limit'))
        if value['namespace'] != NAMESPACE+'.': raise BrokerFailure()
        _integer(value['cursor'],-1,2**63-1)
        _integer(value['limit'],1,32)
    elif operation in ('batch_nodes','batch_edges'):
        _exact(value,('keys','limit'))
        _keys(value['keys'],edges=operation=='batch_edges')
        _integer(value['limit'],len(value['keys'])+1,len(value['keys'])+1)
    elif operation == 'retrieval_vector':
        _exact(value,('index','label','k','vector'))
        _identity(value['index'])
        if value['label'] not in LABELS or not valid_vector(value['vector'],3072):
            raise BrokerFailure()
        _integer(value['k'],1,10)
    else:
        _exact(value,('keys','predicates','labels','limit'))
        _keys(value['keys'])
        for field,allowed in (('labels',LABELS),('predicates',APPROVED)):
            items = value[field]
            if (type(items) is not list or not items or any(type(v) is not str for v in items)
                    or len(items) != len(set(items)) or set(items)-set(allowed)
                    or field=='labels' and set(items) != set(LABELS)):
                raise BrokerFailure()
        _integer(value['limit'],1,50)


def _token(value):
    try:
        if type(value) is not str or not re.fullmatch('[A-Za-z0-9_-]{43,128}',value):
            raise ValueError()
        raw = base64.b64decode(value+'='*((-len(value))%4),altchars=b'-_',validate=True)
        if len(raw)<32: raise ValueError()
        return value.encode('ascii')
    except (ValueError,TypeError):
        raise BrokerFailure(503) from None


class ReadBroker:
    def __init__(self,reader,token,database_id,server_id):
        if reader.database != DATABASE:
            raise BrokerFailure(503)
        for value in (database_id,server_id): _identity(value)
        self.reader, self._token = reader,_token(token)
        self.database_id,self.server_id = database_id,server_id

    def authorize(self,authorization):
        if type(authorization) is not str or not authorization.startswith('Bearer '):
            raise BrokerFailure(401)
        try: candidate = authorization[7:].encode('ascii')
        except UnicodeError: raise BrokerFailure(401) from None
        if not hmac.compare_digest(candidate,self._token): raise BrokerFailure(401)

    def _state(self):
        expected = {'name':DATABASE,'databaseID':self.database_id,'serverID':self.server_id,
                    'currentStatus':'online'}
        if self.reader.database_metadata() != expected: raise BrokerFailure(503)
        state = self.reader.readonly_state()
        if (state['catalog'] != [{'name':DATABASE,'access':'read-only','currentStatus':'online'}]
                or state['settings'] != [{'name':'server.databases.read_only','value':DATABASE}]):
            raise BrokerFailure(503)
        return {'database':DATABASE,'database_id':self.database_id,'server_id':self.server_id,
                'access':'read-only','setting':DATABASE}

    def _backend_ip(self):
        if self.reader.endpoint != 'http://openspg-neo4j:7474': raise BrokerFailure(503)
        address = ip_address(socket.gethostbyname(urlsplit(self.reader.endpoint).hostname))
        if (address.version != 4 or not address.is_private or address.is_loopback
                or address.is_unspecified or address.is_link_local or address.is_multicast or address.is_reserved):
            raise BrokerFailure(503)
        return str(address)

    def _vector_index(self,parameters):
        found = [i for i in self.reader.indexes() if i.get('name') == parameters['index']]
        if len(found)!=1: raise BrokerFailure()
        index = found[0]
        fields = {field for _,field in TARGETS[parameters['label'].rsplit('.',1)[1]]}
        config = index.get('options',{}).get('indexConfig',{})
        if (index.get('type') != 'VECTOR' or index.get('labelsOrTypes') != [parameters['label']]
                or type(index.get('properties')) is not list or len(index['properties'])!=1
                or index['properties'][0] not in fields):
            raise BrokerFailure()
        if (index.get('state') != 'ONLINE' or type(config.get('vector.dimensions')) is not int
                or config['vector.dimensions'] != 3072
                or not isinstance(config.get('vector.similarity_function'), str)
                or config['vector.similarity_function'].lower() != 'cosine'):
            raise BrokerFailure(503)

    def read(self,value,authorization):
        self.authorize(authorization)
        _exact(value,('operation','parameters'))
        operation,parameters = value['operation'],value['parameters']
        _parameters(operation,parameters)
        try:
            if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != CODE_SHA256:
                raise BrokerFailure(503)
            backend_ip = self._backend_ip()
            before = self._state()
            if operation == 'retrieval_vector': self._vector_index(parameters)
            rows = [before] if operation=='readonly_state' else self.reader._query(operation,parameters)
            after = self._state()
            if (type(rows) is not list or before != after or self._backend_ip() != backend_ip):
                raise BrokerFailure(503)
            if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != CODE_SHA256:
                raise BrokerFailure(503)
            return {'rows':rows,'readonly':after,
                    'backend_ip':backend_ip,
                    'broker_code_sha256':CODE_SHA256}
        except BrokerFailure:
            raise
        except Exception:
            raise BrokerFailure(503) from None


class _BoundedOpener:
    def __init__(self):
        # Environment proxies and redirects cannot carry the backend credential elsewhere.
        self._opener = build_opener(ProxyHandler({}),_NoRedirect())
    @contextmanager
    def open(self,request,*,timeout):
        with self._opener.open(request,timeout=timeout) as response:
            raw = response.read(RESPONSE_LIMIT+1)
        if len(raw)>RESPONSE_LIMIT: raise BrokerFailure(503)
        with io.BytesIO(raw) as result: yield result


class BrokerNeo4jClient(Neo4jRetrievalClient):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        if self.endpoint != 'http://openspg-neo4j:7474' or self.database != DATABASE:
            raise BrokerFailure(503)
        self._opener = _BoundedOpener()
    def _readonly_query(self,name):
        target = 'system' if name=='readonly_catalog' else DATABASE
        request = Request(self.endpoint+'/db/'+target+'/tx/commit',method='POST',
            headers={'Authorization':self._auth,'Content-Type':'application/json'},
            data=canonical_json({'statements':[{'statement':_READONLY[name],
                'parameters':{'database':DATABASE} if name=='readonly_catalog' else {}}]}).encode())
        with self._opener.open(request,timeout=self.timeout) as response: result = json.load(response)
        if result.get('errors') or len(result['results'])!=1: raise BrokerFailure(503)
        table = result['results'][0]
        if any(len(row['row'])!=len(table['columns']) for row in table['data']): raise BrokerFailure(503)
        return [dict(zip(table['columns'],row['row'])) for row in table['data']]
    def readonly_state(self):
        return {'catalog':self._readonly_query('readonly_catalog'),
                'settings':self._readonly_query('readonly_settings')}


def _pairs(items):
    result = {}
    for key,value in items:
        if key in result: raise BrokerFailure()
        result[key] = value
    return result


def _constant(value):
    raise BrokerFailure()


class _Handler(BaseHTTPRequestHandler):
    server_version,sys_version = 'SampleReadBroker',''
    def log_message(self,*args): pass
    def send_error(self,code,message=None,explain=None): self._reply(code,{'error':'DENIED'})
    def _reply(self,status,value):
        raw = json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
        if len(raw)>RESPONSE_LIMIT: status,raw = 503,b'{"error":"DENIED"}'
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.send_header('Connection','close')
        self.end_headers()
        self.wfile.write(raw)
        self.close_connection = True
    def do_POST(self):
        try:
            if self.path != '/read': raise BrokerFailure(404)
            headers = self.headers.get_all('Authorization',[])
            if len(headers)!=1: raise BrokerFailure(401)
            self.server.broker.authorize(headers[0])
            lengths = self.headers.get_all('Content-Length',[])
            if (len(lengths)!=1 or not re.fullmatch('[0-9]{1,6}',lengths[0])
                    or not 1<=int(lengths[0])<=BODY_LIMIT or 'Transfer-Encoding' in self.headers
                    or 'Content-Encoding' in self.headers
                    or self.headers.get_all('Content-Type',[]) != ['application/json']):
                raise BrokerFailure()
            raw = self.rfile.read(int(lengths[0]))
            if len(raw)!=int(lengths[0]): raise BrokerFailure()
            value = json.loads(raw.decode('utf-8'),object_pairs_hook=_pairs,parse_constant=_constant)
            result = self.server.broker.read(value,headers[0])
            self._reply(200,result)
        except BrokerFailure as error: self._reply(error.status,{'error':'DENIED'})
        except (ValueError,UnicodeError,RecursionError): self._reply(400,{'error':'DENIED'})
        except Exception: self._reply(503,{'error':'DENIED'})
    def do_GET(self): self._reply(404,{'error':'DENIED'})


class BrokerHTTPServer(HTTPServer):
    def __init__(self,address,broker):
        self.broker = broker
        super().__init__(address,_Handler)
    def get_request(self):
        sock,address = super().get_request()
        sock.settimeout(5)
        return sock,address


def _secret_file(name):
    path = Path(os.environ[name])
    if not path.is_absolute() or path.is_symlink() or not path.is_file(): raise BrokerFailure(503)
    with path.open('rb') as stream: raw = stream.read(4099)
    if raw.endswith(b'\r\n'): raw = raw[:-2]
    elif raw.endswith(b'\n'): raw = raw[:-1]
    if not 1<=len(raw)<=4096 or any(c in raw for c in (b'\0',b'\n',b'\r')): raise BrokerFailure(503)
    return raw.decode('ascii')


def main():
    try:
        if os.environ.get('KAG_BROKER_DATABASE',DATABASE) != DATABASE: raise BrokerFailure(503)
        host = os.environ.get('KAG_BROKER_HOST','0.0.0.0')
        if host not in ('0.0.0.0','127.0.0.1'): raise BrokerFailure(503)
        port = int(os.environ.get('KAG_BROKER_PORT','8888'))
        _integer(port,1,65535)
        reader = BrokerNeo4jClient(os.environ.get('KAG_BROKER_NEO4J_ENDPOINT','http://openspg-neo4j:7474'),
            DATABASE,username=os.environ.get('KAG_BROKER_USERNAME','neo4j'),
            password=_secret_file('KAG_BROKER_PASSWORD_FILE'),timeout=5,namespace=NAMESPACE)
        policy = ReadBroker(reader,_secret_file('KAG_BROKER_TOKEN_FILE'),
            os.environ['KAG_BROKER_DATABASE_ID'],os.environ['KAG_BROKER_SERVER_ID'])
        with BrokerHTTPServer((host,port),policy) as server: server.serve_forever()
    except KeyboardInterrupt: pass
    except Exception: raise SystemExit('Sample read broker unavailable.') from None


if __name__ == '__main__': main()
