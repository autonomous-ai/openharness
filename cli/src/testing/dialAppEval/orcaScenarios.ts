/**
 * Orca's main set (docs/plans/2026-11-22-dial-eval-orca-design.md, "Main set"; the rows of
 * docs/plans/2026-11-22-dial-eval-orca-plan.md, Task 7). A function, not a list: the catalog imports it and it uses the
 * catalog's builders, so it is called once the catalog has them.
 *
 * Each agent is in an Orca pane, laid out by `orca.layout`: every ring here lists its agents in Orca's tab order, each
 * worktree in its order, then its tabs, then each tab's splits. O18 to O23 add Orca's chats
 * (docs/plans/2026-11-23-dial-orca-chats-plan.md, Task 8), which no pane holds: a ring lists them after the panes'
 * agents, in the order of Orca's list of them, which is the order they are declared in.
 */
import { keys, listed, orcaChat, orcaGhost, orcaOpening, orcaSession, orcaStarted, S, scenario, started, withGhost } from './catalog.js'
import type { Check, Scenario, SessionDef, SessionKey } from './types.js'

type Ring = Extract<Check, { kind: 'ring' }>
const ring = (expect: SessionKey[], more: Partial<Ring> = {}): Ring => ({ id: 'ring', kind: 'ring', dim: 'D1', page: 'orca', expect, ...more })
const ringKept = (expect: SessionKey[], more: Partial<Ring> = {}): Ring => ring(expect, { id: 'ringKept', dim: 'D7', ...more })
/** An Orca agent in worktree `worktree`'s tab `tab`, at split `split` of it. */
const pane = (key: SessionKey, worktree: string, tab: number, split = 0, more: Partial<SessionDef> = {}): SessionDef =>
  orcaSession(key, { worktree, tab, split, ...more })
const codex: Partial<SessionDef> = { engine: 'codex' }
/** A chat of Orca's in worktree `worktree`: one no process runs, and one whose Claude Code runs and hooks. */
const resting = (key: SessionKey, worktree: string, more: Partial<SessionDef> = {}): SessionDef =>
  orcaChat(key, 'resting', { worktree, ...more })
const live = (key: SessionKey, worktree: string): SessionDef => orcaChat(key, 'live', { worktree })
/** Tier A alone: tier B's fake Orca lists no chats until the chats plan's Task 7 teaches it to. */
const CHATS_TIERS: Scenario['tiers'] = ['a']

export function orcaScenarios(): Scenario[] {
  /**
   * How long the person works on in Orca after its relaunch before focusing another pane, their own timing: past the
   * devices' next 30 s look at their agents' processes (services/devices.ts OBSERVED_TICK_MS) whatever its phase, and the
   * push after it, so a ring that look changes is graded the same on every run and in both tiers.
   */
  const pastLook = 35 * S
  const s16 = keys('s', 1, 16, 2)
  const t16 = keys('t', 1, 16, 2)
  const k40 = keys('k', 1, 40, 2)
  const w40 = keys('w', 1, 40, 2)
  const o16Ring = ['k05', ...k40.slice(25)]
  const o1Ring = ring(['a', 'c', 'b', 'd', 'e'])
  const o18Ring = ring(['a', 'c', 'd', 'e'])
  return [
    scenario({
      id: 'O1', app: 'orca', title: 'Five agents in two worktrees: the ring has those five in tab order, by their names',
      dims: ['D1'],
      sessions: [pane('a', 'w1', 0), pane('c', 'w1', 0, 1), pane('b', 'w1', 1, 0, codex), pane('d', 'w2', 0),
        pane('e', 'w2', 1, 0, codex), orcaGhost],
      // The plugin sends no front, so every worktree's agents are listed.
      steps: [...orcaOpening(['w1', 'w2'], { d: 'Eval Renamed' }), ...orcaStarted(['e', 'd', 'c', 'b', 'a'])],
      checks: [o1Ring],
      probes: [withGhost(o1Ring)],
    }),
    scenario({
      id: 'O2', app: 'orca', title: "The worktree on screen: only its agents are listed, and opening another lists that one's",
      dims: ['D1', 'D7'],
      // c works in w1's folder from a terminal of w2: its terminal decides.
      sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), pane('c', 'w2', 0, 0, { cwd: '/work/eval-w1' }), pane('d', 'w2', 1), orcaGhost],
      steps: [
        ...orcaOpening(['w1', 'w2']),
        ...orcaStarted(['d', 'c', 'b', 'a']),
        ...listed('orca', ['a', 'b', 'c', 'd']),
        { label: 'front', kind: 'orca.front', worktree: 'w1' },
        ...listed('orca', ['a', 'b']),
        { label: 'open', kind: 'orca.front', worktree: 'w2' },
        ...listed('orca', ['c', 'd']),
      ],
      checks: [
        ring(['a', 'b'], { after: 'front', at: 'open' }),
        ring(['c', 'd'], { id: 'moved', after: 'open', timed: true }),
        ringKept(['c', 'd']),
      ],
      probes: [ring(['c', 'd', 'z'], { after: 'open' })],
    }),
    scenario({
      id: 'O3', app: 'orca', title: "Sixteen agents on the face, then another worktree's sixteen: no tile refused, none left off the face",
      dims: ['D1', 'D7'],
      sessions: [...s16.map((key, i) => pane(key, 'w1', i)), ...t16.map((key, i) => pane(key, 'w2', i)), orcaGhost],
      steps: [
        ...orcaOpening(['w1', 'w2']),
        { label: 'front', kind: 'orca.front', worktree: 'w1' },
        ...orcaStarted([...s16, ...t16]),
        ...listed('orca', s16),
        { label: 'open', kind: 'orca.front', worktree: 'w2' },
        ...listed('orca', t16),
      ],
      checks: [
        { id: 'face', kind: 'face', dim: 'D7', after: 'open' },
        ring(t16, { after: 'open' }),
      ],
      probes: [ring([...t16, 'z'], { after: 'open' })],
    }),
    scenario({
      id: 'O4', app: 'orca', title: "Another pane focused in Orca: the dial follows, and its own tap's echo does not bounce it",
      dims: ['D2'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'focus', kind: 'orca.focus', session: 'b' },
        { kind: 'wait', ms: 2 * S },
        { label: 'tap', kind: 'tap', session: 'a' },
        // The person turns to b before Orca tells the tap's focus (ORCA_ECHO_MS): that echo, of a, must not pull the
        // dial back.
        { kind: 'wait', ms: 1 * S },
        { label: 'swipe', kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 3 * S },
      ],
      checks: [
        { id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'focus', at: 'tap' },
        { id: 'echo', kind: 'focus', dim: 'D2', session: 'b', after: 'swipe', noBounce: true },
      ],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'focus' }],
    }),
    scenario({
      id: 'O5', app: 'orca', title: 'An Orca with no watch-focus: a prompt typed in another agent moves the dial',
      dims: ['D2'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), orcaGhost], world: { orca: { watchFocus: false } },
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'prompt', kind: 'hook', session: 'b', event: 'turn-start' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'prompt' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'prompt' }],
    }),
    scenario({
      id: 'O6', app: 'orca', title: 'An agent in a pane another program made: a prompt typed there moves the dial to it',
      dims: ['D2', 'D1'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1, 0, { held: true }), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'prompt', kind: 'hook', session: 'b', event: 'turn-start' },
      ],
      checks: [
        { id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'prompt' },
        ring(['a', 'b']),
      ],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'prompt' }],
    }),
    scenario({
      id: 'O7', app: 'orca', title: "A tap in the other worktree opens it, switches the pane and brings Orca up; a swipe's rest does not raise it",
      dims: ['D3'], sessions: [pane('a', 'w1', 0), pane('c', 'w1', 1), pane('b', 'w2', 0), orcaGhost],
      steps: [
        ...orcaOpening(['w1', 'w2']),
        ...orcaStarted(['b', 'c', 'a']),
        ...listed('orca', ['a', 'c', 'b']),
        { label: 'tap', kind: 'tap', session: 'b' },
        { kind: 'wait', ms: 4 * S },
        { label: 'rest', kind: 'swipe', session: 'c' },
        { kind: 'wait', ms: 2 * S },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap', at: 'rest' },
        { id: 'rest', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'rest' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'O8', app: 'orca', title: 'A Claude Code turn and a Codex turn in Orca panes: their states, then each recap is its last answer',
      dims: ['D4', 'D6'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1, 0, codex), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'turn', kind: 'hook', session: 'a', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { label: 'ask', kind: 'hook', session: 'a', event: 'needs-input', asks: 'permission' },
        { kind: 'wait', ms: 2 * S },
        { label: 'stop', kind: 'hook', session: 'a', event: 'turn-stop', lastAnswer: 'Eval answer one.' },
        { kind: 'wait', ms: 6 * S },
        { label: 'turn2', kind: 'hook', session: 'b', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { label: 'stop2', kind: 'hook', session: 'b', event: 'turn-stop', lastAnswer: 'Eval answer two.' },
      ],
      checks: [
        { id: 'working', kind: 'state', dim: 'D4', session: 'a', state: 'working', after: 'turn' },
        { id: 'needsYou', kind: 'state', dim: 'D4', session: 'a', state: 'needs-you', after: 'ask' },
        { id: 'done', kind: 'state', dim: 'D4', session: 'a', state: 'done', after: 'stop', at: 'turn2' },
        { id: 'recap', kind: 'recap', dim: 'D6', session: 'a', text: 'Eval answer one.', after: 'stop' },
        { id: 'working2', kind: 'state', dim: 'D4', session: 'b', state: 'working', after: 'turn2' },
        { id: 'done2', kind: 'state', dim: 'D4', session: 'b', state: 'done', after: 'stop2' },
        { id: 'recap2', kind: 'recap', dim: 'D6', session: 'b', text: 'Eval answer two.', after: 'stop2' },
      ],
      probes: [{ id: 'recap', kind: 'recap', dim: 'D6', session: 'z', text: 'Eval answer one.', after: 'stop' }],
    }),
    scenario({
      id: 'O9', app: 'orca', title: 'Voice on a Claude Code at rest in an Orca pane: the exact words reach it once, typed into no pane',
      dims: ['D5'], sessions: [pane('a', 'w1', 0), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['a']),
        ...listed('orca', ['a']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', path: 'mod', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }),
    scenario({
      id: 'O10', app: 'orca', title: 'Voice on a Codex at rest in an Orca pane: the exact words are typed into its pane alone, once',
      dims: ['D5'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1, 0, codex), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 1 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', path: 'typed', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }),
    /**
     * tmux inside Orca stays as today (Diego, 2026-11-23; option A of docs/plans/2026-11-25-dial-orca-tmux-o11-design.md):
     * c is an Orca row at its tab's place, and voice reaches it by its mod. Its tap is graded on what the person expects,
     * its tab and its tmux pane opened (the eval spec's decision 3): the tap switches Orca to c's tab first (observed.ts
     * placedTab), then tmux shows its pane and Orca comes forward. Tier A alone: tier B's c runs in no tmux pane and
     * Orca's rig records no tmux run. Not on Windows: tmux runs only inside WSL there, whose agents never reach the
     * Windows devices.
     */
    scenario({
      id: 'O11', app: 'orca', title: 'Claude Code under tmux in an Orca pane is an Orca row at its tab: a tap opens its tab and pane, and voice reaches it by its mod',
      dims: ['D1', 'D3', 'D5'], platforms: ['darwin', 'linux'], tiers: ['a'],
      sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), pane('c', 'w1', 2, 0, { tmux: true }), orcaGhost],
      steps: [
        ...orcaOpening(['w1']), ...orcaStarted(['c', 'b', 'a']), ...listed('orca', ['a', 'b', 'c']),
        { label: 'tap', kind: 'tap', session: 'c' },
        { kind: 'wait', ms: 4 * S },
        // A tap does not move the face: the person turns to c before speaking, which also ends the tap's window.
        { label: 'face', kind: 'swipe', session: 'c' },
        { kind: 'wait', ms: 1 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for charlie.', target: 'c' },
      ],
      checks: [
        ring(['a', 'b', 'c']),
        { id: 'open', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'tap', at: 'face' },
        { id: 'voice', kind: 'voice', dim: 'D5', session: 'c', text: 'Eval words for charlie.', path: 'mod', after: 'voice' },
      ],
      probes: [
        ring(['a', 'b', 'c', 'z']),
        { id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' },
        { id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for charlie.', after: 'voice' },
      ],
    }),
    scenario({
      id: 'O12', app: 'orca', title: 'Orca quit and relaunched: the ring comes back right with no duplicate rows and stays so, and a focus is followed',
      dims: ['D7', 'D1', 'D2'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        { kind: 'orca.front', worktree: 'w1' },
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'quit', kind: 'quit', app: 'orca' },
        { kind: 'front', app: 'other' },
        { kind: 'wait', ms: 2 * S },
        { label: 'relaunch', kind: 'relaunch', app: 'orca' },
        { kind: 'front', app: 'orca' },
        { kind: 'orca.front', worktree: 'w1' },
        ...listed('orca', ['a', 'b']),
        { kind: 'wait', ms: pastLook },
        { label: 'focus', kind: 'orca.focus', session: 'b' },
        { kind: 'wait', ms: 2 * S },
      ],
      checks: [
        ringKept(['a', 'b'], { after: 'relaunch' }),
        // The ring past the devices' next look, as the focus line comes.
        ring(['a', 'b'], { after: 'relaunch', at: 'focus' }),
        { id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'focus' },
      ],
      probes: [ring(['a', 'b', 'z'], { after: 'relaunch' })],
    }),
    scenario({
      id: 'O13', app: 'orca', title: 'No Harness plugin in Orca: every agent is listed in tab order, and a tap still opens its pane',
      dims: ['D7', 'D1', 'D3'], sessions: [pane('a', 'w1', 0), pane('b', 'w2', 0), orcaGhost], world: { orca: { plugin: false } },
      steps: [
        ...orcaOpening(['w1', 'w2']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [
        ring(['a', 'b']),
        ringKept(['a', 'b']),
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'O14', app: 'orca', title: 'A worktree added with an agent and another removed with its own: the ring follows both',
      dims: ['D7', 'D1'], sessions: [pane('a', 'w1', 0), pane('b', 'w2', 0), pane('c', 'w3', 0), orcaGhost],
      // The removed agent leaves at the devices' 30 s look at their agents' processes: on a daemon of its own that look
      // has the phase tier A's has, not the one the scenario before left.
      fresh: true,
      steps: [
        ...orcaOpening(['w1', 'w2']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'add', kind: 'orca.layout', worktrees: ['w1', 'w2', 'w3'] },
        { kind: 'hook', session: 'c', event: 'start' },
        ...listed('orca', ['a', 'b', 'c']),
        { label: 'remove', kind: 'orca.close', session: 'b' },
        { kind: 'orca.layout', worktrees: ['w1', 'w3'] },
        ...listed('orca', ['a', 'c']),
      ],
      checks: [
        ring(['a', 'b', 'c'], { id: 'added', after: 'add', at: 'remove', timed: true }),
        ring(['a', 'c'], { id: 'removed', after: 'remove', timed: true }),
        ringKept(['a', 'c']),
      ],
      probes: [ring(['a', 'c', 'z'], { after: 'remove' })],
    }),
    scenario({
      id: 'O15', app: 'orca', title: 'An agent started in a new split is listed after its sibling; a pane closed while working leaves',
      dims: ['D7', 'D1'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), pane('c', 'w1', 0, 1), orcaGhost],
      // As O14's removal, its closed pane's agent leaves at the devices' 30 s look.
      fresh: true,
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'split', kind: 'hook', session: 'c', event: 'start' },
        ...listed('orca', ['a', 'c', 'b']),
        { label: 'close', kind: 'orca.close', session: 'b' },
        ...listed('orca', ['a', 'c']),
      ],
      checks: [
        ring(['a', 'c', 'b'], { id: 'split', after: 'split', at: 'close', timed: true }),
        ring(['a', 'c'], { id: 'closed', after: 'close', timed: true }),
        ringKept(['a', 'c']),
      ],
      probes: [ring(['a', 'c', 'z'], { after: 'close' })],
    }),
    scenario({
      id: 'O16', app: 'orca', title: 'Forty worktrees, one agent each, one needing you: the ring has 16, that one among them, in tab order',
      // Tier A alone: its forty starts a second apart cost tier B's Orca file a minute of its six (the plan's Task 14).
      dims: ['D1', 'D7'], tiers: ['a'], sessions: [...k40.map((key, i) => pane(key, w40[i]!, 0)), orcaGhost],
      steps: [
        ...orcaOpening(w40),
        ...started(k40),
        { label: 'ask', kind: 'hook', session: 'k05', event: 'needs-input', asks: 'permission' },
        ...listed('orca', o16Ring),
      ],
      checks: [ring(o16Ring, { after: 'ask' }), ringKept(o16Ring, { after: 'ask' })],
      probes: [ring([...o16Ring, 'z'], { after: 'ask' })],
    }),
    scenario({
      id: 'O17', app: 'orca', title: 'The dial unplugged and plugged in again: the ring and the focused row come back, and a tap opens it',
      dims: ['D7', 'D3'], sessions: [pane('a', 'w1', 0), pane('b', 'w1', 1), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 1 * S },
        { label: 'unplug', kind: 'unplug' },
        { kind: 'wait', ms: 3 * S },
        { label: 'replug', kind: 'replug' },
        ...listed('orca', ['a', 'b']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [
        ringKept(['a', 'b'], { after: 'replug' }),
        { id: 'focusKept', kind: 'focus', dim: 'D7', session: 'b', after: 'replug', at: 'tap' },
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'O18', app: 'orca', title: "An agent in a pane and three chats of Orca's: the ring has the pane's agent, then each chat, resting or live, by its name",
      dims: ['D1', 'D7'], tiers: CHATS_TIERS,
      // d's Claude Code runs and hooks, the other two run nothing: Orca's list alone names them.
      sessions: [pane('a', 'w1', 0), resting('c', 'w1'), live('d', 'w2'), resting('e', 'w2', codex), orcaGhost],
      steps: [...orcaOpening(['w1', 'w2']), ...orcaStarted(['d', 'a']), ...listed('orca', ['a', 'c', 'd', 'e'])],
      checks: [o18Ring, ringKept(['a', 'c', 'd', 'e'])],
      probes: [withGhost(o18Ring)],
    }),
    scenario({
      id: 'O19', app: 'orca', title: "The worktree on screen lists its chats beside its agents, named by its identity or, with none, by its id",
      dims: ['D1', 'D7'], tiers: CHATS_TIERS,
      // Orca gives w2 no identity, so its plugin names it by its id (2 of the 14 worktrees on Tony's Mac).
      sessions: [pane('a', 'w1', 0), pane('b', 'w2', 0), resting('c', 'w1'), resting('d', 'w2'), orcaGhost],
      world: { orca: { noIdentity: ['w2'] } },
      steps: [
        ...orcaOpening(['w1', 'w2']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b', 'c', 'd']),
        { label: 'front', kind: 'orca.front', worktree: 'w1' },
        ...listed('orca', ['a', 'c']),
        { label: 'open', kind: 'orca.front', worktree: 'w2' },
        ...listed('orca', ['b', 'd']),
      ],
      checks: [
        ring(['a', 'c'], { after: 'front', at: 'open' }),
        ring(['b', 'd'], { id: 'moved', after: 'open', timed: true }),
        ringKept(['b', 'd']),
      ],
      probes: [ring(['b', 'd', 'z'], { after: 'open' })],
    }),
    scenario({
      id: 'O20', app: 'orca', title: "A tap on a chat in the other worktree opens that worktree and brings Orca up; a swipe's rest on a chat opens its worktree alone",
      dims: ['D3'], tiers: CHATS_TIERS,
      sessions: [pane('a', 'w1', 0), resting('c', 'w2'), resting('d', 'w1'), orcaGhost],
      steps: [
        ...orcaOpening(['w1', 'w2']),
        ...orcaStarted(['a']),
        ...listed('orca', ['a', 'c', 'd']),
        { label: 'tap', kind: 'tap', session: 'c' },
        { kind: 'wait', ms: 4 * S },
        { label: 'rest', kind: 'swipe', session: 'd' },
        { kind: 'wait', ms: 2 * S },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'tap', at: 'rest' },
        { id: 'rest', kind: 'open', dim: 'D3', session: 'd', link: false, after: 'rest' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'O21', app: 'orca', title: "A prompt typed in a live chat moves the dial to it, while Orca's focus watch runs",
      // Orca's focus watch tells its panes alone, so a chat's prompt is the one sign the person turned to it.
      dims: ['D2'], tiers: CHATS_TIERS, sessions: [pane('a', 'w1', 0), live('b', 'w1'), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'prompt', kind: 'hook', session: 'b', event: 'turn-start' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'prompt' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'prompt' }],
    }),
    scenario({
      id: 'O22', app: 'orca', title: 'Words to a resting chat: the dial says to type them in Orca, and they reach no agent',
      dims: ['D5'], tiers: CHATS_TIERS, sessions: [resting('a', 'w1'), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...listed('orca', ['a']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'refused', kind: 'refused', dim: 'D5', session: 'a', text: 'Type in Orca for chats.', after: 'voice' }],
      probes: [{ id: 'refused', kind: 'refused', dim: 'D5', session: 'z', text: 'Type in Orca for chats.', after: 'voice' }],
    }),
    scenario({
      id: 'O23', app: 'orca', title: "Voice on a live Claude Code chat: the exact words reach it once by Harness's mod, today's route until the owner tries it in Orca by hand",
      // The chats plan's Task 0 keeps or turns off this route once the owner has seen the words land in Orca's chat; until
      // then it is what the product does, and turned off, this scenario's check becomes O22's refusal.
      dims: ['D5'], tiers: CHATS_TIERS, sessions: [live('a', 'w1'), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['a']),
        ...listed('orca', ['a']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', path: 'mod', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }),
  ]
}
