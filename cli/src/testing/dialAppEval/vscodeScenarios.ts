/**
 * VS Code's main set (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Main set: VS Code"). A function, not a
 * list: the catalog imports it and it uses the catalog's builders, so it is called once the catalog has them.
 *
 * The dial's ring keeps each agent where it entered and puts a new one at the end (cable/hosts/select.ts DialRing): every
 * ring here lists its sessions in the order they started.
 */
import { EDITOR_AWAY_MS, editorGhost, editorSession, keys, listed, S, scenario, started } from './catalog.js'
import type { Check, Scenario, SessionDef, SessionKey } from './types.js'

const vscode = (key: SessionKey, more: Partial<SessionDef> = {}): SessionDef => editorSession(key, 'vscode', more)
const panel = (key: SessionKey): SessionDef => vscode(key, { place: 'panel', window: undefined })
/** A probe of a ring check: the same ring with the ghost in it. */
const withGhost = (check: Extract<Check, { kind: 'ring' }>): Check => ({ ...check, expect: [...check.expect, 'z'] })

export function vscodeScenarios(): Scenario[] {
  const ghost = editorGhost('vscode')
  const s20 = keys('s', 1, 20, 2)
  // Started s20 first and s01 last: the ring fills with s20 to s05, then each later start takes the place of the one
  // longest at rest, so it holds s16 down to s01. s05's terminal closing lets the newest left out, s17, in at the end,
  // once the 30 s tick after its 10 s end delay removes s05: the run waits for that ring, or ends before it.
  const v2Listed = keys('s', 1, 16, 2).reverse()
  const v2AfterClose = [...keys('s', 6, 16, 2).reverse(), ...keys('s', 1, 4, 2).reverse(), 's17']
  const v2Kept: Extract<Check, { kind: 'ring' }> = { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'vscode', after: 'close',
    expect: v2AfterClose }
  const v1Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'vscode', expect: ['a', 'b', 'c', 'd'], apart: [] }
  const v11Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'vscode', expect: ['a'], apart: [] }
  const v14Ring: Extract<Check, { kind: 'ring' }> = { id: 'ring', kind: 'ring', dim: 'D1', page: 'vscode', expect: ['a', 'b', 'd'], after: 'relaunch' }
  return [
    scenario({
      id: 'V1', app: 'vscode', title: 'Three terminals and a panel session in one window: the VS Code page has those four, by their names',
      dims: ['D1'],
      // c runs in a split of b's terminal group: to the extension, another terminal of the window.
      sessions: [vscode('a'), vscode('b', { engine: 'codex' }), vscode('c'), panel('d'), ghost],
      steps: [
        ...started(['a', 'b', 'c', 'd']),
        { kind: 'editor.window', window: 'w1', terminals: ['a', 'b', 'c'], active: 'a', focused: true },
      ],
      checks: [v1Ring],
      probes: [withGhost(v1Ring)],
    }),
    scenario({
      id: 'V2', app: 'vscode', title: 'Twenty agents across two windows: the ring keeps 16, and a closed terminal leaves it',
      dims: ['D1', 'D7'], tiers: ['a'],
      sessions: [...s20.map((key, i) => vscode(key, { window: i < 10 ? 'w1' : 'w2' })), ghost],
      steps: [
        ...started([...s20].reverse()),
        { kind: 'editor.window', window: 'w1', active: 's01', focused: true },
        { kind: 'editor.window', window: 'w2', active: 's11', focused: false },
        ...listed('vscode', v2Listed),
        { label: 'close', kind: 'editor.closeTerminal', session: 's05' },
        ...listed('vscode', v2AfterClose),
      ],
      checks: [{ ...v2Kept, id: 'ring', dim: 'D1', timed: true }, v2Kept],
      probes: [withGhost({ ...v2Kept, id: 'ring', dim: 'D1' })],
    }),
    scenario({
      id: 'V3', app: 'vscode', title: 'Another terminal focused in VS Code in front: the dial follows within 1 s',
      dims: ['D2'], sessions: [vscode('a'), vscode('b'), ghost],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a', 'b']),
        { label: 'focus', kind: 'editor.focus', session: 'b' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'focus' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'focus' }],
    }),
    scenario({
      id: 'V4', app: 'vscode', title: 'A prompt typed in the panel session with VS Code in front: the dial follows within 1 s',
      dims: ['D2'], sessions: [vscode('a'), panel('d'), ghost],
      steps: [
        ...started(['a', 'd']),
        { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: true },
        ...listed('vscode', ['a', 'd']),
        { label: 'prompt', kind: 'hook', session: 'd', event: 'turn-start' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'd', after: 'prompt' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'prompt' }],
    }),
    scenario({
      id: 'V5', app: 'vscode', title: 'A tap on an agent in the second window: only that window shows its terminal, and VS Code comes up',
      dims: ['D3', 'D7'], sessions: [vscode('a'), vscode('b', { window: 'w2' }), ghost],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: false },
        { kind: 'editor.window', window: 'w2', active: 'b', focused: true },
        ...listed('vscode', ['a', 'b']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' },
        { id: 'openKept', kind: 'open', dim: 'D7', session: 'b', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'V6', app: 'vscode', title: 'A tap on a panel session at rest opens it by its vscode:// link',
      dims: ['D3'], sessions: [panel('d'), ghost],
      steps: [
        ...started(['d']),
        ...listed('vscode', ['d']),
        { label: 'tap', kind: 'tap', session: 'd' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'd', link: true, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: true, after: 'tap' }],
    }),
    scenario({
      id: 'V7', app: 'vscode', title: 'A turn in a terminal: working, then needs you on a permission, then done, and the recap is its answer',
      dims: ['D4', 'D6'], sessions: [vscode('a'), ghost],
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a']),
        { label: 'turn', kind: 'hook', session: 'a', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { label: 'ask', kind: 'hook', session: 'a', event: 'needs-input', asks: 'permission' },
        { kind: 'wait', ms: 2 * S },
        { label: 'stop', kind: 'hook', session: 'a', event: 'turn-stop', lastAnswer: 'Eval answer one.' },
      ],
      checks: [
        { id: 'working', kind: 'state', dim: 'D4', session: 'a', state: 'working', after: 'turn' },
        { id: 'needsYou', kind: 'state', dim: 'D4', session: 'a', state: 'needs-you', after: 'ask' },
        { id: 'done', kind: 'state', dim: 'D4', session: 'a', state: 'done', after: 'stop' },
        { id: 'recap', kind: 'recap', dim: 'D6', session: 'a', text: 'Eval answer one.', after: 'stop' },
      ],
      probes: [{ id: 'recap', kind: 'recap', dim: 'D6', session: 'z', text: 'Eval answer one.', after: 'stop' }],
    }),
    scenario({
      id: 'V8', app: 'vscode', title: 'Voice on a Claude Code in a terminal, at rest: the exact words reach it, once',
      dims: ['D5'], sessions: [vscode('a'), ghost],
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }),
    scenario({
      id: 'V9', app: 'vscode', title: 'Voice on a Codex in a terminal with a CODEX_HOME of its own: the exact words reach it, once',
      dims: ['D5'], sessions: [vscode('b', { engine: 'codex', codexHome: 'own' }), ghost],
      steps: [
        ...started(['b']),
        { kind: 'editor.window', window: 'w1', active: 'b', focused: true },
        ...listed('vscode', ['b']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }),
    scenario({
      id: 'V10', app: 'vscode', title: 'The window reloads: the ring is unchanged, and a tap shows the terminal on the new stream',
      dims: ['D7', 'D3'], sessions: [vscode('a'), vscode('b'), ghost],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a', 'b']),
        { label: 'reload', kind: 'editor.reload', window: 'w1' },
        { kind: 'wait', ms: 2 * S },
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [
        { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'vscode', expect: ['a', 'b'], after: 'reload' },
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'V11', app: 'vscode', title: 'VS Code started with code . from Terminal: its row is on the VS Code page, a tap shows it and a stroke scrolls it',
      dims: ['D1', 'D3', 'D7'], platforms: ['darwin'], world: { launchedFrom: 'terminal-app' }, sessions: [vscode('a'), ghost],
      // The field case (2026-11-20): it and its terminals inherit Terminal's bundle id, with TERM_PROGRAM=vscode.
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a']),
        { label: 'tap', kind: 'tap', session: 'a' },
        { kind: 'wait', ms: 1 * S },
        { label: 'stroke', kind: 'stroke' },
        { kind: 'wait', ms: 1 * S },
        // With its window closed, no terminal takes the next stroke.
        { label: 'close', kind: 'editor.close', window: 'w1' },
        { kind: 'wait', ms: 1 * S },
        { label: 'skip', kind: 'stroke' },
      ],
      checks: [
        v11Ring,
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' },
        { id: 'scroll', kind: 'scroll', dim: 'D3', session: 'a', after: 'stroke', at: 'close' },
        { id: 'logged', kind: 'logged', dim: 'D7', after: 'skip' },
      ],
      // Not a scroll probe: while the row is filed under Terminal (the spec's Expected to fail at baseline) no stroke
      // reaches a terminal, and a scroll check with no line seen has nothing to say. The ghost was never listed.
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'V12', app: 'vscode', title: 'Claude Code under tmux in a VS Code terminal: its row is on the VS Code page, and a tap shows that terminal',
      dims: ['D7', 'D1', 'D3'], tiers: ['b'], sessions: [vscode('a', { tmux: true }), ghost],
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a']),
        { label: 'tap', kind: 'tap', session: 'a' },
      ],
      checks: [
        { id: 'ring', kind: 'ring', dim: 'D1', page: 'vscode', expect: ['a'], apart: [] },
        { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'vscode', expect: ['a'] },
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'V13', app: 'vscode', title: 'No extension: the terminal agents are on the ring, a tap brings VS Code up, and a stroke says it was skipped',
      dims: ['D7', 'D3'], world: { extension: false }, sessions: [vscode('a'), ghost],
      steps: [
        ...started(['a']),
        // The window opens no stream.
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a']),
        { label: 'tap', kind: 'tap', session: 'a' },
        { kind: 'wait', ms: 1 * S },
        { label: 'stroke', kind: 'stroke' },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' },
        { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'vscode', expect: ['a'] },
        { id: 'logged', kind: 'logged', dim: 'D7', after: 'stroke' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'V14', app: 'vscode', title: 'VS Code quit and relaunched: the ring comes back right, no duplicate rows',
      dims: ['D7', 'D1'], sessions: [vscode('a'), vscode('b'), panel('d'), ghost],
      steps: [
        ...started(['a', 'b', 'd']),
        { kind: 'editor.window', window: 'w1', terminals: ['a', 'b'], active: 'a', focused: true },
        ...listed('vscode', ['a', 'b', 'd']),
        { label: 'quit', kind: 'quit', app: 'vscode' },
        { kind: 'wait', ms: EDITOR_AWAY_MS },
        { label: 'relaunch', kind: 'relaunch', app: 'vscode' },
      ],
      checks: [{ ...v14Ring, id: 'ringKept', dim: 'D7' }, v14Ring],
      probes: [withGhost(v14Ring)],
    }),
    scenario({
      id: 'V15', app: 'vscode', title: 'The dial unplugged and plugged in again: the ring and the focused row come back, and a tap shows the terminal',
      dims: ['D7', 'D3'], sessions: [vscode('a'), vscode('b'), ghost],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('vscode', ['a', 'b']),
        { kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 1 * S },
        { label: 'unplug', kind: 'unplug' },
        { kind: 'wait', ms: 3 * S },
        { label: 'replug', kind: 'replug' },
        ...listed('vscode', ['a', 'b']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [
        { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'vscode', expect: ['a', 'b'], after: 'replug' },
        { id: 'focusKept', kind: 'focus', dim: 'D7', session: 'b', after: 'replug', at: 'tap' },
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
  ]
}
