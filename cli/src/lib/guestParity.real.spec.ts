/**
 * A guest's harness against an owner's, on a real Mac with guest access: the same program, run in the owner's tmux
 * as the owner and through the guest helper as a guest's own OS user (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
 * A guest's harness runs differently, and each difference broke something on 2026-10-22 that nothing tested: Stop
 * was refused (the owner can neither read nor signal another user's process), and a Claude Code harness was named
 * "Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA" (the helper's `env -i` leaves it no TMUX, so it asked the terminal for graphics).
 *
 * Needs the installed helper (`harness` turns guest access on), its sudoers drop-in, and a guest user already made;
 * it makes none and changes none. Run: `RUN_REAL_GUEST_PARITY=1 npx vitest run src/lib/guestParity.real.spec.ts`.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { GUEST_HELPER_PATH, guestHomeRoot, guestRunCommand } from './guestAccounts.js'
import { guestPaneCommand } from './guestPaneCommand.js'
import { checkPidRuntime } from './deleteAgentFallback.js'
import { processRows } from './processTable.js'
import { registry } from './registry.js'
import { stoppedAgents } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { createStopAgentService } from './stopAgentService.js'
import { TmuxBackend } from './tmuxBackend.js'
import { listPaneTitles } from './tmux.js'

const NODE = '/usr/local/lib/harness/node/bin/node'
const QUERY = 'Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA'
const guestUser = (() => {
  try {
    return readdirSync(guestHomeRoot()).find((name) => /^hg_[0-9a-f]{12}$/.test(name) && existsSync(join(guestHomeRoot(), name, 'work'))) ?? null
  } catch { return null }
})()
const ready = process.env.RUN_REAL_GUEST_PARITY === '1' && process.platform === 'darwin' && existsSync(GUEST_HELPER_PATH)
  && existsSync(NODE) && guestUser !== null
const real = ready ? describe : describe.skip

// What Claude Code does with its terminal, as seen on the shared Mac: it reports what it was given (here, the names of
// its environment), and asks a terminal it believes is not tmux whether it can show images.
const PROBE = [
  "process.stdout.write('ENV ' + JSON.stringify(Object.keys(process.env).sort()) + '\\n')",
  "if (!process.env.TMUX) process.stdout.write('\\x1b_" + QUERY + "\\x1b\\\\')",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

real('a guest\'s harness against an owner\'s', () => {
  let server: IsolatedTmux
  let dir: string
  /** The variables a guest's Claude Code is given (guestPaneCommand). */
  let given: string[] = []
  const panes: Record<'owner' | 'guest', { pane: string; pid: number }> = {} as never
  const work = join(guestHomeRoot(), guestUser ?? '', 'work')

  const pidOf = async (pane: string): Promise<number> => {
    // The pane runs sudo for the guest (four of them, as root); the program is the one below it running the probe.
    // (By its arguments: macOS `ps` cuts the command name to 16 characters, `/usr/local/lib/h`.)
    const root = Number(await server.run('display', '-p', '-t', pane, '#{pane_pid}'))
    return vi.waitFor(async () => {
      const rows = (await processRows()) ?? []
      const below = (pid: number): number[] => rows.filter((r) => r.parentPid === pid).flatMap((r) => [r.pid, ...below(r.pid)])
      const found = [root, ...below(root)].map((pid) => rows.find((r) => r.pid === pid))
        .filter((r) => r && r.executable !== 'sudo' && r.args.includes(join(dir, 'probe.js')))
      if (!found.length) throw new Error(`no program yet below ${root}`)
      return found.at(-1)!.pid
    }, { timeout: 15_000, interval: 200 })
  }
  const userOf = (pid: number): string => execFileSync('ps', ['-o', 'user=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  const envOf = async (pane: string): Promise<string[]> => vi.waitFor(async () => {
    const line = (await server.run('capture-pane', '-p', '-J', '-t', pane)).split('\n').find((l) => l.startsWith('ENV '))
    if (!line) throw new Error('no ENV line yet')
    return JSON.parse(line.slice(4)) as string[]
  }, { timeout: 15_000, interval: 200 })

  beforeAll(async () => {
    server = await isolatedTmux({ PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' })
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('TMUX_TMPDIR', server.root)
    // The guest reads the program from a folder every account may read; the owner's temporary folder is its own.
    dir = mkdtempSync('/tmp/guest-parity-')
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'probe.js'), PROBE, { mode: 0o644 })
    const owner = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'parity', '-x', '200', '-y', '50',
      NODE, join(dir, 'probe.js'))
    // As a guest's Claude Code is started (guestPaneCommand, set on its pane as guestCreate does): the variables it is
    // given, through the helper, as the guest, in the guest's workspace. Only the program is the probe.
    const account = { user: guestUser!, home: join(guestHomeRoot(), guestUser!), workspace: work }
    const env = guestPaneCommand({ account, engine: 'claude', relayUrl: 'http://127.0.0.1:9', token: 'parity', bypassPermission: true }).env
    given = Object.keys(env)
    const guest = guestRunCommand(guestUser!, work, env, [NODE, join(dir, 'probe.js')])
    const guestPane = await server.run('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'parity', '-c', dir,
      ...Object.entries(guest.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), ...guest.argv)
    panes.owner = { pane: owner, pid: await pidOf(owner) }
    panes.guest = { pane: guestPane, pid: await pidOf(guestPane) }
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('runs the guest\'s program as the guest\'s own user, the owner\'s as the owner', async () => {
    expect(userOf(panes.guest.pid)).toBe(guestUser)
    expect(userOf(panes.owner.pid)).toBe(userInfo().username)
  })

  it('tells the owner\'s engine it is in tmux, and the guest\'s nothing of the owner\'s terminal', async () => {
    const owner = await envOf(panes.owner.pane)
    const guest = await envOf(panes.guest.pane)
    // What tmux gives a pane: the owner's engine knows its terminal is tmux, and engines act on it (Claude Code does not
    // ask a tmux pane for graphics). The guest's is started with `env -i`: none of it, by design (the socket path is the
    // owner's). A change to either side shows here, to be decided for guests rather than found on a shared Mac.
    for (const key of ['TMUX', 'TMUX_PANE', 'TERM_PROGRAM']) {
      expect(owner, key).toContain(key)
      expect(guest, key).not.toContain(key)
    }
    // Exactly what it was given (guestPaneCommand: TERM, COLORTERM, LANG, the relay's) and what starting as the guest
    // sets (measured: macOS 26, sudo -u … env -i), and nothing of the owner's.
    const login = ['HOME', 'LOGNAME', 'OLDPWD', 'PATH', 'PWD', 'SHELL', 'SHLVL', 'USER', '__CF_USER_TEXT_ENCODING']
    expect(guest).toEqual([...new Set([...given, ...login])].sort())
    // Known, and the plan's "Turn status": a guest's engine has no Harness hooks yet, so its turns are not reported
    // and its activity reads unknown. Giving it the guest-scoped hook token makes this fail: update it then.
    for (const key of ['HARNESS_HOOK_URL', 'HARNESS_HOOK_TOKEN', 'HARNESS_AGENT_ID']) expect(guest, key).not.toContain(key)
  })

  it('names both harnesses alike: the guest\'s graphics query is not a title', async () => {
    const raw = async (pane: string) => server.run('display', '-p', '-t', pane, '#{pane_title}')
    await vi.waitFor(async () => expect(await raw(panes.guest.pane)).toBe(QUERY), { timeout: 10_000, interval: 200 })
    expect(await raw(panes.owner.pane)).not.toBe(QUERY)
    const titles = await listPaneTitles()
    expect(titles.get(panes.guest.pane), 'the query names nothing').toBeUndefined()
    expect([...titles.values()]).not.toContain(QUERY)
  })

  it('stops both by their panes; only the owner\'s can be signalled', async () => {
    // The owner may signal its own process, and never a guest's: the guest's stop cannot be a signal.
    expect(() => process.kill(panes.owner.pid, 0)).not.toThrow()
    expect(() => process.kill(panes.guest.pid, 'SIGTERM')).toThrow(/EPERM/)
    // The daemon's own Stop on the guest's row, through tmux, as in production (stopAgentService's guest path).
    const row = (await processRows())!.find((r) => r.pid === panes.guest.pid)!
    const agent = registry.openPendingAgent({ engine: 'claude', cwd: work, runtimes: [{ backend: 'tmux', paneId: panes.guest.pane }] })!
    Object.assign(agent, { guest: 'parity@example.com', sessionId: '', processIdentity: { pid: row.pid, executable: row.executable, startMarker: row.startMarker } })
    const backend = new TmuxBackend()
    const stop = createStopAgentService({
      registry, stoppedAgents, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
      backendFor: (runtime) => runtime.backend === 'tmux' ? backend : undefined,
      agentReconciler: { suppress: () => {}, holdRoute: () => {}, releaseRoute: () => {}, trigger: async () => {} },
      forgetSession: (id) => { registry.removeAgent(id) }, markDeleted: () => {}, clearDeleted: () => {},
      stopNative: async () => { throw new Error('a guest\'s engine is not this daemon\'s to unload') },
    })
    await stop(agent.agentId)
    expect((await checkPidRuntime({ engine: 'claude', processIdentity: agent.processIdentity })).state).toBe('gone')
    expect(registry.byAgent(agent.agentId)).toBeUndefined()
    // The owner's harness, its pane closed the same way, leaves as well.
    await server.run('kill-pane', '-t', panes.owner.pane)
    await vi.waitFor(() => expect(() => process.kill(panes.owner.pid, 0)).toThrow(/ESRCH/), { timeout: 10_000, interval: 200 })
  }, 60_000)
})
