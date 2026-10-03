import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_STARTUP_RETRY_PROBE } from './codexStartupRetry.js'

const timeout = 'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-startup-probe-'))
  dirs.push(dir)
  const screen = join(dir, 'screen')
  const tmux = join(dir, 'tmux')
  writeFileSync(screen, 'existing terminal output\n')
  writeFileSync(tmux, '#!/bin/sh\ncat "$HARNESS_TEST_SCREEN"\n', { mode: 0o755 })
  const probe = (mode: string, baseline = '', pane = '%7') => {
    try {
      return { status: 0, out: execFileSync(process.execPath, ['-e', CODEX_STARTUP_RETRY_PROBE, mode, tmux, pane, baseline], {
        env: { ...process.env, HARNESS_TEST_SCREEN: screen }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }) }
    } catch (error) { return { status: (error as { status: number }).status, out: '' } }
  }
  return { screen, tmux, probe }
}

describe('Codex startup timeout evidence', () => {
  it('accepts only a newly printed, final bootstrap timeout', () => {
    const f = fixture()
    const before = f.probe('before').out
    expect(before).not.toContain('existing terminal output')
    writeFileSync(f.screen, `${timeout}\n\n\n`)
    expect(f.probe('after', before).status).toBe(0)
    // The same text already on screen before a later launch is not new evidence.
    expect(f.probe('after', f.probe('before').out).status).toBe(1)
  })

  it.each([
    'Error: account/read failed during TUI bootstrap: workspace routing discovery unauthorized (401)',
    'Error: invalid config.toml',
    'Error: stream disconnected before completion: request timed out',
    `${timeout}\n› Ask Codex to do anything`,
    `quoted output: ${timeout}`,
    '',
  ])('does not replay a launch after unrelated output: %s', (screen) => {
    const f = fixture()
    const before = f.probe('before').out
    writeFileSync(f.screen, screen)
    expect(f.probe('after', before).status).toBe(1)
  })

  it('rejects old, invalid or unavailable evidence', () => {
    const f = fixture()
    const before = JSON.parse(f.probe('before').out)
    writeFileSync(f.screen, timeout)
    expect(f.probe('after', JSON.stringify({ ...before, at: Date.now() - 31_000 })).status).toBe(1)
    expect(f.probe('after', JSON.stringify({ ...before, at: Date.now() + 10_000 })).status).toBe(1)
    expect(f.probe('after', 'broken baseline').status).toBe(1)
    expect(f.probe('before', '', 'some-session').status).toBe(1)
    rmSync(f.tmux)
    expect(f.probe('after', JSON.stringify(before)).status).toBe(1)
  })
})
