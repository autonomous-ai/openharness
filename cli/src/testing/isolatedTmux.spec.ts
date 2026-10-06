import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isolatedTmux } from './isolatedTmux.js'

const exec = promisify(execFile)
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true } catch { return false } })()

describe.skipIf(!hasTmux)('real tmux test isolation', () => {
  it('isolates backend calls and cleanup from an inherited parent server', async () => {
    const parent = await isolatedTmux()
    let child: Awaited<ReturnType<typeof isolatedTmux>> | undefined
    try {
      const pane = await parent.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'sentinel', 'sleep 600')
      const pid = await parent.run('display-message', '-p', '-t', pane, '#{pid}')
      const inherited = { ...process.env, TMUX: `${parent.socket},${pid},0`, TMUX_PANE: pane }
      child = await isolatedTmux(inherited)
      // Reproduce the incident safely: TMPDIR alone still selects this disposable parent.
      const wrong = await exec('tmux', ['display-message', '-p', '-t', pane, '#{socket_path}'], {
        env: { ...inherited, TMUX_TMPDIR: child.root }, timeout: 5_000,
      })
      expect(wrong.stdout.trim()).toBe(parent.socket)

      await child.run('new-session', '-d', '-s', 'fixture', 'sleep 600')
      // TmuxBackend uses bare commands; prove its environment selects the child.
      const actual = await exec('tmux', ['display-message', '-p', '-t', 'fixture', '#{socket_path}'], {
        env: child.env, timeout: 5_000,
      })
      expect(actual.stdout.trim()).toBe(child.socket)
      expect(await parent.run('list-sessions', '-F', '#{session_name}')).toBe('sentinel')

      await child.close()
      child = undefined
      expect(await parent.run('display-message', '-p', '-t', pane, '#{pid}')).toBe(pid)
      expect(await parent.run('list-sessions', '-F', '#{session_name}')).toBe('sentinel')
    } finally {
      await child?.close()
      await parent.close()
    }
  }, 15_000)
})
