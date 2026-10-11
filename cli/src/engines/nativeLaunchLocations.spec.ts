import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEngine } from './types.js'

let root = '', home = '', bin = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-launch-locations-'))
  home = join(root, 'shell-home'); bin = join(root, 'bin')
  mkdirSync(home); mkdirSync(bin)
  for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR']) {
    const value = key === 'HOME' ? home : join(root, key)
    mkdirSync(value, { recursive: true }); vi.stubEnv(key, value)
  }
  // Both the binaries and every selected hook destination belong to this case.
  vi.stubEnv('PATH', bin); vi.stubEnv('SHELL', '/bin/sh')
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME',
    'GROK_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR', 'COPILOT_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR',
    'OPENCODE_PLUGIN_DIR', 'OPENCODE_CONFIG_DIR', 'KILO_PLUGIN_DIR', 'PI_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'HERMES_HOME', 'COMMANDCODE_HOME', 'DEVIN_HOME', 'DEVIN_CONFIG_PATH', 'AMP_PLUGIN_DIR', 'ZDOTDIR']) vi.stubEnv(key, '')
  for (const engine of ['CLAUDE', 'CODEX', 'CURSOR', 'GROK', 'AGY', 'COPILOT', 'OPENCODE', 'KILO', 'PI', 'AMP', 'HERMES', 'COMMANDCODE', 'DEVIN']) vi.stubEnv(`${engine}_PATH`, '')
  for (const name of ['claude', 'codex', 'cursor-agent', 'grok', 'agy', 'copilot', 'opencode', 'kilo', 'pi', 'amp', 'hermes', 'cmd', 'devin']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nprintf "2.0.0\\n"\n', { mode: 0o700 })
  }
  vi.resetModules()
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it.each([
  ['claude', '.claude/settings.json'], ['codex', '.codex/hooks.json'], ['cursor', '.cursor/hooks.json'],
  ['grok', '.grok/hooks/harness.json'], ['agy', '.gemini/config/hooks.json'], ['copilot', '.copilot/hooks/harness.json'],
  ['opencode', '.config/opencode/plugins/launcher-register/tui.js'], ['kilo', '.config/kilo/plugin/launcher-register.js'],
  ['pi', '.pi/agent/extensions/launcher-register.ts'], ['amp', '.config/amp/plugins/launcher-register.ts'],
  ['hermes', '.hermes/config.yaml'], ['commandcode', '.commandcode/settings.json'], ['devin', '.config/devin/config.json'],
] as [AgentEngine, string][])('prepares %s at the captured home even after daemon environment drift', async (engine, relative) => {
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const result = await inspectNativeLaunch(engine)
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error(result.detail)
  const drift = join(root, 'changed-home'); mkdirSync(drift)
  vi.stubEnv('HOME', drift); vi.stubEnv('XDG_CONFIG_HOME', join(drift, 'config'))
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(existsSync(join(home, relative))).toBe(true)
  expect(existsSync(join(drift, relative))).toBe(false)
  expect(result.launch.environment.HOME).toBe(home)
  expect(result.launch.environment.PATH).toBe(bin)
  expect(result.launch.current()).toBe(true)
})

it('prepares redirected model homes and bakes that exact home into notifications', async () => {
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  for (const [engine, variable, relative] of [['grok', 'GROK_HOME', 'hooks/harness.json'], ['pi', 'PI_CODING_AGENT_DIR', 'extensions/launcher-register.ts']] as const) {
    const result = await inspectNativeLaunch(engine)
    if (!result.ok) throw Error(result.detail)
    const selected = join(root, `model-${engine}`)
    expect(await result.launch.prepareHooks(19473, () => true, { [variable]: selected })).toBe(true)
    expect(existsSync(join(selected, relative))).toBe(true)
    expect(result.launch.environment[variable]).toBe(selected)
    if (engine === 'grok') expect(readFileSync(join(selected, relative), 'utf8')).toContain(`--grok-home '${selected}'`)
  }
})

it('keeps overlapping OpenCode preparation isolated by selected config root', async () => {
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const a = await inspectNativeLaunch('opencode'), b = await inspectNativeLaunch('opencode')
  if (!a.ok || !b.ok) throw Error('Private executable was not prepared')
  const roots = [join(root, 'opencode-a'), join(root, 'opencode-b')]
  expect(await Promise.all([a.launch.prepareHooks(19473, () => true, { OPENCODE_CONFIG_DIR: roots[0] }),
    b.launch.prepareHooks(19473, () => true, { OPENCODE_CONFIG_DIR: roots[1] })])).toEqual([true, true])
  for (const dir of roots) expect(existsSync(join(dir, 'plugins/launcher-register/tui.js'))).toBe(true)
  expect(a.launch.current()).toBe(true); expect(b.launch.current()).toBe(true)
})

it('pins overridden locations even when the owner disabled hook installation', async () => {
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const result = await inspectNativeLaunch('grok')
  if (!result.ok) throw Error(result.detail)
  const selected = join(root, 'disabled-grok')
  expect(await result.launch.prepareHooks(0, () => true, { GROK_HOME: selected })).toBe(true)
  expect(result.launch.environment.GROK_HOME).toBe(selected)
  expect(existsSync(selected)).toBe(false)
})

it('keeps Claude settings separate from a daemon transcript-root override', async () => {
  const archive = join(root, 'archive', 'projects')
  vi.stubEnv('CLAUDE_PROJECTS_DIR', archive)
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const result = await inspectNativeLaunch('claude')
  if (!result.ok) throw Error(result.detail)
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(existsSync(join(home, '.claude/settings.json'))).toBe(true)
  expect(existsSync(join(root, 'archive/settings.json'))).toBe(false)
  expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toContain(`--claude-projects-dir '${archive}'`)
})
