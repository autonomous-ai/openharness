import { describe, expect, it, vi } from 'vitest'
import { CLOUD_DOWN, type CloudPort } from '../api.js'
import type { CloudHarness } from '../../lib/cloudAgents.js'
import { createCloudAgents } from './cloud.js'

const harness = (over: Partial<CloudHarness> = {}): CloudHarness => ({
  agentId: 'cloud_1', agent: 'devin-cloud', name: 'fix it', state: 'working', activity: null, repository: 'acme/api', branch: null,
  links: [], messages: 1, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z', ...over,
})

function setup(port: CloudPort | null = null) {
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }
  const openQuestions = new Map<string, Record<string, unknown>>()
  const deviceInput = { setUserAction: vi.fn() }
  const cloud = createCloudAgents({ port: () => port, clients, openQuestions, deviceInput, log: () => {} })
  return { cloud, clients, openQuestions, deviceInput }
}

const port = (): CloudPort & { [K in keyof CloudPort]: ReturnType<typeof vi.fn> } => ({
  create: vi.fn(async () => ({ ok: true as const, agent: { id: 'cloud_2' } })),
  deliver: vi.fn(async () => ({ ok: true as const })),
  answer: vi.fn(async () => ({ ok: true as const })),
  rename: vi.fn(async () => ({ ok: true as const })),
  stopHarness: vi.fn(async () => ({ ok: true as const, detail: 'Fo keeps working on its own.' })),
})

describe('agents a service owns', () => {
  it('lists what the service publishes and tells every client what changed', () => {
    const { cloud, clients } = setup()
    cloud.doors.publish([harness(), { agentId: 'not-cloud' }, null] as never)
    expect(cloud.owns('cloud_1')).toBe(true)
    expect(cloud.frames()).toMatchObject([{ id: 'cloud_1', location: 'cloud', engine: 'devin-cloud', terminal: { available: false } }])
    expect(clients.send).toHaveBeenCalledWith({ type: 'agent_synced', payload: { agent: expect.objectContaining({ id: 'cloud_1' }) } })
    expect(clients.sendCommander).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_synced' }))
    // The same list again changes nothing, and is told to nobody.
    clients.send.mockClear()
    cloud.doors.publish([harness()])
    expect(clients.send).not.toHaveBeenCalled()
    // A stopped one leaves the dial's wheel; a gone one leaves every list.
    cloud.doors.publish([harness({ state: 'stopped' })])
    expect(clients.sendCommander).toHaveBeenLastCalledWith({ type: 'agent_deleted', payload: { agentId: 'cloud_1' } })
    // On the dial's wheel while it runs, and what it is doing for its working card.
    cloud.doors.publish([harness({ activity: 'Reading code' }), harness({ agentId: 'cloud_2', state: 'stopped' })])
    expect(cloud.dialRows()).toEqual([expect.objectContaining({ agentId: 'cloud_1', engine: 'devin-cloud', displayName: 'fix it', tmuxPane: '', transcriptPath: null,
      registeredAt: Date.parse('2026-10-11T10:00:00.000Z') })])
    expect(cloud.activity('cloud_1')).toBe('Reading code')
    expect(cloud.activity('cloud_2')).toBeNull()
    expect(cloud.activity('cloud_9')).toBeNull()
    cloud.doors.publish('nonsense' as never)
    expect(clients.send).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: 'cloud_1' } })
    expect(cloud.owns('cloud_1')).toBe(false)
  })

  it('makes the dial\'s turn cards from what changes: working, then what it said, as a terminal agent\'s turn', () => {
    const { cloud, clients } = setup()
    const cards = () => clients.sendCommander.mock.calls.map(([frame]) => frame).filter((frame) => frame.type === 'commander_event')
    // New and working: the tile is told, since it is idle until it is.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip', said: null })])
    expect(cards()).toEqual([{ type: 'commander_event', agentId: 'cloud_1', dbSessionId: 'cloud_1', payload: { kind: 'processing', text: 'Working…' } }])
    expect(cloud.liveCards()).toEqual(cards())
    // Still working, now saying what: no second start.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip', activity: 'Calling Hair Lab' })])
    expect(cards()).toHaveLength(1)
    expect(cloud.liveCards()).toEqual([{ type: 'commander_event', agentId: 'cloud_1', dbSessionId: 'cloud_1', payload: { kind: 'processing', text: 'Calling Hair Lab' } }])
    // Its reply ends the turn: the recap and the text under it, named, and ringing.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip', state: 'idle', said: '## Booked\n\nBooked for **9:30** at Hair Lab. See you Saturday.', messages: 3 })])
    expect(cards().at(-1)).toEqual({ type: 'commander_event', agentId: 'cloud_1', dbSessionId: 'cloud_1', name: 'trip',
      payload: { kind: 'summary', recap: 'Booked for 9:30 at Hair Lab. See you Saturday.', text: 'Booked Booked for 9:30 at Hair Lab. See you Saturday.', notification: { id: 'cloud_1:3', kind: 'done' } } })
    expect(cloud.recent('cloud_1')).toEqual([{ kind: 'summary', recap: 'Booked for 9:30 at Hair Lab. See you Saturday.', text: 'Booked Booked for 9:30 at Hair Lab. See you Saturday.', fullText: '## Booked\n\nBooked for **9:30** at Hair Lab. See you Saturday.' }])
    expect(cloud.said('cloud_1')).toBe('## Booked\n\nBooked for **9:30** at Hair Lab. See you Saturday.')
    expect(cloud.liveCards()).toEqual([])
    // The same words again (a name changed) are not told twice.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'idle', said: '## Booked\n\nBooked for **9:30** at Hair Lab. See you Saturday.', messages: 3 })])
    expect(cards()).toHaveLength(2)
    // Waiting on the person: its question rings, not its words.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'working', said: '## Booked\n\nBooked for **9:30** at Hair Lab. See you Saturday.' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'needs_input', said: 'Which one?\n1) 9:30\n2) 11:00', messages: 5 })])
    expect(cards().at(-1)).toMatchObject({ payload: { kind: 'summary', notification: null } })
    // A turn that ends with nothing said is done; one that failed says why.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'working', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'idle', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    expect(cards().at(-1)).toMatchObject({ payload: { kind: 'done', text: 'done' } })
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'starting', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'failed', activity: 'Fo answered 500.', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    expect(cards().at(-1)).toMatchObject({ payload: { kind: 'error', text: 'Fo answered 500.' } })
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'working', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'failed', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    expect(cards().at(-1)).toMatchObject({ payload: { kind: 'error', text: 'It stopped with an error.' } })
    // Failing with something new said: the summary carries `failed`, so the tier is an alert.
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'working', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'failed', said: 'Running migrations…', messages: 9 })])
    expect(cards().at(-1)).toMatchObject({ payload: { kind: 'summary', failed: true } })
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'working', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'trip!', state: 'failed', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    // Idle and changed, with nothing new said: nothing to tell.
    const before = cards().length
    cloud.doors.publish([harness({ agent: 'fo', name: 'renamed', state: 'failed', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    // Stopped: it leaves the wheel, and no card follows it.
    cloud.doors.publish([harness({ agent: 'fo', name: 'renamed', state: 'working', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    cloud.doors.publish([harness({ agent: 'fo', name: 'renamed', state: 'stopped', said: 'Which one?\n1) 9:30\n2) 11:00' })])
    expect(cards()).toHaveLength(before + 1)
    expect(clients.sendCommander).toHaveBeenLastCalledWith({ type: 'agent_deleted', payload: { agentId: 'cloud_1' } })
    // A list told again whole (a restart) is not news; nor is a harness first seen idle.
    const { cloud: again, clients: fresh } = setup()
    again.doors.publish([harness({ state: 'idle', said: 'Opened #42.' })])
    again.doors.publish([harness({ state: 'idle', said: 'Opened #42.', name: 'x' })])
    expect(fresh.sendCommander.mock.calls.filter(([frame]) => frame.type === 'commander_event')).toEqual([])
    expect(again.recent('cloud_1')).toEqual([expect.objectContaining({ recap: 'Opened #42.' })])
    // Nothing said yet; not one at all.
    again.doors.publish([harness({ said: null })])
    expect(again.recent('cloud_1')).toEqual([])
    expect(again.said('cloud_1')).toBeUndefined()
    expect(again.recent('a1')).toBeNull()
    expect(again.said('a1')).toBeUndefined()
  })

  it('shows its questions where questions show, and closes them', () => {
    const { cloud, clients, openQuestions, deviceInput } = setup()
    cloud.doors.publish([harness()])
    cloud.doors.ask('cloud_none', 'cloud_q_1', { text: 'Which?', choices: [] })
    cloud.doors.ask('cloud_1', 'q_1', { text: 'Which?', choices: [] })
    expect(clients.sendLocal).not.toHaveBeenCalled()
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which branch?', choices: ['main', '', 3, 'dev'] as never })
    const asked = { type: 'commander_question', agentId: 'cloud_1', dbSessionId: 'cloud_1',
      payload: { requestId: 'cloud_q_1', questions: [{ key: 'answer', q: 'Which branch?', options: ['main', 'dev'], multi: false, canText: true }], notification: { id: 'cloud_q_1', kind: 'needsYou' } } }
    expect(clients.sendLocal).toHaveBeenCalledWith(asked)
    expect(clients.sendCommander).toHaveBeenCalledWith(asked)
    expect(openQuestions.get('cloud_1')).toEqual(asked)
    expect(deviceInput.setUserAction).toHaveBeenCalledWith('cloud_1', true)
    // One with no choices is the windows' alone: the dial's question screen takes no words.
    clients.sendCommander.mockClear()
    cloud.doors.ask('cloud_1', 'cloud_q_2', { text: 'Sure?', choices: 'x' as never })
    expect(clients.sendLocal).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ questions: [expect.objectContaining({ options: [] })] }) }))
    expect(clients.sendCommander).not.toHaveBeenCalled()
    cloud.doors.unask('cloud_1', 'cloud_q_2')
    expect(clients.sendCommander).not.toHaveBeenCalled()
    expect(clients.sendLocal).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'commander_question_close', payload: { requestId: 'cloud_q_2' } }))
    cloud.doors.unask('cloud_1', 'cloud_q_9')
    cloud.doors.unask('cloud_1', 'cloud_q_1')
    expect(clients.sendLocal).toHaveBeenLastCalledWith({ type: 'commander_question_close', agentId: 'cloud_1', dbSessionId: 'cloud_1', payload: { requestId: 'cloud_q_1' } })
    expect(openQuestions.has('cloud_1')).toBe(false)
    expect(deviceInput.setUserAction).toHaveBeenLastCalledWith('cloud_1', false)
  })

  it('hands New Harness, words, an answer and Stop for its agents to the service, and nothing else', async () => {
    const service = port()
    const { cloud } = setup(service)
    cloud.doors.publish([harness()])
    expect(cloud.create({ engine: 'claude' })).toBeNull()
    expect(await cloud.create({ engine: 'fo', prompt: 'x' })).toEqual({ agent: { id: 'cloud_2' } })
    service.create.mockResolvedValueOnce({ ok: false, error: 'NOT_CONNECTED', detail: 'Connect Fo' })
    expect(await cloud.create({ engine: 'fo' })).toEqual({ error: 'NOT_CONNECTED', detail: 'Connect Fo' })
    service.create.mockResolvedValueOnce({ ok: false, error: 'X' })
    expect(await cloud.create({ engine: 'fo' })).toEqual({ error: 'X' })

    expect(cloud.deliver('a1', 'hi')).toBeNull()
    expect(await cloud.deliver('cloud_1', 'hi')).toEqual({ ok: true })
    expect(service.deliver).toHaveBeenCalledWith('cloud_1', 'hi')

    expect(cloud.answer({ requestId: 'q_pane' })).toBeNull()
    expect(cloud.answer({})).toBeNull()
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    expect(await cloud.answer({ requestId: 'cloud_q_1', answers: { answer: 'main', other: 3 } })).toEqual({ ok: true })
    expect(service.answer).toHaveBeenCalledWith('cloud_1', 'cloud_q_1', { answer: 'main' })
    service.answer.mockResolvedValueOnce({ ok: false, error: 'STALE_QUESTION', detail: 'gone' }).mockResolvedValueOnce({ ok: false, error: 'BUSY' })
    expect(await cloud.answer({ requestId: 'cloud_q_1', answers: 'x' })).toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'gone' })
    expect(await cloud.answer({ requestId: 'cloud_q_1' })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: '' })

    expect(cloud.stop('a1')).toBeNull()
    expect(await cloud.stop('cloud_1')).toEqual({ deleted: true, detail: 'Fo keeps working on its own.' })
    service.stopHarness.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'CLOUD_FAILED', detail: 'down' }).mockResolvedValueOnce({ ok: false, error: 'X' })
    expect(await cloud.stop('cloud_1')).toEqual({ deleted: true })
    expect(await cloud.stop('cloud_1')).toEqual({ error: 'CLOUD_FAILED', detail: 'down' })
    expect(await cloud.stop('cloud_1')).toEqual({ error: 'X' })
  })

  it('renames one through the service, tells every window and the dial, and answers an open with its frame', async () => {
    const service = port()
    const { cloud, clients } = setup(service)
    cloud.doors.publish([harness({ agent: 'fo', name: 'hi' })])
    clients.send.mockClear()
    clients.sendCommander.mockClear()
    expect(cloud.update({ agentId: 'a1', name: 'x' })).toBeNull()
    expect(cloud.update({})).toBeNull()
    expect(await cloud.update({ agentId: 'cloud_1', name: '  Trip planning  ' })).toEqual({ agent: expect.objectContaining({ id: 'cloud_1', name: 'Trip planning' }) })
    expect(service.rename).toHaveBeenCalledWith('cloud_1', 'Trip planning')
    const renamed = { type: 'agent_renamed', payload: { agentId: 'cloud_1', name: 'Trip planning', engine: 'fo' } }
    expect(clients.send).toHaveBeenCalledWith(renamed)
    expect(clients.sendCommander).toHaveBeenCalledWith(renamed)
    expect(await cloud.update({ agentId: 'cloud_1', name: ' ' })).toEqual({ error: 'MISSING_NAME' })
    expect(await cloud.update({ agentId: 'cloud_1', name: 3 })).toEqual({ error: 'MISSING_NAME' })
    service.rename.mockResolvedValueOnce({ ok: false, error: 'UNKNOWN_AGENT', detail: 'gone' }).mockResolvedValueOnce({ ok: false, error: 'X' })
    expect(await cloud.update({ agentId: 'cloud_1', name: 'y' })).toEqual({ error: 'UNKNOWN_AGENT', detail: 'gone' })
    expect(await cloud.update({ agentId: 'cloud_1', name: 'y' })).toEqual({ error: 'X' })
    // An app opening it: its frame as it stands, nothing told.
    clients.send.mockClear()
    expect(await cloud.update({ agentId: 'cloud_1', opened: true })).toEqual({ agent: expect.objectContaining({ id: 'cloud_1', name: 'hi' }) })
    expect(await cloud.update({ agentId: 'cloud_1' })).toEqual({ error: 'MISSING_UPDATE' })
    expect(clients.send).not.toHaveBeenCalled()
  })

  it('says "stopping" when the maker is slow to stop, so the connection waits on no vendor', async () => {
    const service = port()
    service.stopHarness.mockImplementation(() => new Promise(() => {}))
    const { cloud } = setup(service)
    cloud.doors.publish([harness()])
    expect(await cloud.stop('cloud_1', 5)).toEqual({ deleted: true, detail: 'Stopping. Its pane says when it has.' })
  })

  it('refuses with a reason while the service is off', async () => {
    const { cloud } = setup(null)
    cloud.doors.publish([harness()])
    expect(await cloud.create({ engine: 'devin-cloud' })).toEqual({ error: 'SERVICE_UNAVAILABLE', detail: CLOUD_DOWN.detail })
    expect(await cloud.deliver('cloud_1', 'x')).toEqual(CLOUD_DOWN)
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    expect(await cloud.answer({ requestId: 'cloud_q_1' })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: CLOUD_DOWN.detail })
    expect(await cloud.stop('cloud_1')).toEqual({ error: 'SERVICE_UNAVAILABLE', detail: CLOUD_DOWN.detail })
    expect(await cloud.update({ agentId: 'cloud_1', name: 'x' })).toEqual({ error: 'SERVICE_UNAVAILABLE', detail: CLOUD_DOWN.detail })
  })

  it('logs a question by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const cloud = createCloudAgents({ port: () => null, clients: { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }, openQuestions: new Map(), deviceInput: { setUserAction: vi.fn() } })
    cloud.doors.publish([harness()])
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[cloud] cloud_1 asking'))
    log.mockRestore()
  })
})
