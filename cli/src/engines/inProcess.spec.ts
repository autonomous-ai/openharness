/**
 * The loader of the other engines' code (engines/inProcess.ts): a module that cannot load costs those engines
 * alone, once, and never the core. The bundle-level proof, a deleted chunk under a running daemon, is
 * e2e/lean.e2e.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createInProcessLoader, isOtherEngine, OTHER_ENGINES } from './inProcess.js'
import { terminalScreen } from './kit/screen.js'
import { ENGINES } from './types.js'

const scratch = mkdtempSync(join(tmpdir(), 'in-process-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
afterEach(() => { vi.doUnmock('../lib/legacyScreen.js'); vi.resetModules(); vi.restoreAllMocks() })
const tick = () => new Promise((settle) => setTimeout(settle, 0))
/** A real module file, imported as the bundle's chunks are. */
const moduleFile = (name: string, text: string): string => {
  const path = join(scratch, name)
  writeFileSync(path, text)
  return pathToFileURL(path).href
}

describe('the loader', () => {
  it('imports a module once, whoever asks, and says it is loading until it has', async () => {
    const good = vi.fn(async () => ({ value: 1 }))
    const log = vi.fn()
    const loader = createInProcessLoader<{ good: { value: number } }>({ good }, log)
    expect(loader.loaded('good')).toBeUndefined()
    const [a, b] = await Promise.all([loader.load('good'), loader.load('good')])
    expect(a).toEqual({ value: 1 })
    expect(b).toBe(a)
    expect(loader.loaded('good')).toBe(a)
    expect(await loader.load('good')).toBe(a)
    expect(good).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('answers null, logs once and never retries an import that rejects: its file gone from the bundle', async () => {
    const missing = pathToFileURL(join(scratch, 'core-legacyScreen-GONE.mjs')).href
    const gone = vi.fn(() => import(/* @vite-ignore */ missing))
    const log = vi.fn()
    const loader = createInProcessLoader<{ gone: unknown; other: { ok: true } }>({ gone, other: async () => ({ ok: true }) }, log)
    expect(await loader.load('gone')).toBeNull()
    expect(await loader.load('gone')).toBeNull()
    expect(loader.loaded('gone')).toBeNull()
    expect(gone).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/^\[engine gone\] unavailable · .*core-legacyScreen-GONE\.mjs/)
    expect(log.mock.calls[0][0]).not.toContain('\n')
    // Another module still loads.
    expect(await loader.load('other')).toEqual({ ok: true })
  })

  it('answers null, logs once and never retries a module whose top level throws', async () => {
    const throwing = moduleFile('throws.mjs', 'export const never = 1\nthrow new Error("a chunk that\\nthrows as it loads")\n')
    const fine = moduleFile('fine.mjs', 'export const fine = true\n')
    const log = vi.fn()
    const loader = createInProcessLoader<{ throws: unknown; fine: { fine: boolean } }>({
      throws: () => import(/* @vite-ignore */ throwing), fine: () => import(/* @vite-ignore */ fine),
    }, log)
    expect(loader.loaded('throws')).toBeUndefined()
    await tick()
    expect(await loader.load('throws')).toBeNull()
    expect(loader.loaded('throws')).toBeNull()
    expect(log.mock.calls).toEqual([['[engine throws] unavailable · a chunk that throws as it loads']])
    expect((await loader.load('fine'))?.fine).toBe(true)
  })

  it('catches a loader that throws before it returns a promise, and a rejection that is not an Error', async () => {
    const log = vi.fn()
    const loader = createInProcessLoader<{ sync: unknown; odd: unknown }>({
      sync: () => { throw new Error('thrown in line') },
      odd: () => Promise.reject('a plain string'),
    }, log)
    expect(await loader.load('sync')).toBeNull()
    expect(await loader.load('odd')).toBeNull()
    expect(log.mock.calls).toEqual([['[engine sync] unavailable · thrown in line'], ['[engine odd] unavailable · a plain string']])
  })
})

/** The module as the core has it, with the screens' file standing in: counted, or failing to load. */
async function fresh(screens: 'counted' | 'broken') {
  const evaluated = { count: 0 }
  vi.doMock('../lib/legacyScreen.js', () => {
    evaluated.count++
    if (screens === 'broken') throw new Error('the screens chunk is gone')
    return { legacyScreen: (engine: string, capture: string | null) => ({ read: engine, capture }) }
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return { inProcess: await import('./inProcess.js'), evaluated, error }
}

describe('the core\'s side', () => {
  it('loads Kilo runtime code when the shared adoption reader cannot load', async () => {
    vi.doMock('../lib/sessionSearch/externals/opencode.js', () => { throw new Error('adoption chunk unavailable') })
    try {
      const { inProcess } = await fresh('counted')
      expect(await inProcess.loadEngine('opencode')).toBeNull()
      const kilo = await inProcess.loadEngine('kilo')
      expect(kilo).not.toBeNull()
      expect(kilo).toHaveProperty('KiloReader')
      expect(inProcess.engineNow('kilo', 'a pane was read')).toHaveProperty('createRuntimeProfileReader')
    } finally { vi.doUnmock('../lib/sessionSearch/externals/opencode.js') }
  })

  it('names the twelve engines besides Claude Code, Codex and the terminal', () => {
    expect(ENGINES.filter(isOtherEngine)).toEqual(ENGINES.filter((engine) => !['claude', 'codex', 'terminal'].includes(engine)))
    expect(OTHER_ENGINES).toHaveLength(12)
  })

  it('preloads the screens for a session of theirs, once; Claude Code, Codex and the terminal load nothing', async () => {
    const { inProcess, evaluated } = await fresh('counted')
    for (const engine of ['claude', 'codex', 'terminal'] as const) inProcess.preloadEngine(engine)
    await tick()
    expect(evaluated.count).toBe(0)
    inProcess.preloadEngine('amp')
    inProcess.preloadEngine('pi')
    await tick()
    expect(evaluated.count).toBe(1)
    expect(inProcess.engineLoaded('screens')).toHaveProperty('legacyScreen')
  })

  it('preloads each engine\'s own code with its pane readers, and hands it to a caller that cannot wait', async () => {
    const { inProcess, error } = await fresh('counted')
    expect(inProcess.engineNow('grok', 'a line came')).toBeNull()
    expect(inProcess.engineNow('grok', 'a line came')).toBeNull()
    expect(error.mock.calls).toEqual([['[engine grok] a line came before its code was loaded · skipped']])
    inProcess.preloadEngine('pi')
    expect(await inProcess.loadEngine('pi')).toHaveProperty('PiNormalizer')
    expect(inProcess.engineNow('pi', 'a line came')).toHaveProperty('PiNormalizer')
    vi.doMock('./kilo/inProcess.js', () => { throw new Error('kilo is gone') })
    expect(await inProcess.loadEngine('kilo')).toBeNull()
    expect(inProcess.engineNow('kilo', 'a line came')).toBeNull()
    expect(error).toHaveBeenCalledTimes(2)
    vi.doUnmock('./kilo/inProcess.js')
  })

  it('reads their panes with their readers, the terminal\'s with the kit, and no other engine\'s', async () => {
    const { inProcess, evaluated } = await fresh('counted')
    expect(await inProcess.inProcessScreen('terminal', 'user@host % ')).toEqual(terminalScreen('user@host % '))
    expect(await inProcess.inProcessScreen('terminal', null)).toEqual(terminalScreen(null))
    expect(await inProcess.inProcessScreen('claude', 'x')).toBeUndefined()
    expect(await inProcess.inProcessScreen('codex', null)).toBeUndefined()
    expect(evaluated.count).toBe(0)
    expect(await inProcess.inProcessScreen('kilo', 'pane')).toEqual({ read: 'kilo', capture: 'pane' })
    expect(await inProcess.inProcessScreen('grok', null)).toEqual({ read: 'grok', capture: null })
    expect(evaluated.count).toBe(1)
  })

  it('with their readers unable to load: their panes unreadable, logged once; the terminal\'s still read', async () => {
    const { inProcess, evaluated, error } = await fresh('broken')
    inProcess.preloadEngine('opencode')
    for (const engine of OTHER_ENGINES) expect(await inProcess.inProcessScreen(engine, 'pane'), engine).toBeUndefined()
    expect(inProcess.engineLoaded('screens')).toBeNull()
    expect(evaluated.count).toBe(1)
    // Vitest words a failing mock's error its own way; a real chunk's is the loader's tests above.
    expect(error.mock.calls).toEqual([[expect.stringMatching(/^\[engine screens\] unavailable · /)]])
    expect(await inProcess.inProcessScreen('terminal', 'user@host % ')).toEqual(terminalScreen('user@host % '))
  })
})
