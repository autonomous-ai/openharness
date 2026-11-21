/**
 * Tier A of the dial eval (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier A: replay, in process"): the real devices
 * (services/devices.ts) in this process on virtual time, with the real cable to a loopback dial and the real store readers
 * on fixtures in a temp folder. Only this computer is stood in for: every reader of it is mocked below and answers from
 * the scenario's model of the machine (tierA/machine.ts), so the devices see the scenario's processes and none of the
 * host's.
 *
 * Nothing real is reached. A fetch, a socket to a backend or a child process fails the case: the devices must start no
 * `claude`, `codex`, `orca`, `open`, `xdg-open` or `ps`, and reach no backend. The homes, the stores and the transcripts
 * are throwaway folders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN } from './catalog.js'
import { TierADriver } from './tierA/driver.js'
import { agentIdOf, type Platform, type Scenario, type Seen } from './types.js'

const { machine } = await vi.hoisted(async () => await import('./tierA/machine.js'))

/** What reached past the stand-ins: a fetch, a backend socket or a process started. Each fails the case it happened in. */
const reached = vi.hoisted(() => [] as string[])
/** Every way to start a process, refused and noted. */
const refused = vi.hoisted(() => async (real: () => Promise<Record<string, unknown>>) => {
  const actual = await real()
  const refuse = (name: string) => () => {
    reached.push(name)
    throw new Error(`tier A starts no process (${name})`)
  }
  const starts = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
    .map((name) => [name, refuse(name)]))
  return { ...actual, ...starts, default: { ...(actual.default as object), ...starts } }
})
vi.mock('node:child_process', refused)
vi.mock('child_process', refused)
// The backend's sockets (the devices' lane to the owner's other machines) are `ws`'s: refused and noted, as a fetch is.
vi.mock('ws', async (real) => {
  const actual = await real<Record<string, unknown>>()
  class Refused {
    // The states its callers compare a socket's against.
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    constructor() {
      reached.push('WebSocket')
      throw new Error('tier A opens no socket to a backend')
    }
  }
  return { ...actual, default: Refused, WebSocket: Refused }
})

// The machine's processes, and whether one still runs, from the model. A session's transcript has no stamp there: one
// waiting on the person stays so until its next hook.
vi.mock('../../lib/sessionSearch/externals/support.js', async (real) => ({
  ...await real<typeof import('../../lib/sessionSearch/externals/support.js')>(),
  listProcesses: async () => [...machine.processes.values()].map(({ pid, ppid, executable }) => ({ pid, ppid, executable, args: '' })),
  processAlive: (pid: number) => machine.processes.has(pid),
  fileStamp: async () => null,
}))
// The sessions the machine's processes have open, and their folders and transcripts. Their record is not modelled, and
// a session whose record cannot be read counts as busy, as OpenSessions.busy answers: a turn ends by its own Stop hook.
vi.mock('../../lib/sessionSearch/external.js', async (real) => ({
  ...await real<typeof import('../../lib/sessionSearch/external.js')>(),
  OpenSessions: class {
    async owners() {
      return new Map([...machine.owners].filter(([, owner]) => machine.processes.has(owner.pid))
        .map(([sessionId, { engine, pid }]) => [sessionId, { pid, engine, tty: machine.processes.get(pid)?.tty ?? null, record: sessionId }]))
    }
    async busy() { return true }
  },
  SessionRows: class {
    async find(wanted: ReadonlyMap<string, string>) {
      return new Map([...wanted.keys()].flatMap((sessionId) => {
        const owner = machine.owners.get(sessionId)
        return owner ? [[sessionId, { cwd: owner.cwd, transcriptPath: owner.transcriptPath }] as const] : []
      }))
    }
  },
}))
// Which app each process runs in, the process table and terminals a session's place is read from, and the apps' bundle
// ids: the model's, never this machine's `ps` or `plutil`.
vi.mock('../../cable/hosts/scannedApp.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/scannedApp.js')>(),
  learnApps: async (pids: readonly number[]) => new Map(pids.flatMap((pid) => {
    const app = machine.processes.get(pid)?.app
    return app ? [[pid, app] as const] : []
  })),
  readProcessNames: async () => [...machine.processes.values()].map(({ pid, ppid, executable, tty }) => ({ pid, ppid, executable, ...(tty ? { tty } : {}) })),
  readTtyName: async (pid: number) => machine.processes.get(pid)?.tty,
  readBundleId: async (bundle: string) => machine.bundleIds.get(bundle),
}))
// No folder or socket of this machine is watched: the stores' watch is the world's (tierA/storeWatch.ts), and nothing
// else of the machine changes.
vi.mock('../../cable/hosts/folderWatch.js', () => ({ watchNearest: () => () => {} }))
vi.mock('../../cable/hosts/unixSocket.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/unixSocket.js')>(),
  watchSocket: () => () => {},
}))
// The model's machine has no tmux, Zellij or kitty: no login shell is asked where they are.
vi.mock('../../lib/tmuxOnPath.js', async (real) => ({
  ...await real<typeof import('../../lib/tmuxOnPath.js')>(),
  ensureTmuxOnPath: async () => ({ state: 'absent', reason: 'not on the eval machine' }),
}))
vi.mock('../../cable/hosts/zellij.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/zellij.js')>(),
  zellijFinder: () => async () => ({ state: 'absent', reason: 'not on the eval machine' }),
}))
vi.mock('../../cable/hosts/kitty.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/kitty.js')>(),
  kittyFinder: () => async () => ({ state: 'absent', reason: 'not on the eval machine' }),
}))
// The voice router warms an engine's process: here it warms none, and routes no words.
vi.mock('../../lib/voiceRouter.js', () => ({
  setVoiceRouterSessions: () => {},
  setVoiceRouterDeviceConnected: () => {},
  shutdownVoiceRouter: () => {},
  routeVoiceTask: async () => ({ agentId: '', confidence: 0, reason: 'no router in tier A', needNewAgent: false }),
}))
// Orca's account homes: an Orca that is not there, should anything build its own read of them.
vi.mock('../../devices/orcaHomes.js', async (real) => ({
  ...await real<typeof import('../../devices/orcaHomes.js')>(),
  orcaHomesDeps: () => ({ run: async () => ({ code: null, stdout: '', timedOut: false }), onPath: () => null, exists: () => false, platform: 'linux', uid: 1 }),
}))

const { startDevices } = await import('../../services/devices.js')

const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux']
/** Past the largest half threshold (5 s), as the runner settles after the last step. */
const SETTLE_END_MS = 6_000

beforeEach(() => {
  reached.length = 0
  vi.stubGlobal('fetch', async () => {
    reached.push('fetch')
    throw new Error('tier A reaches no network')
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  expect(reached).toEqual([])
})

const scenario = (id: string): Scenario => {
  const found = MAIN.find((s) => s.id === id)
  if (!found) throw new Error(`the catalog has no ${id}`)
  return found
}

/** A scenario through the driver directly: its steps in order, then the world settled past the last. */
async function run(s: Scenario, platform: Platform): Promise<Seen> {
  const driver = new TierADriver({ startDevices })
  try {
    await driver.start(s, platform)
    for (const step of s.steps) {
      if (step.kind === 'wait') await driver.settle(step.ms)
      else await driver.step(step)
    }
    await driver.settle(SETTLE_END_MS)
  } finally {
    await driver.stop()
  }
  return driver.seen()
}

/** The rows of the last whole list (`agents.begin` to `agents.end`) the dial got while its page was `page`. */
function lastList(seen: Seen, page: string): Array<{ id: unknown; name: unknown }> | undefined {
  let shown = ''
  let rows: Array<{ id: unknown; name: unknown }> | undefined
  let last: typeof rows
  for (const { message } of seen.frames) {
    if (message.t === 'apps') shown = typeof message.shown === 'string' ? message.shown : ''
    else if (message.t === 'agents.begin') rows = []
    else if (message.t === 'agent' && rows) rows.push({ id: message.id, name: message.name })
    else if (message.t === 'agents.end' && rows) {
      if (shown === page) last = rows
      rows = undefined
    }
  }
  return last
}

describe('tier A', () => {
  it.each(PLATFORMS)("C1 on %s: the Claude page's last whole list is the five sessions, newest first, by their titles", async (platform) => {
    const c1 = scenario('C1')
    const seen = await run(c1, platform)
    const five = ['a', 'b', 'c', 'd', 'e'].map((key) => c1.sessions.find((s) => s.key === key)!)
    expect(five.map((s) => s.title)).toEqual(['Eval Alpha', 'Eval Bravo', 'Eval Charlie', 'Eval Delta', 'Eval Echo'])
    expect(lastList(seen, 'claude')).toEqual(five.map((s) => ({ id: agentIdOf(s), name: s.title })))
  })

  it('C1 twice gives the same frames at the same virtual times', async () => {
    const first = await run(scenario('C1'), 'darwin')
    const second = await run(scenario('C1'), 'darwin')
    expect(first.frames.length).toBeGreaterThan(0)
    expect(second.frames).toEqual(first.frames)
  })
})
