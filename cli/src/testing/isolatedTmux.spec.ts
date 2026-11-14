import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // The managed grid's install makes its bin/ read-only (lib/runtimeInstall.ts `readOnly`), and a recursive removal cannot
  // unlink in it: ten roots on one Mac kept their runtime/grid-*/bin after their close (2026-11-14).
  it('removes a folder made read-only in the root, and changes nothing a link in it leads to', async () => {
    const tmux = await isolatedTmux()
    const bin = join(tmux.root, 'runtime', 'grid-0.3.63-darwin-arm64', 'bin')
    const outside = mkdtempSync(join(tmpdir(), 'isolated-tmux-outside-'))
    try {
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'grid'), '')
      chmodSync(bin, 0o555)
      writeFileSync(join(outside, 'kept'), '')
      chmodSync(outside, 0o555)
      symlinkSync(outside, join(tmux.root, 'link'))
      await tmux.close()
      expect(existsSync(tmux.root)).toBe(false)
      expect([statSync(outside).mode & 0o777, readdirSync(outside)]).toEqual([0o555, ['kept']])
    } finally {
      for (const folder of [bin, outside]) { try { chmodSync(folder, 0o755) } catch { /* gone */ } }
      rmSync(tmux.root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
