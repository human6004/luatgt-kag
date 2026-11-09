"""Exact-ID demo eligibility and hand-calculated retrieval metrics."""
import importlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


class EvaluationTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.retriever.evaluation'),
                             'demo evaluation is not implemented')
        return importlib.import_module('kag.retriever.evaluation')

    def slice(self, records, keys):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory)/'source.jsonl', Path(directory)/'slice.jsonl'
            raw = b''.join((json.dumps(r,ensure_ascii=False)+'\r\n').encode() for r in records)
            source.write_bytes(raw)
            receipt = module.build_eval_slice(source, keys, target)
            self.assertEqual(source.read_bytes(),raw)
            return receipt, target.read_bytes(), raw

    def test_slice_requires_all_gold_exact_legal_unit_ids(self):
        rows = [{'id':'Q1','gold_unit_ids':['đơn-vị']},
                {'id':'Q2','gold_unit_ids':['đơn-vị','outside']},
                {'id':'Q3','gold_unit_ids':[]}, {'id':'Q4'},
                {'id':'Q5','gold_unit_ids':['sign']}]
        receipt, raw, _ = self.slice(rows,{('VietRoadTraffic.LegalUnit','đơn-vị'),
                                         ('VietRoadTraffic.TrafficSign','sign')})
        self.assertEqual([json.loads(line)['id'] for line in raw.splitlines()],['Q1'])
        self.assertEqual(receipt['original_questions'],5)
        self.assertEqual(receipt['questions_with_gold'],3)
        self.assertEqual(receipt['eligible_questions'],1)
        self.assertEqual([r['reason'] for r in receipt['excluded']],
                         ['gold_outside_sample','no_gold','no_gold','gold_outside_sample'])
        self.assertEqual(receipt['excluded'][0]['missing_gold_unit_ids'],['outside'])

    def test_slice_preserves_bytes_and_metadata(self):
        record = {'id':'Q1','cau_hoi':'Biển báo đường bộ?','loai':'biển_báo',
                  'nguon':'viết tay','gold_unit_ids':['đơn-vị'],'gold_verified':True}
        receipt, raw, original = self.slice([record],{('VietRoadTraffic.LegalUnit','đơn-vị')})
        self.assertEqual(raw,original)
        self.assertEqual(receipt['distributions']['eligible']['category'],{'biển_báo':1})
        self.assertEqual(receipt['distributions']['original']['source'],{'viết tay':1})
        self.assertEqual(len(receipt['slice_sha256']),64)

    def test_empty_slice_null_metrics(self):
        result = self.module().evaluate([],[],ks=(1,5,10))
        self.assertEqual(result['status'],'BLOCKED')
        self.assertEqual(result['overall']['questions'],0)
        self.assertIsNone(result['overall']['MRR'])
        self.assertIsNone(result['overall']['Hit@5'])
        self.assertIsNone(result['overall']['Recall@10'])

    def test_metrics_exact_identity_rank_and_duplicate_dedup(self):
        questions = [{'id':'Q1','gold_unit_ids':['đơn-vị','b'],'loai':'x','nguon':'tay'},
                     {'id':'Q2','gold_unit_ids':['c'],'loai':'y','nguon':'auto'}]
        predictions = [{'qid':'Q1','unit_ids':['wrong','đơn-vị','đơn-vị','b']},
                       {'qid':'Q2','unit_ids':['C','c']}]
        result = self.module().evaluate(questions,predictions,ks=(1,2,3))
        self.assertEqual(result['overall']['Hit@1'],0)
        self.assertEqual(result['overall']['Hit@2'],1)
        self.assertEqual(result['overall']['Recall@2'],0.75)
        self.assertEqual(result['overall']['Recall@3'],1)
        self.assertEqual(result['overall']['MRR'],0.5)
        self.assertEqual(result['by_category']['x']['Recall@2'],0.5)
        self.assertEqual(result['by_source']['tay']['questions'],1)

    def test_mrr_full_ranking_and_mrr_at_k(self):
        result = self.module().evaluate([{'id':'q','gold_unit_ids':['g']}],
            [{'qid':'q','unit_ids':['a','b','g']}],ks=(1,2))
        self.assertAlmostEqual(result['overall']['MRR'],1/3)
        self.assertEqual(result['overall']['MRR@2'],0)

    def test_unicode_identity_not_normalized(self):
        result = self.module().evaluate([{'id':'q','gold_unit_ids':['é']}],
            [{'qid':'q','unit_ids':['e\u0301']}],ks=(1,))
        self.assertEqual(result['overall']['Hit@1'],0)

    def test_missing_prediction_fails_instead_of_becoming_miss(self):
        with self.assertRaises(ValueError):
            self.module().evaluate([{'id':'q','gold_unit_ids':['g']}],[])

    def test_duplicate_qid_and_extra_predictions_refused(self):
        module = self.module()
        with self.assertRaises(ValueError):
            module.evaluate([{'id':'q','gold_unit_ids':['g']}]*2,
                            [{'qid':'q','unit_ids':[]}])
        with self.assertRaises(ValueError):
            module.evaluate([],[{'qid':'extra','unit_ids':[]}])

    def test_no_gold_metrics_and_malformed_gold_refused(self):
        module = self.module()
        with self.assertRaises(ValueError):
            module.evaluate([{'id':'q','gold_unit_ids':[]}],[{'qid':'q','unit_ids':[]}])
        with self.assertRaises(ValueError):
            self.slice([{'id':'q','gold_unit_ids':'not-a-list'}],set())

    def test_invalid_k_refused(self):
        module = self.module()
        for ks in ((),(0,),(True,),(1,1)):
            with self.subTest(ks=ks),self.assertRaises(ValueError):
                module.evaluate([],[],ks=ks)
