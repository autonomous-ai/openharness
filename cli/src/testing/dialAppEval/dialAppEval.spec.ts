/**
 * Tier A of the dial eval (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier A: replay, in process"): the real devices
 * (services/devices.ts) in this process on virtual time, with the real cable to a loopback dial and the real store readers
 * on fixtures in a temp folder. Only this computer is stood in for: every reader of it is mocked below and answers from
 * the scenario's model of the machine (tierA/machine.ts), so the devices see the scenario's processes and none of the
 * host's.
 *
 * Nothing real is reached. The network guard (netGuard.ts) is the one way this spec refuses the network: installed
 * before any import, a connection to anything but this machine fails, and fails the case it happened in, named by host
 * and port. A child process fails the case too: the devices must start no `claude`, `codex`, `orca`, `open`, `xdg-open`
 * or `ps`. The homes, the stores and the transcripts are throwaway folders.
 */
import { homedir, tmpdir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeGhost, claudeSessions, listed, MAIN, scenario, scenariosFor } from './catalog.js'
import { loadBaseline, tierAVerdict } from './grade.js'
import { describeAttempt } from './netGuard.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from './runner.js'
import { TierADriver } from './tierA/driver.js'
import type { Platform } from './types.js'

// First of all, so no import below opens a connection unguarded.
const guard = await vi.hoisted(async () => (await import('./netGuard.js')).guardThisProcess())
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
// Each read is counted from its call to its end, so the clock moves on only once it lands (tierA/clock.ts).
const counted = vi.hoisted(() => async (real: () => Promise<object>) => (await import('./tierA/clock.js')).countFsCalls(await real()))
vi.mock('node:fs/promises', counted)
vi.mock('fs/promises', counted)
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
/**
 * Tier A runs on a Mac or a Linux host. On a Windows one a platform's store paths flip (a posix path is no path of that
 * host, tierA/storeWatch.ts onHost), a temp folder a reader still holds is EBUSY to remove, and secureState's retries
 * wait in real time (lib/secureState.ts pauseSync): its virtual times would not be the baseline's.
 */
const WINDOWS_HOST = process.platform === 'win32'
/** Every scenario run, in the order run: what the results file holds. */
const runs: ScenarioRun[] = []

beforeEach(() => { reached.length = 0 })
afterEach(() => {
  expect(guard.taken().map(describeAttempt)).toEqual([])
  expect(reached).toEqual([])
})
afterAll(() => {
  const out = process.env.DIAL_EVAL_OUT
  if (out) writeResults(out, 'spec', collect(runs))
  // What was refused after the last case, in the hooks, fails the file.
  try {
    expect(guard.taken().map(describeAttempt)).toEqual([])
  } finally {
    guard.uninstall()
  }
})

describe.skipIf(WINDOWS_HOST).each(PLATFORMS)('tier A on %s', (platform) => {
  it.for(scenariosFor('a', platform))('$id', async (scenario) => {
    const run = await runScenario(new TierADriver({ startDevices }), scenario, platform)
    runs.push(run)
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })
})

describe.skipIf(WINDOWS_HOST)('tier A', () => {
  it('reaches no network: a fetch to example.invalid fails and the guard names it', async () => {
    await expect(fetch('http://example.invalid/')).rejects.toThrow()
    expect(guard.taken().map(describeAttempt)).toEqual(['node net example.invalid:80'])
  })

  it('a voice step whose target the face never shows leaves its scenario ungraded, and says so', async () => {
    // The person turns the dial to b and the step speaks to a: the glass never showed a.
    const voice = scenario({
      id: 'V1', app: 'claude', title: 'Eval voice to a session not on the face', dims: ['D5'], tiers: ['a'],
      sessions: [...claudeSessions(['a', 'b']), claudeGhost],
      steps: [
        { kind: 'claude.write', sessions: ['a', 'b'] },
        ...listed('claude', ['a', 'b']),
        { kind: 'swipe', session: 'b' },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [], probes: [],
    })
    const run = await runScenario(new TierADriver({ startDevices }), voice, 'darwin')
    expect(run.gaps.map((g) => g.reason)).toEqual(['voice step 4: the face never showed a'])
  })

  it('C1 twice gives the same frames, faces, commands and deliveries at the same virtual times', async () => {
    const c1 = MAIN.find((s) => s.id === 'C1')!
    const seen = async () => {
      const driver = new TierADriver({ startDevices })
      await runScenario(driver, c1, 'darwin')
      const { frames, faces, commands, deliveries } = driver.seen()
      return { frames, faces, commands, deliveries }
    }
    const first = await seen()
    const second = await seen()
    expect(first.frames.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
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
