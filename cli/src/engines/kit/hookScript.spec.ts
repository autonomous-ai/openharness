import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hooks as claude } from '../claude/hookContract.js'
import { hooks as codex } from '../codex/hookContract.js'
import { AGY_HOOK_SETTINGS } from '../agy/contract.js'
import { GROK_HOOK_SETTINGS } from '../grok/contract.js'
import { HookScriptMissing } from './hookHeld.js'
import { installHookSettings } from './hookSettings.js'
import { installNativeHookSettings } from './nativeHookSettings.js'
import { installHermesHooks } from '../nativeHooks.js'
import * as notifyHooks from './notifyHooks.js'
import { HOOK_SCRIPT, missingHookScript, requireHookScript } from './notifyHooks.js'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})
// The installers' own check, as it is, unless a test says it threw something else.
vi.mock('./notifyHooks.js', async original => {
  const actual = await original<typeof import('./notifyHooks.js')>()
  return { ...actual, requireHookScript: vi.fn(actual.requireHookScript) }
})

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hook-script-'))
  // A build whose notify.mjs is not beside cli.js: E2E2's lean build, where Codex's SessionStart failed at every start.
  const exists = vi.mocked(fs.existsSync).getMockImplementation()!
  vi.mocked(fs.existsSync).mockImplementation(path => path !== HOOK_SCRIPT && exists(path))
})
afterEach(() => {
  vi.mocked(fs.existsSync).mockRestore()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('refuses to name a notify.mjs that is not there', () => {
  expect(() => requireHookScript('codex')).toThrow(HookScriptMissing)
  expect(() => requireHookScript('codex')).toThrow(`notify.mjs is missing (${HOOK_SCRIPT})`)
})

// Review of #3954: a held create blamed notify.mjs for an engine whose plugin never runs it, or whose hooks are off.
it('names a missing notify.mjs only for an engine whose install it stopped', () => {
  expect(missingHookScript()).toBe(HOOK_SCRIPT)
  expect(missingHookScript('devin')).toBeNull()
  expect(() => requireHookScript('devin')).toThrow(HookScriptMissing)
  expect(missingHookScript('devin')).toBe(HOOK_SCRIPT)
  expect(missingHookScript('opencode')).toBeNull()
})

it.each(['linux', 'darwin', 'win32'] as const)('installs no Codex hook naming a missing notify.mjs, and says why in one line (%s)', async platform => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  const home = join(root, 'codex')
  expect(await installHookSettings('codex', codex.settings, 19473, home, {}, platform)).toBe(false)
  expect(fs.existsSync(join(home, codex.settings.file))).toBe(false)
  expect(said.mock.calls).toEqual([[`[hooks] Codex hooks are not installed: notify.mjs is missing (${HOOK_SCRIPT}), so no hook of Harness's could run`]])
})

it('installs no native hook naming a missing notify.mjs, and says why in one line', async () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  const file = join(root, 'grok', 'hooks', 'harness.json')
  expect(await installNativeHookSettings({ ...GROK_HOOK_SETTINGS, file }, 19473, {}, 'linux')).toBe(false)
  expect(fs.existsSync(file)).toBe(false)
  expect(said.mock.calls).toEqual([[expect.stringMatching(/^\[hooks\] .+ hooks are not installed: notify\.mjs is missing/)]])
})

it('installs no Hermes hook naming a missing notify.mjs: one line, and false rather than a rejection', async () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await installHermesHooks(19473, join(root, 'hermes'), {}, 'linux')).toBe(false)
  expect(fs.existsSync(join(root, 'hermes', 'config.yaml'))).toBe(false)
  expect(said.mock.calls).toEqual([[`[hooks] Hermes hooks are not installed: notify.mjs is missing (${HOOK_SCRIPT}), so no hook of Harness's could run`]])
})

// Review of #3954: installHookSettings asked for notify.mjs before the Windows runner, installNativeHookSettings after. An
// engine with no Windows runner skips its hooks there, as before, whether or not the file is there; one order for both.
it('skips, rather than fails, the hooks of an engine with no Windows runner while notify.mjs is missing', async () => {
  const said = vi.spyOn(console, 'log').mockImplementation(() => {})
  const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
  const home = join(root, 'claude')
  expect(await installHookSettings('claude', { ...claude.settings, win32Runner: undefined }, 19473, home, {}, 'win32')).toBe(true)
  expect(await installNativeHookSettings({ ...AGY_HOOK_SETTINGS, file: join(root, 'agy.json') }, 19473, {}, 'win32')).toBe(true)
  expect(said.mock.calls).toEqual([['[hooks] claude hooks are not installed on Windows yet'], ['[hooks] agy hooks are not installed on Windows yet']])
  expect(failed).not.toHaveBeenCalled()
  expect(fs.existsSync(join(home, claude.settings.file))).toBe(false)
  // So a held launch of theirs is not told to reinstall Harness for a file their hooks do not run here.
  expect(missingHookScript('claude')).toBeNull()
  expect(missingHookScript('agy')).toBeNull()
})

// Review of #3954: Hermes logged hooksNotInstalled's answer without asking whether it had one.
it('says why a Hermes install stopped on any error of the notify.mjs check, not "null"', async () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = new Error('fixture')
  vi.mocked(notifyHooks.requireHookScript).mockImplementationOnce(() => { throw error })
  expect(await installHermesHooks(19473, join(root, 'hermes'), {}, 'linux')).toBe(false)
  expect(said.mock.calls).toEqual([['[hooks] failed to write Hermes config.yaml:', error]])
})
