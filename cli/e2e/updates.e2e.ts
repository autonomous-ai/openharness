/**
 * Engines updated in place, for Claude Code and Codex. Both update themselves while agents run, Claude
 * Code nearly every day: the file on disk is replaced under a running process, a release can drop a
 * flag the daemon passes, the engine can be uninstalled and installed again, and its first start after
 * an update can be slow. A running agent must go on working through all of it; a restart or a new agent
 * must run what is on disk now, or fail quickly with a reason the window gets; and none of it may need
 * the daemon itself restarted.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>
const engines: Engine[] = ['claude', 'codex']

/** A release of the fake engine, as e2e/harness/fakeEngine.mjs reads it from its config. */
interface Release { version?: string; without?: string[]; startDelayMs?: number; updateAvailable?: string }
/** OLD is what the fake engines report unless told otherwise (fakeEngine.mjs); NEW is the next release. */
const OLD: Record<Engine, string> = { claude: '2.1.270', codex: '0.160.0' }
const NEW: Record<Engine, string> = { claude: '2.1.271', codex: '0.161.0' }
const versionLine = (engine: Engine, version: string) => engine === 'claude' ? `${version} (Claude Code)` : `codex-cli ${version}`
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * Installs a release over the engine the way an updater does: the new file is written beside the old one
 * and renamed over it, so a process already running keeps the file it started from and the next launch
 * gets the new one. The config is the one IsolatedDaemon gave the engine, plus the release.
 */
function install(d: IsolatedDaemon, engine: Engine, release: Release = {}): void {
  const config = { ...d.engineConfig, ...release }
  const module = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
  const wrapper = join(d.root, 'bin', engine)
  writeFileSync(`${wrapper}.new`, `#!${process.execPath}\nimport(${JSON.stringify(module)}).then((m) => m.run(${JSON.stringify(engine)}, ${JSON.stringify(config)}))\n`, { mode: 0o755 })
  renameSync(`${wrapper}.new`, wrapper)
}
const uninstall = (d: IsolatedDaemon, engine: Engine) => rmSync(join(d.root, 'bin', engine), { force: true })

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const bound = (client: LocalClient, agentId: string, sessionId?: string) =>
  until(`${agentId.slice(0, 8)} to bind its conversation`, async () => {
    const agent = await row(client, agentId)
    return agent?.sessionId && agent.status === 'active' && (!sessionId || agent.sessionId === sessionId) ? agent : null
  }, 60_000, 500)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return bound(client, created.agent.id)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}
const thread = async (client: LocalClient, sessionId: string) => {
  const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>('session_get', { sessionId, limit: 200 }, 30_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  const events = page.events ?? []
  return {
    users: events.filter((event) => event.type === 'user_message').map((event) => String(event.payload.content)),
    answers: events.filter((event) => event.type === 'text_delta').map((event) => String(event.payload.content)),
  }
}
/** The version of the engine the agent runs now, asked through the daemon and answered in its transcript. */
async function runningVersion(client: LocalClient, agentId: string): Promise<string> {
  await turn(client, agentId, '!version')
  const { sessionId } = (await row(client, agentId))!
  return until('the version answer in the thread', async () => {
    const last = (await thread(client, sessionId)).answers.at(-1)
    return last && /Claude Code|codex-cli/.test(last) ? last : null
  }, 15_000, 250)
}

/** What tmux shows in a pane now, or '' once the pane is gone. */
const screen = (d: IsolatedDaemon, pane: unknown): Promise<string> =>
  typeof pane === 'string' && pane ? d.capture(pane).catch(() => '') : Promise.resolve('')
const errorsFor = (client: LocalClient, agentId: string, from: number) =>
  client.frames.slice(from).filter((frame) => frame.type === 'error' && frame.agentId === agentId).map((frame) => String(frame.payload?.message))

describe('engines updated in place', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      // The runner swallows console output: UPDATES_LOG=<file> keeps the daemon's whole log for reading.
      if (process.env.UPDATES_LOG) writeFileSync(process.env.UPDATES_LOG, d.log())
    })
    await d.start()
    return d
  }

  it.each(engines)('%s: replaced by a newer version under a running agent: the agent goes on, and a restart and a new agent run the new one', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `updated-${engine}`)
    expect(await runningVersion(client, agent.id)).toBe(versionLine(engine, OLD[engine]))

    install(d, engine, { version: NEW[engine] })
    // Through a reap and a reconcile pass (every 5s here) with the file the process started from
    // replaced on disk: the daemon must go on seeing the running engine as the agent's.
    await sleep(7_000)
    expect((await row(client, agent.id))?.status).toBe('active')
    expect(await runningVersion(client, agent.id)).toBe(versionLine(engine, OLD[engine]))
    await turn(client, agent.id, 'still working after the update')

    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    expect(restarted.resumed).toBe(true)
    await bound(client, agent.id, agent.sessionId)
    expect(await runningVersion(client, agent.id)).toBe(versionLine(engine, NEW[engine]))

    const next = await create(d, client, engine, `after-the-update-${engine}`)
    expect(await runningVersion(client, next.id)).toBe(versionLine(engine, NEW[engine]))
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('claude: an update drops --fork-session after forks worked: the fork fails at once, its refusal reaches the window, and the source goes on', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const source = await create(d, client, 'claude', 'fork-after-update')
    await turn(client, source.id, 'before the update')
    const first = await client.request('agent_fork', { agentId: source.id, name: 'before the update' }, 90_000)
    expect(first.error, JSON.stringify(first)).toBeUndefined()
    await bound(client, first.agent.id)

    install(d, 'claude', { version: NEW.claude, without: ['--fork-session'] })
    // The daemon does not read `--fork-session` from the help before it forks (only the permission flag
    // is checked), so it launches the fork with it and the new release refuses it.
    const startedAt = Date.now()
    const forked = await client.request('agent_fork', { agentId: source.id, name: 'after the update' }, 90_000)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    if (!forked.error) {
      const pane = forked.agent.tmuxPane
      // What the daemon does today: the engine's process is there for an instant, the launch reads as
      // ready, then the reconciler finds no engine and keeps the conversation-less row as stopped,
      // giving the shell left in the pane a row of its own. Or, when the watcher misses that instant,
      // the row itself becomes that terminal. Either way the refusal is on a terminal the window has.
      const settled = await until('the fork to settle', async () => {
        const now = await row(client, forked.agent.id)
        return now && now.launch?.state !== 'starting' && !(now.engine === 'claude' && now.status === 'active') ? now : null
      }, 30_000, 250)
      expect(settled.sessionId || null).toBeNull()
      const shell = (await rows(client)).find((agent) => agent.engine === 'terminal' && agent.status === 'active' && agent.tmuxPane === pane)
      expect(shell, `a terminal row for the fork's pane ${pane}: ${JSON.stringify(await rows(client))}`).toBeTruthy()
      expect(await screen(d, pane)).toContain("error: unknown option '--fork-session'")
    } else {
      expect(typeof forked.detail).toBe('string')
    }
    // The source is untouched: it goes on in its own conversation.
    await turn(client, source.id, 'the source after the failed fork')
    expect((await row(client, source.id))?.sessionId).toBe(source.sessionId)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('codex: an update drops resume: a restart comes back on a new conversation and says so, the one it left is kept, and a resume says why it cannot', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'resume-after-update')
    await turn(client, agent.id, 'before the update')
    install(d, 'codex', { version: NEW.codex, without: ['resume'] })

    // Restart tries `codex resume <id>`, sees no engine come up, and falls back to a fresh launch in the
    // same pane: a working agent on a new conversation, with `resumed: false` to say so.
    let startedAt = Date.now()
    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(Date.now() - startedAt).toBeLessThan(45_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    expect(restarted.resumed).toBe(false)
    const renewed = await until('the agent on its new conversation', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId && now.sessionId !== agent.sessionId ? now : null
    }, 30_000, 250)
    expect(await runningVersion(client, agent.id)).toBe(versionLine('codex', NEW.codex))
    // The conversation the restart had to leave is kept as a stopped one of its own: listed, and its
    // history readable.
    const kept = await until('the conversation it left, kept as stopped', async () =>
      (await rows(client)).find((one) => one.status === 'stopped' && one.sessionId === agent.sessionId), 15_000, 250)
    expect(kept.id).not.toBe(agent.id)
    expect((await thread(client, agent.sessionId)).users).toEqual(['before the update'])

    expect((await client.request('agent_delete', { agentId: agent.id }, 60_000)).error).toBeUndefined()
    await until('the agent to stop', async () => (await row(client, agent.id))?.status === 'stopped' || null, 45_000, 500)
    startedAt = Date.now()
    const resumed = await client.request('agent_resume', { agentId: agent.id }, 90_000)
    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(resumed.error, JSON.stringify(resumed)).toBe('RESUME_FAILED')
    expect(String(resumed.detail)).toContain('exited before confirming the saved conversation')
    expect((await row(client, agent.id))?.sessionId).toBe(renewed.sessionId)

    // A release that has resume again opens the kept conversation where it was.
    install(d, 'codex', { version: '0.162.0' })
    const reopened = await client.request('agent_resume', { agentId: kept.id }, 90_000)
    expect(reopened.error, JSON.stringify(reopened)).toBeUndefined()
    await bound(client, kept.id, agent.sessionId)
    await turn(client, kept.id, 'back in the kept conversation')
    expect((await thread(client, agent.sessionId)).users).toEqual(['before the update', 'back in the kept conversation'])
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it.each([['claude', '--permission-mode'], ['codex', '--approve-for-me']] as const)('%s: an update drops %s after the daemon saw it supported: a new agent in Auto is refused with the reason, with no daemon restart', async (engine, flag) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    // Creating an agent in Auto reads the flag from the engine's help, and the daemon keeps the answer.
    const first = await create(d, client, engine, `auto-before-${engine}`)
    await turn(client, first.id, 'before the update')
    install(d, engine, { version: NEW[engine], without: [flag] })

    const cwd = join(d.projectsDir, `auto-after-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const startedAt = Date.now()
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    // The answer it kept was about the file the update replaced, so the engine is asked again, and the
    // launch is refused with the reason before any pane opens, as a daemon that never saw the flag
    // refuses it. Before #773 it went on trusting the old answer until it was restarted: the engine
    // refused the flag in a pane, and the window was shown a harness that started and stopped.
    expect(created.error, JSON.stringify(created)).toBe('CODEX_CLI_TOO_OLD')
    expect(String(created.detail)).toContain(flag)
    expect((await rows(client)).filter((agent) => agent.status === 'active').map((agent) => agent.id)).toEqual([first.id])
    // The running agent is untouched.
    await turn(client, first.id, 'the first agent after the update')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it.each(engines)('%s: uninstalled while an agent runs: it goes on; a new agent and a restart fail at once with the reason; reinstalled, both work with no daemon restart', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `uninstalled-${engine}`)
    await turn(client, agent.id, 'before the uninstall')
    uninstall(d, engine)
    // Through a reap and a reconcile pass with the engine's file gone from disk.
    await sleep(7_000)
    expect((await row(client, agent.id))?.status).toBe('active')
    await turn(client, agent.id, 'after the uninstall')

    const cwd = join(d.projectsDir, `missing-${engine}`)
    mkdirSync(cwd, { recursive: true })
    let startedAt = Date.now()
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    const failed = await until('the launch to fail with its reason', async () => {
      const now = created.agent?.id ? await row(client, created.agent.id) : undefined
      return now?.launch?.state === 'failed' ? now : null
    }, 30_000, 250)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(failed.launch.error).toBe('ENGINE_NOT_INSTALLED')
    expect(failed.launch.detail).toContain(`${engine} is not installed`)

    // A restart cannot bring the agent back on an engine that is not there, so it is refused before the
    // running agent is touched, with the reason, the way the agent's folder is checked first.
    startedAt = Date.now()
    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(restarted.error, JSON.stringify(restarted)).toBe('ENGINE_NOT_INSTALLED')
    expect(String(restarted.detail)).toContain(`${engine} is not installed`)
    await turn(client, agent.id, 'after the refused restart')

    install(d, engine, { version: NEW[engine] })
    const next = await create(d, client, engine, `reinstalled-${engine}`)
    expect(await runningVersion(client, next.id)).toBe(versionLine(engine, NEW[engine]))
    // The first agent restarts onto the engine installed again, in its own conversation.
    const back = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(back.error, JSON.stringify(back)).toBeUndefined()
    expect(back.resumed).toBe(true)
    await bound(client, agent.id, agent.sessionId)
    expect(await runningVersion(client, agent.id)).toBe(versionLine(engine, NEW[engine]))
    expect((await thread(client, agent.sessionId)).users).toContain('after the refused restart')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it.each(engines)('%s: slow to start after an update: a new agent binds, and a message sent while it starts is taken once', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    install(d, engine, { version: NEW[engine], startDelayMs: 6_000 })
    const cwd = join(d.projectsDir, `slow-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const from = client.frames.length
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id: string = created.agent.id
    // Sent once the engine's process is there and before it has drawn or announced anything.
    const starting = await until('the engine process, not yet its conversation', async () => {
      const now = await row(client, id)
      return now?.launch?.state === 'ready' ? now : null
    }, 30_000, 100)
    expect(starting.sessionId || null).toBeNull()
    const content = 'sent while it was starting'
    client.send('message', { agentId: id, content })
    const agent = await bound(client, id)
    await client.waitFor((frame) => isTurn('turn_ended', id)(frame) && client.frames.indexOf(frame) >= from, 45_000, 'the message to be answered')
    // Long enough for every check and retry the daemon makes on a message it could not see taken.
    await sleep(12_000)
    const starts = client.frames.slice(from).filter(isTurn('turn_started', id)).map((frame) => frame.payload?.userMessage)
    expect(starts).toEqual([content])
    expect((await thread(client, agent.sessionId)).users).toEqual([content])
    expect(errorsFor(client, id, from)).toEqual([])
    expect(await runningVersion(client, id)).toBe(versionLine(engine, NEW[engine]))
    client.close()
  })

  it('codex: a message sent while Codex asks whether to update does not update it: refused with the reason, it goes through once the question is answered', async () => {
    // Codex asks at startup when a newer release is out, before its conversation starts; the prompt drops
    // a paste and takes the Enter behind it as `Update now`, the highlighted row.
    const d = await fresh()
    const client = await LocalClient.connect(d)
    install(d, 'codex', { version: OLD.codex, updateAvailable: NEW.codex })
    const cwd = join(d.projectsDir, 'update-prompt')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id: string = created.agent.id
    const pane = String((await until('the engine process', async () => {
      const now = await row(client, id)
      return now?.tmuxPane && now.launch?.state === 'ready' ? now : null
    }, 30_000, 100)).tmuxPane)
    await until('the update prompt to be drawn', async () => (await d.capture(pane)).includes('Update available') || null, 30_000, 250)
    const from = client.frames.length
    const refused = client.next((frame) => frame.type === 'error' && frame.agentId === id, 15_000, 'the refusal')
    client.send('message', { agentId: id, content: 'what changed?' })
    expect(String((await refused).payload?.message)).toBe('Codex is asking whether to update. Answer it in its terminal, then send the message again.')
    expect(await d.capture(pane)).not.toContain('Update ran successfully')
    // Skipped in its terminal, Codex starts, and the same message goes through.
    await d.tmux.run('send-keys', '-t', pane, 'Escape')
    await bound(client, id)
    await turn(client, id, 'what changed?')
    expect(errorsFor(client, id, from)).toHaveLength(1)
    client.close()
  })
})
