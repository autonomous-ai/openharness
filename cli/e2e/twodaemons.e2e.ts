/**
 * Two daemons on one computer. On 2026-10-03 a dev daemon and the release daemon ran at once and fought
 * over the person's panes. Reproduced here on that code: each opened an agent for every pane the other
 * ran and bound the other's conversations, and an agent stopped in the dev app killed the release
 * daemon's pane.
 *
 * Four ways two daemons meet, and what correct is for each. Throughout: no pane is ever taken from the
 * daemon that owns it, no agent is lost or listed twice, no conversation is bound by two daemons, and a
 * daemon that must not run leaves, saying why.
 *
 * - Dev beside release (another port and data folder; one home and one tmux server): both run, each with
 *   its own agents. Neither opens an agent for the other's pane, binds its conversation or hears its
 *   turns, and a dev restart and a dev agent stopped leave the release daemon's agents as they were.
 * - A second `harness start` while one runs (same data folder): a plain start says the daemon is running
 *   and leaves; a foreground one (a launchd or systemd unit's) leaves at once, naming the daemon it found,
 *   and touches nothing of that daemon's: its pid file, socket, agents, panes and viewers.
 * - Two masters racing for one pid file: one daemon serves and owns the pid file; the other master leaves,
 *   saying why, rather than restarting a core that cannot bind for as long as it lives.
 * - A dev daemon started on the release daemon's port: it serves on a port of its own, as a second OS
 *   user's daemon does, and the release daemon keeps its port, its socket and its agents.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
/** What a daemon lists as running: its agents, by id, pane and conversation. */
const running = async (client: LocalClient) =>
  (await rows(client)).filter((agent) => agent.status !== 'stopped').map((agent) => [agent.id, agent.tmuxPane, agent.sessionId])

async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}

const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
/** The agents a client was told turns of. */
const turnsSeen = (client: LocalClient) =>
  new Set(client.frames.filter((frame) => frame.type === 'turn_started' || frame.type === 'turn_ended').map((frame) => frame.agentId))

/** A pane's root process, or null once the pane is gone: the same pid later means nobody replaced it. */
async function panePid(daemon: IsolatedDaemon, pane: string): Promise<number | null> {
  const line = (await daemon.tmux.run('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}')).split('\n').find((l) => l.startsWith(`${pane} `))
  return line ? Number(line.split(' ')[1]) : null
}

const pidFile = (daemon: IsolatedDaemon) => {
  try { return Number(readFileSync(join(daemon.dataDir, 'adapter.pid'), 'utf8').trim()) || null } catch { return null }
}
const status = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as Record<string, any>

/** Run the CLI of this checkout with a daemon's environment, as a person (or a unit file) would. */
function cli(daemon: IsolatedDaemon, args: string[], ms = 90_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: CLI_ROOT, env: daemon.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`harness ${args.join(' ')} did not end within ${ms} ms:\n${output.slice(-3000)}`)) }, ms)
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}

describe('two daemons on one computer', () => {
  const daemons: IsolatedDaemon[] = []
  const strays: number[] = []
  afterEach(async () => {
    // The daemons beside the first go first: the first owns the tmux server they share.
    for (const daemon of daemons.reverse()) await daemon.close()
    daemons.length = 0
    for (const pid of strays.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  })
  const make = async (name: string, options: Parameters<typeof IsolatedDaemon.create>[0] = {}) => {
    const daemon = await IsolatedDaemon.create(options)
    daemons.push(daemon)
    onTestFailed(() => { console.log(`---- ${name} log\n${daemon.log().split('\n').slice(-100).join('\n')}`) })
    return daemon
  }

  it('a dev daemon beside the release one: each keeps its own agents, panes, conversations and turns', async () => {
    const release = await make('release')
    const dev = await make('dev', { beside: release })
    await release.start()
    const atRelease = await LocalClient.connect(release)
    const ours = await create(release, atRelease, 'claude', 'release-claude')
    await dev.start()
    let atDev = await LocalClient.connect(dev)
    const theirs = await create(dev, atDev, 'codex', 'dev-codex')
    const oursPid = await panePid(release, ours.tmuxPane)
    // Two reconcile passes on each (TERMINAL_RECONCILE_INTERVAL_MS is 5 s here): time enough for either to
    // open an agent for the other's pane, as both did on 2026-10-03.
    await sleep(12_000)
    expect(await running(atRelease)).toEqual([[ours.id, ours.tmuxPane, ours.sessionId]])
    expect(await running(atDev)).toEqual([[theirs.id, theirs.tmuxPane, theirs.sessionId]])

    // A turn on each through its own daemon, at once: neither daemon tells its app of the other's turn.
    await Promise.all([turn(atRelease, ours.id, 'a release turn'), turn(atDev, theirs.id, 'a dev turn')])
    expect([...turnsSeen(atRelease)]).toEqual([ours.id])
    expect([...turnsSeen(atDev)]).toEqual([theirs.id])

    // A dev daemon restarts often. Back, it still keeps to its own.
    atDev.close()
    await dev.restart()
    atDev = await LocalClient.connect(dev)
    await until('the dev agent to be back', async () => (await row(atDev, theirs.id))?.status === 'active' || null, 60_000, 500)
    await sleep(6_000)
    expect(await running(atDev)).toEqual([[theirs.id, theirs.tmuxPane, theirs.sessionId]])

    // The dev agent stopped: its pane goes; the release agent's pane is the same process it was.
    expect((await atDev.request('agent_delete', { agentId: theirs.id }, 60_000)).error).toBeUndefined()
    await until('the dev agent\'s pane to go', async () => (await panePid(dev, theirs.tmuxPane)) === null || null, 30_000, 250)
    await sleep(6_000)
    expect(await panePid(release, ours.tmuxPane)).toBe(oursPid)
    expect(await running(atRelease)).toEqual([[ours.id, ours.tmuxPane, ours.sessionId]])
    await turn(atRelease, ours.id, 'still the release daemon\'s')
    atRelease.close()
    atDev.close()
  })

  it('a dev daemon beside the release one: each daemon\'s agents\' hooks reach that daemon, whichever installed the hooks last', async () => {
    // A computer has one Claude Code hook entry and one Codex hook entry, and each daemon writes its own
    // port into them as it starts. The dev daemon, started second, took every hook: the release daemon's
    // agents' hooks went to it, it turned them away (not its panes), and the release daemon never heard
    // their session starts, prompts or turn ends. Each daemon now records where it listens under its pane
    // tag, and the hook goes to the daemon that made its pane (lib/hookRoutes.ts, notify.mjs).
    const release = await make('release')
    const dev = await make('dev', { beside: release })
    await release.start()
    await dev.start()
    const installed = () => [join(release.env.HOME!, '.claude', 'settings.json'), join(release.env.CODEX_HOME!, 'hooks.json')]
      .map((file) => readFileSync(file, 'utf8'))
    // The precondition of the incident: the entries every engine started from here on runs are the dev daemon's.
    for (const file of installed()) expect(file).toContain(`--port ${dev.port} `)

    const atRelease = await LocalClient.connect(release)
    const atDev = await LocalClient.connect(dev)
    const agents = {
      release: [await create(release, atRelease, 'claude', 'release-claude'), await create(release, atRelease, 'codex', 'release-codex')],
      dev: [await create(dev, atDev, 'claude', 'dev-claude'), await create(dev, atDev, 'codex', 'dev-codex')],
    }
    await Promise.all([
      ...agents.release.map((agent) => turn(atRelease, agent.id, 'a release turn')),
      ...agents.dev.map((agent) => turn(atDev, agent.id, 'a dev turn')),
    ])
    const heard = (daemon: IsolatedDaemon, agent: Row, event: string) => daemon.log().includes(`[hooks] ${String(agent.sessionId).slice(0, 8)} ${event}`)
    const reachedOnlyItsOwn = async (mine: IsolatedDaemon, other: IsolatedDaemon, agent: Row, engine: Engine) => {
      // Claude Code's prompt and turn-end hooks, Codex's session start and prompt (lib/hooks.ts installs no more).
      for (const event of engine === 'claude' ? ['UserPromptSubmit', 'turn-stop'] : ['SessionStart', 'UserPromptSubmit']) {
        await until(`${engine} ${agent.id}'s ${event} hook at its own daemon`, () => heard(mine, agent, event), 20_000, 250)
      }
      expect(other.log(), 'the other daemon heard none of its hooks').not.toContain(`[hooks] ${String(agent.sessionId).slice(0, 8)}`)
      expect(other.log(), 'the other daemon turned none of its hooks away').not.toContain(`hints=tmux:${agent.tmuxPane} `)
    }
    for (const [mine, other, [claude, codex]] of [[release, dev, agents.release], [dev, release, agents.dev]] as const) {
      await reachedOnlyItsOwn(mine, other, claude, 'claude')
      await reachedOnlyItsOwn(mine, other, codex, 'codex')
    }

    // And the other way round: restarted, the release daemon owns the entries; a new dev agent reaches dev.
    atRelease.close()
    await release.restart()
    for (const file of installed()) expect(file).toContain(`--port ${release.port} `)
    const later = await create(dev, atDev, 'claude', 'dev-later')
    await turn(atDev, later.id, 'a dev turn after the release daemon restarted')
    await reachedOnlyItsOwn(dev, release, later, 'claude')
    atDev.close()
  }, 240_000)

  it('a routes path that is a regular file leaves the daemon serving its own installed hooks', async () => {
    // Found by QA on a quiet machine: a routing warning must not become a startup failure in cleanup.
    const d = await make('route-unavailable', { noMaster: true })
    d.env.HARNESS_HOOK_ROUTES_DIR = join(d.root, 'blocked-routes')
    writeFileSync(d.env.HARNESS_HOOK_ROUTES_DIR, 'not a folder')
    await d.start()
    expect(d.log()).toContain('could not record this daemon\'s hook route')
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'route-unavailable')
    await turn(client, agent.id, 'the installed command still names this daemon')
    await until('the hook at the installed command\'s daemon', () =>
      d.log().includes(`[hooks] ${String(agent.sessionId).slice(0, 8)} UserPromptSubmit`), 20_000)
    expect(readFileSync(d.env.HARNESS_HOOK_ROUTES_DIR, 'utf8')).toBe('not a folder')
    client.close()
  })

  it('a second harness start while one runs leaves it alone; a foreground one leaves at once, touching nothing', async () => {
    const daemon = await make('running')
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    const agent = await create(daemon, client, 'claude', 'already-running')
    const before = { master: daemon.pid, core: daemon.corePid(), pidFile: pidFile(daemon), pane: await panePid(daemon, agent.tmuxPane) }
    expect(before.pidFile).toBe(daemon.pid)
    // A viewer the running daemon started for a harness agent (dsh/viewerLedger.ts), as its ledger records
    // it: a duplicate daemon must not take it for an orphan of a daemon that died.
    const viewer = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    strays.push(viewer.pid!)
    await sleep(1_000)
    writeFileSync(join(daemon.dataDir, 'viewers.json'), JSON.stringify([{ pid: viewer.pid, startedAt: Date.now() - 1_000, agentId: agent.id, dshId: 'acme/viewer', viewerDir: '/nowhere' }]))

    const plain = await cli(daemon, ['start'])
    expect(plain.output).toContain(`machine already running (pid ${daemon.pid})`)
    expect(plain.code).toBe(0)

    const foreground = await cli(daemon, ['start', '--foreground'])
    expect(foreground.code, foreground.output).not.toBe(0)
    expect(foreground.output).toMatch(/already serving .*daemon-\d+\.sock/)
    // It left before it did anything: no restore, no services, no reaped viewers.
    expect(foreground.output).not.toMatch(/\[discovery\]|\[restore\]|\[dsh\] reaped|\[services\]/)
    expect(IsolatedDaemon.alive(viewer.pid!), 'the running daemon\'s viewer').toBe(true)

    // The running daemon is as it was: its master, core, pid file, socket, agent and pane.
    expect({ master: daemon.pid, core: daemon.corePid(), pidFile: pidFile(daemon), pane: await panePid(daemon, agent.tmuxPane) }).toEqual(before)
    expect(existsSync(join(daemon.dataDir, 'adapter.safe-mode'))).toBe(false)
    expect(await running(client)).toEqual([[agent.id, agent.tmuxPane, agent.sessionId]])
    await turn(client, agent.id, 'after two starts')
    expect(daemon.coresStarted()).toBe(1)
    client.close()
  })

  it('two masters racing for one pid file: one daemon serves, and the other master leaves saying why', async () => {
    const first = await make('first', { env: { HARNESSD_INITIAL_BACKOFF_MS: '200' } })
    const second = await make('second', { beside: first, dataDir: first.dataDir, port: first.port, env: { HARNESSD_INITIAL_BACKOFF_MS: '200' } })
    await Promise.all([first.start({ ready: 'none' }), second.start({ ready: 'none' })])
    await until('a daemon to serve', async () => {
      const ok = (await fetch(`http://127.0.0.1:${first.port}/api/health`).catch(() => null))?.ok
      return ok && existsSync(first.socketPath) && pidFile(first) ? true : null
    }, 90_000, 200)
    const winner = [first, second].find((daemon) => daemon.pid === pidFile(first))
    expect(winner, `the pid file names ${pidFile(first)}; the masters are ${first.pid} and ${second.pid}`).toBeDefined()
    const loser = winner === first ? second : first
    await until('the losing master to leave', () => loser.child === null || null, 60_000, 250)
    expect(loser.log()).toMatch(/another daemon|already serving/)
    expect(loser.log()).toMatch(/\[harnessd\] core stopped for good/)
    await until('the winner to finish starting', () => /\[cli\] ready/.test(winner!.log()) || null, 60_000, 200)

    // One daemon, and it is the one the pid file names: its master and core answer, the loser's core is gone.
    expect(pidFile(first)).toBe(winner!.pid)
    const answer = await status(first.port)
    expect([answer.pid, answer.corePid]).toEqual([winner!.pid, winner!.corePid()])
    expect(IsolatedDaemon.alive(loser.corePid())).toBe(false)
    expect(existsSync(join(first.dataDir, 'adapter.safe-mode'))).toBe(false)
    const client = await LocalClient.connect(winner!)
    const agent = await create(winner!, client, 'codex', 'after-the-race')
    await turn(client, agent.id, 'one daemon')
    expect(await running(client)).toEqual([[agent.id, agent.tmuxPane, agent.sessionId]])
    expect(winner!.coresStarted()).toBe(1)
    client.close()
  })

  it('a master started again while the core of the one that died still serves waits for that core to leave; another live daemon is still refused', async () => {
    // What launchd or systemd does when a master dies: the same master again, at once, while its old core
    // has yet to notice and stop. Stood in for by a socket that answers as such a core does: its master's
    // pid, long gone, and its own. Refused, the new core exited for good, its master with it, cleanly,
    // and neither platform starts a clean exit again: the daemon stayed down until the next login.
    const gone = 2_000_000_000
    const restarted = await make('restarted', { env: { HARNESSD_INITIAL_BACKOFF_MS: '200' } })
    const orphan = createServer((_req, res) => res.end(JSON.stringify({ pid: gone, corePid: process.pid })))
    await new Promise<void>((resolve) => orphan.listen(restarted.socketPath, resolve))
    setTimeout(() => orphan.close(), 3_000)
    await restarted.start({ ready: 'none' })
    await until('the new core to finish starting', () => /\[cli\] ready/.test(restarted.log()) || null, 90_000, 200)
    expect(restarted.log()).toContain(`of a master that is gone (pid ${gone}) — waiting for it to leave`)
    expect(restarted.log()).not.toMatch(/core stopped for good/)
    const client = await LocalClient.connect(restarted)
    const agent = await create(restarted, client, 'claude', 'after-the-orphan')
    await turn(client, agent.id, 'served once the old core left')
    client.close()

    // A daemon that answers for itself, with no master that is gone, is another daemon: refused at once.
    const refused = await make('refused', { env: { HARNESSD_INITIAL_BACKOFF_MS: '200' } })
    const live = createServer((_req, res) => res.end(JSON.stringify({ pid: process.pid, corePid: process.pid })))
    await new Promise<void>((resolve) => live.listen(refused.socketPath, resolve))
    try {
      await refused.start({ ready: 'none' })
      await until('the refused master to leave', () => refused.child === null || null, 60_000, 250)
      expect(refused.log()).toMatch(/\[harnessd\] core stopped for good/)
      expect(refused.log()).not.toMatch(/waiting for it to leave/)
    } finally {
      await new Promise((resolve) => live.close(resolve))
    }
  })

  it('a dev daemon started on the release daemon\'s port takes another, and the release daemon keeps its own', async () => {
    const release = await make('release')
    const dev = await make('dev', { beside: release, port: release.port })
    await release.start()
    const atRelease = await LocalClient.connect(release)
    const ours = await create(release, atRelease, 'claude', 'release-claude')
    const oursPid = await panePid(release, ours.tmuxPane)
    await dev.start()
    expect(dev.log()).toContain(`[hooks] control port ${release.port} unavailable; assigning a separate port`)
    const devPort = JSON.parse(readFileSync(join(dev.dataDir, `daemon-${release.port}.json`), 'utf8')).port as number
    expect(devPort).not.toBe(release.port)
    // The release daemon still answers on its port, as itself.
    const answer = await status(release.port)
    expect([answer.pid, answer.corePid]).toEqual([release.pid, release.corePid()])
    expect((await status(devPort)).corePid).toBe(dev.corePid())

    // Each runs its own agents, and only its own.
    const atDev = await LocalClient.connect(dev)
    const theirs = await create(dev, atDev, 'codex', 'dev-codex')
    await sleep(12_000)
    expect(await running(atRelease)).toEqual([[ours.id, ours.tmuxPane, ours.sessionId]])
    expect(await running(atDev)).toEqual([[theirs.id, theirs.tmuxPane, theirs.sessionId]])
    await Promise.all([turn(atRelease, ours.id, 'release'), turn(atDev, theirs.id, 'dev')])
    expect(await panePid(release, ours.tmuxPane)).toBe(oursPid)
    expect(release.coresStarted()).toBe(1)
    atRelease.close()
    atDev.close()
  })
})
