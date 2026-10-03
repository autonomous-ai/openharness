// Manual native check (PTY required):
// node cli/scripts/memory-native-codex-lifecycle-probe.mjs --output <new-report.json>
// Review and trust only this disposable folder and its exact synthetic hooks through
// the native UI. Never bypass native trust or use an existing native home.
// First launch: send a synthetic coding prompt; /compact; send another prompt; /quit.
// Later launches (resume, model change, config profile): send one prompt; /quit.
// Submit prompts beginning 'Synthetic coding review request' without using tools.
// The report records each outgoing request; a marker in one request does not prove
// every request carried it. No real model, host authorization or usefulness is tested.
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
const engine = 'codex'
const option = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  assert.ok(value && !value.startsWith('--'), `${name} requires a value`)
  return value
}
const reportPath = option('--output')
assert.ok(reportPath, '--output requires a new report path')
const model = option('--model', 'gpt-5.4'), changedModel = option('--changed-model', 'gpt-5.4-mini')
assert.notEqual(model, changedModel, 'The model-change check needs a different model')
const contextFile = option('--context-file')
writeFileSync(reportPath, '{}\n', { flag: 'wx', mode: 0o600 })
let launch = 'first', promptNumber = 0, version = null, sequence = 0
const runs = []
const marker = 'coding-memory-probe-8bd9c6d4'
const contextTemplate = contextFile ? (await readFile(contextFile, 'utf8')).trim() : JSON.stringify({ type: 'coding_memory_context', notice: 'Synthetic historical context; current instructions take precedence.',
  items: [{ claim: `For coding review, prefer a tiny failing test first. ${marker}` }] })
if (contextFile) assert.equal(JSON.parse(contextTemplate).type, 'coding_memory_sources')
assert.ok(contextTemplate.includes(marker), 'The synthetic context must include the probe marker')
const contextHash = createHash('sha256').update(contextTemplate).digest('hex')
const contextFor = number => contextTemplate.replaceAll(marker, `${marker}-${number}`)
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
let checks = null, passed = false
const limitations = ['Synthetic localhost replies and disposable homes; no real inference or task usefulness.',
  'An exact packet on a user turn does not prove every native request includes memory.',
  'Config profile selection is tested; authentication/account changes and Harness owner changes are not.',
  'Execution stays disabled. Startup model/Code Mode errors can occur; delivery observations do not certify background extraction.']
const persist = () => writeFileSync(reportPath,JSON.stringify({engine,version,model,changedModel,
  contextHash,launch,passed,checks,runs,hooks,requests,limitations},null,2))
const fixture = await mkdtemp(join(tmpdir(), 'native-memory-hooks-'))
const receiptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const requests = [], hooks = []
const provider = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return }
  if (!req.url.startsWith('/v1/responses')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return
  }
  requests.push({ sequence: ++sequence,launch,model:body.model, route: req.url.split('?')[0], promptNumber, markers:[...JSON.stringify(body).matchAll(/coding-memory-probe-8bd9c6d4-(\d+)/g)].map(match=>Number(match[1])), inputTypes:(body.input??[]).map(item=>({type:item.type,role:item.role,channel:item.channel})), contextReceived: JSON.stringify(body).includes(marker),
    exactCurrentContextReceived: strings(body).some(value => value.includes(contextFor(promptNumber))),
    contextRoles: (body.messages ?? body.input ?? []).filter(item => JSON.stringify(item).includes(marker)).map(item => item.role),
    promptReceived: JSON.stringify(body).includes('Synthetic coding review request'), tools: (body.tools ?? []).map(tool => tool.name ?? tool.type) })
  persist()
  if (req.url.startsWith('/v1/responses/compact')) {
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'cmp_fixture',object:'response.compaction',created_at:1,output:[{id:'cmp_item',type:'compaction',encrypted_content:'synthetic-opaque-compaction'}],usage:{input_tokens:100,output_tokens:10,total_tokens:110}})); return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    const item = { id:`msg_${randomUUID()}`,type:'message',role:'assistant',channel:'final',status:'completed',content:[{type:'output_text',text:'Synthetic response.',annotations:[]}] }
    const response = {id:`resp_${randomUUID()}`,object:'response',status:'completed',model:body.model,output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}
    send({type:'response.created',response:{...response,status:'in_progress',output:[]}})
    send({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress'}})
    send({type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:'Synthetic response.'})
    send({type:'response.output_item.done',output_index:0,item})
    send({type:'response.completed',response})

  res.end()
})
const adapter = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch {
    hooks.push({sequence:++sequence,launch,route:req.url,method:req.method,rejected:'invalid_json'});persist()
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_json"}'); return
  }
  if(body.hookEvent==='UserPromptSubmit')promptNumber++
  hooks.push({sequence:++sequence,launch,promptNumber,route:req.url,event:body.hookEvent,source:body.source,engine:body.engine,receipt:body.memoryReceiptId===receiptId})
  persist()
  const additionalContext=contextFor(promptNumber)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, additionalContext, memoryReceiptId: receiptId }))
})
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
try {
  await Promise.all([listen(provider), listen(adapter)])
  for (const name of ['home','codex','data','work']) await mkdir(join(fixture,name), { mode:0o700 })
  await writeFile(join(fixture,'data','hook-credential'), `${'a'.repeat(43)}\n`, { mode:0o600 })
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`
  const command = [process.execPath,fileURLToPath(new URL('../hook/notify.mjs', import.meta.url)),'--port',String(adapter.address().port),'--data-dir',join(fixture,'data'),
    '--engine',engine,'--codex-home',join(fixture,'codex')].map(quote).join(' ')
  const config = { hooks: Object.fromEntries(['SessionStart','UserPromptSubmit','PreCompact','PostCompact'].map(event=>[event,[{hooks:[{type:'command',command,timeout:3}]}]])) }
  await writeFile(join(fixture,'codex','hooks.json'),JSON.stringify(config))
  await writeFile(join(fixture,'codex','memory-review.config.toml'), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = "low"\n`)
  const baseEnv = { PATH:process.env.PATH,HOME:join(fixture,'home'),TMPDIR:fixture,TERM:'xterm-256color',TMUX_PANE:'%424242',
    CODEX_HOME:join(fixture,'codex'),HARNESS_MEMORY_TEST_KEY:'local-test-only' }
  const disabled = ['shell_tool','unified_exec','apps','browser_use','browser_use_external','browser_use_full_cdp_access',
    'computer_use','image_generation','in_app_browser','multi_agent','plugins','remote_plugin','view_image','code_mode_host',
    'tool_suggest','workspace_dependencies','skill_search','sleep_tool','goals','memories','shell_snapshot','enable_request_compression','daemon_auto_start']
  const overrides = ['--model',model,'--sandbox','read-only','-c','model_provider="memory_mock"',
    '-c','model_providers.memory_mock.name="Local hook test"','-c',`model_providers.memory_mock.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
    '-c','model_providers.memory_mock.env_key="HARNESS_MEMORY_TEST_KEY"','-c','model_providers.memory_mock.wire_api="responses"',
    '-c','model_providers.memory_mock.requires_openai_auth=false','-c','web_search="disabled"','-c','check_for_update_on_startup=false',
    '--enable','hooks',...disabled.flatMap(feature=>['--disable',feature])]
  const args = ['--no-daemon','--no-alt-screen',...overrides]
  version = execFileSync(engine,['--version'],{encoding:'utf8',env:baseEnv,timeout:5000}).trim()
  for(const step of ['first','resume','model_change','profile_change']) {
    launch=step
    const nextArgs=[...args,...(step==='first'?[]:['resume','--last'])]
    if(step==='model_change') nextArgs[nextArgs.indexOf('--model')+1]=changedModel
    if(step==='profile_change') nextArgs.splice(nextArgs.indexOf('--model'),2,'--profile','memory-review')
    console.log(`\nSYNTHETIC FIXTURE ${step}; native folder and exact hook trust must be reviewed. Report: ${reportPath}\n`)
    const child=spawn(engine,nextArgs,{cwd:join(fixture,'work'),env:baseEnv,stdio:'inherit'})
    const startedAt = new Date().toISOString()
    // The first launch includes four individual native hook reviews. Later launches reuse that trust.
    const timeoutMs = step === 'first' ? 480000 : 120000
    let timedOut=false
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},timeoutMs)
    const hardTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')},timeoutMs+5000)
    const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
    clearTimeout(timer);clearTimeout(hardTimer)
    runs.push({step,...result,timedOut,timeoutMs,startedAt,completedAt:new Date().toISOString()});persist()
    if(result.code!==0 || timedOut) { process.exitCode=1; break }
  }
  const submitted = hooks.filter(hook => hook.event === 'UserPromptSubmit')
  const delivered = number => requests.some(request => request.promptNumber === number
    && request.route === '/v1/responses' && request.promptReceived && request.exactCurrentContextReceived
    && request.contextRoles.includes('developer'))
  const beforeCompaction = hooks.find(hook => hook.launch === 'first' && hook.event === 'PreCompact' && hook.promptNumber === 1)
  const afterCompaction = hooks.find(hook => hook.launch === 'first' && hook.event === 'PostCompact' && hook.promptNumber === 1
    && beforeCompaction && hook.sequence > beforeCompaction.sequence)
  checks = {
    launchesCompleted: runs.length === 4 && runs.every(run => run.code === 0 && !run.timedOut),
    freshContextOnEverySubmittedPrompt: submitted.length === 5 && submitted.every(hook => delivered(hook.promptNumber)),
    contextAfterCompaction: !!afterCompaction && submitted.some(hook => hook.launch === 'first' && hook.promptNumber === 2
      && hook.sequence > afterCompaction.sequence) && requests.some(request => request.launch === 'first'
      && request.sequence > afterCompaction.sequence && request.route === '/v1/responses'
      && request.exactCurrentContextReceived && request.promptNumber === 2),
    resumedPrompt: submitted.some(hook => hook.launch === 'resume') && requests.some(request => request.launch === 'resume'
      && request.model === model && request.exactCurrentContextReceived),
    changedModelPrompt: submitted.some(hook => hook.launch === 'model_change') && requests.some(request => request.launch === 'model_change'
      && request.model === changedModel && request.exactCurrentContextReceived),
    configProfilePrompt: submitted.some(hook => hook.launch === 'profile_change') && requests.some(request => request.launch === 'profile_change'
      && request.model === model && request.exactCurrentContextReceived),
  }
  passed = Object.values(checks).every(Boolean)
  persist()
  if (!passed) process.exitCode = 1
  console.log(JSON.stringify({reportPath,runs,requests:requests.length,hooks:hooks.length},null,2))

} finally {
  for(const server of [provider,adapter]) { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)) }
  await rm(fixture,{recursive:true,force:true})
}
