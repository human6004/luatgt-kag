"""Fresh writes must remain bound to a new physical backend and exact C3 subset."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import test_runner as fixtures
from test_runner import Database, checksum
from kag.run_state import RunBlocked


class FreshSampleTests(unittest.TestCase):
    api = fixtures.RunnerPreflightTests.api
    preflight = fixtures.RunnerPreflightTests.preflight

    @classmethod
    def setUpClass(cls):
        fixtures.RunnerPreflightTests.setUpClass.__func__(cls)

    def setUp(self):
        fixtures.RunnerPreflightTests.setUp(self)
        self.configure_fresh()

    def configure_fresh(self):
        self.config.update(scope='FRESH_SAMPLE', write_mode='WRITE',
                           project_name='FreshSample_20261011', database='freshsample20261011')
        self.projects.records[0]['name'] = self.config['project_name']
        self.projects.records[0]['config']['graph_store']['database'] = self.config['database']
        self.target = dict(project_id=2, project_name=self.config['project_name'], namespace='VietRoadTraffic',
            database=self.config['database'], physical_database_id='physical-fixture-db',
            runtime_identity=['fixture-server','server-container','server-image','neo-container','neo-image',
                              'network-id','kag-s8-fixture_openspg-neo4j-data'])
        sample = dict(kind='FRESH_SAMPLE', target=self.target,
            selected_node_keys=[[n['type'], n['id']] for n in self.originals],
            selected_edge_tuples=[e['tuple'] for e in self.edges],
            c3_sha256={k:self.pins[v] for k,v in [('nodes','nodes_jsonl_sha256'),
                ('edges','edges_jsonl_sha256'),('plan','plan_sha256')]})
        self.sample=sample
        self.write_sample()
        from kag.backend_identity import DockerBackendTransport
        metadata=dict(name=self.config['database'],databaseID='physical-fixture-db',
                      serverID='fixture-server',currentStatus='online')
        self.metadata=metadata
        self.binding=patch.object(DockerBackendTransport,'read',
            side_effect=lambda store, verifier:(dict(self.metadata),tuple(self.target['runtime_identity'][1:])))
        self.binding.start(); self.addCleanup(self.binding.stop)

    def write_sample(self):
        path=Path(self.config['paths']['sample_manifest'])
        path.write_text(json.dumps(self.sample),encoding='utf-8')
        self.config['input_sha256']['sample_manifest']=checksum(path)

    def reader(self):
        class Reader(Database):
            def database_metadata(inner): return dict(self.metadata)
        return Reader()

    def test_fresh_sample_write_preflight_accepts_verified_target(self):
        try: result=self.preflight(self.config,self.reader())
        except RunBlocked as error: self.fail('Verified fresh sample refused: '+error.code)
        self.addCleanup(result['backend_session'].close)
        self.addCleanup(result['source_index'].close)
        self.assertEqual(len(result['node_hashes']),3)
        self.assertEqual(result['writer_config'].scope,'FRESH_SAMPLE')

    def test_fresh_sample_accepts_functional_volume_names(self):
        for project in ('kag','kag-local'):
            with self.subTest(project=project):
                self.target['runtime_identity'][-1]=project+'_openspg-neo4j-data'
                self.write_sample()
                result=self.preflight(self.config,self.reader())
                self.addCleanup(result['backend_session'].close)
                self.addCleanup(result['source_index'].close)
                self.assertEqual(result['writer_config'].scope,'FRESH_SAMPLE')

    def test_fresh_container_requires_loopback_openspg_with_private_neo4j_aliases(self):
        self.config.update(runtime_location='container',endpoints={
            'openspg':'http://127.0.0.1:8887','neo4j_http':'http://openspg-neo4j:7474',
            'neo4j_uri':'bolt://openspg-neo4j:7687'})
        try:config=self.api()._config(self.config)
        except RunBlocked as error:self.fail('Private namespace loopback OpenSPG refused: '+error.code)
        self.assertEqual(config['endpoints'],self.config['endpoints'])
        for endpoint in ('http://openspg-server:8887','http://host.docker.internal:8887',
                         'http://remote.invalid:8887'):
            config=copy.deepcopy(self.config);config['endpoints']['openspg']=endpoint
            with self.subTest(endpoint=endpoint),self.assertRaises(RunBlocked):self.api()._config(config)

    def test_fresh_sample_refuses_protected_database(self):
        for database in ('legalfinalcand','system','vietroadtraffic'):
            config=copy.deepcopy(self.config); config['database']=database
            with self.subTest(database=database),self.assertRaises(RunBlocked):
                self.preflight(config,self.reader())

    def test_fresh_default_database_requires_its_new_physical_identity(self):
        self.config['database']='neo4j';self.target['database']='neo4j'
        self.projects.records[0]['config']['graph_store']['database']='neo4j'
        self.metadata['name']='neo4j';self.write_sample()
        try: result=self.preflight(self.config,self.reader())
        except RunBlocked as error:self.fail('New physical default database refused: '+error.code)
        self.addCleanup(result['backend_session'].close);self.addCleanup(result['source_index'].close)
        self.metadata['databaseID']='legacy-physical-database'
        with self.assertRaises((RunBlocked,ValueError)):result['writer_config'].__post_init__()

    def test_fresh_vietroadtraffic_requires_exact_revised_physical_target(self):
        self.config['database']='vietroadtraffic';self.target['database']='vietroadtraffic'
        self.projects.records[0]['config']['graph_store']['database']='vietroadtraffic'
        self.metadata['name']='vietroadtraffic'
        self.target['runtime_identity'][-1]='kag-s8-fixture_openspg-neo4j-data-fresh-phase-b'
        self.write_sample()
        try:result=self.preflight(self.config,self.reader())
        except RunBlocked as error:self.fail('Revised isolated physical target refused: '+error.code)
        self.addCleanup(result['backend_session'].close);self.addCleanup(result['source_index'].close)
        self.assertEqual(result['writer_config'].backend_proof.canonical_database_name,'vietroadtraffic')
        self.metadata['databaseID']='legacy-physical-database'
        with self.assertRaises((RunBlocked,ValueError)):result['writer_config'].__post_init__()

    def test_fresh_vietroadtraffic_refuses_unrevised_or_foreign_volume(self):
        self.config['database']='vietroadtraffic';self.target['database']='vietroadtraffic'
        self.projects.records[0]['config']['graph_store']['database']='vietroadtraffic'
        self.metadata['name']='vietroadtraffic'
        for volume in ('kag-s8-fixture_openspg-neo4j-data','docker_openspg-neo4j-data-fresh-phase-b',
                       'kag-s8-fixture_openspg-neo4j-data-fresh-../x'):
            self.target['runtime_identity'][-1]=volume;self.write_sample()
            with self.subTest(volume=volume),self.assertRaises((RunBlocked,ValueError)):
                self.preflight(self.config,self.reader())

    def test_fresh_sample_refuses_changed_physical_identity(self):
        self.target['physical_database_id']='different-database'
        self.write_sample()
        with self.assertRaises((RunBlocked,ValueError)):
            self.preflight(self.config,self.reader())

    def test_fresh_sample_refuses_unknown_source_identity(self):
        self.sample['selected_node_keys'].append(['VietRoadTraffic.LegalUnit','invented'])
        self.write_sample()
        with self.assertRaises((RunBlocked,ValueError)):
            self.preflight(self.config,self.reader())

    def test_fresh_sample_refuses_provider_egress(self):
        config=copy.deepcopy(self.config); config['vector_policy']='provider'
        with self.assertRaises(RunBlocked): self.api()._config(config)

    def test_fresh_config_cannot_authorize_production_write(self):
        config=copy.deepcopy(self.config); config.update(scope='PRODUCTION',write_mode='WRITE')
        with self.assertRaises(RunBlocked): self.preflight(config,self.reader())

    def verified(self):
        result=self.preflight(self.config,self.reader())
        self.addCleanup(result['backend_session'].close)
        self.addCleanup(result['source_index'].close)
        return result['writer_config']

    def test_fresh_writer_refuses_modified_source_text(self):
        config=self.verified()
        nodes=copy.deepcopy(self.nodes)
        nodes[1]['properties']['text']='invented source'
        graph=self.adapter.to_subgraphs(nodes,8,'nodes',config)[0]
        with self.assertRaises(self.adapter.WriterAdapterError):
            self.adapter._check_writer_scope(graph,config)

    def test_fresh_writer_refuses_node_outside_manifest(self):
        config=self.verified()
        nodes=copy.deepcopy(self.originals); nodes[0]['id']=nodes[0]['name']='outside'
        graph=self.adapter.to_subgraphs(nodes,8,'nodes',config)[0]
        with self.assertRaises(self.adapter.WriterAdapterError):
            self.adapter._check_writer_scope(graph,config)

    def test_fresh_writer_refuses_deletion(self):
        config=self.verified()
        graph=self.adapter.to_subgraphs(self.originals,8,'nodes',config)[0]
        with self.assertRaises(self.adapter.WriterAdapterError):
            self.adapter._check_writer_scope(graph,config,deleting=True)

    def test_fresh_writer_refuses_missing_invalid_or_unknown_vectors(self):
        config=self.verified()
        for mode in ('missing','wrong-dimension','nonfinite','unknown'):
            nodes=copy.deepcopy(self.nodes)
            props=nodes[0]['properties']
            if mode=='missing':props.pop('_title_vector')
            elif mode=='wrong-dimension':props['_title_vector']=[1.0]
            elif mode=='nonfinite':props['_title_vector'][0]=float('nan')
            else:props['_stub']=True
            graph=self.adapter.to_subgraphs(nodes,8,'nodes',config)[0]
            with self.subTest(mode=mode),self.assertRaises(self.adapter.WriterAdapterError):
                self.adapter._check_writer_scope(graph,config)

    def test_fresh_writer_refuses_manifest_changed_after_discovery(self):
        config=self.verified()
        self.sample['selected_node_keys'].pop(); self.write_sample()
        with self.assertRaises(self.adapter.WriterAdapterError):config.__post_init__()


class FreshExecutionTests(unittest.TestCase):
    setUpClass = FreshSampleTests.__dict__['setUpClass']
    api = fixtures.RunnerPreflightTests.api
    configure_fresh = FreshSampleTests.configure_fresh
    write_sample = FreshSampleTests.write_sample
    record = fixtures.RunnerExecutionTests.record

    def setUp(self):
        fixtures.RunnerExecutionTests.setUp(self)
        self.configure_fresh()
        self.reader.database_metadata = lambda: dict(self.metadata)

    def options(self, writes):
        class Graph:
            _host_addr = self.config['endpoints']['openspg']
            _project_id = 2
            def write_graph(client, **kwargs): writes.append(kwargs['sub_graph'])
        def forbidden(*args, **kwargs):
            self.fail('Replay must never construct a provider')
        return dict(run_id='fresh-flow',reader=self.reader,project_client=self.projects,
            writer_factory=lambda config:self.adapter.NativeIntegerKGWriter(config,graph_client=Graph()),
            vectorizer_factory=forbidden)

    def test_fresh_write_ack_crash_resume_and_read_only_verification(self):
        from kag.run_state import RunState
        api=self.api();writes=[];options=self.options(writes)
        factory=options['writer_factory'];locks=[]
        def tracked(config):
            locks.append(config.graph_lock)
            self.addCleanup(lambda: config.graph_lock.release() if config.graph_lock.acquired else None)
            return factory(config)
        options['writer_factory']=tracked
        original=RunState.confirm_batch
        def crash(state,stage,key,result):
            if stage=='write-nodes':raise RuntimeError('fixture interrupted before confirmation')
            return original(state,stage,key,result)
        with patch.object(RunState,'confirm_batch',crash):
            self.assertEqual(api.run(self.config,**options),1)
        self.assertEqual(len(writes),1)
        retained=locks[0].path.read_bytes()
        self.assertEqual(api.run(self.config,resume=True,**options),2)
        self.assertEqual(locks[0].path.read_bytes(),retained)
        self.assertEqual(len(writes),1)
        # Only this finished transport fixture is recovered; production never clears stale locks.
        locks[0].release()
        self.assertEqual(api.run(self.config,resume=True,**options),0)
        self.assertEqual(len(writes),3)
        release=self.record(run_id='fresh-flow')['stages']['release']
        self.assertEqual((release['kind'],release['embedding_calls']),('FRESH_SAMPLE/WRITE',0))
        self.assertTrue(writes[-1]['resultEdges'])
        self.assertEqual(api.verify_run(self.config,run_id='fresh-flow',reader=self.reader,
            project_client=self.projects),0)
        self.assertEqual(len(writes),3)

    def test_fresh_full_node_barrier_refuses_every_edge_write(self):
        from kag import verify
        api=self.api();writes=[];original=verify.verify_graph
        def barrier(reader,**kwargs):
            if kwargs.get('nodes_only'):raise RunBlocked('NODES')
            return original(reader,**kwargs)
        with patch.object(verify,'verify_graph',barrier):
            self.assertEqual(api.run(self.config,**self.options(writes)),2)
        self.assertTrue(writes)
        self.assertTrue(all(not graph['resultEdges'] for graph in writes))
