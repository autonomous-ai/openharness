/**
 * The dial's usage counts, end to end (docs/plans/2026-11-23-dial-usage-counts-design.md): on the real daemon, signed in
 * to the in-memory backend with sharing on, a fake dial plugged, turned and tapped. The devices count the day into their
 * own dial-usage.json, the gateway reads it at its tick, and the signed-in report carries the dial's names, counts only:
 * no agent, folder, dial or machine in a report or in the file. A daemon restart between the gateway taking the day and
 * its report sends no flag twice: one wait for the report covers both.
 *
 * The dial skill's use rides the same report (docs/plans/2026-11-26-dial-skill-usage-design.md): an outside Claude Code
 * session runs the real `harness device notify`, the dial shows it, and the person's prompt right after answers it; the
 * attach's setup pass wrote the skill, which the devices then find.
 *
 * With the person there the notice is held quiet (docs/plans/2026-11-26-needs-you-right-design.md, Part 2): the person
 * just prompted the session, its app is in front and the dial shows it, so its turn end is silent and its notice is a
 * drawer row with no question frame, counted as held quiet and opening no wait. A second session, the same but for
 * another app in front, rings: a second notice of the first session within its minute would be limited, and waiting the
 * minute out is a fixed sleep.
 *
 * A third session's notice is held quiet the same way, mid-turn, and is asked once its turn ends with the person gone to
 * another app (Part 2b): a question frame under a new id, as the dial mutes the id it holds, the turn's end silent, and
 * the rouse counted.
 *
 * A fourth session gets a second look (Part 5), with the person gone to another app: its Stop hook's report, sent as
 * `harness device claude stop` sends it, marks it after its first turn; the devices say yes to its next turn's stop, and
 * its notice while that yes holds the turn is counted as the ring after the yes. The fake engine has no Stop hook of the
 * plugin's, so the test sends each report itself.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { askDevices, tellDevices } from '../src/devices/listenerClient.js'
import { DIAL_USAGE_FILE } from '../src/lib/dialUsageContract.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, sourcesCli, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

const SERIAL = 'E2E-A'
const MAC = 'e2:e0:00:00:00:0a'
// The first report waits up to a minute and the next one five (gateway/productUsage.ts), so the dial's own report, which
// travels after the product's, is in by then.
const REPORTED_MS = 420_000
// The gateway's first tick is at most a minute after its start, and the next ones 45 to 75 seconds apart.
const TAKEN_MS = 150_000
const machine = { machineId: 'd1'.repeat(16), computerId: 'e2e-dial-usage', name: 'PRIVATE_MACHINE_CANARY', token: 'e2e-dial-usage-token' }
const today = (): string => new Date().toISOString().slice(0, 10)
// The run's bundle when there is one (E2E_BUNDLE), as the daemon runs. Run from the caller's folder, where a bare
// `--import tsx` would not resolve: tsx and the sources by their paths.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : sourcesCli()

describe('the dial\'s usage counts', () => {
  let backend: FakeBackend, d: IsolatedDaemon, desk: Desk, window: LocalClient | undefined
  let agentId = '', cwd = ''
  const outsides: Outside[] = []
  const children: ChildProcess[] = []
  beforeAll(async () => {
    backend = await FakeBackend.start()
    backend.productUsage = { enabled: true, revision: 0, reports: [] }
    backend.addMachine(machine)
    d = await IsolatedDaemon.create({ env: { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl,
      ADAPTER_COMPUTER_ID: machine.computerId, CABLE_DISABLE: 'false' } })
    const dials = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = dials
    desk = new Desk(dials)
    writeFileSync(dials, '[]')
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: machine.token,
      autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
      expiresAt: Date.now() + 86_400_000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
    await d.start()
  }, 120_000)
  afterAll(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const session of outsides) await session.close()
    window?.close(); await desk?.close(); await d?.close(); await backend?.close()
  })
  const showLog = (): void => onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })

  /** The day's sum of [metric] over every report the backend took. */
  const sum = (metric: string, day: string): number => backend.productUsage!.reports
    .filter((report) => report.day === day)
    .reduce((n, report) => n + ((report.counters as Record<string, number>)[metric] ?? 0), 0)
  const usageFile = (): string => join(d.dataDir, DIAL_USAGE_FILE)
  /** What the gateway's queue (gateway/productUsage.ts, a file per account) has taken of the devices' [day]. */
  const taken = (day: string): Record<string, number> => {
    const folder = join(d.dataDir, 'product-usage')
    const queues = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.json')) : []
    return Object.assign({}, ...queues.map((name) =>
      (JSON.parse(readFileSync(join(folder, name), 'utf8')) as { dial?: { sent?: Record<string, Record<string, number>> } }).dial?.sent?.[day]))
  }
  /** A window with the agent on a tab, so a tap on the dial is handed to it. */
  const openWindow = async (): Promise<LocalClient> => {
    const client = await LocalClient.connect(d, { machineId: machine.machineId })
    client.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [agentId], panes: 1 }], tiles: [] })
    client.send('app_panes', { agentIds: [agentId], foreground: true })
    return client
  }
  /** Plugged, then a hand on it: a turn to the agent and a tap that opens it. */
  const plugTurnTap = async (client: LocalClient): Promise<FakeDial> => {
    const dial = await desk.plug(SERIAL, MAC)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the agent list')
    dial.send({ t: 'focus', agentId })
    await client.waitFor((f) => f.type === 'dial_focus' && f.payload?.agentId === agentId, 15_000, 'dial_focus')
    const opens = client.frames.filter((f) => f.type === 'dial_open').length
    dial.send({ t: 'agent.open', agentId })
    await until('the tap handed to the window', () => client.frames.filter((f) => f.type === 'dial_open').length > opens || null, 15_000)
    return dial
  }
  /** The command as an agent's shell runs it (deviceNotify.e2e.ts): the daemon's environment, the caller's variables, in
   *  its folder. */
  const notify = async (caller: Record<string, string>, folder: string, words: string[]): Promise<{ code: number | null; out: string; err: string }> => {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', 'notify', ...words], {
      cwd: folder, env: { ...d.env, TMUX_PANE: '', ...caller }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = '', err = ''
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, out: out.trim(), err }
  }

  it('a dial plugged, turned and tapped, before and after a restart, reaches the report once, as counts only', async () => {
    showLog()
    await until('sharing read', () => backend.seen.includes('GET /api/product-usage/settings') || null, 45_000)
    window = await LocalClient.connect(d, { machineId: machine.machineId })
    cwd = join(d.projectsDir, 'PRIVATE_PROJECT_CANARY')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    agentId = created.agent.id
    await until('the agent to bind its conversation', async () => {
      const rows = (await window!.request('agents_list', { includeStopped: true })).agents as Array<Record<string, unknown>>
      return rows.some((a) => a.id === agentId && a.sessionId && a.status === 'active') || null
    }, 60_000, 500)
    window.close()
    window = await openWindow()
    const day = today()
    const dial = await plugTurnTap(window)
    // With a window on a tab the dial lists that tab alone: the outside session is on the dial's list once it is gone.
    window.close()
    window = undefined

    // Three outside sessions in Ghostty, each prompted by the person in its own app: its UserPromptSubmit hook, the one
    // source that answers a notice and that says the person is there.
    const there = await Outside.start(d, 'PRIVATE_NOTICE_CANARY', { TERM_PROGRAM: 'ghostty' })
    outsides.push(there)
    const away = await Outside.start(d, 'PRIVATE_AWAY_CANARY', { TERM_PROGRAM: 'ghostty' })
    outsides.push(away)
    const left = await Outside.start(d, 'PRIVATE_LEFT_CANARY', { TERM_PROGRAM: 'ghostty' })
    outsides.push(left)
    await dial.next((m) => m.t === 'agent' && m.id === there.id, 45_000, 'the first outside session listed')
    await dial.next((m) => m.t === 'agent' && m.id === away.id, 45_000, 'the second outside session listed')
    await dial.next((m) => m.t === 'agent' && m.id === left.id, 45_000, 'the third outside session listed')
    const caller = (session: Outside): Record<string, string> => ({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session.sessionId })
    /** The app in front, as `harness hardware watch` tells the devices' listener; the dial turned to [session], and the
     *  list it asks after as the barrier: the turn is taken once the list's end comes back. */
    const withFront = async (app: string, session: Outside): Promise<void> => {
      expect(await tellDevices(d.dataDir, { type: 'front', app })).toBe(true)
      dial.send({ t: 'focus', agentId: session.id })
      const since = dial.messages.length
      dial.send({ t: 'agents.list' })
      await dial.next((m) => m.t === 'agents.end', 45_000, 'the list after the turn', since)
    }
    /** The person types [text] to [session] and its turn runs to its end: the summary the dial got for it. */
    const turn = async (session: Outside, text: string, stops: number): Promise<DialMessage> => {
      const started = dial.messages.length
      session.type(text)
      await dial.next((m) => m.t === 'turn.started' && m.agentId === session.id, 45_000, 'its turn started', started)
      await until('its Stop hook', () => session.ran(d, 'Stop', stops) || null, 60_000, 100)
      await session.idle(d)
      return dial.next((m) => m.t === 'summary' && m.agentId === session.id, 60_000, 'its answer', started)
    }
    const items = (m: DialMessage) => (m.items ?? []) as Array<Record<string, unknown>>

    // The person there: the turn end draws the tile alone, and the notice is a drawer row, never asked.
    await withFront('ghostty', there)
    expect(await turn(there, 'first', 1)).toMatchObject({ tier: 'silent' })
    await until('the silent end in the daemon\'s log', () => d.log().includes('[cable] notify · silent · rule:present · present · 0ms'), 30_000, 50)
    const quiet = dial.messages.length
    const line = 'Waiting · PRIVATE_LINE_CANARY needs the VPN · Suggest: connect it'
    expect(await notify(caller(there), join(d.projectsDir, there.folder),
      ['PRIVATE_LINE_CANARY needs the VPN', '--suggest', 'connect it', '--waiting'])).toMatchObject({ code: 0, out: 'shown' })
    const drawer = await dial.next((m) => m.t === 'notif.replace' && items(m).some((item) => item.agentId === there.id), 45_000, 'the row', quiet)
    expect(items(drawer).find((item) => item.agentId === there.id)).toMatchObject({ question: true, summary: line })
    // The hold goes in its agent's order, a turn of the loop behind the drawer replace: the list asked first is the
    // barrier before the row is opened.
    let since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the list', since)
    since = dial.messages.length
    dial.send({ t: 'question.read', agentId: there.id, requestId: 'read-quiet' })
    expect(await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-quiet', 45_000, 'the row read', since))
      .toMatchObject({ ok: true, questions: [{ key: 'notice', q: line, options: ['In Ghostty'] }] })
    expect(dial.messages.slice(quiet).filter((m) => m.t === 'question' && m.agentId === there.id)).toEqual([])
    await until('the quiet notice in the daemon\'s log', () => d.log().includes('[device] notify · claude · shown · waiting · present'), 30_000, 50)
    await turn(there, 'connected', 2)

    // Another app in front: the same notice rings.
    await withFront('kitty', away)
    await turn(away, 'first', 1)
    const rung = dial.messages.length
    expect(await notify(caller(away), join(d.projectsDir, away.folder), ['PRIVATE_RING_CANARY needs a key', '--waiting']))
      .toMatchObject({ code: 0, out: 'shown' })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === away.id, 45_000, 'the ring', rung))
      .toMatchObject({ id: expect.stringMatching(/^shown:/) })
    away.type('connected')

    // The person there mid-turn: the notice is held quiet. Once they go to another app, its turn's end asks it, and the
    // end itself makes no second sound.
    await withFront('ghostty', left)
    const held = dial.messages.length
    left.type('!until left-turn')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === left.id, 45_000, 'its turn started', held)
    expect(await notify(caller(left), join(d.projectsDir, left.folder), ['PRIVATE_LEFT_CANARY needs the VPN', '--waiting']))
      .toMatchObject({ code: 0, out: 'shown' })
    const row = await dial.next((m) => m.t === 'notif.replace' && items(m).some((item) => item.agentId === left.id), 45_000, 'its row', held)
    expect(items(row).find((item) => item.agentId === left.id)).toMatchObject({ question: true })
    // The list asked after the turn to another app is the barrier: the hold, a turn of the loop behind the row, is in.
    await withFront('kitty', left)
    expect(dial.messages.slice(held).filter((m) => m.t === 'question' && m.agentId === left.id)).toEqual([])
    const silentEnds = (): number => d.log().split('\n').filter((entry) => entry.includes('[cable] notify · silent · rule:notice · notice · 0ms')).length
    const before = silentEnds()
    const released = dial.messages.length
    writeFileSync(join(d.engineConfig.root, 'left-turn.release'), '')
    expect(await dial.next((m) => m.t === 'question' && m.agentId === left.id, 60_000, 'the rouse', released))
      .toMatchObject({ id: expect.stringMatching(/^shown:/) })
    expect(await dial.next((m) => m.t === 'summary' && m.agentId === left.id, 60_000, 'its answer', released))
      .toMatchObject({ tier: 'silent' })
    await until('the silent end in the daemon\'s log', () => silentEnds() > before || null, 30_000, 50)
    await left.idle(d)
    await turn(left, 'connected', 2)

    // The person in another app: a second look at the fourth session's stop, and its notice in the turn the yes holds.
    const look = await Outside.start(d, 'PRIVATE_LOOK_CANARY', { TERM_PROGRAM: 'ghostty' })
    outsides.push(look)
    await dial.next((m) => m.t === 'agent' && m.id === look.id, 45_000, 'the fourth outside session listed')
    // The hook sends each report from a process of its own; the test's share one kept-alive connection, which the listener
    // allows a nudge a second: one refused so is sent again.
    const report = (ask: boolean) => until('the report taken', async () => {
      const answer = await askDevices(d.dataDir, { type: 'nudge', engine: 'claude', sessionId: look.sessionId, ask })
      return answer === 429 ? null : answer
    }, 10_000, 200)
    /** The person types [text] to it, and its Stop hook runs a [stops]th time: its stop, which waits for its report. */
    const stopped = async (text: string, stops: number): Promise<void> => {
      look.type(text)
      await until('its Stop hook', () => look.ran(d, 'Stop', stops) || null, 60_000, 100)
    }
    await withFront('kitty', look)
    await turn(look, 'first', 1)
    expect(await report(false)).toEqual({ nudge: false })
    await stopped('second', 2)
    expect(await report(true)).toEqual({ nudge: true })
    expect(await notify(caller(look), join(d.projectsDir, look.folder), ['PRIVATE_LOOK_CANARY needs a key', '--waiting']))
      .toMatchObject({ code: 0, out: 'shown' })
    // The person's answer: the hold ends, and that turn's stop is told once its report came.
    const answered = dial.messages.length
    await stopped('connected', 3)
    expect(await report(false)).toEqual({ nudge: false })
    await dial.next((m) => m.t === 'summary' && m.agentId === look.id, 60_000, 'its answer', answered)

    // Claude Code's skill is written because the case's Harness Claude agent is listed (cable/dialHomeSetup.ts).
    const skill = { dial_notice_installation_days: 1, dial_notice_claude_installation_days: 1,
      dial_skill_claude_installation_days: 1, dial_skill_codex_installation_days: 1, dial_notice_claude: 4,
      dial_notice_shown: 4, dial_notice_waiting: 4, dial_notice_answered_10m: 4, dial_notice_present: 2,
      dial_notice_present_answered_10m: 2, dial_notice_present_roused: 1, dial_nudge_claude: 1, dial_nudge_claude_rang: 1 }
    const expected = { dial_connected_installation_days: 1, dial_used_installation_days: 1,
      dial_engine_claude_installation_days: 1, dial_host_harness_installation_days: 1, dial_open_ok: 1, ...skill }
    await until('the devices to write the day', () => {
      if (!existsSync(usageFile())) return null
      const counts = (JSON.parse(readFileSync(usageFile(), 'utf8')) as { days: Record<string, Record<string, number>> }).days[day] ?? {}
      // Three waits, the two rung notices' and the roused one's: the quiet one never asked opened none.
      const waits = Object.entries(counts).filter(([metric]) => metric.startsWith('dial_wait_')).reduce((n, [, value]) => n + value, 0)
      return (Object.entries(expected).every(([metric, value]) => counts[metric] === value) && waits === 3) || null
    }, 30_000, 500)
    // The gateway's tick took the day into its queue, which the restart keeps.
    await until('the gateway to take the day', () => taken(day).dial_open_ok === 1 || null, TAKEN_MS, 1_000)

    await desk.unplug(SERIAL)
    await d.restart()
    const client = await openWindow()
    window = client
    await until('the agent back after the restart', async () => {
      const rows = (await client.request('agents_list', { includeStopped: true })).agents as Array<Record<string, unknown>>
      return rows.some((a) => a.id === agentId && a.status === 'active') || null
    }, 60_000, 500)
    await plugTurnTap(client)
    // The second tap is the restart's own news: once it is reported, the restarted gateway has sent the day.
    await until('the restart\'s tap reported', () => sum('dial_open_ok', day) === 2 || null, REPORTED_MS, 1_000)
    for (const metric of ['dial_connected_installation_days', 'dial_used_installation_days', 'dial_first_use_installations',
      'dial_engine_claude_installation_days', 'dial_host_harness_installation_days']) expect(sum(metric, day), metric).toBe(1)
    for (const [metric, value] of Object.entries(skill)) expect(sum(metric, day), metric).toBe(value)

    const wire = JSON.stringify(backend.productUsage!.reports)
    const file = readFileSync(usageFile(), 'utf8')
    for (const secret of ['PRIVATE_', cwd, agentId, SERIAL, MAC, machine.name, machine.machineId, machine.computerId, machine.token,
      there.sessionId, away.sessionId, left.sessionId, look.sessionId]) {
      expect(wire).not.toContain(secret)
      expect(file).not.toContain(secret)
    }
  }, 900_000)
})
