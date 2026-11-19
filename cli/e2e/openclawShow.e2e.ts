/**
 * The goal test of docs/plans/2026-11-19-openclaw-show-goal-design.md: an OpenClaw agent walked through every state of
 * its matrix on the real daemon, and what `show`, `show --json`, `ps`, `wait` and `watch` say at each step, as a client
 * polling `show` after `new` reads them. The OpenClaw is a fake (e2e/harness/fakeOpenclaw.mjs) at `OPENCLAW_PATH`, its
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

type Run = { code: number; out: string; err: string }
type Event = { at: number } & Record<string, any>
/** One look at a harness, as a client polling it sees it: `show`, `show --json` and its `ps --json` row, read at once. */
type Look = { start: number; end: number; line1: string; text: string; json: Record<string, any>; ps: Record<string, any> | undefined }
type FakeOptions = Omit<Parameters<typeof fakeOpenclawScript>[0], 'steps' | 'events'>

/** `harness <args>` as a person's shell runs it: not a terminal, so plain text. */
function harness(d: IsolatedDaemon, args: string[]): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

/** Its JSON, or what it said instead. */
function parsed(run: Run): Record<string, any> {
  try { return JSON.parse(run.out) } catch { return { unparsed: `${run.code} ${run.out}${run.err}`.slice(0, 300) } }
}

/** The lines of a `--json` stream that parse. */
function jsonLines(run: Run): Array<Record<string, any>> {
  return run.out.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
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
  /** `harness new openclaw` as the person runs it, once the fake TUI it starts is running. */
  const launch = async (name: string, task: string, extra: string[] = []): Promise<void> => {
    const before = events().filter((e) => e.started).length
    const made = await run('new', 'openclaw', '--name', name, ...extra, project, '--', task)
    expect(made.code, made.out + made.err).toBe(0)
    await until(`${name}'s TUI`, () => events().filter((e) => e.started).length > before || null, 60_000, 100)
  }
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
  return { d, project, run, events, at, logged, step, look, sample, launch, begin, answered, keepsWaiting }
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
    const failed = await until('row 5: failed', async () => {
      const s = await r.look()
      return s.json.state === 'failed' ? s : null
    }, started + 210_000 - Date.now(), 1_000)
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
    const after = samples.slice(first).filter((s) => s.end < (back() ?? Infinity))
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
    const failed = await until('row 10: failed', async () => {
      const s = await r.look()
      return s.json.state === 'failed' ? s : null
    }, 60_000, 1_000)
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
    const shown = await until('row 19: stopped', async () => {
      const s = await r.look()
      return s.json.state === 'stopped' ? s : null
    }, 30_000, 1_000)
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
})
