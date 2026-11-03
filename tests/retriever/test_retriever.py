"""Schema-aware retrieval through a read transport, without graph mutations."""
import importlib
import importlib.util
import io
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT/'kag/schema/schema_contract.json').read_bytes())
LABEL = 'VietRoadTraffic.'
VECTOR = [1.0]+[0.0]*3071


def node(kind, identity, text='Nội dung nguyên vẹn.\nKhông cắt.', doc='văn-bản'):
    props = {}
    for row in CONTRACT['node_properties'][kind]:
        if row['required']:
            props[row['schema_name']] = ('{}' if row['contract_type']=='JSON_TEXT' else
                                         0 if row['contract_type']=='INTEGER' else 'source')
    props.update(id=identity,name=identity)
    if kind!='LegalDocument':
        props['docId'] = doc
    if kind=='LegalUnit':
        props['text'] = text
    elif kind=='LegalDocument':
        props['title'] = text
    else:
        props.update(ten='Tên biển',moTa=text,unitId='đơn-vị')
    return {'physical_id':1,'labels':[LABEL+kind],'properties':props}


class ReadFixture:
    def __init__(self):
        self.hits, self.nodes, self.relations, self.calls = {}, {}, [], []

    def vector_search(self, kind, prop, vector, k):
        self.calls.append((kind,prop,list(vector),k))
        return self.hits.get((kind,prop),[])

    def read_nodes(self, keys):
        return [self.nodes[tuple(key)] for key in keys if tuple(key) in self.nodes]

    def expand(self, keys, predicates, limit):
        self.expansion_args = keys,predicates,limit
        return self.relations


class RetrieverTests(unittest.TestCase):
    def retriever(self, reader=None, embed=None):
        self.assertIsNotNone(importlib.util.find_spec('kag.retriever.retriever'),
                             'schema-specific retriever is not implemented')
        cls = importlib.import_module('kag.retriever.retriever').Retriever
        return cls(reader or ReadFixture(),embed or (lambda question:VECTOR),CONTRACT)

    def fixture(self, kind='LegalUnit', identity='đơn-vị', prop='text',score=0.9):
        reader = ReadFixture()
        reader.hits[kind,prop] = [{'id':identity,'score':score,'index':'index1'}]
        reader.nodes[LABEL+kind,identity] = node(kind,identity)
        return reader

    def test_correct_four_vector_targets_without_chunk_content(self):
        reader = self.fixture()
        evidence = self.retriever(reader).retrieve('Câu hỏi tiếng Việt?')
        self.assertEqual([(kind,prop) for kind,prop,_,_ in reader.calls],
            [('LegalDocument','title'),('LegalUnit','text'),('TrafficSign','ten'),('TrafficSign','moTa')])
        self.assertEqual(evidence[0]['source_texts'],{'text':'Nội dung nguyên vẹn.\nKhông cắt.'})

    def test_exact_identity_doc_text_and_query_preservation(self):
        reader, questions = self.fixture(identity='đơn::D1::K2@2'), []
        def embed(question):
            questions.append(question)
            return VECTOR
        result = self.retriever(reader,embed).retrieve('  Đường bộ?\n')
        self.assertEqual(questions,['  Đường bộ?\n'])
        self.assertEqual(result[0]['entity_id'],'đơn::D1::K2@2')
        self.assertEqual(result[0]['unit_id'],'đơn::D1::K2@2')
        self.assertEqual(result[0]['doc_id'],'văn-bản')
        self.assertEqual(result[0]['entity_type'],'VietRoadTraffic.LegalUnit')

    def test_sign_two_fields_dedup_and_evidence_sources(self):
        reader = self.fixture('TrafficSign','sign@2024','ten',0.6)
        reader.hits['TrafficSign','moTa'] = [{'id':'sign@2024','score':0.8,'index':'moTa'}]*2
        result = self.retriever(reader).retrieve('Biển?')
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['sign_id'],'sign@2024')
        self.assertEqual(result[0]['unit_id'],'đơn-vị')
        self.assertEqual(result[0]['score'],0.8)
        self.assertEqual(len(result[0]['vector_sources']),2)

    def test_deterministic_topk_score_then_exact_identity(self):
        reader = self.fixture(identity='a',score=0.9)
        reader.hits['LegalUnit','text'] += [{'id':'b','score':0.9},{'id':'c','score':0.5}]
        for identity in ('b','c'):
            reader.nodes[LABEL+'LegalUnit',identity] = node('LegalUnit',identity)
        one = self.retriever(reader).retrieve('q',top_k=2)
        reader.hits['LegalUnit','text'].reverse()
        two = self.retriever(reader).retrieve('q',top_k=2)
        self.assertEqual(one,two)
        self.assertEqual([e['unit_id'] for e in one],['a','b'])

    def test_document_identity_is_doc_id(self):
        result = self.retriever(self.fixture('LegalDocument','doc','title')).retrieve('q')
        self.assertEqual(result[0]['doc_id'],'doc')
        self.assertIsNone(result[0]['unit_id'])

    def test_empty_results_return_empty_evidence(self):
        self.assertEqual(self.retriever().retrieve('q'),[])

    def test_missing_and_duplicate_entity_readback_refused(self):
        reader = self.fixture()
        reader.nodes.clear()
        with self.assertRaises(ValueError):
            self.retriever(reader).retrieve('q')
        reader = self.fixture()
        original = reader.read_nodes
        reader.read_nodes = lambda keys:original(keys)*2
        with self.assertRaises(ValueError):
            self.retriever(reader).retrieve('q')

    def test_invalid_scores_ids_vectors_and_limits_refused(self):
        cls = type(self.retriever())
        for score in (float('nan'),float('inf'),True,'0.9',-0.1,1.1):
            reader = self.fixture(score=score)
            with self.subTest(score=score),self.assertRaises(ValueError):
                cls(reader,lambda q:VECTOR,CONTRACT).retrieve('q')
        for vector in ([],[1.0],[0.0]*3072,[float('nan')]*3072):
            with self.subTest(vector_length=len(vector)),self.assertRaises(ValueError):
                cls(ReadFixture(),lambda q:vector,CONTRACT).retrieve('q')
        for question,k in (('',1),('   ',1),('q',0),('q',True),('q',11)):
            with self.subTest(question=question,k=k),self.assertRaises(ValueError):
                self.retriever().retrieve(question,top_k=k)

    def test_unicode_distinct_ids_not_deduplicated(self):
        reader = self.fixture(identity='é')
        reader.hits['LegalUnit','text'].append({'id':'e\u0301','score':0.8})
        reader.nodes[LABEL+'LegalUnit','e\u0301'] = node('LegalUnit','e\u0301')
        result = self.retriever(reader).retrieve('q')
        self.assertEqual([r['unit_id'] for r in result],['é','e\u0301'])

    def test_expansion_allowed_relations_context_and_dedup(self):
        reader = self.fixture(identity='a')
        reader.nodes[LABEL+'LegalUnit','b'] = node('LegalUnit','b',text='Mở rộng')
        relation = {'from':[LABEL+'LegalUnit','a'],'predicate':'citesUnit',
                    'to':[LABEL+'LegalUnit','b']}
        reader.relations = [relation,relation]
        result = self.retriever(reader).retrieve('q',expand=True)
        self.assertEqual([r['unit_id'] for r in result],['a','b'])
        self.assertEqual(result[1]['graph_context'],[relation])
        self.assertEqual(result[1]['vector_sources'],[])
        self.assertEqual(set(reader.expansion_args[1]),
            {'hasUnit','hasChild','hasSign','citesUnit','excludesUnit','cites','amends','repeals','replaces','implements','consolidates'})

    def test_expansion_unapproved_or_disconnected_relation_refused(self):
        for relation in ({'from':[LABEL+'LegalUnit','a'],'predicate':'evil','to':[LABEL+'LegalUnit','b']},
                         {'from':[LABEL+'LegalUnit','x'],'predicate':'citesUnit','to':[LABEL+'LegalUnit','b']}):
            reader = self.fixture(identity='a')
            reader.relations = [relation]
            with self.subTest(relation=relation),self.assertRaises(ValueError):
                self.retriever(reader).retrieve('q',expand=True)


class TransportTests(unittest.TestCase):
    def client(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.retriever.neo4j'),
                             'read-only retrieval transport is not implemented')
        cls = importlib.import_module('kag.retriever.neo4j').Neo4jRetrievalClient
        return cls('http://127.0.0.1:7474','sample',username='reader',password='fixture',timeout=1)

    def test_fixed_vector_read_query_and_parameterized_id(self):
        client, requests = self.client(), []
        class Opener:
            def open(self,request,timeout):
                payload = json.loads(request.data)
                requests.append(payload['statements'][0])
                statement = payload['statements'][0]['statement']
                if statement.startswith('SHOW INDEXES'):
                    rows = [{'name':'idx','type':'VECTOR','state':'ONLINE',
                        'labelsOrTypes':['VietRoadTraffic.LegalUnit'],'properties':['_text_vector'],
                        'options':{'indexConfig':{'vector.dimensions':3072,
                                                'vector.similarity_function':'COSINE'}}}]
                else:
                    rows = [{'id':"x' DELETE n",'score':0.5}]
                columns = list(rows[0])
                return io.BytesIO(json.dumps({'errors':[],'results':[{'columns':columns,
                    'data':[{'row':list(row.values())} for row in rows]}]}).encode())
        client._opener = Opener()
        rows = client.vector_search('LegalUnit','text',VECTOR,3)
        self.assertEqual(rows[0]['id'],"x' DELETE n")
        self.assertEqual(requests[-1]['parameters']['index'],'idx')
        self.assertEqual(requests[-1]['parameters']['k'],3)
        self.assertIn('db.index.vector.queryNodes',requests[-1]['statement'])
        self.assertNotIn("x' DELETE n",requests[-1]['statement'])

    def test_graph_write_and_generic_targets_refused_before_http(self):
        client = self.client()
        class NeverOpen:
            def open(self,*args,**kwargs):
                raise AssertionError('unapproved request reached HTTP')
        client._opener = NeverOpen()
        for name in ('CREATE','write_graph','MATCH (n) DELETE n'):
            with self.subTest(name=name),self.assertRaises(ValueError):
                client._query(name)
        with self.assertRaises(ValueError):
            client.vector_search('Chunk','content',VECTOR,10)
        with self.assertRaises(ValueError):
            client.expand([['VietRoadTraffic.LegalUnit','x']],['evil'],10)
