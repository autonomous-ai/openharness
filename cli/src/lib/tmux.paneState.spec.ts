import { afterEach, describe, expect, it, vi } from 'vitest'

// `tmux display-message` and `ps` as each version and failure answers them. An empty success is what
// Node hands back when its own timeout fires on an answer a held event loop had not read yet, and each
// reader must take it for no answer, never for "no such pane" or "no processes" (e2e/stall.e2e.ts).
const answer = vi.hoisted(() => ({ err: null as (Error & { killed?: boolean }) | null, stdout: '', stderr: '' }))
vi.mock('child_process', async (real) => {
  const actual = await real<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, done: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (file === 'tmux' || file === 'ps') { queueMicrotask(() => done(answer.err, answer.stdout, answer.stderr)); return {} }
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, _options, done)
    },
  }
})

const { tmuxPaneState, lookupPaneEngineProcess, processRows } = await import('./tmux.js')

describe('what tmux says about a pane', () => {
  afterEach(() => { answer.err = null; answer.stdout = ''; answer.stderr = '' })

  it('reads a live pane, a dead one and one whose engine left it to a shell', async () => {
    answer.stdout = '0|||claude\n'
    expect(await tmuxPaneState('%1')).toEqual({ dead: false, exitStatus: null, engineExit: null, command: 'claude' })
    answer.stdout = '1|2||zsh\n'
    expect(await tmuxPaneState('%1')).toEqual({ dead: true, exitStatus: 2, engineExit: null, command: 'zsh' })
    answer.stdout = '0||1|zsh\n'
    expect(await tmuxPaneState('%1')).toMatchObject({ dead: false, engineExit: 1 })
  })

  it('is gone when tmux says it has no such pane, as every version says it, or has no server', async () => {
    answer.stdout = '|||\n'
    expect(await tmuxPaneState('%9')).toBe('gone')
    answer.err = new Error('Command failed')
    answer.stdout = ''
    answer.stderr = "can't find pane: %9\n"
    expect(await tmuxPaneState('%9')).toBe('gone')
    // No server this process ever read from, so there is no socket to ask back: no pane either.
    answer.stderr = 'no server running on /tmp/tmux-501/default\n'
    expect(await tmuxPaneState('%9')).toBe('gone')
  })

  it('is unknown when tmux could not be asked, or its answer was lost', async () => {
    answer.err = Object.assign(new Error('timed out'), { killed: true })
    expect(await tmuxPaneState('%9')).toBe('unknown')
    answer.err = null
    answer.stdout = ''
    expect(await tmuxPaneState('%9')).toBe('unknown')
  })

  it('takes a lost answer to the pane-pid question for unknown, not for a pane that is gone', async () => {
    answer.stdout = ''
    expect(await lookupPaneEngineProcess('%9', 'claude')).toMatchObject({ ok: false, unknown: true })
  })

  it('takes a process table with nobody in it for a read that failed', async () => {
    // `ps` lists itself at the least. An empty table read as an answer says every engine has exited.
    answer.stdout = ''
    expect(await processRows()).toBeNull()
  })
})
