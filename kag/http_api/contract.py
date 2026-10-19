"""Pure strict DTOs and lossless, fail-closed Java v1 projection."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import math
import re
from typing import TYPE_CHECKING
from uuid import UUID
from urllib.parse import urlsplit

from kag.builder.codec import canonical_json

if TYPE_CHECKING:
    from kag.legal_solver import AnswerResult
    from .artifacts import VerifiedSources


_ERRORS = {
    'INVALID_JSON': (400, 'JSON không hợp lệ.', None),
    'AUTH_REQUIRED': (401, 'Cần xác thực dịch vụ.', None),
    'AUTH_INVALID': (401, 'Xác thực dịch vụ không hợp lệ.', None),
    'SCOPE_DENIED': (403, 'Quyền dịch vụ không được phép.', None),
    'DELEGATION_DENIED': (403, 'Ủy quyền người dùng không được phép.', None),
    'REQUEST_TOO_LARGE': (413, 'Yêu cầu vượt giới hạn.', None),
    'UNSUPPORTED_MEDIA_TYPE': (415, 'Định dạng yêu cầu không được hỗ trợ.', None),
    'NOT_READY': (503, 'Dịch vụ chưa sẵn sàng.', None),
    'QUERY_TIMEOUT': (504, 'Yêu cầu hết thời gian.', None),
    'INTERNAL_ERROR': (500, 'Lỗi nội bộ dịch vụ.', None),
    'INVALID_REQUEST': (422, 'Yêu cầu không hợp lệ.', None),
    'CONTEXT_NOT_SUPPORTED': (422, 'Context chưa được hỗ trợ.', None),
    'INVALID_NATIVE_RESULT': (502, 'Kết quả KAG không hợp lệ.', None),
    'SOURCE_VALIDATION_FAILED': (502, 'Nguồn không được xác minh.', None),
    'KAG_ABSTAINED': (503, 'Chưa đủ bằng chứng để trả lời.', 'abstained'),
    'V1_RESULT_UNREPRESENTABLE': (503, 'Kết quả không biểu diễn được bằng v1.', 'answered'),
    'SCHEMA_CONTRACT_MISMATCH': (409, 'Contract không khớp.', None),
    'RELEASE_MISMATCH': (409, 'Release không khớp.', None),
    'SOURCE_SNAPSHOT_MISMATCH': (409, 'Snapshot nguồn không khớp.', None),
    'DATE_MISMATCH': (409, 'Ngày yêu cầu không khớp.', None),
    'DATE_BOUNDARY_CHANGED': (409, 'Ngày phục vụ đã thay đổi.', None),
    'CONCURRENCY_LIMIT': (429, 'Dịch vụ đang xử lý yêu cầu khác.', None),
    'RELEASE_UNAVAILABLE': (503, 'Release chưa khả dụng.', None),
    'BACKEND_UNAVAILABLE': (503, 'Nguồn phụ thuộc chưa khả dụng.', None),
    'PROVIDER_ERROR': (502, 'Dịch vụ suy luận chưa khả dụng.', None),
    'RESULT_LIMIT_EXCEEDED': (502, 'Kết quả vượt giới hạn truyền tải.', None),
    'CONFIG_CONFLICT': (409, 'Cấu hình vừa thay đổi hoặc thao tác không còn phù hợp. Hãy tải lại.', None),
    'CONFIG_BUSY': (409, 'Runtime đang bận hoặc chưa an toàn để áp dụng. Hãy thử lại khi rảnh.', None),
    'CONFIG_STORAGE_UNAVAILABLE': (503, 'Không đọc hoặc ghi được cấu hình đã lưu.', None),
    'CONFIG_INVALID': (503, 'Cấu hình đã lưu không hợp lệ. Cần kiểm tra phía triển khai.', None),
}


class ApiFailure(Exception):
    """Fixed public failures; never accept an internal exception/message."""
    def __init__(self, code: str):
        self.code = code
        self.status, self.message, self.native_state = _ERRORS[code]
        self.retryable = False
        super().__init__(self.message)


def _text(value) -> bool:
    if type(value) is not str:
        return False
    try:
        value.encode('utf-8', errors='strict')
        return True
    except UnicodeError:
        return False


def utf16_units(value: str) -> int:
    if not _text(value):
        raise ApiFailure('INVALID_REQUEST')
    return len(value.encode('utf-16-le')) // 2


def _object(value, required, optional=()):
    if type(value) is not dict or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ApiFailure('INVALID_REQUEST')


def _json_value(value):
    if value is None or type(value) in (bool, int):
        return
    if type(value) is str and _text(value):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        for item in value:
            _json_value(item)
        return
    if type(value) is dict and all(type(key) is str and _text(key) for key in value):
        for item in value.values():
            _json_value(item)
        return
    raise ValueError('invalid JSON value')


class _Request:
    @classmethod
    def from_json(cls, raw: bytes):
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError('duplicate JSON key')
                result[key] = value
            return result

        def constant(value):
            raise ValueError('nonfinite JSON')

        try:
            if type(raw) is not bytes:
                raise ValueError('UTF-8 bytes required')
            value = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                               parse_constant=constant)
            _json_value(value)
        except (ValueError, TypeError, RecursionError):
            raise ApiFailure('INVALID_JSON') from None
        return cls.from_dict(value)

    @classmethod
    def from_dict(cls, value):
        required = ('user_id', 'message', 'context_id', 'schema_contract') if cls is QueryV1Request else (
            'evidence_id' if cls is SampleVectorRequest else 'message', 'schema_contract')
        _object(value, required, () if cls is QueryV1Request else ('top_k', 'expand'))
        return cls(**{**value, 'schema_contract': SchemaIdentity.from_dict(value['schema_contract'])})


@dataclass(frozen=True)
class SchemaIdentity:
    namespace: str
    schema_sha256: str
    contract_sha256: str

    def __post_init__(self):
        if (not _text(self.namespace) or not self.namespace.strip() or
                any(type(v) is not str or not re.fullmatch('[0-9a-f]{64}', v)
                    for v in (self.schema_sha256, self.contract_sha256))):
            raise ApiFailure('INVALID_REQUEST')

    @classmethod
    def from_dict(cls, value):
        _object(value, ('namespace', 'schema_sha256', 'contract_sha256'))
        return cls(**value)


def _request(user_id, message, schema_contract):
    try:
        if not _text(user_id) or str(UUID(user_id)) != user_id:
            raise ValueError('canonical UUID required')
    except ValueError:
        raise ApiFailure('INVALID_REQUEST') from None
    if (not _text(message) or not message.strip() or utf16_units(message) > 4000 or
            type(schema_contract) is not SchemaIdentity):
        raise ApiFailure('INVALID_REQUEST')


@dataclass(frozen=True)
class QueryV1Request(_Request):
    user_id: str
    message: str
    context_id: str
    schema_contract: SchemaIdentity

    def __post_init__(self):
        _request(self.user_id, self.message, self.schema_contract)
        if not _text(self.context_id) or utf16_units(self.context_id) > 250:
            raise ApiFailure('INVALID_REQUEST')
        if self.context_id:
            raise ApiFailure('CONTEXT_NOT_SUPPORTED')


@dataclass(frozen=True)
class RetrieveRequest(_Request):
    """Service-only request for the h1-read-v1.1 retrieve contract."""
    message: str
    schema_contract: SchemaIdentity
    top_k: int = 10
    expand: bool = False

    def __post_init__(self):
        if (not _text(self.message) or not self.message.strip() or utf16_units(self.message) > 4000 or
                type(self.schema_contract) is not SchemaIdentity):
            raise ApiFailure('INVALID_REQUEST')
        retrieval_options({'top_k': self.top_k, 'expand': self.expand})


def retrieval_options(value):
    _object(value, ('top_k', 'expand'))
    if type(value['top_k']) is not int or not 1 <= value['top_k'] <= 10 or type(value['expand']) is not bool:
        raise ApiFailure('INVALID_REQUEST')
    return dict(value)


@dataclass(frozen=True)
class ChatConfigChange(_Request):
    revision: int
    values: dict | None = None

    @classmethod
    def from_dict(cls, value):
        _object(value, ('revision',), ('values',))
        if type(value['revision']) is not int or not 0 <= value['revision'] < 2147483647:
            raise ApiFailure('INVALID_REQUEST')
        return cls(value['revision'], retrieval_options(value['values']) if 'values' in value else None)


def llm_options(value):
    _object(value, ('base_url', 'model'), ('api_key', 'provider'))
    if value.get('provider', 'openai-compatible') != 'openai-compatible':
        raise ApiFailure('INVALID_REQUEST')
    model, endpoint = value['model'], value['base_url']
    if type(model) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}', model):
        raise ApiFailure('INVALID_REQUEST')
    try:
        if type(endpoint) is not str or len(endpoint) > 2048 or re.search(r'[\s\x00-\x1f\x7f]', endpoint):
            raise ValueError()
        url = urlsplit(endpoint)
        if (url.scheme not in ('http', 'https') or not url.hostname or url.port == 0
                or url.username is not None or url.password is not None or url.query or url.fragment
                or not re.fullmatch(r'[A-Za-z0-9.:-]{1,253}', url.hostname)):
            raise ValueError()
    except (ValueError, TypeError):
        raise ApiFailure('INVALID_REQUEST') from None
    if 'api_key' in value and (type(value['api_key']) is not str or not re.fullmatch(r'[!-~]{1,4096}', value['api_key'])):
        raise ApiFailure('INVALID_REQUEST')
    return dict(value, base_url=endpoint.rstrip('/'), provider='openai-compatible')


@dataclass(frozen=True, repr=False)
class LLMCredentialsChange(_Request):
    revision: int
    chat: dict | None = None
    embedding: dict | None = None

    @classmethod
    def from_dict(cls, value):
        _object(value, ('revision',), ('chat', 'embedding'))
        if (type(value['revision']) is not int or not 0 <= value['revision'] < 2147483647
                or not {'chat', 'embedding'} & value.keys()):
            raise ApiFailure('INVALID_REQUEST')
        return cls(value['revision'], **{role: llm_options(value[role])
                   for role in ('chat', 'embedding') if role in value})


@dataclass(frozen=True)
class SampleVectorRequest(_Request):
    """Select a sealed SAMPLE source vector; never accept a question or arbitrary vector."""
    evidence_id: str
    schema_contract: SchemaIdentity
    top_k: int = 10
    expand: bool = False

    def __post_init__(self):
        if (type(self.evidence_id) is not str or not re.fullmatch('[0-9a-f]{64}',self.evidence_id)
                or type(self.schema_contract) is not SchemaIdentity or type(self.top_k) is not int
                or not 1 <= self.top_k <= 10 or type(self.expand) is not bool):
            raise ApiFailure('INVALID_REQUEST')


def project_v1(result: AnswerResult, verified_sources: VerifiedSources, *, namespace='VietRoadTraffic') -> dict:
    # Import real native classes only after callers have bootstrapped their runtime.
    from kag.legal_solver import AnswerResult, Citation

    if (type(result) is not AnswerResult or type(result.abstained) is not bool or
            not _text(result.answer) or not result.answer.strip() or type(result.citations) is not tuple or
            any(type(c) is not Citation for c in result.citations)):
        raise ApiFailure('INVALID_NATIVE_RESULT')
    if result.abstained:
        if result.citations:
            raise ApiFailure('INVALID_NATIVE_RESULT')
        raise ApiFailure('KAG_ABSTAINED')
    if not result.citations:
        raise ApiFailure('INVALID_NATIVE_RESULT')

    dataset = getattr(verified_sources,'source_mode',None)=='dataset-snapshot-v1'
    representable = True
    try:
        sources = verified_sources.citations
        if type(sources) is not tuple or len(sources) != len(result.citations):
            raise ValueError('incomplete certificate')
        for citation, source in zip(result.citations, sources):
            kind = source.entity_type
            identities = {namespace+'.LegalUnit': citation.unit_id,
                          namespace+'.TrafficSign': citation.sign_id,
                          namespace+'.LegalDocument': citation.doc_id}
            if (source.citation != citation or type(source.citation) is not Citation or
                    not _text(citation.doc_id) or not citation.doc_id.strip() or
                    any(v is not None and (not _text(v) or not v.strip())
                        for v in (citation.unit_id, citation.sign_id)) or
                    not _text(source.entity_id) or not source.entity_id.strip() or
                    identities.get(kind) != source.entity_id or type(source.java_eligible) is not bool or
                    not _text(citation.field) or not citation.field.strip() or
                    not _text(source.source_text) or not source.source_text or
                    not _text(citation.quote) or citation.quote != source.source_text or
                    type(citation.start) is not int or type(citation.end) is not int or
                    citation.start != 0 or citation.end != len(source.source_text) or
                    citation.evidence_id != hashlib.sha256(canonical_json(
                        [kind, source.entity_id, citation.field]).encode('utf-8')).hexdigest()):
                raise ValueError('invalid source binding')
            representable &= ((dataset or kind == namespace+'.LegalUnit' and citation.field == 'text' and
                              citation.sign_id is None and source.java_eligible and
                              bool(citation.quote.strip())) and utf16_units(citation.quote) <= 20000)
    except (AttributeError, TypeError, ValueError):
        raise ApiFailure('SOURCE_VALIDATION_FAILED') from None

    if not representable or len(result.citations) > 20 or utf16_units(result.answer) > 20000:
        raise ApiFailure('V1_RESULT_UNREPRESENTABLE')
    citations = [asdict(c) for c in result.citations]
    if dataset:
        from collections.abc import Mapping
        def plain(value):
            if isinstance(value,Mapping):return {k:plain(v) for k,v in value.items()}
            if isinstance(value,tuple):return [plain(v) for v in value]
            return value
        for citation,source in zip(citations,sources):
            if source.metadata is None or source.document_metadata is None:
                raise ApiFailure('SOURCE_VALIDATION_FAILED')
            citation['source']=dict(contract_version='graph-source-v1',release_id=verified_sources.release_id,
                source_snapshot_id=verified_sources.source_snapshot_id,
                release_descriptor_sha256=verified_sources.release_descriptor_sha256,
                schema_contract=asdict(verified_sources.schema_contract),entity_type=source.entity_type,
                entity_id=source.entity_id,source_sha256=source.source_sha256,text=source.source_text,
                metadata=plain(source.metadata),document_metadata=plain(source.document_metadata),as_of=verified_sources.as_of.isoformat())
        return {'contract_version':'graph-chat-v1','answer':result.answer,'citations':citations}
    return {'answer': result.answer, 'citations': citations}


def encode_v1(payload: dict) -> bytes:
    try:
        if type(payload) is not dict:
            raise ValueError('object required')
        _json_value(payload)
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    except (TypeError, ValueError, RecursionError):
        raise ApiFailure('INVALID_NATIVE_RESULT') from None
    if len(raw) > 245760:
        raise ApiFailure('V1_RESULT_UNREPRESENTABLE')
    return raw


def encode_retrieve(payload: dict) -> bytes:
    """Same strict UTF-8 encoding, with the approved retrieve wire-limit error."""
    try:
        return encode_v1(payload)
    except ApiFailure as exc:
        if exc.code == 'V1_RESULT_UNREPRESENTABLE':
            raise ApiFailure('RESULT_LIMIT_EXCEEDED') from None
        raise
