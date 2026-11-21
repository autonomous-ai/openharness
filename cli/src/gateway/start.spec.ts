import { describe, expect, it, vi } from 'vitest'
import { postDeviceAck } from './start.js'

describe('postDeviceAck', () => {
  // The backend's refusal is its own text: a code reads as itself, anything else by its length.
  it.each([
    ['a code', 'ACK_INVALID', '(500: ACK_INVALID)'],
    ['anything else', '/Users/sentinel', '(500: text(15))'],
  ])('a refusal whose code is %s is logged by it', async (_, code, shown) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const backend = vi.fn(async () => ({ status: 500, body: { error: { code } } }))
    try {
      expect(await postDeviceAck({ backend }, { sig: 'ack' })).toBe(false)

      expect(backend).toHaveBeenCalledWith('POST', '/api/device-keys/acks', { ack: { sig: 'ack' } }, 10_000)
      const lines = log.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(lines).not.toContain('sentinel')
      expect(lines).toBe(`[devlog] the backend did not keep "It's mine" ${shown}`)
    } finally {
      log.mockRestore()
    }
  })
})
