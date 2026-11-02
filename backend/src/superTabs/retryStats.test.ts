import { afterEach, expect, it } from 'vitest'
import { runWork } from '../lib/queryStats.js'
import { retryTransient } from './retry.js'
import { recordReload, startRetryStats } from './retryStats.js'

let stop = () => {}
afterEach(() => stop())

const conflict = () => Object.assign(new Error('Transaction failed due to a write conflict'), { code: 'P2034' })
const noWait = async () => {}
const logged = async (logs: Array<Record<string, unknown>>) => { while (!logs.length) await new Promise(resolve => setTimeout(resolve, 10)) }

it('counts each route\'s transaction attempts, retries by code, busy answers and reloads, and logs nothing in a quiet minute', async () => {
  const logs: Array<Record<string, unknown>> = []
  stop = startRetryStats({ everyMs: 50, log: (_m, c) => logs.push(c) })
  await runWork('http POST /api/super-tabs/:tabId/commands', async () => {
    let failures = 2
    await retryTransient(async () => { if (failures-- > 0) throw conflict(); return 'ok' }, noWait)
    recordReload()
    await expect(retryTransient(async () => { throw conflict() }, noWait)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
  })
  await logged(logs)
  expect(logs[0]!.routes).toEqual({ 'http POST /api/super-tabs/:tabId/commands': { attempts: 11, retries: { P2034: 9 }, busy: 1, reloads: 1 } })
  // A minute with nothing to count says nothing.
  const count = logs.length
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(logs).toHaveLength(count)
})

it('counts nothing for an error that is not retried', async () => {
  const logs: Array<Record<string, unknown>> = []
  stop = startRetryStats({ everyMs: 50, log: (_m, c) => logs.push(c) })
  await runWork('background', async () => {
    await expect(retryTransient(async () => { throw new Error('no') }, noWait)).rejects.toThrow('no')
  })
  await logged(logs)
  expect(logs[0]!.routes).toEqual({ background: { attempts: 1, retries: {}, busy: 0, reloads: 0 } })
})
