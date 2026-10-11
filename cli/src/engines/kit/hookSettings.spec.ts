import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { hooks as claude } from '../claude/hookContract.js'
import { hooks as codex } from '../codex/hookContract.js'
import { defaultHookHome, installHookSettings } from './hookSettings.js'
import { HOOK_SCRIPT } from './notifyHooks.js'
import type { HookPreparationProof } from './nativeHookFiles.js'
import { messagesCommand } from './messagesHook.js'
import * as preparations from './nativeHookFiles.js'
import { reviewHash, reviewRecords } from './hookReview.js'

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

it.each(['claude', 'codex'] as const)('publishes one current %s proof after both native and Agent Messages blocks', async engine => {
  const settings = engine === 'claude' ? claude.settings : codex.settings
  const home = join(root, engine), proofs: HookPreparationProof[] = []
  expect(await installHookSettings(engine, settings, 19473, home, { confirmed: proof => { proofs.push(proof) } })).toBe(true)
  expect(proofs).toHaveLength(1)
  expect(proofs[0]!.current()).toBe(true)
  const content = JSON.parse(readFileSync(join(home, settings.file), 'utf8'))
  expect(content.hooks[settings.inbox!.event]?.some((block: { hooks: { command: string }[] }) => block.hooks.some(hook => hook.command === messagesCommand(env.HARNESS_AGENT_MESSAGES_DIR)))).toBe(true)
})

it.each(['both current', 'follower revoked', 'owner revoked'] as const)('joins the complete Messages stage with caller authority: %s', async state => {
  const home = join(root, 'claude'), file = join(home, claude.settings.file)
  const inspect = preparations.inspectHookFile
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(done => { enter = done })
  const gate = new Promise<void>(done => { release = done })
  let paused = false
  vi.spyOn(preparations, 'inspectHookFile').mockImplementation((path, mode) => {
    const observed = inspect(path, mode)
    return { ...observed, replace: async (next, attempt, exclusive) => {
      if (!paused && path === file && next.includes('harness-agent-messages')) {
        paused = true; enter(); await gate
      }
      return observed.replace(next, attempt, exclusive)
    } }
  })
  const proofs: HookPreparationProof[] = []
  const options = { confirmed: (proof: HookPreparationProof) => { proofs.push(proof) } }
  let owner = true, follower = true
  const startup = installHookSettings('claude', claude.settings, 19473, home, { ...options, current: () => owner })
  await entered
  const launch = installHookSettings('claude', claude.settings, 19473, home, { ...options, current: () => follower })
  if (state === 'follower revoked') follower = false
  if (state === 'owner revoked') owner = false
  release()
  expect(await Promise.all([startup, launch])).toEqual(state === 'owner revoked' ? [false, false] : [true, follower])
  expect(proofs).toHaveLength(state === 'owner revoked' ? 0 : follower ? 2 : 1)
  expect(proofs.every(proof => proof.current())).toBe(true)
  expect(readFileSync(file, 'utf8').includes('harness-agent-messages')).toBe(owner)
})

it.each(['peer edit', 'another port'] as const)('holds when %s changes required hook authority during publication', async change => {
  const home = join(root, 'claude'), file = join(home, claude.settings.file)
  const run = preparations.runHookPreparation
  let intercepted = false, peerBytes = ''
  vi.spyOn(preparations, 'runHookPreparation').mockImplementation((files, work, options) => run(files, attempt => work({
    ...attempt, async flush(fd) {
      await attempt.flush(fd)
      if (!intercepted && existsSync(file)) {
        intercepted = true
        if (change === 'another port') expect(await installHookSettings('claude', claude.settings, 19474, home)).toBe(false)
        else {
          const settings = JSON.parse(readFileSync(file, 'utf8')); delete settings.hooks.SessionStart
          writeFileSync(file, JSON.stringify(settings))
        }
        peerBytes = readFileSync(file, 'utf8')
      }
    },
  }), options))
  const confirmed = vi.fn()
  expect(await installHookSettings('claude', claude.settings, 19473, home, { confirmed })).toBe(false)
  expect(intercepted).toBe(true)
  expect(confirmed).not.toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe(peerBytes)
  if (change === 'another port') expect(await installHookSettings('claude', claude.settings, 19474, home)).toBe(true)
})

it('preserves marker-only commands and foreign siblings of the exact Messages hook without approving them', async () => {
  const home = join(root, 'codex'); mkdirSync(home)
  const foreign = { type: 'command', command: 'echo harness-agent-messages' }
  const sibling = { type: 'command', command: 'echo my own hook' }
  const owned = { type: 'command', command: messagesCommand('/fixture/old') }
  const blocks = [{ hooks: [foreign] }, { matcher: 'custom', annotation: 'retain this', hooks: [owned, sibling] },
    { hooks: [{ ...owned, command: owned.command + '; echo foreign' }] }]
  const file = join(home, codex.settings.file), event = codex.settings.inbox!.event
  writeFileSync(file, JSON.stringify({ hooks: { [event]: blocks } }))
  expect(await installHookSettings('codex', codex.settings, 19473, home)).toBe(true)
  const settings = JSON.parse(readFileSync(file, 'utf8'))
  expect(settings.hooks[event].slice(0, 3)).toEqual([blocks[0], { ...blocks[1], hooks: [sibling] }, blocks[2]])
  expect(settings.hooks[event][3].hooks[0].command).toBe(messagesCommand(env.HARNESS_AGENT_MESSAGES_DIR))
  const records = [...reviewRecords(codex.settings.reviewed!, file, settings).keys()]
  const label = codex.settings.reviewed!.events[event]
  expect(records.filter(key => key.includes(`:${label}:`))).toEqual([`${file}:${label}:3:0`])
})

it('approves the required Codex hook when an earlier optional hook uses the same event', async () => {
  const home = join(root, 'codex'); mkdirSync(home)
  const previous = { hooks: [{ type: 'command', command: messagesCommand('/fixture/previous') }] }
  const file = join(home, codex.settings.file)
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [previous] } }))
  const confirmed = vi.fn()
  expect(await installHookSettings('codex', codex.settings, 19473, home, { confirmed })).toBe(true)
  const settings = JSON.parse(readFileSync(file, 'utf8'))
  expect(settings.hooks.SessionStart[0]).toEqual(previous)
  const required = settings.hooks.SessionStart[1]
  expect(required.hooks[0].command).toContain('notify.mjs')
  const config = readFileSync(join(home, codex.settings.reviewed!.file), 'utf8')
  const key = `${realpathSync(file)}:session_start:1:0`
  const hash = reviewHash(codex.settings.reviewed!, 'SessionStart', required.matcher, required.hooks[0])
  expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}`)
  expect(confirmed).toHaveBeenCalledOnce()
  expect(confirmed.mock.calls[0]![0].current()).toBe(true)
})

it('names a home literally in its log lines, whatever characters the path holds', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  // `$&` and `$1` mean something to String.replace with a string replacement, and {port} to the templates.
  const home = join(root, 'a$&b$1{port}{file}')
  const file = join(home, 'settings.json')
  await installHookSettings('claude', { ...claude.settings, messages: { ...claude.settings.messages, installed: '{file}|{script}|{port}' } }, 19473, home)
  expect(log.mock.calls[0]).toEqual([`${file}|${HOOK_SCRIPT}|19473`])
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0].command).toContain('--port 19473')
})

it('reports a held malformed file even when an engine declares no malformed-file lines', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const home = join(root, 'codex')
  mkdirSync(home)
  writeFileSync(join(home, 'hooks.json'), '{not-json')
  const { malformed: _, ...messages } = codex.settings.messages
  expect(await installHookSettings('codex', { ...codex.settings, messages }, 19473, home)).toBe(false)
  expect(error).toHaveBeenCalledWith(codex.settings.messages.failed, expect.any(SyntaxError))
  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{not-json')
})
