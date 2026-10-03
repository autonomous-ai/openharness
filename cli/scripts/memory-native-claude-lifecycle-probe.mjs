// Manual native check: node cli/scripts/memory-native-claude-lifecycle-probe.mjs
// Uses disposable native configuration, fake credentials and localhost responses only.
// Checks the next user prompt after resume/manual compaction/model change, not automatic
// mid-turn compaction, account changes, real host authorization or model usefulness.
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const fixture = await mkdtemp(join(tmpdir(), 'native-memory-lifecycle-'))
const hookFile = fileURLToPath(new URL('../hook/notify.mjs', import.meta.url))
const sessionId = randomUUID()
const marker = 'memory_lifecycle_72ab9'
const receiptId = randomUUID()
const requests = [], hooks = [], runs = []
const sessions = new Map()
let phase = 'setup'
const alias = value => {
  if (typeof value !== 'string') return null
  if (!sessions.has(value)) sessions.set(value, `session_${sessions.size + 1}`)
  return sessions.get(value)
}
const provider = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch { res.writeHead(200).end('{}'); return }
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.endsWith('/count_tokens')) { res.writeHead(200, {'content-type':'application/json'}).end('{"input_tokens":1000}'); return }
  if (path !== '/v1/messages') { res.writeHead(200, {'content-type':'application/json'}).end('{}'); return }
  const text = JSON.stringify(body)
  requests.push({ phase, path, model: body.model, markers: ['first','resume','compact','after_compact','model_change'].filter(p => text.includes(`${marker}_${p}`)),
    contextRoles: (body.messages ?? []).filter(item => JSON.stringify(item).includes(marker)).map(item => item.role),
    tools: (body.tools ?? []).map(tool => tool.name) })
  const answer = phase === 'compact' ? 'Synthetic compacted history: a coding fixture was reviewed. Continue the synthetic task.' : 'Synthetic response.'
  res.writeHead(200, {'content-type':'text/event-stream'})
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  send({type:'message_start',message:{id:`msg_${randomUUID()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,
    stop_sequence:null,usage:{input_tokens:1000,output_tokens:0}}})
  send({type:'content_block_start',index:0,content_block:{type:'text',text:''}})
  send({type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}})
  send({type:'content_block_stop',index:0})
  send({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:20}})
  send({type:'message_stop'})
  res.end()
})
const adapter = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  hooks.push({phase,route:req.url,event:body.hookEvent,source:body.source,session:alias(body.sessionId),receipt:body.memoryReceiptId === receiptId})
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,
    additionalContext:JSON.stringify({type:'coding_memory_context',items:[{claim:`Synthetic memory ${marker}_${phase}`}]}),memoryReceiptId:receiptId}))
})
const listen = server => new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
let active
try {
  await Promise.all([listen(provider),listen(adapter)])
  for (const name of ['home','config','data','work']) await mkdir(join(fixture,name),{mode:0o700})
  await writeFile(join(fixture,'data','hook-credential'),`${'a'.repeat(43)}\n`,{mode:0o600})
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`
  const command = [process.execPath,hookFile,'--port',String(adapter.address().port),'--data-dir',join(fixture,'data'),'--engine','claude'].map(quote).join(' ')
  const settings = join(fixture,'config','settings.json')
  await writeFile(settings,JSON.stringify({hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','PreCompact','PostCompact'].map(event=>[event,[{hooks:[{type:'command',command,timeout:3}]}]]))}))
  const childEnv = {PATH:process.env.PATH,HOME:join(fixture,'home'),TMPDIR:fixture,TERM:'xterm-256color',TMUX_PANE:'%424242',
    CLAUDE_CONFIG_DIR:join(fixture,'config'),ANTHROPIC_BASE_URL:`http://127.0.0.1:${provider.address().port}`,
    ANTHROPIC_AUTH_TOKEN:'synthetic-not-a-real-token',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1'}
  const version=execFileSync('claude',['--version'],{encoding:'utf8',env:childEnv}).trim()
  for (const step of ['first','resume','compact','after_compact','model_change']) {
    phase=step
    const model=step==='model_change'?'claude-sonnet-4-6':'claude-opus-4-6'
    const args=['--print','--verbose','--output-format','stream-json','--include-hook-events','--restricted',
      '--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings',settings,'--setting-sources','','--model',model,
      ...(step==='first'?['--session-id',sessionId]:['--resume',sessionId])]
    active=spawn('claude',args,{cwd:join(fixture,'work'),env:childEnv,stdio:['pipe','pipe','pipe']})
    let stdout='',stderr='',timedOut=false
    active.stdout.on('data',chunk=>{if(stdout.length<2000000)stdout+=chunk})
    active.stderr.on('data',chunk=>{if(stderr.length<20000)stderr+=chunk})
    active.stdin.end(step==='compact'?'/compact':`Synthetic coding lifecycle request ${step}. Return a short reply without tools.`)
    const child=active
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},30000)
    const hardTimer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')},35000)
    const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
    clearTimeout(timer);clearTimeout(hardTimer);active=null
    const events=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}})
    runs.push({phase,...result,timedOut,events:events.map(event=>({type:event.type,subtype:event.subtype,session:alias(event.session_id),
      ...(event.type==='result'?{isError:event.is_error,result:event.result}:{}),...(event.subtype==='compact_boundary'?{compactMetadata:event.compact_metadata}:{})})),stderr})
    if(result.code!==0)break
  }
  console.log(JSON.stringify({version,requests,hooks,runs,limitations:['Synthetic localhost provider; no inference or semantic quality measured.','Adapter uses synthetic responses; this does not verify real host authorization.']},null,2))
} finally {
  if(active && active.exitCode===null && active.signalCode===null)active.kill('SIGTERM')
  for(const server of [provider,adapter]) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  await rm(fixture,{recursive:true,force:true})
}
