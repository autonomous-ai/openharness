/** Disposable real Codex shared-server lifecycle test. No paid provider or user profile. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
const exec = promisify(execFile)
const root = mkdtempSync(join(tmpdir(), 'harness-codex-shared-close-'))
const binary = (await exec('/usr/bin/which', ['codex'])).stdout.trim()
for (const key of Object.keys(process.env)) if (/^(HARNESS|CODEX|CLAUDE|ANTHROPIC|OPENAI)_/.test(key)) delete process.env[key]
Object.assign(process.env, { CODEX_HOME: root, CODEX_PATH: binary, ADAPTER_DATA_DIR: join(root, 'harness') })
const { connectCodexControl, stopSharedCodexSession } = await import('../src/lib/codexSessionLifecycle.js')
const { registry } = await import('../src/lib/registry.js')
const provider = createServer((_request, _response) => { /* Holds the synthetic turn until interrupted. */ })
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
const providerPort = (provider.address() as { port:number }).port
writeFileSync(join(root, 'config.toml'), `model_provider = "fixture"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`)
let control: Awaited<ReturnType<typeof connectCodexControl>> | undefined
try {
  await exec(binary, ['app-server', 'daemon', 'start'], { env: process.env, timeout: 15000 })
  control = await connectCodexControl(root)
  const threads: Array<{ id: string; path: string }> = []
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(), timestamp = new Date().toISOString()
    const folder = join(root, 'sessions', timestamp.slice(0,4), timestamp.slice(5,7), timestamp.slice(8,10))
    mkdirSync(folder, { recursive: true })
    const path = join(folder, `rollout-${timestamp.slice(0,19).replace(/:/g, '-')}-${id}.jsonl`)
    writeFileSync(path, [
      { timestamp, type:'session_meta', payload: { id, timestamp, cwd:root, originator:'codex_cli_rs', cli_version:'0.159.0', source:'cli', model_provider:'fixture' } },
      { timestamp, type:'response_item', payload: { type:'message',role:'user',content:[{type:'input_text',text:`SHARED_HISTORY_${id}`}] } },
    ].map(row=>JSON.stringify(row)).join('\n')+'\n')
    const resumed = await control.request('thread/resume', { threadId:id, cwd:root })
    assert.equal(resumed.thread.id, id)
    threads.push({ id, path })
  }
  const [target, neighbour] = threads
  await control.request('turn/start', { threadId:target.id, input:[{type:'text',text:'Local loopback fixture only; do not use tools.'}] })
  const until = Date.now() + 5000
  while ((await control.request('thread/read', { threadId:target.id })).thread.status.type !== 'active' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await control.request('thread/read', { threadId:target.id })).thread.status.type, 'active')
  await control.request('thread/goal/set', { threadId:target.id, objective:'Only wait for the local fixture; do not use tools.', status:'active' })
  const row = registry.openPendingAgent({ engine:'codex', runtimes:[{backend:'tmux',paneId:'%999999'}],cwd:root,codexHome:root })!
  Object.assign(row, { sessionId:target.id, transcriptPath:target.path })
  await stopSharedCodexSession(row, ()=>true)
  assert.equal((await control.request('thread/read', { threadId:target.id })).thread.status.type, 'notLoaded')
  assert.equal((await control.request('thread/read', { threadId:neighbour.id })).thread.status.type, 'idle')
  assert.equal((await control.request('thread/goal/get', { threadId:target.id })).goal.status, 'paused')
  assert(existsSync(target.path), 'the native conversation must be back in sessions')
  assert(readFileSync(target.path,'utf8').includes(`SHARED_HISTORY_${target.id}`))
  const resumed = await control.request('thread/resume', { threadId:target.id })
  assert.equal(resumed.thread.id, target.id)
  assert.equal(resumed.thread.status.type, 'idle')
  console.log('PASS shared Codex: active turn stopped, target unloaded, neighbour remained loaded, history retained, same conversation resumed')
} finally {
  control?.close()
  provider.closeAllConnections(); provider.close()
  await exec(binary, ['app-server', 'daemon', 'stop'], { env:process.env, timeout:15000 }).catch(error=>console.error('fixture cleanup:',error.message))
  console.log('fixture:',root)
  if (!process.env.KEEP_RESUME_FIXTURE) rmSync(root,{recursive:true,force:true})
}
