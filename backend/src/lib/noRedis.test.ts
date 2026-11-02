import { describe, expect, it } from 'vitest'

// Unit tests run with no Redis (#2434): a file that imports the bus without stubbing it, as webWs.test.ts does through
// webWs.ts, used to open four real clients whose reconnect errors logged after the file ended ("Closing rpc while
// onUserConsoleLog was pending"). The shared setup (noRedis.test-support.ts) gives every file clients that never connect.
describe('the bus in unit tests', () => {
  it('opens no connection, and its commands fail at once as in an outage', async () => {
    const bus = await import('./bus.js')
    // Long enough for a real client to have started connecting and failed once.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(bus.pub.status).toBe('wait')
    await expect(bus.pub.get('anything')).rejects.toThrow("Stream isn't writeable")
    expect(bus.pub.status).toBe('wait')
  })
})
