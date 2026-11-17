import { afterEach, expect, it, vi } from 'vitest'
import * as inline from '../inProcess.js'
import { OTHER_ENGINES, type OtherEngine } from '../otherEngines.js'
import { blankRuntimeState } from '../kit/runtime.js'
import { RUNTIME_IN_FLIGHT, RUNTIME_READ } from '../worker/runtimeProtocol.js'
import { SCREEN_IN_FLIGHT, SCREEN_READ } from '../worker/screenProtocol.js'
import { QUESTION_CONTROL_APPLY, QUESTION_CONTROL_IN_FLIGHT } from '../worker/questionControlProtocol.js'
import { otherRuntimeRequests } from './runtimeRequests.js'
import { PROFILE_SESSIONS } from './runtime.js'

const core = { owner: true, local: true }
const runtime = (engine: OtherEngine, id: string = engine) => ({ version: 1, engine,
  context: { session: { agentId: id, sessionId: id, engine, model: null, cliVersion: null, cwd: '/tmp', transcriptPath: null }, state: blankRuntimeState() },
  operation: { kind: 'pane', text: '' } })
afterEach(() => vi.restoreAllMocks())

it('shares runtime and screen admission across the fourteen engines', async () => {
  const served = otherRuntimeRequests({ query: async () => ({}), recycle: vi.fn() })
  const runtimeCalls = OTHER_ENGINES.slice(0, RUNTIME_IN_FLIGHT).map(engine => served.requests[RUNTIME_READ](runtime(engine), core))
  expect(await served.requests[RUNTIME_READ](runtime(OTHER_ENGINES[RUNTIME_IN_FLIGHT]), core)).toMatchObject({ error: 'ENGINE_BUSY' })
  for (const reply of await Promise.all(runtimeCalls)) expect(reply).toHaveProperty('answer')
  const screen = (engine: OtherEngine) => ({ version: 1, engine, capture: '' })
  const screenCalls = OTHER_ENGINES.slice(0, SCREEN_IN_FLIGHT).map(engine => served.requests[SCREEN_READ](screen(engine), core))
  expect(await served.requests[SCREEN_READ](screen(OTHER_ENGINES[SCREEN_IN_FLIGHT]), core)).toMatchObject({ error: 'ENGINE_BUSY' })
  for (const reply of await Promise.all(screenCalls)) expect(reply).toHaveProperty('answer')
  expect(await served.requests[SCREEN_READ](screen('cursor'), core)).toHaveProperty('answer')
  served.clear()
})

it('shares question admission and revokes pending host writes when the connection closes', async () => {
  const releases: Array<(reply: Record<string, unknown>) => void> = []
  const query = vi.fn(() => new Promise<Record<string, unknown>>(done => { releases.push(done) }))
  const served = otherRuntimeRequests({ query, recycle: vi.fn() })
  const closed = new AbortController()
  const payload = (index: number) => ({ version: 1, engine: OTHER_ENGINES[index % OTHER_ENGINES.length],
    token: index.toString(16).padStart(64, '0'), step: { kind: 'review', key: 'Enter' } })
  const requests = Array.from({ length: QUESTION_CONTROL_IN_FLIGHT }, (_, index) => served.requests[QUESTION_CONTROL_APPLY](payload(index), core, closed.signal))
  expect(await served.requests[QUESTION_CONTROL_APPLY](payload(QUESTION_CONTROL_IN_FLIGHT), core)).toMatchObject({ error: 'ANSWER_FAILED' })
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(QUESTION_CONTROL_IN_FLIGHT))
  closed.abort()
  releases.forEach(release => release({ version: 1, value: true }))
  for (const answer of await Promise.all(requests)) expect(answer).toMatchObject({ error: 'ANSWER_FAILED' })
  // A later lifetime is admitted after the aborted work is released.
  query.mockResolvedValue({ version: 1, value: true })
  expect(await served.requests[QUESTION_CONTROL_APPLY](payload(0), core)).toEqual({ version: 1, ok: true })
  served.clear()
})

it('evicts derived profile targets across engines and clears all retained sessions on disconnect', async () => {
  const forget = vi.fn()
  vi.spyOn(inline, 'loadEngine').mockImplementation(async engine => ({ createRuntimeProfileReader: () => ({
    engine, forget: (id: string) => forget(engine, id), pane: () => {},
  }) }) as never)
  const served = otherRuntimeRequests({ query: async () => ({}), recycle: vi.fn() })
  for (let index = 0; index <= PROFILE_SESSIONS; index++) {
    const engine = OTHER_ENGINES[index % OTHER_ENGINES.length]
    expect(await served.requests[RUNTIME_READ](runtime(engine, `session-${index}`), core)).toHaveProperty('answer')
  }
  expect(forget).toHaveBeenCalledExactlyOnceWith(OTHER_ENGINES[0], 'session-0')
  served.clear()
  expect(forget).toHaveBeenCalledTimes(PROFILE_SESSIONS + 1)
  served.clear()
  expect(forget).toHaveBeenCalledTimes(PROFILE_SESSIONS + 1)
  expect(await served.requests[RUNTIME_READ](runtime('pi', 'new-lifetime'), core)).toHaveProperty('answer')
  served.clear()
  expect(forget).toHaveBeenLastCalledWith('pi', 'new-lifetime')
})
