import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { composedCodex } from '../testing/inlineNativeControls.js'
import { createHarnessResourcesReader } from './harnessResources.js'
import type { RegisteredSession } from './registry.js'

const shell = vi.hoisted(() => ({ environment: {} as NodeJS.ProcessEnv }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.environment }))
const roots: string[] = []
const start = 'Tue Oct 6 10:00:00 2026'
const session = (codexHome: string | null = null) => ({
  agentId: 'agent', sessionId: 'conversation', engine: 'codex', codexHome,
  processIdentity: { pid: 78, startMarker: start, executable: 'codex' },
} as RegisteredSession)
function movedHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-readers-')); roots.push(root)
  shell.environment = { CODEX_HOME: root }
  return root
}
afterEach(() => {
  shell.environment = {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('reads live activity from the login shell Codex server, keeping an explicit agent profile', async () => {
  const home = movedHome()
  const connect = vi.fn(async (_home: string) => ({ request: async () => ({ thread: { id: 'conversation', status: { type: 'active' } } }), close: () => {} }))
  const reader = composedCodex({ connect, now: () => 1000,
    rows: async () => [{ ...session().processIdentity!, parentPid: 1, args: 'codex resume conversation' }],
  })
  try {
    expect(await reader.read(session())).toBe('working')
    expect(connect).toHaveBeenLastCalledWith(home)
    await reader.read(session(join(home, 'agent-profile')))
    expect(connect).toHaveBeenLastCalledWith(join(home, 'agent-profile'))
  } finally { reader.close() }
})

it('stops the shared conversation in the login shell Codex home instead of overlooking its server', async () => {
  // Found by QA on a quiet machine: the wrong home can make close report success with work still running.
  const home = movedHome()
  const request = vi.fn(async () => ({ thread: { id: 'conversation', status: { type: 'notLoaded' } } }))
  const connect = vi.fn(async (_home: string) => ({ request, close: () => {} }))
  await composedCodex({
    daemonIdentity: async (path: string) => path === home ? { pid: 90, processStartTime: start } : null,
    rows: async () => [{ pid: 90, parentPid: 1, executable: 'codex', args: 'codex app-server', startMarker: start }],
    connect,
  }).stop(session(), () => true)
  expect(connect).toHaveBeenCalledWith(home)
  expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'conversation' })
})

it('counts the moved-home shared Codex server in Harness Monitor', async () => {
  const home = movedHome()
  mkdirSync(join(home, 'app-server-daemon'))
  writeFileSync(join(home, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: 90, processStartTime: start }))
  const read = createHarnessResourcesReader(() => [session()], {
    now: () => 1000,
    sample: async () => [
      { pid: 78, parent: 1, memoryBytes: 100, cpuMs: 0, start },
      { pid: 90, parent: 1, memoryBytes: 700, cpuMs: 0, start },
    ],
  })
  expect((await read()).shared).toEqual([
    { kind: 'codex', agentIds: ['agent'], memoryBytes: 700, processCount: 1, cpuPercent: null },
  ])
})
