"""Pinned Community SAMPLE inference through the existing fixed ingress gateway."""
import hashlib
from ipaddress import ip_address
import json
import re
import socket

import httpx

from kag.vector_contract import valid_vector
from . import artifacts as a
from .provider_budget import BudgetError, ProviderBudget, GATEWAY, GatewayTransport, AsyncGatewayTransport

EMBEDDING_URL = 'https://api.vilao.ai/v1'
EMBEDDING_MODEL = 'dg/text-embedding-3-large'
CHAT_URL = 'http://127.0.0.1:8317/v1'
CHAT_MODEL = 'gemini-3.8-flash-high'
LIMITS = {'embedding':3,'chat':7}


def development_policy(release, query_pin):
    """Existing operator query pin seals this policy; no public request can enable it."""
    raw=a._read(release.root,'sample-query.json')
    if hashlib.sha256(raw).hexdigest()!=query_pin:a._invalid()
    proof=a._json(raw)
    policy=proof.get('development_policy')
    if policy is None:return None
    a._keys(policy,('schema','scope','authorization_sha256','baseline_attempts',
                    *(('model_route',) if 'model_route' in policy else ())))
    if (release.release_kind!='SAMPLE' or release.descriptor['release_kind']!='SAMPLE'
            or proof.get('schema')!='h1-community-query-2.0'
            or policy['schema']!='h1-sample-development-policy-1.0' or policy['scope']!='SAMPLE_DEVELOPMENT'
            or type(policy['authorization_sha256']) is not str
            or not re.fullmatch('[0-9a-f]{64}',policy['authorization_sha256'])
            or type(policy['baseline_attempts']) is not dict or set(policy['baseline_attempts'])!={'embedding','chat'}
            or any(type(n) is not int or n<0 for n in policy['baseline_attempts'].values())):a._invalid()
    if 'model_route' in policy:_model_route(policy)
    return policy


def _model_route(policy):
    route=policy['model_route']
    a._keys(route,('schema','requested_model','response_version','upstream','proxy_binary_sha256',
        'proxy_config_sha256','trace_sha256','source_commit','exact_backend_identity_verified','identity_scope'))
    if (route['schema']!='h1-proxy-routing-1.0' or route['requested_model']!=CHAT_MODEL
            or route['response_version']!='gemini-3.8-flash-n'
            or route['upstream']!='https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent'
            or route['source_commit']!='1370789ee9bdc15b6f320499d24c0d37ca1889cf'
            or route['exact_backend_identity_verified'] is not False
            or route['identity_scope']!='REQUEST_ROUTE_AND_RESPONSE_VERSION'
            or any(type(route[key]) is not str or not re.fullmatch('[0-9a-f]{64}',route[key])
                   for key in ('proxy_binary_sha256','proxy_config_sha256','trace_sha256'))):a._invalid()
    return route


def response_model_matches(settings, observed):
    if observed==settings.chat_model:return True
    tested = getattr(settings,'chat_response_model',None)
    if tested is not None and observed==tested:return True
    policy=settings.development_policy
    if not policy or 'model_route' not in policy:return False
    route=_model_route(policy)
    return settings.chat_model==route['requested_model'] and observed==route['response_version']


def load_cache(raw, expected_sha256, *, model=EMBEDDING_MODEL):
    if hashlib.sha256(raw).hexdigest()!=expected_sha256:a._invalid()
    value=a._json(raw)
    a._keys(value,('question','question_sha256','model','endpoint','dimension','vector'))
    if (type(value['question']) is not str or not value['question'].strip()
            or hashlib.sha256(value['question'].encode()).hexdigest()!=value['question_sha256']
            or value['model']!=model or value['endpoint']!=EMBEDDING_URL
            or type(value['dimension']) is not int or value['dimension']!=3072
            or not valid_vector(value['vector'],3072)):a._invalid()
    return value


def cached_vector(cache, question):
    return list(cache['vector']) if question==cache['question'] else None


def provider_budget(settings):
    return ProviderBudget(settings.attempt_ledger,embedding_url=settings.embedding_url+'/embeddings',
        embedding_model=settings.embedding_model,chat_url=settings.chat_url+'/chat/completions',
        chat_model=settings.chat_model,limits={'embedding':None,'chat':None} if settings.development_policy else LIMITS,
        in_place=True,development_only=settings.development_policy is not None)


def load_proof(settings, release, *, capability='query'):
    if (release.release_kind!='SAMPLE' or release.descriptor['release_kind']!='SAMPLE' or not settings.query_proof_sha256
            or not re.fullmatch('[0-9a-f]{64}',settings.query_proof_sha256)
            or settings.reader_username or settings.reader_password or not settings.broker_url
            or (settings.embedding_url,settings.chat_url,settings.chat_model)!=(EMBEDDING_URL,CHAT_URL,CHAT_MODEL)
            or settings.provider_gateway!=GATEWAY or not settings.provider_gateway_token
            or not re.fullmatch('[A-Za-z0-9_-]{43,128}',settings.provider_gateway_token)
            or settings.attempt_ledger!='/provider-state/attempts.json'):a._invalid()
    if capability=='query' and (release.publication is None
            or release.publication['snapshot_id']!=settings.webapp_snapshot_id):a._invalid()
    raw=a._read(release.root,'sample-query.json')
    if hashlib.sha256(raw).hexdigest()!=settings.query_proof_sha256:a._invalid()
    proof=a._json(raw)
    policy=development_policy(release,settings.query_proof_sha256)
    if policy!=settings.development_policy:a._invalid()
    limits={'embedding':None,'chat':None} if policy else LIMITS
    a._keys(proof,('schema',*a._BINDING,'release_descriptor_sha256','sample_proof_sha256',
        'cache_sha256','ledger_binding_sha256','limits','gateway_ip','gateway_token_sha256','gateway_config_sha256',
        *(('development_policy',) if policy else ())))
    a._binding(proof,release.descriptor)
    if (proof['schema']!=('h1-community-query-2.0' if policy else 'h1-community-query-1.0')
            or proof['release_descriptor_sha256']!=release.descriptor_sha256
            or proof['sample_proof_sha256']!=settings.sample_proof_sha256 or proof['limits']!=limits
            or proof['gateway_token_sha256']!=hashlib.sha256(settings.provider_gateway_token.encode()).hexdigest()
            or proof['gateway_config_sha256']!=hashlib.sha256(a._read(release.root,'provider-gateway.cfg')).hexdigest()):a._invalid()
    address=ip_address(proof['gateway_ip'])
    if address.version!=4 or not address.is_private or address.is_loopback or address.is_unspecified:a._invalid()
    cache=load_cache(a._read(release.root,'query-embedding.json'),proof['cache_sha256'],model=settings.embedding_model)
    a.load_sample_proof(release,settings.sample_proof_sha256,None)
    a._verify_sample_provenance(release.root,model_identity=settings.embedding_url+'|'+settings.embedding_model)
    budget=provider_budget(settings)
    if budget.binding!=proof['ledger_binding_sha256']:a._invalid()
    counts=budget.counts()
    if policy and any(counts[k]<n for k,n in policy['baseline_attempts'].items()):a._invalid()
    # Four calls is the attested normal iterative path; every additional call still reserves before send.
    if capability=='query' and not policy and LIMITS['chat']-counts['chat']<4:
        raise BudgetError('PROVIDER_ATTEMPT_BUDGET_EXHAUSTED')
    a._unchanged(release)
    return proof,cache,budget


def verify_gateway(settings, proof):
    # Compose service DNS routes traffic; the sealed token/config, not a container IP, bind authority.
    address=ip_address(socket.gethostbyname('kag-ingress'))
    if (address.version!=4 or not address.is_private or address.is_loopback or address.is_link_local
            or address.is_unspecified or address.is_multicast or address.is_reserved):a._invalid()
    # A metadata request verifies real auth/model routing without executing inference.
    with httpx.Client(trust_env=False,follow_redirects=False,timeout=3) as client:
        response=client.get(GATEWAY+'/models',headers={'X-KAG-Provider-Token':settings.provider_gateway_token,
            'Authorization':'Bearer '+settings.chat_key})
        if response.status_code!=200 or len(response.content)>131072:a._invalid()
        body=a._json(response.content)
        if type(body.get('data')) is not list or not any(type(x) is dict and x.get('id')==CHAT_MODEL for x in body['data']):a._invalid()


def configure_model(settings, model, kind, *, component='direct_runner', request_id=None):
    budget=provider_budget(settings)
    if component not in ('direct_runner','kag.query','kag.retrieve') or (request_id is not None and
            (type(request_id) is not str or not re.fullmatch('[0-9a-f-]{32,36}',request_id))):
        raise BudgetError('PROVIDER_BINDING_INVALID')
    budget.source_component,budget.request_id=component,request_id
    for name,cls,transport in (('client',GatewayTransport,httpx.HTTPTransport(retries=0)),
                               ('aclient',AsyncGatewayTransport,httpx.AsyncHTTPTransport(retries=0))):
        client=getattr(model,name)._client
        client._transport=cls(transport,settings.provider_gateway,settings.provider_gateway_token,
                              str(budget.providers[kind][0]))
        client._mounts={}
    budget.configure_sdk(model,kind)
