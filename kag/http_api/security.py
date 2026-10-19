"""Service-secret policy and bounded admission; never initialize KAG clients."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import hmac
import re
from uuid import UUID

from starlette.requests import ClientDisconnect, Request

from .contract import ApiFailure, QueryV1Request, RetrieveRequest

BODY_LIMIT = 65536
BODY_TIMEOUT_SECONDS = 5
_TOKEN = re.compile(r'[A-Za-z0-9._~+/-]+=*')


@dataclass(frozen=True)
class ServicePrincipal:
    service_id: str
    scopes: frozenset[str]
    can_delegate_user: bool

    def __post_init__(self):
        if (type(self.service_id) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', self.service_id)
                or type(self.scopes) is not frozenset or not self.scopes <= {'query', 'inspect', 'credentials-write', 'provider-test', 'config-apply'}
                or type(self.can_delegate_user) is not bool):
            raise ApiFailure('NOT_READY')


@dataclass(frozen=True)
class ServiceSecrets:
    query_tokens: tuple[str, ...] = field(default=(), repr=False)
    inspect_tokens: tuple[str, ...] = field(default=(), repr=False)
    credentials_write_tokens: tuple[str, ...] = field(default=(), repr=False)
    provider_test_tokens: tuple[str, ...] = field(default=(), repr=False)
    config_apply_tokens: tuple[str, ...] = field(default=(), repr=False)

    def __post_init__(self):
        seen = set()
        for tokens in (self.query_tokens, self.inspect_tokens, self.credentials_write_tokens,
                       self.provider_test_tokens, self.config_apply_tokens):
            if type(tokens) is not tuple or len(tokens) > 2:
                raise ApiFailure('NOT_READY')
            for token in tokens:
                # Operators generate >=32 random bytes, then encode as a bearer-safe string.
                if (type(token) is not str or not 43 <= len(token) <= 512
                        or not _TOKEN.fullmatch(token) or token in seen):
                    raise ApiFailure('NOT_READY')
                seen.add(token)


def authenticate(header: str | None, secrets: ServiceSecrets) -> ServicePrincipal:
    if header is None:
        raise ApiFailure('AUTH_REQUIRED')
    if type(header) is not str or len(header) > 1024:
        raise ApiFailure('AUTH_INVALID')
    match = re.fullmatch(r'(?i:Bearer) ([A-Za-z0-9._~+/-]+=*)', header)
    if not match:
        raise ApiFailure('AUTH_INVALID')
    candidate = match[1].encode('ascii')
    principal = None
    for tokens, identity in (
        (secrets.query_tokens, ServicePrincipal('webapp-query', frozenset({'query'}), True)),
        (secrets.inspect_tokens, ServicePrincipal('inspect', frozenset({'inspect'}), False)),
        (secrets.credentials_write_tokens, ServicePrincipal('credentials-writer', frozenset({'credentials-write'}), False)),
        (secrets.provider_test_tokens, ServicePrincipal('provider-tester', frozenset({'provider-test'}), False)),
        (secrets.config_apply_tokens, ServicePrincipal('config-applier', frozenset({'config-apply'}), False)),
    ):
        for token in tokens:
            if hmac.compare_digest(candidate, token.encode('ascii')):
                principal = identity
    if principal is None:
        raise ApiFailure('AUTH_INVALID')
    return principal


def authorize(principal: ServicePrincipal, scope: str, user_id: UUID | None) -> None:
    if type(principal) is not ServicePrincipal or scope not in principal.scopes:
        raise ApiFailure('SCOPE_DENIED')
    if user_id is not None:
        if type(user_id) is not UUID:
            raise ApiFailure('INVALID_REQUEST')
        if not principal.can_delegate_user:
            raise ApiFailure('DELEGATION_DENIED')


def request_principal(request: Request) -> ServicePrincipal:
    headers = request.headers.getlist('authorization')
    if len(headers) > 1:
        raise ApiFailure('AUTH_INVALID')
    principal = authenticate(headers[0] if headers else None, request.app.state.http_settings.secrets)
    request.state.service_principal = principal
    return principal


async def bounded_body(request: Request, *, limit=BODY_LIMIT) -> bytes:
    lengths = request.headers.getlist('content-length')
    expected = None
    if lengths:
        if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,20}', lengths[0]):
            raise ApiFailure('INVALID_REQUEST')
        expected = int(lengths[0])
        if expected > limit:
            raise ApiFailure('REQUEST_TOO_LARGE')
        if request.headers.get('transfer-encoding'):
            raise ApiFailure('INVALID_REQUEST')
    media = request.headers.getlist('content-type')
    encodings = request.headers.getlist('content-encoding')
    if (len(media) != 1 or not re.fullmatch(
            r'application/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?', media[0], re.IGNORECASE)
            or len(encodings) > 1 or (encodings and encodings[0].lower() != 'identity')):
        raise ApiFailure('UNSUPPORTED_MEDIA_TYPE')

    async def consume():
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > limit:
                raise ApiFailure('REQUEST_TOO_LARGE')
            body.extend(chunk)
        if expected is not None and expected != len(body):
            raise ApiFailure('INVALID_REQUEST')
        return bytes(body)

    try:
        return await asyncio.wait_for(consume(), timeout=BODY_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        raise ApiFailure('QUERY_TIMEOUT') from None
    except ClientDisconnect:
        raise ApiFailure('INVALID_REQUEST') from None


async def admit_request(request: Request, scope: str, dto=QueryV1Request):
    """Internal admission for future routes; no route is registered here."""
    principal = request_principal(request)
    authorize(principal, scope, None)
    from .contract import SampleVectorRequest
    if dto in (RetrieveRequest, SampleVectorRequest):
        authorize(principal, 'inspect', None)
    if any(name in request.headers for name in ('x-user-id', 'user_id', 'x-service-id')):
        raise ApiFailure('INVALID_REQUEST')
    if dto not in (QueryV1Request, RetrieveRequest, SampleVectorRequest):
        raise ApiFailure('NOT_READY')
    parsed = dto.from_json(await bounded_body(request))
    if dto is QueryV1Request:
        user_id = UUID(parsed.user_id)
        authorize(principal, scope, user_id)
        request.state.delegated_user_id = user_id
    return parsed
