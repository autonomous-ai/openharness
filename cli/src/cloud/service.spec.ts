/**
 * The cloud service against scripted makers: never a real Fo, Devin or Cursor, and a throwaway data folder.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudCore } from '../core/api.js'
import type { CloudHarness } from '../lib/cloudAgents.js'
import type { Bridge } from './bridge.js'
import { repositoryOf } from '../lib/cloudAgents.js'
import { nameFor, startCloudService } from './service.js'
import { CloudError, type CloudAdapter, type CloudUpdate } from './types.js'

const owner = { local: true, owner: true }
let dataDir: string
let clock: number
let timers: Map<number, { fn: () => void; ms: number }>
let nextTimer: number
let doors: { publish: ReturnType<typeof vi.fn>; ask: ReturnType<typeof vi.fn>; unask: ReturnType<typeof vi.fn> }

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cloud-'))
  clock = Date.parse('2026-10-11T10:00:00Z')
  timers = new Map()
  nextTimer = 1
  doors = { publish: vi.fn(), ask: vi.fn(), unask: vi.fn() }
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

/** A maker whose answers the test scripts, one look at a time. */
function maker(over: Partial<CloudAdapter> = {}) {
  const looks: CloudUpdate[] = []
  const adapter: CloudAdapter & { looks: CloudUpdate[] } = {
    id: 'devin-cloud',
    looks,
    start: vi.fn(async () => ({ remote: { id: 'devin-1' }, links: [{ label: 'Session', url: 'https://app.devin.ai/sessions/1' }] })),
    send: vi.fn(async () => {}),
    poll: vi.fn(async () => looks.shift() ?? { messages: [] }),
    stop: vi.fn(async () => {}),
    ...over,
  }
  return adapter
}

const bridge = (connections: unknown[] = []): Bridge => ({
  connections: vi.fn(async () => connections as never),
  mcpUrl: (code) => `http://bridge/${code}/mcp`,
  api: vi.fn(async () => ({ status: 200, json: {} })),
})

function start(adapters: Record<string, CloudAdapter>, given = bridge()) {
  return startCloudService({
    dataDir, core: doors as unknown as CloudCore, bridge: given, adapters: adapters as never,
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimer: (id) => { timers.delete(id as number) },
    log: () => {},
  })
}

/** Runs every timer due now, as many times as it takes, then lets the looks settle. */
async function tick(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const due = [...timers.entries()]
    timers.clear()
    for (const [, timer] of due) timer.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const published = (): CloudHarness[] => doors.publish.mock.calls.at(-1)![0] as CloudHarness[]

describe('names and repositories', () => {
  it('reads a repository from a GitHub address or the pair', () => {
    expect(repositoryOf('https://github.com/acme/api')).toBe('acme/api')
    expect(repositoryOf('https://github.com/acme/api.git')).toBe('acme/api')
    expect(repositoryOf('git@github.com:acme/api.git')).toBe('acme/api')
    expect(repositoryOf('acme/api')).toBe('acme/api')
    expect(repositoryOf('https://gitlab.com/acme/api')).toBeNull()
    expect(repositoryOf(3)).toBeNull()
  })

  it('names a harness by its task\'s first line, short', () => {
    expect(nameFor('\n  fix the flaky login test\nmore', 'devin-cloud')).toBe('fix the flaky login test')
    expect(nameFor('a'.repeat(60), 'fo')).toHaveLength(40)
    expect(nameFor('   ', 'fo')).toBe('Fo')
  })
})

describe('a cloud harness', () => {
  it('starts on its maker, is told to the core, and keeps its conversation', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    const made = await service.port.create({ engine: 'devin-cloud', prompt: 'fix the flaky login test', repositoryUrl: 'https://github.com/acme/api', acuLimit: 3 })
    expect(made.ok).toBe(true)
    expect(devin.start).toHaveBeenCalledWith({ task: 'fix the flaky login test', repository: 'acme/api', options: { acuLimit: 3, model: undefined } })
    const harness = published()[0]
    expect(harness).toMatchObject({ agent: 'devin-cloud', name: 'fix the flaky login test', state: 'working', repository: 'acme/api', messages: 1,
      links: [{ label: 'Session', url: 'https://app.devin.ai/sessions/1' }] })
    expect(made.ok && made.agent).toMatchObject({ id: harness.agentId, location: 'cloud', engine: 'devin-cloud' })
    expect(service.transcript(harness.agentId)).toEqual([{ id: expect.any(String), from: 'person', text: 'fix the flaky login test', at: expect.any(String) }])
    const saved = JSON.parse(readFileSync(join(dataDir, 'cloud', 'harnesses.json'), 'utf8'))
    expect(saved.harnesses[0]).toMatchObject({ remote: { id: 'devin-1' }, harness: { agentId: harness.agentId } })
  })

  it('starts Devin Cloud with no repository, as Devin\'s API allows (#1444)', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    expect(await service.port.create({ engine: 'devin-cloud', prompt: 'reply to the release thread' })).toMatchObject({ ok: true })
    expect(devin.start).toHaveBeenCalledWith({ task: 'reply to the release thread', repository: null, options: { acuLimit: undefined, model: undefined } })
  })

  it('refuses what it cannot start, in words a person reads', async () => {
    const devin = maker({ start: vi.fn(async () => { throw new CloudError('NOT_CONNECTED', 'Add your Devin API key') }) })
    const service = start({ 'devin-cloud': devin, fo: maker({ id: 'fo', start: vi.fn(async () => { throw new Error('boom') }) }) })
    expect(await service.port.create({ engine: 'claude', prompt: 'x' })).toMatchObject({ ok: false, error: 'INVALID_ENGINE' })
    expect(await service.port.create({ engine: 'devin-cloud', prompt: '  ' })).toMatchObject({ ok: false, error: 'INVALID_REQUEST' })
    expect(await service.port.create({ engine: 'cursor-cloud', prompt: 'x' })).toMatchObject({ ok: false, detail: expect.stringContaining('GitHub repository') })
    expect(await service.port.create({ engine: 'devin-cloud', prompt: 'x', repositoryUrl: 'https://gitlab.com/acme/api' })).toMatchObject({ ok: false, error: 'INVALID_REQUEST', detail: expect.stringContaining('not a GitHub repository') })
    expect(devin.start).not.toHaveBeenCalled()
    expect(await service.port.create({ engine: 'devin-cloud', prompt: 'x', repository: 'acme/api' })).toEqual({ ok: false, error: 'NOT_CONNECTED', detail: 'Add your Devin API key' })
    expect(await service.port.create({ engine: 'fo', prompt: 'x' })).toEqual({ ok: false, error: 'CLOUD_FAILED', detail: 'Fo could not be reached. Try again.' })
    expect(doors.publish).not.toHaveBeenCalled()
  })

  it('reads what its maker says, asks the person when it waits, and stops looking once idle', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api', name: 'login fix' })
    const agentId = published()[0].agentId
    expect(published()[0].name).toBe('login fix')
    devin.looks.push(
      { messages: [{ id: 'm1', text: 'Found a race.', at: '2026-10-11T10:01:00Z' }], state: 'working', activity: 'Reading code' },
      { messages: [{ id: 'm1', text: 'Found a race.', at: '2026-10-11T10:01:00Z' }, { id: 'm2', text: 'Which branch?', at: '2026-10-11T10:02:00Z' }], state: 'needs_input', question: { text: 'Which branch?', choices: ['main', 'dev'] } },
    )
    await tick()
    expect(published()[0]).toMatchObject({ state: 'needs_input', activity: 'Reading code', messages: 3 })
    expect(doors.ask).toHaveBeenCalledWith(agentId, expect.stringMatching(/^cloud_q_/), { text: 'Which branch?', choices: ['main', 'dev'] })
    const requestId = doors.ask.mock.calls[0][1] as string
    // A waiting harness is looked at less often.
    expect([...timers.values()].at(-1)?.ms).toBe(30_000)

    expect(await service.port.answer(agentId, 'cloud_q_stale', { answer: 'main' })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(await service.port.answer(agentId, requestId, { answer: 'main' })).toEqual({ ok: true })
    expect(devin.send).toHaveBeenCalledWith({ id: 'devin-1' }, 'main')
    expect(doors.unask).toHaveBeenCalledWith(agentId, requestId)
    expect(published()[0]).toMatchObject({ state: 'working', messages: 4 })

    devin.looks.push({ messages: [{ id: 'm3', text: 'Opened #42.', at: '2026-10-11T10:05:00Z' }], state: 'idle', links: [{ label: 'Pull request #42', url: 'https://github.com/acme/api/pull/42' }], branch: 'devin/fix' })
    await tick()
    expect(published()[0]).toMatchObject({ state: 'idle', branch: 'devin/fix', links: [{ label: 'Pull request #42', url: 'https://github.com/acme/api/pull/42' }] })
    expect(timers.size).toBe(0)
    expect(service.transcript(agentId).map((message) => [message.from, message.text])).toEqual([
      ['person', 'fix it'], ['agent', 'Found a race.'], ['agent', 'Which branch?'], ['person', 'main'], ['agent', 'Opened #42.'],
    ])
  })

  it('says why it cannot reach its maker and looks again later', async () => {
    const devin = maker({ poll: vi.fn(async () => { throw new CloudError('RATE_LIMITED', 'Devin Cloud is busy.') }) })
    const fo = maker({ id: 'fo', poll: vi.fn(async () => { throw new Error('socket') }) })
    const service = start({ 'devin-cloud': devin, fo })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    await tick()
    expect(published()[0].activity).toBe('Devin Cloud is busy.')
    expect([...timers.values()][0].ms).toBeGreaterThan(10_000)
    await service.port.create({ engine: 'fo', prompt: 'book a haircut' })
    await tick()
    expect(published().find((harness) => harness.agent === 'fo')!.activity).toBe('Fo could not be reached.')
  })

  it('takes words and refuses them when its maker does', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    const agentId = published()[0].agentId
    expect(await service.port.deliver('cloud_none', 'hi')).toMatchObject({ ok: false, error: 'UNKNOWN_AGENT' })
    expect(await service.port.deliver(agentId, '  ')).toMatchObject({ ok: false, error: 'INVALID_REQUEST' })
    devin.send = vi.fn(async () => ({ run: 'run-2' }))
    expect(await service.requests.cloud_send!({ agentId, text: 'also the tests' }, owner)).toEqual({ ok: true })
    devin.send = vi.fn(async () => { throw new CloudError('BUSY', 'Devin Cloud is still working.') })
    expect(await service.requests.cloud_send!({ agentId, text: 'more' }, owner)).toEqual({ error: 'BUSY', detail: 'Devin Cloud is still working.' })
    expect(await service.requests.cloud_send!({ agentId, text: 'more' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    const saved = JSON.parse(readFileSync(join(dataDir, 'cloud', 'harnesses.json'), 'utf8'))
    expect(saved.harnesses[0].remote).toEqual({ id: 'devin-1', run: 'run-2' })
  })

  it('stops it where its maker can, and says so where it cannot', async () => {
    const devin = maker()
    const fo = maker({ id: 'fo', stop: undefined })
    const service = start({ 'devin-cloud': devin, fo })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    await service.port.create({ engine: 'fo', prompt: 'book a haircut' })
    const [devinId, foId] = published().map((harness) => harness.agentId)
    expect(await service.port.stopHarness(devinId)).toEqual({ ok: true })
    expect(devin.stop).toHaveBeenCalledWith({ id: 'devin-1' })
    expect(await service.port.stopHarness(foId)).toEqual({ ok: true, detail: 'Fo keeps working on its own.' })
    expect(published().map((harness) => [harness.state, harness.activity])).toEqual([['stopped', null], ['stopped', 'Fo keeps working on its own.']])
    expect(await service.port.stopHarness('cloud_none')).toMatchObject({ ok: false, error: 'UNKNOWN_AGENT' })
    devin.stop = vi.fn(async () => { throw new CloudError('CLOUD_FAILED', 'Devin Cloud answered 500.') })
    expect(await service.port.stopHarness(devinId)).toEqual({ ok: false, error: 'CLOUD_FAILED', detail: 'Devin Cloud answered 500.' })
  })

  it('renames one in Harness alone, and keeps the name', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    const [{ agentId, updatedAt }] = published()
    expect(await service.port.rename(agentId, '  Login flake  ')).toEqual({ ok: true })
    expect(published()[0]).toMatchObject({ name: 'Login flake', updatedAt })
    expect(JSON.parse(readFileSync(join(dataDir, 'cloud', 'harnesses.json'), 'utf8')).harnesses[0].harness.name).toBe('Login flake')
    expect(await service.port.rename(agentId, ' ')).toMatchObject({ ok: false, error: 'MISSING_NAME' })
    expect(await service.port.rename('cloud_none', 'x')).toMatchObject({ ok: false, error: 'UNKNOWN_AGENT' })
  })

  it('keeps what it said last for the dial, and finds it in the conversation of a harness saved before it did', async () => {
    const devin = maker()
    const first = start({ 'devin-cloud': devin })
    await first.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    expect(published()[0].said).toBeUndefined()
    devin.looks.push({ messages: [{ id: 'm1', text: 'Opened #42.', at: 'x' }], state: 'idle' })
    await tick()
    expect(published()[0].said).toBe('Opened #42.')
    first.stop()
    const file = join(dataDir, 'cloud', 'harnesses.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    delete saved.harnesses[0].harness.said
    writeFileSync(file, JSON.stringify(saved))
    start({ 'devin-cloud': devin }).republish()
    expect(published()[0].said).toBe('Opened #42.')
    // Nothing said at all: nothing to find.
    saved.harnesses[0].harness.said = null
    writeFileSync(file, JSON.stringify(saved))
    rmSync(join(dataDir, 'cloud', `${saved.harnesses[0].harness.agentId}.jsonl`))
    start({ 'devin-cloud': devin }).republish()
    expect(published()[0].said).toBeNull()
  })

  it('is watched again after a restart, and tells a reconnected core everything again', async () => {
    const devin = maker()
    const first = start({ 'devin-cloud': devin })
    await first.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    devin.looks.push({ messages: [], state: 'needs_input', question: { text: 'Which branch?', choices: [] } })
    await tick()
    first.stop()
    expect(timers.size).toBe(0)
    // Nothing more is told once stopped.
    const told = doors.publish.mock.calls.length
    first.republish()
    expect(doors.publish.mock.calls.length).toBe(told)

    doors.publish.mockClear()
    doors.ask.mockClear()
    // Still waiting and nothing new said: what it asks is what it last said, asked once.
    devin.looks.push({ messages: [], state: 'needs_input' }, { messages: [], state: 'needs_input' })
    const second = start({ 'devin-cloud': devin })
    expect([...timers.values()][0].ms).toBe(1_000)
    await tick()
    expect(doors.ask).toHaveBeenCalledTimes(1)
    expect(doors.ask.mock.calls[0][2]).toEqual({ text: 'Devin Cloud is waiting for you.', choices: [] })
    second.republish()
    expect(doors.publish).toHaveBeenCalled()
    expect(doors.ask).toHaveBeenCalledTimes(2)
    second.stop()
  })

  it('reads a saved file that is broken or half-written as nothing it cannot use', () => {
    mkdirSync(join(dataDir, 'cloud'), { recursive: true })
    writeFileSync(join(dataDir, 'cloud', 'harnesses.json'), JSON.stringify({ harnesses: [null, { harness: { agentId: 'cloud_x', agent: 'nope' }, remote: { id: 'r' } }, { harness: { agentId: 'cloud_y', agent: 'fo', state: 'idle' }, remote: {} }] }))
    writeFileSync(join(dataDir, 'cloud', 'cloud_x.jsonl'), 'not json\n{"id":"a","from":"agent","text":"hi","at":"x"}\n')
    const service = start({})
    expect(timers.size).toBe(0)
    service.republish()
    expect(published()).toEqual([])
    expect(service.transcript('cloud_x')).toEqual([{ id: 'a', from: 'agent', text: 'hi', at: 'x' }])
  })

  it('asks what it last said when it waits with nothing new and nothing asked', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    devin.looks.push({ messages: [{ id: 'm1', text: 'Shall I also update the docs?', at: 'x' }], state: 'working' }, { messages: [], state: 'needs_input' })
    await tick()
    clock += 1
    for (const [, timer] of timers) timer.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(doors.ask.mock.calls.at(-1)![2]).toEqual({ text: 'Shall I also update the docs?', choices: [] })
    service.stop()
  })

  it('keeps the maker\'s status beside its own, and drops it when the person writes or stops', async () => {
    const devin = maker({ start: vi.fn(async () => ({ remote: { id: 'devin-1' }, links: [], update: { messages: [], state: 'starting' as const, providerStatus: { status: 'new', detail: null } } })) })
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    const agentId = published()[0].agentId
    const file = join(dataDir, 'cloud', 'harnesses.json')
    expect(published()[0].providerStatus).toEqual({ status: 'new', detail: null })
    expect(JSON.parse(readFileSync(file, 'utf8')).harnesses[0].harness.providerStatus).toEqual({ status: 'new', detail: null })
    // No new messages: the status still moves, and a detail that went away does not stay.
    devin.looks.push({ messages: [], providerStatus: { status: 'running', detail: 'working' } })
    devin.looks.push({ messages: [], providerStatus: { status: 'running', detail: null } })
    await tick()
    expect(published()[0]).toMatchObject({ state: 'starting', providerStatus: { status: 'running', detail: null } })
    devin.looks.push({ messages: [{ id: 'm1', text: 'Done.', at: 'x' }], state: 'idle', providerStatus: { status: 'running', detail: 'finished' } })
    await tick()
    expect(published()[0]).toMatchObject({ state: 'idle', providerStatus: { status: 'running', detail: 'finished' } })
    service.stop()
    doors.publish.mockClear()
    const again = start({ 'devin-cloud': devin })
    again.republish()
    expect(published()[0].providerStatus).toEqual({ status: 'running', detail: 'finished' })
    // A harness saved before this field existed is still a harness.
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    delete saved.harnesses[0].harness.providerStatus
    writeFileSync(file, JSON.stringify(saved))
    again.stop()
    const restarted = start({ 'devin-cloud': devin })
    restarted.republish()
    expect(published()[0].providerStatus).toBeUndefined()
    expect(published()[0]).toMatchObject({ agentId, state: 'idle' })
    devin.looks.push({ messages: [], state: 'working', providerStatus: { status: 'running', detail: 'working' } })
    expect(await restarted.port.deliver(agentId, 'go on')).toEqual({ ok: true })
    await tick()
    expect(published()[0].providerStatus).toEqual({ status: 'running', detail: 'working' })
    doors.ask.mockClear()
    expect(await restarted.port.deliver(agentId, 'and more')).toEqual({ ok: true })
    expect(published()[0].providerStatus).toBeUndefined()
    // The wait just answered is not asked again. The status on that look still replaces the one the send cleared.
    devin.looks.push({ messages: [], state: 'needs_input', question: { text: 'Which branch?', choices: [] }, providerStatus: { status: 'running', detail: 'waiting_for_user' } })
    await tick()
    expect(doors.ask).not.toHaveBeenCalled()
    expect(published()[0]).toMatchObject({ state: 'working', providerStatus: { status: 'running', detail: 'waiting_for_user' } })
    devin.looks.push({ messages: [{ id: 'm2', text: 'I drafted a plan.', at: 'x' }], state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' } })
    await tick()
    expect(published()[0]).toMatchObject({ state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' } })
    expect(restarted.transcript(agentId).some((message) => message.text === 'I drafted a plan.')).toBe(true)
    await restarted.port.stopHarness(agentId)
    expect(published()[0]).toMatchObject({ state: 'stopped' })
    expect(published()[0].providerStatus).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8')).harnesses[0].harness.providerStatus).toBeUndefined()
    restarted.stop()
  })

  it('stops looking at one unchanged for a day', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    clock += 25 * 60 * 60_000
    await tick()
    expect(devin.poll).not.toHaveBeenCalled()
    expect(timers.size).toBe(0)
    service.stop()
  })

  it('looks again at once when its maker waited for news itself (Fo)', async () => {
    const fo = maker({ id: 'fo', start: vi.fn(async () => ({ remote: { id: 'c1', run: '{}' }, links: [], update: { messages: [], state: 'working' as const, waited: true } })) })
    const service = start({ fo })
    await service.port.create({ engine: 'fo', prompt: 'book a haircut' })
    expect([...timers.values()][0].ms).toBe(0)
    fo.looks.push({ messages: [], state: 'working', waited: true })
    await tick()
    expect(fo.poll).toHaveBeenCalled()
    service.stop()
  })
})

describe('what the review found', () => {
  it('cuts a long wait short when the person writes, rather than queueing their words behind it', async () => {
    let aborted = false
    const fo = maker({ id: 'fo', poll: vi.fn((_remote, signal?: AbortSignal) => new Promise<CloudUpdate>((resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    })) })
    const service = start({ fo })
    await service.port.create({ engine: 'fo', prompt: 'book a haircut' })
    const agentId = published()[0].agentId
    for (const [, timer] of timers) timer.fn()
    timers.clear()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await service.port.deliver(agentId, 'make it 10')).toEqual({ ok: true })
    expect(aborted).toBe(true)
    // Cut short is not a failure: nothing says it could not be reached.
    expect(published()[0].activity).toBeNull()
    service.stop()
  })

  it('is working from the moment the words go, and back where it was when they are refused', async () => {
    let release: () => void = () => {}
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    devin.looks.push({ messages: [{ id: 'm1', text: 'Done.', at: 'x' }], state: 'idle', activity: null, providerStatus: { status: 'running', detail: 'finished' } })
    await tick()
    const agentId = published()[0].agentId
    expect(published()[0].state).toBe('idle')
    // Fo answers its `ask_fo` with its whole reply: the person sees it working all that time.
    devin.send = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const sent = service.port.deliver(agentId, 'and the docs')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(published()[0]).toMatchObject({ state: 'working', activity: null })
    expect(published()[0].providerStatus).toBeUndefined()
    release()
    expect(await sent).toEqual({ ok: true })
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([2_000])
    devin.looks.push({ messages: [{ id: 'm2', text: 'Docs too.', at: 'x' }], state: 'idle', activity: 'Finished', providerStatus: { status: 'running', detail: 'finished' } })
    await tick()
    devin.send = vi.fn(async () => { throw new CloudError('BUSY', 'Devin Cloud is still working.') })
    expect(await service.port.deliver(agentId, 'more')).toMatchObject({ ok: false, error: 'BUSY' })
    expect(published()[0]).toMatchObject({ state: 'idle', activity: 'Finished', providerStatus: { status: 'running', detail: 'finished' } })
    // Not saved while it was only told.
    expect(JSON.parse(readFileSync(join(dataDir, 'cloud', 'harnesses.json'), 'utf8')).harnesses[0].harness.state).toBe('idle')
    service.stop()
  })

  it('reads a reply that came with the words at once, not after the wait', async () => {
    let ready = true
    const fo = maker({ id: 'fo', answered: () => ready })
    const service = start({ fo })
    await service.port.create({ engine: 'fo', prompt: 'weather in New York?' })
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([0])
    fo.looks.push({ messages: [{ id: 'f1', text: 'Rain, 15°C.', at: 'x' }], state: 'idle' })
    await tick()
    expect(await service.port.deliver(published()[0].agentId, 'and tomorrow?')).toEqual({ ok: true })
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([0])
    ready = false
    expect(await service.port.deliver(published()[0].agentId, 'and Sunday?')).toEqual({ ok: true })
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([2_000])
    service.stop()
  })

  it('never looks again at once at a maker that answered at once', async () => {
    const fo = maker({ id: 'fo' })
    const service = start({ fo })
    await service.port.create({ engine: 'fo', prompt: 'book a haircut' })
    fo.looks.push({ messages: [], state: 'working', waited: true })
    const due = [...timers.values()]
    timers.clear()
    for (const timer of due) timer.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([5_000])
    service.stop()
  })

  it('takes a question\'s answer once, and asks it again when the maker did not take it', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    const agentId = published()[0].agentId
    devin.looks.push({ messages: [{ id: 'm1', text: 'Which branch?', at: 'x' }], state: 'needs_input', question: { text: 'Which branch?', choices: ['main'] } })
    await tick()
    const requestId = doors.ask.mock.calls[0][1] as string
    const [first, second] = await Promise.all([service.port.answer(agentId, requestId, { answer: 'main' }), service.port.answer(agentId, requestId, { answer: 'main' })])
    expect([first.ok, second.ok]).toEqual([true, false])
    expect(devin.send).toHaveBeenCalledTimes(1)
    // Refused by the maker: the question stands again, under a new id.
    devin.looks.push({ messages: [{ id: 'm2', text: 'And the tests?', at: 'x' }], state: 'needs_input', question: { text: 'And the tests?', choices: [] } })
    await tick()
    const again = doors.ask.mock.calls.at(-1)![1] as string
    devin.send = vi.fn(async () => { throw new CloudError('BUSY', 'Devin Cloud is still working.') })
    expect(await service.port.answer(agentId, again, { answer: 'yes' })).toMatchObject({ ok: false, error: 'BUSY' })
    expect(doors.ask.mock.calls.at(-1)![2]).toEqual({ text: 'And the tests?', choices: [] })
    service.stop()
  })

  it('does not ask again the wait the person just answered', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    const agentId = published()[0].agentId
    devin.looks.push({ messages: [{ id: 'm1', text: 'Which branch?', at: 'x' }], state: 'needs_input', question: { text: 'Which branch?', choices: [] } })
    await tick()
    await service.port.answer(agentId, doors.ask.mock.calls[0][1] as string, { answer: 'main' })
    doors.ask.mockClear()
    // Devin has not caught up: still "waiting for you", nothing new said.
    devin.looks.push({ messages: [], state: 'needs_input' })
    await tick()
    expect(doors.ask).not.toHaveBeenCalled()
    expect(published()[0].state).toBe('working')
    service.stop()
  })

  it('makes one harness for one New Harness, however often the window asks', async () => {
    let release!: () => void
    const devin = maker({ start: vi.fn(() => new Promise((resolve) => { release = () => resolve({ remote: { id: 'd1' }, links: [] }) })) as never })
    const service = start({ 'devin-cloud': devin })
    const request = { engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api', creationId: 'c-1' }
    const first = service.port.create(request)
    const retried = service.port.create(request)
    release()
    const [a, b] = await Promise.all([first, retried])
    expect(devin.start).toHaveBeenCalledTimes(1)
    expect(a.ok && b.ok && a.agent.id === b.agent.id).toBe(true)
    const later = await service.port.create(request)
    expect(later.ok && a.ok && later.agent.id === a.agent.id).toBe(true)
    expect(published()).toHaveLength(1)
    service.stop()
  })
})

describe('what the apps ask', () => {
  it('reads a harness\'s conversation, from where the pane has read to', async () => {
    const devin = maker()
    const service = start({ 'devin-cloud': devin })
    await service.port.create({ engine: 'devin-cloud', prompt: 'fix it', repository: 'acme/api' })
    const agentId = published()[0].agentId
    devin.looks.push({ messages: [{ id: 'm1', text: 'On it.', at: 'x' }], state: 'working' })
    await tick()
    expect(await service.requests.cloud_transcript!({ agentId }, owner)).toMatchObject({ total: 2, messages: [{ from: 'person' }, { from: 'agent', text: 'On it.' }] })
    expect(await service.requests.cloud_transcript!({ agentId, after: 1 }, owner)).toMatchObject({ total: 2, messages: [{ text: 'On it.' }] })
    expect(await service.requests.cloud_transcript!({ agentId: 'cloud_none' }, owner)).toEqual({ error: 'UNKNOWN_AGENT' })
    expect(await service.requests.cloud_transcript!({ agentId }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    service.stop()
  })

  it('says which cloud agents are connected here, and how to connect the others', async () => {
    const service = start({}, bridge([{ code: 'fo', name: 'Fo', mcp: 'https://mcp.api.wajo.ai/fo', api: null, state: 'connected' }]))
    const answer = await service.requests.cloud_agents!({}, owner) as { agents: Array<Record<string, unknown>> }
    expect(answer.agents).toEqual([
      { id: 'fo', name: 'Fo', place: "Fo's cloud", kind: 'personal', connected: true },
      { id: 'devin-cloud', name: 'Devin Cloud', place: "Devin's cloud", kind: 'coding', connected: false, connect: expect.stringContaining('add-key Devin') },
      { id: 'cursor-cloud', name: 'Cursor Cloud', place: "Cursor's cloud", kind: 'coding', connected: false, connect: expect.stringContaining('add-key Cursor') },
    ])
    expect(await service.requests.cloud_agents!({}, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
  })
})
