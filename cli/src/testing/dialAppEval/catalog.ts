/**
 * The dial eval's scenarios (docs/plans/2026-11-21-dial-app-eval-design.md, "Scenarios"), one catalog both tiers run.
 * Every session is made up: titles start with "Eval ", folders with /work/eval-, ids are fixed UUIDs.
 */
import { cursorScenarios } from './cursorScenarios.js'
import { heldOut } from './heldOut.js'
import { itermScenarios } from './itermScenarios.js'
import { orcaScenarios } from './orcaScenarios.js'
import { vscodeScenarios } from './vscodeScenarios.js'
import { orcaTerminalHandle, type Check, type Editor, type Page, type Platform, type Scenario, type SessionDef, type SessionKey,
  type Step, type Tier } from './types.js'

const EVERY_PLATFORM: Platform[] = ['darwin', 'win32', 'linux']
export const S = 1_000
const MIN = 60 * S
/** A condition wait's limit: twice the ring's half mark, so only a dial that never gets there reaches it. */
const UNTIL_MS = 10 * S
/** How long a person looks at the face before acting on what it lists. */
const READ_MS = 1 * S
/**
 * A wait for the first list before a step that needs it: the dial has a ring of these sessions on that page, and with
 * `apart` the other pages count those. Then the person reads it, their own timing and no synchronisation: an input in
 * the instant the list lands is no person's.
 */
export const listed = (page: Page, expect: SessionKey[], apart?: SessionKey[]): Step[] => [
  { kind: 'wait', ms: UNTIL_MS, until: { kind: 'ring', page, expect, ...(apart ? { apart } : {}) } },
  { kind: 'wait', ms: READ_MS },
]

/**
 * A wait for the Apps screen to show the page and count exactly these pages' agents, then the person reads it: what they
 * look at before a pick, as a pick of a page whose agents the devices have not counted yet is ignored.
 */
export const counted = (shown: Page, counts: Partial<Record<Page, number>>): Step[] => [
  { kind: 'wait', ms: UNTIL_MS, until: { kind: 'apps', shown, counts } },
  { kind: 'wait', ms: READ_MS },
]

/**
 * How long an editor stays quit before the person starts it again, their own timing: longer than the 10 s end delay and
 * the 30 s tick after it, so its rows leave the ring and the ring after the relaunch grades their return.
 */
export const EDITOR_AWAY_MS = 45 * S

const NAMES: Readonly<Record<SessionKey, string>> = { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', z: 'Zulu' }

/** A fixed made-up UUID from the key's bytes, so each key has its own; `variant` keeps a session's two ids apart, and an
 *  Orca session's (8c) and an iTerm2 one's (8e) from the others'. */
function uuid(key: SessionKey, variant: '8' | '9' | 'a' | 'b' | '8c' | '8e'): string {
  const bytes = Buffer.from(key).toString('hex')
  if (bytes.length > 12) throw new Error(`session key ${key} is longer than 6 bytes`)
  return `00000000-0000-4000-${variant.padEnd(4, '0')}-${bytes.padStart(12, '0')}`
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
/** An editor's agent, a Claude Code in a terminal of its window w1 unless `more` says otherwise. The editors have no
 *  store: its age is its start's. */
export function editorSession(key: SessionKey, app: Editor, more: Partial<SessionDef> = {}): SessionDef {
  return { key, app, id: uuid(key, 'b'), title: titleOf(key), cwd: `/work/eval-${key}`, ageMs: 0, place: 'terminal', window: 'w1', ...more }
}
export const vscode = (key: SessionKey, more: Partial<SessionDef> = {}): SessionDef => editorSession(key, 'vscode', more)
export const cursor = (key: SessionKey, more: Partial<SessionDef> = {}): SessionDef => editorSession(key, 'cursor', more)
/** A Claude Code panel session in the editor: no window holds a terminal of it. */
export const panel = (key: SessionKey, app: Editor): SessionDef => editorSession(key, app, { place: 'panel', window: undefined })
/**
 * An Orca agent, Claude Code in the first pane of worktree w1's first tab unless `more` says otherwise, in its
 * worktree's folder (docs/plans/2026-11-22-dial-eval-orca-plan.md, Decisions 1 and 2). A Codex there runs in a home of
 * its own, an Orca account's, so its words are typed into its pane. Orca has no store: its age is its start's.
 */
export function orcaSession(key: SessionKey, more: Partial<SessionDef> = {}): SessionDef {
  const worktree = more.worktree ?? 'w1'
  return { key, app: 'orca', id: uuid(key, '8c'), handle: orcaTerminalHandle(key), title: titleOf(key), worktree, tab: 0, split: 0,
    cwd: `/work/eval-${worktree}`, ageMs: 0, ...(more.engine === 'codex' ? { codexHome: 'own' } : {}), ...more }
}
/**
 * A chat of Orca's, Claude Code's in worktree w1 unless `more` says otherwise (docs/plans/2026-11-23-dial-orca-chats-design.md):
 * Orca runs it on no terminal, so no layout has a pane, tab or handle of it, and its folder is its worktree's.
 */
export function orcaChat(key: SessionKey, chat: 'live' | 'resting', more: Partial<SessionDef> = {}): SessionDef {
  const worktree = more.worktree ?? 'w1'
  return { key, app: 'orca', id: uuid(key, '8c'), title: titleOf(key), worktree, cwd: `/work/eval-${worktree}`, ageMs: 0, chat, ...more }
}
/**
 * An iTerm2 session, Claude Code in its own plain tab, w1's first, unless `more` says otherwise
 * (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 1). iTerm2 has no store: its age is its start's.
 */
export function itermSession(key: SessionKey, more: Partial<SessionDef> = {}): SessionDef {
  return { key, app: 'iterm', id: uuid(key, '8e'), title: titleOf(key), cwd: `/work/eval-${key}`, ageMs: 0, place: 'tab', window: 'w1',
    tab: 0, split: 0, ...more }
}
/** A probe of a ring check: the same ring with the ghost in it. */
export const withGhost = (check: Extract<Check, { kind: 'ring' }>): Check => ({ ...check, expect: [...check.expect, 'z'] })
/** Newest first, a minute apart, as the catalog's rows are unless they say otherwise. */
export const claudeSessions = (keys: SessionKey[]): SessionDef[] => keys.map((key, i) => claudeSession(key, (i + 1) * MIN))
export const threads = (keys: SessionKey[]): SessionDef[] => keys.map((key, i) => thread(key, (i + 1) * MIN))
/** `prefix` and `from`..`to`, zero-padded to `width`: keys('s', 1, 3, 2) is s01 s02 s03. */
export const keys = (prefix: string, from: number, to: number, width: number): SessionKey[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(width, '0')}`)

/** The sessions only probes name: never written or started, so a check of one fails whatever the product does. */
export const claudeGhost: SessionDef = { ...claudeSession('z', 0), ghost: true }
export const chatgptGhost: SessionDef = { ...thread('z', 0), ghost: true }
export const editorGhost = (app: Editor): SessionDef => ({ ...editorSession('z', app), ghost: true })
export const orcaGhost: SessionDef = { ...orcaSession('z'), ghost: true }
export const itermGhost: SessionDef = { ...itermSession('z'), ghost: true }

/** Each session's start hook in the order given, a second apart, so the last is the newest. */
export const started = (keys: SessionKey[]): Step[] => keys.flatMap((session, i): Step[] => [
  ...(i === 0 ? [] : [{ kind: 'wait', ms: S } as const]),
  { kind: 'hook', session, event: 'start' },
])

/** Each session's turn in the order given, so its conversation is on disk for a scan to find
 *  (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 13); 2 s long, the shortest turn the catalog lets a person take. */
export const turned = (keys: SessionKey[]): Step[] => keys.flatMap((session): Step[] => [
  { kind: 'hook', session, event: 'turn-start' },
  { kind: 'wait', ms: 2 * S },
  { kind: 'hook', session, event: 'turn-stop' },
])

/** Orca's worktrees laid out in this order, then the plugin's stream open, as every Orca scenario begins (the plan's
 *  Decision 9). */
export const orcaOpening = (worktrees: string[], renamed?: Record<SessionKey, string>): Step[] => [
  { kind: 'orca.layout', worktrees, ...(renamed === undefined ? {} : { renamed }) },
  { kind: 'orca.plugin', open: true },
]
/** Each session's start hook in the order given, with no wait between: Orca's agents started together. */
export const orcaStarted = (keys: SessionKey[]): Step[] => keys.map((session) => ({ kind: 'hook', session, event: 'start' }))

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
      ...listed('claude', ['a']),
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
      ...listed('claude', ['a', 'b']),
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
    // The person turns to the older session and rests there as a person does, then turns to the new one and rests on it
    // past the open's half mark; its hook comes only after.
    steps: [
      { kind: 'front', app: 'claude' },
      { kind: 'claude.write', sessions: ['a', 'b'] },
      ...listed('claude', ['b', 'a']),
      { kind: 'swipe', session: 'a' },
      { kind: 'wait', ms: 1 * S },
      { label: 'swipe', kind: 'swipe', session: 'b' },
      { kind: 'wait', ms: 3.5 * S },
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
      { kind: 'wait', ms: 1 * S },
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
    id: 'C12', app: 'claude', title: 'Voice on a running, idle session: the exact words reach it, once',
    dims: ['D5'], sessions: [...claudeSessions(['a']), claudeGhost],
    steps: [
      { kind: 'claude.write', sessions: ['a'] },
      { kind: 'hook', session: 'a', event: 'start' },
      ...listed('claude', ['a']),
      { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
    ],
    checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
    probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
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
      { label: 'title', kind: 'thread', title: titleOf('t2') },
    ],
    checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 't2', after: 'title' }],
    probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'title' }],
  }),
  scenario({
    id: 'X3', app: 'chatgpt', title: 'No Accessibility: the dial does not move by itself, and the ring and a tap still work',
    dims: ['D2', 'D7'], platforms: ['darwin'], sessions: [...threads(['t1', 't2']), chatgptGhost], world: { front: 'other', accessibility: false },
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
      ...listed('chatgpt', ['t1', 't2', 't3']),
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
      ...listed('chatgpt', ['t1']),
      { label: 'turn', kind: 'hook', session: 't1', event: 'turn-start' },
      { kind: 'wait', ms: 2 * S },
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
    // c1 is on its terminal's page, whose list the dial is not sent: the apps frame's counts say it is a row of its own.
    checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1'], apart: ['c1'] }],
    probes: [
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1', 'z'] },
      { id: 'apart', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1'], apart: ['c1', 'z'] },
    ],
  }),
  scenario({
    id: 'X11', app: 'chatgpt', title: 'Two windows switched three times 300 ms apart: the dial ends on the last and never bounces back',
    dims: ['D2', 'D7'], sessions: [...threads(['t1', 't2', 't3']), chatgptGhost],
    steps: [
      { kind: 'codex.write', sessions: ['t1', 't2', 't3'] },
      ...listed('chatgpt', ['t1', 't2', 't3']),
      { kind: 'front', app: 'chatgpt' },
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
  scenario({
    id: 'X12', app: 'chatgpt', title: 'Voice on a resting thread: it opens, then the exact words are queued to it once',
    dims: ['D3', 'D5'], tiers: ['a'], world: { codexHome: 'app' }, sessions: [...threads(['t1']), chatgptGhost],
    // No hook: the thread is in the app's metadata alone.
    steps: [
      { kind: 'codex.write', sessions: ['t1'] },
      ...listed('chatgpt', ['t1']),
      { label: 'voice', kind: 'voice', transcript: 'Eval words for one.', target: 't1' },
    ],
    checks: [
      { id: 'open', kind: 'open', dim: 'D3', session: 't1', link: true, after: 'voice' },
      { id: 'voice', kind: 'voice', dim: 'D5', session: 't1', text: 'Eval words for one.', path: 'codex', after: 'voice' },
    ],
    probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for one.', after: 'voice' }],
  }),
  ...vscodeScenarios(),
  ...cursorScenarios(),
  ...orcaScenarios(),
  ...itermScenarios(),
]

export const HELD_OUT: Scenario[] = heldOut()

/** The scenarios, main and held out, that run on that tier and platform. */
export function scenariosFor(tier: Tier, platform: Platform): Scenario[] {
  return [...MAIN, ...HELD_OUT].filter((s) => s.tiers.includes(tier) && s.platforms.includes(platform))
}
