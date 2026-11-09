"""Offline broker boundaries; no Neo4j/provider connection."""
import base64
import copy
import http.client
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from kag.http_api import read_broker as broker

TOKEN = base64.urlsafe_b64encode(b't'*32).decode().rstrip('=')
DB_ID, SERVER_ID = 'a'*64, 'fixture-server'
VECTOR = [1.0]+[0.0]*3071


class Reader:
    database = 'vietroadtraffic'
    endpoint = 'http://openspg-neo4j:7474'
    def __init__(self):
        self.calls = []
        self.metadata = {'name':self.database,'databaseID':DB_ID,'serverID':SERVER_ID,'currentStatus':'online'}
        self.catalog = [{'name':self.database,'access':'read-only','currentStatus':'online'}]
        self.settings = [{'name':'server.databases.read_only','value':self.database}]
        self.drift = None
    def database_metadata(self):
        self.calls.append('identity')
        return copy.deepcopy(self.metadata)
    def readonly_state(self):
        self.calls.append('readonly')
        return copy.deepcopy({'catalog':self.catalog,'settings':self.settings})
    def indexes(self):
        return [{'name':'unit-text','type':'VECTOR','state':'ONLINE',
                 'labelsOrTypes':['VietRoadTraffic.LegalUnit'],'properties':['_text_vector'],
                 'options':{'indexConfig':{'vector.dimensions':3072,'vector.similarity_function':'cosine'}}}]
    def _query(self,name,parameters):
        self.calls.append((name,copy.deepcopy(parameters)))
        if name == 'reader_privileges':
            raise RuntimeError('private-password unsupported')
        if self.drift:
            self.drift()
        return [{'fixture':name}]


class BrokerTests(unittest.TestCase):
    def setUp(self):
        dns_patch = patch('socket.gethostbyname',return_value='172.19.0.5')
        self.dns = dns_patch.start()
        self.addCleanup(dns_patch.stop)
        self.reader = Reader()
        self.policy = broker.ReadBroker(self.reader,TOKEN,DB_ID,SERVER_ID)
    def read(self,operation='indexes',parameters=None,token=TOKEN):
        return self.policy.read({'operation':operation,'parameters':parameters or {}},'Bearer '+token)
    def denied(self,call,status=400):
        with self.assertRaises(broker.BrokerFailure) as caught:
            call()
        self.assertEqual(caught.exception.status,status)
        self.assertNotIn('private-password',str(caught.exception))
    def test_fixed_read_has_identity_and_readonly_before_and_after(self):
        result = self.read()
        self.assertEqual(result['rows'],[{'fixture':'indexes'}])
        self.assertEqual(result['readonly'],{'database':'vietroadtraffic','database_id':DB_ID,
            'server_id':SERVER_ID,'access':'read-only','setting':'vietroadtraffic'})
        self.assertEqual(self.reader.calls,['identity','readonly',('indexes',{}),'identity','readonly'])
    def test_every_response_binds_actual_broker_code(self):
        result = self.read()
        self.assertEqual(result['broker_code_sha256'],hashlib.sha256(Path(broker.__file__).read_bytes()).hexdigest())
    def test_loaded_broker_cannot_claim_changed_file_hash_before_or_during_read(self):
        loaded=Path(broker.__file__).read_bytes()
        with patch.object(broker.Path,'read_bytes',return_value=b'changed after import'):
            self.denied(self.read,503)
        self.assertEqual(self.reader.calls,[])
        with patch.object(broker.Path,'read_bytes',side_effect=[loaded,b'changed during read']):
            self.denied(self.read,503)
        self.assertEqual(len([call for call in self.reader.calls if type(call) is tuple]),1)
    def test_response_binds_current_backend_ip_and_denies_dns_drift(self):
        self.assertEqual(self.read()['backend_ip'],'172.19.0.5')
        self.reader.drift = lambda:setattr(self.dns,'return_value','172.19.0.9')
        self.denied(self.read,503)
    def test_backend_dns_must_be_private_non_loopback_ipv4(self):
        for address in ('127.0.0.1','0.0.0.0','8.8.8.8','169.254.1.1','::1'):
            self.dns.return_value = address
            with self.subTest(address=address): self.denied(self.read,503)
        self.assertEqual(self.reader.calls,[])
    def test_readonly_state_operation_is_not_an_rbac_claim(self):
        result = self.read('readonly_state')
        self.assertEqual(result['rows'],[result['readonly']])
        self.assertEqual(self.reader.calls,['identity','readonly','identity','readonly'])
    def test_identity_and_readonly_drift_deny_before_or_after_each_read(self):
        for stage in ('before','after'):
            for field in ('databaseID','serverID','currentStatus','access','setting'):
                self.setUp()
                def drift():
                    if field == 'access': self.reader.catalog[0]['access']='read-write'
                    elif field == 'setting': self.reader.settings[0]['value']=''
                    else: self.reader.metadata[field]='foreign'
                if stage == 'before': drift()
                else: self.reader.drift=drift
                with self.subTest(stage=stage,field=field): self.denied(self.read,503)
                operations = [v for v in self.reader.calls if type(v) is tuple]
                self.assertEqual(len(operations),int(stage=='after'))
    def test_unknown_operation_extra_payload_parameters_namespace_and_limits_deny(self):
        values = [
            {'operation':'CREATE','parameters':{}},
            {'operation':'indexes','parameters':{},'statement':'CREATE (n)'},
            {'operation':'indexes','parameters':{'database':'system'}},
            {'operation':'nodes','parameters':{'namespace':'Foreign.','cursor':-1,'limit':32}},
            {'operation':'nodes','parameters':{'namespace':'VietRoadTraffic.','cursor':True,'limit':32}},
            {'operation':'nodes','parameters':{'namespace':'VietRoadTraffic.','cursor':-1,'limit':33}},
            {'operation':'batch_nodes','parameters':{'keys':[['Foreign.Unit','u']],'limit':2}},
            {'operation':'batch_nodes','parameters':{'keys':[['VietRoadTraffic.LegalUnit','u']],'limit':1}},
            {'operation':'databases','parameters':{'database':'system'}},
            {'operation':'reader_identity','parameters':{'Authorization':'secret'}},
        ]
        for value in values:
            with self.subTest(value=value):
                self.denied(lambda:self.policy.read(value,'Bearer '+TOKEN))
        self.assertEqual(self.reader.calls,[])
    def test_valid_scan_hydration_expansion_and_system_operations(self):
        for operation,parameters in (
            ('nodes',{'namespace':'VietRoadTraffic.','cursor':-1,'limit':32}),
            ('edges',{'namespace':'VietRoadTraffic.','cursor':0,'limit':22}),
            ('batch_nodes',{'keys':[['VietRoadTraffic.LegalUnit','u']],'limit':2}),
            ('batch_edges',{'keys':[['VietRoadTraffic.LegalDocument','d','hasUnit',
                                    'VietRoadTraffic.LegalUnit','u']],'limit':2}),
            ('retrieval_expand',{'keys':[['VietRoadTraffic.LegalUnit','u']],
                'predicates':['hasUnit'],'labels':list(broker.LABELS),'limit':50}),
            ('database_metadata',{'database':'vietroadtraffic'}),
            ('databases',{'database':'vietroadtraffic'}),('reader_identity',{})):
            with self.subTest(operation=operation):
                self.assertEqual(self.read(operation,parameters)['rows'],[{'fixture':operation}])
    def test_vector_requires_exact_contract_index_and_native_3072_vector(self):
        parameters = {'index':'unit-text','label':'VietRoadTraffic.LegalUnit','k':10,'vector':VECTOR}
        self.assertEqual(self.read('retrieval_vector',parameters)['rows'],[{'fixture':'retrieval_vector'}])
        for changes in ({'index':'foreign'},{'label':'Foreign.Unit'},{'k':True},{'k':11},
                        {'vector':VECTOR[:-1]},{'vector':[0.0]*3072},{'vector':[float('nan')]+VECTOR[1:]}):
            with self.subTest(changes=tuple(changes)):
                self.denied(lambda:self.read('retrieval_vector',{**parameters,**changes}))
    def test_token_is_strong_constant_time_and_required_before_backend(self):
        for token in ('wrong','',TOKEN+'x'):
            self.denied(lambda:self.read(token=token),401)
        self.assertEqual(self.reader.calls,[])
        with patch.object(broker.hmac,'compare_digest',wraps=broker.hmac.compare_digest) as compare:
            self.read()
        compare.assert_called_once()
        for token in ('short','x'*42,'!'*43):
            with self.assertRaises(broker.BrokerFailure):
                broker.ReadBroker(self.reader,token,DB_ID,SERVER_ID)
    def test_unsupported_privilege_query_is_denied_without_claiming_reader(self):
        self.denied(lambda:self.read('reader_privileges'),503)


class TransportTests(unittest.TestCase):
    def test_actual_client_uses_fixed_readonly_statements_and_database_targets(self):
        calls = []
        class Opener:
            def open(inner,request,*,timeout):
                body = json.loads(request.data)
                calls.append((request.full_url,body))
                name = body['statements'][0]['statement']
                if name == broker._READONLY['readonly_catalog']:
                    row = {'name':'vietroadtraffic','access':'read-only','currentStatus':'online'}
                else:
                    row = {'name':'server.databases.read_only','value':'vietroadtraffic'}
                return io.BytesIO(json.dumps({'errors':[],'results':[{'columns':list(row),
                    'data':[{'row':list(row.values())}]}]}).encode())
        reader = broker.BrokerNeo4jClient('http://openspg-neo4j:7474','vietroadtraffic',
            username='neo4j',password='dummy-offline-password',timeout=5)
        reader._opener = Opener()
        self.assertEqual(reader.readonly_state(),{'catalog':Reader().catalog,'settings':Reader().settings})
        self.assertEqual([url for url,_ in calls],['http://openspg-neo4j:7474/db/system/tx/commit',
                                                'http://openspg-neo4j:7474/db/vietroadtraffic/tx/commit'])
        self.assertEqual([v['statements'][0]['parameters'] for _,v in calls],[{'database':'vietroadtraffic'},{}])
        for endpoint in ('http://remote.invalid:7474','http://user:secret@openspg-neo4j:7474'):
            with self.assertRaises(Exception):
                broker.BrokerNeo4jClient(endpoint,'vietroadtraffic',username='neo4j',password='dummy',timeout=5)
    def test_proxy_environment_ignored_redirects_and_oversize_response_denied(self):
        with patch.dict(os.environ,{'HTTP_PROXY':'http://remote.invalid','HTTPS_PROXY':'http://remote.invalid'}), \
                patch.object(broker,'build_opener',wraps=broker.build_opener) as build:
            opener = broker._BoundedOpener()
        proxy,redirect = build.call_args.args
        self.assertEqual(proxy.proxies,{})
        self.assertIsNone(redirect.redirect_request(None,None,307,'redirect',{},'http://remote.invalid'))
        with patch.object(opener._opener,'open',return_value=io.BytesIO(b'x'*(broker.RESPONSE_LIMIT+1))):
            with self.assertRaises(broker.BrokerFailure) as caught:
                with opener.open(None,timeout=5): pass
        self.assertEqual(caught.exception.status,503)
    def test_secret_files_and_cli_invalid_configuration_never_expose_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'secret'
            path.write_bytes(TOKEN.encode()+b'\n')
            with patch.dict(os.environ,{'KAG_BROKER_TOKEN_FILE':str(path)}):
                self.assertEqual(broker._secret_file('KAG_BROKER_TOKEN_FILE'),TOKEN)
            for raw in (b'x'*4097,b'secret\nextra',b'secret\0'):
                path.write_bytes(raw)
                with patch.dict(os.environ,{'KAG_BROKER_PASSWORD_FILE':str(path)}):
                    with self.assertRaises(broker.BrokerFailure): broker._secret_file('KAG_BROKER_PASSWORD_FILE')
        with patch.dict(os.environ,{'KAG_BROKER_DATABASE':'production'},clear=True):
            with self.assertRaises(SystemExit) as caught: broker.main()
        self.assertEqual(str(caught.exception),'Read broker unavailable.')


class HTTPTests(unittest.TestCase):
    def setUp(self):
        dns_patch = patch('socket.gethostbyname',return_value='172.19.0.5')
        dns_patch.start()
        self.addCleanup(dns_patch.stop)
        self.reader = Reader()
        self.server = broker.BrokerHTTPServer(('127.0.0.1',0),broker.ReadBroker(self.reader,TOKEN,DB_ID,SERVER_ID))
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
    def close(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
    def request(self,path='/read',body=None,method='POST',headers=None):
        client = http.client.HTTPConnection(*self.server.server_address,timeout=2)
        try:
            client.request(method,path,body=json.dumps({'operation':'indexes','parameters':{}}) if body is None else body,
                headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json',**(headers or {})})
            response = client.getresponse()
            return response.status,response.read().decode(),dict(response.getheaders())
        finally: client.close()
    def test_only_authenticated_read_route_and_sanitized_failures(self):
        self.assertEqual(self.request()[0],200)
        for path in ('/write','/read?operation=indexes','/db/system/tx/commit','http://remote.invalid/read'):
            self.assertEqual(self.request(path=path)[0],404)
        self.assertEqual(self.request(method='GET')[0],404)
        self.assertEqual(self.request(headers={'Authorization':'Bearer wrong'})[0],401)
        self.assertEqual(self.request(body='{"operation":"indexes","operation":"CREATE","parameters":{}}')[0],400)
        status,body,headers = self.request(body=json.dumps({'operation':'reader_privileges','parameters':{}}))
        self.assertEqual(status,503)
        self.assertNotIn('private-password',body)
        self.assertEqual(headers['Cache-Control'],'no-store')
    def test_http_body_encoding_transfer_and_size_guards(self):
        for headers in ({'Transfer-Encoding':'chunked'},{'Content-Encoding':'gzip'},
                        {'Content-Type':'text/plain'}):
            self.assertEqual(self.request(headers=headers)[0],400)
        self.assertEqual(self.request(body='x'*(broker.BODY_LIMIT+1))[0],400)
        self.assertEqual(self.reader.calls,[])


if __name__ == '__main__':
    unittest.main()
