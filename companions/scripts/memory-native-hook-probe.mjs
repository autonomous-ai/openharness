// Manual native transport probe: node companions/scripts/memory-native-hook-probe.mjs [--codex] [--interactive] [--context-file synthetic.json]
// Isolated synthetic configuration and fake credentials; model/adapter endpoints are loopback-only.
// Native trust prompts are preserved. Do not bypass them or reuse a real user's config for this test.
// This checks transport with a mock model, not extraction fidelity, task quality or every native lifecycle.
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
const engine = process.argv.includes('--codex') ? 'codex' : 'claude'
const interactive = process.argv.includes('--interactive')
const fixture = await mkdtemp(join(tmpdir(), 'native-memory-hooks-'))
const marker = 'coding-memory-probe-8bd9c6d4'
const contextArgument = process.argv.indexOf('--context-file')
const contextFile = contextArgument < 0 ? null : process.argv[contextArgument + 1]
assert.ok(contextArgument < 0 || (contextFile && !contextFile.startsWith('--')), 'A synthetic context file is required')
const additionalContext = contextFile ? (await readFile(contextFile, 'utf8')).trim() : JSON.stringify({ type: 'coding_memory_context', notice: 'Synthetic historical context; current instructions take precedence.',
  items: [{ claim: `For coding review, prefer a tiny failing test first. ${marker}` }] })
if (contextFile) {
  assert.equal(JSON.parse(additionalContext).type, 'coding_memory_sources')
  assert.ok(additionalContext.includes(marker))
}
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
const receiptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const requests = [], hooks = []
const provider = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return }
  if (!req.url.startsWith('/v1/messages') && !req.url.startsWith('/v1/responses')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return
  }
  requests.push({ route: req.url.split('?')[0], contextReceived: JSON.stringify(body).includes(marker),
    exactContextReceived: strings(body).some(value => value.includes(additionalContext)),
    contextRoles: (body.messages ?? body.input ?? []).filter(item => JSON.stringify(item).includes(marker)).map(item => item.role),
    promptReceived: JSON.stringify(body).includes('Synthetic coding review request'), tools: (body.tools ?? []).map(tool => tool.name ?? tool.type) })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  if (engine === 'claude') {
    send({type:'message_start',message:{id:'msg_synthetic',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,
      stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}})
    send({type:'content_block_start',index:0,content_block:{type:'text',text:''}})
    send({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Synthetic response.'}})
    send({type:'content_block_stop',index:0})
    send({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}})
    send({type:'message_stop'})
  } else {
    const item = { id:'msg_probe',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic response.',annotations:[]}] }
    const response = {id:'resp_probe',object:'response',status:'completed',model:body.model,output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}
    send({type:'response.created',response:{...response,status:'in_progress',output:[]}})
    send({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress'}})
    send({type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:'Synthetic response.'})
    send({type:'response.output_item.done',output_index:0,item})
    send({type:'response.completed',response})
  }
  res.end()
})
const adapter = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch {
    hooks.push({ route: req.url, method: req.method, rejected: 'invalid_json' })
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_json"}'); return
  }
  hooks.push({ route: req.url, event: body.hookEvent, engine: body.engine, receipt: body.memoryReceiptId === receiptId })
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, additionalContext, memoryReceiptId: receiptId }))
})
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
try {
  await Promise.all([listen(provider), listen(adapter)])
  for (const name of ['home','config','codex','data','work']) await mkdir(join(fixture,name), { mode:0o700 })
  await writeFile(join(fixture,'data','hook-credential'), `${'a'.repeat(43)}\n`, { mode:0o600 })
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`
  const command = [process.execPath,fileURLToPath(new URL('../../cli/hook/notify.mjs', import.meta.url)),'--port',String(adapter.address().port),'--data-dir',join(fixture,'data'),
    '--engine',engine,'--codex-home',join(fixture,'codex')].map(quote).join(' ')
  const config = { hooks: { UserPromptSubmit:[{hooks:[{type:'command',command,timeout:3}]}] } }
  const settings = join(fixture,'config','settings.json')
  await writeFile(settings,JSON.stringify(config))
  await writeFile(join(fixture,'codex','hooks.json'),JSON.stringify(config))
  const baseEnv = { PATH:process.env.PATH,HOME:join(fixture,'home'),TMPDIR:fixture,TERM:'xterm-256color',TMUX_PANE:'%424242',
    CODEX_HOME:join(fixture,'codex'),CLAUDE_CONFIG_DIR:join(fixture,'config'),
    ANTHROPIC_BASE_URL:`http://127.0.0.1:${provider.address().port}`,ANTHROPIC_AUTH_TOKEN:'synthetic-not-a-real-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',HARNESS_MEMORY_TEST_KEY:'local-test-only' }
  const disabled = ['shell_tool','unified_exec','apps','browser_use','browser_use_external','browser_use_full_cdp_access',
    'computer_use','image_generation','in_app_browser','multi_agent','plugins','remote_plugin','view_image','code_mode_host',
    'tool_suggest','workspace_dependencies','skill_search','sleep_tool','goals','memories','shell_snapshot','enable_request_compression','daemon_auto_start']
  const overrides = ['--model','gpt-5.4','--sandbox','read-only','-c','model_provider="memory_mock"',
    '-c','model_providers.memory_mock.name="Local hook test"','-c',`model_providers.memory_mock.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
    '-c','model_providers.memory_mock.env_key="HARNESS_MEMORY_TEST_KEY"','-c','model_providers.memory_mock.wire_api="responses"',
    '-c','model_providers.memory_mock.requires_openai_auth=false','-c','web_search="disabled"',
    '--enable','hooks',...disabled.flatMap(feature=>['--disable',feature])]
  const args = engine === 'claude'
    ? ['--print','--verbose','--output-format','stream-json','--include-hook-events','--no-session-persistence','--restricted',
      '--disable-slash-commands','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings',settings,
      '--setting-sources','','--model','claude-opus-4-6']
    : interactive ? ['--no-daemon','--no-alt-screen',...overrides] : ['exec','--json','--ephemeral','--skip-git-repo-check',...overrides,'-']
  const version = execFileSync(engine,['--version'],{encoding:'utf8',env:baseEnv}).trim()
  const child = spawn(engine,args,{cwd:join(fixture,'work'),env:baseEnv,stdio:interactive ? 'inherit' : ['pipe','pipe','pipe']})
  let stdout='',stderr=''
  if (!interactive) {
    child.stdout.on('data',chunk=>{if(stdout.length<500000)stdout+=chunk})
    child.stderr.on('data',chunk=>{if(stderr.length<10000)stderr+=chunk})
    child.stdin.end('Synthetic coding review request. Return a short response without tools.')
  }
  const timer=setTimeout(()=>child.kill('SIGTERM'),interactive ? 180000 : 30000)
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  clearTimeout(timer)
  const events=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  const nativeContextVerified = requests.some(request=>request.contextReceived)
  const exactContextVerified = requests.some(request=>request.exactContextReceived)
  console.log(JSON.stringify({engine,version,code,interactive,nativeContextVerified,exactContextVerified,
    contextSha256:createHash('sha256').update(additionalContext).digest('hex'),contextType:JSON.parse(additionalContext).type,hooks,requests,
    events:events.map(event=>({type:event.type,subtype:event.subtype})),
    diagnostics:{stdioCaptured:!interactive,hookTrustNeeded:interactive ? null : /hook.*trust|hook.*review/i.test(stderr),
      stderrPresent:interactive ? null : !!stderr}},null,2))
  if (contextFile) assert.ok(code === 0 && nativeContextVerified && exactContextVerified, 'Exact synthetic source context was not verified in the native model request')
} finally {
  for(const server of [provider,adapter]) { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)) }
  await rm(fixture,{recursive:true,force:true})
}
