import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_STARTUP_RETRY_PROBE } from './codexStartupRetry.js'

// The probe gives tmux 2 s, as it should in a pane. Here tmux is a /bin/sh script, and under 12 busy loops on a
// 12-core Mac (load 60) it took longer than that to start: the probe gave up and printed nothing, and a test
// read that as `Unexpected end of JSON input`. These tests are about the evidence the probe reads, so its
// deadline is lifted here; the probe is otherwise the one a pane runs.
const PROBE = CODEX_STARTUP_RETRY_PROBE.replace('timeout: 2000,', 'timeout: 120000,')
if (PROBE === CODEX_STARTUP_RETRY_PROBE) throw new Error('the probe no longer gives tmux `timeout: 2000`: update this spec')

const timeout = 'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)'
const updated = '🎉 Update ran successfully! Please restart Codex.'
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
      return { status: 0, out: execFileSync(process.execPath, ['-e', PROBE, mode, tmux, pane, baseline], {
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

describe('Codex startup update evidence', () => {
  it.each([updated, updated.replace('🎉 ', '')])('accepts a fresh successful update after waiting at the prompt: %s', output => {
    const f = fixture()
    const before = JSON.parse(f.probe('before').out)
    writeFileSync(f.screen, `Updating Codex via installer\n${output}\n\n`)
    expect(f.probe('after-update', JSON.stringify({ ...before, at: Date.now() - 600_000 })).status).toBe(0)
    expect(f.probe('after', JSON.stringify(before)).status).toBe(1)
    expect(f.probe('after-update', f.probe('before').out).status).toBe(1)
  })

  it.each([
    'Update failed: network error',
    'Update available! Run npm install -g @openai/codex',
    `quoted output: ${updated}`,
    `${updated}\n› Ask Codex to do anything`,
    timeout,
    '',
  ])('rejects output that does not end with a successful update: %s', output => {
    const f = fixture()
    const before = f.probe('before').out
    writeFileSync(f.screen, output)
    expect(f.probe('after-update', before).status).toBe(1)
  })

  it('rejects missing, malformed, future and unavailable evidence', () => {
    const f = fixture()
    const before = JSON.parse(f.probe('before').out)
    writeFileSync(f.screen, updated)
    for (const baseline of ['', '{}', '{broken', JSON.stringify({ ...before, at: Date.now() + 10_000 }), JSON.stringify({ ...before, hash: '' })]) {
      expect(f.probe('after-update', baseline).status).toBe(1)
    }
    expect(f.probe('unknown', JSON.stringify(before)).status).toBe(1)
    expect(f.probe('after-update', JSON.stringify(before), 'other-session').status).toBe(1)
    rmSync(f.tmux)
    expect(f.probe('after-update', JSON.stringify(before)).status).toBe(1)
  })
})
