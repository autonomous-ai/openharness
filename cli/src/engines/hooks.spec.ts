import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { admitHook, engineHooks, hookContracts, hooksFor } from './hooks.js'
import { engineFor } from './registry.js'
import { liveFor } from './live.js'

afterEach(() => vi.restoreAllMocks())

it('declares each engine\'s hooks once, for the full engine interface and the hook-only lookup', () => {
  for (const name of ['claude', 'codex'] as const) {
    expect(engineFor(name)!.hooks).toBe(hookContracts[name])
    expect(hooksFor(name)).toBe(engineHooks[name])
  }
  for (const name of [null, undefined, '', 'future', 'constructor', '__proto__']) expect(hooksFor(name)).toBeUndefined()
  expect(admitHook('future', {})).toEqual({ accepted: true })
  expect(admitHook('claude', {})).toEqual({ accepted: true })
})

it('composes only what a contract declares: Claude Code corrects transcripts, Codex admits, and both Stops close turns', () => {
  expect(Object.keys(engineHooks.claude).sort()).toEqual(['install', 'installIn', 'onStop', 'transcriptFor'])
  expect(Object.keys(engineHooks.codex).sort()).toEqual(['admit', 'install', 'installIn', 'onStop'])
})

// The turn's end, its interrupt and its waits on the person (facts-codex §2). No SubagentStart or SubagentStop: Codex's
// SubagentStop fires per child turn and never for an interrupted or failed one, so a count of them is not exact.
it('declares Codex\'s events, and no subagent event', () => {
  expect(hookContracts.codex.settings.events).toEqual([
    { event: 'SessionStart', matcher: 'startup|resume|clear|compact' }, { event: 'UserPromptSubmit' }, { event: 'Stop' },
    { event: 'PermissionRequest' }, { event: 'PreToolUse', matcher: 'request_user_input' }, { event: 'Interrupt', timeout: 3 }])
})

it('keeps every contract plain data: nothing in it runs', () => {
  const functions = (value: unknown): number => typeof value === 'function' ? 1
    : value && typeof value === 'object' ? Object.values(value).reduce<number>((sum, inner) => sum + functions(inner), 0) : 0
  expect(functions(hookContracts)).toBe(0)
  expect(JSON.parse(JSON.stringify(hookContracts))).toEqual(hookContracts)
})

it('installs Claude hooks into the requested home through its facet', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-hook-facet-'))
  try {
    await engineHooks.claude.installIn(19473, home)
    const file = join(home, 'settings.json')
    const first = readFileSync(file, 'utf8')
    const settings = JSON.parse(first)
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PostToolUse'])
    // Only the notices that wait for the person run the hook (hook/notify.mjs NEEDS_INPUT), not the idle one after each turn.
    expect(settings.hooks.Notification[0].matcher).toBe('permission_prompt|elicitation_dialog|elicitation_url_dialog|quota_auto_resume_stale')
    const command = settings.hooks.Stop[0].hooks[0].command as string
    expect(command).toContain('--port 19473')
    expect(command).toContain(fileURLToPath(new URL('../../hook/notify.mjs', import.meta.url)))
    expect(command).not.toContain('--engine')
    await engineHooks.claude.installIn(19473, home)
    expect(readFileSync(file, 'utf8')).toBe(first)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('rejects Codex delegated rollouts without rejecting a main session or an unwritten transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-hook-admission-'))
  const transcriptPath = join(root, 'rollout.jsonl')
  try {
    expect(admitHook('codex', {})).toEqual({ accepted: true })
    expect(admitHook('codex', { transcriptPath })).toEqual({ accepted: true })
    writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } }) + '\n')
    expect(admitHook('codex', { transcriptPath })).toEqual({ accepted: false, reason: 'codex_subagent' })
    writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: 'parent', source: 'cli' } }) + '\n')
    expect(admitHook('codex', { transcriptPath })).toEqual({ accepted: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('rejects a hook when its engine admission check throws, and leaves other engines available', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(engineHooks.codex, 'admit')
    .mockImplementationOnce(() => { throw new Error('reader failed') })
    .mockImplementationOnce(() => { throw 'reader failed again' })
  expect(admitHook('codex', {})).toEqual({ accepted: false, reason: 'engine_hook_failed' })
  expect(admitHook('codex', {})).toEqual({ accepted: false, reason: 'engine_hook_failed' })
  expect(admitHook('claude', {})).toEqual({ accepted: true })
  expect(console.warn).toHaveBeenCalledWith('[hooks] codex admission failed:', 'reader failed')
})

it('does not emit an end when core rejects a stale closure proposal', async () => {
  const parser = liveFor('claude')!.create({ engine: 'claude' })
  parser.ingest(JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }))
  const emit = vi.fn()
  const closeTurn = vi.fn(() => false)
  await engineHooks.claude.onStop!({
    turnState: () => parser.snapshot(), closeTurn, latestPromptAt: () => undefined,
    drain: async () => {}, noteEngineStopped: () => {}, emit, graceMs: 0,
    heldEnd: () => undefined, heldEndWithin: async () => false, deliverHeldEnd: () => false,
  }, { sessionId: 'session' })
  expect(closeTurn).toHaveBeenCalledWith('session', parser.snapshot().identity)
  expect(emit).not.toHaveBeenCalled()
  expect(parser.turnOpen).toBe(true)
})
