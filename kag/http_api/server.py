"""KAG API entry point; auth, admission and source validation stay in the API."""
from __future__ import annotations

from ipaddress import ip_address
import logging
import os
from pathlib import Path
import re


class ConfigurationError(RuntimeError):
    def __init__(self):
        super().__init__('KAG API startup configuration unavailable.')


def _policy():
    for key,value in {'KAG_OPERATIONAL_PROOF':'DENY','KAG_PRODUCTION_WRITE':'BLOCKED',
                      'KAG_PROVIDER_EGRESS':'DENY','KAG_DEBUG_DUMP_CONFIG':'0'}.items():
        if os.environ.get(key,value) != value:
            raise ConfigurationError()
    # Upstream init_env switches to remote project configuration when these are inherited.
    if any(key in os.environ for key in ('KAG_PROJECT_ID','KAG_PROJECT_HOST_ADDR')):
        raise ConfigurationError()


def _secret(key):
    path = os.environ.get(key)
    if not path:
        return None
    try:
        if not Path(path).is_absolute():
            raise ConfigurationError()
        with Path(path).open('rb') as stream:
            raw = stream.read(4099)
        if len(raw) > 4098:
            raise ConfigurationError()
        if raw.endswith(b'\r\n'):
            raw = raw[:-2]
        elif raw.endswith(b'\n'):
            raw = raw[:-1]
        if not 1 <= len(raw) <= 4096 or any(b in raw for b in (b'\0',b'\n',b'\r')):
            raise ConfigurationError()
        value = raw.decode('ascii',errors='strict')
        if not value.strip():
            raise ConfigurationError()
        return value
    except (OSError,UnicodeError,ValueError):
        raise ConfigurationError() from None


def server_options():
    _policy()
    host = os.environ.get('KAG_HTTP_HOST','0.0.0.0')
    port = os.environ.get('KAG_HTTP_PORT','8000')
    try:
        if (str(ip_address(host)) != host or not re.fullmatch(r'[0-9]{1,5}',port)
                or not 1 <= int(port) <= 65535 or os.environ.get('KAG_HTTP_WORKERS','1') != '1'):
            raise ConfigurationError()
    except ValueError:
        raise ConfigurationError() from None
    return host,int(port)


def provider_test_policy():
    """Shared deployment egress policy; saved models cannot grant network access."""
    test_enabled = os.environ.get('KAG_HTTP_PROVIDER_TEST_ENABLED','0') == '1'
    hosts_file = os.environ.get('KAG_HTTP_PROVIDER_ALLOWED_HOSTS_FILE')
    allowed_hosts = ()
    if hosts_file:
        if not Path(hosts_file).is_absolute():raise ConfigurationError()
        raw = Path(hosts_file).read_bytes()
        if len(raw)>16384:raise ConfigurationError()
        allowed_hosts = tuple(line.strip() for line in raw.decode('ascii').splitlines() if line.strip() and not line.lstrip().startswith('#'))
        if len(allowed_hosts)>64 or any(len(host)>253 or not re.fullmatch(
                r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*',host) for host in allowed_hosts):
            raise ConfigurationError()
    proxy_url = os.environ.get('KAG_HTTP_PROVIDER_PROXY_BASE_URL') or None
    if proxy_url:
        from urllib.parse import urlsplit
        proxy = urlsplit(proxy_url)
        if (proxy.scheme!='http' or not proxy.hostname or proxy.username or proxy.password or proxy.query or proxy.fragment
                or not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*',proxy.path)
                or (proxy.port or 80)!=int(os.environ.get('KAG_HTTP_CHAT_PROXY_PORT','0'))):
            raise ConfigurationError()
    return dict(enabled=test_enabled,
        token=_secret('KAG_HTTP_PROVIDER_TEST_GATEWAY_TOKEN_FILE') if test_enabled else None,
        allowed_hosts=allowed_hosts, proxy=dict(base_url=proxy_url,
            safe=os.environ.get('KAG_HTTP_CHAT_PROXY_TEST_SAFE','0') == '1',
            allow_upstream_retries=os.environ.get('KAG_HTTP_CHAT_PROXY_ALLOW_UPSTREAM_RETRIES','0') == '1') if proxy_url else None)


def create_app():
    """Uvicorn factory: local artifact reads only; never instantiate remote clients."""
    server_options()
    from .app import ApiSettings, create_app as api_app
    from . import artifacts
    from .contract import ApiFailure
    from .runtime import RuntimeSettings
    try:
        for key in ('KAG_HTTP_QUERY_SECRET_FILE','KAG_HTTP_INSPECT_SECRET_FILE',
                    'KAG_HTTP_QUERY_PREVIOUS_SECRET_FILE','KAG_HTTP_INSPECT_PREVIOUS_SECRET_FILE',
                    'KAG_HTTP_CREDENTIALS_WRITE_SECRET_FILE','KAG_HTTP_CREDENTIALS_WRITE_PREVIOUS_SECRET_FILE',
                    'KAG_HTTP_PROVIDER_TEST_SECRET_FILE','KAG_HTTP_PROVIDER_TEST_PREVIOUS_SECRET_FILE',
                    'KAG_HTTP_CONFIG_APPLY_SECRET_FILE','KAG_HTTP_CONFIG_APPLY_PREVIOUS_SECRET_FILE'):
            if key in os.environ and not Path(os.environ[key]).is_absolute():
                raise ConfigurationError()
        settings = ApiSettings.from_env()
        if not (settings.secrets.query_tokens and settings.secrets.inspect_tokens):
            raise ConfigurationError()
        reader_user = os.environ.get('KAG_HTTP_READER_USERNAME') or None
        reader_password = _secret('KAG_HTTP_READER_PASSWORD_FILE')
        broker_url = os.environ.get('KAG_HTTP_BROKER_URL') or None
        broker_token = _secret('KAG_HTTP_BROKER_TOKEN_FILE')
        if (bool(broker_url)!=bool(broker_token) or (broker_url and
                (broker_url!='http://openspg-server:8899' or reader_user or reader_password))):
            raise ConfigurationError()
        if ((reader_user is None) != (reader_password is None)
                or (reader_user is not None and (not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}',reader_user)
                    or reader_user.lower() in ('root','admin','neo4j')))):
            raise ConfigurationError()
        provider_keys = {name:_secret('KAG_HTTP_'+name.upper()+'_KEY_FILE') for name in ('embedding','chat')}
        app = api_app(settings,enable_sample_routes=True)
        app.state.provider_test_policy = provider_test_policy()
        evaluation_root = os.environ.get('KAG_HTTP_EVALUATION_ROOT')
        if evaluation_root:
            if not Path(evaluation_root).is_absolute():
                raise ConfigurationError()
            app.state.evaluation_root = Path(evaluation_root)
        release_id = os.environ.get('KAG_HTTP_RELEASE_ID')
        root = os.environ.get('KAG_HTTP_RELEASE_ROOT')
        sample_pin = os.environ.get('KAG_HTTP_SAMPLE_PROOF_SHA256') or None
        sample_pin_file = _secret('KAG_HTTP_SAMPLE_PROOF_SHA256_FILE')
        query_pin = _secret('KAG_HTTP_QUERY_PROOF_SHA256_FILE')
        gateway_token = _secret('KAG_HTTP_PROVIDER_GATEWAY_TOKEN_FILE')
        gateway = os.environ.get('KAG_HTTP_PROVIDER_GATEWAY') or None
        ledger = os.environ.get('KAG_HTTP_ATTEMPT_LEDGER') or None
        if query_pin and (not re.fullmatch('[0-9a-f]{64}',query_pin) or not broker_url
                or gateway!='http://kag-ingress:8898/v1' or not gateway_token
                or ledger!='/provider-state/attempts.json'):
            raise ConfigurationError()
        if not query_pin and any((gateway_token,gateway,ledger)):
            raise ConfigurationError()
        if sample_pin_file is not None:
            if sample_pin is not None or not broker_url:
                raise ConfigurationError()
            sample_pin = sample_pin_file
        if sample_pin is not None and (not re.fullmatch('[0-9a-f]{64}',sample_pin) or not release_id):
            raise ConfigurationError()
        if bool(release_id) != bool(root):
            raise ConfigurationError()
        from .inspection import configuration_view
        app.state.config_snapshot = configuration_view(os.environ, provider_keys,
            (*settings.secrets.query_tokens, *settings.secrets.inspect_tokens, *settings.secrets.credentials_write_tokens,
             *settings.secrets.provider_test_tokens, *settings.secrets.config_apply_tokens,
             *provider_keys.values(), reader_password, broker_token, gateway_token))
        if release_id:
            if not Path(root).is_absolute():
                raise ConfigurationError()
            release = artifacts.load_release(Path(root),release_id)
            source_id = os.environ.get('KAG_HTTP_SOURCE_SNAPSHOT_ID',release.descriptor['source_snapshot_id'])
            webapp_id = os.environ.get('KAG_HTTP_WEBAPP_SNAPSHOT_ID',release.descriptor['webapp_snapshot_id'])
            if source_id != release.descriptor['source_snapshot_id'] or webapp_id != release.descriptor['webapp_snapshot_id']:
                raise ConfigurationError()
            app.state.serving_release = release
            from .sample_query import development_policy
            development = development_policy(release,query_pin) if query_pin and query_pin!='0'*64 else None
            app.state.runtime_settings = RuntimeSettings(secrets=settings.secrets,release_id=release_id,
                source_snapshot_id=source_id,webapp_snapshot_id=webapp_id,
                reader_username=reader_user,reader_password=reader_password,
                embedding_url=os.environ.get('KAG_HTTP_EMBEDDING_URL') or None,
                embedding_model=os.environ.get('KAG_HTTP_EMBEDDING_MODEL') or None,embedding_key=provider_keys['embedding'],
                chat_url=os.environ.get('KAG_HTTP_CHAT_URL') or None,
                chat_model=os.environ.get('KAG_HTTP_CHAT_MODEL') or None,chat_key=provider_keys['chat'],
                sample_proof_sha256=sample_pin,broker_url=broker_url,broker_token=broker_token,
                query_proof_sha256=query_pin,provider_gateway=gateway,provider_gateway_token=gateway_token,
                attempt_ledger=ledger,development_policy=development)
        return app
    except artifacts.ArtifactFailure:
        # Invalid or absent data disables serving, not authenticated service startup.
        app.state.serving_release = None
        app.state.runtime_settings = None
        logging.getLogger(__name__).warning('KAG serving data unavailable; query readiness disabled.')
        return app
    except (ApiFailure,OSError,ValueError,TypeError):
        raise ConfigurationError() from None


def main():
    host,port = server_options()
    import uvicorn
    uvicorn.run('kag.http_api.server:create_app',factory=True,host=host,port=port,workers=1,
        proxy_headers=False,forwarded_allow_ips='',access_log=False,log_level='warning',
        lifespan='on',ws='none',limit_concurrency=16,timeout_keep_alive=5,
        timeout_graceful_shutdown=30,h11_max_incomplete_event_size=65536)


if __name__ == '__main__':
    main()
