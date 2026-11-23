/**
 * Tier B of the dial eval for iTerm2 (docs/plans/2026-11-22-dial-eval-iterm2-design.md, "Tier B"). Its harness first: a
 * fake iTerm2 whose tabs run under its server (harness/outsideAgent.ts), relaunched keeping them, and a herdr of the test's
 * own started by its first client in one of those tabs (harness/herdrServer.ts), so no walk from a herdr pane reaches this
 * worker, and so the developer's terminal, before the fake iTerm2. Then each main scenario of the catalog for iTerm2, on
 * the real daemon and devices process, through the tier B driver (harness/appEvalDriver.ts) and iTerm2's steps
 * (harness/appEvalIterm.ts): Claude Code in the fake iTerm2's tabs, in tmux on the daemon's private server and in that
 * herdr, and the real `harness hardware watch` told the person's tabs.
 *
 * macOS only, as iTerm2. Never the person's iTerm2, tmux server, herdr, daemon or dial, and no `osascript`: the fake
 * iTerm2's bundle and its server are in the daemon's throwaway home, herdr's config is in it too, tmux's socket is in its
 * root, and the daemon's table holds no herdr outside this worker's tree or this daemon's own fake iTerm2 server
 * (ownHerdrsOnly). What the harness reads of processes: of its own, by pid, their parent, start time, path (`comm`) and
 * tty, the herdr client's child named herdr (`pgrep -P -x`) and that server's sockets (`lsof -p`); of the whole table,
 * each one's pid, parent and path, to tell this worker's herdrs from the rest (othersNow, ownHerdrsOnly), and pid and
 * parent alone, to find the devices again after their restart; and, as at every tier B scenario's cost and every
 * daemon's close, each one's command line and working folder, matched against the daemon's root, only those under it
 * kept (appEvalCost.ts, testing/rootProcesses.ts). Never another process's environment. The network guard runs in this
 * process and in every process of each daemon.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'
import { scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import { itermPlaceOf } from '../src/testing/dialAppEval/types.js'
import { inside, TierBDriver } from './harness/appEvalDriver.js'
import { itermSteps } from './harness/appEvalIterm.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { herdrBinary, othersNow, ownHerdrsOnly, PrivateHerdr } from './harness/herdrServer.js'
import { closeTab, gone, itermServerPath, openTab, relaunchIterm, tabUnder } from './harness/outsideAgent.js'

const execFileAsync = promisify(execFile)
const MAC = process.platform === 'darwin'
const SCENARIOS = MAC ? scenariosFor('b', 'darwin').filter((s) => s.app === 'iterm' && !s.heldOut) : []
/** A conversation of the fake Claude Code's, made up. */
const CONVERSATION = '00000000-0000-4000-8e00-0000000000e1'
const runs: ScenarioRun[] = []

// At file level, so a host that skips every case still writes it: the eval command reads one results file a source (the
// plan's Decision 16), empty off macOS.
afterAll(() => {
  if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'iterm', collect(runs))
})

/** A process of this test's: its parent and the path it was started from (macOS's `comm`); undefined once it is gone. */
const processOf = async (pid: number): Promise<{ pid: number; ppid: number; comm: string } | undefined> => {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)])
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
  const row = /^\s*(\d+)\s+(.*?)\s*$/.exec(stdout)
  return row ? { pid, ppid: Number(row[1]), comm: row[2] } : undefined
}

/** [pid] and its parents, nearest first, up to the last before this worker or launchd: neither is read. */
const parents = async (pid: number): Promise<Array<{ pid: number; ppid: number; comm: string }>> => {
  const chain = []
  for (let at = pid; at > 1 && at !== process.pid && chain.length < 32;) {
    const row = await processOf(at)
    if (!row) break
    chain.push(row)
    at = row.ppid
  }
  return chain
}

/** The fake iTerm2's executable in its bundle, and its server, both in the daemon's home. */
const iterm = (d: IsolatedDaemon) => ({
  app: join(d.env.HOME!, 'Applications', 'iTerm.app', 'Contents', 'MacOS', 'iTerm2'),
  server: itermServerPath(d),
})

describe.skipIf(!MAC)('the dial eval, tier B: the fake iTerm2 and herdr started from its tab', () => {
  const closing: Array<() => Promise<void>> = []
  afterEach(async () => {
    // Last opened, first closed: tabs and herdr before the daemon, whose close sweeps what names its root.
    for (const close of closing.splice(0).reverse()) await close()
  })

  const daemon = async (): Promise<IsolatedDaemon> => {
    const d = await IsolatedDaemon.create()
    closing.push(() => d.close())
    return d
  }

  it("a tab of the fake iTerm2 runs its command under iTerm2's server, whose parent is the fake iTerm2, and the server is inside the daemon's home", async () => {
    const d = await daemon()
    const { app, server } = iterm(d)
    expect(inside(d.env.HOME!, app)).toBe(true)
    expect(inside(d.env.HOME!, server)).toBe(true)

    // A client's tab (tabUnder): the command on the tab's pseudo-terminal, its helper, iTerm2's server, the fake iTerm2.
    const client = await tabUnder(d, 'iterm', ['/bin/cat'], d.env)
    closing.push(() => client.close())
    const clientChain = await parents(client.pid)
    expect(clientChain.map((p) => p.comm)).toEqual(['/bin/cat', expect.any(String), server, app])
    expect(clientChain.at(-1)).toMatchObject({ pid: client.appPid, ppid: process.pid })
    // The bundle names iTerm2 by its id.
    expect(readFileSync(join(dirname(dirname(app)), 'Info.plist'), 'utf8')).toContain('<string>com.googlecode.iterm2</string>')

    // A shell's tab (openTab): its shell between the command and the helper.
    const shell = await openTab(d, d.env.HOME!, d.env, ['/bin/cat'], { app: 'iterm', shell: true })
    closing.push(() => closeTab(shell, 'the shell tab'))
    const shellChain = await parents(shell.pid)
    expect(shellChain.map((p) => p.comm)).toEqual(['/bin/cat', '/bin/sh', expect.any(String), server, app])
    expect(shellChain.at(-1)).toMatchObject({ pid: shell.appPid, ppid: process.pid })
  })

  it("once the fake iTerm2 ends its server is launchd's child and the tab's command runs on", async () => {
    const d = await daemon()
    const { server } = iterm(d)
    const tab = await tabUnder(d, 'iterm', ['/bin/cat'], d.env)
    closing.push(() => tab.close())
    const before = await parents(tab.pid)
    const app = before.at(-1)!.pid
    expect(app).toBe(tab.appPid)

    await relaunchIterm(tab)
    expect(gone(app)).toBe(true)
    const after = await parents(tab.pid)
    expect(after.map((p) => p.comm)).toEqual(['/bin/cat', expect.any(String), server])
    expect(after.map((p) => p.pid)).toEqual(before.slice(0, 3).map((p) => p.pid))
    expect(after.at(-1)!.ppid).toBe(1)

    // Closed, nothing of it runs on: the server, launchd's now, ends with its tab.
    closing.pop()
    await tab.close()
    expect(gone(after.at(-1)!.pid)).toBe(true)
    expect(gone(tab.pid)).toBe(true)
  })

  describe.skipIf(!herdrBinary)('herdr', () => {
    /** A daemon whose table holds no herdr outside this worker's tree, with Claude Code's hooks in. */
    const started = async (): Promise<IsolatedDaemon> => {
      const d = await daemon()
      ownHerdrsOnly(d)
      onTestFailed(() => {
        console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
        console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
      })
      await d.start()
      // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
      await d.hooksInstalled(['claude'])
      return d
    }
    const herdrIn = async (d: IsolatedDaemon) => {
      const herdr = await PrivateHerdr.startIn(d, 'iterm')
      closing.push(() => herdr.stop())
      return herdr
    }
    /** The fake Claude Code's process whose SessionStart hook ran for [sessionId] as [source] says. */
    const agentPid = (d: IsolatedDaemon, sessionId: string, source = 'startup'): number =>
      Number(d.hookLog().match(new RegExp(`claude pid=(\\d+) SessionStart\\(${source}\\) session=${sessionId} ran`))![1])

    it("herdr started from a fake iTerm2 tab runs its server under that client, and a hooked pane's agent's parents reach the fake iTerm2 and never this worker", async () => {
      const d = await started()
      const herdr = await herdrIn(d)
      expect(inside(d.root, herdr.socket)).toBe(true)
      // The server is the client's child, the client the tab's command.
      const server = await processOf(herdr.pid)
      expect(server).toMatchObject({ ppid: herdr.tab.pid })
      expect(basename(server!.comm)).toBe('herdr')
      expect(herdr.tab.tty).toMatch(/^\/dev\/ttys\d+$/)

      const agent = await herdr.hooked('in-herdr')
      const chain = await parents(agentPid(d, agent.sessionId))
      const pids = chain.map((p) => p.pid)
      expect(pids).toContain(herdr.pid)
      expect(pids.indexOf(herdr.tab.pid)).toBeGreaterThan(pids.indexOf(herdr.pid))
      // The walk reaches this worker only past the fake iTerm2, its server before it.
      expect(chain.at(-1)).toMatchObject({ pid: herdr.tab.appPid, comm: iterm(d).app })
      expect(chain.at(-2)).toMatchObject({ comm: iterm(d).server })
    })

    it("a pane's session reported to herdr is in its agent.list row", async () => {
      const d = await started()
      const herdr = await herdrIn(d)
      const agent = await herdr.hooked('reported')
      await herdr.reportSession(agent.pane, agent.sessionId)
      const { agents } = await herdr.rpc('agent.list') as { agents: Array<{ pane_id: string; agent_session?: unknown }> }
      expect(agents.find((row) => row.pane_id === agent.pane)?.agent_session)
        .toMatchObject({ source: 'herdr:claude', agent: 'claude', value: agent.sessionId })
    })

    // herdr tells an agent by its process's argv[0] whole: `claude --resume <id>` there must still read `claude`. Its first
    // agent's pane it finds by another way, so this one is its second.
    it("a pane's Claude Code going on in its conversation is herdr's agent, and its session reported is in its row", async () => {
      const d = await started()
      const herdr = await herdrIn(d)
      await herdr.hooked('first')
      const agent = await herdr.hooked('resumed', { resume: CONVERSATION })
      await herdr.reportSession(agent.pane, agent.sessionId)
      const { agents } = await herdr.rpc('agent.list') as { agents: Array<{ pane_id: string; agent: string; agent_session?: unknown }> }
      expect(agents.find((row) => row.pane_id === agent.pane)).toMatchObject({ agent: 'claude', agent_session: { value: CONVERSATION } })
    })

    it("herdr started again in a new tab goes on in a pane's conversation, and stopped leaves no tab", async () => {
      const d = await started()
      const first = await herdrIn(d)
      const agent = await first.hooked('again')
      closing.pop()
      await first.stop()
      for (const pid of [first.pid, first.tab.pid, first.tab.appPid!]) expect(gone(pid)).toBe(true)

      const second = await herdrIn(d)
      const resumed = await second.hooked('again', { resume: agent.sessionId })
      expect(resumed.sessionId).toBe(agent.sessionId)
      // In a pane of the new server, whose client runs in the new tab.
      const pids = (await parents(agentPid(d, agent.sessionId, 'resume'))).map((p) => p.pid)
      expect(pids).toEqual(expect.arrayContaining([second.pid, second.tab.pid, second.tab.appPid]))
    })
  })
})

describe.skipIf(!MAC)('the dial eval, tier B: iTerm2', () => {
  let driver: TierBDriver
  beforeAll(() => { driver = new TierBDriver({ iterm: itermSteps }) })
  afterAll(async () => {
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })
  /** What a scenario's run proves beside its checks, read from its world as it stopped. */
  const ALSO: Partial<Record<string, (run: ScenarioRun) => void>> = {
    I2: () => {
      const { d } = driver.lastWorld()
      // The devices' tmux is the recording wrapper in the root, run on the root's TMUX_TMPDIR with no TMUX, and none of
      // its runs names a server of its own: each reached the daemon's private server.
      expect(inside(d.root, resolveBinaryOnPath('tmux', d.env) ?? undefined)).toBe(true)
      expect([d.env.TMUX_TMPDIR, d.env.TMUX ?? '']).toEqual([d.tmux.root, ''])
      const tmux = driver.seen().commands.filter((c) => c.argv[0] === 'tmux')
      expect(tmux).not.toEqual([])
      expect(tmux.filter((c) => c.argv.some((arg) => arg === '-S' || arg === '-L'))).toEqual([])
      // herdr was on the daemon's PATH as its dial came, so herdr's own source listed both its agents.
      expect(d.log()).toContain('[herdr] listed · 2 agents')
    },
    I5: (run) => {
      const selects = (driver.seen().streams ?? []).filter((l) => l.window === 'tabs' && l.line.type === undefined).map((l) => l.line)
      expect(selects).toContainEqual({ app: 'iterm', tab: 'w1.1.0', raise: true })
      expect(JSON.stringify([run.results, run.probes])).not.toMatch(/\/dev\/|ttys[0-9]/)
    },
    // b's client detached, its tab stays open on its shell, as the person's does and tier A's: no tab opened after takes
    // its tty, so the tap's select, for the tab b's start looked up, names that tab every run, never the new client's.
    I13: () => {
      const selects = (driver.seen().streams ?? []).filter((l) => l.window === 'tabs' && l.line.type === undefined).map((l) => l.line)
      expect(selects).toEqual([{ app: 'iterm', tab: 'w1.1.0', raise: true }])
    },
    // The Claude mod polled in tmux before the voice, so its words came by the mod, to b alone.
    I19: () => {
      expect(driver.seen().deliveries.filter((d) => d.path === 'mod').map(({ target, text }) => ({ target, text })))
        .toEqual([{ target: 'b', text: 'Eval words for bravo.' }])
    },
  }

  it.for(SCENARIOS)('$id: $title', async (scenario, { skip }) => {
    // herdr's scenarios need herdr and the cc that builds its agent, as the harness's own herdr cases do.
    if (!herdrBinary && scenario.sessions.some((s) => itermPlaceOf(s) === 'herdr')) skip()
    const before = othersNow()
    const began = Date.now()
    const run = await runScenario(driver, scenario, 'darwin')
    // Kept before any assertion, so a scenario that fails one is still in the results and the baseline's verdict.
    runs.push(run)
    expect(run.error).toBeUndefined()
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    const { d, herdrs } = driver.lastWorld()
    for (const path of [d.env.HOME, d.env.HARNESS_OPEN_BIN, iterm(d).server, d.env.TMUX_TMPDIR, join(d.env.HOME!, '.config', 'herdr'),
      ...herdrBinary ? [resolveBinaryOnPath('herdr', d.env) ?? undefined] : []]) {
      expect(inside(d.root, path), path).toBe(true)
    }
    // The herdrs outside this worker, the person's among them: the daemon's table kept none, and each it dropped that
    // still runs is one of them. A herdr that ended since, the test's own once iTerm2 relaunched among them, runs no more.
    const others = [...before, ...othersNow()]
    expect(herdrs.kept().filter((pid) => others.includes(pid))).toEqual([])
    expect(herdrs.dropped().filter((pid) => !others.includes(pid) && !gone(pid))).toEqual([])
    ALSO[scenario.id]?.(run)
    expect(driver.networkReached()).toEqual([])
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })

  // The eval command judges the ratchet itself, over every file's results (run.ts).
  it.skipIf(process.env[SKIP_RATCHET_ENV] === '1')("matches this platform's baseline", () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierBVerdict(collect(runs), baseline!, 'darwin')
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
