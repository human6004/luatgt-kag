from dataclasses import replace
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from fixtures import module, record


class LifecycleTests(unittest.TestCase):
    def test_snapshot_precedes_first_callback(self):
        r,d,m = module('report'),module('dataset'),module('models')
        ds = d.dataset_from_records([record()])
        protocol = m.EvaluationProtocol()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/'run'
            ctx = r.start_run(ds,protocol,'G1',output)
            manifest = json.loads((output/'run_manifest.json').read_bytes())
            self.assertEqual(manifest['status'],'RUNNING')
            self.assertEqual(manifest['requested_count'],1)
            self.assertEqual(manifest['dataset_hash'],ds.dataset_hash)
            self.assertEqual(hashlib.sha256((output/'dataset_snapshot.jsonl').read_bytes()).hexdigest(),ds.dataset_hash)
            self.assertEqual(hashlib.sha256((output/'protocol.json').read_bytes()).hexdigest(),protocol.protocol_hash)
            self.assertFalse(manifest['official_benchmark'])
            self.assertFalse(manifest['paper_eligible'])
            r.verify_snapshot(ctx)

    def test_existing_dir_tamper_and_write_failure(self):
        r,d,m = module('report'),module('dataset'),module('models')
        ds,protocol = d.dataset_from_records([record()]),m.EvaluationProtocol()
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)/'run'
            ctx = r.start_run(ds,protocol,'G1',out)
            before = (out/'run_manifest.json').read_bytes()
            with self.assertRaises(FileExistsError):
                r.start_run(ds,protocol,'G1',out)
            self.assertEqual((out/'run_manifest.json').read_bytes(),before)
            (out/'dataset_snapshot.jsonl').write_bytes(b'bad')
            with self.assertRaises(m.ValidationError):
                r.verify_snapshot(ctx)
            with patch.object(Path,'open',side_effect=OSError('SECRET')),self.assertRaises(OSError):
                r.start_run(ds,protocol,'G1',Path(temp)/'broken')
            with self.assertRaises(m.ValidationError):
                r.start_run(replace(ds,dataset_hash='0'*64),protocol,'G1',Path(temp)/'invalid')
            self.assertFalse((Path(temp)/'invalid').exists())

    def test_provisional_mutation_and_safe_error(self):
        r,d,m = module('report'),module('dataset'),module('models')
        payload = record()
        ds = d.dataset_from_records([payload])
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)/'run'
            ctx = r.start_run(ds,m.EvaluationProtocol(),'G2',out)
            payload['question']='changed'
            self.assertNotEqual(d.dataset_from_records([payload]).dataset_hash,ds.dataset_hash)
            self.assertEqual((out/'dataset_snapshot.jsonl').read_bytes(),ds.canonical_bytes)
            r.mark_run_error(ctx,'STORAGE_ERROR')
            self.assertEqual(json.loads((out/'run_manifest.json').read_bytes())['status'],'ERROR')

    def test_offline_imports_no_sdk_or_network(self):
        module('report')
        script = """import sys
def deny(event,args):
    if event in ('socket.connect','socket.getaddrinfo'): raise AssertionError('network')
sys.addaudithook(deny)
import kag.evaluation.dataset, kag.evaluation.models, kag.evaluation.metrics, kag.evaluation.report, kag.evaluation.legacy, kag.evaluation.__main__
assert 'kag.legal_solver' not in sys.modules
assert 'kag.common.conf' not in sys.modules
"""
        result = subprocess.run([sys.executable,'-B','-c',script],capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr.decode())


class ReportTests(unittest.TestCase):
    def test_required_artifacts_provisional_labels_and_hashes(self):
        e,d,m,r = module('evaluate'),module('dataset'),module('models'),module('report')
        self.assertTrue(hasattr(r,'write_report'),'report export missing')
        from test_retrieval_eval import LocalRetriever,evidence
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)/'run'
            ds = d.dataset_from_records([record(qid='z'),record(qid='a',gold_unit_ids=['u'])])
            run = e.evaluate_g1(ds,LocalRetriever([evidence('LegalUnit','u')]),m.EvaluationProtocol(),output_dir=out)
            self.assertEqual(run.status,'COMPLETE')
            for name in ('results.jsonl','metrics.json','run_manifest.json','report.md','dataset_snapshot.jsonl','protocol.json'):
                self.assertTrue((out/name).is_file())
                self.assertNotIn(b'\r',(out/name).read_bytes())
            manifest = json.loads((out/'run_manifest.json').read_bytes())
            self.assertEqual(manifest['status'],'COMPLETE')
            self.assertNotIn('run_manifest.json',manifest['file_hashes'])
            for name,digest in manifest['file_hashes'].items():
                self.assertEqual(hashlib.sha256((out/name).read_bytes()).hexdigest(),digest)
            rows = [json.loads(line) for line in (out/'results.jsonl').read_bytes().splitlines()]
            self.assertEqual([row['qid'] for row in rows],['a','z'])
            self.assertEqual(rows[0]['question'],ds.records[1].question)
            self.assertEqual(rows[0]['dataset_hash'],ds.dataset_hash)
            self.assertFalse(rows[0]['official_benchmark'])
            self.assertFalse(rows[0]['paper_eligible'])
            self.assertNotIn('MRR',rows[0]['metrics'])
            report = (out/'report.md').read_text(encoding='utf-8')
            for label in ('DATASET_STATUS=PROVISIONAL','OFFICIAL_BENCHMARK=NO','PAPER_ELIGIBLE=NO'):
                self.assertIn(label,report)
            with self.assertRaises((FileExistsError,m.ValidationError)):
                r.write_report(run,out)

    def test_aggregate_denominators_null_categories_and_latency(self):
        r,m,d = module('report'),module('models'),module('dataset')
        self.assertTrue(hasattr(r,'summarize'),'summary missing')
        with tempfile.TemporaryDirectory() as temp:
            ds = d.dataset_from_records([record(qid='a'),record(qid='b',category='multi_hop'),record(qid='c'),record(qid='d')])
            ctx = r.start_run(ds,m.EvaluationProtocol(),'G2',Path(temp)/'run')
            rows = (m.QuestionResult('a','definition',status='SUCCESS',metrics={'quality':m.MetricValue(.5,'OK',1,2)},latency_ms=1),
                    m.QuestionResult('b','multi_hop',status='SUCCESS',metrics={'quality':m.MetricValue(1,'OK',20,20)},latency_ms=3),
                    m.QuestionResult('c','definition',status='ERROR',metrics={'quality':m.MetricValue(reason='EXECUTION_ERROR')},latency_ms=10),
                    m.QuestionResult('d','definition',metrics={'quality':m.MetricValue(status='NOT_APPLICABLE')}))
            result = r.summarize(m.EvaluationRun(ctx,rows))
            self.assertEqual(result['overall']['quality']['value'],.75)
            self.assertEqual(result['overall']['quality']['scored_count'],2)
            self.assertEqual(result['failure_rate']['value'],1/3)
            self.assertEqual(result['latency_ms']['all_attempted']['p95'],10)
            self.assertEqual(result['latency_ms']['successful']['median'],2)
            self.assertIsNone(result['by_category']['traffic_sign']['quality']['value'])

    def test_run_failure_publication_and_frozen_fixture_never_official(self):
        r,m,d,e = module('report'),module('models'),module('dataset'),module('evaluate')
        self.assertTrue(hasattr(r,'write_report'),'report export missing')
        from test_retrieval_eval import LocalRetriever,evidence
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            source=root/'s.jsonl'
            source.write_bytes(d.canonical_line(record(gold_unit_ids=['u'])))
            manifest=d.freeze_dataset(source,root/'frozen','synthetic-frozen')
            ds=d.load_dataset(manifest.with_name('eval_questions.jsonl'))
            run=e.evaluate_g1(ds,LocalRetriever([evidence('LegalUnit','u')]),m.EvaluationProtocol(),output_dir=root/'good')
            self.assertFalse(run.context.manifest['official_benchmark'])
            self.assertFalse(run.context.manifest['paper_eligible'])
            real_write=r.write_new
            def broken(path,raw):
                if path.name=='metrics.json':
                    raise OSError('SECRET')
                return real_write(path,raw)
            with patch.object(r,'write_new',side_effect=broken),self.assertRaises(OSError):
                e.evaluate_g1(ds,LocalRetriever([evidence('LegalUnit','u')]),m.EvaluationProtocol(),output_dir=root/'bad')
            manifest=json.loads((root/'bad'/'run_manifest.json').read_bytes())
            self.assertNotEqual(manifest['status'],'COMPLETE')
            self.assertNotIn('SECRET',str(manifest))


if __name__ == '__main__':
    unittest.main()
