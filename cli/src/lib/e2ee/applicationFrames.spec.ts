import { describe, expect, it } from 'vitest'
import { AGENT_BROWSER_DOWN_TYPES, AGENT_BROWSER_UP_TYPES, encryptDownFrame, encryptDownFrameFor, encryptRpcResult } from './applicationFrames.js'

describe('agent browser stream frames', () => {
  it('the four stream frames are sealed down and up', () => {
    expect([...AGENT_BROWSER_DOWN_TYPES]).toEqual(['agent_browser_open', 'agent_browser_ack', 'agent_browser_close'])
    expect([...AGENT_BROWSER_UP_TYPES]).toEqual(['agent_browser_open_result', 'agent_browser_close'])
    for (const type of AGENT_BROWSER_DOWN_TYPES) {
      expect(encryptDownFrame(type), type).toBe(true)
      // Sealed to every daemon: one too old to open them does not know the stream either.
      expect(encryptDownFrameFor(type, { strictDown: false }), type).toBe(true)
    }
    for (const type of AGENT_BROWSER_UP_TYPES) expect(encryptRpcResult(type), type).toBe(true)
  })
})
