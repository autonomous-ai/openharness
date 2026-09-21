/**
 * The rules, as data and as one pure function.
 *
 * Everything about what *should* happen to a fleet lives here: no tmux, no sockets, no clock of its
 * own. `decide()` takes rows and a policy and returns a plan — one entry per row, with the rule that
 * chose it and a sentence saying why. The CLI prints that plan, the viewer draws it, `hps prune --apply`
 * executes it, and the tests assert on it. A rule nobody can simulate is a rule nobody should run,
 * which is the whole reason this file has no side effects.
 *
 * The vocabulary, kept identical everywhere:
 *   running    the engine process is alive — a normal Harness agent
 *   paused   the pane and the conversation are there, the engine process is not (the daemon's own
 *            "dormant but still viewable agent"); resuming it resumes the conversation
 *   gone     no pane left; the daemon dropped the row. History only, nothing to resume
 */

/** Shipped defaults. Every number here is a judgement, and every one of them is meant to be argued
 *  with in `hps policy` — which is why they are values in a file and not `if` statements. */
export const DEFAULT_POLICY = {
  spec: 1,
  /** Most engines running at once on one machine — a backstop, not a working limit. At 100 it only fires on a
   *  day with more harnesses going than anyone plans for; the idle rule does the everyday work. Lower it on a
   *  machine that swaps: ~300 MB each is the number to divide into your free memory. */
  runningCeiling: 100,
  /** Idle this long and the engine is paused. A day, because a day survives an overnight break: yesterday
   *  afternoon's work is still there, warm, in the morning. The first default was 4h, and on a real fleet the
   *  only thing it caught that a day does not was eight harnesses from the previous afternoon. */
  pauseAfterIdle: '1d',
  /** Idle this long and the row drops below the fold — still there under `--all`, still resumable, just
   *  not in the way. A LIST rule, not a state: an earlier version made this a `retire` verb with its own
   *  state, mark and grace window, and none of that earned its keep. */
  hideAfterIdle: '14d',
  /** A workspace that no longer exists on disk has no work left in it. */
  pauseWhenWorkspaceGone: true,
  protect: {
    /** An agent waiting on a person is not idle; it is blocked on us. */
    needsInput: true,
    /** Mid-turn. Pausing here would throw away work in flight. */
    working: true,
    /** Somebody is looking at this pane right now. */
    attached: true,
    /** Listed in `pins`. The one escape hatch the rules must never overrule. */
    pinned: true,
  },
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `"4h"`, `"90m"`, `"14d"`, `"1w"`, or a plain number of milliseconds. Throws on anything else —
 *  a policy with a typo in it must fail loudly at load, not quietly pause the fleet. */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(String(value ?? '').trim().toLowerCase())
  if (!match) throw new Error(`Not a duration: ${JSON.stringify(value)}. Use 30s, 90m, 4h, 14d or 1w.`)
  return Math.floor(Number(match[1]) * UNITS[match[2]])
}

/** Round-trips `parseDuration`: the number a person typed, or the shortest exact unit for a raw ms. */
export function formatDuration(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0))
  for (const [unit, size] of [['w', UNITS.w], ['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]]) {
    if (n >= size && n % size === 0) return `${n / size}${unit}`
  }
  return `${n}ms`
}

/** Age as a person reads it in a dense table: `3d`, `4h`, `22m`, `now`. Never two units — a column
 *  that sometimes says `3d 4h` stops being scannable, and the second unit never changed a decision. */
export function humanIdle(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0))
  if (n < 45_000) return 'now'
  if (n < UNITS.h) return `${Math.round(n / UNITS.m)}m`
  if (n < UNITS.d) return `${Math.round(n / UNITS.h)}h`
  if (n < 7 * UNITS.d) return `${Math.floor(n / UNITS.d)}d`
  const weeks = Math.floor(n / UNITS.w)
  return weeks > 9 ? '9w+' : `${weeks}w`
}

function expandHome(path, home) {
  if (typeof path !== 'string' || !path) return null
  return path.startsWith('~') ? `${home}${path.slice(1)}` : path
}

/** Validate and fill in, so every consumer can read `policy.runningCeiling` without a guard. Unknown
 *  keys are kept: a policy file written by a newer Harness Monitor must survive a round trip through an older
 *  one rather than being silently rewritten without its rules. */
export function normalizePolicy(raw, { home = '' } = {}) {
  const policy = { ...DEFAULT_POLICY, ...(raw && typeof raw === 'object' ? raw : {}) }
  policy.protect = { ...DEFAULT_POLICY.protect, ...(raw?.protect && typeof raw.protect === 'object' ? raw.protect : {}) }
  const ceiling = Number(policy.runningCeiling)
  if (!Number.isInteger(ceiling) || ceiling < 0 || ceiling > 512) throw new Error('runningCeiling must be a whole number of agents between 0 and 512.')
  policy.runningCeiling = ceiling
  policy.pauseAfterIdleMs = parseDuration(policy.pauseAfterIdle)
  policy.hideAfterIdleMs = parseDuration(policy.hideAfterIdle)
  if (policy.hideAfterIdleMs < policy.pauseAfterIdleMs) {
    throw new Error('hideAfterIdle must be at least pauseAfterIdle — a row cannot drop out of the list before it is even paused.')
  }
  return policy
}

/** Why this row cannot be touched, or null. Order is the order a person would say them in. */
export function protectionFor(row, policy) {
  const p = policy.protect
  if (p.pinned && row.pinned) return { by: 'pinned', why: 'pinned' }
  if (p.needsInput && row.needsInput) return { by: 'needsInput', why: 'waiting on you' }
  if (p.working && row.working) return { by: 'working', why: 'mid-turn' }
  if (p.attached && row.attached) return { by: 'attached', why: 'you are looking at it' }
  return null
}

/** The threshold as the person wrote it (`14d`), not as the clock reads it back (`2w`): a message that
 *  echoes a different unit than the policy file does reads like a second, unexplained rule. */
function said(policy, key) {
  const raw = policy[key]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : formatDuration(policy[`${key}Ms`])
}

const RUNNING = new Set(['running'])

/**
 * The plan. One entry per row, in the order given, plus the rules' own totals.
 *
 * `action` is what the row should become: `pause` or `keep`. Nothing here decides
 * how — `pause.mjs` owns the mechanics, and `forget` never means deleting a transcript.
 */
export function decide(rows, rawPolicy, { now = Date.now(), home = '' } = {}) {
  const policy = rawPolicy?.pauseAfterIdleMs ? rawPolicy : normalizePolicy(rawPolicy, { home })
  const entries = []
  const keep = (row, why, extra = {}) => ({ id: row.id, name: row.name, action: 'keep', rule: 'keep', why, ...extra })

  for (const row of rows) {
    const idle = Math.max(0, Number(row.idleMs) || 0)
    if (row.state === 'gone') {
      const goneFor = Math.max(0, now - (row.stateSince ?? now))
      entries.push(goneFor >= policy.forgetAfterRetiredMs
        ? { id: row.id, name: row.name, action: 'forget', rule: 'gone', why: `no pane left, and gone for ${humanIdle(goneFor)} — drop it from the hps (its transcript stays where the engine wrote it)` }
        : keep(row, 'no pane left; kept in history for now'))
      continue
    }
    // Another machine's harness is shown, never planned: signals and panes are local to this computer.
    if (row.local === false) { entries.push(keep(row, `on ${row.machine || 'another machine'}`)); continue }

    // A shell somebody opened is not an agent: no conversation, nothing to resume, no rule applies.
    if (row.state === 'terminal') { entries.push(keep(row, 'a shell, not an engine — nothing to pause')); continue }

    const protection = protectionFor(row, policy)
    if (protection) {
      entries.push(keep(row, protection.why, { protectedBy: protection.by }))
      continue
    }
    // Never plan a pause for something that could not come back: an engine the daemon cannot resume, or a
    // harness with no conversation bound yet. Known-false only — a row that does not say is not second-guessed.
    if (RUNNING.has(row.state) && row.resumable === false) {
      entries.push(keep(row, row.sessionId ? `the daemon cannot resume ${row.engine}` : 'no conversation bound yet, so nothing to resume'))
      continue
    }
    if (policy.pauseWhenWorkspaceGone && row.workspaceGone && RUNNING.has(row.state)) {
      entries.push({ id: row.id, name: row.name, action: 'pause', rule: 'workspaceGone', why: `its folder is gone (${row.cwd || 'unknown'})`, frees: row.rssBytes ?? 0 })
      continue
    }
    if (RUNNING.has(row.state) && idle >= policy.pauseAfterIdleMs) {
      entries.push({ id: row.id, name: row.name, action: 'pause', rule: 'pauseAfterIdle', why: `idle ${humanIdle(idle)}, past ${said(policy, 'pauseAfterIdle')}`, frees: row.rssBytes ?? 0 })
      continue
    }
    entries.push(keep(row, RUNNING.has(row.state) ? `active ${humanIdle(idle)} ago` : 'paused'))
  }

  // The ceiling runs last, over whatever is still running after the idle rules. Protected rows hold a
  // slot but are never paused: a person with 20 pinned agents has said what they want, and a rule
  // that overruled that would make pinning worthless. Freshest activity keeps its slot (LRU out).
  // The ceiling is per machine, so it counts only this machine's harnesses — and only those can be paused.
  const survivors = rows.filter((row, i) => RUNNING.has(row.state) && row.local !== false && entries[i].action === 'keep')
  const byId = new Map(rows.map((row, i) => [row.id, entries[i]]))
  const ranked = [...survivors].sort((a, b) => (a.idleMs ?? 0) - (b.idleMs ?? 0))
  let slots = policy.runningCeiling
  for (const row of ranked) {
    if (slots > 0) { slots -= 1; continue }
    const entry = byId.get(row.id)
    if (entry.protectedBy) continue
    entry.action = 'pause'
    entry.rule = 'runningCeiling'
    entry.why = `over the ceiling of ${policy.runningCeiling} running, and the least recently active (idle ${humanIdle(row.idleMs ?? 0)})`
    entry.frees = row.rssBytes ?? 0
  }

  return { policy, entries, totals: totals(entries, rows) }
}

function totals(entries, rows) {
  const rss = new Map(rows.map((row) => [row.id, Number(row.rssBytes) || 0]))
  const count = (action) => entries.filter((entry) => entry.action === action).length
  const frees = entries.filter((entry) => entry.action === 'pause')
    .reduce((sum, entry) => sum + (rss.get(entry.id) || 0), 0)
  const runningNow = rows.filter((row) => row.state === 'running' && row.local !== false).length
  return {
    rows: rows.length,
    pause: count('pause'),
    keep: count('keep'),
    runningNow,
    runningAfter: runningNow - entries.filter((e) => e.action === 'pause' && rows.find((r) => r.id === e.id)?.state === 'running').length,
    frees,
  }
}

/** What a policy would do, without saying it will: the shape the viewer's draggable thresholds and
 *  `hps policy --simulate` both read. Same code path as `gc`, so the preview cannot drift. */
export function simulate(rows, policy, options) {
  const plan = decide(rows, policy, options)
  return { ...plan.totals, plan: plan.entries.filter((entry) => entry.action !== 'keep') }
}
