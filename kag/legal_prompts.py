"""Vietnamese legal references and request traces."""
import re
from unicodedata import normalize
from contextvars import ContextVar
from contextlib import contextmanager
from time import perf_counter

_UNSOURCED_LEGAL = re.compile(
    r'\b(?:điều|khoản|trừ\s+điểm|điểm\s+giấy\s+phép|đồng|phạt|tước|giữ\s+xe|nghị\s+định|thông\s+tư|luật|vnđ|vnd|triệu|tỷ|tỉ|nghìn|ngàn)\b|₫', re.I)
_SEARCH_SANCTIONS = ('bao nhiêu tiền', 'bao nhiêu điểm', 'mấy điểm', 'bị phạt', 'mức phạt', 'xử phạt',
                     'bị trừ bao nhiêu điểm', 'bị trừ mấy điểm', 'bị trừ điểm', 'trừ bao nhiêu điểm', 'trừ mấy điểm',
                     'phạt tiền', 'phạt', 'trừ điểm giấy phép lái xe', 'trừ điểm gplx', 'trừ điểm',
                     'tước quyền sử dụng giấy phép lái xe', 'tước quyền sử dụng gplx', 'tước giấy phép lái xe',
                     'tước giấy phép', 'tước bằng', 'tước', 'giữ bằng')
_SEARCH_SANCTION = re.compile(r'\b(?:'+'|'.join(map(re.escape, sorted(_SEARCH_SANCTIONS,key=len,reverse=True)))+r')\b', re.I)
_LEGAL_TRACE = ContextVar('legal_trace', default=None)


def sanction_free_query(question):
    return ' '.join(_SEARCH_SANCTION.sub('', normalize('NFC', question)).split())


def legal_trace(stage, **data):
    sink = _LEGAL_TRACE.get()
    if sink is not None:
        sink(stage, data)


@contextmanager
def legal_timing(stage):
    started, outcome = perf_counter(), 'error'
    try:
        yield
        outcome = 'ok'
    finally:
        legal_trace(stage, duration_ms=round((perf_counter()-started)*1000, 3), outcome=outcome)

class CandidateError(ValueError):
    """Invalid model output, distinct from a model transport error."""


_DOCUMENT = re.compile(r'\b\d+/(?:\d{4}/[\wĐđ-]+|VBHN-[\wĐđ-]+)', re.UNICODE | re.I)
DOCUMENT_CONTENT_PREFIX = 'Trích nội dung văn bản: '


def document_number_matches(metadata, number):
    return any((metadata.get(field) or '').casefold() == number.casefold()
               for field in ('so_hieu', 'official_so_hieu'))


def qcvn_matches(query, qcvn):
    """An explicit QCVN year must match even when its authority is omitted."""
    actual = re.sub(r'\s+', '', str(qcvn or '')).casefold()
    for version, authority in re.findall(r'\b(QCVN\s*\d+\s*:\s*\d{4})(?:\s*/\s*([\w-]+))?', query, re.I):
        expected = re.sub(r'\s+', '', version).casefold()
        if actual.split('/')[0] != expected or authority and actual != expected+'/'+authority.casefold():
            return False
    return True


def document_title_question(query):
    """Only an explicit document-name lookup; mixed legal questions stay factual."""
    if not isinstance(query, str):
        return None
    question = query.removeprefix(DOCUMENT_CONTENT_PREFIX).strip()
    numbers = set(_DOCUMENT.findall(question))
    if len(numbers) != 1:
        return None
    number = next(iter(numbers))
    document = r'(?:văn bản(?: hợp nhất)?|nghị định|thông tư|luật|nghị quyết|quyết định)(?: số)?\s+'+re.escape(number.casefold())
    pattern = (r'(?:tên(?: đầy đủ)?(?: của)?\s+'+document+r'(?:\s+là gì)?|'
               +document+r'\s+(?:có )?tên(?: gọi)? là gì)\s*[?.]?')
    return number if re.fullmatch(pattern, question.casefold()) else None


def exact_source_question(query):
    """Only a document name or an explicit, single-coordinate quotation."""
    if document_title_question(query):
        return True
    if not isinstance(query,str):
        return False
    question=query.strip()
    if question.startswith(DOCUMENT_CONTENT_PREFIX):
        question=question[len(DOCUMENT_CONTENT_PREFIX):].strip()
    elif question.casefold().startswith('trích nguyên văn '):
        question=question[len('trích nguyên văn '):].strip()
    else:
        return False
    numbers=set(_DOCUMENT.findall(question))
    if len(numbers)!=1:
        return False
    article=r'điều\s+\d+[a-zđ]?'
    clause=r'khoản\s+\d+[a-zđ]?'
    point=r'điểm\s+[a-zđ]'
    unit=r'(?:'+point+r'\s+'+clause+r'\s+'+article+r'|'+clause+r'\s+'+article+r'|'+article+r')'
    document=r'(?:văn bản(?: hợp nhất)?|nghị định|thông tư|luật|nghị quyết|quyết định)(?: số)?\s+'
    return bool(re.fullmatch(unit+r'\s+(?:(?:của|thuộc)\s+)?'+document+
                            re.escape(next(iter(numbers)).casefold())+r'\s*[?.]?',question.casefold()))


_NUMBER = re.compile(r'(?<!\w)[+−-]?\d+(?:[.,/:–-]\d+)*(?:\s*%)?', re.UNICODE)
_IDENTIFIER = re.compile(r'\b(?=[\w:/@.-]*[^\W\d_])\w+(?:(?:::|[_:@./-])\w+)+\b')
_REFERENCE = re.compile(r'\b(?:Điều\s+\d+[a-zđ]?|khoản\s+\d+[a-zđ]?|điểm\s+[a-zđ])\b', re.I)
_SCOPE = re.compile(r'\b(?:xe mô tô|xe gắn máy|ô tô|xe ô tô|xe đạp điện|xe đạp|'
                    r'xe máy điện|xe máy chuyên dùng|xe máy|xe số|xe tay ga|xe tải|xe khách|người đi bộ|người điều khiển|'
                    r'người lái xe|chủ xe|cá nhân|tổ chức(?!\s+giao thông\b)|doanh nghiệp|trẻ em|'
                    r'người chưa thành niên|người thành niên)\b', re.I)
_NEGATION = re.compile(r'\b(?:không\s+(?:được\s+phép|chấp\s+hành|[^\W\d_]+)|'
                       r'chưa\s+(?:đủ|có|được)|không|chưa|cấm)\b', re.I)
def material_constraints(text):
    """Return literal legal anchors; matching never changes the source."""
    return {
        'documents': set(_DOCUMENT.findall(text)),
        'identities': set(_IDENTIFIER.findall(text)),
        'numbers': set(_NUMBER.findall(text)),
        'references': set(_REFERENCE.findall(text)),
        'scope': {v.casefold() for v in _SCOPE.findall(text)},
        'negation': {v.casefold() for v in _NEGATION.findall(text)},
    }


def _clauses(text):
    return [part for part in re.split(
        r'(?<!\d)[;.!?\n](?!\d)|\b(?:và|hoặc)\s+(?=Điều\b|xe\b|ô tô\b|'
        r'người\b|cá nhân\b|tổ chức\b|doanh nghiệp\b|công ty\b|ông\b|bà\b|anh\b|chị\b)',
        text, flags=re.I) if part.strip()]


def _reference_bindings(text):
    bindings = set()
    documents = _DOCUMENT.findall(text)
    current_document = documents[0] if len(set(documents)) == 1 else None
    for part in _clauses(text):
        references = list(_REFERENCE.finditer(part))
        docs = list(_DOCUMENT.finditer(part))
        articles = [match for match in references if match.group().casefold().startswith('điều')]
        owners = {}
        prefix = docs and articles and docs[0].start() < articles[0].start()
        for index, match in enumerate(articles):
            end = articles[index+1].start() if index+1 < len(articles) else len(part)
            candidates = ([doc for doc in docs if doc.start() < match.start()] if prefix
                          else [doc for doc in docs if match.end() <= doc.start() < end])
            owners[match.start()] = (candidates[-1 if prefix else 0].group() if candidates
                                    else current_document)
        article = clause = None
        article_document = current_document
        for index, match in enumerate(references):
            reference = match.group().casefold()
            if reference.startswith('điều'):
                article, clause = reference, None
                article_document = owners[match.start()]
                bindings.add((article_document, article, None, None))
            else:
                future = next((m for m in references[index+1:] if m.group().casefold().startswith('điều')), None)
                owner = article or (future.group().casefold() if future else None)
                doc = article_document if article else owners[future.start()] if future else docs[0].group() if len(docs)==1 else current_document
                if reference.startswith('khoản'):
                    clause = reference
                    bindings.add((doc, owner, clause, None))
                else:
                    parent = clause or next((m.group().casefold() for m in references[index+1:]
                                            if m.group().casefold().startswith('khoản')), None)
                    bindings.add((doc, owner, parent, reference))
        if docs:
            current_document = docs[-1].group()
    return bindings
