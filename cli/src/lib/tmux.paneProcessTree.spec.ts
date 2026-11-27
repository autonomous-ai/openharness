import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'

// `tmux display-message` names the pane's root, pid 10; the process table is the test's own rows.
vi.mock('child_process', async (real) => {
  const actual = await real<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, done: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (file === 'tmux' && args[0] === 'display-message') { queueMicrotask(() => done(null, '10\n', '')); return {} }
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, _options, done)
    },
  }
})

const { setProcessTableSource } = await import('./processTable.js')
const { tmuxPaneProcessTree } = await import('./tmux.js')

const row = (pid: number, parentPid: number, executable: string): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: 'Fri Nov 13 10:00:00 2026', args: executable })
/** The pane's tree when the table says the root's parent is [rootParent]: the root, a launcher, the engine below. */
const tree = (rootParent: number) => {
  setProcessTableSource(async () => [row(10, rootParent, 'zsh'), row(11, 10, 'node'), row(12, 11, 'claude')])
  return tmuxPaneProcessTree('%1')
}

describe('the processes under a pane', () => {
  afterEach(() => setProcessTableSource(null))

  // The same walk as discovery's (#4268): the root was listed again, in place of a process below it.
  it.each([
    ['its child', 11],
    ['the engine below', 12],
  ])('are each listed once when the root\'s parent pid names %s', async (_name, rootParent) => {
    const cycle = await tree(rootParent)
    expect(cycle.map((process) => process.executable)).toEqual(['zsh', 'node', 'claude'])
    expect(cycle).toEqual(await tree(1))
  })
})
