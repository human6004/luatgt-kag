"""Keep the pinned native validators; route their Embedding clients via policy."""
from functools import partial
import json
import logging
import runpy

from kag.bootstrap import VENDOR, initialize

initialize()

import httpx
from openai import OpenAI, AsyncOpenAI
from kag.common.vectorize_model import openai_model
from kag.http_api.provider_budget import (
    AsyncGatewayTransport, GatewayTransport, GATEWAY, provider_route,
)
from kag.http_api.server import provider_test_policy


def _embedding_client(*, asynchronous=False, **kwargs):
    policy = provider_test_policy()
    base_url = str(kwargs.get('base_url', ''))
    route = provider_route({'base_url': base_url}, 'embedding', policy)
    upstream = base_url + '/embeddings'
    kwargs['timeout'] = kwargs.get('timeout') or 20
    kwargs['max_retries'] = 0
    if asynchronous:
        transport = AsyncGatewayTransport(httpx.AsyncHTTPTransport(retries=0), GATEWAY,
                                          policy['token'], upstream, route)
        kwargs['http_client'] = httpx.AsyncClient(transport=transport, trust_env=False,
                                                follow_redirects=False, timeout=kwargs['timeout'])
        return AsyncOpenAI(**kwargs)
    transport = GatewayTransport(httpx.HTTPTransport(retries=0), GATEWAY,
                                 policy['token'], upstream, route)
    kwargs['http_client'] = httpx.Client(transport=transport, trust_env=False,
                                       follow_redirects=False, timeout=kwargs['timeout'])
    return OpenAI(**kwargs)


# Native OpenAI vectorizers retain registration, dimensions and validation logic.
openai_model.OpenAI = _embedding_client
openai_model.AsyncOpenAI = partial(_embedding_client, asynchronous=True)
# The upstream logger prints provider response bodies; return a safe error instead.
openai_model.logger.setLevel(logging.CRITICAL)
_upstream = runpy.run_path(str(VENDOR / 'kag/bridge/spg_server_bridge.py'))
init_kag_config = _upstream['init_kag_config']


class SPGServerBridge(_upstream['SPGServerBridge']):
    def run_vectorizer_config_check(self, vec_config):
        try:
            if json.loads(vec_config).get('type') != 'openai':
                raise ValueError('Use the OpenAI-compatible Embedding provider')
            return super().run_vectorizer_config_check(vec_config)
        except Exception:
            raise RuntimeError(
                'OpenSPG Embedding check failed. Verify provider policy, endpoint, model and API key.'
            ) from None
