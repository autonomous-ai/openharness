import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isolatedTmux } from '../testing/isolatedTmux.js'
import { processProbe, runningPane } from './callerPane.js'

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

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

// The second review of #2087: the real tmux and ps outputs, parsed as they come.
describe('reading the real processes and panes', () => {
  it('reads this process\'s own parents from ps, nearest first', () => {
    const chain = processProbe().ancestors()!
    expect(chain.slice(0, 2)).toEqual([process.pid, process.ppid])
    expect(new Set(chain).size).toBe(chain.length)
  })

  it('finds the pane a command runs in on a private tmux server, from tmux\'s pane process and ps', async () => {
    const tmux = await isolatedTmux()
    try {
      const out = join(tmux.root, 'pane.json')
      const script = join(tmux.root, 'probe.mts')
      writeFileSync(script, `import { writeFileSync } from 'node:fs'\nimport { runningPane } from ${JSON.stringify(join(CLI_ROOT, 'src/superTabs/callerPane.ts'))}\n`
        + `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ named: runningPane(process.env), unset: runningPane({ ...process.env, TMUX_PANE: '' }), other: runningPane({ ...process.env, TMUX_PANE: '%999' }) }))\n`)
      await tmux.run('new-session', '-d', '-s', 'probe', '-x', '80', '-y', '20', `${shellQuote(process.execPath)} ${shellQuote(TSX)} ${shellQuote(script)}; sleep 30`)
      const pane = await tmux.run('display-message', '-p', '-t', 'probe', '#{pane_id}')
      expect(processProbe(tmux.env).panes()).toContainEqual({ pane, pid: Number(await tmux.run('display-message', '-p', '-t', 'probe', '#{pane_pid}')) })
      await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 20_000, interval: 100 })
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ named: { pane }, unset: { pane },
        other: { refused: 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.' } })
    } finally { await tmux.close() }
  }, 30_000)
})
