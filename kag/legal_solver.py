"""Sample legal adapters; upstream KAG owns planning and orchestration."""
from dataclasses import dataclass, asdict
from datetime import date, datetime
import asyncio
from zoneinfo import ZoneInfo
import hashlib
import hmac
import json
import secrets
import re

from kag.bootstrap import initialize
initialize()
from kag.builder.codec import canonical_json, decode_properties
from kag.interface import ExecutorABC, GeneratorABC, LLMClient, PromptABC, SolverPipelineABC
from kag.interface.solver.executor_abc import ExecutorResponse
from kag.legal_prompts import (validate_subquery, material_constraints, query_content_terms, _reference_bindings, _clauses, CandidateError, UnsafeSubqueryError,
                               LegalDeducePrompt, legal_trace, legal_timing, document_title_question, DOCUMENT_CONTENT_PREFIX)
from kag.solver.executor.deduce.kag_deduce_executor import KagDeduceExecutor
from kag.solver.planner.kag_iterative_planner import KAGIterativePlanner
from kag.solver.pipeline.kag_iterative_pipeline import KAGIterativePipeline
from kag.retriever.retriever import Retriever
from kag.retriever.neo4j import positive_limit


_CONTEXT_KEY = secrets.token_bytes(32)
_META = {
    'LegalDocument': {'so_hieu', 'loai', 'scope', 'effective_from', 'effective_to', 'hieu_luc_note',
                      'het_hieu_luc_note', 'current_status', 'status_hint', 'ngay_hieu_luc_bo_phan',
                      'consolidation_as_of', 'underlying_effective_from'},
    'LegalUnit': {'so_hieu', 'unit_type', 'scope', 'dieu_number', 'khoan_number', 'diem_letter',
                  'parent_id', 'penalty_doi_tuong', 'penalty_hanh_vi', 'penalty_phat_tien_min',
                  'penalty_phat_tien_max', 'penalty_tru_diem_gplx'},
    'TrafficSign': {'so_hieu', 'ma_bien', 'ngay_hieu_luc', 'ngay_het_hieu_luc'},
}


def _source_texts(payload):
    texts = []
    for item in payload['items']:
        texts.extend(item['source_texts'].values())
        texts.extend(v if isinstance(v, str) else canonical_json(v)
                     for v in item['metadata'].values() if isinstance(v, (str, list, dict)))
    for props in payload['documents'].values():
        texts.extend(v if isinstance(v, str) else canonical_json(v)
                     for v in props.values() if isinstance(v, (str, list, dict)))
    return tuple(texts)


def _unit_references(metadata, source_text=''):
    references=[]
    for field,label,pattern in (('dieu_number','Điều',r'\d+[a-zđ]?'),
                                ('khoan_number','khoản',r'\d+[a-zđ]?'),
                                ('diem_letter','điểm',r'[a-zđ]')):
        value=metadata.get(field)
        if isinstance(value,str) and re.fullmatch(pattern,value,re.I):references.append(label+' '+value)
    article = metadata.get('dieu_number')
    if (metadata.get('unit_type') == 'Dieu' and isinstance(article, str)
            and re.match(r'\s*Điều\s+'+re.escape(article)+r'[.]\s+', source_text, re.I)):
        # Coordinates come from numbered paragraphs inside this verified whole article.
        references.extend('khoản '+number for number in re.findall(
            r'(?m)^\s*(\d+[a-zđ]?)[.)]\s+\S', source_text, re.I))
    return ' '.join(references)


def _grounding_sources(payload):
    """Ground planner identities/coordinates in server-confirmed typed fields.

    Derived labels are for validation only; source fields and citations remain exact.
    """
    texts = list(_source_texts(payload))
    for item in payload['items']:
        texts.extend(item[key] for key in ('entity_id','doc_id','unit_id','sign_id')
                     if isinstance(item.get(key),str))
        metadata = item['metadata']
        references = _unit_references(metadata, item['source_texts'].get('text', ''))
        if references:
            number = payload['documents'].get(item['doc_id'],{}).get('so_hieu') or ''
            texts.append(number+' '+references)
        texts.extend(canonical_json(value) for value in metadata.values() if type(value) in (int,float))
    return tuple(texts)


@dataclass(frozen=True)
class LegalEvidenceResponse(ExecutorResponse):
    """Canonical snapshot is authority; consumers only receive decoded copies."""
    snapshot: str

    @property
    def fingerprint(self):
        return hashlib.sha256(self.snapshot.encode()).hexdigest()

    def payload(self):
        return json.loads(self.snapshot)

    def to_string(self):
        value = self.payload()
        if value['budget_exceeded']:
            return canonical_json({'budget_exceeded': True, 'source_characters': value['source_characters']})
        # Upstream planner formats result objects to strings. Authenticate this
        # boundary so generated thoughts/JSON cannot pose as confirmed retrieval.
        signature = hmac.new(_CONTEXT_KEY, self.snapshot.encode(), hashlib.sha256).hexdigest()
        return canonical_json({'legal_evidence': self.snapshot, 'signature': signature})


def confirmed_context_sources(context, original):
    sources = []
    if not isinstance(context, list):
        return ()
    for step in context:
        try:
            if step['action']['name'] != 'Retriever':
                continue
            envelope = json.loads(step['result'])
            snapshot = envelope['legal_evidence']
            expected = hmac.new(_CONTEXT_KEY, snapshot.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, envelope['signature']):
                continue
            payload = json.loads(snapshot)
            if payload['original_question'] == original and not payload['budget_exceeded']:
                sources.extend(_grounding_sources(payload))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return tuple(sources)


def _task_query(original, task, context):
    if type(task.arguments) is not dict or set(task.arguments) != {'query'}:
        raise ValueError('legal task accepts query only')
    previous = context.kwargs.get('legal_evidence')
    sources = _grounding_sources(previous.payload()) if isinstance(previous, LegalEvidenceResponse) else ()
    subquery = task.arguments['query']
    validate_subquery(original, subquery, sources)
    return subquery


class LegalRetrieverExecutor(ExecutorABC):
    def __init__(self, retriever: Retriever, *, top_k=10, expand=False, max_evidence_chars=48000):
        super().__init__()
        if not isinstance(retriever, Retriever) or type(expand) is not bool:
            raise ValueError('existing E Retriever and boolean expansion required')
        positive_limit(top_k, retriever.search_k)
        if type(max_evidence_chars) is not int or not 1 <= max_evidence_chars <= 48000:
            raise ValueError('evidence bound must be within 48000 source characters')
        self.retriever, self.top_k, self.expand = retriever, top_k, expand
        self.max_evidence_chars = max_evidence_chars

    def schema(self):
        return {'name': 'Retriever', 'description': 'Tìm nguồn pháp luật qua E, giữ nguyên source và identity.',
                'parameters': {'query': {'type': 'string', 'description': 'Subquery provenance-safe theo câu hỏi gốc/nguồn xác nhận.', 'optional': False}}}

    def _metadata(self, evidence):
        contract, namespace = self.retriever.contract, self.retriever.namespace
        keys = {(item['entity_type'], item['entity_id']) for item in evidence}
        keys.update((namespace+'.LegalDocument', item['doc_id']) for item in evidence)
        rows = self.retriever.reader.read_nodes([list(key) for key in sorted(keys)]) if keys else []
        decoded = {}
        for row in rows:
            types = [kind for kind in _META if namespace+'.'+kind in row['labels']]
            if len(types) != 1:
                raise ValueError('ambiguous metadata entity type')
            kind = types[0]
            # Read client already removed outer storage JSON; do not decode it again.
            props = decode_properties(row['properties'], contract['node_properties'][kind], server_encoded=False)
            for field in contract['node_properties'][kind]:
                if field['logical_name'] in _META[kind] and field['schema_name'] in row['properties'] and row['properties'][field['schema_name']] is None:
                    props[field['logical_name']] = None
            key = namespace+'.'+kind, props['id']
            if key not in keys or key in decoded or props['name'] != props['id']:
                raise ValueError('missing, duplicate or mismatched metadata identity')
            decoded[key] = props
        if set(decoded) != keys:
            raise ValueError('exact metadata readback incomplete')
        documents = {key[1]: {k: v for k, v in props.items() if k in _META['LegalDocument']}
                     for key, props in decoded.items() if key[0] == namespace+'.LegalDocument'}
        items = []
        for incoming in evidence:
            item = json.loads(canonical_json(incoming))
            kind = item['entity_type'].removeprefix(namespace+'.')
            props = decoded[item['entity_type'], item['entity_id']]
            expected_doc = props['id'] if kind == 'LegalDocument' else props['doc_id']
            if expected_doc != item['doc_id']:
                raise ValueError('metadata document identity changed')
            rows_by_physical = {row['schema_name']: row['logical_name'] for row in contract['node_properties'][kind]}
            for field, source in item['source_texts'].items():
                if source != props[rows_by_physical[field]]:
                    raise ValueError('evidence changed during metadata hydration')
            item['metadata'] = {k: v for k, v in props.items() if k in _META[kind]}
            item['source_lengths'] = {field: len(source) for field, source in item['source_texts'].items()}
            item['evidence_ids'] = {
                field: hashlib.sha256(canonical_json([item['entity_type'], item['entity_id'], field]).encode()).hexdigest()
                for field in item['source_texts']}
            items.append(item)
        return items, documents

    def invoke(self, query, task, context, **kwargs):
        subquery = _task_query(query, task, context)
        retrieval_query = query if document_title_question(query) else subquery
        legal_trace('retrieval.input', query=retrieval_query, subquery=subquery, top_k=self.top_k, expand=self.expand)
        with legal_timing('retrieval.total'):
            evidence = self.retriever.retrieve(retrieval_query, top_k=self.top_k, expand=self.expand)
        legal_trace('retrieval.output', evidence=evidence)
        with legal_timing('retrieval.metadata'):
            incoming, documents = self._metadata(evidence)
        previous = context.kwargs.get('legal_evidence')
        old = previous.payload() if isinstance(previous, LegalEvidenceResponse) else {'items': [], 'documents': {}}
        if isinstance(previous, LegalEvidenceResponse) and old['original_question'] != query:
            raise ValueError('request evidence belongs to another question')
        merged = {(item['entity_type'], item['entity_id']): item for item in old['items']}
        for item in incoming:
            key = item['entity_type'], item['entity_id']
            if key in merged and (merged[key]['source_texts'] != item['source_texts'] or merged[key]['metadata'] != item['metadata']):
                raise ValueError('same-identity evidence changed within request')
            merged[key] = item
        prior_docs = dict(old['documents'])
        for identity, props in documents.items():
            if identity in prior_docs and prior_docs[identity] != props:
                raise ValueError('document metadata changed within request')
            prior_docs[identity] = props
        payload = {'original_question': query, 'retrieval_task': task.id,
                   'items': list(merged.values()), 'documents': prior_docs}
        characters = sum(map(len, _source_texts(payload)))
        payload.update(source_characters=characters, budget_exceeded=characters > self.max_evidence_chars)
        legal_trace('retrieval.ledger', **payload)
        response = LegalEvidenceResponse(canonical_json(payload))
        context.kwargs['legal_evidence'] = response
        context.kwargs.pop('legal_candidate', None)
        task.update_result(response)
        return response


@dataclass(frozen=True)
class Citation:
    doc_id: str
    unit_id: str | None
    sign_id: str | None
    evidence_id: str
    field: str
    start: int
    end: int
    quote: str


@dataclass(frozen=True)
class AnswerResult:
    answer: str
    citations: tuple[Citation, ...]
    abstained: bool
    reason: str = ''

    def to_dict(self):
        return {'answer': self.answer, 'citations': [asdict(c) for c in self.citations],
                'abstained': self.abstained}


def _abstain(reason):
    return AnswerResult('Chưa đủ bằng chứng để kết luận pháp lý cho câu hỏi này.', (), True, reason)


@dataclass(frozen=True)
class LegalCandidateResponse(ExecutorResponse):
    snapshot: str

    def payload(self):
        return json.loads(self.snapshot)

    def to_string(self):
        return self.snapshot


class LegalDeduceExecutor(KagDeduceExecutor):
    def __init__(self, llm_module: LLMClient, deduce_prompt: PromptABC):
        # Generic upstream constructor creates five LF prompts, and generic
        # invoke needs DeduceNode. Keep base async/task contract, override both.
        ExecutorABC.__init__(self)
        if not isinstance(llm_module, LLMClient) or not isinstance(deduce_prompt, LegalDeducePrompt):
            raise ValueError('real LLMClient and audited legal deduce prompt required')
        self.llm_module, self.deduce_prompt = llm_module, deduce_prompt

    def schema(self):
        return {'name': 'Deduce', 'description': 'Reasoning evidence-only; thiếu authority/applicability/hiệu lực thì abstain.',
                'parameters': {'query': {'type': 'string', 'description': 'Subquery provenance-safe; luôn xét câu hỏi gốc.', 'optional': False}}}

    def invoke(self, query, task, context, **kwargs):
        subquery = _task_query(query, task, context)
        as_of = kwargs.get('as_of')
        if type(as_of) is not date:
            raise ValueError('request as_of must be a date')
        evidence = context.kwargs.get('legal_evidence')
        payload = evidence.payload() if isinstance(evidence, LegalEvidenceResponse) else None
        if not payload or not payload['items'] or payload['budget_exceeded']:
            legal_trace('deduce.skipped', reason='missing evidence or evidence budget exceeded')
            value = {'abstained': True, 'applicability': 'insufficient', 'effectivity': 'uncertain',
                     'conflict': 'none', 'selections': [], 'support_selections': []}
        else:
            if payload['original_question'] != query:
                raise ValueError('request evidence belongs to another question')
            prompt_evidence = dict(payload, subquery=subquery,
                authority_scope='DOCUMENT_TITLE' if document_title_question(query) else
                                'DOCUMENT_CONTENT' if document_content_question(query) else 'CURRENT_LAW')
            try:
                with legal_timing('deduce.total'):
                    value = self.llm_module.invoke({'question': query, 'evidence': prompt_evidence, 'as_of': as_of.isoformat()},
                                                   self.deduce_prompt, with_except=True, reporter=None)
            except RuntimeError as exc:
                if isinstance(exc.__context__, CandidateError):
                    legal_trace('deduce.rejected', error=str(exc.__context__))
                raise
        legal_trace('deduce.candidate', candidate=value)
        result = LegalCandidateResponse(canonical_json({'candidate': value,
                    'evidence_fingerprint': evidence.fingerprint if payload else None,
                    'original_question': query, 'as_of': as_of.isoformat(), 'deduce_task': task.id}))
        context.kwargs['legal_candidate'] = result
        task.update_result(result)
        return result


def _span_index(payload):
    index = {}
    for item in payload['items']:
        for field, source in item['source_texts'].items():
            index[item['evidence_ids'][field], field] = item, source
    namespace = payload['items'][0]['entity_type'].rsplit('.', 1)[0] if payload['items'] else ''
    for identity, props in payload['documents'].items():
        for field, source in props.items():
            if isinstance(source, str) and source:
                key = hashlib.sha256(canonical_json([namespace+'.LegalDocument', identity, field]).encode()).hexdigest()
                item = {'entity_type': namespace+'.LegalDocument', 'entity_id': identity,
                        'doc_id': identity, 'unit_id': None, 'sign_id': None, 'metadata': props,
                        'source_texts': {field: source}}
                index[key, field] = item, source
    return index


def _resolve(span, index):
    pair = index.get((span['evidence_id'], span['field']))
    if not pair:
        raise CandidateError('unknown evidence identity or field')
    item, source = pair
    if not source or span['start'] != 0 or span['end'] != len(source):
        raise CandidateError('whole contextual source field required')
    return item, Citation(item['doc_id'], item['unit_id'], item['sign_id'],
                          span['evidence_id'], span['field'], span['start'], span['end'],
                          source[span['start']:span['end']])


def _iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise CandidateError('missing or ambiguous effectivity date')
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise CandidateError('invalid effectivity date') from exc


def _partial_period(props):
    notes = ' '.join(str(props.get(k) or '') for k in ('hieu_luc_note', 'het_hieu_luc_note')).casefold()
    return (props.get('ngay_hieu_luc_bo_phan') or props.get('consolidation_as_of')
            or any(phrase in notes for phrase in ('một phần', 'riêng', 'từng phần', 'trừ ')))


def _current(item, documents, as_of):
    props = documents.get(item['doc_id'], {})
    if _partial_period(props):
        return False
    notes = ' '.join(str(props.get(k) or '') for k in ('hieu_luc_note', 'het_hieu_luc_note')).casefold()
    status = ' '.join(str(props.get(k) or '') for k in ('current_status', 'status_hint')).casefold()
    inactive = re.search(r'hết hiệu lực|bãi bỏ|bị thay thế|không còn hiệu lực|expired|repealed|superseded|replaced',
                         status+' '+notes)
    if inactive and not props.get('effective_to'):
        return False  # An undated inactive snapshot cannot establish a historical interval.
    try:
        if _iso_date(props.get('effective_from')) >= as_of:
            return False
        if props.get('effective_to') and _iso_date(props['effective_to']) <= as_of:
            return False
        if item['sign_id']:
            sign = item['metadata']
            if _iso_date(sign.get('ngay_hieu_luc')) >= as_of:
                return False
            if sign.get('ngay_het_hieu_luc') and _iso_date(sign['ngay_het_hieu_luc']) <= as_of:
                return False
    except CandidateError:
        return False
    return True


def _applicable(query, item, support, payload):
    title_number = document_title_question(query)
    if title_number:
        return (item['entity_type'].endswith('.LegalDocument')
                and (payload['documents'].get(item['doc_id'], {}).get('so_hieu') or '').casefold() == title_number.casefold())
    text = '\n'.join(item['source_texts'].values())
    parent = item['metadata'].get('parent_id')
    parents = [(source, citation) for source, citation in support if citation.field == 'text'
               and source['unit_id'] == parent and parent and source['doc_id'] == item['doc_id']]
    context_text = '\n'.join(citation.quote for _, citation in parents)
    own_scope = material_constraints(text+'\n'+canonical_json(item['metadata'])+'\n'+context_text)['scope']
    requested = material_constraints(query)
    if item['sign_id']:
        codes = {code.casefold() for code in re.findall(r'\b[A-ZĐ]{1,4}\.\d+[a-z]?\b',query,re.I)}
        if codes and codes != {str(item['metadata'].get('ma_bien') or '').casefold()}:
            return False  # Cross-referenced codes do not identify the selected sign.
    if not requested['scope'] <= own_scope:
        return False
    exclusive_person = {'tổ chức', 'doanh nghiệp', 'cá nhân', 'trẻ em', 'người chưa thành niên', 'người thành niên'}
    if own_scope & exclusive_person - requested['scope']:
        return False
    vehicle_scopes = {s for s in own_scope if s.startswith('xe ') or s == 'ô tô'}
    requested_vehicles = {s for s in requested['scope'] if s.startswith('xe ') or s == 'ô tô'}
    if requested_vehicles and vehicle_scopes - requested_vehicles:
        return False
    document_number = payload['documents'].get(item['doc_id'], {}).get('so_hieu') or ''
    if requested['documents'] and {v.casefold() for v in requested['documents']} != {document_number.casefold()}:
        return False  # Mentioning another document in the source does not change its owner.
    coordinates = _unit_references(item['metadata'], text)
    bindings = _reference_bindings(query)
    if item['entity_type'].endswith('.LegalUnit') and any(b[1] for b in bindings):
        own_bindings = _reference_bindings(document_number+' '+coordinates)
        # A verified amendment parent can locate its child in the amended article.
        for source, citation in parents:
            if (source['metadata'].get('unit_type') == 'Dieu'
                    and source['metadata'].get('dieu_number') == item['metadata'].get('dieu_number')
                    and re.match(r'\s*Điều\s+'+re.escape(str(source['metadata']['dieu_number']))+r'[.]\s+', citation.quote, re.I)):
                for statement in re.split(r'(?<!\d)[;.!?\n](?!\d)', citation.quote):
                    if re.search(r'\b(?:không|chưa|nếu|khi|trừ|sẽ)\b', statement, re.I):
                        continue
                    for target in re.findall(r'\b(?:sửa(?: đổi)?(?:, bổ sung)?|bổ sung)\s+(?:tại\s+)?Điều\s+(\d+[a-zđ]?)\b', statement, re.I):
                        own_bindings.update((doc, 'điều '+target.casefold(), clause, point)
                                            for doc, _, clause, point in tuple(own_bindings))
        if not all(any(all(expected is None or expected.casefold() == (actual or '').casefold() for expected, actual in zip(binding, own))
                       for own in own_bindings) for binding in bindings):
            return False
    # Numbered source paragraphs need their verified typed coordinates, as in planner grounding.
    authority = text+'\n'+canonical_json(item['metadata'])+'\n'+document_number+'\n'+context_text+'\n'+coordinates
    if not query_content_terms(query) <= {word.casefold() for word in re.findall(r'[^\W\d_]+', authority)}:
        return False
    provided = material_constraints(authority)
    for kind in ('documents', 'references', 'negation'):
        required={v.casefold() for v in requested[kind]} if kind in ('references', 'documents') else requested[kind]
        available={v.casefold() for v in provided[kind]} if kind in ('references', 'documents') else provided[kind]
        if not required <= available:
            return False
    if parent and not parents:
        return False
    # A bare monetary fragment has no applicability authority. Presence of
    # explicit scope/context is necessary, never a general entailment proof.
    if re.search(r'\bphạt\b|\bđồng\b', text, re.I) and not own_scope:
        return False
    return True


def _question_parts(query):
    parts = [part.strip() for part in _clauses(query) if query_content_terms(part)]
    documents = material_constraints(query)['documents']
    articles = {v.casefold() for v in material_constraints(query)['references'] if v.casefold().startswith('điều ')}
    for i, part in enumerate(parts):
        # A single explicit document remains context for the following question clauses.
        if len(documents) == 1 and not material_constraints(part)['documents']:
            parts[i] += ' '+next(iter(documents))
        if len(documents) <= 1 and len(articles) == 1 and not any(
                v.casefold().startswith('điều ') for v in material_constraints(part)['references']):
            parts[i] += ' '+next(iter(articles))
    return parts


def _support_linked(item, citation, facts, payload, value):
    for fact, fact_citation in facts:
        if item['doc_id'] != fact['doc_id']:
            continue
        if item['entity_type'].endswith('.LegalDocument') and citation.field in _META['LegalDocument']:
            return True
        if item['entity_id'] == fact['entity_id'] and citation.field == fact_citation.field:
            return True
        if citation.field == 'text' and item['unit_id'] == fact['metadata'].get('parent_id'):
            return True
        if value['conflict'] == 'resolved' and citation.field == 'text':
            relations = [rel for source in payload['items'] for rel in source['graph_context']]
            if any(rel['predicate'] in ('amends', 'repeals') and rel['from'][1] == fact['doc_id']
                   and rel['to'][1] != fact['doc_id'] for rel in relations):
                return True  # Resolution text/target/polarity are checked separately below.
    return False


def _explicit_resolution(text, target):
    pattern = (r'\b(?:bãi bỏ toàn bộ|thay thế toàn bộ)\s+'
               r'(?:(?:nghị định|thông tư|luật|quyết định|văn bản)\s+(?:số\s+)?)?'
               + re.escape(target)+r'(?![\w/-])')
    for clause in re.split(r'(?<!\d)[;.!?\n](?!\d)', text):
        if re.search(pattern, clause, re.I) and not re.search(
                r'\b(?:không|chưa|trừ|ngoại trừ|một phần|chỉ|sẽ|nếu|khi|kể từ|từ ngày)\b', clause, re.I):
            return True
    return False


def _conflict_resolved(query, value, facts, support, payload, as_of):
    baseline = facts[0][1].quote
    parents = {(fact['doc_id'], fact['metadata'].get('parent_id')) for fact, _ in facts}
    linked_parents = {(item['doc_id'], item['unit_id']) for item, citation in support
                      if citation.field == 'text' and (item['doc_id'], item['unit_id']) in parents}
    competing = set()
    for item in payload['items']:
        field = 'text' if item['entity_type'].endswith('.LegalUnit') else 'moTa' if item['sign_id'] else None
        if not field or (item['doc_id'], item['unit_id']) in linked_parents:
            continue
        if not any(_applicable(part, item, support, payload) for part in _question_parts(query)):
            continue
        if not _current(item, payload['documents'], as_of):
            props = payload['documents'].get(item['doc_id'], {})
            try:
                outside = (_iso_date(props.get('effective_from')) > as_of
                           or props.get('effective_to') and _iso_date(props['effective_to']) < as_of)
            except CandidateError:
                outside = False
            if outside and not _partial_period(props):
                continue
        # ponytail: distinct relevant whole fields mean uncertainty, not semantic
        # contradiction proved. Passage-level scope mapping is a later phase.
        if item['source_texts'].get(field) != baseline:
            competing.add((item['doc_id'], item['entity_id']))
    if value['conflict'] == 'none' and not competing:
        return True
    if value['conflict'] != 'resolved' or not support or not competing:
        return False
    winner_ids = {item['doc_id'] for item, _ in facts}
    if len(winner_ids) != 1:
        return False
    winner = next(iter(winner_ids))
    targets = {doc_id for doc_id, _ in competing}
    if winner in targets:
        return False  # No whole-document repeal can disambiguate units in that same document.
    proven = set()
    for relation in (rel for item in payload['items'] for rel in item['graph_context']):
        target_id = relation['to'][1]
        if relation['predicate'] not in ('amends', 'repeals') or relation['from'][1] != winner or target_id not in targets:
            continue
        target = payload['documents'].get(target_id, {}).get('so_hieu')
        if target and any(item['doc_id'] == winner and citation.field == 'text'
                          and _explicit_resolution(citation.quote, target) for item, citation in support):
            proven.add(target_id)
    return targets <= proven


DOCUMENT_CONTENT_ANSWER = 'Trích nội dung nguồn (không xác nhận hiệu lực hiện hành):\n'


def document_content_question(query):
    """Explicit document lookup intent never asserts applicability at as_of."""
    from kag.legal_prompts import exact_source_question
    if exact_source_question(query):
        return query.removeprefix(DOCUMENT_CONTENT_PREFIX).strip()
    if type(query) is not str or not query.startswith(DOCUMENT_CONTENT_PREFIX):return None
    question=query[len(DOCUMENT_CONTENT_PREFIX):].strip()
    if (not question or len(material_constraints(question)['documents'])!=1
            or re.search(r'hiện hành|hiện nay|đang áp dụng|còn hiệu lực|có hiệu lực|ngày hiệu lực',question,re.I)):
        return None
    return question


def _complete_partial_unit(record):
    """A corpus selection may omit descendants; inspect its hash-bound original unit family."""
    from collections.abc import Mapping
    from kag.builder.inputs import SOURCE_FILES
    from kag.builder.production_scope import ROOT
    locator=record.metadata.get('source_record')
    relative=dict(SOURCE_FILES)['units']
    if (not isinstance(locator,Mapping) or locator.get('source_path')!=relative
            or type(locator.get('line')) is not int or locator['line']<1):
        return False
    digest=hashlib.sha256();units=[];origin=None
    try:
        with (ROOT/relative).open('rb') as stream:
            for number,line in enumerate(stream,1):
                digest.update(line)
                if not line.strip():continue
                row=json.loads(line)
                if type(row) is not dict:raise ValueError('invalid original unit')
                if number==locator['line']:origin=row
                if row.get('doc_id')==record.doc_id:units.append(row)
    except OSError:
        return False
    if digest.hexdigest()!=locator.get('file_sha256'):
        return False
    if (origin is None or origin.get('unit_id')!=record.entity_id or origin.get('doc_id')!=record.doc_id
            or origin.get('text')!=record.source_text
            or any(origin.get(key)!=record.metadata.get(key) for key in (
                'unit_type','parent_id','dieu_number','khoan_number','diem_letter'))):
        raise ValueError('source origin does not match sealed unit')
    if len({row.get('unit_id') for row in units})!=len(units):
        raise ValueError('duplicate original unit identity')
    children={}
    for row in units:
        if row.get('parent_id'):
            children.setdefault(row['parent_id'],[]).append(row)
    pending=[origin];seen=set()
    while pending:
        unit=pending.pop()
        if unit['unit_id'] in seen or not unit.get('text') or unit['text'] not in record.source_text:
            return False
        seen.add(unit['unit_id']);pending.extend(children.get(unit['unit_id'],()))
    return True


def exact_source_answer(query, *, source_records, contract, partial=False):
    """Quote a complete sealed source field; final source readback remains mandatory."""
    from kag.legal_prompts import exact_source_question
    if not exact_source_question(query):
        return None
    lookup={}
    for record in source_records:
        key=record.entity_type,record.entity_id,record.field
        if key in lookup:
            raise ValueError('duplicate source identity')
        lookup[key]=record
    retriever=Retriever(None,None,contract,source_records=source_records)
    keys=retriever._exact_keys(query,retriever.search_k)
    if not keys:
        return None
    entity_type,identity=keys[0]
    field='title' if entity_type.endswith('.LegalDocument') else 'text'
    record=lookup.get((entity_type,identity,field))
    if record is None:
        return None
    document=lookup.get((contract['namespace']+'.LegalDocument',record.doc_id,'title'))
    if document is None:
        return None
    kind=document.metadata.get('loai')
    number=document.metadata.get('so_hieu')
    if (not kind or not number or not re.search(r'(?:văn bản|'+re.escape(kind.casefold())+
            r')(?: số)?\s+'+re.escape(number.casefold())+r'(?!\w)',query.casefold())):
        return None
    if field=='text':
        if partial and not _complete_partial_unit(record):
            return None
        unit_type=record.metadata.get('unit_type')
        number=str(record.metadata.get({'Dieu':'dieu_number','Khoan':'khoan_number','Diem':'diem_letter'}.get(unit_type,'')) or '')
        if unit_type=='Dieu':
            lines=record.source_text.split('\n',1)
            if (len(lines)!=2 or not lines[1].strip()
                    or not re.match(r'\s*điều\s+'+re.escape(number)+r'(?:\.|\s|$)',lines[0],re.I)):
                return None
        elif unit_type in ('Khoan','Diem'):
            label='khoản' if unit_type=='Khoan' else 'điểm'
            if not re.match(r'\s*(?:'+label+r'\s+)?'+re.escape(number)+r'[.)]\s+\S',record.source_text,re.I):
                return None
        else:
            return None
        # A parent heading alone cannot stand in for its separately stored descendants.
        children={}
        for child in source_records:
            if child.entity_type==entity_type and child.field=='text' and child.metadata.get('parent_id'):
                children.setdefault(child.metadata['parent_id'],[]).append(child)
        pending=[record];seen=set()
        while pending:
            parent=pending.pop()
            if parent.entity_id in seen:
                return None
            seen.add(parent.entity_id)
            for child in children.get(parent.entity_id,()):
                if child.doc_id!=record.doc_id or child.source_text not in record.source_text:
                    return None
                pending.append(child)
    citation=Citation(record.doc_id,record.unit_id,record.sign_id,record.evidence_id,
                      record.field,0,len(record.source_text),record.source_text)
    return AnswerResult(DOCUMENT_CONTENT_ANSWER+record.source_text,(citation,),False)


class SafeLegalGenerator(GeneratorABC):
    @legal_timing('generator.total')
    def invoke(self, query, context, **kwargs):
        evidence = context.kwargs.get('legal_evidence')
        response = context.kwargs.get('legal_candidate')
        as_of = kwargs.get('as_of')
        if type(as_of) is not date:
            raise ValueError('request as_of must be a date')
        if not isinstance(evidence, LegalEvidenceResponse) or not isinstance(response, LegalCandidateResponse):
            return _abstain('missing fresh legal evidence/candidate')
        bound, payload = response.payload(), evidence.payload()
        if bound['evidence_fingerprint'] != evidence.fingerprint or bound['original_question'] != query or bound['as_of'] != as_of.isoformat() or payload['original_question'] != query:
            return _abstain('stale or mismatched candidate')
        if payload['budget_exceeded']:
            return _abstain('evidence exceeds demo source budget')
        try:
            content_question=document_content_question(query)
            value = LegalDeducePrompt(language='vi').parse_response(bound['candidate'])
            if (value['abstained'] or value['applicability'] != 'supported' or not value['selections']
                    or (value['conflict']!='none' if content_question else value['effectivity']!='supported')):
                return _abstain('insufficient legal authority')
            index = _span_index(payload)
            facts = [_resolve(span, index) for span in value['selections']]
            support = [_resolve(span, index) for span in value['support_selections']]
            parts = _question_parts(content_question or query)
            covered = set()
            if any((not content_question and not _current(item, payload['documents'], as_of))
                   or not _support_linked(item, citation, facts, payload, value) for item, citation in support):
                return _abstain('unverified support applicability/effectivity')
            for item, citation in facts:
                factual = (item['entity_type'].endswith('.LegalUnit') and citation.field == 'text'
                           or item['entity_type'].endswith('.TrafficSign') and citation.field == 'moTa'
                           or document_title_question(query) and item['entity_type'].endswith('.LegalDocument') and citation.field == 'title')
                matched = {i for i, part in enumerate(parts) if _applicable(part, item, support, payload)}
                if (not factual or (not content_question and not _current(item, payload['documents'], as_of))
                        or not matched):
                    return _abstain('unverified source applicability/effectivity')
                covered.update(matched)
            if not parts or covered != set(range(len(parts))):
                return _abstain('incomplete question coverage')
            if not content_question and not _conflict_resolved(query, value, facts, support, payload, as_of):
                return _abstain('unresolved legal conflict')
        except (CandidateError, KeyError, TypeError, ValueError):
            return _abstain('invalid source selection')
        citations = tuple(dict.fromkeys(c for _, c in facts+support))
        answer = (DOCUMENT_CONTENT_ANSWER if content_question else 'Căn cứ nguồn đã xác nhận:\n')+'\n\n'.join(c.quote for c in citations)
        return AnswerResult(answer, citations, False)


class _ThreadedPlannerClient(LLMClient):
    """Use SDK sync transport/parser safely across facade event loops.

    SDK AsyncOpenAI/AsyncLimiter are loop-bound. Both legal executors and
    planner delegate to the same thread-safe SDK sync invocation; no new retry.
    """
    def __init__(self, delegate):
        self.delegate = delegate
        self.model = delegate.model

    def invoke(self, variables, prompt_op, **kwargs):
        context = kwargs.get('context')
        last = context.last_task() if context is not None else None
        response = context.kwargs.get('legal_candidate') if context is not None else None
        if (last is not None and last.executor == 'Deduce'
                and isinstance(response, LegalCandidateResponse) and last.result is response
                and response.payload()['deduce_task'] == last.id):
            result = SafeLegalGenerator().invoke(variables['query'], context, as_of=kwargs.get('as_of'))
            if not result.abstained:
                # Finish needs no inference once the current candidate has passed the server checks.
                legal_trace('planner.finish', reason=result.reason or 'verified candidate')
                return prompt_op.parse_response({'executor': {'name': 'Finish', 'arguments': {}}},
                                                query=variables['query'], context=variables.get('context'))
        legal_trace('planner.input', query=variables.get('query'), executors=variables.get('executors'))
        with legal_timing('planner.total'):
            try:
                tasks = self.delegate.invoke(variables, prompt_op, **kwargs)
            except RuntimeError as exc:
                rejected = exc.__context__
                if not isinstance(rejected, UnsafeSubqueryError):
                    raise
                # Discard the unsafe proposal; the original question must pass the same guard.
                legal_trace('planner.query_fallback', reason=str(rejected))
                tasks = prompt_op.parse_response({'executor': {'name': rejected.executor,
                    'arguments': {'query': variables['query']}}}, **variables)
        tried = {t.arguments.get('query') for t in context.gen_task() if t.executor == 'Retriever'} if context is not None else set()
        if (last is not None and last.executor == 'Retriever' and isinstance(last.result, LegalEvidenceResponse)
                and last.result is context.kwargs.get('legal_evidence')
                and last.result.payload()['original_question'] == variables['query']
                and tasks[0].executor == 'Retriever' and tasks[0].arguments.get('query') in tried):
            legal_trace('planner.assess', reason='repeated retrieval with unassessed evidence')
            return prompt_op.parse_response({'executor': {'name': 'Deduce',
                'arguments': {'query': variables['query']}}}, query=variables['query'], context=variables.get('context'))
        if (last is not None and isinstance(response, LegalCandidateResponse)
                and last.executor == 'Deduce' and last.result is response
                and response.payload()['deduce_task'] == last.id):
            task = tasks[0]
            if task.executor == 'Deduce' or task.executor == 'Retriever' and task.arguments.get('query') in tried:
                legal_trace('planner.finish', reason='no new retrieval direction after checked candidate')
                return prompt_op.parse_response({'executor': {'name': 'Finish', 'arguments': {}}},
                                                query=variables['query'], context=variables.get('context'))
        return tasks

    async def ainvoke(self, variables, prompt_op, **kwargs):
        return await asyncio.to_thread(self.invoke, variables, prompt_op, **kwargs)


def build_pipeline(retriever: Retriever, llm: LLMClient, *, retrieval=None) -> KAGIterativePipeline:
    if not isinstance(retriever, Retriever) or not isinstance(llm, LLMClient):
        raise ValueError('existing E Retriever and upstream LLMClient required')
    planner = KAGIterativePlanner(_ThreadedPlannerClient(llm), PromptABC.from_config({'type': 'viet_legal_planning', 'language': 'vi'}))
    deduce = LegalDeduceExecutor(llm, PromptABC.from_config({'type': 'viet_legal_deduce', 'language': 'vi'}))
    # Fresh list: upstream appends its own Finish; upstream default is five.
    return KAGIterativePipeline(planner, [LegalRetrieverExecutor(retriever, **(retrieval or {})), deduce], SafeLegalGenerator())


def _request_date(as_of):
    if as_of is None:
        return datetime.now(ZoneInfo('Asia/Saigon')).date()
    if type(as_of) is not date:
        raise ValueError('as_of must be a date, not datetime or inferred text')
    return as_of


def _request(question, pipeline, as_of):
    if not isinstance(question, str) or not question.strip():
        raise ValueError('nonempty exact question required')
    if not isinstance(pipeline, SolverPipelineABC):
        raise ValueError('upstream SolverPipelineABC required')
    return _request_date(as_of)


async def aanswer(question: str, *, pipeline: SolverPipelineABC, as_of: date | None = None) -> AnswerResult:
    request_date = _request(question, pipeline, as_of)
    result = await pipeline.ainvoke(question, as_of=request_date, reporter=None)
    if not isinstance(result, AnswerResult):
        raise RuntimeError('legal pipeline must produce server-built AnswerResult')
    return result


def answer(question: str, *, pipeline: SolverPipelineABC, as_of: date | None = None) -> AnswerResult:
    request_date = _request(question, pipeline, as_of)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(aanswer(question, pipeline=pipeline, as_of=request_date))
    raise RuntimeError('use await aanswer() inside an active event loop')
