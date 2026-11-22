/**
 * Cursor's main set (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Main set: Cursor"). A function, not a
 * list: the catalog imports it and it uses the catalog's builders, so it is called once the catalog has them.
 *
 * The dial's ring keeps each agent where it entered and puts a new one at the end (cable/hosts/select.ts DialRing): every
 * ring here lists its sessions in the order they started.
 */
import { EDITOR_AWAY_MS, editorGhost, editorSession, listed, S, scenario, started } from './catalog.js'
import type { Check, Scenario, SessionDef, SessionKey } from './types.js'

const cursor = (key: SessionKey, more: Partial<SessionDef> = {}): SessionDef => editorSession(key, 'cursor', more)
/** cursor-agent in a terminal: Cursor's engine, with TERM_PROGRAM set. */
const cursorAgent = (key: SessionKey): SessionDef => cursor(key, { engine: 'cursor' })
/** Cursor's own agent, on its folder. */
const agent = (key: SessionKey, more: Partial<SessionDef> = {}): SessionDef =>
  cursor(key, { place: 'agent', window: undefined, folders: [`/work/eval-${key}`], ...more })
const panel = (key: SessionKey): SessionDef => cursor(key, { place: 'panel', window: undefined })
/** A probe of a ring check: the same ring with the ghost in it. */
const withGhost = (check: Extract<Check, { kind: 'ring' }>): Check => ({ ...check, expect: [...check.expect, 'z'] })

export function cursorScenarios(): Scenario[] {
  const ghost = editorGhost('cursor')
  const shared = '/work/eval-shared'
  const u1Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['a', 'b', 'c', 'd'], apart: [] }
  const u2Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['b'], apart: ['a'] }
  const u13Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['a', 'c', 'd'], after: 'relaunch' }
  const u14Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['a', 'c'] }
  return [
    scenario({
      id: 'U1', app: 'cursor', title: "Four agents in Cursor: its page has those four, by their names, and none is on VS Code's",
      dims: ['D1'],
      // a and b say TERM_PROGRAM=vscode, as every Cursor terminal does: Cursor's bundle id decides.
      sessions: [cursor('a'), cursorAgent('b'), agent('c'), panel('d'), ghost],
      steps: [
        ...started(['a', 'b', 'c', 'd']),
        { kind: 'editor.window', window: 'w1', terminals: ['a', 'b'], active: 'a', focused: true },
      ],
      checks: [u1Ring],
      probes: [withGhost(u1Ring)],
    }),
    scenario({
      id: 'U2', app: 'cursor', title: "VS Code and Cursor both run a Claude Code: each row is on its own app's page",
      dims: ['D1'], sessions: [editorSession('a', 'vscode'), cursor('b', { window: 'w2' }), ghost],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: false },
        { kind: 'editor.window', window: 'w2', active: 'b', focused: true },
      ],
      // a is on VS Code's page, whose list the dial is not sent: the apps frame's counts say it is a row of its own.
      checks: [u2Ring],
      probes: [withGhost(u2Ring), { ...u2Ring, id: 'apart', apart: ['a', 'z'] }],
    }),
    scenario({
      id: 'U3', app: 'cursor', title: 'Another terminal focused in Cursor in front: the dial follows within 1 s',
      dims: ['D2'], sessions: [cursor('a'), cursor('a2'), ghost],
      steps: [
        ...started(['a', 'a2']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('cursor', ['a', 'a2']),
        { label: 'focus', kind: 'editor.focus', session: 'a2' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'a2', after: 'focus' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'focus' }],
    }),
    scenario({
      id: 'U4', app: 'cursor', title: "A prompt typed in Cursor's own agent with Cursor in front: the dial follows within 1 s",
      dims: ['D2'], sessions: [cursor('a'), agent('c'), ghost],
      steps: [
        ...started(['a', 'c']),
        { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: true },
        ...listed('cursor', ['a', 'c']),
        { label: 'prompt', kind: 'hook', session: 'c', event: 'turn-start' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'c', after: 'prompt' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'prompt' }],
    }),
    scenario({
      id: 'U5', app: 'cursor', title: 'A tap on a terminal agent: its window shows its terminal, and Cursor comes up',
      dims: ['D3'], sessions: [cursor('a'), ghost],
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('cursor', ['a']),
        { label: 'tap', kind: 'tap', session: 'a' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'U6', app: 'cursor', title: "A tap on Cursor's own agent opens Cursor's window for its folder",
      dims: ['D3'], sessions: [agent('c'), ghost],
      steps: [
        ...started(['c']),
        ...listed('cursor', ['c']),
        { label: 'tap', kind: 'tap', session: 'c' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'U7', app: 'cursor', title: 'A tap on a panel session at rest opens it by its cursor:// link',
      dims: ['D3'], sessions: [panel('d'), ghost],
      steps: [
        ...started(['d']),
        ...listed('cursor', ['d']),
        { label: 'tap', kind: 'tap', session: 'd' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'd', link: true, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: true, after: 'tap' }],
    }),
    scenario({
      id: 'U8', app: 'cursor', title: "A turn in Cursor's own agent: working, then done, and the recap is its answer",
      dims: ['D4', 'D6'], sessions: [agent('c'), ghost],
      steps: [
        ...started(['c']),
        ...listed('cursor', ['c']),
        { label: 'turn', kind: 'hook', session: 'c', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { label: 'stop', kind: 'hook', session: 'c', event: 'turn-stop', lastAnswer: 'Eval cursor answer.' },
      ],
      checks: [
        { id: 'working', kind: 'state', dim: 'D4', session: 'c', state: 'working', after: 'turn' },
        { id: 'done', kind: 'state', dim: 'D4', session: 'c', state: 'done', after: 'stop' },
        { id: 'recap', kind: 'recap', dim: 'D6', session: 'c', text: 'Eval cursor answer.', after: 'stop' },
      ],
      // Not a recap probe: Cursor's agent has no recap yet (the spec's Expected to fail at baseline), and a recap check
      // with no summary seen has nothing to say. Its turn's changes are seen.
      probes: [{ id: 'working', kind: 'state', dim: 'D4', session: 'z', state: 'working', after: 'turn' }],
    }),
    scenario({
      id: 'U9', app: 'cursor', title: 'Voice on a Claude Code in a Cursor terminal: the exact words reach it, once',
      dims: ['D5'], sessions: [cursor('a'), ghost],
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('cursor', ['a']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }),
    scenario({
      id: 'U10', app: 'cursor', title: "Voice on Cursor's own agent: the exact words reach it, once",
      dims: ['D5'], sessions: [agent('c'), ghost],
      steps: [
        ...started(['c']),
        ...listed('cursor', ['c']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for charlie.', target: 'c' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'c', text: 'Eval words for charlie.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for charlie.', after: 'voice' }],
    }),
    scenario({
      id: 'U11', app: 'cursor', title: 'Voice on cursor-agent in a Cursor terminal: the exact words reach it, once',
      dims: ['D5'], sessions: [cursorAgent('b'), ghost],
      steps: [
        ...started(['b']),
        { kind: 'editor.window', window: 'w1', active: 'b', focused: true },
        ...listed('cursor', ['b']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }),
    scenario({
      id: 'U12', app: 'cursor', title: "A terminal agent whose window closed: a tap opens Cursor's window for its folder",
      dims: ['D7', 'D3'], sessions: [cursor('a'), ghost],
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('cursor', ['a']),
        // Its stream ends: the tap falls to Cursor's folder row, the last resort for every agent in Cursor.
        { label: 'close', kind: 'editor.close', window: 'w1' },
        { kind: 'wait', ms: 2 * S },
        { label: 'tap', kind: 'tap', session: 'a' },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' },
        { id: 'openKept', kind: 'open', dim: 'D7', session: 'a', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'U13', app: 'cursor', title: 'Cursor quit and relaunched: the ring comes back right, no duplicate rows',
      dims: ['D7', 'D1'], sessions: [cursor('a'), agent('c'), panel('d'), ghost],
      steps: [
        ...started(['a', 'c', 'd']),
        { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: true },
        ...listed('cursor', ['a', 'c', 'd']),
        { label: 'quit', kind: 'quit', app: 'cursor' },
        { kind: 'wait', ms: EDITOR_AWAY_MS },
        { label: 'relaunch', kind: 'relaunch', app: 'cursor' },
      ],
      checks: [{ ...u13Ring, id: 'ringKept', dim: 'D7' }, u13Ring],
      probes: [withGhost(u13Ring)],
    }),
    scenario({
      id: 'U14', app: 'cursor', title: "Cursor's own agent and a terminal Claude Code in the same folder are two rows, never one",
      dims: ['D1'], sessions: [cursor('a', { cwd: shared }), agent('c', { cwd: shared, folders: [shared] }), ghost],
      steps: [
        ...started(['a', 'c']),
        { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: true },
      ],
      checks: [u14Ring],
      probes: [withGhost(u14Ring)],
    }),
  ]
}
