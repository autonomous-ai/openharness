// Shared setup of the backend unit and Super Tab integration runners (vitest.config.ts, vitest.super-tabs.config.ts): no
// test opens Redis (#2434). The bus (bus.ts) makes its clients on import, so a file that imports it without stubbing it,
// even through another module, opened four real connections whose reconnect errors logged after the file ended ("Closing
// rpc while onUserConsoleLog was pending").
// Here every client stays unconnected: its commands fail at once, as in a Redis outage, and a subscription waits.
// A file that stubs ioredis or the bus itself keeps its own stub. Every file that needs real clients calls
// vi.unmock('ioredis'): against a fake server of its own (redisGuard.test.ts), or a real Redis (redisRateCounter.test.ts
// where redis-server is installed; terminalRouteRedis.test.ts and superTabs/cacheRedis.test.ts with REDIS_TEST_URL).
import { vi } from 'vitest'

vi.mock('ioredis', async original => {
  const real = await original<typeof import('ioredis')>()
  // Every connect, the constructor's and each command's, goes through here: no socket opens and the status stays "wait".
  class UnconnectedRedis extends real.Redis {
    override connect(): Promise<void> {
      return Promise.reject(new Error('Unit tests run with no Redis (noRedis.test-support.ts).'))
    }
  }
  return { ...real, Redis: UnconnectedRedis, default: UnconnectedRedis }
})
