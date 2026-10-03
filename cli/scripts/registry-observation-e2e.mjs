// Two real processes exercise production registry locking and discovery/hook merges on private state.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const self = fileURLToPath(import.meta.url)
const baseInput = {
  agentId: 'fixture-base', engine: 'claude', tmuxPane: '%0', cwd: '/fixture/project',
  processIdentity: { pid: 10000, executable: '/fixture/claude', startMarker: 'fixture-base' },
}
const tick = () => new Promise(resolve => setTimeout(resolve, 2))

if (process.argv[2] === '--worker') {
  const [bundle, directory] = process.argv.slice(3)
  const { registry } = await import(pathToFileURL(bundle).href)
  registry.load()
  let queue = Promise.resolve()
  process.on('message', ({ id, command, count }) => {
    queue = queue.then(async () => {
      let result = true
      if (command === 'seed') assert(registry.openProcessAgent(baseInput))
      else if (command === 'observe') {
        for (let i = 0; i < count; i++) {
          await registry.transaction(() => {
            assert(registry.updateRuntimes(baseInput.agentId, [{ backend: 'tmux', paneId: '%0' }]))
            assert(registry.updateProcessIdentity(baseInput.agentId, { ...baseInput.processIdentity }))
          })
          await tick()
        }
      } else if (command === 'hooks') {
        assert(registry.register({ ...baseInput, sessionId: 'fixture-conversation',
          transcriptPath: `${directory}/fixture-conversation.jsonl` }))
        for (let i = 1; i <= count; i++) {
          assert(registry.openProcessAgent({ ...baseInput, agentId: `fixture-added-${i}`, tmuxPane: `%${i}`,
            processIdentity: { ...baseInput.processIdentity, pid: 10000 + i, startMarker: `fixture-${i}` } }))
          registry.updateTitle(baseInput.agentId, `external title ${i}`)
          await tick()
        }
      } else if (command === 'close') {
        registry.setClosePlan(baseInput.agentId, {
          id: '12345678-1234-1234-1234-123456789012', requestedAt: Date.now(),
          identity: 'fixture-conversation', state: 'waiting',
        })
      } else if (command === 'cancel') {
        registry.setClosePlan(baseInput.agentId, null)
      } else if (command === 'rename') {
        for (let i = 0; i < count; i++) {
          registry.updateTitle(baseInput.agentId, `racing title ${i}`)
          await tick()
        }
      } else if (command === 'snapshot') result = registry.list()
      else throw new Error(`Unknown fixture command ${command}`)
      process.send({ id, result })
    }).catch(error => { process.send({ id, error: error.stack }); process.exitCode = 1 })
  })
  process.send({ ready: true })
} else {
  const [outputDirectory] = process.argv.slice(2)
  assert(outputDirectory, 'Usage: node registry-observation-e2e.mjs NEW_OUTPUT_DIRECTORY')
  const root = resolve(outputDirectory)
  mkdirSync(root, { mode: 0o700 })
  const directory = `${root}/state`
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(`${directory}/fixture-conversation.jsonl`, '{}\n', { mode: 0o600 })
  const bundle = `${root}/registry.mjs`
  const keys = ['AMP_SESSIONS_DIR', 'MUSE_HOME', 'CODEX_HOME', 'CURSOR_HOME', 'GROK_HOME', 'AGY_HOME',
    'COPILOT_HOME', 'PI_HOME', 'COMMANDCODE_HOME', 'CLAUDE_PROJECTS_DIR', 'ADAPTER_DATA_DIR']
  await build({ entryPoints: [fileURLToPath(new URL('../src/lib/registry.ts', import.meta.url))], outfile: bundle,
    platform: 'node', format: 'esm', bundle: true, logLevel: 'silent', plugins: [{ name: 'private-state', setup(builder) {
      builder.onResolve({ filter: /config\/env\.js$/ }, () => ({ path: 'env', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js',
        contents: `export const env = ${JSON.stringify(Object.fromEntries(keys.map(key => [key, directory])))};` }))
    } }] })
  const children = []
  const cleanup = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
  }
  async function start() {
    const child = fork(self, ['--worker', bundle, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(child)
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    let sequence = 0
    const pending = new Map()
    let ready
    const started = new Promise((resolve, reject) => {
      ready = resolve
      child.once('error', reject)
      child.once('exit', code => {
        const error = new Error(`Fixture worker exited ${code}: ${output}`)
        reject(error)
        for (const item of pending.values()) item.reject(error)
        pending.clear()
      })
    })
    child.on('message', message => {
      if (message.ready) ready()
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      if (message.error) item.reject(new Error(message.error))
      else item.resolve(message.result)
    })
    await started
    return (command, count) => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      child.send({ id, command, count })
    })
  }
  const deadline = setTimeout(() => {
    for (const child of children) child.kill('SIGTERM')
  }, 45_000)
  try {
    const observer = await start()
    await observer('seed')
    const writer = await start()
    await Promise.all([observer('observe', 100), writer('hooks', 20)])
    await observer('observe', 1)
    const rows = await observer('snapshot')
    assert.equal(rows.length, 21)
    assert.equal(new Set(rows.map(row => row.agentId)).size, 21)
    assert.equal(new Set(rows.map(row => row.tmuxPane)).size, 21)
    assert.equal(rows.find(row => row.agentId === baseInput.agentId).sessionId, 'fixture-conversation')
    assert.equal(rows.find(row => row.agentId === baseInput.agentId).title, 'external title 20')
    await Promise.all([observer('close'), writer('rename', 20)])
    await observer('observe', 1)
    const stored = JSON.parse(readFileSync(`${directory}/registry.json`, 'utf8'))
    const base = stored.find(row => row.agentId === baseInput.agentId)
    assert.equal(base.title, 'racing title 19')
    assert.equal(base.closePlan.state, 'waiting')
    assert.equal(stored.length, 21)
    await Promise.all([observer('observe', 20), writer('cancel')])
    await observer('observe', 1)
    const cancelled = await observer('snapshot')
    assert.equal(cancelled.find(row => row.agentId === baseInput.agentId).closePlan, undefined)
    assert.equal(JSON.parse(readFileSync(`${directory}/registry.json`, 'utf8'))
      .find(row => row.agentId === baseInput.agentId).closePlan, undefined)
    assert(!existsSync(`${directory}/registry.json.lock`))
    await cleanup()
    writeFileSync(`${root}/result.json`, JSON.stringify({ success: true, node: process.version,
      discoveryPasses: 123, concurrentAddedAgents: 20, concurrentTitleUpdates: 40, closeIntentRetained: true,
      closeCancellationPropagated: true,
      finalRows: stored.length, childrenReaped: children.length, lockReleased: true,
      scope: 'Two production registry processes, real filesystem locks and hook/discovery calls; private synthetic rows only.' }, null, 2))
    console.log(readFileSync(`${root}/result.json`, 'utf8'))
  } finally {
    clearTimeout(deadline)
    await cleanup()
  }
}
