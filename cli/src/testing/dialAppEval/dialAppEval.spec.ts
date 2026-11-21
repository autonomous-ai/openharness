/**
 * Tier A of the dial eval (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier A: replay, in process"): the real devices
 * (services/devices.ts) in this process on virtual time, with the real cable to a loopback dial and the real store readers
 * on fixtures in a temp folder. Only this computer is stood in for: every reader of it is mocked below and answers from
 * the scenario's model of the machine (tierA/machine.ts), so the devices see the scenario's processes and none of the
 * host's.
 *
 * Nothing real is reached. The network guard (netGuard.ts) is the one way this spec refuses the network: a connection
 * to anything but this machine fails, and fails the case it happened in, named by host and port. A child process fails
 * the case too: the devices must start no `claude`, `codex`, `orca`, `open`, `xdg-open` or `ps`. The homes, the stores
 * and the transcripts are throwaway folders.
 */
import { homedir, tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN, scenariosFor } from './catalog.js'
import { loadBaseline, tierAVerdict } from './grade.js'
import { describeAttempt, guardThisProcess } from './netGuard.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from './runner.js'
import { TierADriver } from './tierA/driver.js'
import { StepNotBuilt, type Platform, type Seen } from './types.js'

const { machine } = await vi.hoisted(async () => await import('./tierA/machine.js'))

/** The processes started past the stand-ins. Each fails the case it happened in. */
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
/** Every scenario run, in the order run: what the results file holds. */
const runs: ScenarioRun[] = []

let guard: ReturnType<typeof guardThisProcess>
beforeAll(() => { guard = guardThisProcess() })
beforeEach(() => { reached.length = 0 })
afterEach(() => {
  expect(guard.taken().map(describeAttempt)).toEqual([])
  expect(reached).toEqual([])
})
afterAll(() => {
  guard.uninstall()
  const out = process.env.DIAL_EVAL_OUT
  if (out) writeResults(out, 'spec', collect(runs))
})

describe.each(PLATFORMS)('tier A on %s', (platform) => {
  it.for(scenariosFor('a', platform))('$id', async (scenario, { skip }) => {
    let run: ScenarioRun
    try {
      run = await runScenario(new TierADriver({ startDevices }), scenario, platform)
    } catch (error) {
      // A step family not built yet (Task 22 removes this skip).
      if (error instanceof StepNotBuilt) return skip(error.message)
      throw error
    }
    runs.push(run)
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })
})

describe('tier A', () => {
  it('reaches no network: a fetch to example.invalid fails and the guard names it', async () => {
    await expect(fetch('http://example.invalid/')).rejects.toThrow()
    expect(guard.taken().map(describeAttempt)).toEqual(['node net example.invalid:80'])
  })

  it('C1 twice gives the same frames at the same virtual times', async () => {
    const c1 = MAIN.find((s) => s.id === 'C1')!
    const seen = async (): Promise<Seen> => {
      const driver = new TierADriver({ startDevices })
      await runScenario(driver, c1, 'darwin')
      return driver.seen()
    }
    const first = await seen()
    const second = await seen()
    expect(first.frames.length).toBeGreaterThan(0)
    expect(second.frames).toEqual(first.frames)
  })

  // The baseline is written on a Mac and checked on Linux: a result naming this host's folders would differ there.
  it('no result carries an absolute path', () => {
    expect(runs.length).toBeGreaterThan(0)
    const written = JSON.stringify(collect(runs))
    for (const part of [tmpdir(), homedir(), '/work/eval-']) expect(written).not.toContain(part)
  })

  it('matches the baseline', () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierAVerdict(collect(runs), baseline!)
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
