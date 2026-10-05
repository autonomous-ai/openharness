import { describe, expect, it } from 'vitest'
import { HARNESSD_PROTOCOL, isCoreMessage, isMasterMessage } from './protocol.js'

describe('the spawn channel protocol', () => {
  it.each([
    [{ type: 'harnessd:bound', protocol: HARNESSD_PROTOCOL, port: 18473 }, true],
    [{ type: 'harnessd:bound', protocol: 1.5, port: 18473 }, false],
    [{ type: 'harnessd:bound', protocol: 1, port: '18473' }, false],
    [{ type: 'harnessd:ready' }, true],
    [{ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 }, true],
    [{ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 12 }, true],
    [{ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: '12' }, false],
    [{ type: 'harnessd:heartbeat', rssBytes: '1', heapUsedBytes: 1 }, false],
    [{ type: 'harnessd:heartbeat', rssBytes: 1 }, false],
    [{ type: 'harnessd:status', status: {} }, false],
    [{ type: 'other' }, false],
    [null, false],
    ['harnessd:bound', false],
  ])('a core message %j is %s', (message, valid) => {
    expect(isCoreMessage(message)).toBe(valid)
  })

  it.each([
    [{ type: 'harnessd:status', status: { state: 'running' } }, true],
    [{ type: 'harnessd:status', status: null }, false],
    [{ type: 'harnessd:status', status: 'running' }, false],
    [{ type: 'harnessd:bound', protocol: 1, port: 1 }, false],
    [undefined, false],
    [7, false],
  ])('a master message %j is %s', (message, valid) => {
    expect(isMasterMessage(message)).toBe(valid)
  })
})
