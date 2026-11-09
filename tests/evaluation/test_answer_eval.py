import asyncio
from datetime import date
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fixtures import module, record, load_fixture


class G2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = load_fixture('tests/solver/test_legal_solver.py','eval_solver_fixture')

    def driver(self):
        e = module('evaluate')
        self.assertTrue(hasattr(e,'evaluate_g2'),'G2 adapter missing')
        return e

    def data(self,**kwargs):
        return module('dataset').dataset_from_records([record(as_of='2026-10-06',**kwargs)])

    def stub(self,result=None,error=None):
        from kag.interface import SolverPipelineABC
        class Pipeline(SolverPipelineABC):
            calls=[]
            async def ainvoke(self,question,**kwargs):
                self.calls.append((question,kwargs))
                if error:
                    raise error
                return result
        return Pipeline()

    def test_public_sync_async_positive(self):
        e = self.driver()
        text = 'Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.'
        ds = self.data(qid='PRIVATE-QID',question=self.fixture.PipelineTests.question,
                       citation_gold=[dict(doc_id='văn-bản',unit_id='đơn-vị',field='text',start=0,end=len(text),quote=text)],
                       answer_reference={'expected_answer':'PRIVATE-GOLD'})
        with tempfile.TemporaryDirectory() as temp:
            for asynchronous in (False,True):
                f,pipeline,llm = self.fixture.PipelineTests().pipeline()
                name = 'aanswer' if asynchronous else 'answer'
                with patch.object(f,name,wraps=getattr(f,name)) as spy:
                    out = Path(temp)/name
                    if asynchronous:
                        run = asyncio.run(e.aevaluate_g2(ds,pipeline,module('models').EvaluationProtocol(),output_dir=out))
                    else:
                        run = e.evaluate_g2(ds,pipeline,module('models').EvaluationProtocol(),output_dir=out)
                    self.assertEqual(spy.call_count,1)
                row = run.rows[0]
                self.assertEqual(row.status,'SUCCESS')
                self.assertFalse(row.answer_result['abstained'])
                self.assertEqual(row.answer_result['citations'][0]['quote'],text)
                self.assertEqual(row.metrics['citation_exact_recall'].value,1)
                self.assertIsNone(row.retrieval)
                self.assertIsNone(row.cost)
                self.assertIsNone(row.usage)
                self.assertNotIn('PRIVATE-GOLD',json.dumps(llm.prompts))
                self.assertNotIn('PRIVATE-QID',json.dumps(llm.prompts))

    def test_correct_wrong_abstention_and_citation_through_facade(self):
        e = self.driver()
        from kag.legal_solver import AnswerResult,Citation
        protocol = module('models').EvaluationProtocol()
        with tempfile.TemporaryDirectory() as temp:
            for i,(expected,actual) in enumerate(((True,True),(True,False),(False,True))):
                ds = self.data(expected_abstain=expected)
                row = e.evaluate_g2(ds,self.stub(AnswerResult('answer',(),actual)),protocol,output_dir=Path(temp)/str(i)).rows[0]
                self.assertEqual(row.metrics['abstention_accuracy'].value,float(expected == actual))
            ds = self.data(citation_gold=[dict(doc_id='d',unit_id='u',field='text',start=0,end=3,quote='one')])
            result = AnswerResult('answer',(Citation('d','u',None,'e','text',0,3,'bad'),),False)
            row = e.evaluate_g2(ds,self.stub(result),protocol,output_dir=Path(temp)/'wrong').rows[0]
            self.assertEqual(row.metrics['citation_source_recall'].value,1)
            self.assertEqual(row.metrics['citation_exact_recall'].value,0)

    def test_execution_failure_sanitized_and_as_of_required(self):
        e = self.driver()
        from kag.legal_solver import AnswerResult
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ds = module('dataset').dataset_from_records([record()])
            pipeline = self.stub(AnswerResult('answer',(),False))
            row = e.evaluate_g2(ds,pipeline,module('models').EvaluationProtocol(),output_dir=root/'missing').rows[0]
            self.assertEqual(row.status,'INELIGIBLE')
            self.assertIn('AS_OF_REQUIRED',row.reasons)
            self.assertFalse(pipeline.calls)
            row = e.evaluate_g2(self.data(),self.stub(error=ValueError('SECRET-MARKER')),module('models').EvaluationProtocol(),output_dir=root/'error').rows[0]
            self.assertEqual(row.status,'ERROR')
            self.assertIsNone(row.metrics['abstention_accuracy'].value)
            self.assertEqual(row.error['type'],'ValueError')
            self.assertNotIn('SECRET-MARKER',str(row.to_dict()))

    def test_sync_active_loop_and_cancellation(self):
        e = self.driver()
        from kag.legal_solver import AnswerResult
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            async def check():
                with self.assertRaises(RuntimeError):
                    e.evaluate_g2(self.data(),self.stub(AnswerResult('x',(),False)),module('models').EvaluationProtocol(),output_dir=root/'sync')
                self.assertFalse((root/'sync').exists())
                run = await e.aevaluate_g2(self.data(),self.stub(AnswerResult('x',(),False)),module('models').EvaluationProtocol(),output_dir=root/'async')
                self.assertEqual(run.rows[0].status,'SUCCESS')
                with self.assertRaises(asyncio.CancelledError):
                    await e.aevaluate_g2(self.data(),self.stub(error=asyncio.CancelledError()),module('models').EvaluationProtocol(),output_dir=root/'cancel')
                self.assertNotEqual(json.loads((root/'cancel'/'run_manifest.json').read_bytes())['status'],'COMPLETE')
            asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
