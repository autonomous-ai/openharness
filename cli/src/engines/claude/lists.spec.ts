import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnTied } from '../../lib/tied.js'
import { listClaudeCommands, listClaudeModels, parseClaudeCommandList, parseClaudeModelList, resetClaudeListCache } from './lists.js'

/** The models Claude Code 2.1.283 answered `initialize` with, trimmed to three rows. */
const ANSWER = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
]

/** A stand-in Claude Code: prints its argv, a hook line, then answers `initialize` with [answer]. */
function fakeClaude(answer: Record<string, unknown>, { silent = false } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-models-'))
  const script = join(dir, 'claude.mjs')
  writeFileSync(script, `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log(JSON.stringify({ type: 'system', subtype: 'init' }))
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (${silent} || request.request.subtype !== 'initialize') return
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: ${JSON.stringify(answer)} } }))
})
`)
  return script
}

const spawnNode: typeof spawnTied = (command, args, options) => spawnTied(process.execPath, [command, ...args], options)

afterEach(() => resetClaudeListCache())

describe('the models Claude Code offers', () => {
  it('keeps what a picker shows of each row: its id, name, line and efforts', () => {
    expect(parseClaudeModelList(ANSWER)).toEqual([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable for your hardest and longest-running tasks', efforts: ['low', 'medium', 'high'] },
      { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', efforts: [] },
    ])
  })

  it('drops a disabled row, one with no id or name, and an id a /model line could not carry', () => {
    expect(parseClaudeModelList([
      { value: 'opus', displayName: 'Opus 5.5', disabled: true },
      { value: '', displayName: 'Nameless' },
      { value: 'sonnet' },
      { value: 'opus; rm -rf /', displayName: 'Bad' },
      { value: 'sonnet', displayName: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['high', 7, 'NOT-AN-EFFORT'] },
      'not a row',
    ])).toEqual([{ value: 'sonnet', displayName: 'Sonnet 5', description: '', efforts: ['high'] }])
    expect(parseClaudeModelList([])).toBeNull()
    expect(parseClaudeModelList({ models: [] })).toBeNull()
  })

  it('asks Claude Code with no hook, MCP server or saved session, and asks once while the answer is fresh', async () => {
    const script = fakeClaude({ models: ANSWER })
    let now = 1_000
    const options = { claudePath: script, spawn: spawnNode, now: () => now }
    const session = { transcriptPath: null, cwd: tmpdir(), cliVersion: '2.1.283' }
    const [first, second] = await Promise.all([listClaudeModels(session, options), listClaudeModels(session, options)])
    expect(first?.map((m) => m.value)).toEqual(['default', 'claude-fable-5-1', 'haiku'])
    expect(second).toBe(first)
    expect(await listClaudeModels(session, options)).toBe(first)

    const { readFileSync } = await import('node:fs')
    const calls = readFileSync(join(script, '..', 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['-p', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])

    // Half an hour on, Claude Code is asked again: a model released today shows the same day.
    now += 31 * 60_000
    await listClaudeModels(session, options)
    expect(readFileSync(join(script, '..', 'calls'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('is null when Claude Code is missing, says nothing in time, or answers no model', async () => {
    const session = { cwd: tmpdir(), cliVersion: 'x' }
    expect(await listClaudeModels(session, { claudePath: '/nonexistent/claude' })).toBeNull()
    resetClaudeListCache()
    expect(await listClaudeModels(session, { claudePath: fakeClaude({ models: ANSWER }, { silent: true }), spawn: spawnNode, timeoutMs: 300 })).toBeNull()
    resetClaudeListCache()
    expect(await listClaudeModels(session, { claudePath: fakeClaude({ models: [] }), spawn: spawnNode })).toBeNull()
  })

  it('lists the `/` commands from the same answer: one Claude Code for both lists', async () => {
    const script = fakeClaude({
      models: ANSWER,
      commands: [
        { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
        { name: 'telegram:access', description: 'Manage Telegram channel access.\nMore lines a list never shows.' },
        // A menu on Claude Code's screen, which a chat never answers: not in its list.
        { name: 'config', description: 'Open config panel', builtin: true },
      ],
    })
    const options = { claudePath: script, spawn: spawnNode }
    const session = { cwd: tmpdir(), cliVersion: '2.1.283' }
    expect(await listClaudeCommands(session, options)).toEqual([
      { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
      { name: 'telegram:access', description: 'Manage Telegram channel access.', argumentHint: '' },
    ])
    expect((await listClaudeModels(session, options))?.map((m) => m.value)).toEqual(['default', 'claude-fable-5-1', 'haiku'])
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(script, '..', 'calls'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('drops a command no one could type, Claude Code\'s own internal ones and a repeat, and cuts a long line', () => {
    expect(parseClaudeCommandList([
      { name: '__remote-workflow', description: 'internal' },
      { name: 'rm -rf', description: 'bad' },
      { name: 'review', description: 'x'.repeat(300), argumentHint: 7 },
      { name: 'review', description: 'again' },
      'not a row',
    ])).toEqual([{ name: 'review', description: `${'x'.repeat(159)}…`, argumentHint: '' }])
    expect(parseClaudeCommandList([])).toBeNull()
    expect(parseClaudeCommandList(undefined)).toBeNull()
    expect(parseClaudeCommandList(Array.from({ length: 250 }, (_, i) => ({ name: `c${i}` })))).toHaveLength(200)
  })
})
