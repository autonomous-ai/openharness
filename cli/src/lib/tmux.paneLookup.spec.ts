import { afterEach, describe, expect, it, vi } from 'vitest'

// `tmux display-message` as each version and failure answers it, for a pane that dropped out of
// `tmux list-panes` — the question the reconciler asks before it counts a pane as missing.
const answer = vi.hoisted(() => ({ err: null as (Error & { killed?: boolean }) | null, stdout: '', stderr: '' }))
vi.mock('child_process', async (real) => {
  const actual = await real<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, done: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (file === 'tmux' && args[0] === 'display-message') { queueMicrotask(() => done(answer.err, answer.stdout, answer.stderr)); return {} }
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, _options, done)
    },
  }
})

const { lookupPaneEngineProcess } = await import('./paneEngineProcess.js')
const { TmuxBackend } = await import('./tmuxBackend.js')
const lookup = (pane: string) => lookupPaneEngineProcess(new TmuxBackend(), { backend: 'tmux', paneId: pane }, 'claude')

describe('asking tmux for a pane that is not in its list', () => {
  afterEach(() => { answer.err = null; answer.stdout = ''; answer.stderr = '' })

  it('is gone when tmux answers with nothing, as tmux 3.7 does for an unknown pane', async () => {
    answer.stdout = '\n'
    expect(await lookup('%9')).toEqual({ ok: false, unknown: false, reason: 'tmux:%9 has no pane' })
  })

  it('is gone when tmux says it cannot find the pane, as older versions do', async () => {
    answer.err = Object.assign(new Error('Command failed'), {})
    answer.stderr = "can't find pane: %9\n"
    expect(await lookup('%9')).toEqual({ ok: false, unknown: false, reason: 'tmux:%9 has no pane' })
  })

  it('is gone when no tmux server is running, however tmux says it: with no server there is no pane', async () => {
    // The inventory already read this as no panes; this check reading it as "could not ask" kept every
    // agent active after the server died (e2e/machine.e2e.ts).
    answer.err = new Error('Command failed')
    answer.stderr = 'no server running on /tmp/tmux-501/default\n'
    expect(await lookup('%9')).toEqual({ ok: false, unknown: false, reason: 'tmux:%9 has no pane' })
    // What `kill-server`, a tmux crash and a reboot leave: the socket file itself gone.
    answer.stderr = 'error connecting to /tmp/tmux-501/default (No such file or directory)\n'
    expect(await lookup('%9')).toEqual({ ok: false, unknown: false, reason: 'tmux:%9 has no pane' })
  })

  it('is unknown when tmux could not be asked: a timeout, or a socket it may not use', async () => {
    answer.err = Object.assign(new Error('timed out'), { killed: true })
    answer.stderr = ''
    expect(await lookup('%9')).toEqual({ ok: false, unknown: true, reason: 'tmux:%9 could not be resolved' })
    answer.err = new Error('Command failed')
    answer.stderr = `error connecting to ${process.cwd()} (Permission denied)\n`
    expect(await lookup('%9')).toMatchObject({ unknown: true })
  })

  it('is unknown when tmux answers with something that is not a pid', async () => {
    answer.stdout = 'not-a-pid\n'
    expect(await lookup('%9')).toMatchObject({ ok: false, unknown: true })
  })
})
