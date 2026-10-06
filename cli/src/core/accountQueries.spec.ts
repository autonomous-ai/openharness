// The core's account, asked by a service in its own process: a token, and each step of the fleet's lane's
// sealing, which the gateway does with this machine's identity. Nothing else is the account's to answer.
import { describe, expect, it, vi } from 'vitest'
import { AuthSessionError } from '../lib/authSession.js'
import { answerAccountQuery } from './accountQueries.js'
import type { LaneSeal } from './api.js'

function account() {
  const lane = {
    hello: vi.fn(async (machineId: string) => ({ type: 'e2e_hello', machineId })),
    welcome: vi.fn(async () => true),
    rekey: vi.fn(async () => {}),
    seal: vi.fn(async (_m: string, frame: Record<string, unknown>) => ({ frame: { ...frame, sealed: true } })),
    open: vi.fn(async () => ({ unreadable: true as const })),
    drop: vi.fn(),
  } satisfies LaneSeal
  return { accessToken: vi.fn(async () => 'token-1'), lane }
}

describe('the core\'s account, asked by a service in its own process', () => {
  it('hands out a token, refreshed once when the asker says the last was refused, or the session\'s own refusal', async () => {
    const a = account()
    expect(await answerAccountQuery(a, 'access_token', {})).toEqual({ token: 'token-1' })
    expect(a.accessToken).toHaveBeenLastCalledWith({ force: false })
    await answerAccountQuery(a, 'access_token', { force: true, failedToken: 'old' })
    expect(a.accessToken).toHaveBeenLastCalledWith({ force: true, failedToken: 'old' })
    a.accessToken.mockRejectedValueOnce(new AuthSessionError('refresh refused', 'INVALID_REFRESH'))
    expect(await answerAccountQuery(a, 'access_token', {})).toEqual({ code: 'INVALID_REFRESH', message: 'refresh refused' })
    a.accessToken.mockRejectedValueOnce('down')
    expect(await answerAccountQuery(a, 'access_token', {})).toEqual({ code: 'UNAVAILABLE', message: 'down' })
  })

  it('runs each step of the lane\'s sealing on the gateway\'s seal, as it was asked', async () => {
    const a = account()
    expect(await answerAccountQuery(a, 'lane', { op: 'hello', machineId: 'm2', peerPub: 'P' })).toEqual({ frame: { type: 'e2e_hello', machineId: 'm2' } })
    expect(a.lane.hello).toHaveBeenCalledWith('m2', 'P')
    expect(await answerAccountQuery(a, 'lane', { op: 'welcome', machineId: 'm2', payload: { e: 1 } })).toEqual({ ok: true })
    expect(await answerAccountQuery(a, 'lane', { op: 'rekey', machineId: 'm2', payload: { r: 1 } })).toEqual({})
    expect(a.lane.rekey).toHaveBeenCalledWith('m2', { r: 1 })
    expect(await answerAccountQuery(a, 'lane', { op: 'seal', machineId: 'm2', frame: { type: 'message' } })).toEqual({ frame: { type: 'message', sealed: true } })
    expect(await answerAccountQuery(a, 'lane', { op: 'open', machineId: 'm2', frame: [] })).toEqual({ unreadable: true })
    expect(a.lane.open).toHaveBeenCalledWith('m2', {})
    expect(await answerAccountQuery(a, 'lane', { op: 'drop', machineId: 'm2' })).toEqual({})
    expect(a.lane.drop).toHaveBeenCalledWith('m2')
    expect(await answerAccountQuery(a, 'lane', { op: 'reveal', machineId: 'm2' })).toEqual({ error: 'UNKNOWN_OP' })
    a.lane.hello.mockRejectedValueOnce(new Error('the gateway could not start an E2EE session: it is not running'))
    expect(await answerAccountQuery(a, 'lane', { op: 'hello', machineId: 7 })).toEqual({ error: 'the gateway could not start an E2EE session: it is not running' })
    expect(a.lane.hello).toHaveBeenLastCalledWith('', '')
    a.lane.hello.mockRejectedValueOnce('down')
    expect(await answerAccountQuery(a, 'lane', { op: 'hello', machineId: 'm2' })).toEqual({ error: 'down' })
  })

  it('answers nothing that is not the account\'s', async () => {
    expect(await answerAccountQuery(account(), 'agents', {})).toBeNull()
  })
})
