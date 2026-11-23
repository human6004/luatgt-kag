"""Step 2: run WebApp SSE chat sequentially with durable per-turn checkpoints.

No gold or benchmark labels are sent to chat. Retry only an explicit HTTP 429;
an ambiguous POST must be reconciled by its server ID, never blindly repeated.
"""
import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from uuid import uuid4

import httpx
from common import (BENCH, ROOT, TERMINAL, VN, atomic_json, checked_rows, dataset_id,
                    dumps, now, output_file, read_json, write_csv)
from datetime import datetime

RESULT_FIELDS = ('run_id', 'qid', 'conversation_id', 'turn_index', 'server_conversation_id',
                 'server_message_id', 'started_at', 'finished_at', 'latency_ms', 'status',
                 'http_status', 'api_success', 'timeout', 'error_code', 'attempts',
                 'response', 'events', 'metadata')
GOOD = {'ANSWERED', 'CLARIFY', 'KAG_ABSTAINED'}


def settings(path):
    """Load non-secret runtime settings; reject unsafe URLs and invalid limits."""
    config = read_json(path)
    expected = {'base_url', 'timeout_seconds', 'interval_seconds', 'retries',
                'retry_backoff_seconds', 'dataset_version', 'system_version', 'model_version'}
    if not isinstance(config, dict) or set(config) != expected:
        raise ValueError('config.json keys must match the supplied configuration')
    url = httpx.URL(config['base_url'])
    if url.scheme not in ('http', 'https') or not url.host or url.userinfo or url.query or url.fragment:
        raise ValueError('base_url must not contain credentials, query or fragment')
    for name in ('timeout_seconds', 'interval_seconds', 'retry_backoff_seconds'):
        if type(config[name]) not in (int, float) or not 0 < config[name] <= 3600:
            raise ValueError('invalid config ' + name)
    if type(config['retries']) is not int or not 0 <= config['retries'] <= 10:
        raise ValueError('retries must be between 0 and 10')
    config['base_url'] = str(url).rstrip('/')
    return config


def authenticate(client):
    """Use an environment JWT or login credentials; return owner identity, never log secrets."""
    token = os.environ.get('BENCHMARK_TOKEN')
    if not token:
        email, password = os.environ.get('BENCHMARK_EMAIL'), os.environ.get('BENCHMARK_PASSWORD')
        if not email or not password:
            raise ValueError('Set BENCHMARK_TOKEN or BENCHMARK_EMAIL and BENCHMARK_PASSWORD')
        response = client.post('/api/auth/login', json={'email': email, 'password': password})
        if response.status_code != 200:
            raise ValueError(f'Login failed: HTTP {response.status_code}; response omitted to protect secrets')
        token = response.json()['accessToken']
    client.headers['Authorization'] = 'Bearer ' + token
    response = client.get('/api/auth/me')
    if response.status_code != 200:
        raise ValueError('Authentication failed; provide a valid token/account')
    return str(response.json()['id']), token


def safe(value, secrets):
    """Redact known session credentials recursively before persisting HTTP payloads."""
    if isinstance(value, dict):
        return {k: '[REDACTED]' if any(s in k.lower() for s in ('token', 'password', 'api_key', 'authorization'))
                else safe(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [safe(v, secrets) for v in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, '[REDACTED]')
    return value


def sse_events(response, deadline):
    """Yield complete multiline SSE frames; check the run budget between bounded reads."""
    event, data = 'message', []
    for line in response.iter_lines():
        if time.monotonic() > deadline:
            raise TimeoutError('overall deadline exceeded')
        if not line:
            if data:
                yield event, json.loads('\n'.join(data))
            event, data = 'message', []
        elif line.startswith('event:'):
            event = line[6:].strip()
        elif line.startswith('data:'):
            data.append(line[5:].lstrip())
    if data:
        yield event, json.loads('\n'.join(data))


def terminal_result(record, payload, *, recovered=False):
    """Apply a persisted WebApp state to a result row without altering elapsed measurements."""
    if not isinstance(payload, dict) or payload.get('state') not in TERMINAL:
        raise ValueError('Invalid WebApp terminal response')
    if str(payload.get('id')) != record['server_message_id']:
        raise ValueError('WebApp message identity changed')
    record.update(status=payload['state'], response=payload, finished_at=now(),
                  server_conversation_id=str(payload['conversationId']),
                  api_success=payload['state'] in GOOD,
                  error_code='' if payload['state'] in GOOD else payload['state'])
    if recovered:
        record['metadata']['recovered_from_history'] = True
        record['metadata']['latency_note'] = 'N/A: interrupted SSE; completion time unobserved'
        record['latency_ms'] = None


def select_rows(rows, limit):
    """Select an input prefix, extending it to include its entire final conversation."""
    if limit is None:
        return rows
    if limit < 1:
        raise ValueError('limit must be positive')
    selected = rows[:limit]
    if selected:
        last = selected[-1]['conversation_id']
        selected += [r for r in rows[len(selected):] if r['conversation_id'] == last]
    return selected


def save(checkpoint, run):
    """Persist checkpoint first, then rebuild the recoverable CSV snapshot."""
    atomic_json(checkpoint, run)
    write_csv(checkpoint.parent / run['result_file'], list(run['results'].values()), RESULT_FIELDS, replace=True)


def reconcile(client, run, checkpoint, secrets=()):
    """Resolve interrupted turns by exact server IDs; stop when outcome cannot be proven."""
    pending = [r for r in run['results'].values() if r['status'] in ('SENDING', 'PROCESSING', 'INTERRUPTED')]
    if not pending:
        return
    if any(not r['server_message_id'] for r in pending):
        raise ValueError('POST outcome unknown before started ID. Do not resend: inspect WebApp history with a dedicated account, then start a new run if needed. This run remains unresolved.')
    response = client.get('/api/chat')
    response.raise_for_status()
    history = {str(r['id']): r for r in response.json()}
    for row in pending:
        payload = history.get(row['server_message_id'])
        if not payload or payload.get('state') not in TERMINAL:
            raise ValueError('Message missing from recent history or still processing; retry resume later. No POST repeated.')
        terminal_result(row, safe(payload, secrets), recovered=True)
    save(checkpoint, run)


def run_turn(client, question, record, config, persist, secrets):
    """Send one chat turn; checkpoint started/terminal SSE events and each retry attempt."""
    payload = {'message': question['question'], 'contextId': '',
               'conversationId': record['server_conversation_id'] or None}
    start = time.monotonic()
    deadline = start + config['timeout_seconds']
    for attempt in range(config['retries'] + 1):
        record.update(status='SENDING', attempts=attempt + 1)
        persist()
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            # WebApp emits a heartbeat each second. A stalled socket must not get
            # another full 180s read window near the end of the overall budget.
            timeout = httpx.Timeout(remaining, connect=min(10, remaining), read=min(10, remaining))
            with client.stream('POST', '/api/chat/stream', json=payload, timeout=timeout) as response:
                record['http_status'] = response.status_code
                record['metadata']['content_type'] = response.headers.get('content-type')
                record['metadata']['response_headers'] = safe(
                    {k: v for k, v in response.headers.items()
                     if k.lower() not in ('set-cookie', 'authorization', 'proxy-authenticate')}, secrets)
                if response.status_code != 200:
                    record['response'] = {'body': safe(response.read().decode('utf-8', errors='replace'), secrets)}
                if response.status_code == 429:
                    record.update(status='RATE_LIMITED', error_code='HTTP_429')
                    persist()
                    if attempt < config['retries']:
                        wait = config['retry_backoff_seconds'] * (2 ** attempt)
                        header = response.headers.get('retry-after', '')
                        if header.isdigit():
                            wait = max(wait, min(int(header), 3600))
                        if time.monotonic() + wait >= deadline:
                            raise TimeoutError()
                        time.sleep(wait)
                        continue
                    break
                if response.status_code != 200:
                    record.update(status='HTTP_ERROR', error_code=f'HTTP_{response.status_code}')
                    break
                if 'text/event-stream' not in response.headers.get('content-type', ''):
                    raise ValueError('not SSE')
                for event, value in sse_events(response, deadline):
                    value = safe(value, secrets)
                    record['events'].append({'event': event, 'data': value, 'received_at': now()})
                    if event == 'started':
                        if not isinstance(value, dict) or value.get('state') != 'PROCESSING' or not value.get('id'):
                            raise ValueError('invalid started')
                        record.update(server_message_id=str(value['id']),
                                      server_conversation_id=str(value['conversationId']), status='PROCESSING')
                        persist()
                    elif event in ('done', 'error'):
                        if not record['server_message_id']:
                            raise ValueError('terminal event without started')
                        terminal_result(record, value)
                        persist()
                        break
                else:
                    raise ValueError('stream closed before terminal event')
                break
        except (httpx.TimeoutException, TimeoutError):
            record.update(status='INTERRUPTED', timeout=True, error_code='TIMEOUT')
            break
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            record.update(status='INTERRUPTED', error_code='STREAM_OR_TRANSPORT_ERROR')
            break
    record['latency_ms'] = round((time.monotonic() - start) * 1000, 3)
    record['finished_at'] = now()
    persist()


def main():
    """Validate input, bind a run to its owner/config, then run or resume sequentially."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', default=str(BENCH / 'data/benchmark.csv'))
    parser.add_argument('--config', default=str(Path(__file__).with_name('config.json')))
    parser.add_argument('--output-dir', default=str(BENCH / 'output'))
    parser.add_argument('--limit', type=int)
    parser.add_argument('--resume', type=Path, help='checkpoint_*.json from the original run')
    args = parser.parse_args()
    config, rows = settings(args.config), checked_rows(args.dataset)
    client_timeout = httpx.Timeout(config['timeout_seconds'], connect=min(10, config['timeout_seconds']))
    with httpx.Client(base_url=config['base_url'], timeout=client_timeout, follow_redirects=False, trust_env=False) as client:
        owner, token = authenticate(client)
        secrets = [token, os.environ.get('BENCHMARK_PASSWORD', '')]
        if args.resume:
            checkpoint, run = args.resume, read_json(args.resume)
            if run['dataset_id'] != dataset_id(rows) or run['owner_id'] != owner or run['config'] != config:
                raise ValueError('Resume dataset, account or configuration differs from original run')
            if args.limit is not None:
                raise ValueError('Do not change --limit when resuming')
            selected = [r for r in rows if r['qid'] in run['selected_qids']]
            reconcile(client, run, checkpoint, secrets)
            # A 429 is rejected before ChatService.start; an unfinished rejected attempt is safe to resume.
            for qid, result in list(run['results'].items()):
                if result['status'] == 'RATE_LIMITED' and not result['finished_at']:
                    del run['results'][qid]
        else:
            selected = select_rows(rows, args.limit)
            result_path = output_file(args.output_dir, 'ketqua', 'csv')
            checkpoint = result_path.with_name(result_path.name.replace('ketqua_', 'checkpoint_')).with_suffix('.json')
            if checkpoint.exists():
                raise FileExistsError(checkpoint)
            revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
            dirty = subprocess.run(['git', 'status', '--porcelain', '--ignore-submodules', '--untracked-files=no'],
                                   cwd=ROOT, capture_output=True, text=True)
            run = dict(run_id=uuid4().hex, created_at=now(), dataset_id=dataset_id(rows),
                       dataset_snapshot=rows, selected_qids=[r['qid'] for r in selected],
                       owner_id=owner, config=config, result_file=result_path.name,
                       source_revision=revision.stdout.strip() if revision.returncode == 0 else None,
                       source_has_local_changes=bool(dirty.stdout.strip()) if dirty.returncode == 0 else None,
                       corpus_metadata=read_json(ROOT / 'data/metadata/corpus.json'),
                       version_note='Configured system/model versions are declarations; chat API does not expose model version.',
                       date_policy='WebApp uses current Vietnam date; historical reference dates are skipped.',
                       results={})
            save(checkpoint, run)
        try:
            for question in selected:
                qid = question['qid']
                if qid in run['results']:
                    continue
                prior = [run['results'][r['qid']] for r in selected
                         if r['conversation_id'] == question['conversation_id'] and r['turn_index'] < question['turn_index']]
                record = dict.fromkeys(RESULT_FIELDS, '')
                record.update(run_id=run['run_id'], qid=qid, conversation_id=question['conversation_id'],
                              turn_index=question['turn_index'], started_at=now(), latency_ms=None,
                              api_success=False, timeout=False, attempts=0, response={}, events=[], metadata={})
                run['results'][qid] = record
                if question['legal_reference_date'] != datetime.now(VN).date().isoformat():
                    record.update(status='DATE_UNSUPPORTED', error_code='WEBAPP_CURRENT_DATE_ONLY', finished_at=now())
                elif any(r['status'] not in GOOD for r in prior):
                    record.update(status='DEPENDENCY_FAILED', error_code='PREVIOUS_TURN_NOT_SUCCESSFUL', finished_at=now())
                else:
                    if prior:
                        record['server_conversation_id'] = prior[0]['server_conversation_id']
                    run_turn(client, question, record, config, lambda: save(checkpoint, run), secrets)
                save(checkpoint, run)
                print(f'{qid}: {record["status"]}', flush=True)
                if record['status'] == 'INTERRUPTED':
                    raise RuntimeError('Turn interrupted; resume this checkpoint to reconcile before continuing')
                time.sleep(config['interval_seconds'])
        finally:
            save(checkpoint, run)
        print(checkpoint.parent / run['result_file'])
        print(checkpoint)


if __name__ == '__main__':
    main()
