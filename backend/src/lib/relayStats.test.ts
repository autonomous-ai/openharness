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
    termup: { local: 2, published: 1, receivers: 2, none: 0 },
    'up targeted': { local: 0, published: 1, receivers: 1, none: 0 },
  })
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(logs).toHaveLength(1)
})

// A publish no process subscribes to is work for nobody: `none` is what tells whether the daemon's UI gate pays
// (spec 2026-11-02-swarm-cache-delta-design, Part 4).
it('a publish reaching no subscriber counts as none', async () => {
  const logs: Array<Record<string, unknown>> = []
  stop = startRelayStats({ everyMs: 50, log: (_m, c) => logs.push(c) })
  recordRelay('up broadcast', 'published', 0)
  recordRelay('up broadcast', 'published', 0)
  recordRelay('up broadcast', 'published', 3)
  recordRelay('up broadcast', 'local')
  while (!logs.length) await new Promise(resolve => setTimeout(resolve, 10))
  expect(logs[0]!.kinds).toEqual({ 'up broadcast': { local: 1, published: 3, receivers: 3, none: 2 } })
})
