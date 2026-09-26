import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tmuxPaneInfo } from './tmux.js'

// A tmux server of its own, named outright on every call (-S) — the test's and the code's under
// test. Never `tmux` bare: inside a tmux pane (every harness runs in one) a bare call reaches the
// server in $TMUX, and on 2026-09-26 a kill-server here took down every harness on the real one.
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true } catch { return false } })()

describe.skipIf(!hasTmux)('tmuxPaneInfo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hn-paneinfo-'))
  const socket = join(dir, 'test.sock')
  // Even the environment points nowhere real while this runs.
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: dir }
  delete env.TMUX
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { env }).toString().trim()
  let pane = ''

  beforeAll(() => {
    // A command whose name is certain (on macOS `sh` is bash).
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'info', '-c', dir, 'sleep 600')
    pane = tmux('display-message', '-p', '-t', 'info', '#{pane_id}')
  })

  afterAll(() => {
    // This socket's server only.
    try { tmux('kill-server') } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads the pane's command, folder, pid and tty as tmux knows them", async () => {
    const info = await tmuxPaneInfo(pane, socket)
    expect(info?.command).toBe('sleep')
    expect(info?.path.endsWith(dir.split('/').pop()!)).toBe(true)
    expect(info?.pid).toBeGreaterThan(0)
    expect(info?.tty).toMatch(/^\/dev\//)
  })

  it('is null for a pane tmux does not know', async () => {
    expect(await tmuxPaneInfo('%99999', socket)).toBeNull()
  })
})
