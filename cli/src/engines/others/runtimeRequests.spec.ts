import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OTHER_ENGINES } from '../otherEngines.js'
import { blankRuntimeState } from '../kit/runtime.js'
import { otherRuntimeRequests } from './runtimeRequests.js'
import { createScreenTransport } from '../../core/engines/screenTransport.js'
import { createRuntimeTransport } from '../../core/engines/runtimeTransport.js'
import { createQuestionControls } from '../../core/engines/questionControls.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { SCREEN_CAPABILITIES, SCREEN_READ } from '../worker/screenProtocol.js'
import { QUESTION_CONTROL_APPLY, QUESTION_CONTROL_CAPABILITIES } from '../worker/questionControlProtocol.js'
import { RUNTIME_CAPABILITIES, RUNTIME_READ } from '../worker/runtimeProtocol.js'
import type { ScreenReading } from '../facets/screen.js'
import * as takeoverScreens from '../../lib/__fixtures__/takeoverScreens.js'
import * as rewindPickers from '../../lib/__fixtures__/rewindPickers.js'

const core = { owner: true, local: true }
const golden = JSON.parse(readFileSync(new URL('../__fixtures__/other-screens.golden.json', import.meta.url), 'utf8')) as {
  inputs: Array<{ id: string; text?: string }>; screens: Record<string, Record<string, string>>; readings: Record<string, ScreenReading>
}
const capture = (input: { id: string; text?: string }): string | null => {
  if (input.id === '(no capture)') return null
  if (input.text !== undefined) return input.text
  const [file, name] = input.id.split('#')
  if (name) return (file.includes('takeoverScreens') ? takeoverScreens as Record<string, string> : rewindPickers as Record<string, string>)[name]
  return readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('shared other-engine runtime requests', () => {
  it('preserves every frozen screen through the real bounded port', async () => {
    const served = otherRuntimeRequests({ query: async () => ({}) })
    const transport = createScreenTransport({ call: async (_service, method, payload) =>
      await served.requests[method]({ ...payload, requestId: 'route' }, core) as Record<string, unknown> })
    transport.connected('engine-others')
    for (const input of golden.inputs) {
      const text = capture(input)
      if (text === null) continue
      for (const engine of OTHER_ENGINES) {
        const expected = golden.screens[input.id]?.[engine]
        if (!expected) continue
        await expect(transport.read(engine, text), `${engine}: ${input.id}`).resolves.toEqual(golden.readings[expected])
      }
    }
    served.clear()
  }, 30_000)

  it.each(OTHER_ENGINES)('keeps %s view-only through the real runtime port', async engine => {
    vi.stubEnv('PATH', '/nonexistent-other-runtime-test')
    const served = otherRuntimeRequests({ query: async () => ({}) })
    const transport = createRuntimeTransport({ call: async (_service, method, payload) =>
      await served.requests[method](payload, core) as Record<string, unknown> })
    transport.connected('engine-others')
    const context = { session: { agentId: 'agent', sessionId: 'session', engine, model: null, cliVersion: null, cwd: '/tmp', transcriptPath: null }, state: blankRuntimeState() }
    expect((await transport.read(engine, context, { kind: 'describe' })).supportsControl).toBe(false)
    expect((await transport.read(engine, context, { kind: 'models' })).models).toEqual([])
    served.clear()
  })

  it('rejects every public-client, foreign-engine and malformed request before reading', async () => {
    const served = otherRuntimeRequests({ query: async () => ({}) })
    for (const method of [SCREEN_CAPABILITIES, SCREEN_READ, RUNTIME_CAPABILITIES, RUNTIME_READ, QUESTION_CONTROL_CAPABILITIES, QUESTION_CONTROL_APPLY]) {
      for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...core, connection: 'client' }]) {
        expect(await served.requests[method]({ version: 1, engine: 'pi' }, asker)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
      }
      expect(await served.requests[method]({ version: 1, engine: 'claude' }, core)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    }
  })

  it('keeps numbered review confirmation inside its approved grant', async () => {
    const session = { agentId: 'agent', sessionId: 'session', engine: 'cursor', boundAt: 1, active: true, tmuxPane: '%1' } as RegisteredSession
    const writes: string[] = []
    const served = otherRuntimeRequests({ query: (query, payload) => controls.answer('engine-others', query, payload)! })
    const controls = createQuestionControls({ handles: () => true, resolve: () => session, inline: () => { throw Error('inline') },
      key: async (_id, key, allowed) => { if (!allowed()) return false; writes.push(key); return true }, text: async () => false,
      call: async (_service, method, payload) => await served.requests[method](payload, core) as Record<string, unknown> })
    controls.connected('engine-others')
    expect(await controls.forSession(session)!.apply({ kind: 'review', key: '2' })).toBe(true)
    expect(writes).toEqual(['2'])
  })

  it.each(['n', 'y', 'Tab', 'BTab'])('keys only the approved Cursor hint %s through a grant', async hint => {
    vi.useFakeTimers()
    const session = { agentId: 'agent', sessionId: 'session', engine: 'cursor', boundAt: 1, active: true, tmuxPane: '%1' } as RegisteredSession
    const writes: string[] = []
    const served = otherRuntimeRequests({ query: (query, payload) => controls.answer('engine-others', query, payload)! })
    const controls = createQuestionControls({ handles: () => true, resolve: () => session, inline: () => { throw Error('inline') },
      key: async (_id, key, allowed) => { if (!allowed()) return false; writes.push(key); return true }, text: async () => false,
      call: async (_service, method, payload) => await served.requests[method](payload, core) as Record<string, unknown> })
    controls.connected('engine-others')
    const result = controls.forSession(session)!.apply({ kind: 'select', row: { number: hint, label: 'Reviewed', checked: false } })
    await vi.runAllTimersAsync()
    expect(await result).toBe(true)
    expect(writes).toEqual([hint])
  })
})
