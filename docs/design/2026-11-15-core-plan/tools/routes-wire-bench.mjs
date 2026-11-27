import http from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
// Run from a repository checkout with Node 24 and its locked CLI dependencies.
// Usage: node docs/design/2026-11-15-core-plan/tools/routes-wire-bench.mjs BASE_SHA OUTPUT_JSON
const root = process.cwd(), baseline = process.argv[2], output = process.argv[3]
if (!baseline || !output) throw new Error('BASE_SHA and OUTPUT_JSON are required')
const require = createRequire(join(root, 'cli/package.json'))
const { build } = require('esbuild'), { WebSocket } = require('ws')
const { createServiceRoutes } = await import(pathToFileURL(join(root, 'cli/src/core/serviceRoutes.ts')).href)
const fixture = mkdtempSync('/tmp/core-route-wire-')
process.env.HOME = fixture
process.env.HARNESS_HOME = fixture
process.env.NODE_ENV = 'test'
const deadline = setTimeout(() => { console.error('WIRE_BENCH_TIMEOUT'); process.exit(1) }, 120000)
const frames = ['route_task', 'route_send', 'voice_route_reply'].map(frame => ({ frame, type: 'devices_ws', waitMs: 25000 }))
const unused = { route() { throw new Error('unexpected feature request') } }
const adapter = createServiceRoutes({ routes: [], frames, linked: unused, hosted: unused })
const implementations = {}
const sourceHashes = {}
for (const name of ['before', 'after']) {
  const contents = name === 'before'
    ? execFileSync('git', ['show', `${baseline}:cli/src/localWsServer.ts`], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, 'cli/src/localWsServer.ts'), 'utf8')
  sourceHashes[name] = createHash('sha256').update(contents).digest('hex')
  const outfile = join(fixture, `${name}.mjs`)
  await build({ stdin: { contents, loader: 'ts', sourcefile: `${name}.ts`, resolveDir: join(root, 'cli/src') }, outfile,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } })
  implementations[name] = (await import(pathToFileURL(outfile).href)).attachLocalWsServer
}
const percentile = (values, fraction) => [...values].sort((a, b) => a-b)[Math.ceil(values.length * fraction)-1]
async function run(name) {
  let sink, seen = 0, expected = 0, complete
  const backend = {
    registerLocalClient(_id, value) { sink = value; return true },
    async unregisterLocalClient() {},
    handleLocalFrame(_id, frame) {
      if (frame.payload.echo) sink.sendFrame({ type: 'echo', payload: {} })
      if (++seen === expected) complete?.()
    },
    async handleLocalBinary() {},
  }
  const server = http.createServer()
  const options = name === 'after' ? { serviceFrames: adapter.frames } : {
    onRouteTask: unused.route, onRouteSend: unused.route, onVoiceRouteReply: unused.route,
  }
  const local = implementations[name](server, { backend, machineId: 'fixture', ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/local-ws`)
  try {
    await once(socket, 'open')
    const connected = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'fixture', localProtocolVersion: 1 } }))
    await connected
    const messages = ['terminal_ack', 'terminal_resize'].map(type => JSON.stringify({ type, payload: { agentId: 'fixture', consumed: 65536, rows: 40, cols: 120 } }))
    async function batch(count) {
      expected = seen + count
      const done = new Promise(resolve => { complete = resolve })
      for (let i = 0; i < count; i++) socket.send(messages[i & 1])
      await done
    }
    for (let i = 0; i < 20; i++) await batch(256)
    const cpu = process.cpuUsage(), start = performance.now()
    for (let i = 0; i < 160; i++) await batch(256)
    const elapsed = performance.now() - start, used = process.cpuUsage(cpu)
    const echo = JSON.stringify({ type: 'terminal_ack', payload: { agentId: 'fixture', consumed: 65536, echo: true } })
    const latency = []
    for (let i = 0; i < 1200; i++) {
      const received = once(socket, 'message'), start = performance.now()
      socket.send(echo)
      await received
      if (i >= 200) latency.push(performance.now() - start)
    }
    return { wallUsPerFrame: elapsed * 1000 / 40960, cpuUsPerFrame: (used.user + used.system) / 40960,
      roundTripP50Ms: percentile(latency, .5), roundTripP95Ms: percentile(latency, .95) }
  } finally {
    socket.terminate()
    await local.close()
    await new Promise(resolve => server.close(resolve))
  }
}
try {
  const result = { baseline, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version, sourceHashes, samples: [] }
  await run('before'); await run('after')
  for (let round = 0; round < 9; round++) {
    for (const name of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      result.samples.push({ round, name, ...await run(name) })
    }
  }
  writeFileSync(output, JSON.stringify(result, null, 2))
} finally {
  clearTimeout(deadline)
  rmSync(fixture, { recursive: true, force: true })
}
