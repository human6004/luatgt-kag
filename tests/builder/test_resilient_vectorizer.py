"""Real pinned BatchVectorizer orchestration; only provider/schema dependencies fake."""
import copy
import functools
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from contextlib import contextmanager
from tempfile import TemporaryDirectory
from unittest.mock import patch

import test_writer_adapter as writer_tests
NODE, SUBGRAPH, ADAPTER = writer_tests.NODE, writer_tests.SUBGRAPH, writer_tests.ADAPTER

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'kag/builder/resilient_vectorizer.py'


class ProviderError(Exception):
    def __init__(self, status=None, code=None):
        self.status_code = status
        self.body = {'code': code, 'message': 'SECRET source text must never be saved'}


class FakeModel:
    timeout = 60
    def __init__(self, outcomes=()):
        self.outcomes = list(outcomes)
        self.calls = []

    def vectorize(self, texts):
        self.calls.append((list(texts), self.timeout))
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome if outcome is not None else [[1.0, 2.0, 3.0] for _ in texts]


def node(identity='A', text='Luật đường bộ – nguyên văn 🚦', kind='LegalUnit'):
    return {'type': 'VietRoadTraffic.' + kind, 'id': identity, 'name': identity,
            'properties': {'text': text, 'order': 7, 'sourceRecord': '[{"gốc":"Việt"}]'}}


@contextmanager
def pinned_boundary(model, batch_size=2):
    with patch.dict(sys.modules):
        def module(name, **values):
            obj = types.ModuleType(name)
            obj.__dict__.update(values)
            sys.modules[name] = obj
            return obj
        module('kag.builder.model.sub_graph', Node=NODE, SubGraph=SUBGRAPH)
        field = lambda p: {'moTa': '_mo_ta_vector'}.get(p, '_' + p + '_vector')
        module('kag.common.utils', get_vector_field_name=field,
               get_sparse_vector_field_name=lambda p: '_' + p + '_sparse')
        class ABC:
            @classmethod
            def register(cls, *args): return lambda value: value
        module('kag.interface', VectorizerABC=ABC, VectorizeModelABC=ABC, SparseVectorizeModelABC=ABC)
        module('knext.schema.client', SchemaClient=object)
        module('knext.schema.model.base', IndexTypeEnum=types.SimpleNamespace(
            Vector='Vector', TextAndVector='TextAndVector', SparseVector='SparseVector', TextAndSparseVector='TextAndSparseVector'))
        module('knext.common.base.runnable', Input=object, Output=object)
        def retry(**kwargs):
            def decorate(fn):
                @functools.wraps(fn)
                def call(*args, **kw): return fn(*args, **kw)
                return call
            return decorate
        module('tenacity', retry=retry, stop_after_attempt=lambda n: n)
        path = ROOT / 'vendor/KAG/kag/builder/component/vectorizer/batch_vectorizer.py'
        spec = importlib.util.spec_from_file_location('pinned_batch_for_recovery', path)
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        batch = native.BatchVectorizer.__new__(native.BatchVectorizer)
        batch.vectorize_model = model
        batch.sparse_vectorize_model = None
        batch.batch_size = batch_size
        batch.disable_generation = ['LegalDocument.name', 'LegalUnit.name', 'TrafficSign.name', 'Entity.name']
        batch.vec_meta = ({'LegalUnit': ['_name_vector', '_text_vector'],
            'LegalDocument': ['_name_vector', '_title_vector'],
            'TrafficSign': ['_name_vector', '_ten_vector', '_mo_ta_vector'], 'Entity': ['_name_vector']}, {})
        yield batch


class ResilientVectorizerTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(MODULE.exists(), 'project-local resilient vectorizer is missing')
        spec = importlib.util.spec_from_file_location('recovery_under_test', MODULE)
        self.code = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.code
        spec.loader.exec_module(self.code)
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.checkpoint = Path(self.tmp.name) / 'state.sqlite3'
        self.delays = []

    def make(self, batch, model='endpoint/model', dimension=3, **options):
        rv = self.code.ResilientVectorizer(batch, model_identity=model, dimension=dimension,
            checkpoint_path=self.checkpoint, sleep=self.delays.append, **options)
        self.addCleanup(rv.close)
        return rv

    def previous(self, spec, status=None, error='TimeoutError', code=None):
        return [{'node_type': spec['type'], 'node_id': spec['id'], 'property': 'text',
                 'http_status': status, 'error_class': error, 'code': code}]

    def test_immediate_success_uses_actual_pinned_batch_and_preserves_semantics(self):
        original = node()
        with pinned_boundary(FakeModel()) as batch:
            result = self.make(batch).run([original])
        self.assertTrue(result.complete)
        actual = list(result.iter_nodes())[0]
        self.assertEqual(actual['properties']['_text_vector'], [1.0, 2.0, 3.0])
        self.assertEqual({k:v for k,v in actual['properties'].items() if not k.startswith('_')}, original['properties'])
        self.assertEqual(result.provider_requests, 1)
        self.assertEqual(result.counts, {'successful': 1, 'skipped_empty': 0, 'failed_exhausted': 0})

    def test_timeout_recovers_single_job(self):
        provider = FakeModel([TimeoutError(), None])
        with pinned_boundary(provider) as batch:
            result = self.make(batch).run([node()])
        self.assertTrue(result.complete)
        self.assertEqual(self.delays, [2])
        self.assertEqual(result.provider_requests, 2)

    def test_503_recovers(self): self.check_transient(503)
    def test_429_recovers(self): self.check_transient(429)
    def test_404_routing_recovers(self): self.check_transient(404, 'MODEL_NOT_FOUND')

    def check_transient(self, status, code=None):
        with pinned_boundary(FakeModel([ProviderError(status, code), None])) as batch:
            result = self.make(batch).run([node()])
        self.assertTrue(result.complete)
        self.assertEqual(result.retry_requests, 1)
        self.assertEqual(self.delays, [2])

    def test_transient_exhaustion_is_bounded_and_unresolved(self):
        with pinned_boundary(FakeModel([ProviderError(503)] * 5)) as batch:
            engine = self.make(batch)
            with self.assertRaises(self.code.RunBlocked) as caught:
                engine.run([node()])
        self.assertEqual(caught.exception.code, 'VECTORS')
        self.assertEqual(engine.requests, 3)
        self.assertEqual(self.delays, [2, 5])
        job = engine._entry(next(engine._jobs([node()])))
        self.assertEqual(job['status'], 'PENDING')
        self.assertEqual(len(job['attempts']), 3)
        self.assertNotIn('SECRET', json.dumps(job))

    def test_batch_400_isolates_and_single_success(self):
        provider = FakeModel([ProviderError(400), None, None])
        with pinned_boundary(provider) as batch:
            result = self.make(batch).run([node('A', 'A text'), node('B', 'B text')])
        self.assertTrue(result.complete)
        self.assertEqual(provider.calls, [(['A text', 'B text'], 60), (['A text'], 60), (['B text'], 60)])
        self.assertTrue(all(j['classification'] == 'BATCH_OR_PROVIDER_TRANSIENT' for j in result.jobs))

    def test_single_400_is_deterministic_rejection_without_more_calls(self):
        with pinned_boundary(FakeModel([ProviderError(400)] * 5)) as batch:
            result = self.make(batch).run([node()])
        self.assertEqual(result.provider_requests, 2)
        self.assertEqual(result.jobs[0]['classification'], 'DETERMINISTIC_PROVIDER_REJECTION')
        self.assertEqual(self.delays, [])

    def test_large_timeout_uses_180_second_recovery(self):
        n = node(text='đ' * 100001)
        provider = FakeModel()
        with pinned_boundary(provider) as batch:
            result = self.make(batch).run([n], previous_failures=self.previous(n))
        self.assertTrue(result.complete)
        self.assertEqual(provider.calls[0][1], 180)

    def test_large_timeout_uses_300_final_and_stops(self):
        n = node(text='đ' * 100001)
        provider = FakeModel([TimeoutError()] * 4)
        with pinned_boundary(provider) as batch:
            result = self.make(batch).run([n], previous_failures=self.previous(n))
        self.assertFalse(result.complete)
        self.assertEqual([timeout for _,timeout in provider.calls], [180, 300])
        self.assertEqual(result.jobs[0]['classification'], 'PERSISTENT_LARGE_INPUT_TIMEOUT')
        self.assertEqual(result.jobs[0]['source_bytes'], 200002)

    def test_cached_success_is_never_resent_after_restart(self):
        provider = FakeModel()
        with pinned_boundary(provider) as batch:
            first = self.make(batch)
            first.run([node()]); first.close()
            result = self.make(batch).run([node()])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests, 0)
        self.assertEqual(len(provider.calls), 1)

    def test_changed_exact_source_invalidates_cache(self):
        provider = FakeModel()
        with pinned_boundary(provider) as batch:
            rv = self.make(batch)
            rv.run([node(text='é')])
            result = rv.run([node(text='e\u0301')])
        self.assertTrue(result.complete)
        self.assertEqual(len(provider.calls), 2)

    def test_changed_model_or_dimension_invalidates_cache(self):
        with pinned_boundary(FakeModel()) as batch:
            self.make(batch).run([node()])
            result = self.make(batch, model='different/model').run([node()])
        self.assertEqual(result.provider_requests, 1)
        with pinned_boundary(FakeModel([[[1.0, 2.0, 3.0, 4.0]]])) as batch:
            result = self.make(batch, dimension=4).run([node()])
        self.assertEqual(result.provider_requests, 1)

    def test_batch_later_failure_keeps_prior_success_checkpoint(self):
        provider = FakeModel([None, ProviderError(503), None])
        originals = [node('A','A'), node('B','B'), node('C','C')]
        with pinned_boundary(provider) as batch:
            result = self.make(batch).run(originals)
        self.assertTrue(result.complete)
        self.assertEqual([values for values,_ in provider.calls], [['A','B'], ['C'], ['C']])

    def test_resume_only_unresolved_uses_imported_valid_vectors(self):
        a, b = node('A','A'), node('B','B')
        artifact = copy.deepcopy(a); artifact['properties']['_text_vector'] = [1.0,2.0,3.0]
        provider = FakeModel()
        with pinned_boundary(provider) as batch:
            rv = self.make(batch)
            self.assertEqual(rv.import_successes([a,b], [artifact],
                artifact_model_identity='endpoint/model',artifact_dimension=3), 1)
            result = rv.run([a,b], previous_failures=self.previous(b,503,error='ProviderError'))
        self.assertTrue(result.complete)
        self.assertEqual(provider.calls, [(['B'],60)])

    def test_empty_value_matches_pinned_skip_and_name_vector_absent(self):
        n = node(text='')
        with pinned_boundary(FakeModel()) as batch:
            result = self.make(batch).run([n])
        self.assertTrue(result.complete)
        self.assertEqual(result.counts, {'successful':0,'skipped_empty':1,'failed_exhausted':0})
        self.assertEqual(result.provider_requests,0)
        self.assertNotIn('_name_vector',list(result.iter_nodes())[0]['properties'])
        self.assertNotIn('_text_vector',list(result.iter_nodes())[0]['properties'])

    def test_incomplete_result_cannot_supply_writer_nodes(self):
        with pinned_boundary(FakeModel([ProviderError(400)] * 2)) as batch:
            result = self.make(batch).run([node()])
        with self.assertRaises(self.code.IncompleteVectorization): result.require_complete()
        with self.assertRaises(self.code.IncompleteVectorization): list(result.iter_nodes())

    def test_unresolved_result_does_not_unlock_manifest_edge_barrier(self):
        with pinned_boundary(FakeModel([ProviderError(400)] * 2)) as batch:
            result = self.make(batch).run([node()])
        fixture = writer_tests.ManifestWriterScopeTest()
        with fixture.fixture() as (config, _, edges, _):
            writer = ADAPTER.NativeIntegerKGWriter(config, writer_tests.RecordingGraphClient(config))
            with self.assertRaises(self.code.IncompleteVectorization): result.require_complete()
            with self.assertRaises(ADAPTER.WriterAdapterError):
                writer.write_subgraph(ADAPTER.to_subgraphs(edges, 1, 'edges', config)[0], 'edges')
            self.assertEqual(writer.client.calls, [])

    def test_invalid_vector_is_explicit_exhausted_failure(self):
        for vector in ([0.0,0.0,0.0], [float('nan'),1.0,2.0], [1.0,2.0]):
            with self.subTest(vector=vector), pinned_boundary(FakeModel([[vector]])) as batch:
                result = self.make(batch).run([node('N'+str(len(vector)),str(vector))])
                self.assertFalse(result.complete)
                self.assertEqual(result.jobs[0]['classification'], 'INVALID_PROVIDER_VECTOR')

    def test_failed_sign_field_is_not_resent_when_other_field_unattempted(self):
        n = {'type':'VietRoadTraffic.TrafficSign','id':'S','name':'S',
             'properties':{'ten':'sign title','moTa':'sign description'}}
        provider = FakeModel([ProviderError(400),ProviderError(400),None])
        with pinned_boundary(provider,batch_size=1) as batch:
            result = self.make(batch).run([n])
        self.assertFalse(result.complete)
        self.assertEqual([texts for texts,_ in provider.calls], [['sign title'],['sign title'],['sign description']])
        self.assertEqual(result.counts, {'successful':1,'skipped_empty':0,'failed_exhausted':1})

    def test_unvalidated_input_vector_is_not_a_cache_success(self):
        n = node(); n['properties']['_text_vector'] = [9.0,9.0,9.0]
        with pinned_boundary(FakeModel()) as batch:
            result = self.make(batch).run([n])
        self.assertEqual(result.provider_requests,1)
        self.assertEqual(list(result.iter_nodes())[0]['properties']['_text_vector'],[1.0,2.0,3.0])

    def test_corrupted_cache_identity_cannot_reuse_foreign_vector(self):
        provider=FakeModel()
        with pinned_boundary(provider) as batch:
            rv=self.make(batch); rv.run([node()])
            key,state=rv.db.execute('SELECT identity,state FROM jobs').fetchone()
            value=json.loads(state); value['node_id']='foreign'
            rv.db.execute('UPDATE jobs SET state=? WHERE identity=?',(json.dumps(value),key));rv.db.commit()
            result=rv.run([node()])
        self.assertEqual(result.provider_requests,1)

    def test_missing_kag_target_is_explicit_failure_without_infinite_resume(self):
        with pinned_boundary(FakeModel()) as batch:
            batch.vec_meta=({}, {})
            result=self.make(batch).run([node()])
        self.assertFalse(result.complete)
        self.assertEqual(result.jobs[0]['classification'],'MISSING_KAG_VECTOR_TARGET')

    def test_restart_after_interruption_sends_only_unacknowledged_field(self):
        originals=[node('A','A'),node('B','B'),node('C','C')]
        provider=FakeModel([None,KeyboardInterrupt(),None])
        with pinned_boundary(provider) as batch:
            first=self.make(batch)
            with self.assertRaises(KeyboardInterrupt):first.run(originals)
            first.close()
            result=self.make(batch).run(originals)
        self.assertTrue(result.complete)
        self.assertEqual([values for values,_ in provider.calls],[['A','B'],['C'],['C']])
        self.assertEqual(result.provider_requests,1)

    def test_actual_pinned_adapter_swallowed_sdk_error_is_captured_without_logging(self):
        with pinned_boundary(FakeModel()) as batch:
            openai=types.ModuleType('openai')
            for name in ('OpenAI','AsyncOpenAI','AzureOpenAI','AsyncAzureOpenAI'):
                setattr(openai,name,object)
            sys.modules['openai']=openai
            sys.modules['kag.interface'].EmbeddingVector=list
            path=ROOT/'vendor/KAG/kag/common/vectorize_model/openai_model.py'
            spec=importlib.util.spec_from_file_location('pinned_openai_for_recovery',path)
            native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
            model=native.OpenAIVectorizeModel.__new__(native.OpenAIVectorizeModel)
            model.model='configured/model';model.timeout=60
            outcomes=[ProviderError(503,'SERVICE_UNAVAILABLE'),None]
            class Client:
                def with_options(self,**kwargs):
                    self.options=kwargs;return self
                @property
                def embeddings(self):return self
                def create(self,**kwargs):
                    outcome=outcomes.pop(0)
                    if outcome:raise outcome
                    return types.SimpleNamespace(data=[types.SimpleNamespace(embedding=[1.0,2.0,3.0]) for _ in kwargs['input']])
            model.client=Client();batch.vectorize_model=model
            with self.assertNoLogs('pinned_openai_for_recovery',level='ERROR'):
                result=self.make(batch).run([node()])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests,2)
        self.assertNotIn('SECRET',json.dumps(result.jobs))
        self.assertEqual(model.client.options['max_retries'],0)

    def test_unsafe_prior_provider_fields_are_not_written_to_checkpoint(self):
        prior=self.previous(node(),400,error='SECRET full source payload',code='SECRET api key')
        with pinned_boundary(FakeModel([ProviderError(400)])) as batch:
            result=self.make(batch).run([node()],previous_failures=prior)
        self.assertNotIn('SECRET',json.dumps(result.jobs))

    def test_canonical_model_with_required_singleton_new_args_is_composed_safely(self):
        class SingletonModel(FakeModel):
            def __new__(cls, endpoint):return object.__new__(cls)
            def __init__(self, endpoint):super().__init__()
        provider=SingletonModel('configured endpoint')
        with pinned_boundary(provider) as batch:
            result=self.make(batch).run([node()])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests,1)

    def test_previous_result_becomes_invalid_after_checkpoint_revision(self):
        with pinned_boundary(FakeModel()) as batch:
            rv=self.make(batch);old=rv.run([node(text='old')]);rv.run([node(text='new')])
            self.assertFalse(old.complete)
            with self.assertRaises(self.code.IncompleteVectorization):list(old.iter_nodes())

    def test_crash_at_large_180_resumes_at_300_not_default_timeout(self):
        n=node(text='x'*100001);provider=FakeModel([KeyboardInterrupt(),None])
        with pinned_boundary(provider) as batch:
            first=self.make(batch)
            with self.assertRaises(KeyboardInterrupt):first.run([n],previous_failures=self.previous(n))
            first.close();result=self.make(batch).run([n])
        self.assertTrue(result.complete)
        self.assertEqual([timeout for _,timeout in provider.calls],[180,300])

    def test_whitespace_collision_retains_native_mapping_and_source(self):
        originals=[node('A',' '),node('B','\t')];provider=FakeModel()
        with pinned_boundary(provider) as batch:
            result=self.make(batch).run(originals)
        self.assertTrue(result.complete)
        self.assertEqual(provider.calls,[(['none','none'],60)])
        self.assertEqual([n['properties']['text'] for n in result.iter_nodes()],[' ','\t'])

    def test_artifact_model_provenance_mismatch_is_rejected(self):
        original=node();artifact=copy.deepcopy(original);artifact['properties']['_text_vector']=[1.0,2.0,3.0]
        with pinned_boundary(FakeModel()) as batch:
            rv=self.make(batch)
            for identity,dimension in [('other/model',3),('endpoint/model',4)]:
                with self.subTest(identity=identity,dimension=dimension),self.assertRaises(ValueError):
                    rv.import_successes([original],[artifact],artifact_model_identity=identity,artifact_dimension=dimension)

    def test_crash_after_single_400_isolation_does_not_reset_budget(self):
        n=node();provider=FakeModel([KeyboardInterrupt(),None])
        with pinned_boundary(provider) as batch:
            first=self.make(batch)
            with self.assertRaises(KeyboardInterrupt):first.run([n],previous_failures=self.previous(n,400,error='ProviderError'))
            first.close();result=self.make(batch).run([n])
        self.assertFalse(result.complete)
        self.assertEqual(result.provider_requests,0)
        self.assertEqual(result.jobs[0]['classification'],'INTERRUPTED_SINGLE_VALUE_RECOVERY')


class LongTextFallbackTest(ResilientVectorizerTest):
    # Reuse provider/KAG boundary setup without inheriting the existing tests.
    def fallback(self, batch, **config):
        try:
            return self.make(batch, embedding_fallback={'enabled':True, 'max_chunk_chars':8,
                'overlap_chars':2, 'min_chunk_chars':2, 'max_split_depth':2, **config})
        except TypeError as error:
            self.fail('fallback configuration is not supported: '+str(error))

    def exhaust(self, rv, original):
        job = next(rv._jobs([original]));entry=rv._entry(job)
        entry.update(status='FAILED_EXHAUSTED', classification='RETRY_EXHAUSTED',
            attempts=[{'phase':'ORIGINAL','http_status':503,'error_class':'ProviderError','timeout_seconds':60}])
        with rv.db: rv._store(job,entry)

    def test_short_direct_success_does_not_chunk(self):
        with pinned_boundary(FakeModel()) as batch:
            result = self.fallback(batch).run([node(text='short')])
        self.assertEqual(result.provider_requests,1)
        self.assertEqual(result.jobs[0]['embedding_method'],'DIRECT')

    def test_exhausted_text_falls_back_and_preserves_all_semantics(self):
        original=node(text='abcdefghijklmnopqr');saved=copy.deepcopy(original)
        with pinned_boundary(FakeModel()) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original])
        self.assertTrue(result.complete)
        self.assertEqual(original,saved)
        emitted=list(result.iter_nodes())[0]
        self.assertEqual({k:v for k,v in emitted['properties'].items() if not k.startswith('_')},saved['properties'])
        self.assertNotIn('_name_vector',emitted['properties'])
        self.assertEqual(result.jobs[0]['embedding_method'],'CHUNK_AGGREGATED')
        self.assertEqual(result.jobs[0]['fallback']['initial_chunk_count'],3)
        self.assertEqual(result.jobs[0]['fallback']['final_chunk_count'],3)
        self.assertEqual(result.provider_requests,3)
        vector=emitted['properties']['_text_vector']
        self.assertEqual(len(vector),3)
        self.assertAlmostEqual(sum(v*v for v in vector),1.0)

    def test_non_legalunit_field_never_falls_back(self):
        original={'type':'VietRoadTraffic.LegalDocument','id':'D','name':'D','properties':{'title':'abcdefghijklmnop'}}
        with pinned_boundary(FakeModel([ProviderError(400)]*2)) as batch:
            result=self.fallback(batch).run([original])
        self.assertFalse(result.complete)
        self.assertEqual(result.provider_requests,2)
        self.assertNotIn('fallback',result.jobs[0])

    def test_failed_chunk_retries_without_resending_successful_sibling(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel([None,ProviderError(503),None,None])
        with pinned_boundary(provider) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests,4)
        self.assertEqual(result.retry_requests,1)
        self.assertEqual([x for x,_ in provider.calls],[['abcdefgh'],['ghijklmn'],['ghijklmn'],['mnop']])

    def test_failed_initial_chunk_splits_only_that_chunk(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel([None,ProviderError(400),ProviderError(400),None,None,None])
        with pinned_boundary(provider) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original])
        self.assertTrue(result.complete)
        self.assertEqual(result.jobs[0]['fallback']['final_chunk_count'],4)
        self.assertEqual([x for x,_ in provider.calls],[['abcdefgh'],['ghijklmn'],['ghijklmn'],['ghij'],['klmn'],['mnop']])

    def test_minimum_chunk_failure_locks_writer_gate(self):
        original=node(text='abcd');provider=FakeModel([ProviderError(400)]*20)
        with pinned_boundary(provider) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original])
        self.assertFalse(result.complete)
        self.assertEqual(result.jobs[0]['status'],'FALLBACK_INCOMPLETE')
        self.assertEqual(result.counts['failed_exhausted'],1)
        self.assertEqual(result.provider_requests,6)
        self.assertEqual(result.jobs[0]['fallback']['failed_chunks'],2)
        with self.assertRaises(self.code.IncompleteVectorization):list(result.iter_nodes())

    def test_depth_limit_is_bounded(self):
        original=node(text='abcdefgh');provider=FakeModel([ProviderError(400)]*50)
        with pinned_boundary(provider) as batch:
            rv=self.fallback(batch,max_split_depth=0);self.exhaust(rv,original);result=rv.run([original])
        self.assertEqual(result.provider_requests,2)
        self.assertFalse(result.complete)

    def test_successful_aggregate_survives_restart_without_calls(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel()
        with pinned_boundary(provider) as batch:
            first=self.fallback(batch);self.exhaust(first,original);first.run([original]);first.close()
            result=self.fallback(batch).run([original])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests,0)
        self.assertEqual(result.jobs[0]['embedding_method'],'CHUNK_AGGREGATED')

    def test_interrupted_fallback_resumes_only_unacknowledged_chunk(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel([None,KeyboardInterrupt(),None,None])
        with pinned_boundary(provider) as batch:
            first=self.fallback(batch);self.exhaust(first,original)
            with self.assertRaises(KeyboardInterrupt):first.run([original])
            first.close();result=self.fallback(batch).run([original])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests,2)
        self.assertEqual([x for x,_ in provider.calls],[['abcdefgh'],['ghijklmn'],['ghijklmn'],['mnop']])

    def test_changed_chunk_config_invalidates_only_aggregate(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel()
        with pinned_boundary(provider) as batch:
            first=self.fallback(batch);self.exhaust(first,original);first.run([original]);first.close()
            result=self.fallback(batch,max_chunk_chars=10).run([original])
        self.assertTrue(result.complete)
        self.assertEqual(result.provider_requests,2)
        self.assertTrue(all(len(x[0])<=10 for x,_ in provider.calls))

    def test_changed_overlap_or_version_invalidates_aggregate(self):
        original=node(text='abcdefghijklmnop')
        with pinned_boundary(FakeModel()) as batch:
            first=self.fallback(batch);self.exhaust(first,original);first.run([original]);first.close()
            second=self.fallback(batch,overlap_chars=0);result=second.run([original]);second.close()
            third=self.fallback(batch,overlap_chars=0,chunking_version='boundary_offsets_v2');changed=third.run([original])
        self.assertEqual(result.provider_requests,2)
        self.assertEqual(changed.provider_requests,2)

    def test_changed_source_cannot_reuse_old_aggregate(self):
        provider=FakeModel()
        with pinned_boundary(provider) as batch:
            rv=self.fallback(batch);original=node(text='abcdefgh');self.exhaust(rv,original);rv.run([original])
            result=rv.run([node(text='changed')])
        self.assertEqual(result.provider_requests,1)
        self.assertEqual(result.jobs[0]['embedding_method'],'DIRECT')

    def test_completed_fallback_unlocks_vector_result_but_not_full_manifest_edges(self):
        original=node(text='abcdefgh')
        with pinned_boundary(FakeModel()) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original])
        result.require_complete()
        fixture=writer_tests.ManifestWriterScopeTest()
        with fixture.fixture() as (config,_,edges,_):
            writer=ADAPTER.NativeIntegerKGWriter(config,writer_tests.RecordingGraphClient(config))
            with self.assertRaises(ADAPTER.WriterAdapterError):
                writer.write_subgraph(ADAPTER.to_subgraphs(edges,1,'edges',config)[0],'edges')

    def test_manifest_reports_hashes_and_offsets_without_source_or_vectors(self):
        original=node(text='abcdefghijklmno🚦')
        with pinned_boundary(FakeModel()) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original])
        manifest=result.jobs[0]['fallback']
        self.assertNotIn(original['properties']['text'],json.dumps(manifest))
        self.assertNotIn('vector',manifest['chunks'][0])
        self.assertEqual(manifest['chunks'][0]['start_offset'],0)
        self.assertEqual(manifest['chunks'][0]['end_offset'],8)
        self.assertEqual(manifest['chunks'][0]['chunk_chars'],8)

    def test_default_8000_failed_chunk_splits_but_successful_sibling_stays_cached(self):
        original=node(text='a'*8000+'b'*8000)
        provider=FakeModel([None,ProviderError(400),ProviderError(400),None,None,None])
        with pinned_boundary(provider) as batch:
            rv=self.make(batch,embedding_fallback={'enabled':True});self.exhaust(rv,original);result=rv.run([original])
        self.assertTrue(result.complete)
        manifest=result.jobs[0]['fallback']
        self.assertEqual(manifest['initial_chunk_count'],3)
        self.assertEqual(manifest['final_chunk_count'],4)
        self.assertEqual(manifest['chunks'][0]['effective_weight'],8000)
        self.assertEqual(sum(c['effective_weight'] for c in manifest['chunks']),16000)
        self.assertEqual([len(x[0]) for x,_ in provider.calls],[8000,8000,8000,4000,4000,1000])

    def test_legacy_direct_cache_gets_direct_provenance_without_provider_calls(self):
        original=node(text='short')
        with pinned_boundary(FakeModel()) as batch:
            rv=self.fallback(batch);rv.run([original])
            key,state=rv.db.execute('SELECT identity,state FROM jobs').fetchone();value=json.loads(state)
            value.pop('embedding_method');rv.db.execute('UPDATE jobs SET state=? WHERE identity=?',(json.dumps(value),key));rv.db.commit()
            result=rv.run([original])
        self.assertEqual(result.provider_requests,0)
        self.assertEqual(result.jobs[0].get('embedding_method'),'DIRECT')

    def test_corrupt_direct_failure_cannot_reuse_aggregate_after_config_change(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel()
        with pinned_boundary(provider) as batch:
            first=self.fallback(batch);self.exhaust(first,original);first.run([original])
            source_key=next(first._jobs([original]))['key']
            value=json.loads(first.db.execute('SELECT state FROM jobs WHERE identity=?',(source_key,)).fetchone()[0])
            value['direct_failure']['node_id']='foreign'
            first.db.execute('UPDATE jobs SET state=? WHERE identity=?',(json.dumps(value),source_key));first.db.commit();first.close()
            result=self.fallback(batch,max_chunk_chars=10).run([original])
        self.assertGreater(result.provider_requests,0)
        self.assertEqual(result.jobs[0]['node_id'],original['id'])

    def test_config_validation_bounds_requests_before_execution(self):
        with pinned_boundary(FakeModel()) as batch:
            for config in ({'max_split_depth':17},{'overlap_chars':8000},{'enabled':'true'}, {'min_chunk_chars':0}):
                with self.subTest(config=config), self.assertRaises(ValueError):
                    self.make(batch,embedding_fallback={'enabled':True,**config})

    def test_aggregated_dimension_3072_and_finite_l2_norm(self):
        import math
        original=node(text='abcdefghijklmnop');provider=FakeModel([[[1.0]*3072]]*3)
        with pinned_boundary(provider) as batch:
            rv=self.make(batch,dimension=3072,embedding_fallback={'enabled':True,'max_chunk_chars':8,
                'overlap_chars':2,'min_chunk_chars':2});self.exhaust(rv,original);result=rv.run([original])
        vector=list(result.iter_nodes())[0]['properties']['_text_vector']
        self.assertEqual(len(vector),3072)
        self.assertTrue(all(math.isfinite(x) for x in vector))
        self.assertAlmostEqual(math.hypot(*vector),1.0)

    def test_model_endpoint_and_dimension_changes_do_not_reuse_aggregate(self):
        original=node(text='abcdefgh')
        with pinned_boundary(FakeModel()) as batch:
            first=self.fallback(batch);self.exhaust(first,original);first.run([original]);first.close()
            changed=self.make(batch,model='other_endpoint/model',embedding_fallback={'enabled':True}).run([original])
        self.assertEqual(changed.provider_requests,1)
        self.assertEqual(changed.jobs[0]['embedding_method'],'DIRECT')
        with pinned_boundary(FakeModel([[[1.,2.,3.,4.]]])) as batch:
            changed=self.make(batch,model='other_endpoint/model',dimension=4,embedding_fallback={'enabled':True}).run([original])
        self.assertEqual(changed.provider_requests,1)
        self.assertEqual(len(list(changed.iter_nodes())[0]['properties']['_text_vector']),4)

    def test_adaptive_children_wholly_in_overlap_keep_complete_aggregate(self):
        original=node(text='abcdefghijklmnop');provider=FakeModel([None,ProviderError(400),ProviderError(400)])
        with pinned_boundary(provider) as batch:
            rv=self.fallback(batch,overlap_chars=6);self.exhaust(rv,original);result=rv.run([original])
        self.assertTrue(result.complete)
        manifest=result.jobs[0]['fallback']
        self.assertEqual(sum(c['effective_weight'] for c in manifest['chunks']),16)
        self.assertGreater(sum(c['effective_weight']==0 for c in manifest['chunks']),0)

    def test_import_same_aggregate_keeps_scientific_provenance_and_invalidation(self):
        original=node(text='abcdefghijklmnop')
        with pinned_boundary(FakeModel()) as batch:
            first=self.fallback(batch);self.exhaust(first,original);result=first.run([original])
            first.import_successes([original],list(result.iter_nodes()),
                artifact_model_identity='endpoint/model',artifact_dimension=3)
            imported=first.run([original]);first.close()
            changed=self.fallback(batch,max_chunk_chars=10).run([original])
        self.assertEqual(imported.jobs[0]['embedding_method'],'CHUNK_AGGREGATED')
        self.assertEqual(changed.provider_requests,2)

    def test_cold_import_aggregate_requires_matching_sidecar_provenance(self):
        original=node(text='abcdefghijklmnop')
        with pinned_boundary(FakeModel()) as batch:
            first=self.fallback(batch);self.exhaust(first,original);result=first.run([original])
            artifact=list(result.iter_nodes());records=copy.deepcopy(result.jobs);first.close();self.checkpoint.unlink()
            second=self.fallback(batch)
            second.import_successes([original],artifact,artifact_model_identity='endpoint/model',
                artifact_dimension=3,artifact_jobs=records)
            imported=second.run([original]);self.assertTrue(imported.complete);second.close()
            changed=self.fallback(batch,max_chunk_chars=10).run([original])
        self.assertEqual(imported.provider_requests,0)
        self.assertEqual(imported.jobs[0]['embedding_method'],'CHUNK_AGGREGATED')
        self.assertEqual(changed.provider_requests,2)

    def test_import_aggregate_sidecar_rejects_wrong_source_or_config(self):
        original=node(text='abcdefghijklmnop')
        with pinned_boundary(FakeModel()) as batch:
            first=self.fallback(batch);self.exhaust(first,original);result=first.run([original]);artifact=list(result.iter_nodes())
            records=copy.deepcopy(result.jobs);first.close();self.checkpoint.unlink()
            rv=self.fallback(batch)
            for key in ('source_sha256','fallback_config'):
                bad=copy.deepcopy(records);bad[0][key]='different'
                with self.subTest(key=key),self.assertRaises(ValueError):
                    rv.import_successes([original],artifact,artifact_model_identity='endpoint/model',
                        artifact_dimension=3,artifact_jobs=bad)

    def test_explicit_direct_sidecar_replaces_old_aggregate_provenance(self):
        original=node(text='abcdefghijklmnop')
        with pinned_boundary(FakeModel()) as batch:
            rv=self.fallback(batch);self.exhaust(rv,original);result=rv.run([original]);artifact=list(result.iter_nodes())
            artifact[0]['properties']['_text_vector']=[9.,8.,7.]
            records=copy.deepcopy(result.jobs);records[0]['embedding_method']='DIRECT'
            rv.import_successes([original],artifact,artifact_model_identity='endpoint/model',
                artifact_dimension=3,artifact_jobs=records)
            imported=rv.run([original])
        self.assertEqual(imported.jobs[0]['embedding_method'],'DIRECT')
        self.assertNotIn('fallback',imported.jobs[0])
        self.assertEqual(list(imported.iter_nodes())[0]['properties']['_text_vector'],[9.,8.,7.])


# The subclass reuses setup helpers only; don't count inherited direct-path tests twice.
for _name in list(ResilientVectorizerTest.__dict__):
    if _name.startswith('test_') and _name not in LongTextFallbackTest.__dict__:
        setattr(LongTextFallbackTest, _name, None)


if __name__ == '__main__': unittest.main()
