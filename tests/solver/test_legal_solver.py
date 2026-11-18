"""F contract tests use pinned KAG; only model/read transports are fake."""
import asyncio
import importlib
import importlib.util
import json
import logging
from datetime import date
from datetime import datetime
from pathlib import Path
import sys
import unittest


def deny_network(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo'):
        raise AssertionError('offline Solver tests must not access network')


sys.addaudithook(deny_network)
from kag.bootstrap import initialize
initialize()
logging.getLogger().setLevel(logging.ERROR)
from kag.interface import LLMClient

ROOT = Path(__file__).resolve().parents[2]
@LLMClient.register('f_test_llm')
class FakeLLM(LLMClient):
    def __init__(self, responses=None, **kwargs):
        super().__init__(enable_check=False, **kwargs)
        self.responses = list(responses or [])
        self.model = 'offline-fixture'
        self.prompts = []

    def __call__(self, *, messages):
        self.prompts.append(json.loads(messages[-1]['content']))
        if not self.responses:
            raise AssertionError('unexpected model call')
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response(self.prompts[-1])
        return response if isinstance(response, str) else json.dumps(response, ensure_ascii=False)


fixture_spec = importlib.util.spec_from_file_location('f_retrieval_fixture', ROOT/'tests/retriever/test_retriever.py')
retrieval_fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(retrieval_fixture)
from kag.retriever.retriever import Retriever


def fixture(text='Xe mô tô không được phép. Mức phạt 30.000.000 đồng.', identity='đơn-vị', **unit_properties):
    reader = retrieval_fixture.ReadFixture()
    reader.hits['LegalUnit', 'text'] = [{'id': identity, 'score': 0.9, 'index': 'text-index'}]
    unit = retrieval_fixture.node('LegalUnit', identity, text=text, doc='văn-bản')
    unit['properties'].update(unitType='article', soHieu='330/2026/NĐ-CP', **unit_properties)
    document = retrieval_fixture.node('LegalDocument', 'văn-bản', text='Văn bản nguồn')
    document['properties'].update(soHieu='330/2026/NĐ-CP', effectiveFrom='2020-01-01', scope='giao thông')
    reader.nodes['VietRoadTraffic.LegalUnit', identity] = unit
    reader.nodes['VietRoadTraffic.LegalDocument', 'văn-bản'] = document
    return reader, Retriever(reader, lambda q: retrieval_fixture.VECTOR, retrieval_fixture.CONTRACT)


class DirectAnswerTests(unittest.TestCase):
    def test_direct_pipeline_discards_unsupported_paragraph_and_keeps_exact_quote(self):
        module = importlib.import_module('kag.legal_solver')
        quote = 'Xe mô tô đi 300 ki-lô-mét; phạt 400.000 đồng.'
        _, retriever = fixture(text=quote)
        searches = []
        retriever.embed = lambda text: searches.append(text) or retrieval_fixture.VECTOR

        model = FakeLLM([{'mode': 'answer', 'answer': (
            'Đi 300 km; phạt 400000 đồng [1, 99].\n\n'
            'Phạt 500.000 đồng [1]. Ngoài ra người vi phạm bị xử lý [1].')}])
        pipeline = module.build_pipeline(retriever, model, search_queries=['xe mô tô đi 300 km'])
        result = module.answer('Xe mô tô đi thế nào?', pipeline=pipeline, as_of=date(2026, 4, 1))
        self.assertEqual((result.mode, result.answer), ('answer', 'Đi 300 km; phạt 400000 đồng [1].'))
        self.assertEqual([citation.quote for citation in result.citations], [quote])
        self.assertEqual(len(model.prompts), 1)
        self.assertEqual(len(searches), 2)

    def test_direct_numbers_ignore_units_and_normalize_formats(self):
        from kag.legal_solver import _answer_numbers

        pairs = (
            ('Chở theo 02 người', 'Chở theo hai người'),
            ('Đi 300 km', 'Đi 300 ki-lô-mét'),
            ('Dung tích 125 cm³', 'Dung tích 125 cm3'),
            ('Phạt 400.000 đồng', 'Phạt 400000 đồng'),
            ('Mốc 0,300 mg/l', 'Mốc 0.3 mg/l khí thở'),
            ('Có 60 km/h và 50 km/h', '| Tốc độ (km/h) |\n| 60 | 50 |'),
            ('Khoản năm: 06 năm', 'Khoản 5: sáu năm'),
            ('Mười người', '10 người'),
            ('Năm 2026', '2026'),
        )
        for left, right in pairs:
            with self.subTest(left=left, right=right):
                self.assertEqual(_answer_numbers(left), _answer_numbers(right))
        self.assertNotEqual(_answer_numbers('1,500'), _answer_numbers('1.500'))

    def test_direct_paragraph_combines_source_and_question_numbers(self):
        module = importlib.import_module('kag.legal_solver')
        _, retriever = fixture(text='Dải từ 10 km/h đến 20 km/h.')
        model = FakeLLM([{'mode':'answer', 'answer':'Vượt 15 km/h. Dải từ 10 đến 20 km/h [1].'}])
        result = module.answer('Xe mô tô vượt 15 km/h?', pipeline=module.build_pipeline(retriever, model))
        self.assertEqual(result.answer, 'Vượt 15 km/h. Dải từ 10 đến 20 km/h [1].')

    def test_missing_search_queries_remove_sanctions_and_keep_original(self):
        module = importlib.import_module('kag.legal_solver')
        _, retriever = fixture(text='Trừ 4 điểm.')
        queries = []
        retriever.embed = lambda text: queries.append(text) or retrieval_fixture.VECTOR
        question = 'xe máy vượt đèn đỏ bị trừ mấy điểm'
        module.answer(question, pipeline=module.build_pipeline(retriever, FakeLLM([
            {'mode':'answer','answer':'Trừ 4 điểm [1].'}])))
        self.assertEqual(queries, ['xe mô tô, xe gắn máy không chấp hành hiệu lệnh của đèn tín hiệu giao thông', question])
        from kag.legal_prompts import sanction_free_query
        for phrase in ('bị phạt', 'mức phạt', 'trừ điểm', 'mấy điểm', 'bao nhiêu điểm',
                       'tước bằng', 'tước giấy phép', 'giữ bằng', 'bao nhiêu tiền'):
            self.assertEqual(sanction_free_query('xe máy vượt đèn đỏ '+phrase), 'xe máy vượt đèn đỏ')

    def test_quantity_ranges_share_trailing_unit(self):
        module = importlib.import_module('kag.legal_solver')
        for unit in ('tháng', 'năm', 'ngày', 'km/h'):
            full = f'từ 10 {unit} đến 12 {unit}'
            for short in (f'từ 10 đến 12 {unit}', f'10-12 {unit}'):
                for source, answer in ((full, short), (short, full)):
                    with self.subTest(source=source,answer=answer):
                        _, retriever = fixture(text=source)
                        result = module.answer('Xe máy?', pipeline=module.build_pipeline(retriever,
                            FakeLLM([{'mode':'answer','answer':answer+' [1].'}])))
                        self.assertEqual(result.mode, 'answer')
        _, retriever = fixture(text='Tước từ 10 tháng đến 12 tháng.')
        result = module.answer('Xe máy?', pipeline=module.build_pipeline(retriever,
            FakeLLM([{'mode':'answer','answer':'Tước từ 10 đến 14 tháng [1].'}])))
        self.assertEqual(result.mode, 'related')

    def test_clarify_rejects_legal_claims_and_recovers_answer(self):
        module = importlib.import_module('kag.legal_solver')
        for text, expected in (('Phạt bảy triệu đồng.', 'related'), ('Có bị giữ xe.', 'related'),
                               ('Theo khoản hai.', 'related'), ('Bạn hỏi loại xe nào?', 'clarify')):
            with self.subTest(text=text):
                _, retriever = fixture(text='Phạt tiền từ 4.000.000 đồng đến 6.000.000 đồng.')
                model = FakeLLM([{'mode':'clarify', 'clarification':text}])
                result = module.answer('Xe máy vượt đèn đỏ?', pipeline=module.build_pipeline(retriever, model))
                self.assertEqual(result.mode, expected)
        _, retriever = fixture(text='Phạt tiền từ 4.000.000 đồng đến 6.000.000 đồng.')
        model = FakeLLM([{'mode':'clarify', 'clarification':'', 'answer':'Phạt 4 triệu đồng [1].'}])
        self.assertEqual(module.answer('Xe máy vượt đèn đỏ?',
            pipeline=module.build_pipeline(retriever, model)).mode, 'answer')

    def test_penalty_numbers_require_cited_sources(self):
        module = importlib.import_module('kag.legal_solver')
        cases = (
            ('Phạt 7 triệu đồng [1].', 'Xe máy vượt đèn đỏ?', 'related'),
            ('Phạt 7 tr [1].', 'Phạt 7 tr đúng không?', 'related'),
            ('Phạt 7tr [1].', 'Phạt 7tr đúng không?', 'related'),
            ('Phạt 20.000.000đ [1].', 'Phạt 20.000.000đ đúng không?', 'related'),
            ('Phạt từ 4 đến 6 triệu đồng [1].', 'Xe máy vượt đèn đỏ?', 'answer'),
            ('Phạt 20.000.000 đồng [1].', 'Phạt 20.000.000 đồng đúng không?', 'related'),
            ('Bị trừ 8 điểm [1].', 'Xe máy bị trừ 8 điểm đúng không?', 'related'),
            ('Bị tước 18 tháng [1].', 'Có bị tước 18 tháng không?', 'related'),
            ('Nộp thêm 20% [1].', 'Có nộp thêm 20% không?', 'related'),
            ('Vượt 15 km/h, phạt 4 triệu đồng [1].', 'Xe máy vượt 15 km/h?', 'answer'),
        )
        for text, question, expected in cases:
            with self.subTest(text=text):
                _, retriever = fixture(text='7. Phạt tiền từ 4.000.000 đồng đến 6.000.000 đồng.')
                result = module.answer(question, pipeline=module.build_pipeline(retriever,
                    FakeLLM([{'mode':'answer', 'answer':text}])))
                self.assertEqual(result.mode, expected)

    def test_issue_date_is_not_violation_date_and_future_keeps_current_source(self):
        module = importlib.import_module('kag.legal_solver')
        self.assertEqual(list(module._mentioned_dates(
            'Nghị định 168/2024/NĐ-CP ngày 26/12/2024, vi phạm ngày 02/02/2025')), [date(2025, 2, 2)])
        _, retriever = fixture(text='Phạt 4.000.000 đồng.')
        for question in ('Theo Nghị định 330/2026/NĐ-CP ngày 26/12/2024, xe máy bị phạt bao nhiêu?',
                         'Ngày 01/01/2099 xe máy bị phạt bao nhiêu?'):
            with self.subTest(question=question):
                result = module.answer(question, as_of=date(2026, 11, 18),
                    pipeline=module.build_pipeline(retriever, FakeLLM([{'mode':'answer','answer':'Phạt 4 triệu đồng [1].'}])))
                self.assertEqual(result.mode, 'answer')
                if '2099' in question:
                    self.assertIn('2026-11-18', result.answer)
                    self.assertIn('2099', result.answer)

    def test_period_filter_keeps_unknown_dates(self):
        from kag.legal_solver import _period_filter
        payload = {'documents': {'old':{'effective_to':'2025-01-01'}, 'unknown':{'het_hieu_luc_note':'Hết hiệu lực'}},
                   'items':[{'doc_id':'old'}, {'doc_id':'unknown'}]}
        self.assertEqual(_period_filter(payload,date(2026,11,18)),
                         {'documents':{'unknown':payload['documents']['unknown']}, 'items':[{'doc_id':'unknown'}]})

    def test_pack_evidence_keeps_parents(self):
        from kag.legal_solver import _pack_evidence, _source_texts
        def item(identity, score, parent=None):
            return {'entity_type':'Test.LegalUnit', 'entity_id':identity, 'doc_id':'doc', 'score':score,
                    'source_texts':{'text':identity * 20}, 'metadata':{'unit_type':'Khoan', 'parent_id':parent}}
        parent, high, low = item('parent',None), item('high',.9,'parent'), item('low',.1,'parent')
        payload = {'items':[low,parent,high], 'documents':{'doc':{'so_hieu':'168/2024/NĐ-CP'}}}
        limit = sum(map(len,_source_texts(dict(payload,items=[parent,high]))))
        packed = _pack_evidence(payload,limit)
        self.assertEqual({row['entity_id'] for row in packed['items']}, {'parent','high'})

    def test_pack_evidence_keeps_backlinks_before_lower_scoring_groups(self):
        from kag.legal_solver import _pack_evidence
        def item(identity,score):
            return dict(entity_type='Test.LegalUnit',entity_id=identity,doc_id='doc',score=score,
                        metadata={'unit_type':'Khoan'},source_texts={'text':identity})
        high,support=item('high',.9),item('support',None)
        items=[item('low'+str(i),.1) for i in range(25)]+[high,support]
        packed=_pack_evidence(dict(items=items,documents={'doc':{}}),24000,
            referrers={('Test.LegalUnit','high'):[('Test.LegalUnit','support')]})
        identities=[item['entity_id'] for item in packed['items']]
        self.assertEqual(identities[:2],['high','support'])
        self.assertLessEqual(len(identities),20)

    def test_effectivity_note_without_end_date(self):
        from kag.legal_solver import _effectivity
        item = {'doc_id':'doc','sign_id':None}
        documents = {'doc':{'effective_from':'2020-01-01','het_hieu_luc_note':'Văn bản hết hiệu lực'}}
        self.assertEqual(_effectivity(item,documents,date(2026,11,18)), 'blocked')

    def test_expired_requested_document(self):
        from types import SimpleNamespace
        from kag.legal_solver import expired_requested_document
        records = [SimpleNamespace(entity_type='Test.LegalDocument',
            metadata={'so_hieu':'100/2019/NĐ-CP','effective_to':'2025-01-01'})]
        self.assertEqual(expired_requested_document('Theo Nghị định 100/2019/NĐ-CP vượt đèn đỏ?',
            records,date(2026,11,18)).reason_code, 'expired')
        self.assertIsNone(expired_requested_document('Trích nguyên văn Điều 18 Nghị định 100/2019/NĐ-CP',
            records,date(2026,11,18)))

    def test_document_content_quotes_an_expired_source_without_legal_conclusion(self):
        module = importlib.import_module('kag.legal_solver')
        quote = 'Xe mô tô không đội mũ bảo hiểm: phạt 400.000 đồng.'
        reader, retriever = fixture(text=quote)
        reader.nodes['VietRoadTraffic.LegalDocument','văn-bản']['properties']['effectiveTo']='2026-01-01'

        model = FakeLLM([{'mode':'answer','citations':[1],'answer':'Không được xuất ra'}])
        result = module.answer(
            'Trích nội dung văn bản: Xe mô tô không đội mũ theo Nghị định 330/2026/NĐ-CP bị phạt sao?',
            pipeline=module.build_pipeline(retriever,model), as_of=date(2026, 4, 1))
        self.assertEqual(result.answer, module.DOCUMENT_CONTENT_ANSWER+quote)
        self.assertEqual(len(model.prompts), 1)



    def test_cases_drop_unsupported_case_without_orphaned_deduction(self):
        module = importlib.import_module('kag.legal_solver')
        _, retriever = fixture(text='Xe mô tô bị phạt 400.000 đồng và trừ 4 điểm.')
        model = FakeLLM([{'mode': 'cases', 'cases': [
            {'label': 'Xe máy', 'answer': 'Phạt 400.000 đồng [1].'},
            {'label': 'Ô tô', 'answer': 'Máu vượt 80 mg/100 ml; phạt 600.000 đồng. Ngoài ra trừ 4 điểm [1].'},
        ]}])
        result = module.answer('Uống rượu lái xe phạt sao?', pipeline=module.build_pipeline(retriever, model))
        self.assertEqual(result.mode, 'cases')
        self.assertIn('Xe máy\nPhạt 400.000 đồng [1].', result.answer)
        self.assertNotIn('trừ 4 điểm', result.answer)
        self.assertNotIn('Ô tô', result.answer)
        self.assertEqual(len(model.prompts), 1)

    def test_vehicle_filter_preserves_parent_scope_and_falls_back(self):
        module = importlib.import_module('kag.legal_solver')
        def item(identity, kind, text, parent=None):
            return dict(doc_id='doc', unit_id=identity, entity_type='Test.LegalUnit',
                        source_texts={'text': text}, metadata={'unit_type': kind, 'title': text, 'parent_id': parent})
        article = item('article', 'Dieu', 'Xử phạt người điều khiển xe máy chuyên dùng')
        clause = item('clause', 'Khoan', '1. Phạt 100.000 đồng', 'article')
        point = item('point', 'Diem', 'a) Không có bảo hiểm', 'clause')
        general = item('general', 'Khoan', '1. Quy định chung')
        car = item('car', 'Khoan', '1. Người điều khiển ô tô')
        items = [article, clause, point, general, car]
        self.assertEqual(module._filter_scope(items, 'Ô tô không có bảo hiểm'), [general, car])
        self.assertEqual(module._filter_scope(items[:3], 'Ô tô không có bảo hiểm'), items[:3])
        self.assertEqual(module._filter_scope(items, 'Không có bảo hiểm'), items)

    def test_scope_filter_excludes_driving_test_sources_unless_requested(self):
        from kag.legal_solver import _filter_scope
        article=dict(doc_id='exam',unit_id='article',entity_type='Test.LegalUnit',
            source_texts={'text':'Điều khoản thi hành. Phụ lục sát hạch lái xe.'},
            metadata={'unit_type':'Dieu','title':'Điều khoản thi hành','parent_id':None})
        exam=dict(doc_id='exam',unit_id='exam-unit',entity_type='Test.LegalUnit',
            source_texts={'text':'Vượt đèn đỏ bị trừ 10 điểm.'},
            metadata={'unit_type':'Khoan','parent_id':'article'})
        law=dict(doc_id='law',unit_id='licence',entity_type='Test.LegalUnit',
            source_texts={'text':'Điều 57. Hạng B lái xe ô tô.'},metadata={'unit_type':'Khoan'})
        items=[article,exam,law]
        self.assertEqual(_filter_scope(items,'xe máy vượt đèn đỏ bị trừ mấy điểm'),[law])
        self.assertIn(exam,_filter_scope(items,'thi bằng lái xe máy vượt đèn đỏ bị trừ bao nhiêu điểm'))
        self.assertEqual(_filter_scope(items,'giấy phép lái xe hạng B lái được xe gì'),[law])
        self.assertEqual(_filter_scope([article,exam],'xe máy vượt đèn đỏ'),[article,exam])
        street=dict(doc_id='street',unit_id='street',entity_type='Test.LegalUnit',
            source_texts={'text':'Xe mô tô vượt đèn đỏ phạt 4 triệu đồng.'},metadata={'unit_type':'Khoan'})
        self.assertNotIn(street,_filter_scope(items+[street],'thi bằng lái xe máy vượt đèn đỏ bị trừ bao nhiêu điểm'))
        self.assertIn(street,_filter_scope([exam,street],'cấp đổi giấy phép lái xe'))

    def test_retry_only_on_invalid_json(self):
        module = importlib.import_module('kag.legal_solver')
        _, retriever = fixture()
        model = FakeLLM(['invalid JSON', {'mode': 'answer', 'answer': 'Phạt 3.000.000 đồng [1].'}])
        result = module.answer('Xe mô tô phạt bao nhiêu?', pipeline=module.build_pipeline(retriever, model))
        self.assertEqual(result.mode, 'related')
        self.assertEqual(len(model.prompts), 2)

    def test_sync_async_contract(self):
        module = importlib.import_module('kag.legal_solver')
        _, retriever = fixture()
        model = FakeLLM([{'mode': 'answer', 'answer': 'Phạt 30 triệu đồng [1].'}] * 2)
        pipeline = module.build_pipeline(retriever, model)
        question = 'Xe mô tô bị phạt bao nhiêu?'
        sync = module.answer(question, pipeline=pipeline)
        async def run():
            with self.assertRaisesRegex(RuntimeError, 'aanswer'):
                module.answer(question, pipeline=pipeline)
            return await module.aanswer(question, pipeline=pipeline)
        self.assertEqual(asyncio.run(run()), sync)
        with self.assertRaises(ValueError):
            module.answer(question, pipeline=pipeline, as_of=datetime(2026, 10, 6))
