"""Offline inspection only; synthetic fixtures never establish live graph authority."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

from kag.http_api.app import ApiSettings, create_app
from kag.http_api.security import ServiceSecrets
from kag.http_api.runtime import RuntimeSupervisor
from kag.http_api.inspection import dataset_catalog
from kag.evaluation.dataset import canonical_line, freeze_dataset


class InspectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = create_app(ApiSettings(ServiceSecrets(('q'*43,), ('i'*43,))))
        self.supervisor = self.app.state.runtime_supervisor = RuntimeSupervisor()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://offline')
        self.addAsyncCleanup(self.client.aclose)

    async def get(self, path, token='i'*43):
        return await self.client.get(path, headers={'Authorization': 'Bearer '+token} if token else {})

    async def test_inspect_scope_only_and_no_runtime_creation(self):
        for path in ('/v1/pipeline/status', '/v1/benchmark/datasets'):
            with self.subTest(path=path):
                self.assertEqual((await self.get(path, '')).status_code, 401)
                self.assertEqual((await self.get(path, 'q'*43)).status_code, 403)
                self.assertEqual((await self.get(path+'?override=true')).status_code, 422)
                self.assertEqual((await self.client.post(path)).status_code,
                                 401 if path == '/v1/benchmark/datasets' else 405)
        with patch('kag.http_api.runtime.make_runtime', side_effect=AssertionError('runtime constructed')):
            response = await self.get('/v1/pipeline/status')
        self.assertEqual(response.status_code, 200)
        value = response.json()
        self.assertEqual((value['phase'], value['active_requests'], value['progress']), ('idle', 0, None))
        self.assertFalse(value['execution_allowed'])
        self.assertEqual(value['operational_proof'], 'DENY')
        self.assertEqual(value['production_write'], 'BLOCKED')
        self.assertEqual(value['provider_egress'], 'DENY')

    async def test_actual_slot_and_draining_are_observed_without_fake_progress(self):
        task = self.supervisor._task = asyncio.create_task(asyncio.sleep(30))
        self.addAsyncCleanup(self.supervisor.close)
        self.assertEqual((await self.get('/v1/pipeline/status')).json()['phase'], 'running')
        self.supervisor.draining = True
        value = (await self.get('/v1/pipeline/status')).json()
        self.assertEqual((value['phase'], value['active_requests'], value['progress']), ('draining', 1, None))
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.supervisor._task = None
        self.supervisor.closed = True
        self.assertEqual((await self.get('/v1/pipeline/status')).json()['phase'], 'closed')

    async def test_missing_supervisor_is_not_an_idle_runtime(self):
        del self.app.state.runtime_supervisor
        value = (await self.get('/v1/pipeline/status')).json()
        self.assertEqual((value['phase'], value['active_requests']), ('unavailable', None))

    async def test_unconfigured_catalog_is_blocked_not_empty_success(self):
        value = (await self.get('/v1/benchmark/datasets')).json()
        self.assertEqual(value['state'], 'NOT_CONFIGURED')
        self.assertEqual(value['datasets'], [])
        self.assertFalse(value['execution_allowed'])


class DatasetCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='inspection-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def record(self, **changes):
        return dict(schema_version='1.0', dataset_version='synthetic', dataset_status='PROVISIONAL',
                    qid='synthetic-q1', question='TEST ONLY', category='definition', expected_abstain=False,
                    gold_unit_ids=['synthetic-unit'], **changes)

    def test_provisional_valid_and_invalid_legacy_are_blocked(self):
        (self.root/'provisional.jsonl').write_bytes(canonical_line(self.record()))
        (self.root/'legacy.jsonl').write_text('{"cau_hoi":"TEST ONLY"}\n', encoding='utf-8')
        value = dataset_catalog(self.root)
        by_id = {row['id']:row for row in value['datasets']}
        self.assertEqual(by_id['provisional.jsonl']['reason'], 'PROVISIONAL_DATASET')
        self.assertEqual(by_id['provisional.jsonl']['record_count'], 1)
        self.assertEqual(by_id['legacy.jsonl']['reason'], 'INVALID_DATASET')
        self.assertNotIn(str(self.root), json.dumps(value))
        self.assertFalse(value['execution_allowed'])

    def test_framework_verifies_frozen_manifest_but_does_not_authorize_benchmark(self):
        source = self.root/'provisional.jsonl'
        source.write_bytes(canonical_line(self.record()))
        manifest = freeze_dataset(source, self.root, 'synthetic-frozen')
        value = dataset_catalog(self.root)
        frozen = next(row for row in value['datasets'] if row['id'].endswith('/eval_questions.jsonl'))
        self.assertEqual(frozen['dataset_status'], 'FROZEN')
        self.assertEqual(frozen['dataset_eligibility'], 'ELIGIBLE')
        self.assertFalse(frozen['official_benchmark'])
        self.assertFalse(value['execution_allowed'])
        manifest.write_text('{}', encoding='utf-8')
        frozen = next(row for row in dataset_catalog(self.root)['datasets'] if row['id'].endswith('/eval_questions.jsonl'))
        self.assertEqual(frozen['dataset_eligibility'], 'BLOCKED')

    def test_missing_root_symlinks_and_oversized_files_fail_closed(self):
        self.assertEqual(dataset_catalog(self.root/'missing')['state'], 'UNAVAILABLE')
        (self.root/'oversized.jsonl').write_bytes(b' '* (8*1024*1024+1))
        value = dataset_catalog(self.root)
        self.assertEqual(value['datasets'][0]['reason'], 'DATASET_TOO_LARGE')
        with patch.object(Path, 'is_symlink', return_value=True):
            self.assertEqual(dataset_catalog(self.root)['state'], 'UNAVAILABLE')

    def test_empty_root_has_no_fake_metrics_or_progress(self):
        value = dataset_catalog(self.root)
        self.assertEqual((value['state'], value['datasets']), ('AVAILABLE', []))
        self.assertIsNone(value['metrics'])

    def test_dataset_catalog_cannot_mutate_source(self):
        file = self.root/'test.jsonl'
        raw = canonical_line(self.record())
        file.write_bytes(raw)
        dataset_catalog(self.root)
        self.assertEqual(file.read_bytes(), raw)

    def test_scan_limit_is_explicit_instead_of_silent_partial_catalog(self):
        for i in range(21):
            (self.root/f'{i}.jsonl').write_bytes(canonical_line(self.record()))
        self.assertEqual(dataset_catalog(self.root)['state'], 'LIMIT_EXCEEDED')
