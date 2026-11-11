import { describe, expect, it } from 'vitest'
import type { Frame } from './tunnel.js'
import {
  AGENT_BROWSER_DOWN_TYPES,
  AGENT_BROWSER_UP_TYPES,
  browserRateNotice,
  isEncryptedTerminalFrame,
  RELAY_BUSY_STREAMS,
  TERMINAL_DOWN_TYPES,
  TERMINAL_UP_TYPES,
  terminalFrameBytes,
  terminalFrameNeedsWake,
  TerminalRateGuard,
} from './terminalRelay.js'

/** The largest `terminal_ack` a client can send, shaped exactly as the relay wraps it: the plaintext
 *  payload sealed with a 16-byte AEAD tag, base64'd into an `__e2e` envelope. */
function worstCaseAck(): Frame {
  const plaintext = JSON.stringify({
    streamId: '00000000-0000-4000-8000-000000000000',
    lastSeq: Number.MAX_SAFE_INTEGER,
  })
  const ct = Buffer.alloc(Buffer.byteLength(plaintext) + 16).toString('base64')
  return { type: 'terminal_ack', payload: { __e2e: { v: 1, k: 'p', n: Number.MAX_SAFE_INTEGER, ct } } }
}

describe('terminal opaque relay contract', () => {
  it('keeps the expected direction allowlists disjoint', () => {
    expect([...TERMINAL_DOWN_TYPES].sort()).toEqual([
      'terminal_ack', 'terminal_alive', 'terminal_capabilities', 'terminal_chunked_upload_begin',
      'terminal_chunked_upload_cancel', 'terminal_close', 'terminal_input', 'terminal_open',
      'terminal_resize', 'terminal_resync', 'terminal_scroll',
    ])
    expect([...TERMINAL_UP_TYPES].sort()).toEqual([
      'terminal_capabilities_result', 'terminal_chunked_upload_begin_result',
      'terminal_chunked_upload_progress', 'terminal_closed', 'terminal_error',
      'terminal_keyframe', 'terminal_output', 'terminal_paste_file_result',
      'terminal_paste_image_result', 'terminal_ready',
    ])
    expect([...TERMINAL_DOWN_TYPES].some((type) => TERMINAL_UP_TYPES.has(type))).toBe(false)
    expect(TERMINAL_DOWN_TYPES.has('terminal_future_unreviewed')).toBe(false)
    expect(TERMINAL_UP_TYPES.has('terminal_future_unreviewed')).toBe(false)
  })

  it('accepts only structurally valid ciphertext without opening it', () => {
    const frame = {
      type: 'terminal_input',
      payload: { __e2e: { v: 1, k: 'p', n: 7, ct: 'opaque-ciphertext' } },
    }
    expect(isEncryptedTerminalFrame(frame)).toBe(true)
    expect(terminalFrameBytes(frame)).toBe(Buffer.byteLength(JSON.stringify(frame)))
    expect(isEncryptedTerminalFrame({ type: 'terminal_input', payload: { data: 'plaintext' } })).toBe(false)
    expect(isEncryptedTerminalFrame({ type: 'terminal_input', payload: { __e2e: null } })).toBe(false)
    expect(isEncryptedTerminalFrame({ type: 'terminal_input', payload: { __e2e: { v: 1, k: 'p', n: '7', ct: 'x' } } })).toBe(false)
  })

  it('rate-limits per type in a bounded one-minute window', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    for (let i = 0; i < 60; i++) expect(guard.allow('terminal_open', 100)).toBe(true)
    expect(guard.allow('terminal_open', 100)).toBe(false)
    expect(guard.allow('terminal_input', 100)).toBe(true)
    now += 60_000
    expect(guard.allow('terminal_open', 100)).toBe(true)
  })

  it('lets a busy renderer ack for a whole window without losing its stream', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    // What the desktop client actually emits under sustained output: one ack per 16ms render
    // window for a full minute. Every one of them has to pass — a rejected ack is reported as
    // transport loss, so tripping this limit kills the pane rather than throttling it.
    const acksPerMinute = Math.ceil(60_000 / 16)
    for (let i = 0; i < acksPerMinute; i++) {
      expect(guard.allow('terminal_ack', 120)).toBe(true)
    }
    // Heartbeats and user-driven frames keep the tighter, unrelated budget.
    for (let i = 0; i < 1_200; i++) expect(guard.allow('terminal_alive', 100)).toBe(true)
    expect(guard.allow('terminal_alive', 100)).toBe(false)
    expect(guard.allow('terminal_ack', 120)).toBe(true)
  })

  it('sizes the relay for 64 busy harnesses on one machine', () => {
    // A person driving many harnesses on one remote machine hit the 16-stream budget (2026-10-16).
    expect(RELAY_BUSY_STREAMS).toBe(64)
  })

  it('lets RELAY_BUSY_STREAMS renderers ack on one socket for a whole minute', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    // One guard serves the socket, and every pane of the machine shares it. Each busy pane acks once
    // per 16 ms render window; the worst-case frame size makes the byte cap part of the check.
    const acks = RELAY_BUSY_STREAMS * Math.ceil(60_000 / 16)
    const bytes = terminalFrameBytes(worstCaseAck())
    let allowed = 0
    for (let i = 0; i < acks; i++) if (guard.allow('terminal_ack', bytes)) allowed++
    expect(allowed).toBe(acks)
    expect(guard.allow('terminal_ack', bytes)).toBe(false)
    now += 60_000
    expect(guard.allow('terminal_ack', bytes)).toBe(true)
  })

  it('lets RELAY_BUSY_STREAMS streams flush output every 8 ms through one adapter for a whole minute', () => {
    const guard = new TerminalRateGuard(() => 1_000)
    const frames = RELAY_BUSY_STREAMS * (60_000 / 8)
    let allowed = 0
    // ~1 KiB is a typical compressed, sealed output frame; the byte cap must not bind before the frame cap.
    for (let i = 0; i < frames; i++) if (guard.allow('terminal_output', 1_024)) allowed++
    expect(allowed).toBe(frames)
    expect(guard.allow('terminal_output', 1_024)).toBe(false)
  })

  it('keeps a worst-case encrypted ack small enough for the ack byte budget', () => {
    // Pins the size the ack budget was derived from (216 B). A frame that grows past
    // 64 MiB / 240,000 = 279 B would make the byte cap trip before the frame cap.
    expect(terminalFrameBytes(worstCaseAck())).toBeLessThanOrEqual(Math.floor((64 * 1024 * 1024) / 240_000))
  })

  it('wakes only for terminal_open, never per input/mouse/resize/ack frame', () => {
    expect(terminalFrameNeedsWake('terminal_open')).toBe(true)
    for (const type of TERMINAL_DOWN_TYPES) {
      if (type !== 'terminal_open') expect(terminalFrameNeedsWake(type)).toBe(false)
    }
  })
})

/** The largest `agent_browser_ack` a viewer sends: a stream id and a byte count, sealed into an `__e2e` envelope. */
function worstCaseBrowserAck(): Frame {
  const plaintext = JSON.stringify({ streamId: '00000000-0000-4000-8000-000000000000', bytes: Number.MAX_SAFE_INTEGER })
  const ct = Buffer.alloc(Buffer.byteLength(plaintext) + 16).toString('base64')
  return { type: 'agent_browser_ack', payload: { __e2e: { v: 1, k: 'p', n: Number.MAX_SAFE_INTEGER, ct } } }
}

describe('agent browser relay contract', () => {
  it('relays agent_browser_open down and agent_browser_open_result up, and nothing unknown', () => {
    expect([...AGENT_BROWSER_DOWN_TYPES].sort()).toEqual(['agent_browser_ack', 'agent_browser_close', 'agent_browser_open'])
    expect([...AGENT_BROWSER_UP_TYPES].sort()).toEqual(['agent_browser_close', 'agent_browser_open_result'])
    for (const type of ['agent_browser_foo', 'agent_browser_transport_error']) {
      expect(AGENT_BROWSER_DOWN_TYPES.has(type), type).toBe(false)
      expect(AGENT_BROWSER_UP_TYPES.has(type), type).toBe(false)
    }
  })

  it('budgets a machine\'s browser bytes at 512 KiB a second, under their own key', () => {
    const guard = new TerminalRateGuard(() => 1_000)
    for (let i = 0; i < 60 * 8; i++) expect(guard.allow('agent_browser_output', 64 * 1024)).toBe(true)
    expect(guard.allow('agent_browser_output', 1)).toBe(false)
    // A spent browser budget does not throttle the terminal on the same socket.
    expect(guard.allow('terminal_output', 1_024)).toBe(true)
    expect(guard.allow('terminal_keyframe', 1_024)).toBe(true)
  })

  it('budgets a client\'s browser bytes at 64 KiB a second, apart from terminal paste and input', () => {
    const guard = new TerminalRateGuard(() => 1_000)
    for (let i = 0; i < 60; i++) expect(guard.allow('agent_browser_input', 64 * 1024)).toBe(true)
    expect(guard.allow('agent_browser_input', 1)).toBe(false)
    expect(guard.allow('terminal_input', 100)).toBe(true)
    expect(guard.allow('terminal_paste', 100)).toBe(true)
  })

  it('never refuses agent_browser_ack at twice one ack per 64 KiB of the machine budget', () => {
    const guard = new TerminalRateGuard(() => 1_000)
    const bytes = terminalFrameBytes(worstCaseBrowserAck())
    const acks = 2 * ((512 * 1024) / (64 * 1024)) * 60
    for (let i = 0; i < acks; i++) expect(guard.allow('agent_browser_ack', bytes)).toBe(true)
    expect(guard.allow('agent_browser_ack', bytes)).toBe(false)
  })

  it('allows 120 browser opens and closes a minute', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    for (const type of ['agent_browser_open', 'agent_browser_open_result', 'agent_browser_close']) {
      for (let i = 0; i < 120; i++) expect(guard.allow(type, 300), type).toBe(true)
      expect(guard.allow(type, 300), type).toBe(false)
    }
    now += 60_000
    expect(guard.allow('agent_browser_open', 300)).toBe(true)
  })

  it('tells the sender of a refused browser frame, at most once a second', () => {
    let now = 1_000
    const sent: Frame[] = []
    const refused = browserRateNotice((frame) => sent.push(frame), () => now)
    refused(); refused(); refused()
    expect(sent).toEqual([{ type: 'agent_browser_transport_error', payload: { code: 'RATE' } }])
    now += 999
    refused()
    expect(sent).toHaveLength(1)
    now += 1
    refused()
    expect(sent).toHaveLength(2)
  })
})
