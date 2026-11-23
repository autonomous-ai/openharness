/**
 * The goal test of docs/plans/2026-11-19-openclaw-show-goal-design.md: an OpenClaw agent walked through every state of
 * its matrix on the real daemon, and what `show`, `show --json`, `ps`, `wait` and `watch` say at each step, as a client
 * polling `show` after `new` reads them. Rows 21-27 are docs/plans/2026-11-20-openclaw-followups-design.md's: a message
 * refused into the box, a person's draft, the sign-in screens, `close`, what is pushed, a launcher that starts the TUI as
 * its child, and a daemon restart. The OpenClaw is a fake (e2e/harness/fakeOpenclaw.mjs) at `OPENCLAW_PATH`, its
 * state folder under the daemon's root: it draws only screens recorded from OpenClaw 2026.11.2 and writes the store rows
 * its recordings hold. Harness never talks to the Gateway, so the Gateway's states reach it only through that screen and
 * store, and the test sets them with the fake's steps. Signed out, no backend, no real OpenClaw, Gateway, model or
 * account. Every row runs on the real clock: what it checks is timed by the daemon's 5 s binding pass.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { fakeOpenclawScript } from './harness/fakeOpenclaw.mjs'
import { OPENCLAW_STATES, openclawLocalStopped } from '../src/engines/openclaw/contract.js'

const NAME = 'x'
const TASK = 'Say hello from the goal test'
const NOT_TAKEN = 'OpenClaw did not take the first task. Close it and start it again.'
/** The sentences docs/plans/2026-11-20-openclaw-followups-design.md fixes, byte for byte. */
const APPROVAL = 'OpenClaw is waiting for this device to be approved. Run openclaw devices approve --latest.'
const SIGN_IN_REFUSED = "OpenClaw's Gateway refused its sign-in. Its terminal says how to fix it."
const BOX_HELD = "OpenClaw's input box holds text Harness did not type. Clear it so Harness can send the message."
const NONE_KEPT = 'It had not started a conversation, so none was kept.'

type Run = { code: number; out: string; err: string }
/** A command still running, each line of its output with when it came. */
type Streamed = { lines: Array<{ at: number; text: string }>; done: Promise<Run>; stop: () => void }
type Event = { at: number } & Record<string, any>
/** One look at a harness, as a client polling it sees it: `show`, `show --json` and its `ps --json` row, read at once. */
type Look = { start: number; end: number; line1: string; text: string; json: Record<string, any>; ps: Record<string, any> | undefined }
type FakeOptions = Omit<Parameters<typeof fakeOpenclawScript>[0], 'steps' | 'events'>

/** `harness <args>` as a person's shell runs it: not a terminal, so plain text. */
function harness(d: IsolatedDaemon, args: string[]): Promise<Run> {
  return streamed(d, args).done
}

/** [harness] while it runs: `watch` is timed by when each of its lines came. */
function streamed(d: IsolatedDaemon, args: string[]): Streamed {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: Streamed['lines'] = []
  let out = '', err = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const at = Date.now()
    const whole = (out.slice(out.lastIndexOf('\n') + 1) + chunk).split('\n').slice(0, -1)
    out += chunk
    for (const text of whole) lines.push({ at, text })
  })
  child.stderr.on('data', (chunk) => { err += chunk })
  const done = new Promise<Run>((finish) => child.on('close', (code) => finish({ code: code ?? -1, out, err })))
  return { lines, done, stop: () => child.kill() }
}

/** When [done] first holds, asked every [every] ms for at most [ms], or null: a row waits so for what it then asserts,
 *  and goes on to its other claims when it never comes. */
async function soon(done: () => boolean | Promise<boolean>, ms: number, every = 100): Promise<number | null> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await done()) return Date.now()
    if (Date.now() >= deadline) return null
    await new Promise((next) => setTimeout(next, every))
  }
}

/** The input box a capture of the fake's pane shows: the lines between its last two rules. */
function boxShown(capture: string): string | null {
  const lines = capture.split('\n')
  const rules = lines.flatMap((line, i) => /^─{8,}$/.test(line.trimEnd()) ? [i] : [])
  return rules.length < 2 ? null : lines.slice(rules.at(-2)! + 1, rules.at(-1)).map((line) => line.trimEnd()).join('\n')
}

/** The events whose box (submitted, or left by Ctrl+U) holds [text] more than once. */
function twice(events: Event[], text: string): Event[] {
  return events.filter((e) => [e.submitted, e.box].some((box) => typeof box === 'string' && box.split(text).length > 2))
}

/** Its JSON, or what it said instead. */
function parsed(run: Run): Record<string, any> {
  try { return JSON.parse(run.out) } catch { return { unparsed: `${run.code} ${run.out}${run.err}`.slice(0, 300) } }
}

/** A line of a `--json` stream, or null when it does not parse. */
function lineJson(line: string): Record<string, any> | null {
  try { return JSON.parse(line) } catch { return null }
}

/** The lines of a `--json` stream that parse. */
function jsonLines(run: Run): Array<Record<string, any>> {
  return run.out.split('\n').flatMap((line) => lineJson(line) ?? [])
}

/** [name]'s row in `ps --all --json`; null when the list could not be read. */
async function listedAll(run: (...args: string[]) => Promise<Run>, name: string): Promise<Record<string, any> | undefined | null> {
  const rows = parsed(await run('ps', '--all', '--json')).harnesses
  return Array.isArray(rows) ? rows.find((h) => h.name === name) : null
}

/** The status line an idle TUI draws, connected or local. */
const IDLE = /^(?:(?:gateway )?connected|local ready) \| idle$/

/** The looks that do not say starting, in `show --json` and in `ps`, said briefly. */
function notStarting(samples: Look[], t0: number): string[] {
  return samples.filter((s) => s.json.state !== 'starting' || s.ps?.state !== 'starting')
    .map((s) => `${s.start - t0}ms show=${s.json.state ?? s.json.unparsed} ps=${s.ps?.state}`).slice(0, 5)
}

/** The looks that read idle in `show --json` or in `ps`, said briefly: none may before its first task is answered, a look
 *  that overlaps the task's hand-over included (a row whose task was taken but not yet typed once read idle there). */
function idleLooks(samples: Look[], t0: number): string[] {
  return samples.filter((s) => s.json.state === 'idle' || s.ps?.state === 'idle')
    .map((s) => `${s.start - t0}ms show=${s.json.state} ask=${s.json.ask ?? null} ps=${s.ps?.state}`).slice(0, 5)
}

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
afterEach(async () => {
  client?.close()
  client = undefined
  await daemon?.close()
  daemon = undefined
})

/** A daemon whose OpenClaw is the fake, and what a test does with them. */
async function rig(fake: FakeOptions = {}) {
  const d = daemon = await IsolatedDaemon.create()
  const steps = join(d.root, 'openclaw-steps.jsonl')
  const eventLog = join(d.root, 'openclaw-events.jsonl')
  writeFileSync(steps, '')
  writeFileSync(eventLog, '')
  d.env.OPENCLAW_PATH = join(d.root, 'bin', 'openclaw')
  d.env.OPENCLAW_STATE_DIR = join(d.root, 'openclaw')
  writeFileSync(d.env.OPENCLAW_PATH, fakeOpenclawScript({ steps, events: eventLog, ...fake }), { mode: 0o755 })
  // The root is gone by the time a failure is reported: the fake's events as the test last read them, on every look.
  let read = ''
  onTestFailed(() => {
    console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
    console.log(`---- the fake's events\n${read}`)
  })
  await d.start()
  const project = join(d.projectsDir, 'oc')
  mkdirSync(project, { recursive: true })
  const run = (...args: string[]) => harness(d, args)
  /** Every whole line the fake wrote. */
  const events = (): Event[] => {
    read = readFileSync(eventLog, 'utf8')
    return read.split('\n').slice(0, -1).map((line) => JSON.parse(line))
  }
  /** When the first event since [from] that [match] finds was written, or null. */
  const at = (match: (e: Event) => boolean, from = 0): number | null => events().find((e) => e.at >= from && match(e))?.at ?? null
  const logged = (what: string, match: (e: Event) => boolean, ms = 60_000, from = 0): Promise<number> =>
    until(what, () => at(match, from), ms, 100)
  const step = (line: Record<string, unknown>) => appendFileSync(steps, `${JSON.stringify(line)}\n`)
  const look = async (name = NAME): Promise<Look> => {
    events()
    const start = Date.now()
    const [shown, json, listed] = await Promise.all([run('show', name), run('show', name, '--json'), run('ps', '--json')])
    const rows = parsed(listed).harnesses as Array<Record<string, any>> | undefined
    return { start, end: Date.now(), line1: shown.out.split('\n')[0], text: shown.out + shown.err, json: parsed(json), ps: rows?.find((h) => h.name === name) }
  }
  /** A look begun once `show --json` said [state], which lasts: a look's three reads run at once, so in the look that
   *  first says it the others may have read before the change (row 5 on a GitHub Linux runner: `show` said starting). */
  const reached = async (state: string, what: string, ms: number, name = NAME): Promise<Look> => {
    await until(what, async () => (await look(name)).json.state === state || null, ms, 1_000)
    return look(name)
  }
  /** Looks about once a second until [done], [each] run on every look: every look, in order. Returns at [ms] all the
   *  same, so a row whose end never comes still has its looks checked. */
  const sample = async (done: () => boolean, ms: number, each?: (s: Look) => Promise<void> | void, name = NAME): Promise<Look[]> => {
    const deadline = Date.now() + ms
    const samples: Look[] = []
    while (!done() && Date.now() < deadline) {
      const s = await look(name)
      samples.push(s)
      await each?.(s)
      const rest = 1_000 - (Date.now() - s.start)
      if (rest > 0) await new Promise((next) => setTimeout(next, rest))
    }
    return samples
  }
  /** Looks about once a second for at most [ms] until one passes [ok]: that look, or null. */
  const lookUntil = async (ok: (s: Look) => boolean, ms: number, name = NAME): Promise<Look | null> => {
    let found: Look | null = null
    await sample(() => found !== null, ms, (s) => { if (ok(s)) found = s }, name)
    return found
  }
  /** `harness new openclaw` as the person runs it, with a task or none, once the fake TUI it starts is running. */
  const launch = async (name: string, task?: string, extra: string[] = []): Promise<void> => {
    const before = events().filter((e) => e.started).length
    const made = await run('new', 'openclaw', '--name', name, ...extra, project, ...(task === undefined ? [] : ['--', task]))
    expect(made.code, made.out + made.err).toBe(0)
    await until(`${name}'s TUI`, () => events().filter((e) => e.started).length > before || null, 60_000, 100)
  }
  /** [name]'s pane on the rig's tmux server. */
  const paneOf = async (name: string): Promise<string> => {
    const c = await LocalClient.connect(d)
    try {
      const agents = (await c.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      return agents.find((a) => a.name === name)!.tmuxPane
    } finally { c.close() }
  }
  /** What a person types into [name]'s pane, key by key (tmux `send-keys -l`): no paste. */
  const typeAsPerson = async (name: string, text: string): Promise<void> => { await d.tmux.run('send-keys', '-t', await paneOf(name), '-l', text) }
  /** A key a person presses in [name]'s pane, in tmux's words (`C-u`). */
  const keyAsPerson = async (name: string, key: string): Promise<void> => { await d.tmux.run('send-keys', '-t', await paneOf(name), key) }
  /** When the daemon's log first says [line] after [from] (an offset in it), looked at every 100 ms for [ms]; or null. */
  const logSays = (line: RegExp, from: number, ms: number): Promise<number | null> => soon(() => line.test(d.log().slice(from)), ms)
  /** A `manual` startup walked to its connection, the first message's reply set before it. */
  const begin = (next?: Record<string, unknown>) => {
    if (next) step({ next })
    for (let i = 0; i < 3; i++) step({ advance: true })
  }
  /** Once the fake took [task] and drew its answer, `wait` says idle. */
  const answered = async (task: string, name = NAME): Promise<void> => {
    const taken = await logged(`${name} took its task`, (e) => e.accepted === task, 120_000)
    await logged(`${name}'s answer`, (e) => IDLE.test(e.drawn ?? ''), 60_000, taken)
    const waited = await run('wait', name, '--timeout', '1m')
    expect(waited.code, waited.out + waited.err).toBe(0)
  }
  /** `wait <name> --timeout 3s` keeps waiting: it ends only on its timeout. */
  const keepsWaiting = async (row: string, name = NAME): Promise<void> => {
    const waited = await run('wait', name, '--timeout', '3s')
    expect.soft(waited.code, `${row}: wait keeps waiting · ${waited.out}${waited.err}`).toBe(124)
  }
  return {
    d, project, run, events, at, logged, step, look, reached, sample, lookUntil, launch, begin, answered, keepsWaiting,
    typeAsPerson, keyAsPerson, paneOf, logSays, streamed: (...args: string[]) => streamed(d, args),
  }
}

/** What every verb says of a harness that has not taken its first task yet. */
function expectStarting(s: Look, row: string, name = NAME): void {
  expect.soft(s.line1, `${row}: show`).toBe(`${name} on ${s.json.machine}: starting · OpenClaw · started by person`)
  expect.soft(s.json.state, `${row}: show --json`).toBe('starting')
  expect.soft(s.json.next?.[0]?.run, `${row}: next`).toBe(`harness wait ${name}`)
  expect.soft(s.ps?.state, `${row}: ps`).toBe('starting')
}

describe.runIf(process.platform !== 'win32')('an OpenClaw agent, through every state of show, ps, wait and watch', () => {
  it('rows 1-3: starting from its launch until it takes its first task', async () => {
    const r = await rig({ startup: 'manual' })
    const t0 = Date.now()
    await r.launch(NAME, TASK)
    const watched = r.run('watch', NAME, '--json', '--timeout', '20s')
    // Held in `sending` once taken, so a wait over the steps below never sees the run end.
    r.step({ next: { reply: 'plain', hold: 'send' } })
    // Row 1: the banner, no footer yet.
    expectStarting(await r.look(), 'row 1')
    await r.keepsWaiting('row 1')
    // Row 2: connecting, then starting up.
    r.step({ advance: true })
    await r.logged('connecting', (e) => e.drawn === 'connecting | idle')
    expectStarting(await r.look(), 'row 2, connecting')
    await r.keepsWaiting('row 2, connecting')
    r.step({ advance: true })
    await r.logged('starting up', (e) => /^\S+ starting up • /.test(e.drawn ?? ''))
    expectStarting(await r.look(), 'row 2, starting up')
    await r.keepsWaiting('row 2, starting up')
    // Row 3: connected, the task not typed yet.
    r.step({ advance: true })
    await r.logged('connected', (e) => e.drawn === 'gateway connected | idle')
    const taken = () => r.at((e) => e.accepted === TASK)
    const looks = await r.sample(() => taken() !== null, 60_000)
    expect.soft(notStarting(looks.filter((s) => s.end < (taken() ?? Infinity)), t0), 'row 3: every look before the task was taken says starting').toEqual([])
    expect.soft(idleLooks(looks, t0), 'row 3: no look reads idle').toEqual([])
    expect(taken(), 'row 3: the task taken').not.toBeNull()
    await r.keepsWaiting('row 3')
    r.step({ release: 'send' })
    expect.soft(jsonLines(await watched)[0]?.event, 'rows 1-3: watch, started at the launch, says started first').toBe('started')
  }, 240_000)

  it('row 4: a failed history load is loaded again with /session, and the task then typed once', async () => {
    const r = await rig({ startup: 'manual', history: 'fail' })
    const t0 = Date.now()
    await r.launch(NAME, TASK)
    r.begin({ reply: 'tool', quietMs: 10_000 })
    await r.logged('the history load failed', (e) => e.history === 'failed')
    const id = (await r.look()).json.id
    const taken = () => r.at((e) => e.accepted === TASK)
    const looks = await r.sample(() => taken() !== null, 90_000)
    expect.soft(notStarting(looks.filter((s) => s.end < (taken() ?? Infinity)), t0), 'row 4: every look before the task was taken says starting').toEqual([])
    expect.soft(idleLooks(looks, t0), 'row 4: no look reads idle').toEqual([])
    const reload = r.at((e) => e.command === `/session agent:main:harness-${id}`)
    expect(reload, 'row 4: /session typed').not.toBeNull()
    expect(taken(), 'row 4: the task taken').not.toBeNull()
    expect(reload!).toBeLessThan(taken()!)
    expect(r.events().filter((e) => e.accepted), 'row 4: typed once').toHaveLength(1)
    await until('row 4: working', async () => (await r.look()).json.state === 'working' || null, 30_000, 0)
    const waited = await r.run('wait', NAME, '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    expect((await r.look()).json).toMatchObject({ state: 'idle', ask: TASK })
  }, 240_000)

  it('row 5: a history that never loads fails the launch within the bound, visibly, and it can be closed', async () => {
    const r = await rig({ history: 'fail-always' })
    await r.launch(NAME, TASK)
    // The bound counts from the TUI's start at the earliest, and a pass applies it, 5 s apart.
    const started = r.at((e) => !!e.started)!
    await r.logged('row 5: the first /session', (e) => e.command?.startsWith('/session '), 60_000)
    const failed = await r.reached('failed', 'row 5: failed', started + 210_000 - Date.now())
    expect.soft(failed.text, 'row 5: show').toContain(`failed: ${NOT_TAKEN}`)
    expect.soft(failed.json.failure?.error, 'row 5: show --json').toBe('FIRST_TASK_NOT_TAKEN')
    expect.soft(failed.ps?.state, 'row 5: ps').toBe('failed')
    const waited = await r.run('wait', NAME, '--timeout', '10s')
    expect.soft(waited.code, `row 5: wait · ${waited.out}${waited.err}`).toBe(1)
    expect.soft(waited.out.trim(), 'row 5: wait').toBe(`${NAME}: failed · ${NOT_TAKEN}`)
    const sessions = r.events().filter((e) => e.command?.startsWith('/session ')).map((e) => e.at)
    expect.soft(sessions.length, 'row 5: /session at most 5 times').toBeLessThanOrEqual(5)
    // Typed on the daemon's passes, 20 s apart at least; what the paste adds in between is under a second.
    for (let i = 1; i < sessions.length; i++) expect.soft(sessions[i] - sessions[i - 1], 'row 5: /session 20 s apart').toBeGreaterThanOrEqual(19_000)
    expect(r.events().filter((e) => e.accepted), 'row 5: the task never taken').toEqual([])
    const closed = await r.run('close', NAME)
    expect(closed.code, closed.out + closed.err).toBe(0)
    // Row 23: a launch that failed kept no conversation.
    expect.soft(closed.out, "row 23: row 5's close").toContain(NONE_KEPT)
    await until('row 5: stopped', async () => (await listedAll(r.run, NAME))?.state === 'stopped' || null, 60_000, 1_000)
  }, 330_000)

  it('row 6: a first task refused while the Gateway drops is submitted again once ready, never typed twice', async () => {
    const r = await rig({ startup: 'manual' })
    const t0 = Date.now()
    await r.launch(NAME, TASK)
    r.step({ next: { reply: 'tool', quietMs: 10_000 } })
    r.step({ refuseNext: 'disconnected', historyMs: 25_000 })
    r.begin()
    const taken = () => r.at((e) => e.accepted === TASK)
    const looks = await r.sample(() => taken() !== null, 120_000)
    expect.soft(notStarting(looks.filter((s) => s.end < (taken() ?? Infinity)), t0), 'row 6: every look before the task was taken says starting').toEqual([])
    expect.soft(idleLooks(looks, t0), 'row 6: no look reads idle').toEqual([])
    const refused = r.at((e) => e.refused === 'disconnected')
    expect(refused, 'row 6: refused once').not.toBeNull()
    expect(taken(), 'row 6: the task taken').not.toBeNull()
    expect(refused!).toBeLessThan(taken()!)
    expect(r.events().filter((e) => e.accepted), 'row 6: typed once').toHaveLength(1)
    expect(r.events().filter((e) => e.submitted !== undefined && e.submitted !== TASK), 'row 6: the box never held it twice').toEqual([])
    await until('row 6: working', async () => (await r.look()).json.state === 'working' || null, 30_000, 0)
    const waited = await r.run('wait', NAME, '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
  }, 240_000)

  it('row 7: a Gateway down at the launch holds only after 10 s, and the task goes in the pass that clears it', async () => {
    const r = await rig({ startup: 'manual' })
    const t0 = Date.now()
    await r.launch(NAME, TASK)
    r.step({ next: { reply: 'tool', quietMs: 10_000 } })
    r.step({ gateway: 'down' })
    r.step({ advance: true })
    r.step({ advance: true })
    const down = await r.logged('the first refused try', (e) => e.drawn?.startsWith('gateway disconnected'))
    const connected = () => r.at((e) => e.drawn === 'gateway connected | idle')
    const taken = () => r.at((e) => e.accepted === TASK)
    let up = false
    let heldWait: Run | null = null
    // Back after the TUI's try 15 s into the outage, so its next, 31 s in, connects: the outage outlasts the hold's 10 s.
    const samples = await r.sample(() => taken() !== null, 150_000, async (s) => {
      if (!up && Date.now() >= down + 16_000) { r.step({ gateway: 'up' }); up = true }
      if (!heldWait && connected() === null && s.json.state === 'held') heldWait = await r.run('wait', NAME, '--timeout', '5s')
    })
    const held = (s: Look) => s.json.state === 'held' || s.ps?.state === 'held'
    expect.soft(samples.filter((s) => s.end < down + 10_000 && held(s)).map((s) => `${s.start - down}ms`),
      'row 7: not held before the Gateway was gone 10 s').toEqual([])
    // Held once a pass has read it gone 10 s: the first reads it within 5 s, and the next 10 s on, by the outage's 20th
    // second; the line between the TUI's tries, `disconnected` alone, is the same outage.
    const late = samples.filter((s) => s.start >= down + 21_000 && s.end < (connected() ?? Infinity))
    expect.soft(late.length, 'row 7: looks while it was gone').toBeGreaterThan(0)
    expect.soft(late.filter((s) => !(s.json.state === 'held' && s.json.needsPerson === true && s.json.namedState === OPENCLAW_STATES.noGateway
      && s.ps?.state === 'held')).map((s) => `${s.start - down}ms show=${s.json.state} ps=${s.ps?.state}`), 'row 7: held while it is gone').toEqual([])
    expect.soft(heldWait?.code, 'row 7: wait while held').toBe(3)
    expect(connected(), 'row 7: the TUI connected again').not.toBeNull()
    expect(taken(), 'row 7: the task taken').not.toBeNull()
    expect.soft(taken()! - connected()!, 'row 7: taken in the pass that clears the hold').toBeLessThan(10_000)
    // Held until the pass that reads it connected clears the hold (passes are 5 s apart): starting from then until taken.
    const reconnected = samples.filter((s) => s.start > connected()! && s.end < taken()!)
    const cleared = reconnected.findIndex((s) => s.json.state !== 'held' && s.ps?.state !== 'held')
    expect.soft(notStarting(cleared < 0 ? [] : reconnected.slice(cleared), t0), 'row 7: starting once the hold cleared').toEqual([])
    expect.soft(idleLooks(samples, t0), 'row 7: no look reads idle').toEqual([])
    expect.soft(samples.filter((s) => s.json.state === 'failed').length, 'row 7: never failed').toBe(0)
    expect(r.events().filter((e) => e.accepted), 'row 7: typed once').toHaveLength(1)
    await until('row 7: working', async () => (await r.look()).json.state === 'working' || null, 30_000, 0)
  }, 300_000)

  it('row 8: a lasting outage holds the agent throughout, with the sentence, and it is idle again after', async () => {
    const r = await rig()
    await r.launch(NAME, TASK)
    await r.answered(TASK)
    const mark = Date.now()
    r.step({ gateway: 'down' })
    const down = await r.logged('the drop', (e) => e.drawn?.startsWith('gateway disconnected'), 30_000, mark)
    const back = () => r.at((e) => e.drawn === 'gateway reconnected | idle', down)
    let up = false
    let heldWait: Run | null = null
    const samples = await r.sample(() => back() !== null, 150_000, async (s) => {
      if (!up && Date.now() >= down + 40_000) { r.step({ gateway: 'up' }); up = true }
      if (!heldWait && s.json.state === 'held') heldWait = await r.run('wait', NAME, '--timeout', '5s')
    })
    const first = samples.findIndex((s) => s.json.state === 'held')
    expect(first, 'row 8: held').toBeGreaterThanOrEqual(0)
    const sentence = OPENCLAW_STATES.noGateway
    // From the look after it: in the look whose `show --json` first says held, `show` and `ps` may have read before.
    const after = samples.slice(first + 1).filter((s) => s.end < (back() ?? Infinity))
    expect.soft(after.filter((s) => s.json.state !== 'held' || s.ps?.state !== 'held').map((s) => `${s.start - down}ms show=${s.json.state} ps=${s.ps?.state}`),
      'row 8: held until the Gateway is back').toEqual([])
    expect.soft(after.filter((s) => !s.text.includes(`\nheld: ${sentence}\n`) || s.json.next?.[0]?.tell !== `tell the person: ${sentence}`).length,
      'row 8: the sentence, and what to do').toBe(0)
    expect.soft(heldWait?.code, 'row 8: wait while held').toBe(3)
    expect.soft(heldWait?.out.trim(), 'row 8: wait while held').toBe(`${NAME}: held · ${sentence} Only the person can fix this.`)
    expect(back(), 'row 8: the Gateway back').not.toBeNull()
    await until('row 8: idle again', async () => (await r.look()).json.state === 'idle' || null, 30_000, 1_000)
  }, 300_000)

  it('row 9: a drop that reconnects within seconds holds nothing', async () => {
    const r = await rig()
    await r.launch(NAME, TASK)
    await r.answered(TASK)
    const mark = Date.now()
    r.step({ blip: 4_000 })
    // A client's wait, asked on every look, as it polls.
    const waits: Array<Promise<Run>> = []
    const samples = await r.sample(() => {
      const back = r.at((e) => e.drawn === 'gateway reconnected | idle', mark)
      return back !== null && Date.now() > back + 10_000
    }, 60_000, () => { waits.push(r.run('wait', NAME, '--timeout', '30s')) })
    expect(r.at((e) => e.drawn?.startsWith('gateway disconnected'), mark), 'row 9: the drop drawn').not.toBeNull()
    expect.soft(samples.filter((s) => s.json.state === 'held' || s.ps?.state === 'held').map((s) => `${s.start - mark}ms`), 'row 9: never held').toEqual([])
    expect.soft((await Promise.all(waits)).filter((w) => w.code === 3).map((w) => w.out.trim()), 'row 9: wait never ends on a hold').toEqual([])
  }, 240_000)

  it('row 10: a TUI with no Gateway token fails the launch where show finds it', async () => {
    const r = await rig({ noToken: true })
    await r.launch(NAME, TASK)
    const failed = await r.reached('failed', 'row 10: failed', 60_000)
    expect.soft(failed.text, 'row 10: show').toContain(`failed: ${OPENCLAW_STATES.noToken}`)
    expect.soft(failed.json.failure?.error, 'row 10: show --json').toBe('OPENCLAW_NO_TOKEN')
    expect.soft(failed.ps?.state, 'row 10: ps').toBe('failed')
    const waited = await r.run('wait', NAME, '--timeout', '10s')
    expect.soft(waited.code, `row 10: wait · ${waited.out}${waited.err}`).toBe(1)
  }, 180_000)

  it('rows 11, 12, 13, 15, 16: working through a run and a quiet tool step, then its answer, in every verb', async () => {
    const r = await rig({ startup: 'manual' })
    await r.launch(NAME, TASK)
    r.begin({ reply: 'tool', quietMs: 45_000 })
    // Rows 11, 12: from the run on screen to its end, a quiet tool step over the 30 s a working claim lasts.
    const running = await r.logged('the run', (e) => /^\S+ running • /.test(e.drawn ?? ''), 120_000)
    const ended = () => r.at((e) => e.drawn === 'connected | idle', running)
    const run = (await r.sample(() => ended() !== null, 120_000)).filter((s) => s.start > running && s.end < (ended() ?? Infinity))
    expect.soft(run.filter((s) => s.json.state !== 'working').map((s) => `${s.start - running}ms show=${s.json.state}`), 'row 11: show says working').toEqual([])
    expect.soft(run.filter((s) => s.ps?.state !== 'working').map((s) => `${s.start - running}ms ps=${s.ps?.state}`), 'row 12: ps says working through the quiet step').toEqual([])
    // Row 15: idle after it, with what it was asked and its answer.
    const waited = await r.run('wait', NAME, '--timeout', '1m')
    expect.soft(waited.code, `row 15: wait · ${waited.out}${waited.err}`).toBe(0)
    expect.soft(waited.out.trim(), 'row 15: wait').toBe(`${NAME}: idle · read it: harness show ${NAME}`)
    const idle = await r.look()
    expect.soft(idle.json.state, 'row 15: show --json').toBe('idle')
    expect.soft(idle.text, 'row 15: show').toContain(`asked: ${TASK}\nanswer (after 1 tool calls):\nprobe-ok`)
    expect.soft(idle.ps?.state, 'row 15: ps').toBe('idle')

    // Row 13: a person's message on screen, sending, before its run writes a row.
    client = await LocalClient.connect(r.d)
    const agentId = idle.json.id
    const second = 'Now say it once more'
    r.step({ next: { reply: 'plain', hold: 'send' } })
    client.send('message', { agentId, content: second })
    const sending = await r.logged('the second message taken', (e) => e.accepted === second)
    const holding = (await r.sample(() => Date.now() > sending + 12_000, 30_000)).filter((s) => s.start > sending)
    expect.soft(holding.filter((s) => s.json.state !== 'working' || s.ps?.state !== 'working')
      .map((s) => `${s.start - sending}ms show=${s.json.state} ps=${s.ps?.state}`), 'row 13: working while it sends').toEqual([])
    r.step({ release: 'send' })
    const after = await r.run('wait', NAME, '--timeout', '1m')
    expect(after.code, after.out + after.err).toBe(0)

    // Row 16: the answer after its tool calls, under a last history page of heartbeat runs only. A run shows four rows
    // (its poll, a call, its result, the reply) and a page holds 80: 30 fill the last page, and the four `show` reads reach it.
    const third = 'Run it and tell me what it printed'
    r.step({ next: { reply: 'tool', heartbeats: 30 } })
    client.send('message', { agentId, content: third })
    const taken = await r.logged('the third message taken', (e) => e.accepted === third)
    await r.logged('its answer', (e) => e.drawn === 'connected | idle', 60_000, taken)
    const done = await r.run('wait', NAME, '--timeout', '1m', '--json')
    expect.soft(done.code, `row 16: wait · ${done.out}${done.err}`).toBe(0)
    expect.soft(parsed(done).harnesses?.[0]?.state, 'row 16: wait --json').toBe('idle')
    expect.soft((await r.look()).text, 'row 16: show').toContain(`asked: ${third}\nanswer (after 1 tool calls):\nprobe-ok`)
    const watched = jsonLines(await r.run('watch', NAME, '--json', '--timeout', '10s'))
    expect.soft(watched.find((line) => line.event === 'done')?.summary, 'row 16: watch says done with its answer').toBe('probe-ok')
  }, 360_000)

  for (const [row, reply, words] of [['14', 'approval', 'exec was denied'], ['14b', 'list', '1. Retry the request'], ['17', 'fail', 'This model was not found']]) {
    it(`row ${row}: a ${reply} reply is idle with its answer, never needs the person`, async () => {
      const r = await rig({ startup: 'manual' })
      await r.launch(NAME, TASK)
      r.begin({ reply })
      const taken = await r.logged('the task taken', (e) => e.accepted === TASK, 120_000)
      const answered = () => r.at((e) => /^(?:gateway )?connected \| (?:idle|error)$/.test(e.drawn ?? ''), taken)
      const samples = await r.sample(() => {
        const at = answered()
        return at !== null && Date.now() > at + 8_000
      }, 90_000)
      expect.soft(samples.filter((s) => s.json.state === 'needs-input').map((s) => `${s.start - taken}ms`), `row ${row}: never needs the person`).toEqual([])
      const waited = await r.run('wait', NAME, '--timeout', '1m')
      expect.soft(waited.code, `row ${row}: wait · ${waited.out}${waited.err}`).toBe(0)
      const shown = await r.look()
      expect.soft(shown.json.state, `row ${row}: show --json`).toBe('idle')
      expect.soft(shown.json.answer, `row ${row}: the answer`).toContain(words)
      expect.soft(shown.ps?.state, `row ${row}: ps`).toBe('idle')
    }, 240_000)
  }

  it("row 18: a --local run whose runtime stopped is held with OpenClaw's reason", async () => {
    const r = await rig()
    const folder = join(r.d.root, 'oc-local')
    mkdirSync(folder, { recursive: true })
    await r.launch(NAME, TASK, ['--local', folder])
    await r.answered(TASK)
    r.step({ localStop: 'out of memory' })
    // An idle pane is read every 30 s (engines/openclaw/live.ts QUIET_PANE_MS), and the hold comes on that read.
    const held = await until('row 18: held', async () => {
      const s = await r.look()
      return s.json.state === 'held' ? s : null
    }, 60_000, 1_000)
    expect.soft(held.json.namedState, 'row 18: show --json').toBe(openclawLocalStopped('out of memory'))
    expect.soft(held.json.needsPerson, 'row 18: needs the person').toBe(true)
    const waited = await r.run('wait', NAME, '--timeout', '10s')
    expect.soft(waited.code, `row 18: wait · ${waited.out}${waited.err}`).toBe(3)
  }, 180_000)

  it('row 19: closed by the person, or its TUI gone, it is stopped', async () => {
    const r = await rig()
    await r.launch(NAME, TASK)
    await r.answered(TASK)
    const closed = await r.run('close', NAME)
    expect(closed.code, closed.out + closed.err).toBe(0)
    const shown = await r.reached('stopped', 'row 19: stopped', 30_000)
    expect.soft(shown.ps, 'row 19: ps hides it').toBeUndefined()
    expect.soft((await listedAll(r.run, NAME))?.state, 'row 19: ps --all shows it').toBe('stopped')
    // The person's shell keeps no record of what it closed (an agent's does, and its wait ends 0): stopped, 4.
    const waited = await r.run('wait', NAME, '--timeout', '10s')
    expect.soft(waited.code, `row 19: wait · ${waited.out}${waited.err}`).toBe(4)

    const other = 'y'
    const task = 'Say hello once more'
    await r.launch(other, task)
    await r.answered(task, other)
    r.step({ exit: 0 })
    await until('row 19: its TUI gone', async () => {
      const row = await listedAll(r.run, other)
      return row !== null && (row === undefined || row.state === 'stopped') || null
    }, 60_000, 1_000)
    const gone = await r.run('wait', other, '--timeout', '10s')
    expect.soft(gone.code, `row 19: wait on a TUI that exited · ${gone.out}${gone.err}`).toBe(4)
  }, 240_000)

  it('row 20: a launch on a Node OpenClaw cannot run on is refused', async () => {
    const r = await rig({ oldNode: true })
    const made = await r.run('new', 'openclaw', '--name', NAME, r.project, '--', TASK)
    expect(made.code, made.out + made.err).not.toBe(0)
    expect(made.out + made.err).toContain(OPENCLAW_STATES.oldNode)
    expect(await listedAll(r.run, NAME), 'row 20: none listed').toBeUndefined()
  }, 120_000)

  it("rows 21, 21b: a message refused into a box whose history did not load is cleared and sent once; a person's draft holds it", async () => {
    const r = await rig()
    await r.launch(NAME, TASK)
    await r.answered(TASK)
    client = await LocalClient.connect(r.d)
    const agentId = (await r.look()).json.id
    // Row 21: a person's message, as row 13 sends one, meets a Gateway drop and goes back into the box, and the
    // reconnect's history load fails: the pane reads no history, the message in its box.
    const told = 'Now say it once more'
    r.step({ refuseNext: 'disconnected', historyMs: 3_000, history: 'fail' })
    const mark = Date.now()
    client.send('message', { agentId, content: told })
    const failed = await r.logged("row 21: the reconnect's history load failed", (e) => e.history === 'failed', 60_000, mark)
    await soon(() => r.at((e) => e.accepted === told, mark) !== null, 60_000)
    const since = r.events().filter((e) => e.at >= mark)
    const keyed = since.filter((e) => e.keyed === 'C-u')
    expect.soft(keyed.length, 'row 21: Ctrl+U pressed').toBeGreaterThan(0)
    expect.soft(keyed.at(-1)?.box, 'row 21: Ctrl+U leaves the box empty').toBe('')
    const reload = since.find((e) => e.at > failed && e.command?.startsWith('/session '))
    expect.soft(reload?.command, 'row 21: /session').toBe(`/session agent:main:harness-${agentId}`)
    expect.soft(!!reload && keyed.length > 0 && reload.at >= keyed.at(-1)!.at, 'row 21: /session once the box is empty').toBe(true)
    expect.soft(since.filter((e) => e.accepted === told).length, 'row 21: accepted exactly once').toBe(1)
    const waited = await r.run('wait', NAME, '--timeout', '2m')
    expect.soft(waited.code, `row 21: wait · ${waited.out}${waited.err}`).toBe(0)
    expect.soft((await r.look()).json.ask, 'row 21: its answer is to the message').toBe(told)
    expect.soft(twice(r.events(), told), 'row 21: no box held it twice').toEqual([])

    // Row 21b: a pane that can send, a draft the person is typing in its box, then a message: held, the draft left as it is.
    const draft = 'a draft the person is still writing'
    const pane = await r.paneOf(NAME)
    const typed = Date.now()
    await r.typeAsPerson(NAME, draft)
    expect(await soon(async () => boxShown(await r.d.capture(pane))?.endsWith(draft) ?? false, 10_000), 'row 21b: the draft in the box').not.toBeNull()
    const second = 'Then say goodbye'
    client.send('message', { agentId, content: second })
    const heldNow = await r.lookUntil((s) => s.json.state === 'held', 15_000)
    // The look after: in the one whose `show --json` first says held, `show` and `ps` may have read before.
    const held = heldNow && await r.look()
    expect.soft(held?.text.split('\n')[1], 'row 21b: show').toBe(`held: ${BOX_HELD}`)
    expect.soft(held?.json.namedState, 'row 21b: show --json').toBe(BOX_HELD)
    expect.soft(held?.ps?.state, 'row 21b: ps').toBe('held')
    const heldWait = await r.run('wait', NAME, '--timeout', '10s')
    expect.soft(heldWait.code, `row 21b: wait · ${heldWait.out}${heldWait.err}`).toBe(3)
    expect.soft(heldWait.out.trim(), 'row 21b: wait').toBe(`${NAME}: held · ${BOX_HELD} Only the person can fix this.`)
    expect.soft(boxShown(await r.d.capture(pane)), 'row 21b: the draft as the person typed it').toBe(draft)
    expect.soft(r.events().filter((e) => e.at >= typed && (e.keyed || e.submitted !== undefined)), 'row 21b: nothing pressed or submitted in its box').toEqual([])
    // The person clears it, a Ctrl+U at a time, as they would.
    const clearing = Date.now()
    const empty = () => r.at((e) => e.keyed === 'C-u' && e.box === '', clearing)
    for (let i = 0; i < 5 && empty() === null; i++) {
      const before = r.events().length
      await r.keyAsPerson(NAME, 'C-u')
      await soon(() => r.events().slice(before).some((e) => e.keyed === 'C-u'), 5_000)
    }
    const cleared = empty()
    expect(cleared, 'row 21b: the person cleared the box').not.toBeNull()
    expect.soft(await r.lookUntil((s) => s.json.state !== 'held' && s.ps?.state !== 'held', 10_000), 'row 21b: not held once the box is empty').not.toBeNull()
    await soon(() => r.at((e) => e.accepted === second) !== null, 30_000)
    expect.soft(r.events().filter((e) => e.at >= cleared! && typeof e.submitted === 'string' && !e.submitted.startsWith('/')).map((e) => e.submitted),
      'row 21b: typed once, into the empty box').toEqual([second])
    expect.soft(r.events().filter((e) => e.accepted === second).length, 'row 21b: accepted exactly once').toBe(1)
    expect.soft(r.events().filter((e) => typeof e.submitted === 'string' && e.submitted.includes(draft)), 'row 21b: the draft never submitted').toEqual([])
  }, 480_000)

  it('row 22: each sign-in screen holds the agent with its own sentence, and a reconnect clears it at once', async () => {
    const r = await rig()
    await r.launch(NAME, TASK)
    await r.answered(TASK)
    const looks: Look[] = []
    /** The looks from [from] to [to] that do not say held with [sentence] in every verb, said briefly. */
    const notHeldWith = (sentence: string, from: number, to: number): string[] => looks.filter((s) => s.start >= from && s.end < to)
      .filter((s) => !(s.json.state === 'held' && s.json.needsPerson === true && s.json.namedState === sentence
        && s.text.split('\n')[1] === `held: ${sentence}` && s.ps?.state === 'held'))
      .map((s) => `${s.start - from}ms show=${s.json.state} namedState=${s.json.namedState} ps=${s.ps?.state}`)
    const lateLooks = (from: number, to: number) => looks.filter((s) => s.start >= from && s.end < to).length
    /** `wait` on the held agent: it needs the person, and says why. */
    const heldWait = async (row: string, sentence: string): Promise<void> => {
      const waited = await r.run('wait', NAME, '--timeout', '5s')
      expect.soft(waited.code, `${row}: wait · ${waited.out}${waited.err}`).toBe(3)
      expect.soft(waited.out.trim(), `${row}: wait`).toBe(`${NAME}: held · ${sentence} Only the person can fix this.`)
    }
    /**
     * An outage of [kind] from the drop the step makes, looked at until a look reads held, [onHeld] run then. An idle
     * pane is read every 30 s (engines/openclaw/live.ts QUIET_PANE_MS) and held from a pass that has read it gone 10 s,
     * so within 45 s of the drop: looked at for 75 s. [held] is when the first look that read held ended: in that look
     * `show` and `ps` may have read before, so the looks it must hold through are those after it.
     */
    const outage = async (row: string, kind: string, onHeld: () => Promise<void>): Promise<{ down: number; held: number }> => {
      const mark = Date.now()
      r.step({ gateway: kind })
      const down = await r.logged(`${row}: the drop`, (e) => e.drawn?.startsWith('gateway disconnected'), 30_000, mark)
      const first: { held?: Look } = {}
      looks.push(...await r.sample(() => !!first.held, 75_000, (s) => { if (s.json.state === 'held') first.held = s }))
      expect(first.held, `${row}: held within 75 s of the drop`).toBeDefined()
      await onHeld()
      return { down, held: first.held!.end }
    }
    /**
     * The Gateway up again right after the TUI draws its next refused try, so the try after, a whole backoff on, connects;
     * looked at all along, then until the hold clears. When the TUI drew its reconnect.
     */
    const back = async (row: string): Promise<number> => {
      const mark = Date.now()
      let done = false
      const sampled = r.sample(() => done, 150_000)
      let connected: number
      try {
        const tried = await r.logged(`${row}: a refused try`, (e) => e.drawn?.startsWith('gateway disconnected'), 45_000, mark)
        r.step({ gateway: 'up' })
        connected = await r.logged(`${row}: connected again`, (e) => e.drawn === 'gateway reconnected | idle', 45_000, tried)
      } finally {
        done = true
        looks.push(...await sampled)
      }
      expect.soft(await r.lookUntil((s) => s.json.state !== 'held' && s.ps?.state !== 'held', 15_000), `${row}: not held once it is back`).not.toBeNull()
      return connected
    }

    // A device the Gateway has not approved: the TUI waits for its pairing on its backoff.
    const pairing = await outage('row 22, pairing', 'pairing', () => heldWait('row 22, pairing', APPROVAL))
    const paired = await back('row 22, pairing')
    expect.soft(lateLooks(pairing.held, paired), 'row 22, pairing: looks while refused').toBeGreaterThan(0)
    expect.soft(notHeldWith(APPROVAL, pairing.held, paired), 'row 22, pairing: held with its sentence').toEqual([])

    // An identity-aware proxy that refuses its sign-in, on the same backoff; a watch begun once it reads held.
    const watch: { run?: Streamed } = {}
    const proxy = await outage('row 22, proxy', 'proxy', async () => {
      watch.run = r.streamed('watch', NAME, '--json', '--timeout', '150s')
      await heldWait('row 22, proxy', SIGN_IN_REFUSED)
    })
    const proxied = await back('row 22, proxy')
    expect.soft(lateLooks(proxy.held, proxied), 'row 22, proxy: looks while refused').toBeGreaterThan(0)
    expect.soft(notHeldWith(SIGN_IN_REFUSED, proxy.held, proxied), 'row 22, proxy: held with its sentence').toEqual([])
    // Its line after `held` comes as the hold ends, not at the watch's next look a minute on.
    const heldLine = () => watch.run?.lines.findIndex((line) => lineJson(line.text)?.event === 'held') ?? -1
    await soon(() => heldLine() >= 0 && watch.run!.lines.length > heldLine() + 1, proxied + 75_000 - Date.now(), 250)
    watch.run?.stop()
    const next = heldLine() >= 0 ? watch.run!.lines[heldLine() + 1] : undefined
    const said = watch.run?.lines.map((line) => `${line.at - proxied}ms ${lineJson(line.text)?.event}`).join(', ')
    expect.soft(!!next && next.at - proxied <= 15_000, `row 22: watch tells the hold's end within 15 s of the TUI's reconnect · ${said}`).toBe(true)

    // A token the Gateway refuses: the TUI tries no more (OpenClaw's `shouldPauseGatewayReconnect`), so it stays held.
    const token = await outage('row 22, token', 'token', () => heldWait('row 22, token', SIGN_IN_REFUSED))
    looks.push(...await r.sample(() => false, 10_000))
    expect.soft(lateLooks(token.held, Infinity), 'row 22, token: looks while refused').toBeGreaterThan(0)
    expect.soft(notHeldWith(SIGN_IN_REFUSED, token.held, Infinity), 'row 22, token: held with its sentence').toEqual([])
    expect.soft(looks.filter((s) => s.json.namedState === OPENCLAW_STATES.noGateway || s.text.includes(OPENCLAW_STATES.noGateway))
      .map((s) => `${s.start - pairing.down}ms ${s.json.state}`).slice(0, 5), 'row 22: never "Gateway is not running"').toEqual([])
  }, 600_000)

  it('rows 23, 24, 25: none kept when no task was taken; a claim, the starting minute and a paste are pushed', async () => {
    const r = await rig({ startup: 'manual' })
    client = await LocalClient.connect(r.d)
    await r.launch(NAME, TASK)
    r.begin()
    await r.answered(TASK)
    const agentId = (await r.look()).json.id
    // Row 25a: a second agent launched with no task, its TUI not past its banner, so with no session, past its minute.
    const other = 'y'
    const since = client.frames.length
    await r.launch(other)
    // Its minute counts from its TUI's start at the earliest, and a pass applies it, 5 s apart: 65 s, and the push.
    const tuiStarted = r.events().filter((e) => e.started).at(-1)!.at
    const otherId = (await r.look(other)).json.id
    const startingOver = client.waitFor((f) => f.type === 'agent_synced' && f.payload?.agent?.id === otherId && f.payload?.agent?.starting === false,
      Math.max(0, tuiStarted + 68_000 - Date.now()), 'row 25a: its starting minute over', since).then(() => Date.now(), () => null)

    // Row 25b: a paste the TUI holds at `sending`, with no row yet, is pushed as working at once.
    r.step({ next: { reply: 'plain', hold: 'send' } })
    const second = 'Now say it once more'
    const working = client.next((f) => f.type === 'agent_activity' && f.agentId === agentId && f.payload?.activity?.state === 'working', 15_000, 'row 25b: working')
      .then(() => Date.now(), () => null)
    const mark = Date.now()
    client.send('message', { agentId, content: second })
    const pasted = await r.logged('row 25b: the paste', (e) => e.submitted === second, 60_000, mark)
    const pushed = await working
    expect.soft(pushed !== null && pushed - pasted <= 2_000, `row 25b: agent_activity working within 2 s of the paste (${pushed === null ? 'none in 15 s' : `${pushed - pasted} ms`})`).toBe(true)
    r.step({ release: 'send' })
    const answeredSecond = await r.run('wait', NAME, '--timeout', '1m')
    expect(answeredSecond.code, answeredSecond.out + answeredSecond.err).toBe(0)

    // Row 24: a send its Gateway fails before the run starts: working on screen with no turn open, then no row at all.
    // A second at `sending`: each pass that reads it busy renews the claim, and the bound counts from the claim's start.
    r.step({ next: { reply: 'send-failed', sendMs: 1_000 } })
    const third = 'Say it a third time'
    const mark24 = Date.now()
    client.send('message', { agentId, content: third })
    const paste = await r.logged('row 24: the paste', (e) => e.submitted === third, 60_000, mark24)
    const watched = r.streamed('watch', NAME, '--json', '--timeout', '45s')
    const waited = await r.run('wait', NAME, '--timeout', '2m')
    const returned = Date.now()
    expect.soft(returned - paste <= 40_000, `row 24: wait returns within 40 s of the paste (${returned - paste} ms · ${waited.code} ${waited.out.trim()})`).toBe(true)
    await watched.done
    const lines = watched.lines.map((line) => ({ at: line.at, event: lineJson(line.text)?.event }))
    const workingLine = lines.findIndex((line) => line.event === 'working')
    const after = workingLine >= 0 ? lines[workingLine + 1] : undefined
    expect.soft(!!after && after.at - paste <= 40_000, `row 24: watch says what follows working within 40 s of the paste · ${lines.map((line) => `${line.at - paste}ms ${line.event}`).join(', ')}`).toBe(true)

    // Row 25a's push, then row 23: the second agent's TUI goes on, binds its session, reads idle and is closed.
    const over = await startingOver
    expect.soft(over !== null && over - tuiStarted <= 68_000, `row 25a: agent_synced with starting false within 68 s of its TUI's start (${over === null ? 'none' : `${over - tuiStarted} ms`})`).toBe(true)
    const bound = client.waitFor((f) => f.type === 'agent_synced' && f.payload?.agent?.id === otherId && !!f.payload?.agent?.sessionId, 60_000, 'row 23: its session bound', since)
    for (let i = 0; i < 3; i++) r.step({ advance: true })
    await bound
    await r.reached('idle', 'row 23: idle', 30_000, other)
    const closed = await r.run('close', other, '--json')
    expect(closed.code, closed.out + closed.err).toBe(0)
    expect.soft(parsed(closed).effect, 'row 23: close').toBe(NONE_KEPT)
    expect.soft(parsed(closed).conversationKept, 'row 23: close --json').toBe(false)
  }, 420_000)

  it('row 26: a TUI its launcher starts as a child, as OpenClaw does, is confirmed by the new-pane watcher within seconds', async () => {
    const r = await rig({ respawn: true })
    const from = r.d.log().length
    const opened = r.logSays(/\[agent\] create pane open · openclaw\b/, from, 60_000)
    const ready = r.logSays(/\[agent\] create ready · openclaw\b/, from, 90_000)
    await r.launch(NAME, TASK)
    await r.answered(TASK)
    const [open, confirmed] = await Promise.all([opened, ready])
    expect.soft(r.d.log().slice(from).split('\n').filter((line) => line.includes('create watch failed')), 'row 26: the watcher never fails').toEqual([])
    expect.soft(open !== null && confirmed !== null && confirmed - open <= 10_000,
      `row 26: create ready within 10 s of create pane open (${open === null || confirmed === null ? `pane open ${open !== null}, ready ${confirmed !== null}` : `${confirmed - open} ms`})`).toBe(true)
    expect.soft(r.events().filter((e) => e.accepted === TASK).length, 'row 26: the task taken once').toBe(1)
  }, 240_000)

  it('row 27a: a first task typed and held at sending reads starting across a daemon restart, then working, then idle', async () => {
    const r = await rig({ startup: 'manual' })
    const t0 = Date.now()
    await r.launch(NAME, TASK)
    r.begin({ reply: 'tool', quietMs: 10_000, hold: 'send' })
    const taken = () => r.at((e) => e.accepted === TASK)
    const looks = await r.sample(() => taken() !== null, 90_000)
    expect(taken(), 'row 27a: the task taken').not.toBeNull()
    await r.d.restart()
    // The new daemon's passes, before the run writes its first row.
    looks.push(...await r.sample(() => false, 20_000))
    r.step({ release: 'send' })
    expect.soft(notStarting(looks, t0), 'row 27a: every look from the launch to the release says starting').toEqual([])
    expect.soft(r.events().filter((e) => e.accepted), 'row 27a: typed once').toHaveLength(1)
    expect.soft(await r.lookUntil((s) => s.json.state === 'working', 30_000), 'row 27a: working once released').not.toBeNull()
    const waited = await r.run('wait', NAME, '--timeout', '2m')
    expect.soft(waited.code, `row 27a: wait · ${waited.out}${waited.err}`).toBe(0)
    expect.soft((await r.look()).json, 'row 27a: idle with what it was asked').toMatchObject({ state: 'idle', ask: TASK })
  }, 300_000)

  it('row 27b: a first task refused into its box before a daemon restart is sent with one Enter after it', async () => {
    const r = await rig({ startup: 'manual' })
    await r.launch(NAME, TASK)
    r.step({ next: { reply: 'tool', quietMs: 10_000 } })
    r.step({ refuseNext: 'disconnected', historyMs: 40_000 })
    r.begin()
    const refused = await r.logged('row 27b: the task refused', (e) => e.refused === 'disconnected', 120_000)
    // The daemon goes and comes back while the TUI loads its history again, the task in its box.
    await r.d.restart()
    expect(r.at((e) => e.history === 'ok', refused), 'row 27b: restarted before the TUI could send').toBeNull()
    await soon(() => r.at((e) => e.accepted === TASK) !== null, 90_000)
    expect.soft(r.events().filter((e) => e.at > refused && e.submitted !== undefined).map((e) => e.submitted),
      'row 27b: one Enter on the task in its box, nothing pasted').toEqual([TASK])
    expect.soft(r.events().filter((e) => e.accepted === TASK).length, 'row 27b: accepted once').toBe(1)
  }, 300_000)

  it('row 27c: a first task refused into a box whose history did not load, before a daemon restart, is cleared and typed once more', async () => {
    const r = await rig({ startup: 'manual' })
    await r.launch(NAME, TASK)
    r.step({ next: { reply: 'tool', quietMs: 10_000 } })
    r.step({ refuseNext: 'disconnected', historyMs: 3_000, history: 'fail' })
    r.begin()
    const failed = await r.logged("row 27c: the reconnect's history load failed", (e) => e.history === 'failed', 120_000)
    await r.d.restart()
    await soon(() => r.at((e) => e.accepted === TASK) !== null, 90_000)
    const after = r.events().filter((e) => e.at >= failed)
    const keyed = after.filter((e) => e.keyed === 'C-u')
    expect.soft(keyed.at(-1)?.box, 'row 27c: Ctrl+U leaves the box empty').toBe('')
    const reload = after.find((e) => e.command?.startsWith('/session '))
    expect.soft(!!reload && keyed.length > 0 && reload.at >= keyed.at(-1)!.at, 'row 27c: /session once the box is empty').toBe(true)
    expect.soft(after.filter((e) => typeof e.submitted === 'string' && !e.submitted.startsWith('/')).map((e) => e.submitted),
      'row 27c: typed once more, into the empty box').toEqual([TASK])
    expect.soft(r.events().filter((e) => e.accepted === TASK).length, 'row 27c: accepted once').toBe(1)
    expect.soft(twice(r.events(), TASK), 'row 27c: no box held it twice').toEqual([])
  }, 300_000)
})
