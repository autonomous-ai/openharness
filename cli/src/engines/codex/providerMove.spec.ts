import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import gridInstructions from './gridInstructions.json' with { type: 'json' }
import { appServerArgs, moveCodexConversation } from './providerMove.js'

/** A stand-in `codex` that speaks app-server's JSONL, records what it is asked, and refuses the fork when told to. */
function fakeCodex(fork: 'works' | 'refused' = 'works') {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'))
  const seen = join(dir, 'seen.jsonl')
  const command = join(dir, 'codex')
  writeFileSync(command, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')
if (process.argv[2] === 'debug') { console.log(JSON.stringify({ models: [{ slug: 'own-model', base_instructions: 'OWN' }] })); process.exit(0) }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  appendFileSync(${JSON.stringify(seen)}, line + '\\n')
  if (m.id === undefined) return
  const say = (x) => console.log(JSON.stringify(x))
  if (m.method === 'thread/fork') return say(${fork === 'works'} ? { id: m.id, result: { thread: { id: 'new-thread' } } } : { id: m.id, error: { message: 'no such thread' } })
  if (m.method === 'model/list') return say({ id: m.id, result: { data: [{ model: 'own-model', isDefault: true }] } })
  say({ id: m.id, result: {} })
})
`)
  chmodSync(command, 0o755)
  const requests = () => readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { command, requests }
}
const moveWith = (command: string, toGrid: boolean, args: string[]) =>
  moveCodexConversation({ sessionId: 'source', toGrid, args, argv: (codexArgs) => [command, ...codexArgs], env: process.env, cwd: '/work' })

describe.skipIf(process.platform === 'win32')('moveCodexConversation', () => {
  it('forks onto the grid on the launch model, with the instructions of a new conversation and no other change', async () => {
    const codex = fakeCodex()
    expect(await moveWith(codex.command, true, ['-c', 'model_provider="grid"', '-m', 'grid/model'])).toBe('new-thread')
    const asked = codex.requests()
    expect(asked[0].argv).toEqual(['app-server', '-c', 'model_provider="grid"'])
    expect(asked.find((r) => r.method === 'thread/fork').params).toEqual({
      threadId: 'source', model: 'grid/model', cwd: '/work', baseInstructions: gridInstructions.instructions,
    })
    expect(asked.filter((r) => r.method).map((r) => r.method)).toEqual(['initialize', 'initialized', 'thread/fork'])
  })

  it('reports a refused fork', async () => {
    const codex = fakeCodex('refused')
    await expect(moveWith(codex.command, true, ['-m', 'grid/model'])).rejects.toThrow('no such thread')
  })

  it('restores the own model\'s instructions on the way home', async () => {
    const codex = fakeCodex()
    expect(await moveWith(codex.command, false, ['-c', 'model_provider="openai"'])).toBe('new-thread')
    expect(codex.requests().find((r) => r.method === 'thread/fork').params).toEqual({ threadId: 'source', cwd: '/work', baseInstructions: 'OWN' })
  })

  it('leaves the conversation\'s instructions alone on the way home when the catalog does not list the model', async () => {
    const codex = fakeCodex()
    await moveWith(codex.command, false, ['-m', 'unlisted'])
    expect(codex.requests().find((r) => r.method === 'thread/fork').params).toEqual({ threadId: 'source', model: 'unlisted', cwd: '/work' })
  })
})

describe('appServerArgs', () => {
  it('keeps every -c pair and takes the model out, because app-server refuses -m', () => {
    expect(appServerArgs(['-c', 'model_provider="grid"', '-m', 'some/model', '--flag', '-c', 'x=1'])).toEqual({
      config: ['-c', 'model_provider="grid"', '-c', 'x=1'], model: 'some/model',
    })
  })

  it('finds no model where the launch names none', () => {
    expect(appServerArgs(['-c', 'model_provider="openai"'])).toEqual({ config: ['-c', 'model_provider="openai"'], model: null })
  })
})

describe('the instructions a move to a grid starts with', () => {
  it('never name the tool a grid model does not have', () => {
    expect(gridInstructions.instructions.length).toBeGreaterThan(1000)
    expect(gridInstructions.instructions).not.toContain('functions.exec')
  })
})
