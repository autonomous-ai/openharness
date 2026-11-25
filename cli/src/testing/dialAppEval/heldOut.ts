// Held out (docs/plans/2026-11-21-dial-app-eval-design.md, Held-out set, and the editors'
// docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, Held-out set): whoever fixes a failing group of the dial eval
// does not read this file.
//
// Scored and reported apart, never in the headline score. A function, not a list: the catalog imports it and it uses
// the catalog's builders, so it is called once the catalog has them.
import { chatgptGhost, claudeGhost, claudeSession, claudeSessions, cursor, editorGhost, itermGhost, itermSession, keys, listed, orcaGhost,
  orcaOpening, orcaSession, orcaStarted, panel, S, scenario, started, threads, titleOf, turned, vscode, withGhost } from './catalog.js'
import type { Check, Scenario } from './types.js'

export function heldOut(): Scenario[] {
  const s16 = keys('s', 1, 16, 2)
  const s20 = keys('s', 1, 20, 2)
  // IH3's twenty start s20 first: the ring keeps the sixteen newest in the order they entered, s16 first
  // (cable/hosts/select.ts DialRing).
  const ih3Ring: Extract<Check, { kind: 'ring' }> =
    { id: 'ring', kind: 'ring', dim: 'D1', page: 'iterm', expect: [...s16].reverse(), apart: [] }
  // iTerm2's scenarios run on macOS alone (docs/plans/2026-11-22-dial-eval-iterm2-design.md, decision 2).
  const darwin = { platforms: ['darwin' as const] }
  return [
    scenario({
      id: 'CH1', app: 'claude', title: 'Sixteen sessions and a new one: the oldest leaves, the new one is first',
      dims: ['D1'], tiers: ['a'], sessions: [...claudeSessions(s16), claudeSession('s00', 30 * S), claudeGhost],
      steps: [
        { kind: 'claude.write', sessions: s16 },
        ...listed('claude', s16),
        { label: 'new', kind: 'claude.write', sessions: ['s00'] },
      ],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['s00', ...s16.slice(0, 15)], after: 'new' }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['s00', ...s16.slice(0, 15), 'z'], after: 'new' }],
    }, true),
    scenario({
      id: 'CH2', app: 'claude', title: 'A long title with an emoji: the row\'s name is the title as the daemon\'s title rule makes it',
      dims: ['D1'], tiers: ['a'],
      sessions: [claudeSession('a', 60 * S, { title: `Eval 🎉 ${'abcdefghij'.repeat(7)}` }), claudeGhost],
      steps: [{ kind: 'claude.write', sessions: ['a'] }],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a'] }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'z'] }],
    }, true),
    scenario({
      id: 'CH3', app: 'claude', title: 'Voice on the focused session while another is working: only the focused one gets it',
      dims: ['D5'], sessions: [...claudeSessions(['a', 'b']), claudeGhost],
      steps: [
        { kind: 'claude.write', sessions: ['a', 'b'] },
        { kind: 'hook', session: 'a', event: 'start' },
        { kind: 'hook', session: 'b', event: 'start' },
        { kind: 'hook', session: 'b', event: 'turn-start' },
        ...listed('claude', ['a', 'b']),
        // The dial lands on the working b: the person turns to a and rests there before speaking.
        { kind: 'swipe', session: 'a' },
        { kind: 'wait', ms: 1 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }, true),
    scenario({
      id: 'XH1', app: 'chatgpt', title: 'A thread renamed after it is listed: its row\'s name updates',
      dims: ['D1'], tiers: ['a'], sessions: [...threads(['t1', 't2']), chatgptGhost],
      steps: [
        { kind: 'codex.write', sessions: ['t1', 't2'] },
        ...listed('chatgpt', ['t1', 't2']),
        // Only Codex's names change: the threads' rows stay as they were.
        { label: 'rename', kind: 'codex.write', sessions: [], names: { t1: 'Eval Renamed' } },
      ],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1', 't2'], after: 'rename' }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1', 't2', 'z'], after: 'rename' }],
    }, true),
    scenario({
      id: 'XH2', app: 'chatgpt', title: 'A thread opened in the app while the dial shows the Claude app\'s page: the dial moves to it',
      dims: ['D2'], sessions: [claudeSession('a', 60 * S), ...threads(['t1', 't2']), chatgptGhost], world: { front: 'claude' },
      // The ChatGPT page opens on its first tile, t1: only the title line can land the dial on t2.
      steps: [
        { kind: 'claude.write', sessions: ['a'] },
        { kind: 'codex.write', sessions: ['t1', 't2'] },
        ...listed('claude', ['a']),
        { label: 'front', kind: 'front', app: 'chatgpt' },
        ...listed('chatgpt', ['t1', 't2']),
        { label: 'title', kind: 'thread', title: titleOf('t2') },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 't2', after: 'title' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'title' }],
    }, true),
    scenario({
      id: 'XH3', app: 'chatgpt', title: 'Voice 200 ms after a follow moved the dial: the words reach the newly focused thread',
      dims: ['D5'], sessions: [...threads(['t1', 't2']), chatgptGhost],
      // Both threads have a running session, idle, so the words can reach either.
      steps: [
        { kind: 'codex.write', sessions: ['t1', 't2'] },
        { kind: 'hook', session: 't1', event: 'start' },
        { kind: 'hook', session: 't2', event: 'start' },
        ...listed('chatgpt', ['t1', 't2']),
        { kind: 'front', app: 'chatgpt' },
        { label: 'follow', kind: 'thread', title: titleOf('t2') },
        { kind: 'wait', ms: 200 },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for two.', target: 't2' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 't2', text: 'Eval words for two.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for two.', after: 'voice' }],
    }, true),
    scenario({
      id: 'VH1', app: 'vscode', title: 'Voice on the focused terminal agent while another terminal\'s agent is working: only the focused one gets it',
      dims: ['D5'], sessions: [vscode('a'), vscode('b'), editorGhost('vscode')],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', terminals: ['a', 'b'], active: 'a', focused: true },
        { kind: 'hook', session: 'b', event: 'turn-start' },
        ...listed('vscode', ['a', 'b']),
        // Wherever b's turn moved the dial, the person turns to a and rests there before speaking.
        { kind: 'swipe', session: 'a' },
        { kind: 'wait', ms: 1 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }, true),
    scenario({
      id: 'VH2', app: 'vscode', title: 'Two windows report the same shell: a tap shows it in the window that reported it last',
      dims: ['D3', 'D7'], sessions: [vscode('a'), editorGhost('vscode')],
      // As when a terminal moves from w1 to w2: w1's state still lists it.
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: false },
        { kind: 'editor.window', window: 'w2', terminals: ['a'], active: 'a', focused: true },
        ...listed('vscode', ['a']),
        { label: 'tap', kind: 'tap', session: 'a' },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' },
        { id: 'openKept', kind: 'open', dim: 'D7', session: 'a', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }, true),
    scenario({
      id: 'VH3', app: 'vscode', title: 'The second pane of a split terminal in a window behind focused: the dial follows to its agent',
      dims: ['D2'], sessions: [vscode('a'), vscode('c', { window: 'w2' }), vscode('b', { window: 'w2' }), editorGhost('vscode')],
      // b runs in a split of c's terminal group in a second window, behind the first: its focus brings that window up.
      steps: [
        ...started(['a', 'c', 'b']),
        { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: true },
        { kind: 'editor.window', window: 'w2', terminals: ['c', 'b'], active: 'c', focused: false },
        ...listed('vscode', ['a', 'c', 'b']),
        { label: 'focus', kind: 'editor.focus', session: 'b' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'focus' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'focus' }],
    }, true),
    scenario({
      id: 'VH4', app: 'vscode', title: 'Voice on a panel session at rest: the exact words reach it, once',
      dims: ['D5'], sessions: [panel('d', 'vscode'), editorGhost('vscode')],
      steps: [
        ...started(['d']),
        ...listed('vscode', ['d']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for delta.', target: 'd' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'd', text: 'Eval words for delta.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for delta.', after: 'voice' }],
    }, true),
    scenario({
      id: 'UH1', app: 'cursor', title: 'Cursor started with cursor . from Terminal: its row is on the Cursor page, and a tap shows its terminal',
      dims: ['D1', 'D3'], platforms: ['darwin'], world: { launchedFrom: 'terminal-app' }, sessions: [cursor('a'), editorGhost('cursor')],
      // The field case's cause in the other app: Cursor and its terminals inherit Terminal's bundle id.
      steps: [
        ...started(['a']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('cursor', ['a']),
        { label: 'tap', kind: 'tap', session: 'a' },
      ],
      checks: [
        { id: 'ring', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['a'], apart: [] },
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }, true),
    scenario({
      id: 'UH2', app: 'cursor', title: 'Cursor\'s own agent in a multi-root workspace: a tap opens its first folder',
      dims: ['D3'],
      sessions: [cursor('c', { place: 'agent', window: undefined, cwd: '/work/eval-c', folders: ['/work/eval-c1', '/work/eval-c2'] }),
        editorGhost('cursor')],
      steps: [
        ...started(['c']),
        ...listed('cursor', ['c']),
        { label: 'tap', kind: 'tap', session: 'c' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }, true),
    scenario({
      id: 'UH3', app: 'cursor', title: 'Voice 200 ms after a prompt typed in another Cursor terminal moved the dial: the words reach that agent',
      dims: ['D5'], sessions: [cursor('a'), cursor('b'), editorGhost('cursor')],
      steps: [
        ...started(['a', 'b']),
        { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
        ...listed('cursor', ['a', 'b']),
        { label: 'prompt', kind: 'hook', session: 'b', event: 'turn-start' },
        { kind: 'wait', ms: 200 },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }, true),
    scenario({
      id: 'OH1', app: 'orca', title: 'Voice on the focused Codex agent while another Orca agent is working: only the focused one gets it',
      dims: ['D5'], sessions: [orcaSession('a', { engine: 'codex' }), orcaSession('b', { tab: 1 }), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        { kind: 'hook', session: 'b', event: 'turn-start' },
        ...listed('orca', ['a', 'b']),
        // Wherever b's turn moved the dial, the person turns to a and rests there before speaking.
        { kind: 'swipe', session: 'a' },
        { kind: 'wait', ms: 1 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', path: 'typed', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }, true),
    scenario({
      id: 'OH2', app: 'orca', title: 'Voice 200 ms after a focus line moved the dial: the words are typed into the newly focused pane',
      dims: ['D5'], sessions: [orcaSession('a', { engine: 'codex' }), orcaSession('b', { engine: 'codex', tab: 1 }), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'focus', kind: 'orca.focus', session: 'b' },
        { kind: 'wait', ms: 200 },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', path: 'typed', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }, true),
    scenario({
      id: 'OH3', app: 'orca', title: 'A tap on an agent in a pane another program made: its pane is switched and Orca brought forward',
      dims: ['D3'], sessions: [orcaSession('a'), orcaSession('b', { tab: 1, held: true }), orcaGhost],
      steps: [
        ...orcaOpening(['w1']),
        ...orcaStarted(['b', 'a']),
        ...listed('orca', ['a', 'b']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }, true),
    scenario({
      id: 'OH4', app: 'orca', title: 'Two Claude Code agents in one worktree, one with no handle in its hooks: each is its own row, in tab order',
      dims: ['D1'], sessions: [orcaSession('a'), orcaSession('b', { tab: 1, handle: 'none' }), orcaGhost],
      // b's pane is laid out like any other: only elimination can tell its hooks from a's.
      steps: [...orcaOpening(['w1']), ...orcaStarted(['b', 'a'])],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'orca', expect: ['a', 'b'] }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'orca', expect: ['a', 'b', 'z'] }],
    }, true),
    scenario({
      id: 'IH1', app: 'iterm', title: 'Voice 200 ms after a tab selection moved the dial: the words reach the newly followed agent',
      // a first, so the face is on a: only the select can bring it to b before the words.
      dims: ['D5'], ...darwin, sessions: [itermSession('a'), itermSession('b', { tab: 1 }), itermGhost],
      steps: [
        ...started(['a', 'b']),
        ...listed('iterm', ['a', 'b']),
        { label: 'select', kind: 'iterm.select', window: 'w1', tab: 1 },
        { kind: 'wait', ms: 200 },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }, true),
    scenario({
      id: 'IH2', app: 'iterm', title: 'tmux with clients in two tabs, the person typing into the second: a tap goes to the second tab',
      dims: ['D3'], ...darwin, sessions: [itermSession('a'), itermSession('b', { place: 'tmux', tab: 1 }), itermGhost],
      // A turn typed through each client in turn: the first tab's, then the second's, the one a tap must select.
      steps: [
        ...started(['a', 'b']),
        ...listed('iterm', ['a'], ['b']),
        { kind: 'iterm.tab', window: 'w1', tab: 2 },
        { label: 'attach', kind: 'tmux.attach', session: 'b', window: 'w1', tab: 2 },
        { kind: 'wait', ms: 1 * S },
        { kind: 'iterm.select', window: 'w1', tab: 1 },
        { kind: 'wait', ms: 1 * S },
        { kind: 'hook', session: 'b', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { kind: 'hook', session: 'b', event: 'turn-stop' },
        { kind: 'wait', ms: 1 * S },
        { kind: 'iterm.select', window: 'w1', tab: 2 },
        { kind: 'wait', ms: 1 * S },
        { label: 'turn', kind: 'hook', session: 'b', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        ...listed('tmux', ['b'], ['a']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, tab: 'w1.2.0', after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }, true),
    scenario({
      id: 'IH3', app: 'iterm', title: 'Twenty tabs with agents: the ring keeps the sixteen newest',
      dims: ['D1'], tiers: ['a'], ...darwin, sessions: [...s20.map((key, i) => itermSession(key, { tab: i })), itermGhost],
      // s01 starts last, the newest.
      steps: [...started([...s20].reverse())],
      checks: [ih3Ring],
      probes: [withGhost(ih3Ring)],
    }, true),
    scenario({
      id: 'IH4', app: 'iterm', title: 'A scan-found herdr agent whose herdr row has no session: one row on herdr\'s page, and a tap reaches its tab',
      dims: ['D1', 'D3'], ...darwin, sessions: [itermSession('c', { place: 'herdr', herdrSession: false }), itermGhost],
      // Its turn puts its conversation on disk, so the scan after the restart finds it (the plan's Decision 13).
      steps: [
        ...started(['c']),
        ...turned(['c']),
        ...listed('herdr', ['c']),
        { label: 'restart', kind: 'devices.restart' },
        ...listed('herdr', ['c']),
        { label: 'tap', kind: 'tap', session: 'c' },
      ],
      checks: [
        { id: 'ring', kind: 'ring', dim: 'D1', page: 'herdr', expect: ['c'], apart: [], after: 'restart', at: 'tap' },
        { id: 'open', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }, true),
    scenario({
      id: 'IH5', app: 'iterm', title: 'Codex in a tmux pane under the daemon\'s CODEX_HOME: working, then done, with its recap',
      dims: ['D4', 'D6'], ...darwin, sessions: [itermSession('b', { place: 'tmux', engine: 'codex' }), itermGhost],
      steps: [
        ...started(['b']),
        ...listed('tmux', ['b']),
        { label: 'turn', kind: 'hook', session: 'b', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { label: 'stop', kind: 'hook', session: 'b', event: 'turn-stop', lastAnswer: 'Eval codex answer.' },
      ],
      checks: [
        { id: 'working', kind: 'state', dim: 'D4', session: 'b', state: 'working', after: 'turn', at: 'stop' },
        { id: 'done', kind: 'state', dim: 'D4', session: 'b', state: 'done', after: 'stop' },
        { id: 'recap', kind: 'recap', dim: 'D6', session: 'b', text: 'Eval codex answer.', after: 'stop' },
      ],
      probes: [{ id: 'recap', kind: 'recap', dim: 'D6', session: 'z', text: 'Eval codex answer.', after: 'stop' }],
    }, true),
  ]
}
