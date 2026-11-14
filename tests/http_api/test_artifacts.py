"""Synthetic sealed evidence only; no live legal-source or readiness proof."""
import copy
from dataclasses import FrozenInstanceError, replace
from datetime import date, datetime
import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from fixtures import answered, source, AnswerResult, Citation
from kag.builder.codec import canonical_json, decode_properties
from kag.http_api.contract import ApiFailure, project_v1
from kag.vector_contract import TARGETS

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT/'kag/schema/schema_contract.json').read_bytes())
IDENTITY = {'namespace': CONTRACT['namespace'],
    'schema_sha256': hashlib.sha256((ROOT/'kag/schema/VietRoadTraffic.schema').read_bytes()).hexdigest(),
    'contract_sha256': hashlib.sha256((ROOT/'kag/schema/schema_contract.json').read_bytes()).hexdigest()}
AS_OF = date(2026, 10, 8)
NS = 'VietRoadTraffic.'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def raw_json(value):
    return canonical_json(value).encode('utf-8')


def node(kind, identity):
    props = {}
    for row in CONTRACT['node_properties'][kind]:
        if row['required']:
            props[row['schema_name']] = ('{}' if row['contract_type'] == 'JSON_TEXT'
                else 0 if row['contract_type'] == 'INTEGER' else 'synthetic')
    props.update(id=identity, name=identity, soHieu='synthetic-document')
    if kind == 'LegalDocument':
        props.update(title='Văn bản synthetic', effectiveFrom='2020-01-01')
    elif kind == 'LegalUnit':
        props.update(docId='document-1', unitType='Dieu', text=source().source_text)
    else:
        props.update(docId='document-1', unitId='unit-1', ten='Tên synthetic',
                     moTa='Mô tả synthetic e\u0301 😀.', ngayHieuLuc='2020-01-01')
    return {'physical_id': 1, 'labels': [NS+kind], 'properties': props}


class EvidenceFixture:
    """Operator artifacts and an existing read-interface double, kept separate."""
    def __init__(self, root):
        self.root = root
        self.endpoint, self.database = 'http://fixture.invalid:7474', 'synthetic-db'
        self.nodes = {(NS+kind, identity): node(kind, identity) for kind, identity in
            [('LegalDocument','document-1'), ('LegalUnit','unit-1'), ('TrafficSign','sign-1')]}
        self.metadata = {'name':self.database, 'databaseID':'physical-fixture-db',
                         'serverID':'physical-fixture-server', 'currentStatus':'online'}
        self.vector_indexes = [{'name':'synthetic-'+field, 'type':'VECTOR', 'state':'ONLINE',
            'labelsOrTypes':[NS+kind], 'properties':[field],
            'options':{'indexConfig':{'vector.dimensions':3072, 'vector.similarity_function':'cosine'}}}
            for kind, targets in TARGETS.items() for _, field in targets]
        self.calls = []
        self.relation = {'from':[NS+'LegalDocument','document-1'], 'predicate':'hasUnit',
                         'to':[NS+'LegalUnit','unit-1'], 'properties':{}}
        self.edges = [{'physical_id':1, 'predicate':'hasUnit','properties':{},
            'from':{'labels':[NS+'LegalDocument'],'properties':{'id':'document-1','name':'document-1'}},
            'to':{'labels':[NS+'LegalUnit'],'properties':{'id':'unit-1','name':'unit-1'}}}]
        self.binding = {'release_id':'synthetic-release', 'schema_contract':IDENTITY,
            'source_snapshot_id':'synthetic-source', 'graph_fingerprint':'c'*64,
            'database_id':'physical-fixture-db','server_id':'physical-fixture-server',
            'database':self.database,'namespace':CONTRACT['namespace']}
        self.catalog = {'schema':'h1-source-catalog-1.0', **self.binding, 'records':[]}
        self.publication = {'schema':'h1-webapp-publication-1.0',
            'snapshot_id':'synthetic-webapp', 'schema_contract':IDENTITY,
            'source_snapshot_id':'synthetic-source', 'as_of':AS_OF.isoformat(),
            'timezone':'Asia/Saigon','documents':[], 'units':[]}
        for (entity_type, identity), row in self.nodes.items():
            kind = entity_type.rsplit('.',1)[1]
            props = decode_properties(row['properties'], CONTRACT['node_properties'][kind])
            fields = [(physical, physical) for physical,_ in TARGETS[kind]]
            if kind == 'LegalDocument':
                fields.append(('effective_from','effectiveFrom'))
            for field, physical in fields:
                text = row['properties'][physical]
                self.catalog['records'].append({'entity_type':entity_type,'entity_id':identity,
                    'doc_id':identity if kind == 'LegalDocument' else props['doc_id'],
                    'unit_id':identity if kind == 'LegalUnit' else props.get('unit_id'),
                    'sign_id':identity if kind == 'TrafficSign' else None,
                    'field':field,'physical_field':physical,'source_text':text,
                    'source_sha256':sha(text.encode('utf-8')), 'metadata':props,
                    'graph_context':[self.relation] if kind != 'TrafficSign' else []})
            if kind == 'LegalDocument':
                self.publication['documents'].append({'doc_id':identity,'published':True,
                    'version':'synthetic-v1','effective_from':'2020-01-01','effective_to':None,
                    'current_effective':True,'replaces_eligible':True})
            if kind == 'LegalUnit':
                self.publication['units'].append({'doc_id':'document-1','unit_id':identity,
                    'text_sha256':sha(props['text'].encode('utf-8')),'published':True,'version':'synthetic-v1'})
        self.graph = {'schema':'h1-graph-receipt-1.0', **self.binding, 'graph_verified':True}
        self.backend = {'schema':'h1-backend-receipt-1.0', **self.binding,
            'reader_endpoint':self.endpoint, 'project_id':'synthetic-project', 'identity_attested':True}
        self.authority = {'schema':'h1-serving-authority-1.0', **self.binding,
            'reader_endpoint':self.endpoint, 'project_id':'synthetic-project',
            'graph_frozen':True,'schema_frozen':True,'read_only':True,'catalog_complete':True}
        self.descriptor = {'schema':'h1-release-1.0', **self.binding, 'release_kind':'SAMPLE',
            'source_catalog_sha256':None,'graph_receipt_sha256':None,'backend_receipt_sha256':None,
            'serving_mode':'sealed_read_only','serving_authority_receipt_sha256':None,
            'sealed_at':'2026-10-08T00:00:00Z','webapp_snapshot_id':'synthetic-webapp',
            'webapp_publication_sha256':None}
        self.seal()

    def seal(self, publication=True):
        self.graph['source_catalog_sha256'] = sha(raw_json(self.catalog))
        self.authority['source_catalog_sha256'] = self.graph['source_catalog_sha256']
        self.authority['backend_receipt_sha256'] = sha(raw_json(self.backend))
        entries = [('source-catalog.json',self.catalog,'source_catalog_sha256'),
            ('graph-receipt.json',self.graph,'graph_receipt_sha256'),
            ('backend-receipt.json',self.backend,'backend_receipt_sha256'),
            ('serving-authority.json',self.authority,'serving_authority_receipt_sha256')]
        if publication:
            entries.append(('webapp-publication.json',self.publication,'webapp_publication_sha256'))
        else:
            self.descriptor.update(webapp_snapshot_id=None, webapp_publication_sha256=None)
        for filename, value, key in entries:
            raw = raw_json(value)
            (self.root/filename).write_bytes(raw)
            self.descriptor[key] = sha(raw)
        (self.root/'release.json').write_bytes(raw_json(self.descriptor))

    def database_metadata(self):
        self.calls.append('database_metadata')
        return copy.deepcopy(self.metadata)

    def indexes(self):
        self.calls.append('indexes')
        return copy.deepcopy(self.vector_indexes)

    def read_nodes(self, keys):
        self.calls.append(('read_nodes', keys))
        return [copy.deepcopy(self.nodes[tuple(k)]) for k in keys if tuple(k) in self.nodes]

    def read_edges(self, keys):
        self.calls.append(('read_edges',keys))
        return copy.deepcopy(self.edges) if keys else []


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='h1-synthetic-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.fixture = EvidenceFixture(self.root)

    def api(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.http_api.artifacts'),
                             'verified artifacts interface not implemented')
        return importlib.import_module('kag.http_api.artifacts')

    def load(self):
        return self.api().load_release(self.root, 'synthetic-release')

    def verify(self, result=None, snapshot='synthetic-webapp', as_of=AS_OF, release=None):
        result = result if result is not None else answered()[0]
        return self.api().verify_native_sources(result, release or self.load(), self.fixture, as_of, snapshot)

    def failure(self, operation, code='SOURCE_VALIDATION_FAILED', state='invalid'):
        with self.assertRaises(ApiFailure) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.state.value, state)
        return caught.exception

    def test_selected_release_bytes_immutable_and_no_reader_calls(self):
        release = self.load()
        self.assertEqual(release.release_id,'synthetic-release')
        self.assertEqual(release.descriptor_sha256, sha((self.root/'release.json').read_bytes()))
        self.assertEqual(self.fixture.calls,[])

    def test_sample_publication_window_verifies_next_day_without_changing_query_date(self):
        from datetime import timedelta
        self.fixture.publication.update(schema='h1-webapp-publication-2.0',serving_until=(AS_OF+timedelta(days=6)).isoformat())
        self.fixture.seal()
        verified=self.verify(as_of=AS_OF+timedelta(days=1))
        self.assertEqual(verified.as_of,AS_OF+timedelta(days=1))
        self.assertEqual(verified.publication_state.value,'verified')
        for day in (AS_OF-timedelta(days=1),AS_OF+timedelta(days=7)):
            self.failure(lambda:self.verify(as_of=day),'NOT_READY')

    def test_sample_publication_window_does_not_extend_legal_effectivity(self):
        from datetime import timedelta
        props=self.fixture.nodes[NS+'LegalDocument','document-1']['properties']
        props['effectiveTo']=(AS_OF+timedelta(days=1)).isoformat()
        for record in self.fixture.catalog['records']:
            if record['entity_type']==NS+'LegalDocument':
                record['metadata']=decode_properties(props,CONTRACT['node_properties']['LegalDocument'])
        self.fixture.publication['documents'][0]['effective_to']=props['effectiveTo']
        self.fixture.publication.update(schema='h1-webapp-publication-2.0',serving_until=(AS_OF+timedelta(days=6)).isoformat())
        self.fixture.seal()
        self.verify()
        self.failure(lambda:self.verify(as_of=AS_OF+timedelta(days=1)))

    def test_publication_window_is_sample_only_bounded_and_cannot_mutate_sealed_bytes(self):
        from datetime import timedelta
        self.fixture.publication.update(schema='h1-webapp-publication-2.0',serving_until=(AS_OF+timedelta(days=6)).isoformat())
        self.fixture.seal();release=self.load()
        (self.root/'webapp-publication.json').write_bytes(b'{}')
        self.failure(lambda:self.verify(release=release),'NOT_READY')
        for end in ((AS_OF-timedelta(days=1)).isoformat(),(AS_OF+timedelta(days=7)).isoformat(),None):
            self.fixture.publication['serving_until']=end
            self.fixture.seal();self.failure(self.load,'NOT_READY')
        self.fixture.publication['serving_until']=(AS_OF+timedelta(days=6)).isoformat()
        self.fixture.descriptor['release_kind']='PRODUCTION'
        self.fixture.seal();self.failure(self.load,'NOT_READY')
        with self.assertRaises(FrozenInstanceError):
            release.release_id = 'forged'
        with self.assertRaises(TypeError):
            release.records[0].metadata['id'] = 'forged'

    def test_document_content_intent_requires_exact_label_source_and_sample(self):
        from kag.legal_solver import DOCUMENT_CONTENT_ANSWER
        props=self.fixture.nodes[NS+'LegalDocument','document-1']['properties']
        props.update(soHieu='330/2026/NĐ-CP',ngayHieuLucBoPhan='[{"date":"2027-07-01"}]')
        for record in self.fixture.catalog['records']:
            if record['entity_type']==NS+'LegalDocument':
                record['metadata']=decode_properties(props,CONTRACT['node_properties']['LegalDocument'])
        self.fixture.seal();release=self.load()
        original=answered()[0]
        result=AnswerResult(DOCUMENT_CONTENT_ANSWER+'\n\n'.join(c.quote for c in original.citations),original.citations,False)
        question='Trích nội dung văn bản: Nghị định 330/2026/NĐ-CP quy định gì?'
        self.api().verify_native_sources(result,release,self.fixture,AS_OF,'synthetic-webapp',question=question)
        for bad_result,bad_question,bad_release in (
                (result,None,release),(original,question,release),
                (result,question.replace('330','999'),release),
                (result,question,replace(release,release_kind='PRODUCTION'))):
            self.failure(lambda:self.api().verify_native_sources(bad_result,bad_release,self.fixture,AS_OF,
                'synthetic-webapp',question=bad_question))

    def test_view_cannot_promote_artifact_hashes_to_live_readiness(self):
        view = self.api().release_view(self.load())
        self.assertFalse(view['backend_identity_verified'])
        self.assertFalse(view['source_identity_verified'])
        self.assertFalse(view['query_ready'])
        self.assertIsNone(view['verified_at'])
        self.assertEqual(view['production_write'],'blocked')
        self.assertNotIn('fixture.invalid',raw_json(view).decode())

    def test_verified_whole_legalunit_preserves_projection_and_result(self):
        result, _ = answered()
        before = result.to_dict()
        verified = self.verify(result)
        self.assertEqual(verified.state.value,'verified')
        self.assertEqual(verified.release_id,'synthetic-release')
        self.assertEqual(verified.as_of,AS_OF)
        self.assertEqual(project_v1(result,verified),{'answer':result.answer,'citations':before['citations']})
        self.assertEqual(result.to_dict(),before)

    def test_native_abstention_preserved_without_citations(self):
        result = AnswerResult('Chưa đủ bằng chứng.',(),True,'insufficient legal authority')
        verified = self.verify(result)
        self.assertEqual(verified.citations,())
        self.assertEqual(result.reason,'insufficient legal authority')
        with self.assertRaises(ApiFailure) as caught:
            project_v1(result,verified)
        self.assertEqual(caught.exception.code,'KAG_ABSTAINED')

    def test_sign_source_with_unit_metadata_never_becomes_legalunit(self):
        text = self.fixture.nodes[NS+'TrafficSign','sign-1']['properties']['moTa']
        sign = source('TrafficSign','sign-1','moTa',text,unit_id='unit-1',sign_id='sign-1')
        result, _ = answered(sign)
        verified = self.verify(result)
        self.assertEqual(verified.citations[0].entity_type,NS+'TrafficSign')
        self.assertFalse(verified.citations[0].java_eligible)
        with self.assertRaises(ApiFailure) as caught:
            project_v1(result,verified)
        self.assertEqual(caught.exception.code,'V1_RESULT_UNREPRESENTABLE')

    def test_document_metadata_mixed_support_retained_then_v1_refused(self):
        metadata = source('LegalDocument','document-1','effective_from','2020-01-01',unit_id=None)
        result, _ = answered(source(),metadata)
        verified = self.verify(result)
        self.assertEqual(tuple(v.citation for v in verified.citations),result.citations)
        with self.assertRaises(ApiFailure) as caught:
            project_v1(result,verified)
        self.assertEqual(caught.exception.code,'V1_RESULT_UNREPRESENTABLE')
        self.assertEqual(len(result.citations),2)

    def test_document_only_provenance_does_not_claim_java_fact(self):
        result, _ = answered(source('LegalDocument','document-1','effective_from','2020-01-01',unit_id=None))
        verified = self.verify(result)
        self.assertFalse(verified.citations[0].java_eligible)
        with self.assertRaises(ApiFailure):
            project_v1(result,verified)

    def test_unicode_codepoint_spans_not_utf16_or_bytes(self):
        result, _ = answered()
        self.assertNotEqual(len(result.citations[0].quote), len(result.citations[0].quote.encode('utf-8')))
        self.assertEqual(self.verify(result).citations[0].source_text,result.citations[0].quote)

    def test_missing_release_unavailable(self):
        (self.root/'release.json').unlink()
        self.failure(self.load,'NOT_READY','unavailable')

    def test_wrong_selected_release_invalid(self):
        self.failure(lambda:self.api().load_release(self.root,'foreign-release'),'NOT_READY')

    def test_unknown_descriptor_fields_invalid(self):
        self.fixture.descriptor['run_id'] = 'request-controlled'
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')

    def test_missing_or_unsealed_freeze_proof_unverified(self):
        for field in ('graph_frozen','schema_frozen','read_only','catalog_complete'):
            original = dict(self.fixture.authority)
            self.fixture.authority[field] = False
            self.fixture.seal()
            self.failure(self.load,'NOT_READY','unverified')
            self.fixture.authority = original
        self.fixture.authority.pop('read_only')
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')

    def test_backend_attestation_not_boolean_truthiness(self):
        self.fixture.backend['identity_attested'] = 'true'
        self.fixture.seal()
        self.failure(self.load,'NOT_READY','unverified')

    def test_receipt_binding_mismatch_invalid(self):
        for name in ('graph','backend','authority'):
            receipt = getattr(self.fixture,name)
            receipt['database_id'] = 'foreign-db'
            self.fixture.seal()
            self.failure(self.load,'NOT_READY')
            receipt['database_id'] = 'physical-fixture-db'

    def test_schema_and_contract_hash_mismatch_invalid(self):
        for field in ('namespace','schema_sha256','contract_sha256'):
            original = copy.deepcopy(self.fixture.descriptor['schema_contract'])
            self.fixture.descriptor['schema_contract'] = {**original,field:'foreign' if field == 'namespace' else 'd'*64}
            self.fixture.seal()
            self.failure(self.load,'NOT_READY')
            self.fixture.descriptor['schema_contract'] = original

    def test_tampered_each_artifact_rejected_by_hash_before_readback(self):
        for filename in ('source-catalog.json','graph-receipt.json','backend-receipt.json',
                         'serving-authority.json','webapp-publication.json'):
            self.fixture.seal()
            path = self.root/filename
            path.write_bytes(path.read_bytes()+b' ')
            self.failure(self.load,'NOT_READY')
        self.assertEqual(self.fixture.calls,[])

    def test_strict_artifact_json_duplicate_nonfinite_bom_surrogate(self):
        path = self.root/'release.json'
        for raw in (b'{"schema":1,"schema":2}',b'{"x":NaN}',b'\xef\xbb\xbf{}',b'{"x":"\\ud800"}',b'\xff'):
            path.write_bytes(raw)
            self.failure(self.load,'NOT_READY')

    def test_artifact_limit_before_json_parsing(self):
        path = self.root/'release.json'
        with path.open('wb') as stream:
            stream.seek(64*1024*1024)
            stream.write(b'x')
        self.failure(self.load,'NOT_READY')

    def test_nonregular_artifact_rejected_without_blocking_open(self):
        self.api()
        path = self.root/'release.json'
        path.unlink()
        os.mkfifo(path)
        code = '''
from pathlib import Path
import sys
from kag.http_api.artifacts import load_release, ArtifactFailure
try:
    load_release(Path(sys.argv[1]),'synthetic-release')
except ArtifactFailure as exc:
    assert exc.code == 'NOT_READY' and exc.state.value == 'invalid'
else:
    raise AssertionError('nonregular artifact accepted')
'''
        try:
            result = subprocess.run([sys.executable,'-B','-c',code,str(self.root)],
                                    cwd=ROOT,capture_output=True,timeout=5)
        except subprocess.TimeoutExpired:
            self.fail('artifact read blocked on nonregular file')
        self.assertEqual(result.returncode,0,result.stderr.decode())

    def test_symlink_artifact_and_root_escape_rejected(self):
        path = self.root/'source-catalog.json'
        original = self.root/'original.json'
        path.rename(original)
        path.symlink_to(original)
        self.failure(self.load,'NOT_READY')
        linked = self.root/'root-link'
        linked.symlink_to(self.root,target_is_directory=True)
        self.failure(lambda:self.api().load_release(linked,'synthetic-release'),'NOT_READY')

    def test_bad_catalog_text_hash_and_duplicate_evidence_invalid(self):
        record = self.fixture.catalog['records'][0]
        record['source_sha256'] = 'd'*64
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')
        record['source_sha256'] = sha(record['source_text'].encode())
        self.fixture.catalog['records'].append(copy.deepcopy(record))
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')

    def test_physical_field_and_source_identity_cannot_be_guessed(self):
        record = next(r for r in self.fixture.catalog['records'] if r['field']=='text')
        for field, value in [('physical_field','title'),('unit_id','foreign'),('doc_id','foreign'),('entity_type',NS+'Chunk')]:
            original = record[field]
            record[field] = value
            self.fixture.seal()
            self.failure(self.load,'NOT_READY')
            record[field] = original

    def test_missing_backend_reader_unavailable(self):
        self.failure(lambda:self.api().verify_native_sources(answered()[0],self.load(),None,AS_OF,'synthetic-webapp'),
                     'NOT_READY','unavailable')

    def test_backend_physical_identity_status_and_reader_binding_mismatch(self):
        for field, value in [('databaseID','foreign'),('serverID','foreign'),('name','foreign'),('currentStatus','offline')]:
            original = self.fixture.metadata[field]
            self.fixture.metadata[field] = value
            self.failure(self.verify)
            self.fixture.metadata[field] = original
        self.fixture.endpoint = 'http://other.invalid:7474'
        self.failure(self.verify)

    def test_four_online_exact_vector_indexes_required(self):
        for field, value in [('state','POPULATING'),('type','RANGE')]:
            original = self.fixture.vector_indexes[0][field]
            self.fixture.vector_indexes[0][field] = value
            self.failure(self.verify)
            self.fixture.vector_indexes[0][field] = original
        config = self.fixture.vector_indexes[0]['options']['indexConfig']
        for value in (True,1536,'3072'):
            config['vector.dimensions'] = value
            self.failure(self.verify)
        config['vector.dimensions'] = 3072
        config['vector.similarity_function'] = 'euclidean'
        self.failure(self.verify)
        config['vector.similarity_function'] = 'cosine'
        self.fixture.vector_indexes.append(copy.deepcopy(self.fixture.vector_indexes[0]))
        self.failure(self.verify)

    def test_changed_source_text_and_same_text_changed_metadata_rejected(self):
        props = self.fixture.nodes[NS+'LegalUnit','unit-1']['properties']
        for field, value in [('text','Changed'),('soHieu','Changed'),('docId','foreign')]:
            original = props[field]
            props[field] = value
            self.failure(self.verify)
            props[field] = original

    def test_missing_duplicate_ambiguous_readback_rejected(self):
        original = self.fixture.read_nodes
        for operation in (lambda keys:[], lambda keys:original(keys)*2):
            self.fixture.read_nodes = operation
            self.failure(self.verify)
        self.fixture.read_nodes = original
        self.fixture.nodes[NS+'LegalUnit','unit-1']['labels'].append(NS+'TrafficSign')
        self.failure(self.verify)

    def test_changed_relation_properties_or_endpoints_rejected(self):
        for operation in (lambda:self.fixture.edges[0]['properties'].update(sourceRecord='{}'),
                          lambda:self.fixture.edges[0]['to']['properties'].update(id='foreign')):
            original = copy.deepcopy(self.fixture.edges)
            operation()
            self.failure(self.verify)
            self.fixture.edges = original
        self.fixture.edges = []
        self.failure(self.verify)

    def test_wrong_native_identity_field_quote_and_spans_rejected(self):
        result, _ = answered()
        citation = result.citations[0]
        for changes in ({'doc_id':'foreign'},{'unit_id':None},{'sign_id':'foreign'},{'field':'title'},
            {'evidence_id':'a'*64},{'quote':citation.quote[:-1]+'x'},{'start':True},{'start':1},
            {'end':-1},{'end':len(citation.quote.encode('utf-8'))},{'end':str(citation.end)}):
            bad = replace(result,citations=(replace(citation,**changes),))
            self.failure(lambda:self.verify(bad))

    def test_native_result_type_invariants_rejected(self):
        for result in ({'answer':'x'},AnswerResult('x',[],False),AnswerResult('',(),True),
                       AnswerResult('x',(),False),AnswerResult('x',answered()[0].citations,True)):
            self.failure(lambda:self.verify(result),'INVALID_NATIVE_RESULT')

    def test_transport_exception_sanitized_unavailable(self):
        self.fixture.database_metadata = lambda:(_ for _ in ()).throw(RuntimeError('secret provider endpoint'))
        error = self.failure(self.verify,'NOT_READY','unavailable')
        self.assertNotIn('secret',str(error))
        self.assertIsNone(error.__cause__)

    def test_missing_publication_native_verified_java_ineligible(self):
        self.fixture.seal(publication=False)
        verified = self.verify(snapshot=None)
        self.assertEqual(verified.state.value,'verified')
        self.assertEqual(verified.publication_state.value,'unverified')
        self.assertFalse(verified.citations[0].java_eligible)
        with self.assertRaises(ApiFailure) as caught:
            project_v1(answered()[0],verified)
        self.assertEqual(caught.exception.code,'V1_RESULT_UNREPRESENTABLE')

    def test_publication_snapshot_date_timezone_and_source_binding_mismatch(self):
        for field, value in [('snapshot_id','foreign'),('source_snapshot_id','foreign'),
                             ('timezone','UTC'),('as_of','2026-10-07')]:
            original = self.fixture.publication[field]
            self.fixture.publication[field] = value
            self.fixture.seal()
            self.failure(self.verify,'NOT_READY')
            self.fixture.publication[field] = original
        self.fixture.seal()
        self.failure(lambda:self.verify(snapshot='foreign'),'NOT_READY')

    def test_unpublished_document_unit_and_replaces_not_java_eligible(self):
        for group, field in [('documents','published'),('documents','current_effective'),
                             ('documents','replaces_eligible'),('units','published')]:
            record = self.fixture.publication[group][0]
            record[field] = False
            self.fixture.seal()
            verified = self.verify()
            self.assertFalse(verified.citations[0].java_eligible)
            record[field] = True

    def test_publication_source_text_doc_and_effectivity_mismatch_rejected(self):
        for group, field, value in [('units','text_sha256','d'*64),('units','doc_id','foreign'),
                                  ('documents','effective_from','2021-01-01')]:
            record = self.fixture.publication[group][0]
            original = record[field]
            record[field] = value
            self.fixture.seal()
            self.failure(self.verify,'NOT_READY')
            record[field] = original

    def test_historical_native_date_no_java_publication_eligibility(self):
        self.fixture.seal(publication=False)
        self.assertFalse(self.verify(snapshot=None,as_of=date(2021,1,1)).citations[0].java_eligible)
        self.failure(lambda:self.verify(snapshot=None,as_of=date(2020,1,1)))

    def test_native_strict_effectivity_boundaries_use_existing_core(self):
        self.fixture.seal(publication=False)
        self.failure(lambda:self.verify(snapshot=None,as_of=date(2020,1,1)))
        self.failure(lambda:self.verify(snapshot=None,as_of=date(2019,1,1)))

    def test_datetime_and_string_as_of_rejected(self):
        for value in ('2026-10-08',datetime(2026,10,8)):
            self.failure(lambda:self.verify(as_of=value),'NOT_READY')

    def test_artifact_change_after_load_cannot_change_immutable_release(self):
        release = self.load()
        (self.root/'source-catalog.json').write_bytes(b'{}')
        self.failure(lambda:self.api()._unchanged(release),'NOT_READY')

    def test_backend_identity_checked_again_after_readback(self):
        original = self.fixture.database_metadata
        calls = []
        def changed():
            calls.append(1)
            value = original()
            if len(calls)>1:
                value['databaseID'] = 'changed-after-read'
            return value
        self.fixture.database_metadata = changed
        self.failure(self.verify)
        self.assertEqual(len(calls),2)

    def test_verified_certificates_are_immutable(self):
        verified = self.verify()
        with self.assertRaises(FrozenInstanceError):
            verified.citations = ()
        with self.assertRaises(FrozenInstanceError):
            verified.citations[0].java_eligible = True

    def test_same_native_order_all_citations_retained(self):
        unit = source()
        metadata = source('LegalDocument','document-1','effective_from','2020-01-01',unit_id=None)
        result, _ = answered(metadata,unit,metadata)
        verified = self.verify(result)
        self.assertEqual(tuple(v.citation for v in verified.citations),result.citations)
        self.assertEqual(len(verified.citations),3)

    def test_unknown_readback_flags_properties_and_labels_rejected(self):
        record = self.fixture.nodes[NS+'LegalUnit','unit-1']
        for field, value in [('stub',True),('_degraded','true'),('unknownProperty','x')]:
            record['properties'][field] = value
            self.failure(self.verify)
            record['properties'].pop(field)
        record['labels'].append('ForeignLabel')
        self.failure(self.verify)

    def test_missing_sign_unit_reference_cannot_be_verified(self):
        self.fixture.descriptor['release_kind'] = 'PRODUCTION'
        for record in self.fixture.catalog['records']:
            if record['entity_type'] == NS+'TrafficSign':
                record['unit_id'] = 'missing-unit'
                record['metadata']['unit_id'] = 'missing-unit'
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')

    def test_catalog_relation_properties_and_duplicates_rejected(self):
        record = self.fixture.catalog['records'][0]
        record['graph_context'][0]['properties'] = {'unknownProperty':'x'}
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')
        record['graph_context'][0]['properties'] = {}
        record['graph_context'].append(copy.deepcopy(record['graph_context'][0]))
        self.fixture.seal()
        self.failure(self.load,'NOT_READY')

    def test_unknown_edge_properties_and_endpoint_labels_rejected(self):
        edge = self.fixture.edges[0]
        edge['properties']['unknownProperty'] = 'x'
        self.failure(self.verify)
        edge['properties'].pop('unknownProperty')
        edge['to']['labels'].append('ForeignLabel')
        self.failure(self.verify)

    def test_empty_or_nontext_source_cannot_be_verified(self):
        record = next(r for r in self.fixture.catalog['records'] if r['field']=='text')
        for value in ('',None,1,True):
            record['source_text'] = value
            self.fixture.seal()
            self.failure(self.load,'NOT_READY')

    def test_expiry_partial_and_sign_effectivity_preserve_native_semantics(self):
        self.fixture.seal(publication=False)
        for field, value in [('effective_to','2026-10-08'),('hieu_luc_note','hết hiệu lực một phần')]:
            for record in self.fixture.catalog['records']:
                if record['entity_type'] == NS+'LegalDocument':
                    record['metadata'][field] = value
            self.fixture.nodes[NS+'LegalDocument','document-1']['properties'][
                'effectiveTo' if field=='effective_to' else 'hieuLucNote'] = value
            self.fixture.seal(publication=False)
            self.failure(lambda:self.verify(snapshot=None))
            for record in self.fixture.catalog['records']:
                if record['entity_type'] == NS+'LegalDocument':
                    record['metadata'].pop(field,None)
            self.fixture.nodes[NS+'LegalDocument','document-1']['properties'].pop(
                'effectiveTo' if field=='effective_to' else 'hieuLucNote')
        text = self.fixture.nodes[NS+'TrafficSign','sign-1']['properties']['moTa']
        result = answered(source('TrafficSign','sign-1','moTa',text,unit_id='unit-1',sign_id='sign-1'))[0]
        for record in self.fixture.catalog['records']:
            if record['entity_type'] == NS+'TrafficSign':
                record['metadata']['ngay_hieu_luc'] = AS_OF.isoformat()
        self.fixture.nodes[NS+'TrafficSign','sign-1']['properties']['ngayHieuLuc'] = AS_OF.isoformat()
        self.fixture.seal(publication=False)
        self.failure(lambda:self.verify(result,snapshot=None))

    def test_readback_failure_and_changed_indexes_after_read_unavailable(self):
        self.fixture.read_nodes = lambda keys:(_ for _ in ()).throw(RuntimeError('secret node transport'))
        self.failure(self.verify,'NOT_READY','unavailable')
        del self.fixture.read_nodes
        original = self.fixture.indexes
        calls = []
        def changed():
            calls.append(1)
            value = original()
            if len(calls)>1:
                value[0]['state'] = 'POPULATING'
            return value
        self.fixture.indexes = changed
        self.failure(self.verify)

    def test_schema_self_hash_checked_without_request_identity(self):
        from unittest.mock import patch
        api = self.api()
        original = api._read
        def bad(root, filename):
            raw = original(root,filename)
            if filename == 'schema_contract.json':
                value = json.loads(raw)
                value['runtime_contract']['schema_sha256'] = 'a'*64
                return raw_json(value)
            return raw
        with patch.object(api,'_read',side_effect=bad):
            self.failure(self.load,'NOT_READY')

    def test_fresh_module_import_does_not_initialize_core(self):
        self.api()
        code = "import sys; import kag.http_api.artifacts; assert 'kag.legal_solver' not in sys.modules; assert 'kag.bootstrap' not in sys.modules; assert 'knext' not in sys.modules"
        result = subprocess.run([sys.executable,'-B','-c',code],cwd=ROOT,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr.decode())

    def test_module_origins_and_upstream_registry_unchanged(self):
        from kag.bootstrap import initialize
        from kag.common.registry import Registrable
        registry = Registrable._registry
        entries = {base:dict(values) for base,values in registry.items()}
        self.verify()
        initialize()
        self.assertIs(Registrable._registry,registry)
        self.assertEqual(registry,entries)
        self.assertTrue(Path(__import__('inspect').getfile(Registrable)).resolve().is_relative_to(ROOT/'vendor/KAG'))
        self.assertTrue(Path(self.api().__file__).resolve().is_relative_to(ROOT/'kag/http_api'))


if __name__ == '__main__':
    unittest.main()
