import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_BAR_REQUESTS, emptyPorts, type Asker } from '../core/api.js'
import { createServiceHost } from '../core/serviceHost.js'
import { CommandBarError, CommandBarService, commandBarService } from '../lib/commandBar.js'
import { fakeCore } from '../testing/fakeCore.js'
import { commandsFor, startCommandBar, type Commands } from './commandBar.js'

const OWNER: Asker = { local: false, owner: true, connection: 'web-1' }
const REQUEST = { prompt: 'open the release notes', candidates: [] }

/** A decision that waits until its signal aborts, then fails as the real one does when its asker goes. */
function waitingDecide() {
  const started: AbortSignal[] = []
  const decide = vi.fn((_raw: unknown, signal?: AbortSignal) => new Promise<Record<string, unknown>>((_resolve, reject) => {
    started.push(signal!)
    signal!.addEventListener('abort', () => reject(new CommandBarError(499, 'TIMEOUT', 'Command cancelled.')))
  }))
  return { decide, started, status: vi.fn() }
}

/** The command bar behind the core's host, in this process: its requests routed with their connection. */
function hosted(commands: Commands) {
  const host = createServiceHost(emptyPorts(), { log: () => {} })
  host.serve('commandBar', (core) => startCommandBar(core, commands), fakeCore(), COMMAND_BAR_REQUESTS)
  const answers: Array<Record<string, unknown>> = []
  const ask = (connection: string | undefined, owner = true) => {
    const answered = new Promise<Record<string, unknown>>((resolve) => {
      host.route('command_bar', { request: REQUEST }, { local: false, owner, ...(connection ? { connection } : {}) }, resolve)
    })
    void answered.then((answer) => { answers.push(answer) })
    return answered
  }
  return { host, ask, answers }
}

describe('the command bar', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('decides for the owner with the answer the socket gave, and refuses anyone else before deciding', async () => {
    const decide = vi.fn(async () => ({ selectedId: 'send:a', autoExecute: false }))
    const { ask } = hosted({ status: vi.fn(), decide })
    expect(await ask('web-1')).toEqual({ selectedId: 'send:a', autoExecute: false })
    expect(decide).toHaveBeenCalledWith(REQUEST, expect.any(AbortSignal))
    expect(await ask('device-1', false)).toEqual({ error: 'OWNER_REQUIRED' })
    expect(decide).toHaveBeenCalledOnce()
  })

  it('takes two at once from a connection and eight in all, and answers BUSY beyond, as the socket did', async () => {
    const commands = waitingDecide()
    const { host, ask, answers } = hosted(commands)
    const mine = [ask('one'), ask('one')]
    expect(await ask('one')).toEqual({ error: 'BUSY' })
    // Requests with no connection (a core from before connections) are each their own.
    const others = [ask('two'), ask('two'), ask(undefined), ask(undefined), ask(undefined), ask('three')]
    expect(await ask('four')).toEqual({ error: 'BUSY' })
    expect(commands.decide).toHaveBeenCalledTimes(8)
    // A connection's slots come back as its decisions end: closed here, so they end at once.
    host.closeConnection('one')
    expect(await Promise.all(mine)).toEqual([{ error: 'TIMEOUT', detail: 'Command cancelled.' }, { error: 'TIMEOUT', detail: 'Command cancelled.' }])
    void ask('one')
    expect(commands.decide).toHaveBeenCalledTimes(9)
    for (const connection of ['one', 'two', 'three']) host.closeConnection(connection)
    await vi.waitFor(() => expect(answers.filter((answer) => answer.error === 'TIMEOUT')).toHaveLength(6))
    // Those with no connection are never closed by another's closing.
    expect(commands.started.filter((signal) => !signal.aborted)).toHaveLength(3)
    void others
  })

  it('aborts a connection\'s decisions when it closes, and no other connection\'s, with the real decision', async () => {
    const calls: AbortSignal[] = []
    // JEV that never answers: only an abort ends the call.
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      calls.push(init!.signal!)
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const commands = new CommandBarService({ fetch: fetch as typeof globalThis.fetch, key: async () => 'fixture-only', timeoutMs: 60_000 })
    const { host, ask } = hosted(commands)
    const gone = ask('gone')
    const stays = ask('stays')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    host.closeConnection('gone')
    expect(await gone).toEqual({ error: 'TIMEOUT', detail: 'Command cancelled.' })
    expect(calls.map((signal) => signal.aborted)).toEqual([true, false])
    host.closeConnection('stays')
    expect(await stays).toEqual({ error: 'TIMEOUT', detail: 'Command cancelled.' })
  })

  it('answers a failure in the command bar\'s own words, and anything else as this machine unable to', async () => {
    const decide = vi.fn()
      .mockRejectedValueOnce(new CommandBarError(503, 'OPENROUTER_REQUIRED', 'Connect OpenRouter.'))
      .mockRejectedValueOnce(new Error('socket hang up'))
    const requests = startCommandBar(fakeCore(), { status: vi.fn(), decide })
    expect(await requests.command_bar({ request: REQUEST }, OWNER)).toEqual({ error: 'OPENROUTER_REQUIRED', detail: 'Connect OpenRouter.' })
    expect(await requests.command_bar({ request: REQUEST }, OWNER)).toEqual({ error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' })
  })

  it('answers the HTTP door with the status and body it answered with, for a process on this computer only', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ configured: true, provider: 'OpenRouter', model: 'typesafe/jev-1.13' })
      .mockRejectedValueOnce(new Error('keychain locked'))
    const decide = vi.fn()
      .mockResolvedValueOnce({ selectedId: null, suggestions: [] })
      .mockRejectedValueOnce(new CommandBarError(429, 'BUSY', 'Too many commands at once. Try again in a moment.'))
    const requests = startCommandBar(fakeCore(), { status, decide })
    const local: Asker = { local: true, owner: true, connection: 'http:1' }
    const closed = new AbortController().signal
    expect(await requests.command_bar_http({ route: 'status' }, local, closed)).toEqual({ status: 200, body: { success: true, data: { configured: true, provider: 'OpenRouter', model: 'typesafe/jev-1.13' } } })
    expect(await requests.command_bar_http({ route: 'resolve', body: REQUEST }, local, closed)).toEqual({ status: 200, body: { success: true, data: { selectedId: null, suggestions: [] } } })
    expect(decide).toHaveBeenCalledWith(REQUEST, closed)
    expect(await requests.command_bar_http({ route: 'resolve', body: REQUEST }, local, closed)).toEqual({ status: 429, body: { success: false, error: { code: 'BUSY', message: 'Too many commands at once. Try again in a moment.' } } })
    expect(await requests.command_bar_http({ route: 'status' }, local, closed)).toEqual({ status: 502, body: { success: false, error: { code: 'UNAVAILABLE', message: 'Command bar unavailable.' } } })
    expect(await requests.command_bar_http({ route: 'status' }, OWNER)).toEqual({ error: 'UNSUPPORTED' })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('decides through OpenRouter, or through a fake JEV on this computer for the end-to-end tests only', async () => {
    expect(commandsFor({})).toBe(commandBarService)
    expect(() => commandsFor({ HARNESS_TEST_JEV_URL: 'https://openrouter.example/decisions' })).toThrow('loopback')
    expect(() => commandsFor({ HARNESS_TEST_JEV_URL: 'http://192.168.1.4:9000/' })).toThrow('loopback')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: {} })))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-only')
    const fake = commandsFor({ HARNESS_TEST_JEV_URL: 'http://127.0.0.1:4100/decisions' })
    await expect(fake.decide({ prompt: 'x', candidates: [{ id: 'a', kind: 'open', title: 'A', detail: '' }] })).rejects.toMatchObject({ code: 'INVALID_DECISION' })
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:4100/decisions')
    // Started with no commands given, it decides through OpenRouter.
    expect(Object.keys(startCommandBar(fakeCore()))).toEqual([...COMMAND_BAR_REQUESTS])
    vi.unstubAllEnvs()
  })
})
