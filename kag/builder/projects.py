"""Pinned OpenSPG catalog, scoped by its native login and OWNER permissions."""
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener

from kag.backend_identity import _field, _store, bound_sdk_requests


class ProjectCatalogError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _native_get(endpoint, path, token):
    request = Request(endpoint.rstrip('/') + path,
        headers={'Cookie': 'OPEN_SPG_TOKEN=' + token, 'Accept': 'application/json'})
    try:
        with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=10) as response:
            raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError
        return json.loads(raw)
    except HTTPError as error:
        raise ProjectCatalogError('FORBIDDEN' if error.code in (401, 403) else 'UNAVAILABLE') from None
    except (URLError, OSError, ValueError):
        raise ProjectCatalogError('UNAVAILABLE') from None


def owned_project_ids(endpoint, token, *, page_size=100):
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._~+/=%:-]{1,8192}', token):
        raise ProjectCatalogError('FORBIDDEN')
    identities, total, page = set(), None, 1
    while True:
        value = _native_get(endpoint, '/v1/projects/list?' + urlencode(
            dict(isOwner='true', pageNo=page, pageSize=page_size)), token)
        if not isinstance(value, dict) or value.get('success') is not True:
            raise ProjectCatalogError('FORBIDDEN')
        try:
            data = value['result']
            # The pinned owner-empty response serializes only the default Page fields.
            if ('total' not in data and (page != 1 or set(data) != {'pageNo','pageSize'}
                    or type(data['pageNo']) is not int or data['pageNo'] != 1
                    or type(data['pageSize']) is not int or data['pageSize'] < 1)):
                raise ValueError
            count, records = data.get('total', 0), data.get('data')
            if records is None:
                records = []
            if (type(count) is not int or not 0 <= count <= 10000 or type(records) is not list
                    or len(records) > page_size or total is not None and count != total):
                raise ValueError
            total = count
            for record in records:
                identity = record['id']
                if (type(identity) not in (str, int) or not str(identity).isdigit()
                        or not 1 <= int(identity) <= 2147483647 or int(identity) in identities):
                    raise ValueError
                identities.add(int(identity))
            if len(identities) == total:
                return identities
            if not records or len(identities) > total:
                raise ValueError
            page += 1
        except (AttributeError, KeyError, TypeError, ValueError):
            raise ProjectCatalogError('UNAVAILABLE') from None


def project_metadata(records, owned_ids, neo4j_uri, serving_database):
    trusted = urlsplit(neo4j_uri)
    rows, seen = [], set()
    for record in records:
        raw_id = _field(record, 'id')
        if type(raw_id) not in (str, int) or not str(raw_id).isdigit():
            raise ProjectCatalogError('UNAVAILABLE')
        identity = int(raw_id)
        if identity in seen:
            raise ProjectCatalogError('UNAVAILABLE')
        seen.add(identity)
        if identity not in owned_ids:
            continue
        name, namespace = _field(record, 'name'), _field(record, 'namespace')
        if (not 1 <= identity <= 2147483647 or not isinstance(name, str) or not name.strip()
                or len(name) > 255 or not isinstance(namespace, str)
                or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', namespace)):
            raise ProjectCatalogError('UNAVAILABLE')
        database, state = None, 'CONNECTION_NOT_CONFIGURED'
        try:
            store, endpoint = _store(record)
            parsed = urlsplit(endpoint)
            database = store['database'].lower()
            if (parsed.hostname.lower(), parsed.port) == (trusted.hostname.lower(), trusted.port):
                state = 'SERVING_PROTECTED' if database == serving_database.lower() else 'AVAILABLE'
        except (KeyError, TypeError, ValueError, AttributeError):
            pass
        rows.append(dict(project_id=identity, project_name=name, namespace=namespace, database=database, state=state))
    return sorted(rows, key=lambda row: row['project_id'])


def _project_client(endpoint):
    from kag.bootstrap import initialize
    initialize()
    from knext.project.client import ProjectClient
    client = ProjectClient(host_addr=endpoint)
    bound_sdk_requests(client)
    return client


def deployment_endpoints():
    from kag.builder.production_scope import _endpoint
    try:
        endpoints = dict(openspg=os.environ['KAG_BUILDER_OPENSPG_URL'],
            neo4j_http=os.environ['KAG_BUILDER_NEO4J_HTTP'], neo4j_uri=os.environ['KAG_BUILDER_NEO4J_URI'])
        location = os.environ.get('KAG_BUILDER_RUNTIME_LOCATION', 'container')
        _endpoint(endpoints['openspg'], ('http','https'), location)
        _endpoint(endpoints['neo4j_http'], ('http','https'), location)
        _endpoint(endpoints['neo4j_uri'], ('bolt','neo4j','bolt+s','neo4j+s'), location)
        return endpoints, location
    except (KeyError, ValueError):
        raise ProjectCatalogError('NOT_CONFIGURED') from None


def read_projects(token):
    try:
        endpoints, _ = deployment_endpoints()
        owned = owned_project_ids(endpoints['openspg'], token)
        records = _project_client(endpoints['openspg'])._rest_client.project_get() if owned else []
        projects = project_metadata(records, owned, endpoints['neo4j_uri'],
            os.environ.get('KAG_BUILDER_SERVING_DATABASE', 'neo4j'))
        return dict(contract_version='builder-projects-v1', state='AVAILABLE' if projects else 'EMPTY', projects=projects)
    except ProjectCatalogError as error:
        return dict(contract_version='builder-projects-v1', state=error.code, projects=[])
    except Exception:
        return dict(contract_version='builder-projects-v1', state='UNAVAILABLE', projects=[])


def selected_target(project_id, token):
    if type(project_id) is not int or not 1 <= project_id <= 2147483647:
        raise ProjectCatalogError('NOT_FOUND')
    catalog = read_projects(token)
    if catalog['state'] not in ('AVAILABLE','EMPTY'):
        raise ProjectCatalogError(catalog['state'])
    matches = [row for row in catalog['projects'] if row['project_id'] == project_id]
    if len(matches) != 1:
        raise ProjectCatalogError('NOT_FOUND')
    row = matches[0]
    if row['state'] != 'AVAILABLE':
        raise ProjectCatalogError(row['state'])
    endpoints, location = deployment_endpoints()
    return dict({key: row[key] for key in ('project_id','project_name','namespace','database')},
        runtime_location=location, endpoints=endpoints)
