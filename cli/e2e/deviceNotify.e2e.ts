/**
 * `harness device notify` on the real daemon (docs/plans/2026-11-16-dial-agent-notify-design.md): the real command, run
 * as an agent's shell runs it, with that agent's own variables and in its folder, reaches the devices' listener, and a
 * fake dial on the desk (harness/desk.ts) shows the line as a card of that agent's own:
 * - an outside Claude Code session's and a Codex session's notice is a card on their own row, answered in their app;
 *   the same line again is limited; reading the card leaves it, and the agent's next prompt closes it;
 * - the turn that sent a notice ends silent, and its card stays;
 * - a Harness agent's notice is tied to the Harness agent, and a session nobody lists rings under its folder;
 * - it rings with a window open on its tab;
 * - with the dial unplugged, or no dial on this computer, it prints `no dial`, and the second starts nothing;
 * - a pending card comes back after the devices process restarts, as a silent row that opens to its line
 *   (docs/plans/2026-11-18-dial-notices-restart-design.md).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { LocalClient } from './harness/client.js'
import { CodexOutside } from './harness/codexOutside.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

const LINE = 'Connect the VPN so I can run the staging tests'

// The run's bundle when there is one (E2E_BUNDLE), as the daemon runs. Run from the caller's folder, where a bare
// `--import tsx` would not resolve: tsx and the sources by their paths.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH
  ? [process.env.E2E_BUNDLE_PATH]
  : ['--import', pathToFileURL(createRequire(join(CLI_ROOT, 'package.json')).resolve('tsx')).href, join(CLI_ROOT, 'src', 'cli.ts')]

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
/** A Harness agent in a tmux pane, created as the desktop creates one, and the engine session the core bound to it. */
async function create(daemon: IsolatedDaemon, client: LocalClient, folder: string): Promise<{ id: string; sessionId: string }> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  const agent = await until(`${folder} to bind its conversation`, async () => {
    const found = await row(client, created.agent.id)
    return found?.sessionId && found.status === 'active' ? found : null
  }, 60_000, 500)
  return { id: created.agent.id, sessionId: String(agent.sessionId) }
}

describe('harness device notify', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })
  const fresh = async (env: Record<string, string> = {}): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...env } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    return { d, desk: theDesk }
  }
  const plugged = async (theDesk: Desk): Promise<FakeDial> => {
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }
  const startOutside = async (d: IsolatedDaemon, folder: string): Promise<Outside> => {
    const engine = await Outside.start(d, folder, { TERM_PROGRAM: 'ghostty' })
    outside.push(engine)
    return engine
  }
  const listed = (dial: FakeDial, agentId: string): Promise<DialMessage> =>
    dial.next((m) => m.t === 'agent' && m.id === agentId, 45_000, 'the agent listed')

  /** The command as an agent's shell runs it: the daemon's environment, the caller's variables, in its folder. */
  async function notify(d: IsolatedDaemon, caller: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
    mkdirSync(cwd, { recursive: true })
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', 'notify', LINE], {
      cwd, env: { ...d.env, TMUX_PANE: '', ...caller }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = '', err = ''
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, out: out.trim(), err }
  }
  const questions = (dial: FakeDial, agentId: string): DialMessage[] =>
    dial.messages.filter((m) => m.t === 'question' && m.agentId === agentId)
  const card = (app: string) => [{ key: 'notice', q: LINE, options: [`In ${app}`] }]
  /** What a ring carries of the card: its line, as the drawer row shows it. The dial reads the card itself. */
  const rung = [{ key: '', q: LINE, options: [] }]

  it('an outside Claude Code session\'s notice is its own card, read without closing it, and closed by its next prompt', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const cwd = join(d.projectsDir, 'fix-login')

    expect(await notify(d, caller, cwd)).toMatchObject({ code: 0, out: 'shown' })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')
    expect(question).toMatchObject({ agentId: engine.id, name: 'fix-login', id: expect.stringMatching(/^shown:/), questions: rung })

    // The same line again, within the minute: limited, and nothing more on the dial.
    expect(await notify(d, caller, cwd)).toMatchObject({ code: 0, out: 'limited' })

    // Opening the alert to read it leaves the card. The list asked after it is the barrier: the daemon has handled the
    // read, and whatever it sent for it, by the time the list's drawer is sent. A drawer carries the dial's open
    // questions as rows instead of asking them again (#4445): the card is one of them.
    let since = dial.messages.length
    dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })
    const state = await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the card read', since)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: card('Ghostty') })
    since = dial.messages.length
    dial.send({ t: 'agents.list' })
    const drawer = await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer sent with the list', since)
    expect(drawer.items).toContainEqual(expect.objectContaining({ agentId: engine.id, name: 'fix-login', summary: LINE, question: true }))
    // The same card each time it is sent, never a second one, and never closed.
    expect([...new Set(questions(dial, engine.id).map((m) => m.id))]).toEqual([question.id])
    const prompted = dial.messages.length
    expect(dial.messages.some((m) => m.t === 'question.close' && m.agentId === engine.id)).toBe(false)

    // The person's next prompt: its turn starts, and the card goes.
    engine.type('connected')
    await dial.next((m) => m.t === 'question.close' && m.agentId === engine.id && m.id === question.id, 45_000, 'the card closed', prompted)

    await until('the notice in the daemon\'s log', () => d.log().includes('[device] notify · claude · shown'), 30_000, 50)
    expect(d.log().split('\n').filter((line) => line.includes(LINE))).toEqual([])
  })

  // One ring a turn (docs/plans/2026-11-17-dial-one-ring-per-turn-design.md): the notice rang, so the turn's end only
  // draws the tile, and the notice keeps its row.
  it('a turn that sent a notice ends silent, and its card stays', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const started = dial.messages.length
    // The turn ends only once the notice is shown, as an agent's turn goes on while the command it runs works: no
    // timer for the command to beat.
    engine.type('!until fix-login')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', started)
    expect(await notify(d, caller, join(d.projectsDir, 'fix-login'))).toMatchObject({ code: 0, out: 'shown' })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice', started)
    writeFileSync(join(d.engineConfig.root, 'fix-login.release'), '')
    const summary = await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', started)
    expect(summary).toMatchObject({ tier: 'silent', silent: true })
    // The read answered after the summary is the barrier: the card is still the daemon's, and nothing closed it.
    const since = dial.messages.length
    dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })
    expect(await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the card read', since))
      .toMatchObject({ ok: true, id: question.id, questions: card('Ghostty') })
    expect(dial.messages.some((m) => m.t === 'question.close' && m.agentId === engine.id)).toBe(false)
    // The log reaches the test on a path of its own, not behind the dial's frames.
    await until('the silent end in the daemon\'s log', () => d.log().includes('[cable] notify · silent · rule:notice · notice · 0ms'), 30_000, 50)
  })

  it('a Codex session\'s notice is its own card', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const codex = new CodexOutside(d, 'api', children, { TERM_PROGRAM: 'ghostty' })
    await codex.hook('SessionStart', { source: 'startup' })
    await listed(dial, codex.id)
    expect(await notify(d, { CODEX_THREAD_ID: codex.sessionId }, codex.cwd)).toMatchObject({ code: 0, out: 'shown' })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === codex.id, 45_000, 'the notice'))
      .toMatchObject({ name: 'api', id: expect.stringMatching(/^shown:/), questions: rung })
    expect(await opened(dial, codex.id)).toMatchObject({ ok: true, questions: card('Ghostty') })
    await until('the notice in the daemon\'s log', () => d.log().includes('[device] notify · codex · shown'), 30_000, 50)
  })

  it('a Harness agent\'s notice is tied to the agent', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await plugged(desk)
    await listed(dial, harness.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: harness.sessionId }
    expect(await notify(d, caller, join(d.projectsDir, 'in-harness'))).toMatchObject({ code: 0, out: 'shown' })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === harness.id, 45_000, 'the notice'))
      .toMatchObject({ id: expect.stringMatching(/^shown:/), questions: rung })
    expect(await opened(dial, harness.id)).toMatchObject({ ok: true, questions: card('Harness') })
    expect(questions(dial, observedAgentId('claude', harness.sessionId))).toEqual([])
    client.close()
  })

  it('a session nobody lists still rings, under its folder', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const sessionId = randomUUID()
    const agentId = observedAgentId('claude', sessionId)
    expect(await notify(d, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sessionId }, join(d.projectsDir, 'scratch')))
      .toMatchObject({ code: 0, out: 'shown' })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === agentId, 45_000, 'the notice'))
      .toMatchObject({ name: 'scratch', id: expect.stringMatching(/^shown:/), questions: rung })
    expect(await opened(dial, agentId)).toMatchObject({ ok: true, questions: card('Terminal') })
  })

  it('it rings with a window open on its tab', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    // A window on a tab, as the desktop says it: the dial shows the tab's list, and an outside agent's turns are held.
    const window = await LocalClient.connect(d)
    const since = dial.messages.length
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    window.send('app_panes', { agentIds: [], foreground: true })
    await dial.next((m) => m.t === 'agents.end' && m.tab === 't1', 45_000, 'the tab\'s list', since)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    expect(await notify(d, caller, join(d.projectsDir, 'fix-login'))).toMatchObject({ code: 0, out: 'shown' })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice', since))
      .toMatchObject({ questions: rung })
    window.close()
  })

  it('with the dial unplugged it prints no dial', async () => {
    const { d, desk } = await fresh()
    await plugged(desk)
    const window = await LocalClient.connect(d)
    await desk.unplug('E2E-A')
    await until('the dial to read as unplugged', async () => {
      const answer = await window.request('harness_devices_list', {})
      return (answer.status?.devices as Array<{ id: string; attached: boolean }> | undefined)?.find((device) => device.id === 'E2E-A')?.attached === false || null
    }, 30_000, 500)
    expect(await notify(d, { CODEX_THREAD_ID: randomUUID() }, join(d.projectsDir, 'api'))).toMatchObject({ code: 0, out: 'no dial' })
    window.close()
  })

  it('with no dial on this computer it prints no dial and starts nothing', async () => {
    const { d } = await fresh({ CABLE_DISABLE: 'true' })
    const before = d.log().length
    expect(await notify(d, { CODEX_THREAD_ID: randomUUID() }, join(d.projectsDir, 'api'))).toMatchObject({ code: 0, out: 'no dial' })
    expect(d.log().slice(before)).not.toContain('asking for the devices\' process')
  })

  /** The cards of the daemon's file of pending notices, once it is there. */
  const stored = (d: IsolatedDaemon): Array<{ id: string }> | null => {
    try { return (JSON.parse(readFileSync(join(d.dataDir, 'dial-notices.json'), 'utf8')) as { cards: Array<{ id: string }> }).cards } catch { return null }
  }
  const inFile = (d: IsolatedDaemon, id: string) => until('the card in the file', () => stored(d)?.some((card) => card.id === id) || null, 30_000, 50)
  /** That agent's row in the first drawer since [since] that carries one. */
  const drawerRow = async (dial: FakeDial, agentId: string, since: number): Promise<Record<string, unknown>> => {
    const items = (m: DialMessage) => (m.items ?? []) as Array<Record<string, unknown>>
    const replaced = await dial.next((m) => m.t === 'notif.replace' && items(m).some((item) => item.agentId === agentId), 60_000, 'the row back', since)
    return items(replaced).find((item) => item.agentId === agentId)!
  }
  /** Opening its row reads the line, as the dial asks once a question row is opened. The list asked first is the barrier:
   *  the hold goes in its agent's order, a turn of the loop behind the drawer replace. */
  const opened = async (dial: FakeDial, agentId: string): Promise<DialMessage> => {
    let since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the list', since)
    since = dial.messages.length
    dial.send({ t: 'question.read', agentId, requestId: 'read-1' })
    return dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the row read', since)
  }
  /** What rang for that agent since [since]: a question, an error, or a summary told aloud. */
  const rang = (dial: FakeDial, agentId: string, since: number): DialMessage[] => dial.messages.slice(since).filter((m) => m.agentId === agentId &&
    (m.t === 'question' || m.t === 'turn.error' || (m.t === 'summary' && m.restore !== true && m.tier !== 'silent')))

  it('an outside session\'s notice comes back as a silent row after the devices restart, and its next prompt ends it', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    // A turn, so the scan after the restart finds its conversation.
    engine.type('before the restart')
    await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    await engine.idle(d)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    expect(await notify(d, caller, join(d.projectsDir, 'fix-login'))).toMatchObject({ code: 0, out: 'shown' })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')
    await inFile(d, question.id as string)

    const back = dial.messages.length
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
    await dial.welcomeAfter(back, 60_000)
    expect(await drawerRow(dial, engine.id, back)).toMatchObject({ agentId: engine.id, question: true, summary: LINE, name: 'fix-login' })
    // The row opens to its line, never "No readable question. Check the terminal."
    const state = await opened(dial, engine.id)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: [{ q: LINE }] })
    expect(state.error).toBeUndefined()
    expect(rang(dial, engine.id, back)).toEqual([])

    // The person's next prompt: its turn starts, and the card goes, from the file too.
    const prompted = dial.messages.length
    engine.type('connected')
    await dial.next((m) => m.t === 'question.close' && m.agentId === engine.id && m.id === question.id, 45_000, 'the card closed', prompted)
    await until('the file emptied', () => stored(d)?.length === 0 || null, 30_000, 50)
    expect(d.log()).toContain('[device] notices · restored 1 · aged out 0')
    expect(d.log().split('\n').filter((line) => line.includes(LINE))).toEqual([])
  })

  it('a Harness agent\'s notice comes back as a silent row after the devices restart', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await plugged(desk)
    await listed(dial, harness.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: harness.sessionId }
    expect(await notify(d, caller, join(d.projectsDir, 'in-harness'))).toMatchObject({ code: 0, out: 'shown' })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === harness.id, 45_000, 'the notice')
    await inFile(d, question.id as string)

    const back = dial.messages.length
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
    await dial.welcomeAfter(back, 60_000)
    expect(await drawerRow(dial, harness.id, back)).toMatchObject({ agentId: harness.id, question: true, summary: LINE })
    const state = await opened(dial, harness.id)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: [{ q: LINE }] })
    expect(state.error).toBeUndefined()
    expect(dial.messages.slice(back).filter((m) => m.t === 'question' && m.agentId === harness.id)).toEqual([])

    const prompted = dial.messages.length
    client.send('message', { agentId: harness.id, content: 'go on' })
    await dial.next((m) => m.t === 'question.close' && m.agentId === harness.id && m.id === question.id, 45_000, 'the card closed', prompted)
    client.close()
  })
})
