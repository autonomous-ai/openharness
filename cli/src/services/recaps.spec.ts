import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type RecapSession, type TurnLifecycle } from '../core/api.js'
import { SUBAGENT_IDLE_MS, type CommanderMirrorOpts } from '../lib/commander.js'
import { deriveTurnSummary } from '../lib/deviceRecap.js'
import type { LiveEvent } from '../lib/normalize.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createRecaps, startRecaps } from './recaps.js'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'recaps-')); dirs.push(dir); return dir }
const watching = { device: true, active: true }
const nobody = { device: false, active: false }
const s1: RecapSession = { sessionId: 's1', agentId: 'a1', name: 'app', subagent: false }
const started = (userMessage = 'what is the fix?') => ({ type: 'turn_started', payload: { userMessage } }) as LiveEvent
const ended = { type: 'turn_ended', payload: {} } as LiveEvent
const flush = () => new Promise((done) => setTimeout(done, 0))

function setup(over: Parameters<typeof createRecaps>[1] = {}) {
  const core = fakeCore({ dataDir: temp() })
  vi.mocked(core.transcripts.lastTurn).mockResolvedValue({ assistantText: 'The fix is in. Tests pass.', userMessage: 'what is the fix?' } as never)
  const recaps = createRecaps(core, { recapForce: false, recapWithoutDevice: () => true, ...over })
  const opts = (recaps.mirror as unknown as { opts: CommanderMirrorOpts }).opts
  const tell = (event: TurnLifecycle, seen = watching) => recaps.port.lifecycle(event, seen)
  return { core, recaps, opts, tell }
}

describe('the recaps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('starts in the core\'s process behind its port', () => {
    const ports = emptyPorts()
    startRecaps(fakeCore({ dataDir: temp() }), ports)
    expect(ports.recaps?.recaps('nobody')).toBeNull()
  })

  it('cuts a turn\'s recap from its final answer, sends the card and the apps\' recap, and keeps it for the core to read', async () => {
    const { core, recaps, tell } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    expect(recaps.port.recaps('s1')).toMatchObject({ asks: ['what is the fix?'], busy: true })
    tell({ kind: 'events', session: s1, events: [ended], replay: false })
    await vi.waitFor(() => expect(core.clients.turnSummary).toHaveBeenCalled())
    const summary = await deriveTurnSummary('The fix is in. Tests pass.')
    expect(core.transcripts.lastTurn).toHaveBeenCalledWith('s1')
    expect(vi.mocked(core.clients.turnSummary).mock.calls[0][0]).toMatchObject({ type: 'turn_summary', agentId: 'a1', dbSessionId: 's1', payload: { summary, sessionId: 's1' } })
    const cards = vi.mocked(core.clients.turnCard).mock.calls.map(([frame]) => frame)
    expect(cards.map((frame) => frame.payload.kind)).toEqual(['processing', 'done', 'summary'])
    // The summary card carries the agent's name for a machine whose tile is not loaded.
    expect(cards[2]).toMatchObject({ type: 'commander_event', agentId: 'a1', dbSessionId: 's1', name: 'app' })
    expect(recaps.port.recaps('s1')).toMatchObject({ busy: false, history: [summary], fullTexts: ['The fix is in. Tests pass.'] })
  })

  it('streams no card with no device watching, and still cuts the recap for the apps', async () => {
    const { core, tell } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    tell({ kind: 'events', session: s1, events: [started()], replay: false }, nobody)
    tell({ kind: 'events', session: s1, events: [ended], replay: false }, nobody)
    await vi.waitFor(() => expect(core.clients.turnSummary).toHaveBeenCalled())
    expect(core.clients.turnCard).not.toHaveBeenCalled()
  })

  it('beats a busy card only while the core says the turn is verifiably working', () => {
    const { core, tell } = setup()
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    vi.mocked(core.clients.turnCard).mockClear()
    tell({ kind: 'beat', session: s1, working: false })
    expect(core.clients.turnCard).not.toHaveBeenCalled()
    tell({ kind: 'beat', session: s1, working: true })
    expect(vi.mocked(core.clients.turnCard).mock.calls.map(([frame]) => frame.payload)).toEqual([{ kind: 'processing', text: 'Processing' }])
  })

  it('clears the card on a cancel and a forget, keeping what is stored for a resume', () => {
    const { core, recaps, tell } = setup()
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    vi.mocked(core.clients.turnCard).mockClear()
    tell({ kind: 'cancelled', session: s1 })
    expect(recaps.port.recaps('s1')?.busy).toBe(false)
    tell({ kind: 'forgotten', session: { ...s1, subagent: true } })
    expect(vi.mocked(core.clients.turnCard).mock.calls.map(([frame]) => frame.payload)).toEqual([
      { kind: 'done', text: 'done' }, { kind: 'done', text: 'done', subagent: true },
    ])
    expect(recaps.port.recaps('s1')?.asks).toEqual(['what is the fix?'])
  })

  it('keeps what it was last told of whether a session is a sub-agent\'s, when an event does not say', () => {
    const { core, tell } = setup()
    tell({ kind: 'events', session: { ...s1, subagent: true }, events: [started()], replay: false })
    vi.mocked(core.clients.turnCard).mockClear()
    tell({ kind: 'cancelled', session: { sessionId: 's1', agentId: 'a1' } })
    expect(vi.mocked(core.clients.turnCard).mock.calls[0][0].payload).toEqual({ kind: 'done', text: 'done', subagent: true })
    // A session never told of is anyone's.
    tell({ kind: 'cancelled', session: { sessionId: 's2', agentId: 'a2' } })
    expect(core.clients.turnCard).toHaveBeenCalledTimes(1)
  })

  it('moves a conversation\'s recaps to its new session, and forgets a purged one', async () => {
    const { core, recaps, tell } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    tell({ kind: 'events', session: s1, events: [ended], replay: false })
    await vi.waitFor(() => expect(core.clients.turnSummary).toHaveBeenCalled())
    tell({ kind: 'rebound', from: 's1', to: 's9' })
    expect(recaps.port.recaps('s9')?.history).toEqual(recaps.port.recaps('s1')?.history)
    tell({ kind: 'purged', sessionId: 's1' })
    expect(recaps.port.recaps('s1')).toBeNull()
  })

  it('holds a turn\'s "done" notification while a question waits on the person, and lets it go once answered', async () => {
    const { core, tell } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    tell({ kind: 'asked', sessionId: 's1', requestId: 'r1' })
    tell({ kind: 'events', session: s1, events: [ended], replay: false })
    await vi.waitFor(() => expect(core.clients.turnSummary).toHaveBeenCalledTimes(1))
    expect(vi.mocked(core.clients.turnSummary).mock.calls[0][0].payload).toMatchObject({ notification: null })
    tell({ kind: 'answered', sessionId: 's1', requestId: 'r1' })
    tell({ kind: 'events', session: s1, events: [started('and now?')], replay: false })
    tell({ kind: 'events', session: s1, events: [ended], replay: false })
    await vi.waitFor(() => expect(core.clients.turnSummary).toHaveBeenCalledTimes(2))
    expect(vi.mocked(core.clients.turnSummary).mock.calls[1][0].payload).toMatchObject({ notification: { kind: 'done' } })
  })

  it('says every card again as a device joins, busy only where the core says the turn is working', () => {
    const { core, tell } = setup()
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    tell({ kind: 'events', session: { ...s1, sessionId: 's2', agentId: 'a2' }, events: [started()], replay: false })
    tell({ kind: 'beat', session: s1, working: true })
    vi.mocked(core.clients.turnCard).mockClear()
    tell({ kind: 'rejoined', working: ['s2'] })
    expect(vi.mocked(core.clients.turnCard).mock.calls.map(([frame]) => [frame.dbSessionId, frame.payload.kind])).toEqual([['s2', 'processing']])
  })

  it('says the cards of every turn still at work, for a dial that just attached', async () => {
    const { recaps, tell } = setup()
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    tell({ kind: 'beat', session: s1, working: true })
    expect(await recaps.port.liveCards()).toEqual([{ type: 'commander_event', agentId: 'a1', dbSessionId: 's1', payload: { kind: 'processing', text: 'Processing' } }])
  })

  it('lets a held turn end go on the engine\'s Stop hook', () => {
    const { recaps, tell } = setup()
    const stopped = vi.spyOn(recaps.mirror, 'noteEngineStopped')
    tell({ kind: 'stopped', sessionId: 's1' })
    expect(stopped).toHaveBeenCalledWith('s1')
  })

  it('gives the mirror the core\'s doors, the device gates as told, and an excerpt for a recap', async () => {
    const { core, opts, tell } = setup({ changed: vi.fn() })
    const frame = { type: 'commander_event' as const, agentId: 'a1', dbSessionId: 's1', payload: {} }
    opts.send(frame)
    opts.sendWeb({ type: 'turn_summary' })
    expect(core.clients.turnCard).toHaveBeenCalledWith(frame)
    expect(core.clients.turnSummary).toHaveBeenCalledWith({ type: 'turn_summary' })
    tell({ kind: 'stopped', sessionId: 's1' }, { device: true, active: false })
    expect(opts.hasDevice()).toBe(true)
    expect(opts.active!()).toBe(false)
    expect(await opts.summarize('The fix is in. Tests pass.')).toEqual(await deriveTurnSummary('The fix is in. Tests pass.'))
    expect(opts.summarizeIsLocal).toBe(true)
    expect(opts.notifyWithoutDevice).toBe(true)
    expect(opts.dataDir).toBe(core.dataDir)
    expect(opts.recapForce).toBe(false)
    expect((opts.alwaysGenerate as () => boolean)()).toBe(true)
    expect(opts.nameFor!('nobody')).toBeUndefined()
    expect(opts.agentIdFor!('nobody')).toBeUndefined()
    expect(opts.isSubagent!('nobody')).toBe(false)
    expect(opts.changed).toBeTypeOf('function')
  })

  it('reads the recap settings from the daemon\'s environment unless told', () => {
    const recaps = createRecaps(fakeCore({ dataDir: temp() }))
    const opts = (recaps.mirror as unknown as { opts: CommanderMirrorOpts }).opts
    expect(typeof opts.recapForce).toBe('boolean')
    expect(typeof (opts.alwaysGenerate as () => boolean)()).toBe('boolean')
  })

  it('counts a Claude Code sub-agent as at work while its own transcript is still growing', () => {
    const { opts, tell } = setup()
    const transcripts = temp()
    const transcriptPath = join(transcripts, 'main.jsonl')
    tell({ kind: 'stopped', sessionId: 's1' })
    tell({ kind: 'cancelled', session: { ...s1, transcriptPath } })
    tell({ kind: 'cancelled', session: { sessionId: 's2', agentId: 'a2' } })
    expect(opts.subagentActive!('s2', 'x'), 'no transcript').toBe(false)
    expect(opts.subagentActive!('s1', 'x'), 'no sub-agent file').toBe(false)
    const file = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', 'agent-x.jsonl')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{}\n')
    expect(opts.subagentActive!('s1', 'x')).toBe(true)
    const old = (Date.now() - SUBAGENT_IDLE_MS - 60_000) / 1000
    utimesSync(file, old, old)
    expect(opts.subagentActive!('s1', 'x')).toBe(false)
  })

  it('cuts no recap from a turn whose final answer the core cannot read', async () => {
    const { core, tell } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(core.transcripts.lastTurn).mockResolvedValue(null)
    tell({ kind: 'events', session: s1, events: [started()], replay: false })
    tell({ kind: 'events', session: s1, events: [ended], replay: false })
    await flush()
    await flush()
    expect(core.clients.turnSummary).not.toHaveBeenCalled()
    expect(vi.mocked(core.clients.turnCard).mock.calls.at(-1)?.[0].payload).toEqual({ kind: 'done', text: 'done' })
  })
})
