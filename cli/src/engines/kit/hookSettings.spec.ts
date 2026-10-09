import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { hooks as claude } from '../claude/hookContract.js'
import { hooks as codex } from '../codex/hookContract.js'
import { defaultHookHome, installHookSettings } from './hookSettings.js'
import { HOOK_SCRIPT } from './notifyHooks.js'

// What every case writes and logs is engines/hookInstallers.golden.spec.ts; these are the kit's own edges.
let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hook-settings-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('finds an engine\'s home in the person\'s home or in a daemon setting', () => {
  expect(defaultHookHome(claude.settings)).toBe(join(homedir(), '.claude'))
  expect(defaultHookHome(codex.settings)).toBe(env.CODEX_HOME)
})

it('names a home literally in its log lines, whatever characters the path holds', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  // `$&` and `$1` mean something to String.replace with a string replacement, and {port} to the templates.
  const home = join(root, 'a$&b$1{port}{file}')
  const file = join(home, 'settings.json')
  installHookSettings('claude', { ...claude.settings, messages: { ...claude.settings.messages, installed: '{file}|{script}|{port}' } }, 19473, home)
  expect(log.mock.calls[0]).toEqual([`${file}|${HOOK_SCRIPT}|19473`])
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0].command).toContain('--port 19473')
})

it('keeps a malformed file quietly for an engine that declares no lines for it', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const home = join(root, 'codex')
  mkdirSync(home)
  writeFileSync(join(home, 'hooks.json'), '{not-json')
  const { malformed: _, ...messages } = codex.settings.messages
  installHookSettings('codex', { ...codex.settings, messages }, 19473, home)
  expect(error).not.toHaveBeenCalled()
  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{not-json')
})
