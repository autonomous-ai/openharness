import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { MEMORY_REQUESTS, runMem, startMemory, type MemoryDeps } from './memory.js'

vi.mock('../dsh/installed.js', () => ({ installedDsh: vi.fn(() => undefined) }))

const owner = { local: false, owner: true }
const device = { local: false, owner: false }

/** A Memories package whose `mem` answers what the test says, and records what it was asked. */
function deps(answer: (args: string[], input?: string) => unknown = () => ({ ok: true })): MemoryDeps & { calls: Array<[string[], string | undefined]> } {
  const calls: Array<[string[], string | undefined]> = []
  return {
    calls,
    packageDir: () => '/pkg',
    run: async (_dir, args, input) => {
      calls.push([args, input])
      const value = answer(args, input)
      if (value instanceof Error) throw value
      return { stdout: JSON.stringify(value) }
    },
  }
}

describe('memory: this machine\'s memories for the owner\'s other machines', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers the three requests it declares', () => {
    expect(Object.keys(startMemory(fakeCore(), deps())).sort()).toEqual([...MEMORY_REQUESTS].sort())
  })

  it('answers only the owner', async () => {
    const memory = startMemory(fakeCore(), deps())
    for (const type of MEMORY_REQUESTS) expect(await memory[type]!({}, device)).toEqual({ error: 'OWNER_REQUIRED' })
  })

  it('memory_snapshot runs `mem snapshot --json` and answers what it printed', async () => {
    const d = deps(() => ({ memories: [{ id: 'claude:x.md' }] }))
    expect(await startMemory(fakeCore(), d).memory_snapshot!({}, owner)).toEqual({ snapshot: { memories: [{ id: 'claude:x.md' }] } })
    expect(d.calls).toEqual([[['snapshot', '--json'], undefined]])
  })

  it('memory_about_put writes another machine\'s build with its number', async () => {
    const d = deps(() => ({ written: true, refreshed: ['codex'] }))
    const memory = startMemory(fakeCore(), d)
    expect(await memory.memory_about_put!({ text: '## A\n- one\n', gen: 7 }, owner)).toEqual({ ok: true })
    expect(d.calls).toEqual([[['about', 'write', '--gen', '7', '--json'], '## A\n- one\n']])
    expect(await memory.memory_about_put!({ text: '  ', gen: 7 }, owner)).toMatchObject({ error: 'INVALID_MEMORY' })
    expect(await memory.memory_about_put!({ text: 'x'.repeat(70_000), gen: 7 }, owner)).toMatchObject({ error: 'INVALID_MEMORY' })
    expect(await memory.memory_about_put!({ text: '## A\n- one\n', gen: '7' }, owner)).toMatchObject({ error: 'INVALID_MEMORY' })
    expect(await memory.memory_about_put!({ gen: 7 }, owner)).toMatchObject({ error: 'INVALID_MEMORY' })
  })

  it('memory_deliver applies the choice with the time it was made', async () => {
    const d = deps(() => ({ on: false, results: [] }))
    const memory = startMemory(fakeCore(), d)
    expect(await memory.memory_deliver!({ on: false, choiceAt: 1_791_600_000_000 }, owner)).toEqual({ ok: true, delivery: { on: false, results: [] } })
    expect(await memory.memory_deliver!({ on: true, choiceAt: 5 }, owner)).toMatchObject({ ok: true })
    expect(d.calls.map(([args]) => args)).toEqual([['deliver', 'off', '--choice-at', '1791600000000', '--json'], ['deliver', 'on', '--choice-at', '5', '--json']])
    for (const bad of [{ on: 'yes', choiceAt: 5 }, { on: true }, { on: true, choiceAt: 0 }, { on: true, choiceAt: 1.5 }]) {
      expect(await memory.memory_deliver!(bad, owner)).toMatchObject({ error: 'INVALID_MEMORY' })
    }
  })

  it('says when Memories is not installed, and what failed when its command did', async () => {
    const missing = startMemory(fakeCore(), { ...deps(), packageDir: () => null })
    expect(await missing.memory_snapshot!({}, owner)).toMatchObject({ error: 'MEMORIES_NOT_INSTALLED' })
    const broken = startMemory(fakeCore(), deps(() => new Error('the session index is busy')))
    expect(await broken.memory_snapshot!({}, owner)).toEqual({ error: 'MEMORY_FAILED', detail: 'the session index is busy' })
    expect(await broken.memory_about_put!({ text: '## A\n- x\n', gen: 1 }, owner)).toMatchObject({ error: 'MEMORY_FAILED' })
    expect(await broken.memory_deliver!({ on: true, choiceAt: 2 }, owner)).toMatchObject({ error: 'MEMORY_FAILED' })
    const garbled = startMemory(fakeCore(), { packageDir: () => '/pkg', run: async () => ({ stdout: 'not json' }) })
    expect(await garbled.memory_snapshot!({}, owner)).toMatchObject({ error: 'MEMORY_FAILED' })
    const thrown = startMemory(fakeCore(), { packageDir: () => '/pkg', run: async () => { throw 'plain' } })
    expect(await thrown.memory_snapshot!({}, owner)).toEqual({ error: 'MEMORY_FAILED', detail: 'plain' })
  })

  it('by default, finds the installed package and says when there is none', async () => {
    const { installedDsh } = await import('../dsh/installed.js')
    expect(await startMemory(fakeCore()).memory_snapshot!({}, owner)).toMatchObject({ error: 'MEMORIES_NOT_INSTALLED' })
    expect(installedDsh).toHaveBeenCalledWith('autonomous/memories')
  })
})

describe('runMem: the package\'s own command, on this process\'s Node', () => {
  const pkg = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-pkg-'))
    mkdirSync(join(dir, 'toolchain'))
    writeFileSync(join(dir, 'toolchain', 'mem.mjs'), body)
    chmodSync(join(dir, 'toolchain', 'mem.mjs'), 0o755)
    return dir
  }

  it('passes the arguments and the input, and returns what it printed', async () => {
    const dir = pkg(`let input = ''; process.stdin.on('data', (c) => { input += c }).on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), input })))`)
    const { stdout } = await runMem(dir, ['about', 'write', '--json'], 'hello')
    expect(JSON.parse(stdout)).toEqual({ args: ['about', 'write', '--json'], input: 'hello' })
    const quiet = await runMem(dir, ['snapshot'])
    expect(JSON.parse(quiet.stdout)).toEqual({ args: ['snapshot'], input: '' })
  })

  it('rejects with the command\'s last line of error output', async () => {
    const dir = pkg(`console.error('first'); console.error('the profile has no lines'); process.exit(1)`)
    await expect(runMem(dir, ['about', 'write'])).rejects.toThrow('the profile has no lines')
    const silent = pkg(`process.exit(3)`)
    await expect(runMem(silent, [])).rejects.toThrow(/Command failed/)
  })
})
