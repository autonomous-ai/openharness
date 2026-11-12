/**
 * A Hermes bound and followed from the record it keeps of its own terminal (docs/plans/2026-11-12-sandbox-hooks-design.md):
 * the real daemon, a private tmux server and Hermes home, and a fake Hermes v0.23 (e2e/harness/fakeHermes.mjs) at
 * `HERMES_PATH`, so the computer's own Hermes is never run. On Linux, the same fake in a sandbox of its own (`unshare`).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { fakeHermesScript } from './harness/fakeHermes.mjs'

const CURRENT = 'Hermes Agent v0.23.1 (2026.11.1)'
const OLDER = 'Hermes Agent v0.21.5 (2026.10.7)'
/** The first line of the hook block every release writes into a Hermes config (contract.ts HERMES_HOOK_SETTINGS). */
const BLOCK = '# machine-adapter: session discovery'
const PERSON = 'model: anthropic/claude\nterminal:\n  client_env_passthrough: ["MY_VAR"]\n'
const TUI = 'display:\n  interface: tui\n'
const REMOVED = "[hooks] removed Harness's Hermes hooks → "

type Agent = { id: string; sessionId?: string; status?: string; launch?: { state: string }; identityHold?: string }
type Saved = { agentId: string; sessionId: string; cwd: string | null; hermesHome?: string | null; hermesHomeDerived?: true; lastHookAt: number }
type Started = { given: string; terminal: string | null; session: string }

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
afterEach(async () => {
  client?.close()
  await daemon?.close()
  client = undefined
  daemon = undefined
})

/** A daemon whose Hermes is the fake: its default home, and the script file the fakes follow. */
async function rig() {
  const d = daemon = await IsolatedDaemon.create()
  onTestFailed(() => console.log(d.log()))
  const home = d.env.HERMES_HOME = join(d.root, 'hermes')
  d.env.HERMES_PATH = join(d.root, 'bin', 'hermes')
  d.env.HOOK_INSTALL_ENGINES = 'hermes'
  mkdirSync(home, { recursive: true })
  const script = join(d.root, 'hermes-script.jsonl')
  writeFileSync(script, '')
  const hermes = (options: Omit<Parameters<typeof fakeHermesScript>[0], 'script' | 'version'> & { version?: string } = {}) =>
    writeFileSync(d.env.HERMES_PATH!, fakeHermesScript({ version: CURRENT, script, ...options }), { mode: 0o755 })
  const tell = (step: Record<string, unknown>) => appendFileSync(script, `${JSON.stringify(step)}\n`)
  const connect = async () => { client?.close(); return client = await LocalClient.connect(d) }
  const folder = (name: string) => { const path = join(d.projectsDir, name); mkdirSync(path, { recursive: true }); return path }
  return { d, home, config: join(home, 'config.yaml'), hermes, tell, connect, folder }
}
type Rig = Awaited<ReturnType<typeof rig>>

/** The person's config in [home], with the hook a daemon writes there for an older Hermes, as every release before this one wrote it. */
async function olderHook(r: Rig, home: string): Promise<void> {
  const given = r.d.env.HERMES_HOME
  r.d.env.HERMES_HOME = home
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.yaml'), PERSON)
  r.hermes({ version: OLDER })
  await r.d.start()
  await hookIn(r.d, join(home, 'config.yaml'))
  await r.d.stop()
  r.d.env.HERMES_HOME = given
}

/** [config] once the daemon's hook, installed after it is ready, is in it and approved beside it (written after it). */
const hookIn = (d: IsolatedDaemon, config: string): Promise<string> => until('the hook in the config', () => {
  const text = readFileSync(config, 'utf8')
  const approvals = readFileSync(join(dirname(config), 'shell-hooks-allowlist.json'), 'utf8')
  return text.includes(BLOCK) && text.includes(String(d.port)) && approvals.includes(String(d.port)) ? text : null
}, 15_000)

const startedIn = (home: string): Started => JSON.parse(readFileSync(join(home, 'started.json'), 'utf8'))
const recorded = (home: string, terminal: string): string =>
  JSON.parse(readFileSync(join(home, 'terminal-sessions', terminal), 'utf8')).session_id
/** The session [terminal]'s record names once it no longer names [was]. */
const movedFrom = (home: string, terminal: string, was: string): Promise<string> => until('the record of the new session', () => {
  const named = recorded(home, terminal)
  return named !== was ? named : null
}, 10_000, 50)
const saved = (d: IsolatedDaemon, agentId: string): Saved | undefined =>
  (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Saved[]).find((row) => row.agentId === agentId)
const row = async (c: LocalClient, agentId: string): Promise<Agent | undefined> =>
  (await c.request<{ agents: Agent[] }>('agents_list', { includeStopped: true })).agents.find((agent) => agent.id === agentId)
const boundTo = (c: LocalClient, agentId: string, sessionId: string) =>
  until(`the agent bound to ${sessionId.slice(0, 14)}`, async () => (await row(c, agentId))?.sessionId === sessionId || null, 30_000, 100)

/** A Hermes agent in [cwd], once its fake has started there (`started.json` is the fake's, written before it says so). */
async function create(r: Rig, c: LocalClient, cwd: string, home = r.home): Promise<{ agentId: string; started: Started }> {
  rmSync(join(home, 'started.json'), { force: true })
  const created = await c.request('agent_create', { engine: 'hermes', cwd }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const pane = String(created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane)
  await until('the fake Hermes', async () => (await r.d.capture(pane)).includes('fake-hermes-ready') || null, 30_000, 100)
  return { agentId: created.agent.id, started: startedIn(home) }
}

/** The fake started again in [home] (its `started.json` written anew) after [action]. */
async function startedAgain(home: string, action: () => Promise<unknown>): Promise<Started> {
  rmSync(join(home, 'started.json'), { force: true })
  await action()
  await until('the fake Hermes to start again', () => existsSync(join(home, 'started.json')) || null, 60_000, 100)
  return startedIn(home)
}

it('binds a Hermes v0.23 from its terminal record, follows /new, and writes no hook', async () => {
  const r = await rig()
  await olderHook(r, r.home)
  const allowlist = join(r.home, 'shell-hooks-allowlist.json')
  expect(JSON.parse(readFileSync(allowlist, 'utf8')).approvals).toHaveLength(2)
  r.hermes()
  let mark = r.d.log().length
  await r.d.start()
  await until('the hook removed', () => readFileSync(r.config, 'utf8') === PERSON || null, 15_000)
  await until('its approvals removed', () => JSON.parse(readFileSync(allowlist, 'utf8')).approvals.length === 0 || null, 15_000)
  expect(r.d.log().slice(mark)).toContain(`${REMOVED}${r.config}`)

  const c = await r.connect()
  const cwd = r.folder('p1')
  mark = r.d.log().length
  const a = await create(r, c, cwd)
  // Typed before the pass binds, as a person does in the first seconds of a launch: the conversation still shows it.
  r.tell({ say: 'hello' })
  expect(a.started.terminal).toMatch(/^tty-dev-/)
  expect(recorded(r.home, a.started.terminal!)).toBe(a.started.session)
  await boundTo(c, a.agentId, a.started.session)
  expect(r.d.log().slice(mark)).toContain('[discovery] bound hermes session ')
  expect(r.d.log()).not.toMatch(/\[hooks\] \S+ SessionStart/)
  await until('the first message in the conversation', async () =>
    JSON.stringify(await c.request('session_get', { sessionId: a.agentId }, 30_000)).includes('hello') || null, 30_000, 250)

  // `/new` (a branch and a compression split write the record the same way), and a message typed before the pass
  // that follows it, up to 5 s later.
  r.tell({ new: true })
  r.tell({ say: 'right after /new' })
  const second = await movedFrom(r.home, a.started.terminal!, a.started.session)
  await boundTo(c, a.agentId, second)
  await c.waitFor((frame) => frame.type === 'session_reset' && frame.payload?.staleSessionId === a.started.session, 10_000, 'session_reset')
  expect(r.d.log().slice(mark)).toContain(`switched hermes session ${a.started.session.slice(0, 8)} → ${second.slice(0, 8)}`)
  await until('the message in the new conversation', async () =>
    JSON.stringify(await c.request('session_get', { sessionId: a.agentId }, 30_000)).includes('right after /new') || null, 30_000, 250)

  // A second Hermes in the same home and folder binds its own session; neither takes the other's.
  const b = await create(r, c, cwd)
  expect(b.started.terminal).not.toBe(a.started.terminal)
  await boundTo(c, b.agentId, b.started.session)
  expect((await row(c, a.agentId))?.sessionId).toBe(second)
  expect(readFileSync(r.config, 'utf8')).toBe(PERSON)
})

it('follows a resumed Hermes through /new without failing it', async () => {
  const r = await rig()
  r.hermes()
  await r.d.start()
  const c = await r.connect()
  const a = await create(r, c, r.folder('p1'))
  await boundTo(c, a.agentId, a.started.session)
  r.tell({ say: 'before the stop' })
  expect((await c.request('agent_delete', { agentId: a.agentId }, 60_000)).error).toBeUndefined()
  await until('the agent to be stopped', async () => (await row(c, a.agentId))?.status === 'stopped' || null, 60_000, 250)

  const resumed = await startedAgain(r.home, async () =>
    expect((await c.request('agent_resume', { agentId: a.agentId }, 90_000)).error).toBeUndefined())
  expect(resumed.session).toBe(a.started.session)
  // `/new` at once, before a pass reads the record naming the resumed conversation: the record only ever names the new
  // one, and the resumed one, which `/new` ended, is confirmed from the store before the agent follows (Review Focus 3).
  r.tell({ new: true })
  const next = await movedFrom(r.home, resumed.terminal!, a.started.session)
  await boundTo(c, a.agentId, next)
  const agent = await row(c, a.agentId)
  expect(agent?.launch?.state).not.toBe('failed')
  expect(r.d.log()).not.toContain('RESUME_SESSION_MISMATCH')
  await until('the resumed conversation confirmed', () => (saved(r.d, a.agentId)?.lastHookAt ?? 0) > 0 || null, 10_000, 100)
})

it('binds nothing from a record an earlier process left, binds once by the repair, and says switches are not followed', async () => {
  const r = await rig()
  r.hermes({ record: false })
  const cwd = r.folder('p1')
  // A session of the pane's own an earlier Hermes in this terminal was on, a minute before this one started.
  const earlier = `local-${'e'.repeat(64)}`
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(r.home, 'state.db'))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, created_source TEXT, cwd TEXT, started_at REAL)')
  db.prepare("INSERT INTO sessions VALUES (?, 'local', 'cli', ?, ?)").run(earlier, cwd, Date.now() / 1000 - 60)
  db.close()
  await r.d.start()
  const c = await r.connect()
  const mark = r.d.log().length
  const a = await create(r, c, cwd)
  mkdirSync(join(r.home, 'terminal-sessions'), { recursive: true })
  writeFileSync(join(r.home, 'terminal-sessions', a.started.terminal!), JSON.stringify({ session_id: earlier, cwd, ts: Date.now() / 1000 - 60 }))
  await boundTo(c, a.agentId, a.started.session)
  await until('the fallback said', () => r.d.log().slice(mark).includes('hermes keeps no terminal record · its session switches are not followed') || null, 10_000)
  await until('the earlier record ignored', () => r.d.log().slice(mark).includes('hermes terminal record ignored · older than its process') || null, 10_000)
  expect((await row(c, a.agentId))?.sessionId).toBe(a.started.session)
})

it('ignores a record that is a symlink, and one of 10 MB, and keeps the session it has', async () => {
  const r = await rig()
  r.hermes()
  await r.d.start()
  const c = await r.connect()
  const mark = r.d.log().length
  const a = await create(r, c, r.folder('p1'))
  await boundTo(c, a.agentId, a.started.session)
  // Another terminal's record, naming a session of its own.
  const other = join(r.home, 'terminal-sessions', 'tty-dev-other')
  writeFileSync(other, JSON.stringify({ session_id: `local-${'f'.repeat(64)}`, cwd: '/elsewhere', ts: Date.now() / 1000 }))
  r.tell({ link: other })
  await until('the symlink ignored', () => r.d.log().slice(mark).includes('hermes terminal record ignored · not a regular file') || null, 15_000)
  r.tell({ pad: 10 * 1024 * 1024 })
  await until('the oversized record ignored', () => r.d.log().slice(mark).includes('hermes terminal record ignored · oversized') || null, 15_000)
  expect((await row(c, a.agentId))?.sessionId).toBe(a.started.session)
  // The passes after it go on as before: the next record Hermes writes is followed.
  r.tell({ new: true })
  const next = await movedFrom(r.home, a.started.terminal!, a.started.session)
  await boundTo(c, a.agentId, next)
  const said = r.d.log().slice(mark)
  expect(said.split('not a regular file')).toHaveLength(2)
  expect(said.split('· oversized')).toHaveLength(2)
})

it('keeps an older Hermes\'s hook', async () => {
  const r = await rig()
  writeFileSync(r.config, PERSON)
  r.hermes({ version: OLDER })
  await r.d.start()
  await hookIn(r.d, r.config)
  expect(r.d.log()).not.toContain(REMOVED)
})

it('keeps the hook of a home set to the TUI', async () => {
  const r = await rig()
  r.hermes({ record: false })
  writeFileSync(r.config, PERSON + TUI)
  await r.d.start()
  const installed = await hookIn(r.d, r.config)
  expect(r.d.log()).not.toContain(REMOVED)
  const c = await r.connect()
  const a = await create(r, c, r.folder('p1'))
  // The fake runs no hook: the repair binds it.
  await boundTo(c, a.agentId, a.started.session)
  expect(readFileSync(r.config, 'utf8')).toBe(installed)
})

it('follows a Hermes that only has a HOME of its own, and starts it again without naming that home', async () => {
  const r = await rig()
  const folder = join(r.d.root, 'agents', 'a1')
  const own = join(folder, '.hermes')
  const ownConfig = join(own, 'config.yaml')
  await olderHook(r, own)
  r.hermes({ home: folder })
  await r.d.start()
  const c = await r.connect()
  const mark = r.d.log().length
  const a = await create(r, c, r.folder('p1'), own)
  expect(recorded(own, a.started.terminal!)).toBe(a.started.session)
  await boundTo(c, a.agentId, a.started.session)
  await until('the home marked on the saved row', () => saved(r.d, a.agentId)?.hermesHomeDerived || null, 15_000)
  expect(saved(r.d, a.agentId)?.hermesHome).toBe(own)
  await until('the hook gone from its own config', () => r.d.log().slice(mark).includes(`${REMOVED}${ownConfig}`) || null, 15_000)
  expect(readFileSync(ownConfig, 'utf8')).toBe(PERSON)

  // Started again, it is given what its first start was given, never the home Harness worked out.
  const restart = async (via: LocalClient) => {
    const again = await startedAgain(own, async () =>
      expect((await via.request('agent_restart', { agentId: a.agentId }, 90_000)).error).toBeUndefined())
    expect(again.given).toBe(a.started.given)
    expect(again.given).not.toBe(own)
    await boundTo(via, a.agentId, again.session)
    expect(saved(r.d, a.agentId)?.hermesHomeDerived).toBe(true)
  }
  await restart(c)
  // The mark was saved: a daemon started again does not name the home either.
  await r.d.restart()
  const after = await r.connect()
  await until('the agent back', async () => (await row(after, a.agentId))?.sessionId || null, 30_000, 250)
  await restart(after)
})

/** Whether this machine lets an unprivileged process make the sandbox the fake runs in. */
const unshareWorks = (): boolean =>
  spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true']).status === 0

describe.runIf(process.platform === 'linux' && unshareWorks())('in a sandbox', () => {
  it('binds and follows a Hermes whose home and folder are where the daemon sees them', async () => {
    const r = await rig()
    const folder = join(r.d.root, 'agents', 'a1')
    const own = join(folder, '.hermes')
    const ownConfig = join(own, 'config.yaml')
    await olderHook(r, own)
    r.hermes({ home: folder, sandbox: 'same' })
    await r.d.start()
    const c = await r.connect()
    const mark = r.d.log().length
    const a = await create(r, c, r.folder('p1'), own)
    expect(a.started.terminal).toMatch(/^tty-dev-pts-\d+$/)
    await boundTo(c, a.agentId, a.started.session)
    await until('the home marked on the saved row', () => saved(r.d, a.agentId)?.hermesHomeDerived || null, 15_000)
    expect(saved(r.d, a.agentId)?.hermesHome).toBe(own)
    await until('the hook gone from its own config', () => r.d.log().slice(mark).includes(`${REMOVED}${ownConfig}`) || null, 15_000)
    expect(readFileSync(ownConfig, 'utf8')).toBe(PERSON)
    expect(r.d.log().slice(mark).split('hermes runs in a sandbox · followed from its terminal record')).toHaveLength(2)
    r.tell({ new: true })
    const second = await movedFrom(own, a.started.terminal!, a.started.session)
    await boundTo(c, a.agentId, second)
  })

  it('binds a Hermes whose home, folder and /dev/pts are remapped', async () => {
    const r = await rig()
    const folder = join(r.d.root, 'agents', 'a1')
    const own = join(folder, '.hermes')
    mkdirSync(own, { recursive: true })
    r.hermes({ home: folder, sandbox: 'remapped' })
    await r.d.start()
    const c = await r.connect()
    const cwd = r.folder('p1')
    const a = await create(r, c, cwd, own)
    expect(a.started.terminal).toMatch(/^tmux_pane--\d+$/)
    await boundTo(c, a.agentId, a.started.session)
    await until('the host\'s paths on the saved row', () => saved(r.d, a.agentId)?.hermesHomeDerived || null, 15_000)
    expect(saved(r.d, a.agentId)).toMatchObject({ cwd, hermesHome: own, hermesHomeDerived: true })
    const again = await startedAgain(own, async () =>
      expect((await c.request('agent_restart', { agentId: a.agentId }, 90_000)).error).toBeUndefined())
    expect(again.given).toBe(a.started.given)
    expect(again.given).not.toBe(own)
    await boundTo(c, a.agentId, again.session)
  })

  it('holds a Hermes whose home is on a filesystem of the sandbox\'s own, and leaves its pane working', async () => {
    const r = await rig()
    r.hermes({ home: join(r.d.root, 'agents', 'a1'), sandbox: 'unseen' })
    await r.d.start()
    const c = await r.connect()
    const mark = r.d.log().length
    const created = await c.request('agent_create', { engine: 'hermes', cwd: r.folder('p1') }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    const pane = String(created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane)
    const hold = 'Hermes runs in a sandbox whose folder Harness cannot see'
    await until('the hold', async () => (await row(c, agentId))?.identityHold === hold || null, 30_000, 250)
    expect((await row(c, agentId))?.sessionId).toBeFalsy()
    expect(r.d.log().slice(mark).split(`binding held · ${hold}`)).toHaveLength(2)
    expect(await r.d.capture(pane)).toContain('fake-hermes-ready')
  })
})

it.runIf(process.env.HARNESS_E2E_REQUIRE_SANDBOX === '1')('ran the sandbox cases', () => {
  expect(process.platform === 'linux' && unshareWorks()).toBe(true)
})
