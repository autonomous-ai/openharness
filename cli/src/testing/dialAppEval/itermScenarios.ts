/**
 * iTerm2's main set (docs/plans/2026-11-22-dial-eval-iterm2-design.md, "Main set"; the rows of
 * docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Task 9). A function, not a list: the catalog imports it and it uses the
 * catalog's builders, so it is called once the catalog has them.
 *
 * Every scenario runs on macOS alone (the spec's decision 2). An agent keeps its place in the ring from when it entered
 * (cable/hosts/select.ts DialRing), so every ring here lists its agents in the order they started, and the face is on the
 * first: a check that the dial moves to a row starts that row's agent later, so the dial must move for it to pass.
 *
 * An agent in tmux or herdr is on iTerm2's page and on the multiplexer's (Diego's 2026-11-26 rule,
 * docs/plans/2026-11-26-dial-mux-host-pages-design.md): iTerm2's page lists every agent here, a follow in iTerm2 moves
 * the dial there, and tmux's and herdr's pages are reached by a pick.
 */
import type { Nest } from '../../cable/hosts/types.js'
import { counted, itermGhost, itermSession, listed, S, scenario, started, turned, withGhost } from './catalog.js'
import type { Check, Scenario, SessionDef, SessionKey } from './types.js'

type Ring = Extract<Check, { kind: 'ring' }>
/** On iTerm2's page, with `apart` the agents it does not list; the grader counts each listed one on its multiplexer's
 *  page too. */
const ring = (expect: SessionKey[], more: Partial<Ring> = {}): Ring =>
  ({ id: 'ring', kind: 'ring', dim: 'D1', page: 'iterm', expect, apart: [], ...more })
const ringKept = (expect: SessionKey[], more: Partial<Ring> = {}): Ring => ring(expect, { id: 'ringKept', dim: 'D7', ...more })
/** On tmux's or herdr's page, which count their agents across every terminal app (Diego, 2026-11-23): `ringTmux`,
 *  `ringHerdr`, so iTerm2's own page keeps its baseline keys. */
const ringOn = (page: Nest, expect: SessionKey[], more: Partial<Ring> = {}): Ring =>
  ring(expect, { id: `ring${page[0]!.toUpperCase()}${page.slice(1)}`, page, ...more })
const ringKeptOn = (page: Nest, expect: SessionKey[], more: Partial<Ring> = {}): Ring =>
  ringOn(page, expect, { id: `ringKept${page[0]!.toUpperCase()}${page.slice(1)}`, dim: 'D7', ...more })
/** A Claude Code in w1's tab `tab`, at split `split` of it. */
const tab = (key: SessionKey, at: number, split = 0): SessionDef => itermSession(key, { tab: at, split })
/** A Claude Code in a pane of tmux or herdr whose first client runs in w1's tab `at`, `split` its pane's order there. */
const inTmux = (key: SessionKey, at: number, split = 0): SessionDef => itermSession(key, { place: 'tmux', tab: at, split })
const inHerdr = (key: SessionKey, at: number, split = 0): SessionDef => itermSession(key, { place: 'herdr', tab: at, split })
const darwin = { platforms: ['darwin' as const] }

export function itermScenarios(): Scenario[] {
  /**
   * How long the person waits after a tap before the next one, their own timing: past the open's half mark, so a late
   * open still scores half before the next tap closes its window.
   */
  const tapRest = 4 * S
  /**
   * How long the person works on after herdr starts again, their own timing: past the devices' next 30 s look at their
   * agents' processes (services/devices.ts OBSERVED_TICK_MS) whatever its phase, and the push after it, so the ring graded
   * is the one that look leaves, with the old agents' processes gone.
   */
  const pastLook = 35 * S
  const i1Ring = ring(['a'])
  // Held as the select's window ends: the select keeps iTerm2's page.
  const i2Ring = ring(['a', 'b', 'c', 'd'], { at: 'toTmux' })
  const i3Ring = ring(['a', 'b', 'c', 'd'], { after: 'restart', at: 'toTmux' })
  return [
    scenario({
      id: 'I1', app: 'iterm', title: 'One tab running Claude Code: one row on iTerm2\'s page, by its name',
      dims: ['D1'], ...darwin, sessions: [tab('a', 0), itermGhost],
      steps: [...started(['a'])],
      checks: [i1Ring],
      probes: [withGhost(i1Ring)],
    }),
    scenario({
      id: 'I2', app: 'iterm', title: 'A plain tab, tmux in a tab and herdr with two panes in a tab: iTerm2 4, tmux 1, herdr 2',
      dims: ['D1', 'D2'], ...darwin, sessions: [tab('a', 0), inTmux('b', 1), inHerdr('c', 2), inHerdr('d', 2, 1), itermGhost],
      // Selecting b's tab keeps iTerm2's page and moves the dial to b; tmux's and herdr's pages are reached by a pick
      // (Diego's 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
      steps: [
        ...started(['a', 'b', 'c', 'd']),
        ...listed('iterm', ['a', 'b', 'c', 'd'], []),
        { label: 'select', kind: 'iterm.select', window: 'w1', tab: 1 },
        { kind: 'wait', ms: 2 * S },
        { label: 'toTmux', kind: 'pick', page: 'tmux' },
        ...listed('tmux', ['b'], ['a', 'c', 'd']),
        { label: 'toHerdr', kind: 'pick', page: 'herdr' },
        ...listed('herdr', ['c', 'd'], ['a', 'b']),
      ],
      checks: [
        i2Ring,
        { id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'select', at: 'toTmux' },
        ringOn('tmux', ['b'], { apart: ['a', 'c', 'd'], after: 'toTmux', at: 'toHerdr' }),
        ringOn('herdr', ['c', 'd'], { apart: ['a', 'b'], after: 'toHerdr' }),
      ],
      probes: [withGhost(i2Ring)],
    }),
    scenario({
      id: 'I3', app: 'iterm', title: 'The same four, idle, and the devices start again: iTerm2 4, tmux 1, herdr 2 come back before any hook',
      dims: ['D1', 'D7'], ...darwin, sessions: [tab('a', 0), inTmux('b', 1), inHerdr('c', 2), inHerdr('d', 2, 1), itermGhost],
      steps: [
        ...started(['a', 'b', 'c', 'd']),
        ...turned(['a', 'b', 'c', 'd']),
        // d's prompt, the last, moves the dial to d on iTerm2's page, which lists every agent here (Diego's 2026-11-26
        // rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['a', 'b', 'c', 'd'], []),
        { label: 'restart', kind: 'devices.restart' },
        // The Apps screen's counts before the picks, as a pick of a page the devices have not counted yet is ignored; the
        // rows the scan finds keep their names, read from Claude Code's process record, and the checks grade them.
        ...counted('iterm', { iterm: 4, tmux: 1, herdr: 2 }),
        { label: 'toTmux', kind: 'pick', page: 'tmux' },
        { kind: 'wait', ms: 2 * S },
        { label: 'toHerdr', kind: 'pick', page: 'herdr' },
        { kind: 'wait', ms: 2 * S },
      ],
      checks: [
        i3Ring,
        ringKept(['a', 'b', 'c', 'd'], { after: 'restart', at: 'toTmux' }),
        ringOn('tmux', ['b'], { apart: ['a', 'c', 'd'], after: 'toTmux', at: 'toHerdr' }),
        ringKeptOn('tmux', ['b'], { apart: ['a', 'c', 'd'], after: 'toTmux', at: 'toHerdr' }),
        ringOn('herdr', ['c', 'd'], { apart: ['a', 'b'], after: 'toHerdr' }),
        ringKeptOn('herdr', ['c', 'd'], { apart: ['a', 'b'], after: 'toHerdr' }),
      ],
      probes: [withGhost(i3Ring)],
    }),
    scenario({
      id: 'I4', app: 'iterm', title: 'A tab split in two, Claude Code in each: two rows, and a tap on each selects its own split',
      dims: ['D1', 'D3'], ...darwin, sessions: [tab('a', 0), tab('b', 0, 1), itermGhost],
      steps: [
        { kind: 'hook', session: 'a', event: 'start' },
        { kind: 'wait', ms: 1 * S },
        { label: 'split', kind: 'iterm.split', window: 'w1', tab: 0, split: 1 },
        { kind: 'wait', ms: 1 * S },
        { kind: 'hook', session: 'b', event: 'start' },
        ...listed('iterm', ['a', 'b']),
        { label: 'tapA', kind: 'tap', session: 'a' },
        { kind: 'wait', ms: tapRest },
        { label: 'tapB', kind: 'tap', session: 'b' },
      ],
      checks: [
        ring(['a', 'b']),
        { id: 'open', kind: 'open', dim: 'D3', session: 'a', link: false, after: 'tapA', at: 'tapB' },
        { id: 'openB', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tapB' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tapB' }],
    }),
    scenario({
      id: 'I5', app: 'iterm', title: 'A tap on a plain tab\'s row brings iTerm2 forward and selects its tab',
      dims: ['D3'], ...darwin, sessions: [tab('a', 0), tab('b', 1), itermGhost],
      steps: [...started(['a', 'b']), ...listed('iterm', ['a', 'b']), { label: 'tap', kind: 'tap', session: 'b' }],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'tap' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'I6', app: 'iterm', title: 'A rest on the tmux row with iTerm2 in front selects its client\'s tab and its pane',
      // d first in b's tmux: the pick lands the face on tmux's first row, so with b alone there the swipe would not move
      // the dial.
      dims: ['D3'], ...darwin, sessions: [tab('a', 0), inTmux('d', 1), inTmux('b', 1, 1), itermGhost],
      steps: [
        ...started(['a', 'd', 'b']),
        // iTerm2's page lists the tmux agents too (Diego's 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['a', 'd', 'b'], []),
        { kind: 'pick', page: 'tmux' },
        ...listed('tmux', ['d', 'b'], ['a']),
        { label: 'rest', kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 2 * S },
      ],
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'rest' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'rest' }],
    }),
    scenario({
      id: 'I7', app: 'iterm', title: 'A tap on each herdr row focuses its own pane, brings iTerm2 forward and selects its client\'s tab',
      dims: ['D3'], ...darwin, sessions: [tab('a', 0), inHerdr('c', 1), inHerdr('d', 1, 1), itermGhost],
      steps: [
        ...started(['a', 'c', 'd']),
        // iTerm2's page lists the herdr agents too (Diego's 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['a', 'c', 'd'], []),
        { kind: 'pick', page: 'herdr' },
        ...listed('herdr', ['c', 'd'], ['a']),
        { label: 'tapC', kind: 'tap', session: 'c' },
        { kind: 'wait', ms: tapRest },
        { label: 'tapD', kind: 'tap', session: 'd' },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'tapC', at: 'tapD' },
        { id: 'openD', kind: 'open', dim: 'D3', session: 'd', link: false, after: 'tapD' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tapD' }],
    }),
    scenario({
      id: 'I8', app: 'iterm', title: 'The person selects another tab in iTerm2: the dial follows to its agent',
      // a first, so the face is on a: the select must move it to b.
      dims: ['D2'], ...darwin, sessions: [tab('a', 0), tab('b', 1), itermGhost],
      steps: [...started(['a', 'b']), ...listed('iterm', ['a', 'b']), { label: 'select', kind: 'iterm.select', window: 'w1', tab: 1 }],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'select' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'select' }],
    }),
    scenario({
      id: 'I9', app: 'iterm', title: 'iTerm2 reports late the tab the dial selected before: the dial does not move back',
      dims: ['D2', 'D7'], ...darwin, sessions: [tab('a', 0), tab('b', 1), itermGhost],
      // The dial rests on b, then on a; iTerm2's report of b's tab, inside the devices' 2 s echo window after the dial
      // selected it, must not pull the dial back to b (the plan's Decision 12).
      steps: [
        ...started(['a', 'b']),
        ...listed('iterm', ['a', 'b']),
        { label: 'toB', kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 1 * S },
        { label: 'toA', kind: 'swipe', session: 'a' },
        { kind: 'wait', ms: 500 },
        { label: 'echo', kind: 'iterm.select', window: 'w1', tab: 1 },
        { kind: 'wait', ms: 3 * S },
      ],
      checks: [
        { id: 'echo', kind: 'focus', dim: 'D2', session: 'a', after: 'toA', noBounce: true },
        { id: 'still', kind: 'still', dim: 'D7', ms: 3 * S, after: 'echo' },
      ],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'toA' }],
    }),
    scenario({
      id: 'I10', app: 'iterm', title: 'The person moves to another tmux pane in the selected tab: the dial follows to its agent',
      // The person is on a's pane, so the select moves the dial to a, its active pane and heard from last in that tab: the
      // move to b's pane must bring it to b. b's pane is active once both start, and a move to it would move nothing.
      dims: ['D2'], ...darwin, sessions: [inTmux('a', 0), inTmux('b', 0, 1), itermGhost],
      steps: [
        ...started(['b', 'a']),
        // iTerm2 holds no agent of its own, but its page lists the agents whose tmux client runs in it, and the dial
        // follows the pane switch there (Diego's 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['b', 'a']),
        { kind: 'tmux.selectPane', session: 'a' },
        { kind: 'wait', ms: 1 * S },
        { label: 'select', kind: 'iterm.select', window: 'w1', tab: 0 },
        { kind: 'wait', ms: 2 * S },
        { label: 'pane', kind: 'tmux.selectPane', session: 'b' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'pane' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'pane' }],
    }),
    scenario({
      id: 'I11', app: 'iterm', title: 'The person moves to the other herdr pane in the selected tab: the dial follows to its agent',
      // As I10's: the select moves the dial to c, the pane move must bring it to d, on iTerm2's page (Diego's 2026-11-26
      // rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
      dims: ['D2'], ...darwin, sessions: [inHerdr('c', 0), inHerdr('d', 0, 1), itermGhost],
      steps: [
        ...started(['d', 'c']),
        ...listed('iterm', ['d', 'c']),
        { label: 'select', kind: 'iterm.select', window: 'w1', tab: 0 },
        { kind: 'wait', ms: 2 * S },
        { label: 'pane', kind: 'herdr.focus', session: 'd' },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'd', after: 'pane' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'pane' }],
    }),
    scenario({
      id: 'I12', app: 'iterm', title: 'A tab closed with its agent: its row leaves; a new tab with a new agent: a new row',
      dims: ['D1', 'D7'], ...darwin, sessions: [tab('a', 0), tab('b', 1), tab('c', 2), itermGhost],
      steps: [
        ...started(['a', 'b']),
        ...listed('iterm', ['a', 'b']),
        { label: 'close', kind: 'iterm.closeTab', window: 'w1', tab: 1 },
        ...listed('iterm', ['a']),
        { label: 'new', kind: 'iterm.tab', window: 'w1', tab: 2 },
        { kind: 'hook', session: 'c', event: 'start' },
        ...listed('iterm', ['a', 'c']),
      ],
      checks: [
        ring(['a'], { id: 'closed', after: 'close', at: 'new', timed: true }),
        ring(['a', 'c'], { id: 'added', after: 'new', timed: true }),
        ringKept(['a', 'c'], { after: 'new' }),
      ],
      probes: [ring(['a', 'c', 'z'], { after: 'new' })],
    }),
    scenario({
      id: 'I13', app: 'iterm', title: 'tmux detached, then attached from another tab with no turn after: the row stays, and a tap goes to the new tab',
      dims: ['D7', 'D3'], ...darwin, sessions: [tab('a', 0), inTmux('b', 1), itermGhost],
      steps: [
        ...started(['a', 'b']),
        // b is on iTerm2's page while a client of its tmux runs in iTerm2, and on tmux's (Diego's 2026-11-26 rule,
        // docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['a', 'b'], []),
        { label: 'detach', kind: 'tmux.detach', session: 'b' },
        { kind: 'wait', ms: 2 * S },
        { kind: 'iterm.tab', window: 'w1', tab: 2 },
        { label: 'attach', kind: 'tmux.attach', session: 'b', window: 'w1', tab: 2 },
        { kind: 'wait', ms: 2 * S },
        { label: 'toTmux', kind: 'pick', page: 'tmux' },
        ...listed('tmux', ['b'], ['a']),
        { label: 'tap', kind: 'tap', session: 'b' },
      ],
      checks: [
        ringKept(['a', 'b'], { after: 'attach', at: 'toTmux' }),
        ringKeptOn('tmux', ['b'], { apart: ['a'], after: 'toTmux', at: 'tap' }),
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, tab: 'w1.2.0', after: 'tap' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'tap' }],
    }),
    scenario({
      id: 'I14', app: 'iterm', title: 'herdr restarted, its agents ending and starting again: the rows come back, one each',
      dims: ['D7', 'D1'], ...darwin, sessions: [tab('a', 0), inHerdr('c', 1), inHerdr('d', 1, 1), itermGhost],
      steps: [
        ...started(['a', 'c', 'd']),
        // iTerm2's page lists the herdr agents too (Diego's 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['a', 'c', 'd'], []),
        { kind: 'pick', page: 'herdr' },
        ...listed('herdr', ['c', 'd'], ['a']),
        { label: 'restart', kind: 'herdr.restart' },
        ...listed('herdr', ['c', 'd'], ['a']),
        { kind: 'wait', ms: pastLook },
        { label: 'toIterm', kind: 'pick', page: 'iterm' },
        ...listed('iterm', ['a', 'c', 'd'], []),
      ],
      checks: [
        ringOn('herdr', ['c', 'd'], { apart: ['a'], after: 'restart', at: 'toIterm' }),
        ringKeptOn('herdr', ['c', 'd'], { apart: ['a'], after: 'restart', at: 'toIterm' }),
        ring(['a', 'c', 'd'], { after: 'toIterm' }),
        ringKept(['a', 'c', 'd'], { after: 'toIterm' }),
      ],
      probes: [ringOn('herdr', ['c', 'd', 'z'], { apart: ['a'], after: 'restart', at: 'toIterm' })],
    }),
    scenario({
      id: 'I15', app: 'iterm', title: 'iTerm2 relaunched keeping its sessions, then the devices start again: tmux\'s and herdr\'s rows come back on iTerm2\'s page and theirs, with their tabs',
      dims: ['D7', 'D1'], ...darwin, sessions: [tab('a', 0), inTmux('b', 1), inHerdr('c', 2), itermGhost],
      // b and c are on iTerm2's page and on their multiplexer's (Diego's 2026-11-26 rule,
      // docs/plans/2026-11-26-dial-mux-host-pages-design.md).
      steps: [
        ...started(['a', 'b', 'c']),
        ...turned(['a', 'b', 'c']),
        // c's prompt, the last, moves the dial to c on iTerm2's page.
        ...listed('iterm', ['a', 'b', 'c'], []),
        { label: 'relaunch', kind: 'iterm.relaunch' },
        { kind: 'wait', ms: 2 * S },
        { label: 'restart', kind: 'devices.restart' },
        // Listed waits, as the taps need their rows listed; each tap on the page that lists its row. The pick waits for
        // the Apps screen's counts too, as a pick of a page the devices have not counted yet is ignored.
        ...listed('iterm', ['a', 'b', 'c'], []),
        ...counted('iterm', { iterm: 3, tmux: 1, herdr: 1 }),
        { label: 'toTmux', kind: 'pick', page: 'tmux' },
        ...listed('tmux', ['b'], ['a', 'c']),
        { label: 'tapB', kind: 'tap', session: 'b' },
        { kind: 'wait', ms: tapRest },
        { label: 'toHerdr', kind: 'pick', page: 'herdr' },
        ...listed('herdr', ['c'], ['a', 'b']),
        { label: 'tapC', kind: 'tap', session: 'c' },
      ],
      checks: [
        ring(['a', 'b', 'c'], { after: 'restart', at: 'toTmux' }),
        ringKept(['a', 'b', 'c'], { after: 'restart', at: 'toTmux' }),
        ringOn('tmux', ['b'], { apart: ['a', 'c'], after: 'toTmux', at: 'tapB' }),
        ringKeptOn('tmux', ['b'], { apart: ['a', 'c'], after: 'toTmux', at: 'tapB' }),
        ringOn('herdr', ['c'], { apart: ['a', 'b'], after: 'toHerdr', at: 'tapC' }),
        ringKeptOn('herdr', ['c'], { apart: ['a', 'b'], after: 'toHerdr', at: 'tapC' }),
        { id: 'openKeptB', kind: 'open', dim: 'D7', session: 'b', link: false, after: 'tapB', at: 'toHerdr' },
        { id: 'openKeptC', kind: 'open', dim: 'D7', session: 'c', link: false, after: 'tapC' },
      ],
      probes: [ring(['a', 'b', 'c', 'z'], { after: 'restart', at: 'toTmux' })],
    }),
    scenario({
      id: 'I16', app: 'iterm', title: 'A long turn in a plain tab: working, then done, and the last answer is the recap',
      dims: ['D4', 'D6'], ...darwin, sessions: [tab('a', 0), itermGhost],
      // Past the firmware's 25 s fuse, so the devices' 20 s reminder is on its path (the plan's Decision 19).
      steps: [
        ...started(['a']),
        ...listed('iterm', ['a']),
        { label: 'turn', kind: 'hook', session: 'a', event: 'turn-start' },
        { kind: 'wait', ms: 30 * S },
        { label: 'stop', kind: 'hook', session: 'a', event: 'turn-stop', lastAnswer: 'Eval answer one.' },
      ],
      checks: [
        { id: 'working', kind: 'state', dim: 'D4', session: 'a', state: 'working', after: 'turn', at: 'stop' },
        { id: 'done', kind: 'state', dim: 'D4', session: 'a', state: 'done', after: 'stop' },
        { id: 'recap', kind: 'recap', dim: 'D6', session: 'a', text: 'Eval answer one.', after: 'stop' },
      ],
      probes: [{ id: 'recap', kind: 'recap', dim: 'D6', session: 'z', text: 'Eval answer one.', after: 'stop' }],
    }),
    scenario({
      id: 'I17', app: 'iterm', title: 'Claude Code in tmux asks for a permission: the row needs you',
      dims: ['D4'], ...darwin, sessions: [inTmux('b', 0), itermGhost],
      steps: [
        ...started(['b']),
        // With iTerm2 in front the dial shows iTerm2's page, which lists b too (Diego's 2026-11-26 rule,
        // docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['b']),
        { label: 'turn', kind: 'hook', session: 'b', event: 'turn-start' },
        { kind: 'wait', ms: 2 * S },
        { label: 'ask', kind: 'hook', session: 'b', event: 'needs-input', asks: 'permission' },
      ],
      checks: [{ id: 'needsYou', kind: 'state', dim: 'D4', session: 'b', state: 'needs-you', after: 'ask' }],
      probes: [{ id: 'needsYou', kind: 'state', dim: 'D4', session: 'z', state: 'needs-you', after: 'ask' }],
    }),
    scenario({
      id: 'I18', app: 'iterm', title: 'Voice on the plain tab\'s agent: the exact words reach it, once',
      // a first, so the face is on a as the person speaks: words go to the row on the face.
      dims: ['D5'], ...darwin, sessions: [tab('a', 0), tab('b', 1), itermGhost],
      steps: [
        ...started(['a', 'b']),
        ...listed('iterm', ['a', 'b']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }),
    scenario({
      id: 'I19', app: 'iterm', title: 'Voice on the tmux agent: the exact words reach it, once',
      // a first, so the face is on a: the person selects b's tab, which moves the dial to b on iTerm2's page (Diego's
      // 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md), and speaks: words that reach a are a
      // wrong send.
      dims: ['D5'], ...darwin, sessions: [tab('a', 0), inTmux('b', 1), itermGhost],
      steps: [
        ...started(['a', 'b']),
        ...listed('iterm', ['a', 'b'], []),
        { kind: 'iterm.select', window: 'w1', tab: 1 },
        { kind: 'wait', ms: 2 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for bravo.', target: 'b' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'b', text: 'Eval words for bravo.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for bravo.', after: 'voice' }],
    }),
    scenario({
      id: 'I20', app: 'iterm', title: 'Voice on one herdr pane\'s agent beside another, idle: only the target gets the words',
      dims: ['D5'], ...darwin, sessions: [inHerdr('c', 0), inHerdr('d', 0, 1), itermGhost],
      steps: [
        // d first, so the face is on d: the person turns to c, and words for c reaching d are a wrong send. With iTerm2 in
        // front the dial shows iTerm2's page, which lists them (Diego's 2026-11-26 rule,
        // docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...started(['d', 'c']),
        ...listed('iterm', ['d', 'c']),
        { kind: 'swipe', session: 'c' },
        { kind: 'wait', ms: 1 * S },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for charlie.', target: 'c' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'c', text: 'Eval words for charlie.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for charlie.', after: 'voice' }],
    }),
    scenario({
      id: 'I21', app: 'iterm', title: 'The dial unplugged and plugged in again: the ring and the focused row come back',
      // d first in b's tmux, as in I6: the pick lands the face on d, so focusKept must keep a face the swipe moved.
      dims: ['D7'], ...darwin, sessions: [tab('a', 0), inTmux('d', 1), inTmux('b', 1, 1), inHerdr('c', 2), itermGhost],
      steps: [
        ...started(['a', 'd', 'b', 'c']),
        // iTerm2's page lists every agent here (Diego's 2026-11-26 rule, docs/plans/2026-11-26-dial-mux-host-pages-design.md).
        ...listed('iterm', ['a', 'd', 'b', 'c'], []),
        { kind: 'pick', page: 'tmux' },
        // The swipe needs b's row, or the replug has no focus to keep.
        ...listed('tmux', ['d', 'b'], ['a', 'c']),
        { kind: 'swipe', session: 'b' },
        { kind: 'wait', ms: 1 * S },
        { label: 'unplug', kind: 'unplug' },
        { kind: 'wait', ms: 3 * S },
        { label: 'replug', kind: 'replug' },
        ...listed('tmux', ['d', 'b'], ['a', 'c']),
        { label: 'toIterm', kind: 'pick', page: 'iterm' },
        ...listed('iterm', ['a', 'd', 'b', 'c'], []),
        { label: 'toHerdr', kind: 'pick', page: 'herdr' },
        ...listed('herdr', ['c'], ['a', 'd', 'b']),
      ],
      checks: [
        ringKeptOn('tmux', ['d', 'b'], { apart: ['a', 'c'], after: 'replug', at: 'toIterm' }),
        { id: 'focusKept', kind: 'focus', dim: 'D7', session: 'b', after: 'replug', at: 'toIterm' },
        ringKept(['a', 'd', 'b', 'c'], { after: 'toIterm', at: 'toHerdr' }),
        ringKeptOn('herdr', ['c'], { apart: ['a', 'd', 'b'], after: 'toHerdr' }),
      ],
      probes: [ringKeptOn('tmux', ['d', 'b', 'z'], { apart: ['a', 'c'], after: 'replug', at: 'toIterm' })],
    }),
    // I22-I24 (docs/plans/2026-11-26-dial-mux-host-pages-design.md, Testing, "New"): with another app in front, a pick or
    // a rest on tmux's or herdr's page brings iTerm2 on the agent's tab and pane. Tier A's world records the bring but
    // moves no front app, so I22 and I23 report iTerm2 in front themselves within 2 s of it (cable/hosts/appFilter.ts
    // DIAL_BRINGS_MS): that settle is the dial's, and the page holds.
    scenario({
      id: 'I22', app: 'iterm', title: 'tmux\'s page picked with another app in front: iTerm2 comes forward on b\'s tab and pane, and the dial stays on tmux\'s page',
      dims: ['D3', 'D7'], ...darwin, world: { front: 'other' }, sessions: [tab('a', 0), inTmux('b', 1), itermGhost],
      steps: [
        ...started(['a', 'b']),
        ...counted('iterm', { iterm: 2, tmux: 1 }),
        { label: 'pick', kind: 'pick', page: 'tmux' },
        { kind: 'wait', ms: 1 * S },
        { label: 'front', kind: 'front', app: 'iterm' },
        { kind: 'wait', ms: 2 * S },
      ],
      // The open's window runs on past the front step: nothing after the pick opens another row, and a window closed at
      // the front would be shorter than the open's half mark.
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'pick' },
        ringKeptOn('tmux', ['b'], { apart: ['a'], after: 'front' }),
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'pick' }],
    }),
    scenario({
      id: 'I23', app: 'iterm', title: 'herdr\'s page with another app in front, a rest on d: iTerm2 comes forward on d\'s tab and pane, the dial stays on herdr\'s page, and a rest on c shows c\'s pane',
      dims: ['D3', 'D7'], ...darwin, world: { front: 'other' }, sessions: [tab('a', 0), inHerdr('c', 2), inHerdr('d', 2, 1), itermGhost],
      steps: [
        ...started(['a', 'c', 'd']),
        // The Apps screen's counts first, as a pick of a page the devices have not counted yet is ignored.
        ...counted('iterm', { iterm: 3, herdr: 2 }),
        { kind: 'pick', page: 'herdr' },
        ...listed('herdr', ['c', 'd'], ['a']),
        { label: 'rest', kind: 'swipe', session: 'd' },
        { kind: 'wait', ms: 1 * S },
        { label: 'front', kind: 'front', app: 'iterm' },
        // Past the front's 1 s settle, and d's open window past the open's half mark.
        { kind: 'wait', ms: 3 * S },
        { label: 'restC', kind: 'swipe', session: 'c' },
        { kind: 'wait', ms: 2 * S },
      ],
      checks: [
        { id: 'open', kind: 'open', dim: 'D3', session: 'd', link: false, after: 'rest', at: 'restC' },
        ringKeptOn('herdr', ['c', 'd'], { apart: ['a'], after: 'front', at: 'restC' }),
        { id: 'openC', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'restC' },
      ],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'restC' }],
    }),
    scenario({
      id: 'I24', app: 'iterm', title: 'The same tmux attached from two tabs, the second used last: a pick of tmux\'s page brings the second tab',
      dims: ['D3'], ...darwin, world: { front: 'other' }, sessions: [tab('a', 0), inTmux('b', 1), itermGhost],
      steps: [
        ...started(['a', 'b']),
        { kind: 'iterm.tab', window: 'w1', tab: 2 },
        { kind: 'tmux.attach', session: 'b', window: 'w1', tab: 2 },
        ...counted('iterm', { iterm: 2, tmux: 1 }),
        { label: 'pick', kind: 'pick', page: 'tmux' },
        { kind: 'wait', ms: 2 * S },
      ],
      // The client used last is the one the pick reads (tmux.ts client_activity), so its select names the new tab, as I13's.
      checks: [{ id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, tab: 'w1.2.0', after: 'pick' }],
      probes: [{ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'pick' }],
    }),
  ]
}
