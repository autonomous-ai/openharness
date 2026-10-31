import { afterEach, expect, it } from 'vitest'
import { recordRelay, startRelayStats } from './relayStats.js'

let stop = () => {}
afterEach(() => stop())

it('counts local and published frames and the receivers each publish reached, per kind, and logs nothing in a quiet window', async () => {
  const logs: Array<Record<string, unknown>> = []
  stop = startRelayStats({ everyMs: 50, log: (_m, c) => logs.push(c) })
  recordRelay('termup', 'local')
  recordRelay('termup', 'local')
  recordRelay('termup', 'published', 2)
  recordRelay('up targeted', 'published', 1)
  while (!logs.length) await new Promise(resolve => setTimeout(resolve, 10))
  expect(logs[0]!.kinds).toEqual({
    termup: { local: 2, published: 1, receivers: 2 },
    'up targeted': { local: 0, published: 1, receivers: 1 },
  })
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(logs).toHaveLength(1)
})
