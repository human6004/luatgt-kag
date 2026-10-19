import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { loadKagStatus, runRetrieval, inspectionError, loadPipelineStatus, loadBenchmarkDatasets, loadSampleInspection, loadBuilderInputs, loadBuilderStatus, loadBuilderConfiguration, saveBuilderConfiguration, checkBuilderReadiness, runBuilderAction, builderStages, loadLLMCredentials, loadBuilderProjects, builderNeo4jLink, loadBuilderStructure, prepareBuilderStructure, previewBuilderSelection, loadBuilderClear, clearBuilderData } from '../src/pages/server/kag-inspection.ts'
import { ApiError, tokenKey } from '../src/api.ts'
import { runGraphRetrieval, loadDataset } from '../src/pages/server/kag-inspection.ts'

let calls, tokens
const failure = { state: 'NOT_READY', httpStatus: 503, code: 'NOT_READY' }
const status = { liveness: { state: 'ALIVE', httpStatus: 200 }, queryReadiness: failure, retrievalReadiness: failure, vectorRetrievalReadiness: failure, release: { state: 'RELEASE_UNAVAILABLE', httpStatus: 503 } }
const result = { contract_version: 'h1-read-v1.1', request_id: '00000000-0000-4000-8000-000000000001', release_id: 'synthetic-release', source_snapshot_id: 'synthetic-source', schema_contract: { namespace: 'VietRoadTraffic', schema_sha256: 'a'.repeat(64), contract_sha256: 'b'.repeat(64) }, items: [{ entity_type: 'VietRoadTraffic.LegalUnit', entity_id: 'test::1', doc_id: 'test', unit_id: 'test::1', sign_id: null, source_texts: { text: 'TEST ONLY — nguồn thử, không phải căn cứ pháp luật.' }, score: 0.5, vector_sources: [{ property: 'text', score: 0.5, index: 'synthetic-index' }], graph_context: [] }] }
beforeEach(() => {
  calls = []; tokens = new Map([[tokenKey, 'webapp-jwt-fixture']])
  globalThis.sessionStorage = { getItem: key => tokens.get(key), removeItem: key => tokens.delete(key) }
  globalThis.window = { dispatchEvent() {} }
})
function wire(body, code = 200) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options }); assert.equal(options.headers.get('Authorization'), 'Bearer webapp-jwt-fixture')
    return new Response(JSON.stringify(body), { status: code })
  }
}
test('trial is bound to the selected project and run without switching active', async () => {
  const trial={contract_version:'builder-retrieval-v1',project_id:17,run_id:'run-B',schema_contract:result.schema_contract,
    model_identity:'https://provider.invalid/v1|model-B',dimension:3072,graph_fingerprint:'c'.repeat(64),items:result.items}
  wire(trial);assert.deepEqual(await runGraphRetrieval(17,'run-B','Câu thử',3,false),trial)
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/admin/kag/graph/17/run-B/retrieve')
  assert.deepEqual(JSON.parse(calls[0].body),{message:'Câu thử',top_k:3,expand:false})
  wire({...trial,project_id:18});await assert.rejects(runGraphRetrieval(17,'run-B','Câu thử',3,false))
  wire({...trial,run_id:'run-A'});await assert.rejects(runGraphRetrieval(17,'run-B','Câu thử',3,false))
})
test('dataset viewing only reads a bounded page and never prepares a plan', async () => {
  const page={contract_version:'builder-dataset-v1',dataset:'LuậtGT',group:'units',source:'data/processed/units/units.jsonl',offset:25,limit:25,total:26,items:[{unit_id:'u26',text:'Nguồn Việt 😀'}]}
  wire(page);assert.deepEqual(await loadDataset('units',25),page)
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/admin/kag/dataset/units?offset=25&limit=25');assert.equal(calls[0].method,undefined)
  wire({...page,offset:0});await assert.rejects(loadDataset('units',25))
  wire({...page,items:[]});await assert.rejects(loadDataset('units',25))
  calls=[];await assert.rejects(loadDataset('../secrets'));assert.equal(calls.length,0)
})
test('structure preparation has explicit preview and confirmation with strict server readback', async () => {
  const value = { contract_version: 'builder-structure-v1', state: 'PREVIEW', revision: 1, preview_id: 'a'.repeat(64), checked_at: '2026-10-18T00:00:00Z', can_apply: true, code: null,
    report: { target: { project_id: 2, project_name: 'Private', namespace: 'Road', database: 'road' }, database_id: 'isolated', dimension: 3072,
      counts: { nodes: 0, edges: 0 }, changes: [{ kind: 'type', action: 'ADD', name: 'Road.LegalUnit' }],
      indexes: [['LegalDocument', '_title_vector'], ['LegalUnit', '_text_vector'], ['TrafficSign', '_ten_vector'], ['TrafficSign', '_mo_ta_vector']].map(([local, property]) => ({ label: 'Road.' + local, property, action: 'ADD' })),
      conflicts: [], native_rebuild: [], code: null } }
  wire(value); assert.deepEqual(await loadBuilderStructure(), value)
  wire(value, 202); await prepareBuilderStructure('preview', 2, 1)
  assert.deepEqual(JSON.parse(calls.at(-1).body), { project_id: 2, revision: 1 })
  await prepareBuilderStructure('apply', 2, 1, value.preview_id)
  assert.deepEqual(JSON.parse(calls.at(-1).body), { project_id: 2, revision: 1, preview_id: value.preview_id })
  for (const invalid of [{ ...value, state: 'COMPLETE' }, { ...value, report: { ...value.report, password: 'secret' } }, { ...value, can_apply: true, state: 'APPLYING' }]) {
    wire(invalid); await assert.rejects(loadBuilderStructure())
  }
  const cleanup = structuredClone(value)
  Object.assign(cleanup.report, { build_ready: true, default_types: ['Road.Person'], index_changes: [
    { name: '_road_person_name_vector_index', type: 'VECTOR', labels: ['Road.Person'], properties: ['_name_vector'], action: 'REMOVE' },
    { name: '_road_legal_unit_name_vector_index', type: 'VECTOR', labels: ['Road.LegalUnit'], properties: ['_name_vector'], action: 'ADD' }],
    changes: [{ kind: 'type', action: 'REMOVE', name: 'Road.Person' }, { kind: 'type', action: 'KEEP', name: 'Road.LegalUnit' }] })
  cleanup.report.indexes.forEach(row => { row.action = 'REBUILD' })
  wire(cleanup); assert.deepEqual(await loadBuilderStructure(), cleanup)
  for (const invalid of [{ ...cleanup, state: 'COMPLETE' }, { ...cleanup, report: { ...cleanup.report, build_ready: 'yes' } },
    { ...cleanup, report: { ...cleanup.report, index_changes: [{ ...cleanup.report.index_changes[0], password: 'secret' }] } }]) {
    wire(invalid); await assert.rejects(loadBuilderStructure())
  }
  const complete = structuredClone(cleanup)
  Object.assign(complete, { state: 'COMPLETE', can_apply: false })
  Object.assign(complete.report, { default_types: [], index_changes: [], changes: [{ kind: 'type', action: 'KEEP', name: 'Road.LegalUnit' }] })
  complete.report.indexes.forEach(row => { row.action = 'KEEP' })
  wire(complete); assert.deepEqual(await loadBuilderStructure(), complete)
})
test('project catalog retains IDs, distinguishes empty and permissions, rejects raw secrets', async () => {
  const row={project_id:2,project_name:'Cùng tên',namespace:'RoadOne',database:'roadone',state:'AVAILABLE'}
  const catalog={contract_version:'builder-projects-v1',state:'AVAILABLE',projects:[row,{...row,project_id:3}]}
  wire(catalog);assert.deepEqual(await loadBuilderProjects(),catalog)
  for(const state of ['EMPTY','FORBIDDEN','UNAVAILABLE','NOT_CONFIGURED']) {
    wire({...catalog,state,projects:[]});assert.equal((await loadBuilderProjects()).state,state)
  }
  for(const projects of [[row,row],[{...row,graph_store:{password:'secret'}}],[{...row,project_id:0}],[{...row,namespace:'../bad'}]]) {
    wire({...catalog,projects});await assert.rejects(loadBuilderProjects())
  }
  assert.equal(calls[0].url,'/api/admin/kag/builder/projects')
})
test('project configuration and Neo4j links use selected namespace and verified run database', async () => {
  const value={...builderConfig,contract_version:'builder-configuration-v3',target:{...builderConfig.target,namespace:'RoadTwo'},
    embedding:{...builderConfig.embedding,dimension:1536},selection:{node_limit:null,nodes:3,edges:1},
    links:{openspg:'http://127.0.0.1:8887/',neo4j:'http://127.0.0.1:7474/browser/',bolt:'bolt://127.0.0.1:7687'}}
  wire(value);assert.deepEqual(await loadBuilderConfiguration(),value)
  const link=new URL(builderNeo4jLink(value.links,'previousrun'))
  assert.equal(link.searchParams.get('db'),'previousrun')
  assert.equal(link.searchParams.get('connectURL'),value.links.bolt)
  assert.equal(builderNeo4jLink(value.links,'../escape'),undefined)
  wire({...value,links:{...value.links,bolt:'bolt://password@127.0.0.1:7687'}});await assert.rejects(loadBuilderConfiguration())
})
test('model metadata distinguishes separate Builder configuration and legacy Worker', async () => {
  const role={saved_revision:null,active_revision:null,active:null,test:null,status:'NOT_CONFIGURED',blocker:null,actions:{test:false,apply:false}}
  const value={contract_version:'llm-credentials-v3',revision:0,saved:false,chat:null,embedding:null,applied:false,
    connection_tested:false,save_allowed:true,error_code:null,roles:{chat:role,embedding:role},
    build_config:{state:'SEPARATE',reason:'BUILDER_CONFIGURATION_API'}}
  wire(value);assert.deepEqual(await loadLLMCredentials(),value)
  wire({...value,build_config:{state:'NOT_SUPPORTED',reason:'BUILDER_REPLAY_ONLY'}});await loadLLMCredentials()
  wire({...value,build_config:{state:'SEPARATE',reason:'BUILDER_REPLAY_ONLY'}});await assert.rejects(loadLLMCredentials())
})
const sourceValidation = { state: 'VALID', error_code: null, plan_sha256: 'f'.repeat(64), nodes: 3, edges: 1 }
const fullInputs = { contract_version: 'builder-inputs-v1', configuration: 'CONFIGURED', error_code: null, scope: 'PRODUCTION', target: { project_id: 37, database: 'traffic-full', namespace: 'VietRoadTraffic' }, inputs: [{ name: 'c3_manifest', sha256: 'a'.repeat(64), state: 'MATCHED' }], preflight: 'NOT_RUN', source_validation: sourceValidation }
const builderConfig = { contract_version: 'builder-configuration-v1', revision: 1, saved: true, error_code: null,
  target: { ...fullInputs.target, project_name: 'TrafficFull' }, embedding: { provider: 'openai-compatible', base_url: 'https://embedding.invalid/v1', model: 'example-model', revision: 5, key_configured: true, tested: true, dimension: 3072 },
  batch_size: 64, request_limit: null, readiness: { state: 'NOT_RUN', checks: [], checked_at: null } }
const completedBuild = { contract_version: 'builder-control-v2', state: 'COMPLETE', run_id: 'run-1', target: fullInputs.target, progress: { stage: 'release', done: 1, total: 1 }, error_code: null,
  actions: { build: false, stop: false, resume: false, delete: false }, delete_reason: 'DELETE_NOT_AUTHORIZED', production_write: 'CONFIGURED',
  stages: builderStages.map(name => ({ name, state: 'COMPLETE', done: 1, total: 1, error_code: null })),
  timing: { started_at: '2026-10-17T00:00:00+00:00', updated_at: '2026-10-17T01:00:00+00:00' },
  binding: { run_id: 'run-1', scope: 'PRODUCTION', plan_sha256: 'a'.repeat(64), config_sha256: 'b'.repeat(64), model_identity: 'https://embedding.invalid/v1|example-model', database_id: 'physical-db', ...fullInputs.target },
  result: { nodes: 3, edges: 1, vectors: 2, dimension: 3072, indexes: 4, fingerprint: 'c'.repeat(64), verified_at: '2026-10-17T01:00:00+00:00', chat_activation: 'SEPARATE' } }
test('Builder v2 keeps verified result after restart without granting another Build', async () => {
  wire(completedBuild); assert.deepEqual(await loadBuilderStatus(), completedBuild)
  assert.equal(calls[0].cache, 'no-store')
  wire(completedBuild,202);await runBuilderAction('build','run-1',7)
  assert.equal(calls.at(-1).headers.get('If-Match'),'"7"')
  assert.deepEqual(JSON.parse(calls.at(-1).body),{run_id:'run-1'})
})
test('Builder v2 rejects foreign binding, missing verification and secret fields', async () => {
  for (const mutate of [v => { v.binding.run_id = 'foreign' }, v => { v.binding.database = 'foreign' },
    v => { v.stages[1].name = 'unknown' }, v => { v.stages[7].state = 'PENDING'; v.stages[7].done = v.stages[7].total = null },
    v => { v.result.dimension = '3072' }, v => { v.result = null }, v => { v.binding.api_key = 'secret' },
    v => { v.binding.model_identity = 'https://key@embedding.invalid/v1|model' }, v => { v.state = 'RUNNING'; v.actions.stop = true }]) {
    const value = structuredClone(completedBuild); mutate(value); wire(value); await assert.rejects(loadBuilderStatus())
  }
})
test('Builder config reads metadata; save and read-only preflight remain explicit actions', async () => {
  wire(builderConfig); assert.deepEqual(await loadBuilderConfiguration(), builderConfig)
  assert.equal(calls[0].method, undefined)
  const change = { revision: 0, embedding_revision: 5, batch_size: 64, request_limit: null }
  wire(builderConfig, 202); assert.deepEqual(await saveBuilderConfiguration(change), builderConfig)
  assert.deepEqual(JSON.parse(calls.at(-1).body), change)
  await checkBuilderReadiness(); assert.equal(calls.at(-1).url, '/api/admin/kag/builder/preflight'); assert.equal(calls.at(-1).body, undefined)
})
test('preflight distinguishes an unchecked lock from a held lock', async () => {
  const value = { ...builderConfig, readiness: { state: 'BLOCKED', checked_at: null, checks: [
    { name: 'target', state: 'BLOCKED', code: 'INDEX' }, { name: 'lock', state: 'NOT_CHECKED', code: 'WAIT_TARGET' }] } }
  wire(value); assert.deepEqual(await loadBuilderConfiguration(), value)
  value.readiness.checks[1] = { name: 'lock', state: 'BLOCKED', code: 'LOCK' }
  wire(value); assert.deepEqual(await loadBuilderConfiguration(), value)
  value.readiness.checks[1].owner = { run_id: 'build-related', project_id: 2 }
  wire(value); assert.deepEqual(await loadBuilderConfiguration(), value)
  value.readiness.checks[1].owner.owner_token = 'secret'
  wire(value); await assert.rejects(loadBuilderConfiguration())
  delete value.readiness.checks[1].owner.owner_token
  value.readiness.checks[1].owner.project_id = -1
  wire(value); await assert.rejects(loadBuilderConfiguration())
  delete value.readiness.checks[1].owner
  value.readiness.state = 'READY'
  wire(value); await assert.rejects(loadBuilderConfiguration())
})
test('Builder config rejects secret fields, forged readiness, invalid target and dimension', async () => {
  for (const value of [{ ...builderConfig, api_key: 'unexpected' }, { ...builderConfig, request_limit: -1 },
    { ...builderConfig, embedding: { ...builderConfig.embedding, base_url: 'https://secret@embedding.invalid/v1' } },
    { ...builderConfig, target: { ...builderConfig.target, database: '../escape' } },
    { ...builderConfig, readiness: { state: 'READY', checks: [], checked_at: null } },
    { ...builderConfig, embedding: { ...builderConfig.embedding, dimension: -1 } }]) {
    wire(value); await assert.rejects(loadBuilderConfiguration())
  }
})

test('abandoned sessions retain their binding and cannot expose Resume', async () => {
  const abandoned={...completedBuild,contract_version:'builder-control-v3',state:'ABANDONED',result:null,actions:{build:false,stop:false,resume:false,abandon:false,delete:false}}
  wire(abandoned);assert.deepEqual(await runBuilderAction('abandon',abandoned.run_id,7),abandoned)
  assert.equal(calls.at(-1).headers.get('If-Match'),'"7"')
  wire({...abandoned,actions:{...abandoned.actions,resume:true}});await assert.rejects(loadBuilderStatus())
  wire({...abandoned,actions:{...abandoned.actions,abandon:true}});await assert.rejects(loadBuilderStatus())
})

test('database clear has an explicit target confirmation and cannot expose stale run success', async () => {
  const value={contract_version:'builder-clear-v1',state:'PREVIEW',revision:1,preview_id:'a'.repeat(64),checked_at:'2026-10-18T00:00:00Z',code:null,
    deleted:{nodes:0,edges:0},report:{target:builderConfig.target,database_id:'physical-fixture',counts:{nodes:3,edges:1},batch_size:500}}
  wire(value);assert.deepEqual(await loadBuilderClear(),value)
  await clearBuilderData('apply',1,value.preview_id,value.report.target.database)
  assert.deepEqual(JSON.parse(calls.at(-1).body),{revision:1,preview_id:value.preview_id,database:value.report.target.database})
  for(const bad of [{...value,report:null},{...value,report:{...value.report,batch_size:0}},{...value,deleted:{nodes:-1,edges:0}},{...value,api_key:'private'}]) {
    wire(bad);await assert.rejects(loadBuilderClear())
  }
  const cleared={...completedBuild,contract_version:'builder-control-v3',state:'CLEARED',result:null,actions:{build:false,stop:false,resume:false,abandon:false,delete:false}}
  wire(cleared);assert.deepEqual(await loadBuilderStatus(),cleared)
  wire({...cleared,result:completedBuild.result});await assert.rejects(loadBuilderStatus())
})
test('extended scope previews carry counts only and bind save without changing the request budget', async () => {
  const request = {mode:'PERCENT',value:50}, summary={nodes:151,edges:299,node_counts:{LegalDocument:1,LegalUnit:149,TrafficSign:1},edge_counts:{hasUnit:299},excluded_edges:12}
  const preview={contract_version:'builder-selection-v1',revision:1,preview_id:'e'.repeat(64),node_limit:151,request,summary}
  wire(preview);assert.deepEqual(await previewBuilderSelection(1,request),preview)
  const config={...builderConfig,contract_version:'builder-configuration-v4',links:null,selection:{node_limit:151,nodes:151,edges:299,request,summary}}
  wire(config);assert.deepEqual(await loadBuilderConfiguration(),config)
  const change={revision:1,embedding_revision:5,batch_size:64,request_limit:100,selection_preview_id:preview.preview_id}
  wire(config);await saveBuilderConfiguration(change);assert.deepEqual(JSON.parse(calls.at(-1).body),change)
  for(const bad of [{...preview,node_keys:[]},{...preview,summary:{...summary,nodes:150}},{...preview,request:{mode:'ALL',value:null}}]) {
    wire(bad);await assert.rejects(previewBuilderSelection(1,request))
  }
})
test('bounded Builder selection persists counts and cannot claim an oversized or invalid scope', async () => {
  const value = { ...builderConfig, contract_version: 'builder-configuration-v2', selection: { node_limit: 32, nodes: 32, edges: 21 } }
  wire(value); assert.deepEqual(await loadBuilderConfiguration(), value)
  const change = { revision: 1, embedding_revision: 5, batch_size: 4, request_limit: 100, node_limit: 32 }
  wire(value, 202); await saveBuilderConfiguration(change); assert.deepEqual(JSON.parse(calls.at(-1).body), change)
  for (const selection of [{ node_limit: 2, nodes: 2, edges: 1 }, { node_limit: 32, nodes: 33, edges: 1 }, { node_limit: 32, nodes: 32, edges: 257 }]) {
    wire({ ...value, selection }); await assert.rejects(loadBuilderConfiguration())
  }
  wire({ ...completedBuild, binding: { ...completedBuild.binding, node_limit: 32 } }); await loadBuilderStatus()
  wire({ ...completedBuild, binding: { ...completedBuild.binding, node_limit: 129 } }); await loadBuilderStatus()
  wire({ ...completedBuild, binding: { ...completedBuild.binding, node_limit: 2 } }); await assert.rejects(loadBuilderStatus())
})
test('full source validity stays separate from target preflight and write authority', async () => {
  wire(fullInputs); assert.deepEqual(await loadBuilderInputs(), fullInputs)
  wire({ ...fullInputs, inputs: [{ ...fullInputs.inputs[0], state: 'NOT_CHECKED' }] }); assert.equal((await loadBuilderInputs()).inputs[0].state, 'NOT_CHECKED')
  assert.equal(calls[0].url, '/api/admin/kag/builder/inputs')
  const blocked = { contract_version: 'builder-control-v1', state: 'BLOCKED', run_id: null, target: fullInputs.target, progress: null, error_code: 'LOCK_MOUNT', actions: { build: false, stop: false, resume: false, delete: false }, delete_reason: 'DELETE_NOT_AUTHORIZED', production_write: 'CONFIGURED' }
  wire(blocked); assert.deepEqual(await loadBuilderStatus(), blocked)
  assert.equal((await loadBuilderStatus()).actions.build, false)
})
test('explicit source check sends no path, key, run id or write grant', async () => {
  const source = { state: 'CHECKING', error_code: null, plan_sha256: null, nodes: null, edges: null }
  wire({ ...fullInputs, source_validation: source }, 202)
  assert.equal((await loadBuilderInputs(undefined, true)).source_validation.state, 'CHECKING')
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body, undefined)
})
test('packaged corpus can be prepared before a Builder target is configured', async () => {
  const value = { ...fullInputs, contract_version: 'builder-inputs-v2', configuration: 'NOT_CONFIGURED', scope: null, target: null, inputs: [] }
  wire(value); assert.deepEqual(await loadBuilderInputs(), value)
  wire({ ...value, contract_version: 'builder-inputs-v1' }); await assert.rejects(loadBuilderInputs())
})
test('source inspection rejects stale counts, forged readiness and unknown fields', async () => {
  for (const source of [{ ...sourceValidation, state: 'INVALID' }, { ...sourceValidation, nodes: -1 }, { ...sourceValidation, plan_sha256: null }, { ...sourceValidation, token: 'unexpected' }]) {
    wire({ ...fullInputs, source_validation: source }); await assert.rejects(loadBuilderInputs())
  }
  wire({ ...fullInputs, preflight: 'PASS' }); await assert.rejects(loadBuilderInputs())
  wire({ ...fullInputs, inputs: [] }); await assert.rejects(loadBuilderInputs())
})
test('status uses backend only and keeps ALIVE separate from NOT_READY', async () => {
  wire(status); assert.deepEqual(await loadKagStatus(), status); assert.equal(calls[0].url, '/api/admin/kag/status')
})
test('retrieval preserves evidence and sends no service identity or token', async () => {
  wire(result); assert.deepEqual(await runRetrieval('Nguồn thử 🚦', 3, true), result)
  assert.equal(calls[0].url, '/api/admin/kag/retrieve'); assert.deepEqual(JSON.parse(calls[0].body), { message: 'Nguồn thử 🚦', top_k: 3, expand: true })
})
test('empty evidence remains empty without sample sources', async () => {
  wire({ ...result, items: [] }); assert.deepEqual((await runRetrieval('Nguồn thử', 1, false)).items, [])
})
test('503 never becomes retrieval success or invalidates WebApp session', async () => {
  wire({ message: 'reflected-secret /private/credentials' }, 503)
  await assert.rejects(runRetrieval('Nguồn thử', 1, false), e => e.status === 503 && !inspectionError(e).includes('reflected-secret'))
  assert.equal(tokens.has(tokenKey), true); assert.match(inspectionError(new ApiError('unsafe', 503)), /chưa khả dụng/)
})
test('offline and expired JWT have separate safe errors', async () => {
  globalThis.fetch = async () => { throw Error('unsafe') }; await assert.rejects(loadKagStatus(), e => /Không kết nối/.test(inspectionError(e)))
  wire({}, 401); await assert.rejects(loadKagStatus(), e => /đăng nhập/.test(inspectionError(e))); assert.equal(tokens.has(tokenKey), false)
})
test('USER denial and validation failure remain errors', async () => {
  for (const code of [403, 422]) { wire({ message: 'unsafe' }, code); await assert.rejects(runRetrieval('Nguồn thử', 1, false), e => e.status === code && !inspectionError(e).includes('unsafe')) }
})
test('bad retrieval input makes no request', async () => {
  wire(result); for (const args of [['', 1, false], ['x'.repeat(4001), 1, false], ['Nguồn thử', 0, false], ['Nguồn thử', 11, false], ['Nguồn thử', 1.5, false]]) await assert.rejects(runRetrieval(...args)); assert.equal(calls.length, 0)
})
test('fake answer or malformed evidence fails closed', async () => {
  for (const body of [{ answer: 'fake', citations: [] }, { ...result, items: [{}] }, { ...result, answer: 'fake' }]) { wire(body); await assert.rejects(runRetrieval('Nguồn thử', 1, false)) }
})
test('liveness 200 cannot be used as a readiness proof', async () => {
  wire({ ...status, queryReadiness: { state: 'READY', httpStatus: 200, evidence: { status: 'alive' } } }); await assert.rejects(loadKagStatus())
})
test('artifact-only release cannot claim verified readiness', async () => {
  wire({ ...status, release: { state: 'READY', httpStatus: 200, evidence: { backend_identity_verified: false, source_identity_verified: false, query_ready: false } } }); await assert.rejects(loadKagStatus())
})
test('liveness is never displayed as verified capability readiness', async () => {
  wire({ ...status, liveness: { state: 'READY', httpStatus: 200, evidence: { status: 'ready', capability: 'retrieve', checks: { auth: 'pass', runtime: 'pass', sources: 'pass', admission: 'pass' } } } }); await assert.rejects(loadKagStatus())
})
const pipeline = { contract_version: 'h1-inspect-v1.0', phase: 'idle', active_requests: 0, draining: false, closed: false, progress: null, execution_allowed: false, operational_proof: 'DENY', production_write: 'BLOCKED', provider_egress: 'DENY' }
const benchmark = { contract_version: 'h1-inspect-v1.0', state: 'AVAILABLE', datasets: [{ id: 'synthetic/eval_questions.jsonl', dataset_status: 'FROZEN', dataset_eligibility: 'ELIGIBLE', reason: null, dataset_hash: 'a'.repeat(64), record_count: 1, official_benchmark: false }], execution_allowed: false, execution_blockers: ['OPERATIONAL_PROOF_REQUIRED', 'BENCHMARK_EXECUTION_NOT_AUTHORIZED'], metrics: null }
test('pipeline displays only measured slot state with no fabricated progress', async () => {
  wire(pipeline); assert.deepEqual(await loadPipelineStatus(), pipeline); assert.equal(calls[0].url, '/api/admin/kag/pipeline')
  wire({ ...pipeline, phase: 'running', active_requests: 1 }); assert.equal((await loadPipelineStatus()).phase, 'running')
  for (const body of [{ ...pipeline, progress: 100 }, { ...pipeline, execution_allowed: true }, { ...pipeline, phase: 'running' }, { ...pipeline, provider_egress: 'ALLOW' }]) { wire(body); await assert.rejects(loadPipelineStatus()) }
})
test('frozen dataset eligibility does not grant benchmark execution or invent metrics', async () => {
  wire(benchmark); const value = await loadBenchmarkDatasets(); assert.deepEqual(value, benchmark); assert.equal(value.execution_allowed, false); assert.equal(value.metrics, null); assert.equal(calls[0].url, '/api/admin/kag/benchmark/datasets')
  for (const body of [{ ...benchmark, metrics: { accuracy: 1 } }, { ...benchmark, execution_allowed: true }, { ...benchmark, datasets: [{ ...benchmark.datasets[0], dataset_status: 'PROVISIONAL' }] }]) { wire(body); await assert.rejects(loadBenchmarkDatasets()) }
})
test('inspection offline and 503 do not turn into idle or eligible success', async () => {
  wire({}, 503); await assert.rejects(loadPipelineStatus()); await assert.rejects(loadBenchmarkDatasets())
  globalThis.fetch = async () => { throw Error('offline') }; await assert.rejects(loadPipelineStatus())
})
test('inspection rejects unexpected fields, unsafe IDs and incomplete execution blockers', async () => {
  wire({ ...pipeline, credential: 'unexpected' }); await assert.rejects(loadPipelineStatus())
  for (const body of [{ ...benchmark, execution_blockers: [] }, { ...benchmark, credential: 'unexpected' },
    { ...benchmark, datasets: [{ ...benchmark.datasets[0], id: '../private/file' }] },
    { ...benchmark, datasets: [{ ...benchmark.datasets[0], dataset_hash: 'unverified' }] },
    { ...benchmark, datasets: [benchmark.datasets[0], benchmark.datasets[0]] }]) {
    wire(body); await assert.rejects(loadBenchmarkDatasets())
  }
})
const sample = {
  contract_version: 'h1-sample-inspection-1.0', release_id: 'fixture-release', release_kind: 'SAMPLE', source_snapshot_id: 'fixture-source', source_catalog_sha256: 'a'.repeat(64), schema_contract: result.schema_contract, graph_fingerprint: 'b'.repeat(64),
  backend: { database: 'vietroadtraffic', namespace: 'VietRoadTraffic', database_id: 'fixture-db', server_id: 'fixture-server', read_only: true, verified: true },
  counts: { nodes: 1, edges: 0, vectors: 1 }, nodes: [{ entity_type: 'VietRoadTraffic.LegalDocument', entity_id: 'fixture-doc', properties: { id: 'fixture-doc', name: 'fixture-doc', title: 'TEST ONLY' }, sources: [{ evidence_id: 'c'.repeat(64), field: 'title', source_sha256: 'd'.repeat(64) }] }], edges: [],
  verified_at: '2026-10-11T00:00:00+00:00', execution_allowed: false, production_write: 'BLOCKED', sample_receipt: { stage: 'GRAPH_VERIFIED', sealed_at: '2026-10-11T00:00:00Z', receipt_sha256: 'e'.repeat(64), build_run_id: null, progress: null },
  datasets: { ...benchmark, datasets: [] }, providers: { state: 'NOT_CONFIGURED', attempts: null, receipt_window: null, configured_chat_model: null, configured_embedding_model: null, policy_response_version: null, exact_backend_identity_verified: false, upstream_attempts: null, proxy_retries: null }
}

test('dataset metadata exposes version and validated categories with consistent counts', async () => {
  const row = { ...benchmark.datasets[0], eligible_count: 1, ineligible_count: 0, invalid_count: 0, gold_count: 1, missing_gold: { document: [], unit: [], sign: [] }, eligibility_scope: 'G1_RETRIEVAL_GOLD_COVERAGE', metadata: { dataset_version: 'fixture-v2', category_counts: { definition: 1 }, generation_method: null } }
  const body = { ...sample, datasets: { ...benchmark, datasets: [row] } }
  wire(body); assert.equal((await loadSampleInspection()).datasets.datasets[0].metadata.dataset_version, 'fixture-v2')
  for (const metadata of [{ ...row.metadata, category_counts: { definition: 2 } }, { ...row.metadata, dataset_version: '' }, { ...row.metadata, generation_method: 'fabricated' }]) {
    wire({ ...body, datasets: { ...body.datasets, datasets: [{ ...row, metadata }] } }); await assert.rejects(loadSampleInspection())
  }
})
test('sample inspection preserves bounded actual nodes, provenance and separate authority', async () => {
  wire(sample); assert.deepEqual(await loadSampleInspection(), sample); assert.equal(calls[0].url, '/api/admin/kag/sample')
  assert.equal((await loadSampleInspection()).nodes[0].properties.title, 'TEST ONLY')
})
test('sample inspection rejects false proof, fabricated counts, dangling edges and production authority', async () => {
  for (const body of [{ ...sample, backend: { ...sample.backend, verified: false } }, { ...sample, counts: { ...sample.counts, nodes: 2 } },
    { ...sample, execution_allowed: true }, { ...sample, providers: { ...sample.providers, exact_backend_identity_verified: true } },
    { ...sample, counts: { ...sample.counts, edges: 1 }, edges: [{ from: ['VietRoadTraffic.LegalDocument', 'fixture-doc'], predicate: 'hasUnit', to: ['VietRoadTraffic.LegalUnit', 'missing'], properties: {} }] }]) {
    wire(body); await assert.rejects(loadSampleInspection())
  }
})

test('provisional smoke results remain separate from official benchmark authority', async () => {
  const smoke = { state: 'AVAILABLE', review_status: 'PROVISIONAL', g1_eligible_count: 1, graph_fingerprint: sample.graph_fingerprint, official_benchmark: false, runs: { G1: { status: 'COMPLETE', started_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T00:01:00Z', requested_count: 1, attempted_count: 1, failed_count: 0, ineligible_count: 0, metrics: { 'unit.Hit@1': { value: 0, scored_count: 1, eligible_count: 1, excluded_count: 0, failed_count: 0, status_counts: { OK: 1, NOT_APPLICABLE: 0, UNAVAILABLE: 0, UNKNOWN: 0 } } }, latency_ms: { successful: { count: 1, min: 10, mean: 10, median: 10, p95: 10, max: 10 }, all_attempted: { count: 1, min: 10, mean: 10, median: 10, p95: 10, max: 10 } } }, G2: null } }
  const row = { ...benchmark.datasets[0], dataset_status: 'PROVISIONAL', dataset_eligibility: 'BLOCKED', reason: 'PROVISIONAL_DATASET', eligible_count: 0, ineligible_count: 1, invalid_count: 0, gold_count: 1, missing_gold: { document: [], unit: [], sign: [] }, eligibility_scope: 'G1_RETRIEVAL_GOLD_COVERAGE', smoke }
  const body = { ...sample, datasets: { ...benchmark, datasets: [row] } }
  wire(body); assert.equal((await loadSampleInspection()).datasets.datasets[0].smoke.runs.G1.metrics['unit.Hit@1'].value, 0)
  for (const change of [{ official_benchmark: true }, { review_status: 'HUMAN_REVIEWED' }, { graph_fingerprint: '0'.repeat(64) }, { state: 'NOT_RUN' }, { runs: { ...smoke.runs, G1: { ...smoke.runs.G1, attempted_count: 2 } } }]) {
    wire({ ...body, datasets: { ...body.datasets, datasets: [{ ...row, smoke: { ...smoke, ...change } }] } }); await assert.rejects(loadSampleInspection())
  }
  const frozenRun = { ...smoke.runs.G1, requested_count: 5, attempted_count: 5, metrics: {}, latency_ms: Object.fromEntries(Object.entries(smoke.runs.G1.latency_ms).map(([k,v])=>[k,{...v,count:5}])) }
  frozenRun.configuration = { protocol_version:'1.0',eval_version:'1.0',metric_policy_version:'1.1',ks:[1],top_k:1,expand:false,rank_semantics:'channel_projected_returned_top_k',identity_catalog_hash:null,release_id:sample.release_id,judge_config:{name:'fixture',version:'v1',model:'synthetic',prompt_version:'p1',temperature:0,seed:null,calibrated:false} }
  const frozenRow = { ...row, dataset_status:'FROZEN',dataset_eligibility:'ELIGIBLE',reason:null,record_count:5,eligible_count:5,ineligible_count:0,gold_count:5,smoke:{...smoke,review_status:'FROZEN',g1_eligible_count:5,runs:{G1:frozenRun,G2:null}} }
  wire({...body,datasets:{...body.datasets,datasets:[frozenRow]}});assert.equal((await loadSampleInspection()).datasets.datasets[0].smoke.runs.G1.requested_count,5)
  for (const changes of [{review_status:'PROVISIONAL'},{official_benchmark:true}]) {
    wire({...body,datasets:{...body.datasets,datasets:[{...frozenRow,smoke:{...frozenRow.smoke,...changes}}]}});await assert.rejects(loadSampleInspection())
  }
})
