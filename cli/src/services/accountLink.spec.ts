// The core's account from a service's own process: each token and each step of the lane's sealing asked of
// the core (core/accountQueries.ts, wired in here as the core answers), and nothing in the clear without it.
import { describe, expect, it, vi } from 'vitest'
import { answerAccountQuery } from '../core/accountQueries.js'
import type { LaneSeal } from '../core/api.js'
import { AuthSessionError } from '../lib/authSession.js'
import { accountLink } from './accountLink.js'

function core() {
  const lane = {
    hello: vi.fn(async (machineId: string) => ({ type: 'e2e_hello', machineId })),
    welcome: vi.fn(async () => true),
    rekey: vi.fn(async () => {}),
    seal: vi.fn(async (_m: string, frame: Record<string, unknown>) => ({ frame: { ...frame, sealed: true } })),
    open: vi.fn(async (_m: string, frame: Record<string, unknown>) => ({ frame: { ...frame, opened: true } })),
    drop: vi.fn(),
  } satisfies LaneSeal
  const account = { accessToken: vi.fn(async (_options?: unknown) => 'token-1'), lane }
  const query = vi.fn(async (q: string, payload: Record<string, unknown>) => (await answerAccountQuery(account, q, payload)) ?? { error: 'UNKNOWN_QUERY' })
  return { account, query }
}

describe('the core\'s account, from a service\'s own process', () => {
  it('asks the core for each token, and fails as the session failed', async () => {
    const c = core()
    const link = accountLink(c.query)
    expect(await link.accessToken()).toBe('token-1')
    expect(await link.accessToken({ force: true, failedToken: 'old' })).toBe('token-1')
    expect(c.account.accessToken).toHaveBeenLastCalledWith({ force: true, failedToken: 'old' })
    c.account.accessToken.mockRejectedValueOnce(new AuthSessionError('signed out', 'MISSING'))
    await expect(link.accessToken()).rejects.toMatchObject({ code: 'MISSING', message: 'signed out' })
    c.account.accessToken.mockRejectedValueOnce(Object.assign(new Error('odd'), { code: 'WEIRD' }))
    await expect(link.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'odd' })
    await expect(accountLink(async () => ({}))?.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'the core could not hand out a token' })
    // The link to the core gone: no token, said as a session that could not be refreshed just now.
    await expect(accountLink(async () => { throw new Error('the core went away') }).accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'the core went away' })
    await expect(accountLink(async () => { throw 'gone' }).accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'not connected to the core' })
  })

  it('seals and opens through the core, step by step, as the gateway did each', async () => {
    const c = core()
    const { lane } = accountLink(c.query)
    expect(await lane.hello('m2', 'P')).toEqual({ type: 'e2e_hello', machineId: 'm2' })
    expect(await lane.welcome('m2', { e: 1 })).toBe(true)
    await lane.rekey('m2', { r: 1 })
    expect(await lane.seal('m2', { type: 'message' })).toEqual({ frame: { type: 'message', sealed: true } })
    expect(await lane.open('m2', { type: 'card' })).toEqual({ frame: { type: 'card', opened: true } })
    c.account.lane.open.mockResolvedValueOnce({ unreadable: true } as never)
    expect(await lane.open('m2', { type: 'card' })).toEqual({ unreadable: true })
    lane.drop('m2')
    await vi.waitFor(() => expect(c.account.lane.drop).toHaveBeenCalledWith('m2'))
    expect(c.account.lane.rekey).toHaveBeenCalledWith('m2', { r: 1 })
  })

  it('starts no session and seals nothing without the core, never handing a frame back as it came', async () => {
    const { lane } = accountLink(async () => { throw new Error('the core went away') })
    await expect(lane.hello('m2', 'P')).rejects.toThrow('not connected to the core')
    await expect(accountLink(async () => ({})).lane.hello('m2', 'P')).rejects.toThrow('the gateway could not start an E2EE session')
    expect(await lane.welcome('m2', {})).toBe(false)
    expect(await lane.seal('m2', { type: 'message', payload: { content: 'never in the clear' } })).toEqual({ lost: true })
    expect(await lane.open('m2', { type: 'card' })).toEqual({ lost: true })
    const c = core()
    c.account.lane.hello.mockRejectedValueOnce(new Error('it is not running'))
    await expect(accountLink(c.query).lane.hello('m2', 'P')).rejects.toThrow('it is not running')
  })
})
