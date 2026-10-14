/** Record the former boot/caller evidence before sharing its pure probe with the hook client. */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { controlIdentity, nativeProcessControl, type NativeControlRow } from '../../lib/nativeProcessControl.js'
import { readProcessEvidence } from '../../lib/processEvidence.js'
import { nativeBytes } from './nativeEvidence.js'
import { createNativeHookOwnerReader } from './nativeHookOwner.js'

vi.mock('../../lib/processEvidence.js', () => ({ readProcessEvidence: vi.fn() }))
vi.mock('../../lib/nativeProcessControl.js', async original => ({ ...await original<object>(), nativeProcessControl: vi.fn() }))
vi.mock('./nativeEvidence.js', async original => ({ ...await original<object>(), nativeBytes: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the native-owner golden') }
  return { execFile: vi.fn(), exec: forbidden, execSync: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
const GOLDEN = new URL('../../__fixtures__/native-hook-owner.golden.json', import.meta.url)
const RECORD = process.env.RECORD_NATIVE_HOOK_OWNER_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const BOOT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

it.each(['linux', 'darwin'])('preserves precise %s caller, runtime and boot evidence', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    captured[key] = JSON.parse(JSON.stringify(value))
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  const refusal = async (read: () => unknown) => {
    try { await read(); return 'unexpected success' }
    catch (error) { return { name: (error as Error).name, message: (error as Error).message } }
  }
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-11T00:00:00Z') })
    vi.stubEnv('TZ', 'UTC'); vi.stubEnv('TMPDIR', '/tmp'); clock.now = 0
    const kernel: unknown[] = [], probes: unknown[] = [], proofReads: unknown[] = []
    vi.mocked(nativeBytes).mockImplementation(async (path, limit, budget) => {
      kernel.push({ path, limit, deadline: budget.remaining() }); return Buffer.from(BOOT + '\n')
    })
    vi.mocked(execFile).mockImplementation((path, args, options, callback) => {
      expect(path).toBe('/usr/sbin/sysctl')
      kernel.push({ path: '<sysctl>', args, options })
      ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(null, BOOT.toUpperCase() + '\n', '')
      return {} as never
    })
    const row = { agentId: 'fixture-agent', active: true, engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%1' }],
      primaryRuntimeKey: 'tmux:%1', processIdentity: { pid: 42, executable: 'codex', startMarker: 'fixture-start' } } as RegisteredSession
    const native: NativeControlRow = { pid: 42, parentPid: 77, birth: platform === 'linux' ? '12345' : '1791547140:123456',
      command: 'codex', imagePath: '/fixture/codex', argv: ['codex', '--model', 'fixture'], fds: [] }
    const shell: NativeControlRow = { ...native, pid: 43, parentPid: 42, birth: platform === 'linux' ? '12346' : '1791547140:123457',
      command: 'sh', imagePath: '/fixture/sh', argv: ['sh', '-c', '<node> <hook>'] }
    const processes = new Map([[42, native], [43, shell]])
    vi.mocked(nativeProcessControl).mockImplementation(async (pids, parent, budget, descriptors) => {
      probes.push({ pids, parent, descriptors, deadline: budget.remaining() })
      if (pids.some(pid => !processes.has(pid))) throw Error('fixture unreadable ancestor')
      return { parent: 0, children: [], rows: new Map(pids.map(pid => [pid, processes.get(pid)!])) }
    })
    vi.mocked(readProcessEvidence).mockImplementation(async (pid, budget, unused, identity) => {
      proofReads.push({ pid, deadline: budget.remaining(), unused: unused ?? null, identity })
      return { parent: { nativeBirth: native.birth, controlIdentity: controlIdentity(native) } } as never
    })
    const reader = createNativeHookOwnerReader(), caller = await reader.captureCaller(43, [])
    const owner = caller.owner(row)
    check('original', owner)
    processes.delete(43); clock.now = 10_000
    const fresh = await reader(row, owner)
    fresh.verify(); check('after-caller-exit', { key: fresh.key, evidence: fresh.evidence })
    native.birth += '1'
    check('replacement-refused', await refusal(() => reader(row, owner)))
    const cursor = { ...row, engine: 'cursor' } as RegisteredSession
    const runtime = await reader.captureCaller(43, [cursor])
    check('cursor-runtime', runtime.owner(cursor))
    check('cursor-route-changed', await refusal(() => runtime.owner({ ...cursor, runtimes: [{ backend: 'tmux', paneId: '%2' }] })))
    const absent = await reader.captureCaller(43, [])
    check('absent-prefix', await refusal(() => absent.owner(row)))
    check('kernel-probes', kernel)
    check('control-probes', probes)
    check('registry-proofs', proofReads)
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', original)
  }
})

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
