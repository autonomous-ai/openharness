/**
 * The core's account, as a service in its own process reaches it (step 10, R3; the core's side is
 * core/accountQueries.ts): a token for each dial, and the gateway's seal for the fleet's lane, each asked of
 * the core as it is needed. The process holds neither the session nor this machine's E2EE identity.
 *
 * A core that cannot be asked (the link is down) hands out no token and starts no session: the lane seals
 * nothing (`lost`), so nothing for a linked machine goes out in the clear while the core is away.
 */
import type { CoreApi } from '../core/api.js'
import { AuthSessionError } from '../lib/authSession.js'

type Payload = Record<string, unknown>
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
/** A frame in the core's answer: an object, or none. */
const frameOf = (answer: Payload): Payload | null => (answer.frame && typeof answer.frame === 'object' ? answer.frame as Payload : null)
const SESSION_CODES = new Set(['MISSING', 'INVALID_REFRESH', 'UNAVAILABLE'])

/** `query` asks the core (`CoreConnection.query`, services/process.ts); it rejects when the link goes. */
export function accountLink(query: (query: string, payload: Payload) => Promise<Payload>): Pick<CoreApi['account'], 'accessToken' | 'lane'> {
  const ask = (q: string, payload: Payload): Promise<Payload> => query(q, payload).catch((): Payload => ({ error: 'not connected to the core' }))
  const lane = (op: string, payload: Payload = {}) => ask('lane', { ...payload, op })
  return {
    accessToken: async (options = {}) => {
      const answer = await query('access_token', options).catch((error: unknown) => {
        throw new AuthSessionError(error instanceof Error ? error.message : 'not connected to the core', 'UNAVAILABLE')
      })
      if (typeof answer.token === 'string') return answer.token
      const code = SESSION_CODES.has(text(answer.code)) ? text(answer.code) as 'MISSING' | 'INVALID_REFRESH' | 'UNAVAILABLE' : 'UNAVAILABLE'
      throw new AuthSessionError(text(answer.message) || 'the core could not hand out a token', code)
    },
    lane: {
      hello: async (machineId, peerPub) => {
        const answer = await lane('hello', { machineId, peerPub })
        const frame = frameOf(answer)
        if (frame) return frame
        throw new Error(text(answer.error) || 'the gateway could not start an E2EE session')
      },
      welcome: async (machineId, payload) => (await lane('welcome', { machineId, payload })).ok === true,
      rekey: async (machineId, payload) => { await lane('rekey', { machineId, payload }) },
      seal: async (machineId, frame) => {
        const sealed = frameOf(await lane('seal', { machineId, frame }))
        return sealed ? { frame: sealed } : { lost: true }
      },
      open: async (machineId, frame) => {
        const answer = await lane('open', { machineId, frame })
        const opened = frameOf(answer)
        if (opened) return { frame: opened }
        return answer.unreadable === true ? { unreadable: true } : { lost: true }
      },
      drop: (machineId) => { void lane('drop', { machineId }) },
    },
  }
}
