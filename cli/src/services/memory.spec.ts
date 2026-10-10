import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { memEnv, MEMORY_REQUESTS, runMem, startMemory, type MemoryDeps } from './memory.js'

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
    expect(await memory.memory_about_put!({ text: '## A\n- one\n', gen: 7 }, owner)).toEqual({ ok: true, written: true })
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

describe('memory: one write at a time, one read for many', () => {
  it('runs writes in the order they came, and shares one snapshot among those asked together', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    const memory = startMemory(fakeCore(), {
      packageDir: () => '/pkg',
      run: async (_dir, args) => {
        if (args[0] === 'snapshot') { reads++; await gate; return { stdout: '{"memories":[]}' } }
        order.push(`start ${args[1]}`)
        if (args[1] === 'on') await gate
        order.push(`end ${args[1]}`)
        return { stdout: '{"written":false}' }
      },
    })
    const on = memory.memory_deliver!({ on: true, choiceAt: 10 }, owner)
    const off = memory.memory_deliver!({ on: false, choiceAt: 11 }, owner)
    const first = memory.memory_snapshot!({}, owner)
    const second = memory.memory_snapshot!({}, owner)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['start on'])
    release()
    await Promise.all([on, off, first, second])
    expect(order).toEqual(['start on', 'end on', 'start off', 'end off'])
    expect(reads).toBe(1)
    expect(await memory.memory_about_put!({ text: '## A\n- older\n', gen: 1 }, owner)).toEqual({ ok: true, written: false })
    // A write that fails does not stop the ones after it.
    const failing = startMemory(fakeCore(), { packageDir: () => '/pkg', run: async (_dir, args) => { if (args[1] === 'on') throw new Error('no'); return { stdout: '{}' } } })
    const bad = failing.memory_deliver!({ on: true, choiceAt: 2 }, owner)
    const good = failing.memory_deliver!({ on: false, choiceAt: 3 }, owner)
    expect(await bad).toMatchObject({ error: 'MEMORY_FAILED' })
    expect(await good).toMatchObject({ ok: true })
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

  it('rejects with the command\'s last line of error output, and never with a command line', async () => {
    const dir = pkg(`console.error('first'); console.error('the profile has no lines'); process.exit(1)`)
    await expect(runMem(dir, ['about', 'write'])).rejects.toThrow('the profile has no lines')
    const silent = pkg(`process.exit(3)`)
    await expect(runMem(silent, [])).rejects.toThrow('mem stopped (exit 3)')
    const garbled = pkg(`console.log('{ not json'); process.exit(1)`)
    await expect(runMem(garbled, [])).rejects.toThrow('mem stopped (exit 1)')
  })

  it('says a run was too slow, or stopped by a signal, in words', async () => {
    const slow = pkg(`setTimeout(() => {}, 10_000)`)
    await expect(runMem(slow, [], undefined, process.versions.node, 200)).rejects.toThrow('mem stopped (too slow)')
    const killed = pkg(`process.kill(process.pid, 'SIGKILL')`)
    await expect(runMem(killed, [])).rejects.toThrow('mem stopped (exit unknown)')
  })

  it('takes the answer of a run that wrote some agents and not others (exit 1, its JSON printed)', async () => {
    const dir = pkg(`console.log(JSON.stringify({ on: true, results: [{ agent: 'claude', ok: true }, { agent: 'codex', ok: false, error: 'is a link' }] })); process.exit(1)`)
    const { stdout } = await runMem(dir, ['deliver', 'on', '--json'])
    expect(JSON.parse(stdout).results[1]).toEqual({ agent: 'codex', ok: false, error: 'is a link' })
  })

  it('needs Node 22, and never hands the daemon\'s credentials to the package', async () => {
    await expect(runMem('/pkg', [], undefined, '20.10.0')).rejects.toThrow('Memories needs Node 22 or newer; this Harness runs on 20.10.0.')
    expect(memEnv({ HOME: '/h', HARNESSD_SERVICE_TOKEN: 'secret', HARNESSD_SERVICES: 'x', PATH: '/bin' })).toEqual({ HOME: '/h', PATH: '/bin' })
  })
})
