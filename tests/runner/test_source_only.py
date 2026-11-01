"""Explicit offline full-source mode; no graph/model authority."""
import copy
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import Mock, patch

import test_runner as fixtures
from kag.run_state import RunState


class SourceOnlyTests(unittest.TestCase):
    setUpClass = fixtures.RunnerPreflightTests.__dict__['setUpClass']
    api = fixtures.RunnerPreflightTests.api

    def setUp(self):
        fixtures.RunnerPreflightTests.setUp(self)
        self.config = dict(scope='SOURCE_ONLY_DRY_RUN', write_mode='NO_OP',
            paths={'c3_manifest': str(self.root / 'manifest.json'), 'run_root': str(self.root / 'runs')},
            input_sha256={'c3_manifest': self.config['input_sha256']['c3_manifest']},
            batch_size=2, heartbeat_seconds=5)
        self.provider = Mock(side_effect=AssertionError('provider must never be constructed'))
        self.writer = Mock(side_effect=AssertionError('writer must never be constructed'))
        self.client = Mock(side_effect=AssertionError('clients must never be used'))

    def execute(self, run_id='source', **kwargs):
        api = self.api()
        with patch.object(api, '_clients', side_effect=AssertionError('no graph clients')), \
             patch.object(api, '_provider', side_effect=AssertionError('no embedding provider')), \
             patch('kag.verify.verify_graph', side_effect=AssertionError('no graph readback')):
            code = api.run(self.config, run_id=run_id, project_client=self.client, reader=self.client,
                vectorizer_factory=self.provider, writer_factory=self.writer, **kwargs)
        self.provider.assert_not_called(); self.writer.assert_not_called()
        self.assertEqual(self.client.mock_calls, [])
        return code

    def record(self, name='receipt.json', run_id='source'):
        return json.loads((self.root / 'runs' / run_id / name).read_bytes())

    def test_explicit_source_mode_batches_full_fixture_and_never_claims_graph_release(self):
        self.assertEqual(self.execute(), 0)
        receipt = self.record()
        self.assertEqual(receipt['identity']['scope'], 'SOURCE_ONLY_DRY_RUN')
        self.assertEqual(receipt['stages']['source-nodes'], {'count': 3, 'batches': 2})
        self.assertEqual(receipt['stages']['source-edges'], {'count': 1, 'batches': 1})
        final = receipt['stages']['source-complete']
        self.assertEqual(final['kind'], 'SOURCE_ONLY_DRY_RUN')
        self.assertFalse(final['graph_verified'])
        for name in ('embedding_calls', 'graph_writes', 'provider_calls', 'writer_calls', 'graph_reader_calls', 'project_operations'):
            self.assertEqual(final[name], 0)
        self.assertTrue(set(receipt['stages']).isdisjoint({'vectorize','write-nodes','write-edges','verify','release'}))
        self.assertEqual(self.record('status.json')['stage'], 'source-complete')

    def test_source_mode_interruption_resume_skips_confirmations_and_keeps_audit_anchors(self):
        self.assertEqual(self.execute(stop_after_batch=('source-nodes', 1)), 1)
        interrupted = self.record('status.json')
        self.assertEqual((interrupted['stage'], interrupted['done'], interrupted['error_code']),
                         ('source-nodes', 2, 'INTERRUPTED'))
        original = RunState.confirm_batch
        calls = []
        def observed(state, stage, key, result):
            calls.append((stage,key))
            return original(state, stage, key, result)
        with patch.object(RunState, 'confirm_batch', observed):
            self.assertEqual(self.execute(resume=True), 0)
        self.assertEqual(calls, [('source-nodes','1'), ('source-edges','0')])
        receipt = self.record()
        self.assertEqual(receipt['stages']['source-complete']['skipped_batches'], 1)
        directory = self.root / 'runs/source'
        state = RunState(directory, receipt['identity'], resume=True)
        try:
            self.assertFalse(state.db.in_transaction)
            anchors = state._validate_logs()
            self.assertFalse(state.db.in_transaction)
            self.assertEqual(receipt['audit'], {k: dict(sequence=v[0],hash=v[1]) for k,v in anchors.items()})
            for log in ('events', 'batches'):
                confirmations = [(r['stage'],r['key']) for r in map(json.loads,
                    (directory / (log+'.jsonl')).read_text().splitlines()) if r.get('state') == 'CONFIRMED']
                self.assertEqual(len(confirmations), len(set(confirmations)))
        finally:
            state.close()

    def test_source_mode_fails_closed_for_write_provider_graph_fields_and_bad_config(self):
        for changes in ({'write_mode':'WRITE'}, {'vector_policy':'provider'}, {'endpoints':{}},
                        {'batch_size':True}, {'heartbeat_seconds':float('nan')}):
            with self.subTest(changes=changes):
                config = dict(self.config, **changes)
                self.assertEqual(self.api().run(config, run_id='bad'), 2)
        self.assertFalse((self.root / 'runs/bad/ledger.sqlite3').exists())

    def test_malformed_source_identity_is_integrity_block(self):
        import hashlib
        path = self.root/'manifest.json'
        manifest = json.loads(path.read_bytes())
        manifest.pop('plan_sha256')
        path.write_text(json.dumps(manifest),encoding='utf-8')
        self.config['input_sha256']['c3_manifest'] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(self.execute(),2)

    def test_source_resume_blocks_changed_config_input_or_source_ledger(self):
        self.assertEqual(self.execute(stop_after_batch=('source-nodes',1)), 1)
        original = copy.deepcopy(self.config)
        self.config['batch_size'] = 1
        self.assertEqual(self.execute(resume=True), 2)
        self.config = original
        path = self.root / 'fixture.txt'
        path.write_bytes(b'changed')
        self.assertEqual(self.execute(resume=True), 2)
        path.write_bytes(b'fixture')
        with sqlite3.connect(self.root / 'runs/source/ledger.sqlite3') as db:
            db.execute("UPDATE runner_sources SET source_hash=? WHERE kind='nodes' AND ordinal=0", ('0'*64,))
        self.assertEqual(self.execute(resume=True), 2)

    def test_tampered_source_receipt_cannot_claim_graph_verification_on_resume(self):
        self.assertEqual(self.execute(), 0)
        path = self.root / 'runs/source/ledger.sqlite3'
        with sqlite3.connect(path) as db:
            row = db.execute("SELECT result FROM run_stages WHERE stage='source-complete'").fetchone()
            final = json.loads(row[0]); final['graph_verified'] = True
            db.execute("UPDATE run_stages SET result=? WHERE stage='source-complete'", (json.dumps(final),))
        self.assertEqual(self.execute(resume=True), 2)

    def test_source_resume_rejects_foreign_graph_stages_and_batches(self):
        for table, stage in (('run_stages','release'), ('run_stages','verify'),
                             ('run_batches','write-nodes'), ('run_batches','vectorize')):
            with self.subTest(table=table, stage=stage):
                run_id = 'foreign-' + stage
                self.assertEqual(self.execute(run_id=run_id), 0)
                with sqlite3.connect(self.root / 'runs' / run_id / 'ledger.sqlite3') as db:
                    if table == 'run_stages':
                        db.execute('INSERT INTO run_stages VALUES (?,?)', (stage,
                            json.dumps({'kind':'PRODUCTION/WRITE','graph_verified':True})))
                    else:
                        db.execute("INSERT INTO run_batches VALUES (?, '0', ?, 'CONFIRMED', ?)",
                                   (stage, '0'*64, json.dumps({'count':1})))
                self.assertEqual(self.execute(run_id=run_id, resume=True), 2)

    def test_source_resume_rejects_deleted_changed_or_added_audited_batches(self):
        for mutation in ('deleted','intent','result','extra'):
            with self.subTest(mutation=mutation):
                run_id = 'batch-tamper-' + mutation
                self.assertEqual(self.execute(run_id=run_id), 0)
                with sqlite3.connect(self.root / 'runs' / run_id / 'ledger.sqlite3') as db:
                    if mutation == 'deleted':
                        db.execute("DELETE FROM run_batches WHERE stage='source-nodes' AND key='0'")
                    if mutation == 'intent':
                        db.execute("UPDATE run_batches SET state='INTENT' WHERE stage='source-nodes' AND key='0'")
                    if mutation == 'result':
                        db.execute("UPDATE run_batches SET result=? WHERE stage='source-nodes' AND key='0'",
                                   (json.dumps({'count':1}),))
                    if mutation == 'extra':
                        db.execute("INSERT INTO run_batches VALUES ('source-nodes','999',?,'CONFIRMED',?)",
                                   ('0'*64,json.dumps({'count':1})))
                self.assertEqual(self.execute(run_id=run_id, resume=True), 2)

    def test_source_audit_rejects_reconfirmed_key_even_with_valid_hash_chain(self):
        self.assertEqual(self.execute(), 0)
        receipt = self.record()
        state = RunState(self.root / 'runs/source', receipt['identity'], resume=True)
        try:
            digest = state.db.execute("SELECT source_hash FROM run_batches WHERE stage='source-nodes' AND key='0'").fetchone()[0]
            with state.db:
                state.db.execute("DELETE FROM run_batches WHERE stage='source-nodes' AND key='0'")
            state.begin_batch('source-nodes', '0', digest)
            state.confirm_batch('source-nodes', '0', {'count':2})
            with self.assertRaises(ValueError): state._validate_logs()
        finally:
            state.close()

    def test_source_resume_rejects_out_of_range_audited_batch(self):
        self.assertEqual(self.execute(), 0)
        receipt = self.record()
        state = RunState(self.root / 'runs/source', receipt['identity'], resume=True)
        try:
            state.begin_batch('source-nodes', '999', '0'*64)
            state.confirm_batch('source-nodes', '999', {'count':1})
            state._receipt()
        finally:
            state.close()
        self.assertEqual(self.execute(resume=True), 2)
