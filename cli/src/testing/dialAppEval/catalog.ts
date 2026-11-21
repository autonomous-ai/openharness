/**
 * The dial eval's scenarios (docs/plans/2026-11-21-dial-app-eval-design.md, "Scenarios"), one catalog both tiers run.
 * Every session is made up: titles start with "Eval ", folders with /work/eval-, ids are fixed UUIDs.
 */
import { heldOut } from './heldOut.js'
import type { App, Check, Platform, Scenario, SessionDef, SessionKey, Step, Tier } from './types.js'

const EVERY_PLATFORM: Platform[] = ['darwin', 'win32', 'linux']
export const S = 1_000
const MIN = 60 * S
/** A condition wait's limit: twice the ring's half mark, so only a dial that never gets there reaches it. */
const UNTIL_MS = 10 * S
/** How long a person looks at the face before acting on what it lists. */
const READ_MS = 1 * S
/**
 * A wait for the first list before a step that needs it: the dial has a ring of these sessions on that page. Then the
 * person reads it, their own timing and no synchronisation: an input in the instant the list lands is no person's.
 */
export const listed = (page: App, expect: SessionKey[]): Step[] => [
  { kind: 'wait', ms: UNTIL_MS, until: { kind: 'ring', page, expect } },
  { kind: 'wait', ms: READ_MS },
]

const NAMES: Readonly<Record<SessionKey, string>> = { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', z: 'Zulu' }

/** A fixed made-up UUID from the key's bytes, so each key has its own; `variant` keeps a session's two ids apart. */
function uuid(key: SessionKey, variant: '8' | '9' | 'a'): string {
  const bytes = Buffer.from(key).toString('hex')
  if (bytes.length > 12) throw new Error(`session key ${key} is longer than 6 bytes`)
  return `00000000-0000-4000-${variant}000-${bytes.padStart(12, '0')}`
}
/** A session's title, made up from its key: Eval Alpha for a, Eval T1 for t1. */
export const titleOf = (key: SessionKey): string => `Eval ${NAMES[key] ?? key.toUpperCase()}`

/** A Claude app session: its Claude Code id and its store file's id. */
export function claudeSession(key: SessionKey, ageMs: number, more: Partial<SessionDef> = {}): SessionDef {
  return { key, app: 'claude', id: uuid(key, '8'), localId: `local_${uuid(key, '9')}`, title: titleOf(key), cwd: `/work/eval-${key}`, ageMs, ...more }
}
/** A ChatGPT app thread: its Codex thread id; its Codex name is its title. */
export function thread(key: SessionKey, ageMs: number, more: Partial<SessionDef> = {}): SessionDef {
  return { key, app: 'chatgpt', id: uuid(key, 'a'), title: titleOf(key), cwd: `/work/eval-${key}`, ageMs, ...more }
}
/** Newest first, a minute apart, as the catalog's rows are unless they say otherwise. */
export const claudeSessions = (keys: SessionKey[]): SessionDef[] => keys.map((key, i) => claudeSession(key, (i + 1) * MIN))
export const threads = (keys: SessionKey[]): SessionDef[] => keys.map((key, i) => thread(key, (i + 1) * MIN))
/** `prefix` and `from`..`to`, zero-padded to `width`: keys('s', 1, 3, 2) is s01 s02 s03. */
export const keys = (prefix: string, from: number, to: number, width: number): SessionKey[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(width, '0')}`)

/** The sessions only probes name: never written or started, so a check of one fails whatever the product does. */
export const claudeGhost: SessionDef = { ...claudeSession('z', 0), ghost: true }
export const chatgptGhost: SessionDef = { ...thread('z', 0), ghost: true }

const COST: Check = { id: 'cost', kind: 'cost', dim: 'D8' }
type Def = Omit<Scenario, 'platforms' | 'tiers' | 'heldOut'> & { platforms?: Platform[]; tiers?: Tier[] }

/**
 * Every platform and both tiers unless it names them. A tier B scenario also measures its cost, so both apps have a D8
 * score (PM, 2026-11-21); tier A has none, since its cost would be the test runner's.
 */
export function scenario(def: Def, held = false): Scenario {
  const tiers = def.tiers ?? ['a', 'b']
  const cost = tiers.includes('b')
  return {
    ...def, platforms: def.platforms ?? EVERY_PLATFORM, tiers, heldOut: held,
    dims: cost ? [...def.dims, 'D8'] : def.dims,
    checks: cost ? [...def.checks, COST] : def.checks,
  }
}

const a5 = ['a', 'b', 'c', 'd', 'e']
const s30 = keys('s', 1, 30, 2)
const t8 = keys('t', 1, 8, 1)
const b2000 = keys('b', 0, 1999, 4)

export const MAIN: Scenario[] = [
  scenario({
    id: 'C1', app: 'claude', title: 'Five sessions in the app: the ring has those five, newest first, by their names',
    dims: ['D1'], sessions: [...claudeSessions(a5), claudeGhost],
    steps: [{ kind: 'claude.write', sessions: a5 }],
    checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: a5 }],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: [...a5, 'z'] }],
  }),
  scenario({
    id: 'C2', app: 'claude', title: 'A session archived in the app leaves the ring within 2 s',
    dims: ['D1', 'D7'], sessions: [...claudeSessions(['a', 'b', 'c']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a', 'b', 'c'] },
      ...listed('claude', ['a', 'b', 'c']),
      { label: 'archive', kind: 'claude.write', sessions: ['b'], archived: true },
    ],
    checks: [
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'c'], after: 'archive', timed: true },
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: ['a', 'c'] },
    ],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'c', 'z'], after: 'archive' }],
  }),
  scenario({
    id: 'C3', app: 'claude', title: 'Thirty sessions in the app: the ring keeps the newest 16',
    dims: ['D1', 'D7'], tiers: ['a'], sessions: [...claudeSessions(s30), claudeGhost],
    steps: [{ kind: 'claude.write', sessions: s30 }],
    checks: [
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: s30.slice(0, 16) },
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: s30.slice(0, 16) },
    ],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: [...s30.slice(0, 16), 'z'] }],
  }),
  scenario({
    id: 'C4', app: 'claude', title: 'A tap on a resting session opens it in the app by its link',
    dims: ['D3'], sessions: [...claudeSessions(['a']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a'] },
      ...listed('claude', ['a']),
      { label: 'tap', kind: 'tap', session: 'a' },
    ],
    checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'a', link: true, after: 'tap' }],
    probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: true, after: 'tap' }],
  }),
  scenario({
    id: 'C5', app: 'claude', title: 'Another session attached in the app in front: the dial follows within 1 s',
    dims: ['D2'], sessions: [...claudeSessions(['a', 'b']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a', 'b'] },
      { kind: 'hook', session: 'a', event: 'start' },
      { kind: 'hook', session: 'b', event: 'start' },
      ...listed('claude', ['a', 'b']),
      { kind: 'front', app: 'claude' },
      { kind: 'swipe', session: 'a' },
      { label: 'attach', kind: 'attach', session: 'b' },
    ],
    checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'attach' }],
    probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'attach' }],
  }),
  scenario({
    id: 'C6', app: 'claude', title: 'A long turn: working, then done, and the last answer is the recap',
    dims: ['D4', 'D6'], sessions: [...claudeSessions(['a']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a'] },
      { kind: 'hook', session: 'a', event: 'start' },
      { label: 'turn', kind: 'hook', session: 'a', event: 'turn-start' },
      { kind: 'wait', ms: 5 * S },
      { label: 'stop', kind: 'hook', session: 'a', event: 'turn-stop', lastAnswer: 'Eval answer one.' },
    ],
    checks: [
      { id: 'working', kind: 'state', dim: 'D4', session: 'a', state: 'working', after: 'turn' },
      { id: 'done', kind: 'state', dim: 'D4', session: 'a', state: 'done', after: 'stop' },
      { id: 'recap', kind: 'recap', dim: 'D6', session: 'a', text: 'Eval answer one.', after: 'stop' },
    ],
    probes: [{ id: 'recap', kind: 'recap', dim: 'D6', session: 'z', text: 'Eval answer one.', after: 'stop' }],
  }),
  scenario({
    id: 'C7', app: 'claude', title: 'Claude asks for a permission: the row needs you',
    dims: ['D4'], sessions: [...claudeSessions(['a', 'b']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a', 'b'] },
      { kind: 'hook', session: 'a', event: 'start' },
      { kind: 'hook', session: 'b', event: 'start' },
      { kind: 'hook', session: 'a', event: 'turn-start' },
      { label: 'ask', kind: 'hook', session: 'a', event: 'needs-input', asks: 'permission' },
    ],
    checks: [{ id: 'needsYou', kind: 'state', dim: 'D4', session: 'a', state: 'needs-you', after: 'ask' }],
    probes: [{ id: 'needsYou', kind: 'state', dim: 'D4', session: 'z', state: 'needs-you', after: 'ask' }],
  }),
  scenario({
    id: 'C8', app: 'claude', title: 'Voice on a resting session: it opens, then the exact words are sent to it once',
    dims: ['D3', 'D5'], sessions: [claudeSession('a', MIN, { resumable: true }), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a'] },
      ...listed('claude', ['a']),
      { kind: 'front', app: 'claude' },
      { kind: 'swipe', session: 'a' },
      { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
    ],
    checks: [
      { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: true, after: 'voice' },
      { id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' },
    ],
    probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
  }),
  scenario({
    id: 'C9', app: 'claude', title: 'A new session with no hook yet: a swipe reaches it, and its hook makes the two one row',
    dims: ['D3', 'D1', 'D7'], sessions: [...claudeSessions(['b', 'a']), claudeGhost],
    // The person turns from the older session to the new one and rests on it past the open's half mark; its hook comes
    // only after.
    steps: [
      { kind: 'front', app: 'claude' },
      { kind: 'claude.write', sessions: ['a', 'b'] },
      ...listed('claude', ['b', 'a']),
      { kind: 'swipe', session: 'a' },
      { label: 'swipe', kind: 'swipe', session: 'b' },
      { kind: 'wait', ms: 3 * S },
      { label: 'hook', kind: 'hook', session: 'b', event: 'start' },
    ],
    checks: [
      { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: true, after: 'swipe', at: 'hook' },
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['b', 'a'], after: 'hook' },
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: ['b', 'a'] },
    ],
    probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: true, after: 'swipe' }],
  }),
  scenario({
    id: 'C10', app: 'claude', title: 'The app quit and relaunched: the ring comes back right, no duplicate rows',
    dims: ['D7', 'D1'], sessions: [...claudeSessions(['a', 'b']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a', 'b'] },
      { kind: 'hook', session: 'a', event: 'start' },
      { kind: 'hook', session: 'b', event: 'start' },
      ...listed('claude', ['a', 'b']),
      { label: 'quit', kind: 'quit', app: 'claude' },
      { kind: 'wait', ms: 2 * S },
      { label: 'relaunch', kind: 'relaunch', app: 'claude' },
    ],
    checks: [
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: ['a', 'b'], after: 'relaunch' },
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b'], after: 'relaunch' },
    ],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b', 'z'], after: 'relaunch' }],
  }),
  scenario({
    id: 'C11', app: 'claude', title: 'The dial unplugged and plugged in again: the ring and the focused row come back',
    dims: ['D7'], sessions: [...claudeSessions(['a', 'b']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a', 'b'] },
      // The swipe needs b's row, or the replug has no focus to keep.
      ...listed('claude', ['a', 'b']),
      { kind: 'swipe', session: 'b' },
      { label: 'unplug', kind: 'unplug' },
      { kind: 'wait', ms: 3 * S },
      { label: 'replug', kind: 'replug' },
    ],
    checks: [
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: ['a', 'b'], after: 'replug' },
      { id: 'focusKept', kind: 'focus', dim: 'D7', session: 'b', after: 'replug' },
    ],
    probes: [{ id: 'focus', kind: 'focus', dim: 'D7', session: 'z', after: 'replug' }],
  }),
  scenario({
    id: 'X1', app: 'chatgpt', title: 'Three projects and eight threads: the ring in the sidebar\'s order, by Codex\'s names',
    dims: ['D1'],
    sessions: [
      thread('t1', 10 * S, { project: 'p1' }), thread('t2', 50 * S, { project: 'p1' }), thread('t3', 30 * S, { project: 'p2' }),
      thread('t4', 20 * S, { project: 'p2' }), thread('t5', 40 * S, { project: 'p3' }), thread('t6', 5 * S),
      thread('t7', 60 * S), thread('t8', 70 * S, { project: 'p3' }), chatgptGhost,
    ],
    steps: [{ kind: 'codex.write', sessions: t8, projects: ['p2', 'p1', 'p3'] }],
    // The sidebar's order (design 2026-11-19): each project in its order, newest first in it, then Recent.
    checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t4', 't3', 't1', 't2', 't5', 't8', 't6', 't7'] }],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t4', 't3', 't1', 't2', 't5', 't8', 't6', 't7', 'z'] }],
  }),
  scenario({
    id: 'X2', app: 'chatgpt', title: 'A thread opened in the app: the dial follows from the window title',
    dims: ['D2'], sessions: [...threads(['t1', 't2']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1', 't2'] },
      ...listed('chatgpt', ['t1', 't2']),
      { kind: 'front', app: 'chatgpt' },
      { kind: 'swipe', session: 't1' },
      { label: 'title', kind: 'thread', title: titleOf('t2') },
    ],
    checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 't2', after: 'title' }],
    probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'title' }],
  }),
  scenario({
    id: 'X3', app: 'chatgpt', title: 'No Accessibility: the dial does not move by itself, and the ring and a tap still work',
    dims: ['D2', 'D7'], platforms: ['darwin'], sessions: [...threads(['t1', 't2']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1', 't2'] },
      ...listed('chatgpt', ['t1', 't2']),
      { label: 'front', kind: 'front', app: 'chatgpt' },
      { kind: 'wait', ms: 5 * S },
      { label: 'tap', kind: 'tap', session: 't2' },
    ],
    checks: [
      { id: 'still', kind: 'still', dim: 'D2', ms: 5 * S, after: 'front', at: 'tap' },
      // From the start: the one whole list lands before front, and the last list before the tap is the ring still held.
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'chatgpt', expect: ['t1', 't2'], at: 'tap' },
      { id: 'openKept', kind: 'open', dim: 'D7', session: 't2', link: true, after: 'tap' },
    ],
    probes: [{ id: 'open', kind: 'open', dim: 'D7', session: 'z', link: true, after: 'tap' }],
  }),
  scenario({
    id: 'X4', app: 'chatgpt', title: 'A tap on a thread opens it by its link and brings the app to the front',
    dims: ['D3'], sessions: [...threads(['t1']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1'] },
      ...listed('chatgpt', ['t1']),
      { label: 'tap', kind: 'tap', session: 't1' },
    ],
    checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 't1', link: true, after: 'tap' }],
    probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: true, after: 'tap' }],
  }),
  scenario({
    id: 'X5', app: 'chatgpt', title: 'A thread found by the read alone, its link failing: a tap still brings the app up',
    dims: ['D3'], sessions: [...threads(['t1']), chatgptGhost], world: { linkFails: ['chatgpt'] },
    steps: [
      { kind: 'codex.write', sessions: ['t1'] },
      ...listed('chatgpt', ['t1']),
      { label: 'tap', kind: 'tap', session: 't1' },
    ],
    checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 't1', link: false, after: 'tap' }],
    // A probe asks for the ghost's link: the app coming up is no session's, so only a link can fail it.
    probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: true, after: 'tap' }],
  }),
  scenario({
    id: 'X6', app: 'chatgpt', title: 'A thread archived and another made newer: the ring updates',
    dims: ['D1', 'D7'], sessions: [...threads(['t1', 't2', 't3']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1', 't2', 't3'] },
      { label: 'archive', kind: 'codex.write', sessions: ['t2', 't3'], archived: ['t2'], ages: { t3: 1 * S } },
    ],
    checks: [
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t3', 't1'], after: 'archive', timed: true },
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'chatgpt', expect: ['t3', 't1'], after: 'archive' },
    ],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t3', 't1', 'z'], after: 'archive' }],
  }),
  scenario({
    id: 'X7', app: 'chatgpt', title: '2,000 threads while the app keeps the WAL busy: the ring keeps the newest 16',
    dims: ['D7'], sessions: [...threads(b2000), chatgptGhost], fresh: true,
    steps: [{ kind: 'codex.write', sessions: b2000, walBusy: true }],
    checks: [{ id: 'ringKept', kind: 'ring', dim: 'D7', page: 'chatgpt', expect: b2000.slice(0, 16) }],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D7', page: 'chatgpt', expect: [...b2000.slice(0, 16), 'z'] }],
  }),
  scenario({
    id: 'X8', app: 'chatgpt', title: 'A Codex turn: working, then done, and the last answer is the recap',
    dims: ['D4', 'D6'], sessions: [...threads(['t1']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1'] },
      { kind: 'hook', session: 't1', event: 'start' },
      { label: 'turn', kind: 'hook', session: 't1', event: 'turn-start' },
      { label: 'stop', kind: 'hook', session: 't1', event: 'turn-stop', lastAnswer: 'Eval codex answer.' },
    ],
    checks: [
      { id: 'working', kind: 'state', dim: 'D4', session: 't1', state: 'working', after: 'turn' },
      { id: 'done', kind: 'state', dim: 'D4', session: 't1', state: 'done', after: 'stop' },
      { id: 'recap', kind: 'recap', dim: 'D6', session: 't1', text: 'Eval codex answer.', after: 'stop' },
    ],
    probes: [{ id: 'recap', kind: 'recap', dim: 'D6', session: 'z', text: 'Eval codex answer.', after: 'stop' }],
  }),
  scenario({
    id: 'X9', app: 'chatgpt', title: 'Voice: the exact words reach the selected thread',
    dims: ['D5'], sessions: [...threads(['t1']), chatgptGhost],
    // The thread has a running session, idle.
    steps: [
      { kind: 'codex.write', sessions: ['t1'] },
      { kind: 'hook', session: 't1', event: 'start' },
      ...listed('chatgpt', ['t1']),
      { kind: 'swipe', session: 't1' },
      { label: 'voice', kind: 'voice', transcript: 'Eval words for one.', target: 't1' },
    ],
    checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 't1', text: 'Eval words for one.', after: 'voice' }],
    probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for one.', after: 'voice' }],
  }),
  scenario({
    id: 'X10', app: 'chatgpt', title: 'A thread of the app and a Codex CLI session in the same folder are never one row',
    dims: ['D1'],
    sessions: [
      thread('t1', MIN, { cwd: '/work/eval-shared' }), thread('c1', 2 * MIN, { cwd: '/work/eval-shared', cli: true }), chatgptGhost,
    ],
    steps: [
      { kind: 'codex.write', sessions: ['t1', 'c1'] },
      { kind: 'hook', session: 'c1', event: 'start' },
    ],
    checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1'] }],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1', 'z'] }],
  }),
  scenario({
    id: 'X11', app: 'chatgpt', title: 'Two windows switched three times 300 ms apart: the dial ends on the last and never bounces back',
    dims: ['D2', 'D7'], sessions: [...threads(['t1', 't2', 't3']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1', 't2', 't3'] },
      ...listed('chatgpt', ['t1', 't2', 't3']),
      { kind: 'front', app: 'chatgpt' },
      { kind: 'swipe', session: 't1' },
      { kind: 'thread', title: titleOf('t2') },
      { kind: 'wait', ms: 300 },
      { kind: 'thread', title: titleOf('t1') },
      { kind: 'wait', ms: 300 },
      { label: 'last', kind: 'thread', title: titleOf('t2') },
    ],
    checks: [
      { id: 'focus', kind: 'focus', dim: 'D2', session: 't2', after: 'last', noBounce: true },
      { id: 'focusKept', kind: 'focus', dim: 'D7', session: 't2', after: 'last', noBounce: true },
    ],
    probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'last' }],
  }),
]

export const HELD_OUT: Scenario[] = heldOut()

/** The scenarios, main and held out, that run on that tier and platform. */
export function scenariosFor(tier: Tier, platform: Platform): Scenario[] {
  return [...MAIN, ...HELD_OUT].filter((s) => s.tiers.includes(tier) && s.platforms.includes(platform))
}
