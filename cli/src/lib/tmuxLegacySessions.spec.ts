import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLegacyHarnessSession } from './harnessSessionLabel.js'
import { adoptLegacyHarnessSessions } from './tmuxAgentDiscovery.js'

const originalPath = process.env.PATH
const dirs: string[] = []

afterEach(() => {
  process.env.PATH = originalPath
  delete process.env.TMUX_LEGACY_CALLS
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake tmux: answers `list-panes` with the given inventory and records every call. */
function fakeTmux(panes: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-legacy-'))
  dirs.push(dir)
  const calls = join(dir, 'calls')
  const tmux = join(dir, 'tmux')
  writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LEGACY_CALLS"
case "$1" in
  list-panes) printf '${panes}' ;;
esac
`)
  chmodSync(tmux, 0o700)
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
  process.env.TMUX_LEGACY_CALLS = calls
  return calls
}

describe('isLegacyHarnessSession', () => {
  it('recognises only the pre-prefix `<engine>-<ms>` label', () => {
    expect(isLegacyHarnessSession('claude-1787912296587')).toBe(true)
    expect(isLegacyHarnessSession('codex-1787549944131')).toBe(true)
    expect(isLegacyHarnessSession('harness-claude-1787912296587')).toBe(false)
    expect(isLegacyHarnessSession('work')).toBe(false)
    expect(isLegacyHarnessSession('claude-notes')).toBe(false)
    expect(isLegacyHarnessSession('claude-42')).toBe(false)
  })
})

describe('adoptLegacyHarnessSessions', () => {
  it('renames the registry\'s own pre-prefix sessions and nothing else', async () => {
    // The inventory seen on machine-remote-1: two sessions from before the prefix that the registry
    // owns, one already named right, one user session (`work`) that ALSO holds a registered pane, and
    // one legacy-looking session nobody registered.
    const calls = fakeTmux([
      '%%13|40496|claude-1787912296587|/home/agent/abc',
      '%%1|368|codex-1787549944131|/home/agent/proj',
      '%%18|32943|harness-codex-1789028699411|/home/agent/abc',
      '%%0|40087|work|/home/agent/proj',
      '%%7|700|claude-1787000000000|/tmp',
    ].join('\\n') + '\\n')
    const owned = new Map([['%13', 'claude'], ['%1', 'codex'], ['%18', 'codex'], ['%0', 'codex']])

    const adopted = await adoptLegacyHarnessSessions(owned, 1_800_000_000_000)

    expect(adopted).toEqual([
      { from: 'claude-1787912296587', to: 'harness-claude-1800000000000', paneId: '%13' },
      { from: 'codex-1787549944131', to: 'harness-codex-1800000000001', paneId: '%1' },
    ])
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'list-panes -a -F #{pane_id}|#{pane_pid}|#{session_name}|#{pane_current_path}',
      'rename-session -t =claude-1787912296587 harness-claude-1800000000000',
      'rename-session -t =codex-1787549944131 harness-codex-1800000000001',
    ])
  })

  it('renames a session once even when several of its panes are registered', async () => {
    const calls = fakeTmux('%%2|20|claude-1787912296587|/a\\n%%3|30|claude-1787912296587|/b\\n')
    const adopted = await adoptLegacyHarnessSessions(new Map([['%2', 'claude'], ['%3', 'claude']]), 5)
    expect(adopted).toHaveLength(1)
    expect(readFileSync(calls, 'utf8').trim().split('\n').filter((call) => call.startsWith('rename-session'))).toHaveLength(1)
  })

  it('does not touch tmux at all when the registry owns no panes', async () => {
    const calls = fakeTmux('%%2|20|claude-1787912296587|/a\\n')
    await expect(adoptLegacyHarnessSessions(new Map())).resolves.toEqual([])
    expect(() => readFileSync(calls, 'utf8')).toThrow()
  })
})
