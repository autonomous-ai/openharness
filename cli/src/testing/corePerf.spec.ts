import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const children: ChildProcessWithoutNullStreams[] = []
const roots: string[] = []
const preload = join(process.cwd(), 'e2e/harness/corePerf.cjs')
const token = 'only-this-disposable-test'

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 1_000)
    try { await exited } finally { clearTimeout(kill) }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function start(role: '__run' | '__harnessd' | '__service') {
  const root = mkdtempSync(join(tmpdir(), 'core-perf-probe-'))
  roots.push(root)
  // A real child does measurable work. The sampler must include its CPU, not the runner's.
  const child = spawn(process.execPath, ['--require', preload, '-e', `
    process.stdin.on('data', () => {
      const start = process.cpuUsage();
      let total = 0;
      for (let i = 0; i < 3_000_000; i++) total += Math.sqrt(i);
      console.log('work ' + JSON.stringify({ cpu: process.cpuUsage(start), total }));
    });
    console.log('ready');
  `, '--', role], {
    env: { HOME: root, HARNESS_E2E_PERF_DIR: root, HARNESS_E2E_PERF_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await vi.waitFor(() => expect(output).toContain('ready'), { timeout: 3_000 })
  return { root, child, output: () => output }
}

it.each(['__harnessd', '__service'] as const)('does not start a perf endpoint in %s', async role => {
  const { root } = await start(role)
  expect(readdirSync(root)).toEqual([])
})

it('measures the owned core, rejects overlapping windows, and keeps heap pauses out of them', async () => {
  const { root, child, output } = await start('__run')
  const ready = join(root, `core-${child.pid}.json`)
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3_000 })
  const endpoint = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; port: number }
  expect(endpoint.pid).toBe(child.pid)
  const request = (op: string, label = 'sample', credential = token) => fetch(`http://127.0.0.1:${endpoint.port}/${op}`, {
    method: 'POST', headers: { 'x-harness-perf-token': credential }, body: JSON.stringify({ label }), signal: AbortSignal.timeout(5_000),
  })
  expect((await request('start', 'sample', 'wrong')).status).toBe(403)
  expect((await request('end')).status).toBe(400)
  expect((await request('start')).status).toBe(200)
  expect((await request('start')).status).toBe(400)
  expect((await request('heap')).status).toBe(400)
  // Let the delay histogram observe the event loop before and after the work.
  await new Promise(resolve => setTimeout(resolve, 25))
  child.stdin.write('work\n')
  await vi.waitFor(() => expect(output()).toContain('work {'))
  await new Promise(resolve => setTimeout(resolve, 25))
  const work = JSON.parse(output().split('\n').find(line => line.startsWith('work '))!.slice(5))
  const response = await request('end')
  expect(response.status).toBe(200)
  const measured = await response.json() as Record<string, any>
  expect(measured.pid).toBe(child.pid)
  expect(measured.cpu.userUs).toBeGreaterThanOrEqual(work.cpu.user)
  expect(measured.cpu.systemUs).toBeGreaterThanOrEqual(work.cpu.system)
  expect(measured.cpu.percent).toBeGreaterThan(0)
  expect(measured.endUs).toBeGreaterThan(measured.startUs)
  expect(measured.memory.rssMax).toBeGreaterThan(0)
  expect(measured.eventLoop.delaySamples).toBeGreaterThan(0)
  expect((await request('end')).status).toBe(400)
  const heap = await (await request('heap', 'after')).json() as { pid: number; file: string; durationSeconds: number }
  expect(heap.pid).toBe(child.pid)
  expect(heap.file.startsWith(join(root, 'after-'))).toBe(true)
  expect(statSync(heap.file).size).toBeGreaterThan(0)
  expect(heap.durationSeconds).toBeGreaterThan(0)
  expect((await request('unknown')).status).toBe(400)
  expect((await request('start', '../escape')).status).toBe(400)
}, 10_000)
