import { expect, it } from 'vitest'
import { runningPane } from './callerPane.js'

// This process is 900; its shell 800 runs in pane %42, whose process is 700. Pane %7, another harness's, is 500.
const panes = [{ pane: '%7', pid: 500 }, { pane: '%42', pid: 700 }]
const probe = (over: { panes?: typeof panes | null; ancestors?: number[] | null } = {}) => ({
  panes: () => over.panes === undefined ? panes : over.panes,
  ancestors: () => over.ancestors === undefined ? [900, 800, 700, 1] : over.ancestors,
})

it('finds the pane this command runs in from its parent processes, whatever TMUX_PANE says', () => {
  expect(runningPane({ TMUX_PANE: '%42' }, probe(), 'darwin')).toEqual({ pane: '%42' })
  // Unsetting TMUX_PANE does not hide the pane.
  expect(runningPane({}, probe(), 'darwin')).toEqual({ pane: '%42' })
  // tmux inside a harness's pane: the nearest pane is the one asking.
  expect(runningPane({ TMUX_PANE: '%7' }, probe({ ancestors: [900, 500, 800, 700, 1] }), 'darwin')).toEqual({ pane: '%7' })
})

// The Lead's must on #904's plan: an allowed command can't claim another harness by typing its pane.
it('refuses a TMUX_PANE that names another pane than the one the command runs in', () => {
  const refused = { refused: 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.' }
  expect(runningPane({ TMUX_PANE: '%7' }, probe(), 'darwin')).toEqual(refused)
  // Nothing to check it against (tmux or ps cannot be read): a named pane is not taken on its word.
  expect(runningPane({ TMUX_PANE: '%42' }, probe({ panes: null }), 'darwin')).toEqual(refused)
  expect(runningPane({ TMUX_PANE: '%42' }, probe({ ancestors: null }), 'darwin')).toEqual(refused)
})

it('is no pane for a person\'s terminal outside tmux', () => {
  expect(runningPane({}, probe({ ancestors: [900, 300, 1] }), 'darwin')).toEqual({})
  expect(runningPane({}, probe({ panes: null }), 'darwin')).toEqual({})
})

it('keeps TMUX_PANE as it is on Windows, which has no tmux to check it against', () => {
  expect(runningPane({ TMUX_PANE: '%7' }, probe({ panes: null, ancestors: null }), 'win32')).toEqual({ pane: '%7' })
  expect(runningPane({}, probe(), 'win32')).toEqual({})
})
