import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fixtures import module, record, load_fixture


def evidence(kind,identity,doc='d',anchor=None):
    return dict(entity_type='VietRoadTraffic.'+kind,entity_id=identity,doc_id=identity if kind=='LegalDocument' else doc,
                unit_id=identity if kind=='LegalUnit' else anchor,sign_id=identity if kind=='TrafficSign' else None,
                source_texts={'text':'synthetic'},score=.9,vector_sources=[],graph_context=[])


class LocalRetriever:
    search_k = 10
    def __init__(self,values=(),callback=None):
        self.values,self.calls,self.callback = list(values),[],callback
    def retrieve(self,question,**kwargs):
        self.calls.append((question,kwargs))
        if self.callback:
            self.callback()
        return self.values


class G1Tests(unittest.TestCase):
    def test_runtime_evidence_mutation_does_not_change_prior_rows(self):
        e,d,m = module('evaluate'),module('dataset'),module('models')
        shared=[evidence('LegalUnit','u1')]
        calls=[]
        def callback():
            if calls:
                shared[0].update(evidence('LegalUnit','u2'))
            calls.append(1)
        with tempfile.TemporaryDirectory() as temp:
            run=e.evaluate_g1(d.dataset_from_records([record(qid='a',gold_unit_ids=['u1']),record(qid='b',gold_unit_ids=['u2'])]),
                              LocalRetriever(shared,callback),m.EvaluationProtocol(),output_dir=Path(temp)/'run')
            first=run.rows[0]
            self.assertEqual(first.retrieval['evidence'][0]['unit_id'],'u1')
            self.assertEqual(first.retrieval['projections']['unit'],['u1'])
            self.assertEqual(first.metrics['unit.Recall@10'].value,1)

    def test_error_keeps_unscored_channels_outside_eligible_counts(self):
        e,d,m,r = module('evaluate'),module('dataset'),module('models'),module('report')
        def broken():
            raise ValueError('fixture')
        with tempfile.TemporaryDirectory() as temp:
            run=e.evaluate_g1(d.dataset_from_records([record(gold_unit_ids=['u'])]),LocalRetriever(callback=broken),
                              m.EvaluationProtocol(),output_dir=Path(temp)/'run')
            summary=r.summarize(run)
            for channel in ('document','sign'):
                metric=summary['overall'][channel+'.Recall@10']
                self.assertEqual(metric['eligible_count'],0)
                self.assertEqual(metric['failed_count'],0)
                self.assertEqual(metric['excluded_count'],1)
            self.assertEqual(summary['overall']['unit.Recall@10']['failed_count'],1)
            self.assertEqual(summary['failure_rate']['value'],1)

    def run_eval(self,records,retriever,protocol=None,**kwargs):
        e,d,m = module('evaluate'),module('dataset'),module('models')
        with tempfile.TemporaryDirectory() as temp:
            return e.evaluate_g1(d.dataset_from_records(records),retriever,protocol or m.EvaluationProtocol(),output_dir=Path(temp)/'run',**kwargs)

    def test_real_retriever_document_unit_sign_channels(self):
        module('evaluate')
        f = load_fixture('tests/retriever/test_retriever.py','eval_retriever_fixture')
        from kag.retriever.retriever import Retriever
        reader = f.ReadFixture()
        for kind,identity,prop,score in (('LegalDocument','d','title',.9),('TrafficSign','s','moTa',.8),('LegalUnit','u','text',.7)):
            reader.hits[kind,prop]=[{'id':identity,'score':score}]
            reader.nodes[f.LABEL+kind,identity]=f.node(kind,identity,doc='d')
        questions=[]
        def embed(q):
            questions.append(q)
            return f.VECTOR
        row = self.run_eval([record(question='  Đường?\n',gold_doc_ids=['d'],gold_unit_ids=['u'],gold_sign_ids=['s'])],Retriever(reader,embed,f.CONTRACT)).rows[0]
        self.assertEqual(questions,['  Đường?\n'])
        self.assertEqual([(k,p) for k,p,_,_ in reader.calls],[('LegalDocument','title'),('LegalUnit','text'),('TrafficSign','ten'),('TrafficSign','moTa')])
        for channel in ('document','unit','sign'):
            self.assertEqual(row.metrics[channel+'.MRR@1'].value,1)
        self.assertEqual(row.retrieval['returned_count'],3)

    def test_sign_anchor_never_unit_credit_and_projection_dedup(self):
        r = LocalRetriever([evidence('TrafficSign','s',anchor='u'),evidence('LegalUnit','x'),evidence('LegalUnit','x'),evidence('LegalUnit','u')])
        row = self.run_eval([record(gold_unit_ids=['u'],gold_sign_ids=['s'])],r).rows[0]
        self.assertEqual(row.metrics['unit.MRR@1'].value,0)
        self.assertEqual(row.metrics['unit.returned_top_k_MRR'].value,.5)
        self.assertEqual(row.retrieval['projections']['unit'],['x','u'])
        self.assertEqual(r.calls[0][1],{'top_k':10,'expand':False})
        row = self.run_eval([record(gold_unit_ids=['u'])],LocalRetriever([evidence('TrafficSign','s',anchor='u')])).rows[0]
        self.assertEqual(row.metrics['unit.Recall@10'].value,0)

    def test_no_gold_scope_and_abstention_eligibility(self):
        r = LocalRetriever()
        run = self.run_eval([record(),record(qid='q2',expected_abstain=True,gold_doc_ids=['d'])],r)
        self.assertEqual(len(run.rows),2)
        self.assertEqual(len(r.calls),1)
        self.assertEqual(run.rows[0].status,'INELIGIBLE')
        catalog = {'schema_version':'1.0','identities':{'document':['d'],'unit':['u'],'sign':[]}}
        d,m = module('dataset'),module('models')
        protocol = m.EvaluationProtocol.from_dict({'identity_catalog_hash':hashlib.sha256(d.canonical_line(catalog)).hexdigest()})
        r = LocalRetriever([evidence('LegalUnit','u')])
        row = self.run_eval([record(gold_unit_ids=['u','missing'])],r,protocol,identity_catalog=catalog).rows[0]
        self.assertFalse(r.calls)
        self.assertEqual(row.eligibility['unit']['missing_gold'],['missing'])
        self.assertIsNone(row.metrics['unit.Recall@10'].value)
        with self.assertRaises(m.ValidationError):
            self.run_eval([record()],r,identity_catalog=catalog)

    def test_invalid_cutoff_and_output_before_call(self):
        module('evaluate')
        r = LocalRetriever()
        r.search_k = 2
        with self.assertRaises(module('models').ValidationError):
            self.run_eval([record(gold_unit_ids=['u'])],r)
        self.assertFalse(r.calls)

    def test_g1_execution_failure_not_miss(self):
        def broken():
            raise ValueError('SECRET-MARKER')
        row = self.run_eval([record(gold_unit_ids=['u'])],LocalRetriever(callback=broken)).rows[0]
        self.assertEqual(row.status,'ERROR')
        self.assertIsNone(row.metrics['unit.MRR@1'].value)
        self.assertNotIn('SECRET-MARKER',str(row.to_dict()))
        self.assertEqual(row.error['type'],'ValueError')

    def test_snapshot_before_callback_source_mutation_and_failure(self):
        e,d,m,rp = module('evaluate'),module('dataset'),module('models'),module('report')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source,output=root/'source.jsonl',root/'run'
            payload=record(gold_unit_ids=['u'])
            source.write_bytes(d.canonical_line(payload))
            ds = d.load_dataset(source)
            def callback():
                self.assertEqual(json.loads((output/'run_manifest.json').read_bytes())['status'],'RUNNING')
                self.assertEqual((output/'dataset_snapshot.jsonl').read_bytes(),ds.canonical_bytes)
                payload['question']='new question'
                source.write_bytes(d.canonical_line(payload))
            retriever = LocalRetriever([evidence('LegalUnit','u')],callback)
            run = e.evaluate_g1(ds,retriever,m.EvaluationProtocol(),output_dir=output)
            self.assertEqual(run.rows[0].metrics['unit.Recall@10'].value,1)
            self.assertNotEqual(d.load_dataset(source).dataset_hash,ds.dataset_hash)
            retriever = LocalRetriever()
            with patch.object(rp,'write_new',side_effect=OSError()),self.assertRaises(OSError):
                e.evaluate_g1(ds,retriever,m.EvaluationProtocol(),output_dir=root/'broken')
            self.assertFalse(retriever.calls)


if __name__ == '__main__':
    unittest.main()
