"""Offline identity authorization tests; no network or write dispatch."""
import copy
from dataclasses import replace, FrozenInstanceError
import importlib
import json
import unittest
from unittest.mock import Mock


class BackendIdentityTests(unittest.TestCase):
    def setUp(self):
        self.api = importlib.import_module('kag.backend_identity')
        self.record = {'id': '37', 'name': 'Production', 'namespace': 'VietRoadTraffic',
            'config': {'graph_store': {'uri': 'neo4j://u:SECRET_URI@neo:7687',
                'database': 'VietRoadTraffic', 'user': 'u', 'password': 'SECRET_CONFIG'},
                'embedding': {'api_key': 'SECRET_EMBED'}}}
        self.projects = Mock(_host_addr='http://server:8887')
        self.projects._rest_client.project_get.side_effect = lambda: [self.record]
        self.projects.get.side_effect = lambda **kw: self.record
        self.meta = {'name': 'vietroadtraffic', 'databaseID': 'physical',
                     'serverID': 'server-id', 'currentStatus': 'online'}
        self.reader = Mock(endpoint='http://localhost:27474')
        self.reader.database_metadata.side_effect = lambda: dict(self.meta)
        self.transport = Mock()
        self.transport.read.side_effect = lambda store, reader: (dict(self.meta), ('container', 'image', 'network'))
        self.session = self.new_session()

    def new_session(self):
        return self.api.BackendIdentitySession(self.projects, self.reader, self.transport,
            project_id=37, project_name='Production', namespace='VietRoadTraffic',
            openspg_endpoint='http://server:8887')

    def test_valid_proof_is_immutable_allowlisted_and_credential_free(self):
        proof = self.session.prove()
        self.session.validate(proof)
        self.assertEqual(proof.physical_database_id, 'physical')
        self.assertEqual(proof.canonical_database_name, 'vietroadtraffic')
        with self.assertRaises(FrozenInstanceError): proof.project_id = 2
        output = repr(proof) + json.dumps(proof.to_receipt())
        for secret in ('SECRET_URI', 'SECRET_CONFIG', 'SECRET_EMBED'): self.assertNotIn(secret, output)
        self.assertEqual(proof.backend_endpoint, 'neo4j://neo:7687')

    def test_project_missing_wrong_or_duplicate_blocks(self):
        cases = [[], [dict(self.record, id=2)], [dict(self.record, name='Wrong')],
                 [dict(self.record, namespace='Wrong')], [self.record, self.record],
                 [self.record, dict(self.record, name='Other')]]
        for records in cases:
            with self.subTest(records=len(records)):
                self.projects._rest_client.project_get.side_effect = None
                self.projects._rest_client.project_get.return_value = records
                with self.assertRaises(self.api.BackendIdentityError): self.new_session().prove()

    def test_independent_id_lookup_blocks(self):
        self.projects.get.side_effect = lambda **kw: dict(self.record, namespace='Wrong')
        with self.assertRaises(self.api.BackendIdentityError): self.session.prove()

    def test_nested_project_rest_route_cannot_change_under_existing_client(self):
        from types import SimpleNamespace
        api = SimpleNamespace(configuration=SimpleNamespace(host=self.projects._host_addr),
                              url_prefix='/public/v1')
        self.projects._rest_client.api_client = api
        session = self.new_session()
        proof = session.prove()
        api.configuration.host = 'http://other-server:8887'
        with self.assertRaises(self.api.BackendIdentityError): session.validate(proof)

    def test_missing_or_invalid_backend_metadata_blocks(self):
        for store in ({}, {'uri':'neo4j://neo:7687'}, {'database':'vietroadtraffic'},
                      {'uri':'postgres://neo:7687','database':'vietroadtraffic'},
                      {'uri':'neo4j://neo:7687?database=other','database':'vietroadtraffic'}):
            with self.subTest(store=store):
                self.record['config']['graph_store'] = store
                with self.assertRaises(self.api.BackendIdentityError): self.new_session().prove()

    def test_database_missing_offline_empty_or_mismatch_blocks(self):
        for change in ({'name':'other'}, {'databaseID':''}, {'serverID':''},
                       {'currentStatus':'offline'}):
            with self.subTest(change=change):
                original = dict(self.meta)
                self.meta.update(change)
                with self.assertRaises(self.api.BackendIdentityError): self.new_session().prove()
                self.meta = original
        self.transport.read.side_effect = lambda *args: (dict(self.meta, databaseID='other'), ('runtime',))
        with self.assertRaises(self.api.BackendIdentityError): self.session.prove()

    def test_runtime_or_server_mismatch_blocks(self):
        self.transport.read.side_effect = lambda *args: (dict(self.meta, serverID='other'), ('runtime',))
        with self.assertRaises(self.api.BackendIdentityError): self.session.prove()
        self.transport.read.side_effect = lambda *args: (self.meta, ())
        with self.assertRaises(self.api.BackendIdentityError): self.session.prove()

    def test_copied_fabricated_cross_session_and_closed_proofs_block(self):
        proof = self.session.prove()
        for forged in (None, copy.copy(proof), replace(proof), proof.to_receipt()):
            with self.subTest(forged=type(forged).__name__):
                with self.assertRaises(self.api.BackendIdentityError): self.session.validate(forged)
        with self.assertRaises(self.api.BackendIdentityError): self.new_session().validate(proof)
        self.session.close()
        with self.assertRaises(self.api.BackendIdentityError): self.session.validate(proof)
        with self.assertRaises(self.api.BackendIdentityError): self.session.prove()

    def test_mutated_and_stale_proofs_block(self):
        proof = self.session.prove()
        object.__setattr__(proof, 'physical_database_id', 'other')
        with self.assertRaises(self.api.BackendIdentityError): self.session.validate(proof)
        self.session = self.new_session()
        proof = self.session.prove()
        self.meta['databaseID'] = 'changed'
        with self.assertRaises(self.api.BackendIdentityError): self.session.validate(proof)

    def test_live_route_revalidation_and_resume_stable_receipt(self):
        proof = self.session.prove()
        self.assertEqual(proof.to_receipt(), self.new_session().prove().to_receipt())
        self.transport.read.side_effect = lambda *args: (self.meta, ('changed',))
        with self.assertRaises(self.api.BackendIdentityError): self.session.validate(proof)

    def test_secret_transport_error_is_sanitized(self):
        self.transport.read.side_effect = RuntimeError('SECRET_ERROR SECRET_CONFIG')
        with self.assertRaises(RuntimeError) as caught: self.session.prove()
        self.assertNotIn('SECRET', str(caught.exception))


class CatalogTests(unittest.TestCase):
    def setUp(self):
        from kag.verify import Neo4jReadClient
        self.client = Neo4jReadClient('http://localhost:7474', 'VietRoadTraffic',
                                     username='u', password='SECRET', timeout=10)
        self.row = {'name':'vietroadtraffic','databaseID':'physical',
                    'serverID':'server','currentStatus':'online'}

    def test_catalog_resolves_case_by_unique_catalog_row(self):
        self.client._query = Mock(return_value=[self.row])
        self.assertEqual(self.client.database_metadata(), self.row)
        self.client._query.assert_called_once_with('database_metadata', {'database':'VietRoadTraffic'})

    def test_catalog_rejects_missing_ambiguous_and_duplicate_physical_id(self):
        for rows in ([], [self.row,self.row], [self.row,dict(self.row,name='other')],
                     [dict(self.row,currentStatus='offline')], [dict(self.row,serverID='')]):
            with self.subTest(rows=len(rows)):
                self.client._query = Mock(return_value=rows)
                with self.assertRaises(ValueError): self.client.database_metadata()


class LockBindingTests(unittest.TestCase):
    setUp = BackendIdentityTests.setUp
    new_session = BackendIdentityTests.new_session
    def test_lock_uses_proof_and_aliases_contend(self):
        import hashlib
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from kag.run_state import GraphLock, RunBlocked
        proof = self.session.prove()
        with TemporaryDirectory():
            root = '/run/kag-locks'
            with self.assertRaises(ValueError):
                GraphLock(root, 'wrong', {'scope':'PRODUCTION'},
                          backend_proof=proof, backend_session=self.session)
            lock = GraphLock(root, 'physical', {'scope':'PRODUCTION'},
                             backend_proof=proof, backend_session=self.session)
            self.assertEqual(lock.path.name, hashlib.sha256(b'physical').hexdigest()+'.lock')
            lock.acquire()
            inode = lock.path.stat().st_ino
            try:
                other = GraphLock(root, 'physical', {'scope':'PRODUCTION'},
                                  backend_proof=proof, backend_session=self.session)
                with self.assertRaises(RunBlocked): other.acquire()
            finally: lock.release()
            self.assertEqual(lock.path.stat().st_ino, inode)
            self.assertEqual(lock.path.read_bytes(), b'')


class DockerRouteTests(unittest.TestCase):
    def test_unproven_route_blocks_before_backend_read(self):
        from kag.backend_identity import DockerBackendTransport, BackendIdentityError
        transport = DockerBackendTransport('http://localhost:28887')
        transport._docker = Mock(side_effect=['', '[]'])
        with self.assertRaises(BackendIdentityError):
            transport.read({'uri':'neo4j://neo:7687','database':'vietroadtraffic'},
                           Mock(endpoint='http://localhost:27474'))

    def test_audited_alias_routes_share_runtime_and_bad_dns_or_ports_block(self):
        from kag.backend_identity import DockerBackendTransport, BackendIdentityError
        server = {'Id':'server-container','Image':'server-image','State':{'Running':True},
            'NetworkSettings':{'Ports':{'8887/tcp':[{'HostIp':'127.0.0.1','HostPort':'28887'}]},
                'Networks':{'net':{'NetworkID':'net-id','IPAddress':'172.20.0.5'}}}}
        neo = {'Id':'neo-container','Image':'neo-image','State':{'Running':True},
            'Config':{'ExposedPorts':{'7687/tcp':{},'7474/tcp':{}}},
            'NetworkSettings':{'Ports':{'7474/tcp':[{'HostIp':'127.0.0.1','HostPort':'27474'}]},
                'Networks':{'net':{'NetworkID':'net-id','IPAddress':'172.20.0.3',
                    'Aliases':['neo','neo-alias']}}}}
        metadata = {'name':'vietroadtraffic','databaseID':'physical',
                    'serverID':'server','currentStatus':'online'}
        from unittest.mock import patch
        runtime = []
        with patch('kag.verify.Neo4jReadClient.database_metadata', return_value=metadata) as read:
            for alias in ('neo','neo-alias'):
                transport = DockerBackendTransport('http://localhost:28887')
                transport._docker = Mock(side_effect=['s n', json.dumps([server,neo]), '["172.20.0.3"]'])
                actual, binding = transport.read({'uri':'neo4j://'+alias+':7687',
                    'database':'VietRoadTraffic','user':'u','password':'SECRET'},
                    Mock(endpoint='http://localhost:27474'))
                self.assertEqual(actual,metadata); runtime.append(binding)
            self.assertEqual(runtime[0],runtime[1]); self.assertEqual(read.call_count,2)
            for change in ('dns','port','network','duplicate','offline'):
                damaged = copy.deepcopy(neo)
                servers = [server, damaged]
                dns = '["172.20.0.9"]' if change=='dns' else '["172.20.0.3"]'
                if change=='port': damaged['NetworkSettings']['Ports']['7474/tcp'][0]['HostPort']='9999'
                if change=='network': damaged['NetworkSettings']['Networks']['net']['NetworkID']='different'
                if change=='duplicate': servers.append(copy.deepcopy(damaged))
                if change=='offline': damaged['State']['Running']=False
                transport = DockerBackendTransport('http://localhost:28887')
                transport._docker = Mock(side_effect=['s n', json.dumps(servers), dns])
                before = read.call_count
                with self.subTest(change=change), self.assertRaises(BackendIdentityError):
                    transport.read({'uri':'neo4j://neo:7687','database':'VietRoadTraffic'},
                                   Mock(endpoint='http://localhost:27474'))
                self.assertEqual(read.call_count,before)


if __name__ == '__main__': unittest.main()
