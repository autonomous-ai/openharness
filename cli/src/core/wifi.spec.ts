import { describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../lib/normalize.js'
import { WIFI_OFF, type WifiPort } from './api.js'
import { createWifiCore } from './wifi.js'

function harness() {
  const port = {
    resume: vi.fn(async () => {}), card: vi.fn(), turnEnded: vi.fn(), stream: vi.fn(), transcript: vi.fn(), delivery: vi.fn(),
    events: vi.fn(), input: vi.fn(), disconnected: vi.fn(), agentGone: vi.fn(), appFocus: vi.fn(async () => {}), revealed: vi.fn(), stop: vi.fn(async () => {}),
  } satisfies WifiPort
  let on: WifiPort | null = port
  const fullText = vi.fn((agentId: string) => agentId === 'a' ? 'the whole answer' : undefined)
  const wifi = createWifiCore({ port: () => on, fullText, doors: WIFI_OFF })
  return { wifi, port, fullText, off: () => { on = null }, on: () => { on = port } }
}

describe('remaining Wi-Fi transcript, stream and final focus fences', () => {
  it('forwards intact lifecycle batches before recap filtering, and no ordinary output batch', () => {
    const { wifi, port, off } = harness()
    const output = { type: 'text', payload: { text: 'answer' } } as unknown as LiveEvent
    const started = { type: 'turn_started', payload: {} } as LiveEvent
    const ended = { type: 'turn_ended', payload: {} } as LiveEvent
    wifi.feed.events('a', [output])
    expect(port.events).not.toHaveBeenCalled()
    const batch = [ended, started, output]
    wifi.feed.events('a', batch)
    expect(port.events).toHaveBeenCalledExactlyOnceWith('a', batch)
    wifi.feed.events('a', [started])
    expect(port.events).toHaveBeenCalledTimes(2)
    off()
    expect(() => wifi.feed.events('a', [ended])).not.toThrow()
    expect(port.events).toHaveBeenCalledTimes(2)
  })
  it('sends an agent\'s transcript lines from its prompt\'s dispatch until the service is done with it as of its last prompt', () => {
    const { wifi, port } = harness()
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(false)
    wifi.started(null)
    wifi.feed.inputDispatched('a')
    // Before the service could ask for it: the prompt's first lines may come at once.
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(true)
    expect(wifi.feed.needsTranscript('a', 's', 'codex')).toBe(true)
    // Only the engines whose transcripts prove a turn.
    expect(wifi.feed.needsTranscript('a', 's', 'cursor')).toBe(false)
    wifi.feed.observeTranscript('a', 's', 'claude', '{"line":1}')
    expect(port.transcript).toHaveBeenCalledWith('a', 's', 'claude', '{"line":1}')
    // A second prompt the service has not heard of yet: its "done as of the first" leaves it watched.
    wifi.feed.inputDispatched('a')
    wifi.api.transcripts('a', 1)
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(true)
    wifi.api.transcripts('a', 2)
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(false)
    // An agent it was never told of.
    wifi.api.transcripts('b', 0)
    expect(wifi.feed.needsTranscript('b', 's', 'claude')).toBe(false)
  })

  it('takes the service\'s own list as it starts, and forgets the counts the last one heard', () => {
    const { wifi } = harness()
    wifi.started(null)
    wifi.feed.inputDispatched('a')
    wifi.api.watching(['b'])
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(false)
    expect(wifi.feed.needsTranscript('b', 's', 'claude')).toBe(true)
    wifi.api.transcripts('b', 0)
    expect(wifi.feed.needsTranscript('b', 's', 'claude')).toBe(false)
  })

  it('streams the answer\'s text always and a tool\'s events only for a subscribed agent, and nothing with the service away', () => {
    const { wifi, port } = harness()
    const events = [
      { type: 'turn_started', payload: {} }, { type: 'text_delta', payload: { content: 'hi' } },
      { type: 'tool_start', payload: { id: 't', tool: 'Read', input: {} } }, { type: 'tool_end', payload: { id: 't', tool: 'Read', isError: false } },
      { type: 'thinking_delta', payload: {} }, { type: 'turn_ended', payload: {} },
    ] as unknown as LiveEvent[]
    wifi.feed.stream('a', events)
    expect(port.stream).not.toHaveBeenCalled()
    wifi.started(null)
    wifi.feed.stream('a', events)
    expect(port.stream).toHaveBeenLastCalledWith('a', [events[0], events[1], events[5]])
    wifi.api.streams(['a'])
    wifi.feed.stream('a', events)
    expect(port.stream).toHaveBeenLastCalledWith('a', [events[0], events[1], events[2], events[3], events[5]])
    port.stream.mockClear()
    wifi.feed.stream('a', [events[4]])
    expect(port.stream).not.toHaveBeenCalled()
  })

  it('passes what the agents do and the panes say on to the service, and nothing when it is off', () => {
    const { wifi, port, off } = harness()
    wifi.feed.agentGone('a')
    wifi.feed.turnEnded('a')
    wifi.feed.turnEnded('b', true)
    expect(port.agentGone).toHaveBeenCalledWith('a')
    expect(port.turnEnded).toHaveBeenCalledWith('a', false)
    expect(port.turnEnded).toHaveBeenCalledWith('b', true)
    off()
    for (const call of [() => wifi.feed.agentGone('a'),
      () => wifi.feed.observeTranscript('a', 's', 'claude', 'x'), () => wifi.feed.inputDispatched('a'),
      () => wifi.feed.turnEnded('a'),
      () => wifi.card({ type: 'commander_event' }), () => wifi.started(null)]) expect(call()).toBeUndefined()
    wifi.api.streams(['a'])
    expect(wifi.feed.stream('a', [{ type: 'text_delta', payload: { content: 'x' } } as unknown as LiveEvent])).toBeUndefined()
  })

  it('hands a summary card its turn\'s whole answer, and any other card as it is', () => {
    const { wifi, port, fullText } = harness()
    const summary = { type: 'commander_event', agentId: 'a', payload: { kind: 'summary', text: 'short' } }
    wifi.card(summary)
    expect(port.card).toHaveBeenLastCalledWith(summary, 'the whole answer')
    const tool = { type: 'commander_event', agentId: 'a', payload: { kind: 'tool' } }
    wifi.card(tool)
    expect(port.card).toHaveBeenLastCalledWith(tool, undefined)
    wifi.card({ type: 'commander_question', agentId: 'a' })
    wifi.card({ type: 'commander_event', payload: { kind: 'summary' } })
    expect(fullText).toHaveBeenCalledTimes(1)
  })

  it('resumes only window focus across service generations without retaining its revision', async () => {
    const { wifi, port } = harness()
    expect(wifi.api.view).toBe(WIFI_OFF.view)
    wifi.started({ machineId: 'm', agentId: 'a', connId: 'w' })
    expect(port.resume).toHaveBeenCalledExactlyOnceWith({ focus: { machineId: 'm', agentId: 'a', connId: 'w' } })
    wifi.stopped()
    port.resume.mockRejectedValueOnce(new Error('unavailable'))
    wifi.started(null)
    await Promise.resolve()
  })
})
