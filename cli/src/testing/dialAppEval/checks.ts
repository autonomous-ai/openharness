// The dial eval's check evaluators: pure functions from what a driver saw to scores (docs/plans/2026-11-21-dial-app-eval-plan.md,
// Task 5). Evidence names session keys and times only, never a title, a folder or spoken text, and lists only what was
// observed: a driver that observes nothing leaves it empty, so its probes fail.
import { windowClasses } from '../../cable/hosts/frontApp.js'
import { APP_BUNDLES } from '../../cable/hosts/hostDetect.js'
import { observedTitle } from '../../cable/hosts/observedTitle.js'
import { WINDOWS_APPS } from '../../cable/hosts/windowsRaise.js'
import { CAROUSEL_TILES } from '../dialCarousel.js'
import { agentIdOf, PAGE, THRESHOLDS, type App, type Check, type CheckResult, type Platform, type Scenario, type Seen,
  type SessionDef, type SessionKey, type Tier, type Until, type WrongSend } from './types.js'

/** A failing check's evidence stays readable in the report, however long the scenario ran. */
const MAX_EVIDENCE = 20

/** [full, half], inclusive (≤); never seen scores 0. */
export function graded(value: number | null, threshold: readonly [number, number]): 0 | 0.5 | 1 {
  if (value === null) return 0
  return value <= threshold[0] ? 1 : value <= threshold[1] ? 0.5 : 0
}

interface Part { part: string; score: number; timed: boolean; ms?: number | null; evidence: string[] }
/** A check's window: from its `after` step (inclusive, as a step's own reaction lands at its time) to its `at` step. */
interface Window { from: number; to: number }
interface Ring { at: number; page: string; rows: Array<{ id: string; name: string }> }

type CheckOf<K extends Check['kind']> = Extract<Check, { kind: K }>

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole)
const bounded = (lines: string[]): string[] =>
  lines.length <= MAX_EVIDENCE ? lines : [...lines.slice(0, MAX_EVIDENCE), `… ${lines.length - MAX_EVIDENCE} more`]
/** Session keys on one line, as many as lines a check may give: a ring of 2,000 rows stays one readable line. */
const keyList = (keys: string[]): string => bounded(keys).join(' ')

class World {
  private readonly keys = new Map<string, SessionKey>()

  constructor(readonly scenario: Scenario, readonly seen: Seen) {
    for (const s of scenario.sessions) this.keys.set(agentIdOf(s), s.key)
  }

  session(key: SessionKey): SessionDef {
    const found = this.scenario.sessions.find((s) => s.key === key)
    if (!found) throw new Error(`scenario ${this.scenario.id} names no session ${key}`)
    return found
  }

  /** A row's session key; an id the scenario does not know is never printed, as it may be the machine's. */
  keyOf(agentId: string | null): string {
    return agentId === null ? 'none' : this.keys.get(agentId) ?? 'other'
  }

  stepAt(label: string): number | undefined {
    return this.seen.steps.find((s) => s.label === label)?.at
  }

  /** Undefined while a step it names has not run: nothing it measures was seen. */
  window(check: Check): Window | undefined {
    const from = check.after === undefined ? 0 : this.stepAt(check.after)
    const to = check.at === undefined ? Infinity : this.stepAt(check.at)
    return from === undefined || to === undefined ? undefined : { from, to }
  }

  /**
   * Only whole lists count: a list with no `agents.end`, or one a second `agents.begin` replaced, is never read, as the
   * firmware does not read it. Its page is the last `apps` frame's, which each push sends before its ring.
   */
  rings(): Ring[] {
    const rings: Ring[] = []
    let page = ''
    let building: Ring['rows'] | undefined
    for (const { at, message } of this.seen.frames) {
      if (message.t === 'apps') page = typeof message.shown === 'string' ? message.shown : ''
      else if (message.t === 'agents.begin') building = []
      else if (message.t === 'agent' && building && typeof message.id === 'string') {
        building.push({ id: message.id, name: typeof message.name === 'string' ? message.name : '' })
      } else if (message.t === 'agents.end' && building) {
        rings.push({ at, page, rows: building })
        building = undefined
      }
    }
    return rings
  }

  /** Each step that ran before `to`, with the scenario's step. */
  stepsBefore(to: number): Scenario['steps'] {
    return this.seen.steps.filter((s) => s.at < to).map((s) => this.scenario.steps[s.index]!)
  }
}

const within = (at: number, w: Window): boolean => at >= w.from && at < w.to

function ringParts(check: CheckOf<'ring'>, world: World, w: Window | undefined): Part[] {
  const expected = check.expect.map((key) => agentIdOf(world.session(key)))
  const page = PAGE[check.page]
  const all = world.rings()
  const lists = w ? all.filter((r) => r.page === page && within(r.at, w)) : []
  const last = lists.at(-1)
  const right = (r: Ring): boolean => {
    const ids = new Set(r.rows.map((row) => row.id))
    return expected.every((id) => ids.has(id)) && r.rows.length === new Set(expected).size && ids.size === r.rows.length
  }
  const changed = w && check.timed ? lists.find(right) : undefined
  const change = changed && w ? changed.at - w.from : null
  const parts: Part[] = []
  const evidence: string[] = []
  if (!last) {
    if (all.length > 0) evidence.push(`no whole list on ${page} in the window; ${all.length} whole lists seen`)
    for (const part of ['recall', 'precision', 'order', 'names', 'cap', 'archived']) parts.push({ part, score: 0, timed: false, evidence })
  } else {
    const ids = last.rows.map((r) => r.id)
    const unique = new Set(ids)
    evidence.push(`list at ${last.at} on ${page}: ${ids.length} rows ${keyList(ids.map((id) => world.keyOf(id)))}`.trimEnd())
    // Over the rows the list has: a missing row is recall's to lose, not names'.
    const present = check.expect.filter((key) => unique.has(agentIdOf(world.session(key))))
    const right = present.filter((key) => {
      const row = last.rows.find((r) => r.id === agentIdOf(world.session(key)))
      return row!.name === observedTitle(titleOf(world, key, w!.to))
    })
    const misnamed = present.filter((key) => !right.includes(key))
    if (misnamed.length > 0) evidence.push(`names wrong: ${keyList(misnamed)}`)
    const archived = [...archivedBefore(world, w!.to)].filter((key) => unique.has(agentIdOf(world.session(key))))
    if (archived.length > 0) evidence.push(`archived rows: ${keyList(archived)}`)
    const scored: Array<[string, number]> = [
      ['recall', ratio(expected.filter((id) => unique.has(id)).length, expected.length)],
      // A duplicate or an unknown id is an extra row: only one row per expected id is right.
      ['precision', ratio(new Set(ids.filter((id) => expected.includes(id))).size, ids.length)],
      ['order', ratio(expected.filter((id, i) => ids[i] === id).length, expected.length)],
      ['names', ratio(right.length, present.length)],
      ['cap', ids.length <= CAROUSEL_TILES ? 1 : 0],
      ['archived', archived.length === 0 ? 1 : 0],
    ]
    for (const [part, score] of scored) parts.push({ part, score, timed: false, evidence })
  }
  if (check.apart) parts.push(apartPart(check.apart, page, world, w))
  if (check.timed) {
    const lines = changed ? [`first right list at ${changed.at}`] : evidence
    parts.push({ part: 'change', score: graded(change, THRESHOLDS.ringChange), timed: true, ms: change, evidence: lines })
  }
  return parts
}

/**
 * The last `apps` frame in the window on the ring's page: its other pages count exactly the sessions apart, no fewer (one
 * merged into the ring) and no more (one shown twice). Counts name no session, so a check apart from no other is exact.
 */
function apartPart(apart: SessionKey[], page: string, world: World, w: Window | undefined): Part {
  const frame = w ? world.seen.frames.filter((f) => f.message.t === 'apps' && f.message.shown === page && within(f.at, w)).at(-1) : undefined
  const apps = Array.isArray(frame?.message.apps) ? frame.message.apps as Array<{ id?: unknown; count?: unknown }> : []
  const counts = apps.map((a) => ({ id: String(a.id), count: typeof a.count === 'number' ? a.count : 0 }))
  const elsewhere = counts.filter((a) => a.id !== page).reduce((sum, a) => sum + a.count, 0)
  const evidence = frame ? [`apps at ${frame.at}: ${counts.map((a) => `${a.id} ${a.count}`).join(', ')}`.trimEnd()] : []
  return { part: 'apart', score: elsewhere === apart.length ? 1 : 0, timed: false, evidence }
}

/** The title a row should carry at `to`: the latest `codex.write` that renamed it before then, else the fixture's. */
function titleOf(world: World, key: SessionKey, to: number): string {
  let title = world.session(key).title
  for (const step of world.stepsBefore(to)) {
    if (step.kind === 'codex.write' && step.names && Object.hasOwn(step.names, key)) title = step.names[key]!
  }
  return title
}

/** Sessions the latest write before `to` left archived: a later write of the session unarchives it. */
function archivedBefore(world: World, to: number): Set<SessionKey> {
  const archived = new Set<SessionKey>()
  for (const step of world.stepsBefore(to)) {
    if (step.kind === 'claude.write') {
      for (const key of step.sessions) {
        if (step.archived) archived.add(key)
        else archived.delete(key)
      }
    } else if (step.kind === 'codex.write') {
      for (const key of step.sessions) archived.delete(key)
      for (const key of step.archived ?? []) archived.add(key)
    }
  }
  return archived
}

function focusParts(check: CheckOf<'focus'>, world: World, w: Window | undefined): Part[] {
  const id = agentIdOf(world.session(check.session))
  const faces = w ? world.seen.faces.filter((f) => f.at < w.to) : []
  const after = w ? faces.filter((f) => f.at >= w.from) : []
  // The face as the window opens, then each one in it.
  const start = w ? faces.filter((f) => f.at < w.from).at(-1) : undefined
  const evidence = bounded([...(start ? [start] : []), ...after].map((f) => `face at ${f.at}: ${world.keyOf(f.active)}`))
  const last = faces.at(-1)
  // A face on the session as the window opens has landed at its start: what it does from then on is judged.
  const already = start?.active === id
  const landing = already ? 0 : after.findIndex((f) => f.active === id)
  const latency = !w || landing < 0 ? null : already ? 0 : after[landing]!.at - w.from
  const parts: Part[] = [
    { part: 'lands', score: last?.active === id ? 1 : 0, timed: false, evidence },
    { part: 'latency', score: graded(latency, THRESHOLDS.follow), timed: true, ms: latency, evidence },
  ]
  if (check.noBounce) {
    const bounced = landing >= 0 && after.slice(landing).some((f) => f.active !== null && f.active !== id)
    parts.push({ part: 'noBounce', score: landing >= 0 && !bounced ? 1 : 0, timed: false, evidence })
  }
  return parts
}

function stillParts(check: CheckOf<'still'>, world: World, w: Window | undefined): Part[] {
  const faces = w ? world.seen.faces.filter((f) => f.at < w.to) : []
  // A dial whose face was never seen is not shown still: a driver that sees nothing passes nothing.
  if (!w || faces.length === 0) return [{ part: 'still', score: 0, timed: false, evidence: [] }]
  // The window opens on the face before it: one that moves at its first ms moved.
  const start = faces.filter((f) => f.at < w.from).at(-1)
  let was = start?.active ?? null
  // Inclusive of its last ms, as every mark here is, but not of the step that closes the window (`at`): that step's own
  // move is the person's, not the dial's. Moving is leaving a tile, for another or for none: the first landing from no
  // tile, when the ring arrives, is not.
  const moved = faces.filter((f) => f.at >= w.from && f.at <= w.from + check.ms).filter((f) => {
    const left = was !== null && f.active !== was
    was = f.active
    return left
  })
  // The face held, the first seen when none came before the window, then each move.
  const held = start ?? faces[0]!
  const evidence = bounded([held, ...moved].map((f) => `face at ${f.at}: ${world.keyOf(f.active)}`))
  return [{ part: 'still', score: moved.length === 0 ? 1 : 0, timed: false, evidence }]
}

/** Each app's link scheme: the ChatGPT app's threads are Codex's. */
const SCHEMES: Readonly<Record<App, string>> = { claude: 'claude://', chatgpt: 'codex://' }

/** The session's own link: the Claude app opens its store's `local_` id, the ChatGPT app the Codex thread. */
function linkOf(session: SessionDef): string | undefined {
  if (session.app === 'chatgpt') return `${SCHEMES.chatgpt}threads/${session.id}`
  return session.localId && `${SCHEMES.claude}code/continue?session=${session.localId}`
}

/**
 * Whether a command brings the session's app to the front (the eval sees commands, not windows), in the form the
 * devices run it on each platform, or tier A records it (tierA/world.ts):
 * - macOS: `open -b <the app's bundle> [<link>]`.
 * - Linux: `xdg-open <the session's link>`, or `raise [<pid>] [<app id>]`, tier A's record of linuxRaise's call. A raise
 *   counts only naming the session's app, by its app id or one of its window classes (frontApp.ts windowClasses): a pid
 *   alone does not, as the eval is told no session's process.
 * - Windows: `harness-pty open-link <the session's link>`, or `harness-pty raise` naming the app, by its bundle (tier
 *   A's record of windowsRaise.app) or by `--exe <its program>` (the helper's own form, windowsRaise.ts), any case.
 */
function fronts(argv: string[], platform: Platform, app: App, link: string | undefined): boolean {
  const exe = (argv[0] ?? '').split(/[\\/]/).at(-1)!.replace(/\.exe$/, '')
  const id = PAGE[app]
  const bundle = APP_BUNDLES[id]!
  switch (platform) {
    case 'darwin': return argv.some((a, i) => a === '-b' && argv[i + 1] === bundle)
    case 'linux': return (exe === 'xdg-open' && link !== undefined && argv.includes(link))
      || (exe === 'raise' && argv.slice(1).some((a) => a === id || windowClasses(id).includes(a)))
    case 'win32': {
      const program = WINDOWS_APPS[bundle]!.toLowerCase()
      return exe === 'harness-pty' && ((argv[1] === 'open-link' && link !== undefined && argv[2] === link)
        || (argv[1] === 'raise' && (argv[2] === bundle || (argv[2] === '--exe' && argv[3]?.toLowerCase() === program))))
    }
  }
}

function openParts(check: CheckOf<'open'>, world: World, w: Window | undefined, platform: Platform): Part[] {
  const session = world.session(check.session)
  const link = linkOf(session)
  const commands = w ? world.seen.commands.filter((c) => within(c.at, w)) : []
  const linked = commands.filter((c) => link !== undefined && c.argv.includes(link))
  // A command that failed, or that hands an app a link it refuses (world.linkFails), brought nothing up, whatever it
  // names: X5's tap must bring its app up another way.
  const refused = world.scenario.world?.linkFails ?? []
  const brings = (c: Seen['commands'][number]): boolean => c.ok
    && !c.argv.some((arg) => refused.some((app) => arg.startsWith(SCHEMES[app]))) && fronts(c.argv, platform, session.app, link)
  const front = commands.find(brings)
  // The dial's inputs first, so an input that opened nothing fails with what the driver saw. Commands carry paths: the
  // evidence says only what each one was. The inputs are the scenario's own steps, which every driver records: only a
  // window in which the driver saw a command or a frame names them, so a recorder that sees nothing catches no probe.
  const heard = commands.length > 0 || (w !== undefined && world.seen.frames.some((f) => within(f.at, w)))
  const inputs = w && heard ? world.seen.steps.filter((s) => within(s.at, w)).flatMap((s) => {
    const step = world.scenario.steps[s.index]!
    return step.kind === 'tap' || step.kind === 'swipe' ? [`${step.kind} on ${step.session} at ${s.at}`] : []
  }) : []
  const evidence = bounded([...inputs, ...commands.map((c) =>
    `command at ${c.at}: ${[linked.includes(c) && 'link', brings(c) && 'front', !c.ok && 'failed'].filter(Boolean).join(' ') || 'other'}`),
  ...(inputs.length > 0 && commands.length === 0 ? ['no command'] : [])])
  const latency = front && w ? front.at - w.from : null
  return [
    ...(check.link ? [{ part: 'link', score: linked.length > 0 ? 1 : 0, timed: false, evidence }] : []),
    { part: 'front', score: front ? 1 : 0, timed: false, evidence },
    { part: 'latency', score: graded(latency, THRESHOLDS.open), timed: true, ms: latency, evidence },
  ]
}

/**
 * The row's state as the device cards set it, as HarnessSource.noteCard reads them; a restored recap is no news. Each
 * question stays up on the dial until its own close or the turn's end, as the devices keep them: a turn card sent while
 * one is open is no news either, and the close of one leaves the others asking. `open`: the row's open questions' ids.
 */
function stateAfter(message: Record<string, unknown>, open: Set<string>): string | undefined {
  const question = String(message.id ?? '')
  switch (message.t) {
    case 'turn.started': return open.size > 0 ? undefined : 'working'
    case 'question':
      open.add(question)
      return 'needs-you'
    // A close heard twice, or of a question never open, is no news.
    case 'question.close': return open.delete(question) && open.size === 0 ? 'working' : undefined
    case 'summary':
    case 'turn.done':
      if (message.restore === true) return undefined
      open.clear()
      return 'done'
    case 'turn.error':
      open.clear()
      return 'error'
  }
  return undefined
}

const STATE_MARKS = { working: THRESHOLDS.working, 'needs-you': THRESHOLDS.needsYou, done: THRESHOLDS.done } as const

function stateParts(check: CheckOf<'state'>, world: World, w: Window | undefined): Part[] {
  const session = world.session(check.session)
  const id = agentIdOf(session)
  const page = PAGE[session.app]
  const rings = world.rings().filter((r) => r.page === page)
  // Every session's changes, not only this one's: the evidence lists those in the window, so a probe on a session that
  // never changes still says what the driver saw.
  const all: Array<{ at: number; agentId: string; state: string }> = []
  const questions = new Map<string, Set<string>>()
  for (const { at, message } of world.seen.frames) {
    if (typeof message.agentId !== 'string') continue
    let open = questions.get(message.agentId)
    if (!open) questions.set(message.agentId, open = new Set())
    const next = stateAfter(message, open)
    if (next !== undefined) all.push({ at, agentId: message.agentId, state: next })
  }
  const changes = all.filter((c) => c.agentId === id)
  // Shown: at some moment in the window the row is in its page's last whole list and in that state.
  const moments = w ? [w.from, ...changes.map((c) => c.at), ...rings.map((r) => r.at)].filter((at) => within(at, w)).sort((x, y) => x - y) : []
  const shownAt = moments.find((at) => {
    const now = changes.filter((c) => c.at <= at).at(-1)?.state ?? 'idle'
    const ring = rings.filter((r) => r.at <= at).at(-1)
    return now === check.state && ring !== undefined && ring.rows.some((r) => r.id === id)
  })
  const seenChanges = w ? all.filter((c) => within(c.at, w)) : []
  const evidence = bounded(seenChanges.map((c) => `${world.keyOf(c.agentId)} ${c.state} at ${c.at}`))
  if (shownAt !== undefined) evidence.push(`${check.session} shown ${check.state} at ${shownAt}`)
  const parts: Part[] = [{ part: 'shown', score: shownAt === undefined ? 0 : 1, timed: false, evidence }]
  if (check.state !== 'idle') {
    const latency = shownAt === undefined || !w ? null : shownAt - w.from
    parts.push({ part: 'latency', score: graded(latency, STATE_MARKS[check.state]), timed: true, ms: latency, evidence })
  }
  return parts
}

function voiceParts(check: CheckOf<'voice'>, world: World, w: Window | undefined): Part[] {
  const deliveries = w ? world.seen.deliveries.filter((d) => within(d.at, w)) : []
  const mine = deliveries.filter((d) => d.target === check.session)
  const exact = mine.length > 0 && mine.every((d) => d.text === check.text)
  // What the dial was told of the voice (a refusal is a voice.error), so a voice that reached nobody says why.
  const told = w ? world.seen.frames.filter((f) => typeof f.message.t === 'string' && f.message.t.startsWith('voice.') && within(f.at, w)) : []
  // Spoken text is never printed: only whether it matched.
  const evidence = bounded([...told.map((f) => `${String(f.message.t)} at ${f.at}`), ...deliveries.map((d) =>
    `delivery at ${d.at} via ${d.path} to ${d.target ?? 'none'}${d.target === check.session ? `, text ${d.text === check.text ? 'exact' : 'differs'}` : ''}`),
  ...(told.length > 0 && deliveries.length === 0 ? ['no delivery'] : [])])
  return [
    { part: 'reached', score: mine.length > 0 ? 1 : 0, timed: false, evidence },
    { part: 'once', score: mine.length === 1 ? 1 : 0, timed: false, evidence },
    { part: 'exact', score: exact ? 1 : 0, timed: false, evidence },
  ]
}

function recapParts(check: CheckOf<'recap'>, world: World, w: Window | undefined): Part[] {
  const id = agentIdOf(world.session(check.session))
  // Every session's summaries in the window, so a probe on a session that never has one still says what was seen.
  const summaries = w ? world.seen.frames.filter((f) => f.message.t === 'summary' && within(f.at, w)) : []
  const last = summaries.filter((f) => f.message.agentId === id).at(-1)
  const exact = last?.message.text === check.text
  // The recap is the session's words: only whether it matched is printed.
  const evidence = bounded(summaries.map((f) => `summary at ${f.at} for ${world.keyOf(typeof f.message.agentId === 'string' ? f.message.agentId : null)}${
    f === last ? `, text ${exact ? 'exact' : 'differs'}` : ''}`))
  return [{ part: 'exact', score: exact ? 1 : 0, timed: false, evidence }]
}

function costParts(seen: Seen): Part[] {
  const cost = seen.cost
  const evidence = cost ? [`cpu ${cost.cpuPercent}%, loop p99 ${cost.loopP99Ms} ms, ${cost.leftovers} processes left`] : []
  return [
    { part: 'cpu', score: graded(cost?.cpuPercent ?? null, THRESHOLDS.cpuPercent), timed: true, evidence },
    { part: 'loopP99', score: graded(cost?.loopP99Ms ?? null, THRESHOLDS.loopP99Ms), timed: true, ms: cost?.loopP99Ms ?? null, evidence },
    { part: 'leftovers', score: cost?.leftovers === 0 ? 1 : 0, timed: false, evidence },
  ]
}

function partsOf(check: Check, scenario: Scenario, seen: Seen, platform: Platform): Part[] {
  const world = new World(scenario, seen)
  const w = world.window(check)
  switch (check.kind) {
    case 'ring': return ringParts(check, world, w)
    case 'focus': return focusParts(check, world, w)
    case 'still': return stillParts(check, world, w)
    case 'open': return openParts(check, world, w, platform)
    case 'state': return stateParts(check, world, w)
    case 'voice': return voiceParts(check, world, w)
    case 'recap': return recapParts(check, world, w)
    case 'cost': return costParts(seen)
  }
}

export function evaluate(check: Check, scenario: Scenario, seen: Seen, tier: Tier, platform: Platform): CheckResult[] {
  // Tier A runs in the test process: its cost would be the test runner's, so it has no D8.
  if (check.kind === 'cost' && tier === 'a') return []
  const parts = partsOf(check, scenario, seen, platform)
  const base = { tier, platform, scenario: scenario.id, app: scenario.app, dim: check.dim, heldOut: scenario.heldOut }
  // Robustness asks whether the thing still works, not how fast: one pass/fail result over its untimed parts.
  if (check.dim === 'D7') {
    const untimed = parts.filter((p) => !p.timed)
    const evidence = [...new Set(untimed.flatMap((p) => p.evidence))]
    return [{ ...base, check: check.id, score: untimed.every((p) => p.score === 1) ? 1 : 0, timed: false, evidence }]
  }
  return parts.map((p) => ({ ...base, check: `${check.id}.${p.part}`, score: p.score, timed: p.timed,
    ...(p.ms === undefined ? {} : { ms: p.ms }), evidence: p.evidence }))
}

/**
 * A wait's condition holds once every untimed part of the same check, from the scenario's start, is right; the
 * evidence is what the dial had, for a wait that reaches its limit.
 */
export function condition(until: Until, scenario: Scenario, seen: Seen): { holds: boolean; evidence: string[] } {
  // The id and dim name no result: only the parts are read, from the start.
  const world = new World(scenario, seen)
  const untimed = ringParts({ id: 'until', dim: scenario.dims[0]!, ...until }, world, { from: 0, to: Infinity }).filter((p) => !p.timed)
  return { holds: untimed.length > 0 && untimed.every((p) => p.score === 1), evidence: [...new Set(untimed.flatMap((p) => p.evidence))] }
}

/**
 * Each delivery after a voice step to anyone but that step's target; one with no known target is a wrong-session send too. A
 * delivery is the latest voice step's that spoke its words, as one can land after the next step; words no step spoke are
 * the latest step's.
 */
export function wrongSends(scenario: Scenario, seen: Seen): Array<Omit<WrongSend, 'tier' | 'platform'>> {
  const voices = seen.steps.flatMap((s) => {
    const step = scenario.steps[s.index]!
    return step.kind === 'voice' ? [{ at: s.at, step }] : []
  })
  const wrong: Array<Omit<WrongSend, 'tier' | 'platform'>> = []
  for (const d of seen.deliveries) {
    const before = voices.filter((v) => v.at <= d.at)
    const voice = (before.filter((v) => v.step.transcript === d.text).at(-1) ?? before.at(-1))?.step
    if (voice === undefined || d.target === voice.target) continue
    wrong.push({ scenario: scenario.id, target: voice.target, got: d.target, path: d.path, at: d.at })
  }
  return wrong
}
