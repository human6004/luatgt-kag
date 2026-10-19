"""F contract tests use pinned KAG; only model/read transports are fake."""
import asyncio
import copy
import importlib
import importlib.util
import inspect
import json
import logging
import re
from datetime import date
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


def deny_network(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo'):
        raise AssertionError('offline Solver tests must not access network')


sys.addaudithook(deny_network)
from kag.bootstrap import initialize
initialize()
logging.getLogger().setLevel(logging.ERROR)
from kag.common.conf import KAG_PROJECT_CONF
from kag.interface import Context, LLMClient, PromptABC, Task
from kag.solver.planner.kag_iterative_planner import KAGIterativePlanner

ROOT = Path(__file__).resolve().parents[2]
PAIRS = [('30.000.000', '3.000.000'), ('30,5%', '305%'),
         ('Điều 13', 'Điều 31'), ('330/2026/NĐ-CP', '331/2026/NĐ-CP'),
         ('khoản 2', 'khoản 3'), ('không được phép', 'được phép')]


@LLMClient.register('f_test_llm')
class FakeLLM(LLMClient):
    def __init__(self, responses=None, **kwargs):
        super().__init__(enable_check=False, **kwargs)
        self.responses = list(responses or [])
        self.model = 'offline-fixture'
        self.prompts = []

    def __call__(self, prompt, **kwargs):
        self.prompts.append(json.loads(prompt))
        if not self.responses:
            raise AssertionError('unexpected model call')
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response(self.prompts[-1])
        return json.dumps(response, ensure_ascii=False)


def action(query='', executor='Retriever'):
    return {'executor': {'name': executor,
                         'arguments': {} if executor == 'Finish' else {'query': query},
                         'thought': 'Bước tiếp theo dựa trên bằng chứng.'}}


def candidate(selections=None, **overrides):
    value = {'abstained': False, 'applicability': 'supported',
             'effectivity': 'supported', 'conflict': 'none',
             'selections': selections or [], 'support_selections': []}
    value.update(overrides)
    return value


class PromptTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.legal_prompts'),
                             'local audited legal prompts missing')
        return importlib.import_module('kag.legal_prompts')

    def test_prompt_registry_vi_and_variables(self):
        module = self.module()
        before = KAG_PROJECT_CONF.language
        plan = PromptABC.from_config({'type': 'viet_legal_planning', 'language': 'vi'})
        deduce = PromptABC.from_config({'type': 'viet_legal_deduce', 'language': 'vi'})
        self.assertIsInstance(plan, module.LegalPlanningPrompt)
        self.assertEqual(plan.template_variables, ['context', 'executors', 'query'])
        self.assertEqual(deduce.template_variables, ['question', 'evidence', 'as_of'])
        self.assertEqual((plan.language, deduce.language), ('vi', 'vi'))
        self.assertEqual(KAG_PROJECT_CONF.language, before)

    def test_planning_task_shape_and_provenance_safe_subquery(self):
        plan = self.module().LegalPlanningPrompt(language='vi')
        original = 'Xe mô tô theo Nghị định 330/2026/NĐ-CP bị phạt và trừ điểm thế nào?'
        narrow = 'Mức phạt xe mô tô theo Nghị định 330/2026/NĐ-CP?'
        tasks = plan.parse_response(action(narrow), query=original, context=[])
        self.assertIsInstance(tasks[0], Task)
        self.assertEqual(tasks[0].executor, 'Retriever')
        self.assertEqual(tasks[0].arguments, {'query': narrow})
        self.assertNotEqual(narrow, original)
        second = 'Trừ điểm xe mô tô theo Nghị định 330/2026/NĐ-CP thế nào?'
        self.assertEqual(plan.parse_response(action(second, 'Deduce'),
                         query=original, context=[])[0].arguments, {'query': second})

    def test_subqueries_prior_grounding_and_mutation_rejection(self):
        module = self.module()
        original = 'Xe mô tô không được phép theo Điều 13 khoản 2 điểm b Nghị định 330/2026/NĐ-CP, ngày 01/07/2026, mức 30.000.000 đồng và 30,5%?'
        for left, right in PAIRS + [('xe mô tô', 'ô tô'), ('01/07/2026', '02/07/2026'),
                                   ('điểm b', 'điểm c')]:
            changed = original.replace(left, right) if left in original else original.replace(left.capitalize(), right)
            with self.subTest(pair=(left, right)), self.assertRaises(ValueError):
                module.validate_subquery(original, changed, ())
        basic = 'Xe mô tô bị phạt thế nào?'
        grounded = 'Xe mô tô bị phạt theo Điều 13 Nghị định 330/2026/NĐ-CP thế nào?'
        with self.assertRaises(ValueError):
            module.validate_subquery(basic, grounded, ())
        module.validate_subquery(basic, grounded,
            ('Điều 13 Nghị định 330/2026/NĐ-CP quy định mức phạt xe mô tô.',))
        with self.assertRaises(ValueError):
            module.validate_subquery(basic, 'Xe mô tô đã gây tai nạn và bị phạt thế nào?', ())
        with self.assertRaises(ValueError):
            module.validate_subquery(basic, 'Tổ chức bị phạt xe mô tô thế nào?', ())

    def test_planning_schema_strict_in_optimized_python(self):
        plan = self.module().LegalPlanningPrompt(language='vi')
        invalid = [[], {}, {'output': action('q'), 'gold': 'x'},
                   action('q', 'Math'), action('', 'Retriever'),
                   {'executor': {'name': 'Retriever', 'arguments': {'query': 'q', 'qid': '1'}}},
                   {'executor': {'name': 'Finish', 'arguments': {'query': 'q'}}},
                   {'executor': {'name': 'Retriever', 'arguments': {'query': 'q'}, 'category': 'x'}}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan.parse_response(value, query='q', context=[])
        self.assertEqual(plan.parse_response(action(executor='Finish'), query='q', context=[])[0].executor, 'Finish')

    def test_deduce_schema_strict(self):
        deduce = self.module().LegalDeducePrompt(language='vi')
        valid = candidate([{'evidence_id': 'source', 'field': 'text', 'start': 0, 'end': 9}])
        self.assertEqual(deduce.parse_response(valid), valid)
        for bad in [candidate(abstained=1), candidate(applicability='yes'),
                    candidate(effectivity='current'), candidate(conflict='newest'),
                    candidate(answer='30.000.000 đồng'), {'abstained': True},
                    candidate([{'evidence_id': 'source', 'field': 'text', 'start': True, 'end': 9}])]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                deduce.parse_response(bad)

    def test_deduce_explains_mandatory_resolution_support(self):
        deduce = self.module().LegalDeducePrompt(language='vi')
        text = json.loads(deduce.build_prompt({'question':'Xe mô tô?', 'evidence':{}, 'as_of':'2026-10-06'}))
        self.assertIn('conflict=resolved',text['instruction'])
        self.assertIn('phải có support_selections',text['instruction'])
        self.assertIn('parent_id',text['instruction'])
        self.assertIn('bắt buộc',text['instruction'])

    def test_unicode_and_meaning_pairs(self):
        module = self.module()
        planning, deduce = module.LegalPlanningPrompt(language='vi'), module.LegalDeducePrompt(language='vi')
        for source in ['  Điều 13 khoản 2 điểm b\n$', 'é', 'e\u0301', '"{"query":"$evidence"}"'] + [v for pair in PAIRS for v in pair]:
            text = json.loads(planning.build_prompt({'query': source, 'context': [], 'executors': []}))
            self.assertEqual(text['query'].encode(), source.encode())
            text = json.loads(deduce.build_prompt({'question': source, 'evidence': source, 'as_of': '2026-10-06'}))
            self.assertEqual(text['question'], source)
            self.assertEqual(text['evidence'], source)
            self.assertEqual(planning.parse_response(action(source), query=source, context=[])[0].arguments['query'], source)

    def test_real_upstream_planner_uses_local_parse(self):
        prompt = self.module().LegalPlanningPrompt(language='vi')
        llm = FakeLLM([action('Mức phạt xe mô tô?')])
        planner = KAGIterativePlanner(llm, prompt)
        tasks = asyncio.run(planner.ainvoke('Xe mô tô bị phạt và trừ điểm thế nào?', context=Context(), executors=[]))
        self.assertEqual(tasks[0].arguments['query'], 'Mức phạt xe mô tô?')
        self.assertTrue(Path(inspect.getfile(type(planner))).is_relative_to(ROOT/'vendor/KAG'))

    def test_planner_explains_unguarded_domain_defaults_are_not_premises(self):
        prompt = self.module().LegalPlanningPrompt(language='vi')
        rendered = json.loads(prompt.build_prompt({'query':'Xe mô tô bị phạt thế nào?',
                                                    'context':[], 'executors':[]}))
        self.assertIn('người điều khiển', rendered['instruction'])
        self.assertIn('vi phạm', rendered['instruction'])
        self.assertIn('từ nối', rendered['instruction'])
        for query in ('xử phạt vi phạm giao thông xe mô tô',
                      'xử phạt người điều khiển xe mô tô giao thông đường bộ'):
            with self.assertRaises(ValueError):
                prompt.parse_response(action(query), query=rendered['query'], context=[])

    def test_r1_preserves_reference_and_entity_clause_bindings(self):
        module = self.module()
        pairs = [
            ('Điều 13 khoản 2 và Điều 31 khoản 3', 'Điều 13 khoản 3 và Điều 31 khoản 2'),
            ('Nghị định 330/2026/NĐ-CP Điều 13; Nghị định 331/2026/NĐ-CP Điều 31',
             'Nghị định 330/2026/NĐ-CP Điều 31; Nghị định 331/2026/NĐ-CP Điều 13'),
            ('Xe mô tô không được phép chở hàng; ô tô được phép chở người',
             'Xe mô tô được phép chở người; ô tô không được phép chở hàng'),
            ('Công ty A chở hàng; Công ty B chở người',
             'Công ty A chở người; Công ty B chở hàng'),
            ('105_2026_TT_BCA::D13', '105_2026_TT_BCA::D31'),
            ('Tỷ lệ -30,5%?', 'Tỷ lệ 30,5%?')]
        for original, changed in pairs:
            with self.subTest(original=original), self.assertRaises(ValueError):
                module.validate_subquery(original, changed)
        original = 'Điều 13 khoản 2; Điều 31 khoản 3'
        module.validate_subquery(original, 'Điều 31 khoản 3; Điều 13 khoản 2')
        with self.assertRaises(ValueError):
            module.validate_subquery('Xe mô tô?', 'Xe mô tô theo Điều 13 khoản 3?',
                                     ('Xe mô tô Điều 13 khoản 2; Điều 31 khoản 3.',))
        module.validate_subquery('Xe mô tô theo khoản 2?', 'Xe mô tô theo khoản 2 Điều 13?',
                                 ('Xe mô tô Điều 13 khoản 2.',))
        with self.assertRaises(ValueError):
            module.validate_subquery('Xe mô tô?', 'Xe mô tô theo Điều 13 khoản 2 Nghị định 331/2026/NĐ-CP?',
                ('Nghị định 330/2026/NĐ-CP Điều 13 khoản 2.', 'Nghị định 331/2026/NĐ-CP Điều 31 khoản 3.'))


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


class AdapterTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('kag.legal_solver'), 'F E adapter missing')
        return importlib.import_module('kag.legal_solver')

    def invoke(self, reader=None, retriever=None, context=None, original='Xe mô tô bị phạt thế nào?', subquery='Mức phạt xe mô tô?'):
        module = self.module()
        if retriever is None:
            reader, retriever = fixture()
        context = context or Context()
        task = Task('Retriever', {'query': subquery})
        result = module.LegalRetrieverExecutor(retriever).invoke(original, task, context)
        context.append_task(task)
        return result, context, task

    def test_e_adapter_exact_provenance_and_metadata(self):
        reader, retriever = fixture(text='"$text"\nXe mô tô không được phép.', identity='é')
        before = copy.deepcopy(reader.nodes)
        seen = []
        retriever.embed = lambda q: (seen.append(q) or retrieval_fixture.VECTOR)
        response, context, task = self.invoke(reader, retriever)
        self.assertEqual(seen, ['Mức phạt xe mô tô?'])
        self.assertEqual([(kind, field) for kind, field, _, _ in reader.calls],
            [('LegalDocument', 'title'), ('LegalUnit', 'text'), ('TrafficSign', 'ten'), ('TrafficSign', 'moTa')])
        item = response.payload()['items'][0]
        self.assertEqual(item['source_texts'], {'text': '"$text"\nXe mô tô không được phép.'})
        self.assertEqual((item['entity_id'], item['unit_id'], item['doc_id']), ('é', 'é', 'văn-bản'))
        self.assertEqual(item['metadata']['unit_type'], 'article')
        self.assertEqual(response.payload()['documents']['văn-bản']['effective_from'], '2020-01-01')
        self.assertEqual(item['vector_sources'][0]['property'], 'text')
        self.assertEqual(reader.nodes, before)
        self.assertIs(task.result, response)
        self.assertIs(context.kwargs['legal_evidence'], response)
        self.assertIsInstance(response, importlib.import_module('kag.interface.solver.executor_abc').ExecutorResponse)

    def test_missing_conflicting_readback_fails_closed(self):
        module = self.module()
        for mode in ('missing_doc', 'duplicate_doc', 'bad_doc_name', 'changed_source', 'wrong_doc'):
            reader, retriever = fixture()
            real_read, reads = reader.read_nodes, []
            def read(keys):
                reads.append(keys)
                records = copy.deepcopy(real_read(keys))
                if len(reads) > 1:
                    if mode == 'missing_doc':
                        records = [r for r in records if r['properties']['id'] != 'văn-bản']
                    elif mode == 'duplicate_doc':
                        records += [r for r in records if r['properties']['id'] == 'văn-bản']
                    elif mode == 'bad_doc_name':
                        for r in records:
                            if r['properties']['id'] == 'văn-bản': r['properties']['name'] = 'khác'
                    else:
                        for r in records:
                            if r['properties']['id'] == 'đơn-vị':
                                r['properties']['text' if mode == 'changed_source' else 'docId'] = 'khác'
                return records
            reader.read_nodes = read
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.invoke(reader, retriever)

    def test_immutable_ledger_and_source_bound(self):
        module = self.module()
        response, context, _ = self.invoke()
        decoded = response.payload()
        decoded['items'][0]['source_texts']['text'] = '3.000.000'
        self.assertIn('30.000.000', response.payload()['items'][0]['source_texts']['text'])
        with self.assertRaises((AttributeError, TypeError)):
            response.snapshot = 'changed'
        for size, exceeded in ((48000, False), (48001, True)):
            reader, retriever = fixture(text='x'*size)
            for record in reader.nodes.values():
                for key, value in list(record['properties'].items()):
                    if key not in ('id', 'name', 'docId', 'text') and isinstance(value, str) and value != '{}':
                        record['properties'][key] = ''
            result, _, _ = self.invoke(reader, retriever)
            self.assertEqual(result.payload()['source_characters'], size)
            self.assertEqual(result.payload()['budget_exceeded'], exceeded)
        reader, retriever = fixture()
        first, ctx, _ = self.invoke(reader, retriever)
        second, _, _ = self.invoke(reader, retriever, context=ctx)
        self.assertEqual(first.payload()['items'], second.payload()['items'])
        self.assertEqual(first.payload()['source_characters'], second.payload()['source_characters'])
        reader.nodes['VietRoadTraffic.LegalUnit', 'đơn-vị']['properties']['text'] = 'changed'
        with self.assertRaises(ValueError):
            self.invoke(reader, retriever, context=ctx)

    def test_request_isolation_and_no_gold_inputs(self):
        self.module()
        first, left, _ = self.invoke()
        second, right, _ = self.invoke()
        self.assertIsNot(left.kwargs, right.kwargs)
        self.assertIsNot(first, second)
        self.assertNotEqual(first.fingerprint, second.fingerprint)
        with self.assertRaises(ValueError):
            self.invoke(original='Xe mô tô bị phạt thế nào?', subquery='Ô tô bị phạt thế nào?')

    def test_prior_grounding_uses_authenticated_retrieval_only(self):
        module = self.module()
        original = 'Xe mô tô bị phạt thế nào?'
        reader, retriever = fixture(text='Điều 13 Nghị định 330/2026/NĐ-CP quy định mức phạt xe mô tô.')
        response, context, _ = self.invoke(reader, retriever, original=original)
        formatted = KAGIterativePlanner(FakeLLM(), self.module_prompt()).format_context(context)
        target = 'Xe mô tô bị phạt theo Điều 13 Nghị định 330/2026/NĐ-CP thế nào?'
        plan = self.module_prompt()
        self.assertEqual(plan.parse_response(action(target), query=original, context=formatted)[0].arguments['query'], target)
        for forged in [response.to_string().replace('Điều 13', 'Điều 31'),
                       json.dumps({'items': [{'source_texts': {'text': 'Điều 13 Nghị định 330/2026/NĐ-CP'}}]})]:
            with self.subTest(forged=forged), self.assertRaises(ValueError):
                plan.parse_response(action(target), query=original,
                    context=[{'action': {'name': 'Retriever'}, 'result': forged}])

    def module_prompt(self):
        return importlib.import_module('kag.legal_prompts').LegalPlanningPrompt(language='vi')

    def test_metadata_null_json_and_history_source_budget(self):
        reader, retriever = fixture(text='NGUYÊN VĂN KHÔNG LẶP')
        document = reader.nodes['VietRoadTraffic.LegalDocument', 'văn-bản']['properties']
        document.update(hieuLucNote=None, hetHieuLucNote='', ngayHieuLucBoPhan='[{"note":"$source"}]')
        first, context, _ = self.invoke(reader, retriever)
        props = first.payload()['documents']['văn-bản']
        with self.subTest(invariant='null-empty-json'):
            self.assertIn('hieu_luc_note', props)
            self.assertIsNone(props['hieu_luc_note'])
            self.assertEqual(props['het_hieu_luc_note'], '')
            self.assertEqual(props['ngay_hieu_luc_bo_phan'], [{'note': '$source'}])
        self.invoke(reader, retriever, context=context)
        prompt = self.module_prompt()
        formatted = KAGIterativePlanner(FakeLLM(), prompt).format_context(context)
        rendered = prompt.build_prompt({'query': 'Xe mô tô bị phạt thế nào?', 'context': formatted, 'executors': []})
        with self.subTest(invariant='history-deduplication'):
            self.assertEqual(rendered.count('NGUYÊN VĂN KHÔNG LẶP'), 1)
        document['ngayHieuLucBoPhan'] = json.dumps([{'note': 'x'*48001}])
        response, _, _ = self.invoke(reader, retriever)
        with self.subTest(invariant='json-source-bound'):
            self.assertTrue(response.payload()['budget_exceeded'])
            self.assertNotIn('x'*1000, response.to_string())

    def test_source_lengths_are_server_derived_unicode_offsets(self):
        reader, retriever = fixture(text='Aé\n')
        response, _, _ = self.invoke(reader, retriever)
        self.assertEqual(response.payload()['items'][0]['source_lengths'], {'text': 3})

    def test_grounded_metadata_references_reach_real_planner_and_executor(self):
        module=self.module()
        reader,retriever=fixture(text='Xe mô tô.',dieuNumber='13',khoanNumber='2')
        reader.nodes['VietRoadTraffic.LegalDocument','văn-bản']['properties']['loai']='Nghị định'
        question='Xe mô tô bị phạt thế nào?'
        response,ctx,_=self.invoke(reader,retriever,original=question)
        prompt=importlib.import_module('kag.legal_prompts').LegalPlanningPrompt(language='vi')
        subquery='Xe mô tô bị phạt theo Điều 13 khoản 2 Nghị định 330/2026/NĐ-CP?'
        history=KAGIterativePlanner(FakeLLM(),prompt).format_context(ctx)
        task=prompt.parse_response(action(subquery),query=question,context=history)[0]
        refreshed=module.LegalRetrieverExecutor(retriever).invoke(question,task,ctx)
        self.assertEqual(refreshed.payload()['items'],response.payload()['items'])
        self.assertEqual(task.arguments['query'],subquery)


class SafetyTests(unittest.TestCase):
    def test_sign_primary_code_and_traffic_organization_verb(self):
        module = self.module()
        for code, expected, phrase in (('DP.127', False, 'tổ chức giao thông'),
                                       ('DP.135', True, 'báo hiệu đường bộ')):
            question = 'Biển '+code+' có ý nghĩa gì?'
            reader, retriever = fixture()
            sign = retrieval_fixture.node('TrafficSign', 'sign',
                text='Biển DP.127 có ý nghĩa hết tốc độ tối đa theo phương án '+phrase+'. '
                     'Trường hợp hết tất cả lệnh cấm dùng DP.135.', doc='văn-bản')
            sign['properties'].update(maBien='DP.127', ngayHieuLuc='2020-01-01')
            reader.nodes['VietRoadTraffic.TrafficSign', 'sign'] = sign
            reader.hits = {('TrafficSign', 'moTa'): [{'id':'sign','score':0.9,'index':'sign-index'}]}
            ctx = Context()
            module.LegalRetrieverExecutor(retriever).invoke(question, Task('Retriever',{'query':question}),ctx)
            result, _, _ = self.render(module,ctx,question,candidate([self.selected(ctx,source_field='moTa')]))
            with self.subTest(code=code):
                self.assertEqual(result.abstained, expected)
        # Organization as regulated subject must still fail closed.
        module, _, _, ctx, question = self.prepare(
            text='Tổ chức dùng xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        result, _, _ = self.render(module,ctx,question,candidate([self.selected(ctx)]))
        self.assertTrue(result.abstained)

    def module(self):
        module = importlib.import_module('kag.legal_solver')
        self.assertTrue(hasattr(module, 'LegalDeduceExecutor'), 'evidence-only LegalDeduce missing')
        self.assertTrue(hasattr(module, 'SafeLegalGenerator'), 'safe GeneratorABC missing')
        return module

    def prepare(self, text='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.',
                question='Xe mô tô không đội mũ bảo hiểm bị phạt bao nhiêu?', **properties):
        module = self.module()
        reader, retriever = fixture(text=text, **properties)
        ctx = Context()
        task = Task('Retriever', {'query': question})
        module.LegalRetrieverExecutor(retriever).invoke(question, task, ctx)
        ctx.append_task(task)
        return module, reader, retriever, ctx, question

    def selected(self, context, index=0, source_field='text', **overrides):
        item = context.kwargs['legal_evidence'].payload()['items'][index]
        span = {'evidence_id': item['evidence_ids'][source_field], 'field': source_field,
                'start': 0, 'end': len(item['source_texts'][source_field])}
        span.update(overrides)
        return span

    def render(self, module, context, question, value, llm=None):
        llm = llm or FakeLLM([value])
        executor = module.LegalDeduceExecutor(llm, importlib.import_module('kag.legal_prompts').LegalDeducePrompt(language='vi'))
        task = Task('Deduce', {'query': question})
        executor.invoke(question, task, context, as_of=date(2026, 10, 6))
        context.append_task(task)
        result = module.SafeLegalGenerator().invoke(question, context, as_of=date(2026, 10, 6))
        return result, llm, task

    def test_empty_insufficient_or_stale_deduce_abstains(self):
        module = self.module()
        for ctx in (Context(),):
            task = Task('Deduce', {'query': 'Xe mô tô?'})
            task.thought = 'Phạt 30.000.000 theo luật tưởng tượng.'
            ctx.append_task(task)
            result, llm, _ = self.render(module, ctx, 'Xe mô tô?', candidate())
            self.assertTrue(result.abstained)
            self.assertEqual(result.to_dict()['citations'], [])
            self.assertEqual(llm.prompts, [])
        module, reader, retriever, ctx, question = self.prepare()
        result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)], applicability='insufficient'))
        self.assertTrue(result.abstained)
        result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
        self.assertFalse(result.abstained)
        latest = Task('Retriever', {'query': question})
        module.LegalRetrieverExecutor(retriever).invoke(question, latest, ctx)
        ctx.append_task(latest)
        self.assertTrue(module.SafeLegalGenerator().invoke(question, ctx, as_of=date(2026, 10, 6)).abstained)
        fresh = Context()
        fresh.append_task(Task('Finish', {}))
        self.assertTrue(module.SafeLegalGenerator().invoke(question, fresh, as_of=date(2026, 10, 6)).abstained)

    def test_forged_identity_and_offsets_abstain(self):
        module, _, _, ctx, question = self.prepare()
        for override in ({'evidence_id': 'invented'}, {'field': 'missing'},
                         {'start': -1}, {'end': 99999}, {'start': 20, 'end': 1}, {'end': 0}):
            with self.subTest(override=override):
                result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx, **override)]))
                self.assertTrue(result.abstained)
                self.assertEqual(result.to_dict()['citations'], [])
        with self.assertRaises(RuntimeError):
            self.render(module, ctx, question, candidate([self.selected(ctx, start=True)]))
        for extra in ({'quote': '3.000.000 đồng'}, {'doc_id': 'invented'}, {'answer': 'được phép'}):
            with self.assertRaises(RuntimeError):
                self.render(module, ctx, question, candidate([self.selected(ctx)], **extra))

    def test_server_spans_preserve_numbers_negation_and_context(self):
        for left, right in PAIRS:
            source = 'Xe mô tô không đội mũ bảo hiểm: '+left+'.'
            module, _, _, ctx, question = self.prepare(text=source)
            result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
            self.assertFalse(result.abstained, left)
            self.assertEqual(result.to_dict()['citations'][0]['quote'].encode(), source.encode())
            self.assertIn(left, result.answer)
            self.assertNotEqual(result.to_dict()['citations'][0]['quote'],
                                'Xe mô tô không đội mũ bảo hiểm: '+right+'.')
            result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx, start=len('Xe mô tô không đội mũ bảo hiểm: '))]))
            self.assertTrue(result.abstained)
        source = 'Xe mô tô không đội mũ bảo hiểm; khoản 2 Điều 13 điểm b, 01/07/2026. é e\u0301 $text'
        module, _, _, ctx, question = self.prepare(text=source)
        result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
        self.assertEqual(result.to_dict()['citations'][0]['quote'], source)

    def test_effectivity_and_conflict_gates(self):
        self.module()
        for props in ({'effectiveFrom': '2027-01-01'}, {'effectiveTo': '2026-01-01'},
                      {'effectiveTo': '2026-10-06'}, {'effectiveFrom': None},
                      {'effectiveFrom': '01/01/2020'}, {'ngayHieuLucBoPhan': '[{"unit":"unknown"}]'},
                      {'hieuLucNote': 'Một phần có hiệu lực vào ngày khác.'},
                      {'consolidationAsOf': '2026-01-01'}):
            module, reader, retriever, ctx, question = self.prepare()
            reader.nodes['VietRoadTraffic.LegalDocument', 'văn-bản']['properties'].update(props)
            ctx = Context()
            task = Task('Retriever', {'query': question})
            module.LegalRetrieverExecutor(retriever).invoke(question, task, ctx)
            ctx.append_task(task)
            result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
            with self.subTest(props=props): self.assertTrue(result.abstained)
        module, _, _, ctx, question = self.prepare()
        for flags in ({'conflict': 'unresolved'}, {'conflict': 'resolved'}, {'effectivity': 'uncertain'}):
            result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)], **flags))
            self.assertTrue(result.abstained)

    def test_explicit_document_content_keeps_grounding_without_claiming_current_law(self):
        question='Trích nội dung văn bản: Xe mô tô không đội mũ bảo hiểm theo Nghị định 330/2026/NĐ-CP bị phạt bao nhiêu?'
        module,reader,retriever,_,_=self.prepare(question=question)
        reader.nodes['VietRoadTraffic.LegalDocument','văn-bản']['properties']['ngayHieuLucBoPhan']='[{"date":"2027-07-01"}]'
        ctx=Context();task=Task('Retriever',{'query':question})
        module.LegalRetrieverExecutor(retriever).invoke(question,task,ctx);ctx.append_task(task)
        result,_,_=self.render(module,ctx,question,candidate([self.selected(ctx)],effectivity='uncertain'))
        self.assertFalse(result.abstained)
        self.assertTrue(result.answer.startswith('Trích nội dung nguồn (không xác nhận hiệu lực hiện hành):\n'))
        self.assertEqual(result.citations[0].quote,'Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        for override in ({'applicability':'wrong_context'},{'conflict':'unresolved'}):
            denied,_,_=self.render(module,ctx,question,candidate([self.selected(ctx)],**override))
            self.assertTrue(denied.abstained)
        self.assertIsNone(module.document_content_question('Trích nội dung văn bản: pháp luật hiện hành quy định gì?'))
        self.assertIsNone(module.document_content_question('Nghị định 330/2026/NĐ-CP quy định gì?'))

    def test_content_lookup_resolves_numbered_unit_metadata_with_exact_parent_support(self):
        text='4. Người dự kiểm tra không đạt yêu cầu có thể đăng ký kiểm tra lại sau 07 ngày.'
        parent_text='Điều 9. Sửa tại Điều 16 về kiểm tra.'
        question='Trích nội dung văn bản: Khoản 4 Điều 16 sửa tại Điều 9 Nghị định 330/2026/NĐ-CP quy định gì về kiểm tra lại?'
        module,reader,retriever,_,_=self.prepare(text=text,question=question,parentId='parent',dieuNumber='9',khoanNumber='4')
        parent=retrieval_fixture.node('LegalUnit','parent',text=parent_text,doc='văn-bản')
        parent['properties'].update(unitType='Dieu',soHieu='330/2026/NĐ-CP',dieuNumber='9')
        reader.nodes['VietRoadTraffic.LegalUnit','parent']=parent
        reader.hits['LegalUnit','text'].append({'id':'parent','score':0.8,'index':'text-index'})
        ctx=Context();module.LegalRetrieverExecutor(retriever).invoke(question,Task('Retriever',{'query':question}),ctx)
        value=candidate([self.selected(ctx)],support_selections=[self.selected(ctx,1)],effectivity='uncertain')
        result,_,_=self.render(module,ctx,question,value)
        self.assertFalse(result.abstained)
        self.assertEqual([c.quote for c in result.citations],[text,parent_text])
        for bad_question in (question.replace('Khoản 4','Khoản 5'),question.replace('330/2026','331/2026')):
            payload=ctx.kwargs['legal_evidence'].payload();payload['original_question']=bad_question
            bad_ctx=Context();bad_ctx.kwargs['legal_evidence']=module.LegalEvidenceResponse(module.canonical_json(payload))
            rejected,_,_=self.render(module,bad_ctx,bad_question,value)
            self.assertTrue(rejected.abstained)
        rejected,_,_=self.render(module,ctx,question,dict(value,support_selections=[]))
        self.assertTrue(rejected.abstained)
        current=question.removeprefix('Trích nội dung văn bản: ')
        payload=ctx.kwargs['legal_evidence'].payload();payload['original_question']=current
        current_ctx=Context();current_ctx.kwargs['legal_evidence']=module.LegalEvidenceResponse(module.canonical_json(payload))
        rejected,_,_=self.render(module,current_ctx,current,value)
        self.assertTrue(rejected.abstained)

    def test_inactive_metadata_without_dated_authority_abstains(self):
        for props in ({'currentStatus':'Hết hiệu lực'},
                      {'currentStatus':'REPLACED'},
                      {'statusHint':'Đã bị thay thế'},
                      {'hetHieuLucNote':'Đã bị bãi bỏ toàn bộ.'}):
            module, reader, retriever, _, question = self.prepare()
            reader.nodes['VietRoadTraffic.LegalDocument','văn-bản']['properties'].update(props)
            ctx = Context()
            task = Task('Retriever', {'query':question})
            module.LegalRetrieverExecutor(retriever).invoke(question, task, ctx)
            result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
            with self.subTest(props=props):
                self.assertTrue(result.abstained)
        module, _, _, ctx, _ = self.prepare()
        payload = ctx.kwargs['legal_evidence'].payload()
        payload['documents']['văn-bản'].update(current_status='Hết hiệu lực', effective_to='2025-01-01')
        self.assertTrue(module._current(payload['items'][0], payload['documents'], date(2021,1,1)))

    def test_wrong_scope_and_unverified_applicability_abstain(self):
        for source, props in [('Ô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.', {}),
                              ('Phạt 30.000.000 đồng.', {}),
                              ('Tổ chức dùng xe mô tô không đội mũ bảo hiểm bị phạt.', {'penaltyDoiTuong': 'tổ chức'}),
                              ('Xe mô tô không đội mũ bảo hiểm bị phạt.', {'parentId': 'parent-unretrieved'})]:
            module, _, _, ctx, question = self.prepare(text=source, **props)
            result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
            with self.subTest(source=source, props=props): self.assertTrue(result.abstained)

    def test_support_requires_current_linked_same_document_context(self):
        for expired in (False, True):
            module, reader, retriever, _, question = self.prepare(
                text='Xe mô tô không chấp hành tín hiệu đèn: phạt 30.000.000 đồng.')
            support = retrieval_fixture.node('LegalUnit', 'support',
                text='Xe mô tô không đội mũ bảo hiểm.', doc='support-doc')
            support['properties'].update(unitType='article', soHieu='331/2026/NĐ-CP')
            doc = retrieval_fixture.node('LegalDocument', 'support-doc', text='Nguồn support')
            doc['properties'].update(soHieu='331/2026/NĐ-CP', effectiveFrom='2020-01-01')
            if expired:
                doc['properties']['effectiveTo']='2025-01-01'
            reader.nodes['VietRoadTraffic.LegalUnit','support']=support
            reader.nodes['VietRoadTraffic.LegalDocument','support-doc']=doc
            reader.hits['LegalUnit','text'].append({'id':'support','score':0.8,'index':'text-index'})
            ctx = Context()
            module.LegalRetrieverExecutor(retriever).invoke(question, Task('Retriever',{'query':question}),ctx)
            result, _, _ = self.render(module, ctx, question,
                candidate([self.selected(ctx)], support_selections=[self.selected(ctx,1)]))
            with self.subTest(expired=expired):
                self.assertTrue(result.abstained)
        for parent_doc in ('văn-bản','other-doc'):
            module, reader, retriever, _, question = self.prepare(
                text='Xe mô tô: phạt 30.000.000 đồng.', parentId='parent')
            parent = retrieval_fixture.node('LegalUnit','parent',text='Xe mô tô không đội mũ bảo hiểm.',doc=parent_doc)
            parent['properties'].update(unitType='article',soHieu='330/2026/NĐ-CP')
            reader.nodes['VietRoadTraffic.LegalUnit','parent']=parent
            if parent_doc!='văn-bản':
                doc = retrieval_fixture.node('LegalDocument',parent_doc,text='Nguồn khác')
                doc['properties'].update(soHieu='330/2026/NĐ-CP',effectiveFrom='2020-01-01')
                reader.nodes['VietRoadTraffic.LegalDocument',parent_doc]=doc
            reader.hits['LegalUnit','text'].append({'id':'parent','score':0.8,'index':'text-index'})
            ctx=Context()
            module.LegalRetrieverExecutor(retriever).invoke(question,Task('Retriever',{'query':question}),ctx)
            result, _, _ = self.render(module,ctx,question,
                candidate([self.selected(ctx)],support_selections=[self.selected(ctx,1)]))
            with self.subTest(parent_doc=parent_doc):
                self.assertEqual(result.abstained,parent_doc!='văn-bản')

    def test_transport_error_and_oversized_evidence_are_distinct(self):
        module, _, _, ctx, question = self.prepare()
        failing = FakeLLM([OSError('model transport unavailable')]*3)
        with patch.object(LLMClient.call_with_json_parse.retry, 'sleep', lambda seconds: None), self.assertRaises(RuntimeError):
            self.render(module, ctx, question, candidate(), llm=failing)
        self.assertEqual(len(failing.prompts), 3)
        module, _, _, ctx, question = self.prepare(text='x'*48001)
        result, llm, _ = self.render(module, ctx, question, candidate())
        self.assertTrue(result.abstained)
        self.assertEqual(llm.prompts, [])

    def test_wrong_action_and_hidden_conflict_cannot_be_supported_by_flags(self):
        module, _, _, ctx, question = self.prepare(text='Xe mô tô không chấp hành tín hiệu đèn giao thông: phạt 30.000.000 đồng.')
        result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)]))
        with self.subTest(invariant='action-context'):
            self.assertTrue(result.abstained, 'same vehicle is not proof of same legal context')
        module, reader, retriever, ctx, question = self.prepare()
        second = retrieval_fixture.node('LegalUnit', 'other', text='Xe mô tô không đội mũ bảo hiểm: phạt 3.000.000 đồng.', doc='other-doc')
        second['properties'].update(unitType='article', soHieu='331/2026/NĐ-CP')
        other_doc = retrieval_fixture.node('LegalDocument', 'other-doc', text='Văn bản khác')
        other_doc['properties'].update(soHieu='331/2026/NĐ-CP', effectiveFrom='2020-01-01')
        reader.nodes['VietRoadTraffic.LegalUnit', 'other'] = second
        reader.nodes['VietRoadTraffic.LegalDocument', 'other-doc'] = other_doc
        reader.hits['LegalUnit', 'text'].append({'id': 'other', 'score': 0.8, 'index': 'text-index'})
        ctx = Context()
        task = Task('Retriever', {'query': question})
        module.LegalRetrieverExecutor(retriever).invoke(question, task, ctx)
        ctx.append_task(task)
        result, _, _ = self.render(module, ctx, question, candidate([self.selected(ctx)], conflict='none'))
        with self.subTest(invariant='hidden-conflict'):
            self.assertTrue(result.abstained, 'model cannot silently ignore contradictory current sources')

    def test_conflict_requires_all_targets_and_affirmative_current_resolution(self):
        for mode in ('same-document', 'permission', 'points', 'three-partial', 'missing-support',
                     'negated', 'partial-competitor', 'full-two', 'full-three'):
            question='Xe mô tô không đội mũ bảo hiểm bị phạt thế nào?'
            first='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.'
            second='Xe mô tô không đội mũ bảo hiểm: phạt 3.000.000 đồng.'
            if mode=='permission':
                question='Xe mô tô có được phép qua đường?'
                first='Xe mô tô được phép qua đường.'
                second='Xe mô tô không được phép qua đường.'
            if mode=='points':
                question='Xe mô tô không đội mũ bảo hiểm bị trừ điểm thế nào?'
                first='Xe mô tô không đội mũ bảo hiểm: trừ 2 điểm.'
                second='Xe mô tô không đội mũ bảo hiểm: trừ 3 điểm.'
            resolution=mode in ('three-partial','negated','full-two','full-three','missing-support')
            if resolution:
                first+=(' Không' if mode=='negated' else '')+' bãi bỏ toàn bộ Nghị định 331/2026/NĐ-CP.'
            if mode=='full-three':
                first+=' Bãi bỏ toàn bộ Nghị định 332/2026/NĐ-CP.'
            module,reader,retriever,_,_=self.prepare(text=first,question=question)
            second_doc='văn-bản' if mode=='same-document' else 'doc-B'
            rows=[('unit-B',second_doc,'330/2026/NĐ-CP' if mode=='same-document' else '331/2026/NĐ-CP',second)]
            if mode in ('three-partial','full-three'):
                rows.append(('unit-C','doc-C','332/2026/NĐ-CP',
                             'Xe mô tô không đội mũ bảo hiểm: phạt 1.000.000 đồng.'))
            for identity,doc_id,number,text in rows:
                unit=retrieval_fixture.node('LegalUnit',identity,text=text,doc=doc_id)
                unit['properties'].update(unitType='article',soHieu=number)
                reader.nodes['VietRoadTraffic.LegalUnit',identity]=unit
                reader.hits['LegalUnit','text'].append({'id':identity,'score':0.8,'index':'text-index'})
                if doc_id!='văn-bản':
                    doc=retrieval_fixture.node('LegalDocument',doc_id,text='Nguồn cạnh tranh')
                    doc['properties'].update(soHieu=number,effectiveFrom='2020-01-01')
                    if mode=='partial-competitor':
                        doc['properties'].update(effectiveTo='2025-01-01',hetHieuLucNote='Một phần hết hiệu lực.')
                    reader.nodes['VietRoadTraffic.LegalDocument',doc_id]=doc
            if resolution:
                reader.hits['LegalDocument','title']=[{'id':doc_id,'score':0.1,'index':'title-index'}
                    for kind,doc_id in reader.nodes if kind.endswith('.LegalDocument')]
                targets=['doc-B','doc-C'] if mode=='full-three' else ['doc-B']
                reader.relations=[{'from':['VietRoadTraffic.LegalDocument','văn-bản'],
                    'predicate':'repeals','to':['VietRoadTraffic.LegalDocument',target],
                    'properties':{}} for target in targets]
            ctx=Context()
            module.LegalRetrieverExecutor(retriever,expand=resolution).invoke(
                question,Task('Retriever',{'query':question}),ctx)
            spans=[self.selected(ctx)]
            value=candidate(spans,conflict='resolved' if resolution else 'none',
                            support_selections=spans if resolution and mode!='missing-support' else [])
            result,_,_=self.render(module,ctx,question,value)
            with self.subTest(mode=mode):
                self.assertEqual(result.abstained,mode not in ('full-two','full-three'))


def select_first(prompt):
    item = next(item for item in prompt['evidence']['items'] if item['entity_type'].endswith('.LegalUnit'))
    source = item['source_texts']['text']
    return candidate([{'evidence_id': item['evidence_ids']['text'], 'field': 'text', 'start': 0, 'end': len(source)}])


class PipelineTests(unittest.TestCase):
    question = 'Xe mô tô không đội mũ bảo hiểm bị phạt bao nhiêu?'
    narrow = 'Mức phạt xe mô tô không đội mũ bảo hiểm?'

    def module(self):
        module = importlib.import_module('kag.legal_solver')
        self.assertTrue(hasattr(module, 'build_pipeline'), 'native upstream composition missing')
        self.assertTrue(hasattr(module, 'answer') and hasattr(module, 'aanswer'), 'thin facades missing')
        return module

    def pipeline(self, script=None, retriever=None):
        module = self.module()
        if retriever is None:
            _, retriever = fixture(text='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        llm = FakeLLM(script or [action(self.narrow), action(self.narrow, 'Deduce'), select_first, action(executor='Finish')])
        return module, module.build_pipeline(retriever, llm), llm

    def test_real_upstream_composition_and_trace(self):
        module, pipeline, llm = self.pipeline()
        from kag.solver.pipeline.kag_iterative_pipeline import KAGIterativePipeline
        from kag.solver.executor.deduce.kag_deduce_executor import KagDeduceExecutor
        from kag.interface import GeneratorABC, PlannerABC
        self.assertIs(type(pipeline), KAGIterativePipeline)
        self.assertIs(type(pipeline.planner), KAGIterativePlanner)
        self.assertIsInstance(pipeline.select_executor('Deduce'), KagDeduceExecutor)
        self.assertIsInstance(pipeline.generator, GeneratorABC)
        self.assertEqual([e.schema()['name'] for e in pipeline.executors], ['Retriever', 'Deduce', 'Finish'])
        result = module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
        self.assertFalse(result.abstained)
        self.assertEqual(result.to_dict()['citations'][0]['quote'], 'Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        self.assertEqual(result.to_dict()['citations'][0]['unit_id'], 'đơn-vị')
        self.assertEqual(llm.prompts[1]['context'][0]['action']['argument']['query'], self.narrow)
        self.assertEqual([step['action']['name'] for step in llm.prompts[-1]['context']], ['Retriever', 'Deduce'])
        self.assertEqual(llm.prompts[2]['evidence']['subquery'], self.narrow)
        self.assertEqual(pipeline.max_iteration, 5)
        _, another, _ = self.pipeline()
        self.assertIsNot(pipeline.executors, another.executors)
        self.assertEqual(len(another.executors), 3)
        for cls in (KAGIterativePipeline, KAGIterativePlanner, Context, Task, KagDeduceExecutor):
            self.assertTrue(Path(inspect.getfile(cls)).is_relative_to(ROOT/'vendor/KAG'))
        configured = PlannerABC.from_config({'type': 'kag_iterative_planner',
            'llm': {'type': 'f_test_llm', 'responses': [action(self.narrow)]},
            'plan_prompt': {'type': 'viet_legal_planning', 'language': 'vi'}})
        self.assertEqual(configured.invoke(self.question, context=Context(), executors=[])[0].arguments['query'], self.narrow)

    def test_sync_async_and_event_loop_contract(self):
        module, pipeline, _ = self.pipeline()
        sync = module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6)).to_dict()
        module, pipeline, llm = self.pipeline()
        async def run():
            with self.assertRaisesRegex(RuntimeError, 'aanswer'):
                module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
            self.assertEqual(llm.prompts, [])
            return (await module.aanswer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))).to_dict()
        self.assertEqual(asyncio.run(run()), sync)
        for value in ('', '  ', None, 12):
            module, pipeline, llm = self.pipeline()
            with self.assertRaises(ValueError): module.answer(value, pipeline=pipeline)
            self.assertEqual(llm.prompts, [])
        module, pipeline, llm = self.pipeline()
        with self.assertRaises(ValueError):
            module.answer(self.question, pipeline=pipeline, as_of=datetime(2026, 10, 6))
        self.assertEqual(llm.prompts, [])

    def test_finish_iteration_retries_and_errors(self):
        module, pipeline, llm = self.pipeline([action(self.narrow)]*5)
        from kag.solver.pipeline.kag_iterative_pipeline import MaxIterationsReachedError
        with self.assertRaises(MaxIterationsReachedError):
            module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
        self.assertEqual(len(llm.prompts), 5)
        module, pipeline, llm = self.pipeline([action('ô tô', 'Unknown')]*3)
        with self.assertRaises(RuntimeError):
            module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
        self.assertEqual(len(llm.prompts), 3)
        module, pipeline, llm = self.pipeline([action(executor='Finish')])
        result = module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
        self.assertTrue(result.abstained)
        self.assertEqual(result.to_dict()['citations'], [])
        self.assertEqual(len(llm.prompts), 1)

    def test_independent_requests_and_no_legacy_eval_path(self):
        module, pipeline, llm = self.pipeline()
        llm.responses += [action(executor='Finish')]
        self.assertFalse(module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6)).abstained)
        self.assertTrue(module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6)).abstained)
        self.assertEqual(llm.prompts[-1]['context'], [])
        with self.assertRaises(TypeError):
            module.answer(self.question, pipeline=pipeline, qid='benchmark', gold='answer')
        self.assertFalse(any(name.startswith('benchmark') for name in sys.modules))

    def test_r1_replans_mutation_before_e_and_preserves_decomposition(self):
        original = self.question+' Theo Nghị định 330/2026/NĐ-CP.'
        good = self.narrow+' Theo Nghị định 330/2026/NĐ-CP.'
        reader, retriever = fixture(text='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        seen = []
        retriever.embed = lambda q: (seen.append(q) or retrieval_fixture.VECTOR)
        module, pipeline, llm = self.pipeline([action(good.replace('330/', '331/')), action(good),
                                             action(good, 'Deduce'), select_first, action(executor='Finish')], retriever)
        result = module.answer(original, pipeline=pipeline, as_of=date(2026, 10, 6))
        self.assertFalse(result.abstained)
        self.assertEqual(seen, [good])
        self.assertNotEqual(good, original)
        self.assertEqual(len(llm.prompts), 5)

    def test_request_clock_not_import_time(self):
        module = self.module()
        for current in (datetime(2026, 10, 6, tzinfo=timezone.utc), datetime(2026, 10, 7, tzinfo=timezone.utc)):
            _, pipeline, llm = self.pipeline()
            with patch('kag.legal_solver.datetime') as clock:
                clock.now.return_value = current
                module.answer(self.question, pipeline=pipeline)
                self.assertEqual(str(clock.now.call_args.args[0]), 'Asia/Saigon')
            self.assertEqual(llm.prompts[2]['as_of'], current.date().isoformat())

    def test_sync_reuse_with_loop_bound_sdk_transport(self):
        class LoopBoundLLM(FakeLLM):
            async def acall(self, prompt, **kwargs):
                loop = asyncio.get_running_loop()
                if hasattr(self, 'transport_loop') and self.transport_loop is not loop:
                    raise RuntimeError('SDK async transport belongs to another event loop')
                self.transport_loop = loop
                return self(prompt, **kwargs)
        module = self.module()
        _, retriever = fixture(text='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        script = [action(self.narrow), action(self.narrow, 'Deduce'), select_first, action(executor='Finish')]
        llm = LoopBoundLLM(script+script)
        pipeline = module.build_pipeline(retriever, llm)
        async def no_sleep(seconds):
            return None
        with patch.object(LLMClient.acall_with_json_parse.retry, 'sleep', no_sleep):
            first = module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
            second = module.answer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6))
        self.assertFalse(first.abstained)
        self.assertEqual(first.to_dict(), second.to_dict())

    def test_r1_negation_binding_is_not_a_bag_of_words(self):
        from kag.legal_prompts import validate_subquery
        original = 'Xe mô tô không được phép theo Điều 13?'
        with self.assertRaises(ValueError):
            validate_subquery(original, 'Xe mô tô được phép không theo Điều 13?', ())

    def test_concurrent_requests_share_upstream_components_without_ledger_leaks(self):
        module = self.module()
        def respond(prompt):
            if 'question' in prompt:
                return select_first(prompt)
            context = prompt['context']
            if not context:
                return action(prompt['query'])
            if context[-1]['action']['name'] == 'Retriever':
                return action(prompt['query'], 'Deduce')
            return action(executor='Finish')
        _, retriever = fixture(text='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        llm = FakeLLM([respond]*8)
        pipeline = module.build_pipeline(retriever, llm)
        async def run():
            return await asyncio.gather(module.aanswer(self.question, pipeline=pipeline, as_of=date(2026, 10, 6)),
                module.aanswer(self.narrow, pipeline=pipeline, as_of=date(2026, 10, 6)))
        results = asyncio.run(run())
        self.assertTrue(all(not result.abstained for result in results))
        self.assertEqual(len(llm.prompts), 8)
        for prompt in llm.prompts:
            if 'question' in prompt:
                self.assertEqual(prompt['question'], prompt['evidence']['original_question'])


class FieldRoleContractTests(unittest.TestCase):
    """R6.3: Deduce field-role contract matches server roles; server stays fail-closed (R6.2)."""
    module = SafetyTests.module
    prepare = SafetyTests.prepare
    selected = SafetyTests.selected
    render = SafetyTests.render
    sign_question = 'Biển DP.127 có ý nghĩa gì?'
    sign_text = ('Biển DP.127 có ý nghĩa hết tốc độ tối đa theo phương án tổ chức giao thông. '
                 'Trường hợp hết tất cả lệnh cấm dùng DP.135.')

    def instruction(self):
        deduce = importlib.import_module('kag.legal_prompts').LegalDeducePrompt(language='vi')
        rendered = deduce.build_prompt({'question': self.sign_question, 'evidence': {}, 'as_of': '2026-10-06'})
        return json.loads(rendered)['instruction']

    def sentences(self, field):
        pattern = re.compile(r'(?<![\w])`?' + re.escape(field) + r'`?(?![\w])')
        return [s for s in re.split(r'(?<=\.)\s+', self.instruction()) if pattern.search(s)]

    def declared_factual(self, field):
        return any('selections' in s and 'factual' in s and 'không' not in s for s in self.sentences(field))

    def declared_identity_only(self, field):
        return any('không' in s and 'selections' in s and 'support_selections' in s for s in self.sentences(field))

    def sign_context(self):
        module = self.module()
        reader, retriever = fixture()
        sign = retrieval_fixture.node('TrafficSign', 'sign', text=self.sign_text, doc='văn-bản')
        sign['properties'].update(maBien='DP.127', ngayHieuLuc='2020-01-01')
        reader.nodes['VietRoadTraffic.TrafficSign', 'sign'] = sign
        reader.hits = {('TrafficSign', 'moTa'): [{'id': 'sign', 'score': 0.9, 'index': 'sign-index'}]}
        ctx = Context()
        task = Task('Retriever', {'query': self.sign_question})
        module.LegalRetrieverExecutor(retriever).invoke(self.sign_question, task, ctx)
        ctx.append_task(task)
        return module, ctx, self.sign_question

    def title_context(self):
        module = self.module()
        question = 'Xe mô tô không đội mũ bảo hiểm bị phạt bao nhiêu?'
        reader, retriever = fixture(text='Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')
        reader.hits['LegalDocument', 'title'] = [{'id': 'văn-bản', 'score': 0.95, 'index': 'title-index'}]
        ctx = Context()
        task = Task('Retriever', {'query': question})
        module.LegalRetrieverExecutor(retriever).invoke(question, task, ctx)
        ctx.append_task(task)
        return module, ctx, question

    def span(self, ctx, kind, field, **overrides):
        items = ctx.kwargs['legal_evidence'].payload()['items']
        index = next(i for i, item in enumerate(items) if item['entity_type'].endswith('.' + kind))
        return self.selected(ctx, index, source_field=field, **overrides)

    def assert_fail_closed(self, result):
        self.assertTrue(result.abstained)
        self.assertEqual(result.citations, ())
        self.assertEqual(result.to_dict()['citations'], [])

    def test_prompt_declares_factual_and_identity_only_field_roles(self):
        for field in ('text', 'moTa'):
            with self.subTest(field=field):
                self.assertTrue(self.declared_factual(field), field + ' must be declared a factual selection field')
                self.assertFalse(self.declared_identity_only(field))
        for field in ('ten', 'title'):
            with self.subTest(field=field):
                self.assertTrue(self.declared_identity_only(field),
                                field + ' must be declared identity-only: not selections, not support_selections')
                self.assertFalse(self.declared_factual(field))
        self.assertTrue(any('factual' in s and 'không đủ' in s and 'abstain' in s
                            for s in re.split(r'(?<=\.)\s+', self.instruction())),
                        'insufficient admissible factual evidence must instruct abstention')

    def test_prompt_roles_agree_with_server_roles(self):
        server = {}
        module, _, _, ctx, question = self.prepare()
        server['text'] = not self.render(module, ctx, question, candidate([self.span(ctx, 'LegalUnit', 'text')]))[0].abstained
        module, ctx, question = self.sign_context()
        for field in ('moTa', 'ten'):
            server[field] = not self.render(module, ctx, question, candidate([self.span(ctx, 'TrafficSign', field)]))[0].abstained
        module, ctx, question = self.title_context()
        server['title'] = not self.render(module, ctx, question, candidate([self.span(ctx, 'LegalDocument', 'title')]))[0].abstained
        self.assertEqual({field for field, ok in server.items() if ok}, {'text', 'moTa'})
        self.assertEqual({field for field in server if self.declared_factual(field)}, {'text', 'moTa'})

    def test_legal_unit_text_is_factual_eligible(self):
        module, _, _, ctx, question = self.prepare()
        result, _, _ = self.render(module, ctx, question, candidate([self.span(ctx, 'LegalUnit', 'text')]))
        self.assertFalse(result.abstained)
        self.assertEqual([(c.field, c.quote) for c in result.citations],
                         [('text', 'Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.')])

    def test_traffic_sign_moTa_is_factual_eligible_with_exact_whole_field_citation(self):
        module, ctx, question = self.sign_context()
        result, _, _ = self.render(module, ctx, question, candidate([self.span(ctx, 'TrafficSign', 'moTa')]))
        self.assertFalse(result.abstained)
        self.assertEqual([(c.field, c.sign_id, c.start, c.end, c.quote) for c in result.citations],
                         [('moTa', 'sign', 0, len(self.sign_text), self.sign_text)])

    def test_traffic_sign_ten_is_not_factual(self):
        module, ctx, question = self.sign_context()
        result, _, _ = self.render(module, ctx, question, candidate([self.span(ctx, 'TrafficSign', 'ten')]))
        self.assert_fail_closed(result)

    def test_traffic_sign_ten_is_not_support(self):
        module, ctx, question = self.sign_context()
        result, _, _ = self.render(module, ctx, question, candidate(
            [self.span(ctx, 'TrafficSign', 'moTa')], support_selections=[self.span(ctx, 'TrafficSign', 'ten')]))
        self.assert_fail_closed(result)

    def test_legal_document_title_is_not_factual(self):
        module, ctx, question = self.title_context()
        unit, title = self.span(ctx, 'LegalUnit', 'text'), self.span(ctx, 'LegalDocument', 'title')
        self.assertFalse(self.render(module, ctx, question, candidate([unit]))[0].abstained, 'control: unit text positive')
        self.assert_fail_closed(self.render(module, ctx, question, candidate([title]))[0])
        self.assert_fail_closed(self.render(module, ctx, question, candidate([title, unit]))[0])

    def test_insufficient_admissible_factual_evidence_abstains(self):
        module, ctx, question = self.sign_context()
        ten = self.span(ctx, 'TrafficSign', 'ten')
        for value in (candidate([]), candidate([ten]), candidate([], support_selections=[ten]),
                      candidate([], abstained=True, applicability='insufficient', effectivity='uncertain')):
            with self.subTest(value=value):
                self.assert_fail_closed(self.render(module, ctx, question, value)[0])

    def test_guards_whole_candidate_fail_closed_never_silently_filtered(self):
        module, ctx, question = self.sign_context()
        moTa, ten = self.span(ctx, 'TrafficSign', 'moTa'), self.span(ctx, 'TrafficSign', 'ten')
        self.assertFalse(self.render(module, ctx, question, candidate([moTa]))[0].abstained, 'control: moTa only positive')
        cases = {
            'ten_plus_moTa': [ten, moTa],
            'moTa_plus_ten': [moTa, ten],
            'forged_evidence_id': [moTa, dict(moTa, evidence_id='0' * 64)],
            'partial_span': [dict(moTa, end=moTa['end'] - 1)],
            'unsupported_field': [moTa, dict(moTa, field='ma_bien', end=6)],
        }
        for name, selections in cases.items():
            with self.subTest(case=name):
                result, _, _ = self.render(module, ctx, question, candidate(selections))
                self.assert_fail_closed(result)
                self.assertNotIn(self.sign_text, result.answer, 'valid moTa must not be kept by silent filtering')


class ConflictSupportContractTests(unittest.TestCase):
    """F-DEMO last fix: reason over ALL competing sources != support-select them.

    The server linkage contract (_support_linked / _conflict_resolved) is unchanged:
    support must come from the selected fact's own document, the server itself
    enumerates competing sources from the whole ledger, and resolution needs an
    explicit whole-document repeal text in the winner plus an amends/repeals relation.
    """
    module = SafetyTests.module
    prepare = SafetyTests.prepare
    selected = SafetyTests.selected
    render = SafetyTests.render
    question = 'Xe mô tô không đội mũ bảo hiểm bị phạt thế nào?'
    winner_rule = 'Xe mô tô không đội mũ bảo hiểm: phạt 30.000.000 đồng.'
    repeal = ' Bãi bỏ toàn bộ Nghị định 331/2026/NĐ-CP.'
    loser_rule = 'Xe mô tô không đội mũ bảo hiểm: phạt 3.000.000 đồng.'

    def instruction(self):
        deduce = importlib.import_module('kag.legal_prompts').LegalDeducePrompt(language='vi')
        rendered = deduce.build_prompt({'question': self.question, 'evidence': {}, 'as_of': '2026-10-06'})
        return json.loads(rendered)['instruction']

    def sentences(self):
        return re.split(r'(?<=\.)\s+', self.instruction())

    def conflict_context(self, *, repeal_text=True, relation=True, winner_from='2020-01-01',
                         loser_from='2020-01-01', loser_to=None):
        module, reader, retriever, _, _ = self.prepare(
            text=self.winner_rule+(self.repeal if repeal_text else ''), question=self.question)
        reader.nodes['VietRoadTraffic.LegalDocument', 'văn-bản']['properties']['effectiveFrom'] = winner_from
        unit = retrieval_fixture.node('LegalUnit', 'unit-B', text=self.loser_rule, doc='doc-B')
        unit['properties'].update(unitType='article', soHieu='331/2026/NĐ-CP')
        reader.nodes['VietRoadTraffic.LegalUnit', 'unit-B'] = unit
        reader.hits['LegalUnit', 'text'].append({'id': 'unit-B', 'score': 0.8, 'index': 'text-index'})
        doc = retrieval_fixture.node('LegalDocument', 'doc-B', text='Nguồn cạnh tranh')
        doc['properties'].update(soHieu='331/2026/NĐ-CP', effectiveFrom=loser_from)
        if loser_to:
            doc['properties']['effectiveTo'] = loser_to
        reader.nodes['VietRoadTraffic.LegalDocument', 'doc-B'] = doc
        reader.hits['LegalDocument', 'title'] = [{'id': doc_id, 'score': 0.1, 'index': 'title-index'}
                                                 for kind, doc_id in reader.nodes if kind.endswith('.LegalDocument')]
        reader.relations = [{'from': ['VietRoadTraffic.LegalDocument', 'văn-bản'], 'predicate': 'repeals',
                             'to': ['VietRoadTraffic.LegalDocument', 'doc-B'], 'properties': {}}] if relation else []
        ctx = Context()
        module.LegalRetrieverExecutor(retriever, expand=True).invoke(
            self.question, Task('Retriever', {'query': self.question}), ctx)
        return module, ctx

    def unit_span(self, ctx, doc_id):
        items = ctx.kwargs['legal_evidence'].payload()['items']
        index = next(i for i, item in enumerate(items)
                     if item['entity_type'].endswith('.LegalUnit') and item['doc_id'] == doc_id)
        return self.selected(ctx, index)

    def assert_fail_closed(self, result, reason=None):
        self.assertTrue(result.abstained)
        self.assertEqual(result.citations, ())
        self.assertEqual(result.to_dict()['citations'], [])
        if reason:
            self.assertEqual(result.to_dict().get('reason', reason), reason)

    # A
    def test_prompt_does_not_require_losing_competitor_support(self):
        sentences = self.sentences()
        for s in sentences:
            if 'support_selections chứa' in s:
                for match in re.finditer(r'từng văn bản cạnh tranh', s):
                    self.assertTrue(s[:match.start()].endswith('số hiệu '),
                                    'support must name each competitor (number), not contain each competitor: '+s)
        self.assertTrue(any('support' in s.casefold() and 'chính văn bản' in s and 'fact' in s for s in sentences),
                        'support must be declared same-document as the selected fact (server linkage contract)')
        self.assertTrue(any('bị bãi bỏ/thay thế' in s and 'không' in s.casefold() and 'support_selections' in s
                            for s in sentences), 'losing/repealed source must not be inserted as selection/support')

    # B
    def test_prompt_requires_considering_all_competitors_and_explicit_resolution(self):
        sentences, text = self.sentences(), self.instruction()
        self.assertTrue(any('xét' in s and 'mọi văn bản cạnh tranh' in s for s in sentences))
        self.assertTrue(any('số hiệu từng văn bản cạnh tranh' in s for s in sentences))
        self.assertIn('không chọn văn bản mới nhất', text)
        self.assertIn('amends/', text)
        self.assertTrue(any('abstain' in s and 'Thiếu' in s for s in sentences))
        module, ctx = self.conflict_context()
        winner = self.unit_span(ctx, 'văn-bản')
        result, _, _ = self.render(module, ctx, self.question, candidate([winner], conflict='none'))
        self.assert_fail_closed(result)  # the server considers every competitor even if the model ignores it

    # C
    def test_winner_fact_with_linked_winner_support_is_positive_exact(self):
        module, ctx = self.conflict_context()
        winner = self.unit_span(ctx, 'văn-bản')
        result, _, _ = self.render(module, ctx, self.question,
                                   candidate([winner], conflict='resolved', support_selections=[winner]))
        self.assertFalse(result.abstained)
        whole = self.winner_rule+self.repeal
        self.assertEqual([(c.doc_id, c.field, c.start, c.end, c.quote) for c in result.citations],
                         [('văn-bản', 'text', 0, len(whole), whole)])

    # D
    def test_winner_fact_with_losing_cross_document_support_abstains(self):
        module, ctx = self.conflict_context()
        winner, loser = self.unit_span(ctx, 'văn-bản'), self.unit_span(ctx, 'doc-B')
        for support in ([winner, loser], [loser, winner], [loser]):
            module, ctx = self.conflict_context()
            result, _, _ = self.render(module, ctx, self.question,
                                       candidate([winner], conflict='resolved', support_selections=support))
            with self.subTest(support=[s['evidence_id'][:8] for s in support]):
                self.assert_fail_closed(result)

    # E
    def test_unresolved_conflict_abstains(self):
        for flags in ({'conflict': 'unresolved'}, {'conflict': 'none'}):
            module, ctx = self.conflict_context()
            winner = self.unit_span(ctx, 'văn-bản')
            result, _, _ = self.render(module, ctx, self.question, candidate([winner], support_selections=[winner], **flags))
            with self.subTest(flags=flags):
                self.assert_fail_closed(result)

    # F
    def test_missing_explicit_relation_or_repeal_text_abstains(self):
        for options in ({'relation': False}, {'repeal_text': False}, {'relation': False, 'repeal_text': False}):
            module, ctx = self.conflict_context(**options)
            winner = self.unit_span(ctx, 'văn-bản')
            result, _, _ = self.render(module, ctx, self.question,
                                       candidate([winner], conflict='resolved', support_selections=[winner]))
            with self.subTest(options=options):
                self.assert_fail_closed(result)

    # G
    def test_newer_document_does_not_win_without_explicit_evidence(self):
        for conflict in ('resolved', 'none'):
            module, ctx = self.conflict_context(repeal_text=False, relation=False,
                                                winner_from='2026-01-01', loser_from='2019-01-01')
            winner = self.unit_span(ctx, 'văn-bản')
            result, _, _ = self.render(module, ctx, self.question, candidate(
                [winner], conflict=conflict, support_selections=[winner] if conflict == 'resolved' else []))
            with self.subTest(conflict=conflict):
                self.assert_fail_closed(result)

    # H
    def test_losing_or_repealed_factual_source_selected_abstains(self):
        module, ctx = self.conflict_context()
        winner, loser = self.unit_span(ctx, 'văn-bản'), self.unit_span(ctx, 'doc-B')
        for selections, support in (([loser], [loser]), ([loser], [winner]), ([loser, winner], [winner]), ([loser], [])):
            module, ctx = self.conflict_context()
            result, _, _ = self.render(module, ctx, self.question,
                                       candidate(selections, conflict='resolved', support_selections=support))
            with self.subTest(selections=len(selections), support=len(support)):
                self.assert_fail_closed(result)

    # I
    def test_no_server_candidate_filtering_or_repair(self):
        module, ctx = self.conflict_context()
        winner, loser = self.unit_span(ctx, 'văn-bản'), self.unit_span(ctx, 'doc-B')
        value = candidate([winner], conflict='resolved', support_selections=[winner, loser])
        result, llm, _ = self.render(module, ctx, self.question, copy.deepcopy(value))
        self.assert_fail_closed(result)
        self.assertNotIn(self.winner_rule, result.answer, 'valid winner fact must not be kept by dropping loser support')
        self.assertEqual(ctx.kwargs['legal_candidate'].payload()['candidate'], value, 'bound candidate must be unchanged')
        self.assertEqual(len(llm.prompts), 1)

    # Legacy ADAPT: effectivity decided by dated metadata, never by the model or recency
    def test_dated_expired_competitor_is_not_a_competitor(self):
        module, ctx = self.conflict_context(repeal_text=False, relation=False, loser_to='2025-01-01')
        winner = self.unit_span(ctx, 'văn-bản')
        result, _, _ = self.render(module, ctx, self.question, candidate([winner], conflict='none'))
        self.assertFalse(result.abstained)
        self.assertEqual([(c.doc_id, c.quote) for c in result.citations], [('văn-bản', self.winner_rule)])

if __name__ == '__main__':
    unittest.main()
