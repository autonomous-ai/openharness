import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { inspectNativeHookOriginHeader } from './engines/kit/nativeHookOrigin.js'

const roots: string[] = [], servers: ReturnType<typeof createServer>[] = []
let artifact: string, inputs: string[]
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'emitted-hook-build-'))
  roots.push(root); artifact = join(root, 'notify.mjs')
  const { buildHookNotify } = await import(new URL('../scripts/lib/hookNotifyBundle.mjs', import.meta.url).href)
  const build = await buildHookNotify({ outfile: artifact })
  inputs = Object.keys(build.metafile.inputs)
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))))
})
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

async function emitted(engine: string, mode = 'late reparent', credential = true) {
  const root = mkdtempSync(join(tmpdir(), 'emitted-hook-origin-')); roots.push(root)
  const data = join(root, 'data'), home = join(root, 'home'), tmux = join(root, 'tmux')
  for (const path of [data, home, tmux, join(root, 'proc/sys/kernel/random')]) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'proc/sys/kernel/random/boot_id'), 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n')
  if (credential) writeFileSync(join(data, 'hook-credential'), 'a'.repeat(43), { mode: 0o600 })
  writeFileSync(join(data, 'registry.json'), '[]\n', { mode: 0o600 })
  for (const [pid, parent] of [[4102, mode === 'early reparent' || mode === 'offline' ? 1 : 4101], [4101, 4100], [4100, 1]]) {
    const directory = join(root, 'proc', String(pid)); mkdirSync(directory)
    writeFileSync(join(directory, 'stat'), `${pid} (fixture-process) S ${parent} ${Array(17).fill(0).join(' ')} ${pid * 100} ${Array(30).fill(0).join(' ')}\n`)
    writeFileSync(join(directory, 'cmdline'), '/fixture/node\0fixture-engine\0')
  }
  const requests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = []
  // This is an old core: it ignores optional headers and accepts the former body.
  const server = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw)
      requests.push({ headers: request.headers, body })
      response.writeHead('nativeOrigin' in body ? 400 : 200).end(JSON.stringify({ ok: true }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  if (mode === 'offline') await new Promise<void>(done => server.close(() => done()))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(data, 'runtime'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECTS_DIR: join(home, '.claude/projects'), CODEX_HOME: join(home, '.codex'),
    TMUX_TMPDIR: tmux, TMUX_PANE: '%1', HARNESS_ORIGIN_FIXTURE: root,
    HARNESS_ORIGIN_CASE: mode === 'offline' ? 'early reparent' : mode,
  }
  delete env.TMUX; delete env.NODE_OPTIONS; delete env.HARNESS_HOOK_DEADLINE_MS
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./testing/nativeHookOriginPreload.mjs', import.meta.url)),
    artifact, '--engine', engine, '--data-dir', data, '--port', String(port)], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const code = new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done) })
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', cwd: root }))
  const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
  try { expect(await code, stderr).toBe(0) } finally { clearTimeout(timer) }
  return { requests, stdout, stderr, registry: readFileSync(join(data, 'registry.json'), 'utf8'),
    wroteLock: existsSync(join(data, 'registry.json.lock')) }
}

it('bundles the emitted origin reader without daemon configuration, registry, workers or outbox activation', () => {
  expect(inputs).toContain('src/engines/kit/nativeHookOriginClient.ts')
  expect(inputs.filter(path => /src\/(?:config|core|services|harnessd)\/|\/registry\.|nativeHook(?:Client\.|Outbox|Replay)/.test(path))).toEqual([])
})

it.each(['claude', 'codex'])('emits the original %s caller after reparenting with an old-core-compatible body', async engine => {
  const result = await emitted(engine)
  expect(result.stderr).toBe(''); expect(result.stdout).toBe('')
  expect(result.requests).toHaveLength(1)
  const request = result.requests[0]
  expect(request.body).toMatchObject({ engine, callerPid: 4101 })
  expect(request.body).not.toHaveProperty('nativeOrigin')
  const origin = inspectNativeHookOriginHeader(request.headers['x-harness-hook-origin'])
  expect(origin.callerPid).toBe(4101)
  expect(origin.ancestry.map(row => row.pid)).toEqual([4101, 4100])
  expect(origin).not.toHaveProperty('runtime')
})

it.each(['early reparent', 'stuck boot', 'offline'])('keeps %s capture held without recapture or offline registry writes', async mode => {
  const result = await emitted('claude', mode)
  expect(result.stderr.match(/Hook admission is held/g)).toHaveLength(1)
  expect(result.registry).toBe('[]\n'); expect(result.wroteLock).toBe(false)
  expect(result.requests).toHaveLength(mode === 'offline' ? 0 : 1)
  for (const request of result.requests) expect(request.headers['x-harness-hook-origin']).toBe('unavailable-v1')
}, 10_000)

it('keeps failed capture held when the hook credential is unavailable', async () => {
  const result = await emitted('codex', 'early reparent', false)
  expect(result.requests).toEqual([])
  expect(result.stderr.match(/Hook admission is held/g)).toHaveLength(1)
  expect(result.registry).toBe('[]\n')
})

it('preserves Cursor legacy matching without injecting an ancestry-only origin', async () => {
  const result = await emitted('cursor')
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0].headers).not.toHaveProperty('x-harness-hook-origin')
  expect(result.stdout).toBe('{}\n'); expect(result.stderr).toBe('')
})
