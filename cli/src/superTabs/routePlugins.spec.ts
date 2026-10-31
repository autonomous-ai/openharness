// cli/src/superTabs/routePlugins.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoutePlugin } from './route.js'
import { makePlugins, MAKER_TIMEOUT_MS, type PluginInput, type PluginMaker } from './routePlugins.js'

const input: PluginInput = { conversationId: 'g1', assessment: { difficulty: 'low', risk: 'low', size: 'small', why: 'x', needs: { tools: [], devices: [] } },
  read: { tab: {} }, catalog: { models: [], grid: { strength: 1, models: [] } }, history: Promise.resolve(null), request: async () => ({ ok: true }) }
const plugin = (name: string): RoutePlugin => ({ name, adjust: () => null })
const maker = (name: string, make: PluginMaker['make']): PluginMaker => ({ name, make })
const skipped = (name: string, why: string) => `The routing plug-in "${name}" was skipped: ${why}. The route is ranked without it.`

afterEach(() => { vi.useRealTimers() })

describe('makePlugins', () => {
  it('an empty list makes no plug-ins and no warnings', async () => {
    expect(await makePlugins([], input)).toEqual({ plugins: [], warnings: [] })
  })
  it('gives each maker the task, the backend read, the shared history and the request, and keeps the makers\' order whatever order they finish in', async () => {
    const seen: PluginInput[] = []
    const slowFirst = maker('First', async i => { seen.push(i); await new Promise(r => setTimeout(r, 20)); return plugin('first') })
    const fastSecond = maker('Second', async i => { seen.push(i); return plugin('second') })
    const made = await makePlugins([slowFirst, fastSecond], input)
    expect(made.plugins.map(p => p.name)).toEqual(['first', 'second'])
    expect(made.warnings).toEqual([])
    expect(seen).toEqual([input, input])
  })
  it('a maker with nothing to say this time adds no plug-in and no warning', async () => {
    expect(await makePlugins([maker('Idle', async () => null)], input)).toEqual({ plugins: [], warnings: [] })
  })
  it('a maker that throws, rejects or answers what is not a plug-in is left out with a warning, never with its error', async () => {
    const made = await makePlugins([
      maker('Throws', () => { throw new Error('token=secret') }),
      maker('Rejects', async () => { throw new Error('secret') }),
      maker('Junk', async () => ({ name: '' }) as RoutePlugin),
      maker('Bad adjust', async () => ({ name: 'x', adjust: 'no' }) as unknown as RoutePlugin),
      maker('Bad candidates', async () => ({ name: 'x', candidates: 1 }) as unknown as RoutePlugin),
      maker('Not an object', async () => 7 as unknown as RoutePlugin),
      maker('Fine', async () => plugin('fine')),
    ], input)
    expect(made.plugins.map(p => p.name)).toEqual(['fine'])
    expect(made.warnings).toEqual(['Throws', 'Rejects', 'Junk', 'Bad adjust', 'Bad candidates', 'Not an object'].map(n => skipped(n, 'its maker failed')))
    expect(JSON.stringify(made)).not.toContain('secret')
  })
  it('a maker that has not answered in time is left out with a warning, and what it answers later is dropped', async () => {
    vi.useFakeTimers()
    let finish: (p: RoutePlugin) => void = () => {}, fail: (e: Error) => void = () => {}
    const pending = makePlugins([maker('Slow', () => new Promise(r => { finish = r })), maker('Slow fail', () => new Promise((_, j) => { fail = j })),
      maker('Quick', async () => plugin('quick'))], input)
    await vi.advanceTimersByTimeAsync(MAKER_TIMEOUT_MS + 1)
    const made = await pending
    expect(made).toEqual({ plugins: [expect.objectContaining({ name: 'quick' })], warnings: ['Slow', 'Slow fail'].map(n => skipped(n, 'its maker took longer than 3 s')) })
    // Late answers change nothing, and a late failure is not an unhandled rejection.
    finish(plugin('late')); fail(new Error('late'))
    await vi.advanceTimersByTimeAsync(1)
    expect(made.plugins.map(p => p.name)).toEqual(['quick'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
