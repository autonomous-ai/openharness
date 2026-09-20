import { describe, expect, it, vi } from 'vitest'
import { CommandBarService } from './commandBar.js'

const candidate = { id: 'settings', kind: 'command', title: 'Open Settings', detail: 'Open appearance and account settings.', context: '' }
const request = { prompt: 'change my theme', candidates: [candidate] }
const choice = (extra = {}) => ({ type: 'choice', choice: 'c0', confidence: 0.99, probabilities: { c0: 0.98, none: 0.02 }, ...extra })
const json = (answers: unknown) => new Response(JSON.stringify({ answers }), { status: 200 })
const decisions = (action = choice(), kind = 'command') => ({
  intent: choice({ choice: kind, probabilities: { [kind]: 0.98, none: 0.02 } }),
  [`pick_${kind}`]: action,
})
function service(action = choice(), fit = 0.98, kind = 'command') {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json(decisions(action, kind)))
    .mockResolvedValueOnce(json({ fit: { type: 'noul', noul: fit } }))
  return { fetcher, api: new CommandBarService({ fetch: fetcher, key: async () => 'fixture-only' }) }
}

describe('JEV command bar decisions', () => {
  it('uses the Decisions API and independently verifies the selected action before auto navigation', async () => {
    const { api, fetcher } = service()
    expect(await api.decide(request)).toMatchObject({ selectedId: 'settings', autoExecute: true, provider: 'OpenRouter' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    const payload = JSON.parse(String(init!.body))
    expect(payload.model).toBe('typesafe/jev-1.13')
    expect(payload.state.prompt).toBe(request.prompt)
    expect(payload.questions.intent.criteria).toHaveProperty('none')
    expect(payload.questions.pick_command.criteria.c0).toContain('state.candidates.c0')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body)).state.selected.id).toBe('settings')
    expect(fetcher.mock.calls[0][1]!.signal).toBe(fetcher.mock.calls[1][1]!.signal)
  })

  it('does not equate a high relative probability with a supported request', async () => {
    const { api } = service(choice(), 0.1)
    expect(await api.decide(request)).toMatchObject({ selectedId: null, suggestions: ['settings'], autoExecute: false })
  })

  it.each(['send', 'create', 'watch'])('always leaves %s for explicit selection', async kind => {
    const { api } = service(choice(), 0.98, kind)
    expect(await api.decide({ ...request, candidates: [{ ...candidate, kind }] })).toMatchObject({ selectedId: 'settings', autoExecute: false })
  })

  it('accepts an abstention without a second request', async () => {
    const { api, fetcher } = service(choice({ choice: 'none' }))
    expect(await api.decide(request)).toMatchObject({ selectedId: null, autoExecute: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    choice({ choice: 'shell:rm' }),
    choice({ confidence: 1.5 }),
    choice({ probabilities: { c0: -1 } }),
    { type: 'choice' },
  ])('rejects malformed or invented decisions', async answer => {
    const { api } = service(answer as ReturnType<typeof choice>)
    await expect(api.decide(request)).rejects.toMatchObject({ code: 'INVALID_DECISION' })
  })

  it('does not auto run when optional probability metadata is absent', async () => {
    const { api } = service({ type: 'choice', choice: 'c0' } as ReturnType<typeof choice>)
    expect(await api.decide(request)).toMatchObject({ selectedId: 'settings', autoExecute: false })
  })

  it('rejects duplicate identities, excessive context and unknown fields before any provider call', async () => {
    const { api, fetcher } = service()
    for (const invalid of [
      { ...request, candidates: [candidate, candidate] },
      { ...request, prompt: 'x'.repeat(2001) },
      { ...request, apiKey: 'do-not-accept' },
      { ...request, candidates: Array.from({ length: 60 }, (_, i) => ({ ...candidate, id: String(i), context: 'x'.repeat(700) })) },
    ]) await expect(api.decide(invalid)).rejects.toMatchObject({ status: 400 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not reflect provider error bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private prompt / fake secret', { status: 500 }))
    const api = new CommandBarService({ fetch: fetcher, key: async () => 'fixture-only' })
    await expect(api.decide(request)).rejects.toMatchObject({ code: 'JEV_UNAVAILABLE', message: 'JEV is unavailable. Try again or choose a local action.' })
  })

  it('reports missing OpenRouter setup without a provider request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const api = new CommandBarService({ fetch: fetcher, key: async () => null })
    expect(await api.status()).toEqual({ configured: false, provider: 'OpenRouter', model: 'typesafe/jev-1.13' })
    await expect(api.decide(request)).rejects.toMatchObject({ code: 'OPENROUTER_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('cancels superseded requests and bounds time spent in the provider', async () => {
    const aborted = new AbortController(); aborted.abort()
    const { api, fetcher } = service()
    await expect(api.decide(request, aborted.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetcher).not.toHaveBeenCalled()
    const slowFetch = vi.fn<typeof fetch>().mockImplementation(async (_, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const slow = new CommandBarService({ fetch: slowFetch, key: async () => 'fixture-only', timeoutMs: 10 })
    await expect(slow.decide(request)).rejects.toMatchObject({ status: 504 })
  })

  it('bounds concurrency without queueing paid requests', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const api = new CommandBarService({ fetch: fetcher, key: async () => 'fixture-only' })
    const a = api.decide(request)
    await Promise.resolve()
    const finishA = finish
    const b = api.decide(request)
    await Promise.resolve()
    await expect(api.decide(request)).rejects.toMatchObject({ code: 'BUSY' })
    finishA(json(decisions(choice({ choice: 'none' }))))
    finish(json(decisions(choice({ choice: 'none' }))))
    await Promise.all([a, b])
  })

  it('evaluates matches independently against explicitly referenced session evidence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ c0: { type: 'noul', noul: 0.9 }, c1: { type: 'noul', noul: 0.3 } }))
    const api = new CommandBarService({ fetch: fetcher, key: async () => 'fixture-only' })
    const result = await api.decide({ mode: 'match', prompt: 'tests are passing', candidates: [
      { ...candidate, id: 's1', kind: 'open', context: 'Test suite passed.' },
      { ...candidate, id: 's2', kind: 'open', context: 'Tests failed.' },
      candidate,
    ] })
    expect(result).toMatchObject({ matches: [{ id: 's1', fit: 0.9 }] })
    const questions = JSON.parse(String(fetcher.mock.calls[0][1]!.body)).questions
    expect(Object.keys(questions)).toEqual(['c0', 'c1'])
    expect(questions.c0.instructions).toContain('state.candidates.c0')
    expect(questions.c1.instructions).toContain('state.candidates.c1')
  })
})
