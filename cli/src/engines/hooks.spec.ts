import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { admitHook, engineHooks, hooksFor } from './hooks.js'
import { engineFor } from './registry.js'
import { liveFor } from './live.js'

afterEach(() => vi.restoreAllMocks())

it('exposes the same hooks through the full and hook-only engine interfaces', () => {
  for (const name of ['claude', 'codex']) expect(engineFor(name)!.hooks).toBe(hooksFor(name))
  for (const name of [null, undefined, '', 'future', 'constructor', '__proto__']) expect(hooksFor(name)).toBeUndefined()
  expect(admitHook('future', {})).toEqual({ accepted: true })
  expect(admitHook('claude', {})).toEqual({ accepted: true })
})

it('installs Claude hooks into the requested home through its facet', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-hook-facet-'))
  try {
    engineHooks.claude.installIn(19473, home)
    const file = join(home, 'settings.json')
    const first = readFileSync(file, 'utf8')
    const settings = JSON.parse(first)
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure'])
    const command = settings.hooks.Stop[0].hooks[0].command as string
    expect(command).toContain('--port 19473')
    expect(command).toContain(fileURLToPath(new URL('../../hook/notify.mjs', import.meta.url)))
    expect(command).not.toContain('--engine')
    engineHooks.claude.installIn(19473, home)
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
  }, { sessionId: 'session' })
  expect(closeTurn).toHaveBeenCalledWith('session', parser.snapshot().identity)
  expect(emit).not.toHaveBeenCalled()
  expect(parser.turnOpen).toBe(true)
})
