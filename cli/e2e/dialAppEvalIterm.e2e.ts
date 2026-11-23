/**
 * Tier B of the dial eval for iTerm2 (docs/plans/2026-11-22-dial-eval-iterm2-design.md, "Tier B"). Its harness first: a
 * fake iTerm2 whose tabs run under its server (harness/outsideAgent.ts), relaunched keeping them, and a herdr of the test's
 * own started by its first client in one of those tabs (harness/herdrServer.ts), so no walk from a herdr pane reaches this
 * worker, and so the developer's terminal, before the fake iTerm2.
 *
 * macOS only, as iTerm2. Never the person's iTerm2, herdr, daemon or dial, and no `osascript`: the fake iTerm2's bundle
 * and its server are in the daemon's throwaway home, herdr's config is in it too, and the daemon's table holds no herdr
 * outside this worker's tree (ownHerdrsOnly). Each process read is one of this test's own, alone, by its pid
 * (`ps -o ppid=,comm= -p`): never another process's environment, argv or the whole table's command lines.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'
import { herdrBinary, ownHerdrsOnly, PrivateHerdr } from './harness/herdrServer.js'
import { closeTab, openTab, relaunchIterm, tabUnder } from './harness/outsideAgent.js'

const execFileAsync = promisify(execFile)
const MAC = process.platform === 'darwin'

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

const gone = (pid: number): boolean => {
  try { process.kill(pid, 0) } catch { return true }
  return false
}
const inside = (root: string, path: string): boolean => isAbsolute(path) && !relative(root, path).startsWith('..')

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
  /** The fake iTerm2's executable in its bundle, and its server, both in the daemon's home. */
  const iterm = (d: IsolatedDaemon) => ({
    app: join(d.env.HOME!, 'Applications', 'iTerm.app', 'Contents', 'MacOS', 'iTerm2'),
    server: join(d.env.HOME!, 'Library', 'Application Support', 'iTerm2', 'iTermServer-3.6.6'),
  })

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
