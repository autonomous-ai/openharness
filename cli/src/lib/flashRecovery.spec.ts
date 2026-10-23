import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import type { DialPort } from '../cable/serial.js'
import { completeFlash } from './flashRecovery.js'

const a: DialPort = { path: 'COM3', serialNumber: 'FIXTURE-A', session: 'attachment-a', vendorId: 0x303a, productId: 0x1001 }
const b: DialPort = { ...a, path: 'COM4', serialNumber: 'FIXTURE-B', session: 'attachment-b' }
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(ports: DialPort[] = [a, b]) {
  const dir = mkdtempSync(join(tmpdir(), 'flash-recovery-')); directories.push(dir)
  const verdictFile = join(dir, 'dial-ports.json')
  const before = new DialVerdicts(verdictFile)
  before.markForeign(a); before.markForeign(b)
  const stopDiscovery = vi.fn()
  return { verdictFile, findPorts: async () => ports, stopDiscovery }
}

function shortLivedCompletion(verdictFile: string, outcome: 'success' | 'missing' | 'stop-failure') {
  const directory = dirname(verdictFile)
  const entry = join(directory, 'completion.mjs')
  const receipt = join(directory, 'completion.json')
  const stopped = join(directory, 'watch-stopped')
  const pidFile = join(directory, 'watch-pid')
  const source = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)))
  buildSync({
    stdin: { contents: `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { completeFlash } from ${source('./flashRecovery.ts')}
import { createWindowsDialWatch } from ${source('../cable/windowsSerial.ts')}
const watch = createWindowsDialWatch({
  command: (args) => ({ file: process.execPath, args: [${source('../cable/__fixtures__/fakeHarnessSerial.mjs')}, ...args] }),
  spawn: (...args) => { const child = spawn(...args); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); return child },
})
// Match cli.ts: its completion promise has handlers, but no top-level await or other referenced work.
void completeFlash('COM3', {
  verdictFile: ${JSON.stringify(verdictFile)},
  findPorts: () => watch.ports(),
  stopDiscovery: () => { watch.stop(); writeFileSync(${JSON.stringify(stopped)}, 'stopped'); ${outcome === 'stop-failure' ? "throw new Error('fixture stop failed')" : ''} },
}).then(() => { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ ok: true })); process.exitCode = 0 })
  .catch(error => { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 })
`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  })
  const snapshot = { console: true, ports: outcome === 'missing' ? [b] : [a, b] }
  const result = spawnSync(process.execPath, [entry], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true, cwd: directory,
    env: {
      ...process.env,
      NODE_ENV: 'test', HARNESS_TEST_ISOLATED: '1', ADAPTER_DATA_DIR: directory,
      ADAPTER_CLI_DIR: join(directory, 'cli'), ADAPTER_RUNTIME_DIR: join(directory, 'runtime'),
      HARNESS_AUTH_DIR: join(directory, 'auth'), HARNESS_BIN_DIR: join(directory, 'bin'),
      HARNESS_LOGS_DIR: join(directory, 'logs'),
      WEB_URL: 'http://127.0.0.1:9', BACKEND_WS_URL: 'ws://127.0.0.1:9',
      FAKE_SERIAL_DELAY: '250', FAKE_SERIAL_LINES: JSON.stringify([JSON.stringify(snapshot)]),
      FAKE_SERIAL_EXIT: '', FAKE_SERIAL_STUBBORN: '', FAKE_SERIAL_SPLIT: '',
    },
  })
  return { result, receipt, stopped, pidFile }
}

async function expectWatchEnded(pidFile: string) {
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await vi.waitFor(() => {
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    expect(alive).toBe(false)
  }, { timeout: 3_000 })
}

describe('a successful flash while the daemon was stopped', () => {
  it('keeps a short-lived CLI alive for the real watch snapshot and scoped persisted clearing', async () => {
    const f = fixture()
    const child = shortLivedCompletion(f.verdictFile, 'success')
    try {
      expect(child.result.error).toBeUndefined()
      expect(child.result.status, child.result.stderr).toBe(0)
      const after = new DialVerdicts(f.verdictFile)
      expect({
        foreignA: after.isForeign(a), foreignB: after.isForeign(b),
        completed: existsSync(child.receipt), stopped: existsSync(child.stopped),
      }).toEqual({ foreignA: false, foreignB: true, completed: true, stopped: true })
      expect(JSON.parse(readFileSync(child.receipt, 'utf8'))).toEqual({ ok: true })
      expect(readFileSync(child.stopped, 'utf8')).toBe('stopped')
    } finally { await expectWatchEnded(child.pidFile) }
  })

  it('ends the short-lived CLI and watch after asynchronous selection failure, preserving both verdicts', async () => {
    const f = fixture()
    const before = readFileSync(f.verdictFile, 'utf8')
    const child = shortLivedCompletion(f.verdictFile, 'missing')
    try {
      expect(child.result.error).toBeUndefined()
      expect(child.result.status, child.result.stderr).toBe(1)
      expect(readFileSync(f.verdictFile, 'utf8')).toBe(before)
      expect(JSON.parse(readFileSync(child.receipt, 'utf8'))).toEqual({ ok: false, error: 'could not uniquely identify the flashed board' })
      expect(readFileSync(child.stopped, 'utf8')).toBe('stopped')
    } finally { await expectWatchEnded(child.pidFile) }
  })

  it('releases its process lifetime even when stopping the completed watch throws', async () => {
    const f = fixture()
    const child = shortLivedCompletion(f.verdictFile, 'stop-failure')
    try {
      expect(child.result.error).toBeUndefined()
      expect(child.result.status, child.result.stderr).toBe(1)
      expect(JSON.parse(readFileSync(child.receipt, 'utf8'))).toEqual({ ok: false, error: 'fixture stop failed' })
      expect(new DialVerdicts(f.verdictFile).isForeign(a)).toBe(false)
      expect(new DialVerdicts(f.verdictFile).isForeign(b)).toBe(true)
      expect(readFileSync(child.stopped, 'utf8')).toBe('stopped')
    } finally { await expectWatchEnded(child.pidFile) }
  })

  it('forgets only the selected board, persisting before the next daemon reads the unchanged attachment', async () => {
    const f = fixture()
    await completeFlash('com3', f)
    const after = new DialVerdicts(f.verdictFile)
    expect(after.isForeign(a)).toBe(false)
    expect(after.isForeign(b)).toBe(true)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', [b]],
    ['ambiguous COM port', [a, { ...b, path: a.path }]],
    ['ambiguous board identity', [a, { ...b, serialNumber: a.serialNumber }]],
    ['case-insensitive duplicate identity', [a, { ...b, serialNumber: a.serialNumber!.toLowerCase() }]],
    ['missing stable identity', [{ ...a, serialNumber: undefined }, b]],
    ['empty stable identity', [{ ...a, serialNumber: '' }, b]],
  ] as const)('preserves every verdict when the selected board is %s', async (_reason, ports) => {
    const f = fixture([...ports])
    const bytes = readFileSync(f.verdictFile, 'utf8')
    await expect(completeFlash('COM3', f)).rejects.toThrow(/identify/)
    expect(readFileSync(f.verdictFile, 'utf8')).toBe(bytes)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })

  it('closes the read-only watch when discovery fails', async () => {
    const f = fixture()
    const bytes = readFileSync(f.verdictFile, 'utf8')
    await expect(completeFlash('COM3', { ...f, findPorts: async () => { throw new Error('discovery failed') } })).rejects.toThrow('discovery failed')
    expect(readFileSync(f.verdictFile, 'utf8')).toBe(bytes)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })

  it('rejects a malformed port without touching the persisted verdicts', async () => {
    const f = fixture()
    const bytes = readFileSync(f.verdictFile, 'utf8')
    await expect(completeFlash('COM3 & COM4', f)).rejects.toThrow(/COM port/)
    expect(readFileSync(f.verdictFile, 'utf8')).toBe(bytes)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })
})
