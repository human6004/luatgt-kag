"""OFFLINE SAMPLE proof, full graph verifier and provider-free HTTP entry."""
import copy
from dataclasses import replace
import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from kag.builder.codec import canonical_json
from kag.builder.mapping import application_edge_key
from kag.http_api import artifacts, contract, runtime
from kag.http_api.app import ApiSettings, create_app
from kag.http_api.security import ServiceSecrets
from kag.vector_contract import TARGETS
from kag.retriever.neo4j import Neo4jRetrievalClient
from kag.verify import index_expected, verify_graph
from test_artifacts import EvidenceFixture, CONTRACT, IDENTITY, sha, raw_json

VECTOR = [1.0]+[0.0]*3071
SECRETS = ServiceSecrets(('q'*43,), ('i'*43,))


class SampleFixture(EvidenceFixture):
    def __init__(self, root, *, model_identity='OFFLINE-SYNTHETIC'):
        super().__init__(root)
        self.principal = {'user':'sample_reader', 'roles':['PUBLIC','reader'],
                          'passwordChangeRequired':False, 'suspended':False}
        self.privileges = [{'access':'GRANTED','action':'access'},
                           {'access':'GRANTED','action':'match'}]
        self.closed, self.searches = False, 0
        jobs, specs = [], []
        for ordinal, ((kind, identity), node) in enumerate(self.nodes.items()):
            node['physical_id'] = ordinal
            for prop, field in TARGETS[kind.rsplit('.',1)[1]]:
                node['properties'][field] = list(VECTOR)
                text = node['properties'][prop]
                jobs.append({'node_type':kind,'node_id':identity,'property':prop,
                    'source_sha256':sha(text.encode()),'source_chars':len(text),
                    'source_bytes':len(text.encode()),'dimension':3072,
                    'model_identity':model_identity,'status':'SUCCESS','embedding_method':'DIRECT'})
            specs.append({'type':kind,'id':identity,'name':identity,'properties':node['properties']})
        for side, key in (('from',('VietRoadTraffic.LegalDocument','document-1')),
                          ('to',('VietRoadTraffic.LegalUnit','unit-1'))):
            self.edges[0][side] = copy.deepcopy(self.nodes[key])
        fields = [*self.relation['from'], self.relation['predicate'], *self.relation['to']]
        index_expected(root/'expected.sqlite3', specs,
            [{'tuple':fields,'properties':{},'application_edge_key':application_edge_key(fields)}],
            contract=CONTRACT, provenance=jobs)
        (root/'provenance.jsonl').write_bytes(b''.join(raw_json(j)+b'\n' for j in jobs))
        result = verify_graph(self,db_path=root/'expected.sqlite3',contract=CONTRACT,batch_size=32)
        self.binding['graph_fingerprint'] = result['fingerprint']
        for value in (self.catalog,self.graph,self.backend,self.authority,self.descriptor):
            value['graph_fingerprint'] = result['fingerprint']
        self.seal(publication=False)
        self.release = artifacts.load_release(root,'synthetic-release')
        self.proof = {'schema':'h1-sample-serving-1.0',**self.binding,
            'release_descriptor_sha256':self.release.descriptor_sha256,
            'expected_graph_sha256':sha((root/'expected.sqlite3').read_bytes()),
            'provenance_sha256':sha((root/'provenance.jsonl').read_bytes()),
            'reader_username':'sample_reader','reader_privileges_verified':True,
            'counts':{'nodes':3,'edges':1,'vectors':4}}
        self.pin = self.seal_proof()
        self.evidence_id = next(r.evidence_id for r in self.release.records
            if r.entity_type.endswith('.LegalUnit'))

    def seal_proof(self):
        raw = raw_json(self.proof)
        (self.root/'sample-serving.json').write_bytes(raw)
        return sha(raw)

    def iter_nodes(self, namespace, batch_size):
        yield copy.deepcopy(list(self.nodes.values()))

    def iter_edges(self, namespace, batch_size):
        yield copy.deepcopy(self.edges)

    def reader_security(self):
        return copy.deepcopy(self.principal), copy.deepcopy(self.privileges)

    def vector_search(self, kind, prop, vector, k):
        self.searches += 1
        return [{'id':'unit-1','score':1.0,'index':'synthetic-_text_vector'}] if kind=='LegalUnit' else []

    def close(self):
        self.closed = True


class SampleServingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertIn('sample_proof_sha256',runtime.RuntimeSettings.__dataclass_fields__, 'sample proof config missing')
        self.temp = tempfile.TemporaryDirectory(prefix='OFFLINE-sample-serving-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixture = SampleFixture(self.root)
        self.settings = runtime.RuntimeSettings(secrets=SECRETS,
            release_id='synthetic-release',source_snapshot_id='synthetic-source',
            reader_username='sample_reader',reader_password='fixture-only',
            sample_proof_sha256=self.fixture.pin)

    def body(self):
        return {'evidence_id':self.fixture.evidence_id,'schema_contract':IDENTITY,'top_k':1,'expand':False}

    async def post(self, body=None, capability=None):
        app = create_app(ApiSettings(SECRETS),enable_sample_routes=True)
        app.state.serving_release = self.fixture.release
        app.state.runtime_settings = self.settings
        app.state.runtime_supervisor = runtime.RuntimeSupervisor()
        self.supervisor = app.state.runtime_supervisor
        with patch.object(runtime,'initialize_runtime'), patch.object(runtime,'_new_reader',return_value=self.fixture), \
                patch.object(runtime,'_new_embedding',side_effect=AssertionError('provider forbidden')), \
                patch.object(runtime,'_new_llm',side_effect=AssertionError('chat forbidden')):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture.invalid') as client:
                headers = {'authorization':'Bearer '+'i'*43,'x-kag-release-id':'synthetic-release'}
                if capability:
                    return await client.get('/v1/health?mode=ready&capability='+capability,headers=headers)
                return await client.post('/v1/retrieve/vector',json=self.body() if body is None else body,headers=headers)

    async def test_offline_sample_serves_sealed_vector_and_closes_reader(self):
        response = await self.post()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['release_kind'],'SAMPLE')
        self.assertEqual(response.json()['items'][0]['entity_id'],'unit-1')
        self.assertEqual(self.fixture.searches,4)
        self.assertTrue(self.fixture.closed)

    async def test_reader_role_null_admin_or_write_privileges_denied(self):
        for roles in (None,['admin'],['PUBLIC','reader','publisher']):
            self.fixture.principal['roles'] = roles
            self.assertEqual((await self.post()).status_code,503)
        self.fixture.principal['roles'] = ['PUBLIC','reader']
        self.fixture.privileges.append({'access':'GRANTED','action':'write'})
        self.assertEqual((await self.post()).status_code,503)
        self.assertEqual(self.fixture.searches,0)

    async def test_tampered_expected_graph_proof_and_provenance_denied(self):
        for name in ('sample-serving.json','expected.sqlite3','provenance.jsonl'):
            path = self.root/name
            raw = path.read_bytes()
            path.write_bytes(raw+b' ')
            self.assertEqual((await self.post()).status_code,503)
            path.write_bytes(raw)
        self.assertEqual(self.fixture.searches,0)

    async def test_vector_drift_and_extra_node_denied(self):
        key = ('VietRoadTraffic.LegalUnit','unit-1')
        self.fixture.nodes[key]['properties']['_text_vector'][0] = 0.5
        self.assertEqual((await self.post()).status_code,503)
        self.fixture.nodes[key]['properties']['_text_vector'][0] = 1.0
        extra = copy.deepcopy(self.fixture.nodes[key])
        extra['physical_id'] = 99
        extra['properties'].update(id='extra',name='extra')
        self.fixture.nodes[(key[0],'extra')] = extra
        self.assertEqual((await self.post()).status_code,503)
        self.assertEqual(self.fixture.searches,0)

    async def test_live_physical_identity_and_index_drift_denied(self):
        self.fixture.metadata['databaseID'] = 'foreign'
        self.assertEqual((await self.post()).status_code,503)
        self.fixture.metadata['databaseID'] = self.fixture.binding['database_id']
        self.fixture.vector_indexes[0]['state'] = 'POPULATING'
        self.assertEqual((await self.post()).status_code,503)
        self.assertEqual(self.fixture.searches,0)

    async def test_backend_changes_during_search_denied_after_native_result(self):
        original = self.fixture.vector_search
        def search(*args):
            result = original(*args)
            self.fixture.principal['roles'] = ['admin']
            return result
        self.fixture.vector_search = search
        self.assertEqual((await self.post()).status_code,503)
        self.assertTrue(self.fixture.closed)

    async def test_inspect_auth_required_before_reader_and_runtime_settings_mismatch(self):
        app = create_app(ApiSettings(SECRETS),enable_sample_routes=True)
        app.state.serving_release = self.fixture.release
        app.state.runtime_settings = replace(self.settings,secrets=ServiceSecrets(('x'*43,),('y'*43,)))
        app.state.runtime_supervisor = runtime.RuntimeSupervisor()
        with patch.object(runtime,'_new_reader',side_effect=AssertionError('reader must not be constructed')):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture.invalid') as client:
                response = await client.post('/v1/retrieve/vector',json=self.body(),
                    headers={'authorization':'Bearer '+'i'*43,'x-kag-release-id':'synthetic-release'})
                self.assertEqual(response.status_code,503,response.text)
                response = await client.get('/v1/health?mode=ready&capability=retrieve-vector',
                    headers={'authorization':'Bearer '+'q'*43,'x-kag-release-id':'synthetic-release'})
                self.assertEqual(response.status_code,403,response.text)

    def test_actual_rbac_transport_only_reads_system_with_approved_statements(self):
        calls = []
        class Opener:
            def open(inner,request,timeout):
                calls.append((request.full_url,json.loads(request.data)['statements'][0]['statement']))
                row = self.fixture.principal if len(calls)==1 else self.fixture.privileges[0]
                return io.BytesIO(json.dumps({'errors':[],'results':[{'columns':list(row),
                    'data':[{'row':list(row.values())}]}]}).encode())
        reader = Neo4jRetrievalClient('http://fixture.invalid:7474','synthetic-db',
            username='sample_reader',password='fixture-only',timeout=5)
        reader._opener = Opener()
        principal,privileges = reader.reader_security()
        self.assertEqual(principal,self.fixture.principal)
        self.assertEqual(privileges,[self.fixture.privileges[0]])
        self.assertTrue(all(url.endswith('/db/system/tx/commit') for url,_ in calls))
        self.assertEqual([query.split(' YIELD')[0] for _,query in calls],
                         ['SHOW CURRENT USER','SHOW USER PRIVILEGES'])

    def test_unsealed_sqlite_sidecar_denied(self):
        (self.root/'expected.sqlite3-wal').write_bytes(b'unsealed')
        with self.assertRaises(contract.ApiFailure):
            artifacts.load_sample_proof(self.fixture.release,self.settings.sample_proof_sha256,'sample_reader')

    async def test_nl_arbitrary_vector_and_foreign_evidence_denied(self):
        for body in ({**self.body(),'message':'Câu hỏi'}, {**self.body(),'vector':VECTOR},
                     {**self.body(),'evidence_id':'0'*64}):
            self.assertGreaterEqual((await self.post(body)).status_code,400)
        self.assertEqual(self.fixture.searches,0)

    async def test_sample_ready_separate_from_nl_and_production(self):
        response = await self.post(capability='retrieve-vector')
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['release_kind'],'SAMPLE')
        self.assertEqual((await self.post(capability='retrieve')).status_code,503)
        self.fixture.release = replace(self.fixture.release,release_kind='PRODUCTION')
        self.assertEqual((await self.post()).status_code,503)

    def test_false_privilege_receipt_denied_even_when_live_roles_are_reader(self):
        self.fixture.proof['reader_privileges_verified'] = False
        self.settings = replace(self.settings,sample_proof_sha256=self.fixture.seal_proof())
        with self.assertRaises(contract.ApiFailure):
            artifacts.load_sample_proof(self.fixture.release,self.settings.sample_proof_sha256,'sample_reader')

    def test_dto_requires_exact_evidence_identity_and_bounded_fields(self):
        self.assertEqual(contract.SampleVectorRequest.from_dict(self.body()).evidence_id,self.fixture.evidence_id)
        for field,value in (('evidence_id','x'),('top_k',True),('expand',1)):
            with self.assertRaises(contract.ApiFailure):
                contract.SampleVectorRequest.from_dict({**self.body(),field:value})

    def test_sample_catalog_preserves_external_parent_without_inventing_nodes(self):
        for record in self.fixture.catalog['records']:
            if record['entity_type'].endswith('.TrafficSign'):
                record['unit_id'] = 'outside-bounded-sample'
                record['metadata']['unit_id'] = 'outside-bounded-sample'
            elif record['entity_type'].endswith('.LegalUnit'):
                record['metadata']['parent_id'] = 'outside-parent-sample'
        self.fixture.seal(publication=False)
        try:
            release = artifacts.load_release(self.root,'synthetic-release')
        except contract.ApiFailure:
            self.fail('SAMPLE metadata parent outside bounded graph must remain representable')
        self.assertEqual(len(release.records),len(self.fixture.catalog['records']))
        sign = next(r for r in release.records if r.entity_type.endswith('.TrafficSign'))
        unit = next(r for r in release.records if r.entity_type.endswith('.LegalUnit'))
        self.assertEqual(sign.unit_id,'outside-bounded-sample')
        self.assertEqual(unit.metadata['parent_id'],'outside-parent-sample')

    def test_non_sample_catalog_still_denies_external_parent(self):
        self.fixture.descriptor['release_kind'] = 'PRODUCTION'
        for record in self.fixture.catalog['records']:
            if record['entity_type'].endswith('.TrafficSign'):
                record['unit_id'] = 'outside-bounded-sample'
                record['metadata']['unit_id'] = 'outside-bounded-sample'
        self.fixture.seal(publication=False)
        with self.assertRaises(contract.ApiFailure):
            artifacts.load_release(self.root,'synthetic-release')

    def test_sample_actual_graph_context_external_endpoint_remains_denied(self):
        self.fixture.relation['to'][1] = 'outside-bounded-sample'
        self.fixture.seal(publication=False)
        with self.assertRaises(contract.ApiFailure):
            artifacts.load_release(self.root,'synthetic-release')

    def test_sample_present_unit_parent_still_requires_same_document(self):
        other_doc = copy.deepcopy(next(r for r in self.fixture.catalog['records']
                                      if r['entity_type'].endswith('.LegalDocument')))
        other_doc.update(entity_id='document-2',doc_id='document-2',graph_context=[])
        other_doc['metadata'].update(id='document-2',name='document-2')
        self.fixture.catalog['records'].append(other_doc)
        for record in self.fixture.catalog['records']:
            if record['entity_type'].endswith('.TrafficSign'):
                record['doc_id'] = 'document-2'
                record['metadata']['doc_id'] = 'document-2'
        self.fixture.seal(publication=False)
        with self.assertRaises(contract.ApiFailure):
            artifacts.load_release(self.root,'synthetic-release')
