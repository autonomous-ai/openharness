/**
 * Whether the plugin is on, read from Claude Code's user settings in a throwaway folder, and where those settings are.
 * The real ~/.claude is never touched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudePluginOn, claudeSettingsPath } from './plugin.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const step of cleanup.splice(0).reverse()) step()
})

// What `claude plugin` leaves in Claude Code's user settings (tried with 2.1.325 in a throwaway CLAUDE_CONFIG_DIR): the
// entry true once installed or enabled, false once disabled, gone once uninstalled.
describe('claudePluginOn', () => {
  function settings(text: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'cs-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')
    if (text !== null) writeFileSync(path, text)
    return path
  }
  const entry = (on: boolean) => JSON.stringify({ enabledPlugins: { 'harness-device@openharness': on } })

  it('is on while the user settings enable the plugin', () => {
    expect(claudePluginOn(settings(entry(true)))).toBe(true)
  })

  it('is off once disabled or uninstalled', () => {
    expect(claudePluginOn(settings(entry(false)))).toBe(false)
    expect(claudePluginOn(settings(JSON.stringify({ enabledPlugins: {}, extraKnownMarketplaces: {} })))).toBe(false)
    expect(claudePluginOn(settings(JSON.stringify({ model: 'opus' })))).toBe(false)
  })

  it('is on, as before the check, when the settings cannot be read', () => {
    expect(claudePluginOn(settings(null))).toBe(true)
    expect(claudePluginOn(settings(entry(false).slice(0, -3)))).toBe(true)
    expect(claudePluginOn(settings('[]'))).toBe(true)
    const folder = settings(null)
    mkdirSync(folder)
    expect(claudePluginOn(folder)).toBe(true)
    // Past 1 MiB the file is not read whole: unread, it says nothing.
    const long = JSON.stringify({ enabledPlugins: { 'harness-device@openharness': false }, pad: 'x'.repeat(1024 * 1024) })
    expect(claudePluginOn(settings(long))).toBe(true)
  })
})

describe('claudeSettingsPath', () => {
  it('is settings.json in CLAUDE_CONFIG_DIR, else in ~/.claude', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/profile-a')
    expect(claudeSettingsPath()).toBe('/tmp/profile-a/settings.json')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    vi.stubEnv('HOME', '/tmp/home-b')
    expect(claudeSettingsPath()).toBe('/tmp/home-b/.claude/settings.json')
  })
})
