import type { PushDevice } from './devices.js'

/**
 * One notification for one person's phones (task #2905), as the phone's own notices word it (mobile
 * lib/swarm/swarm_notices.dart): who and where, never what was written. `key` is the phone's key for the same notice, so the
 * app never posts it a second time; `link` is the phone's `swarm:` payload, which opens the thread at the reply.
 */
export interface PhoneNotice { personId: string; key: string; title: string; subtitle: string; body: string; link: string }

/** sent; gone: the token is dead, forget it; sandbox: taken by Apple's sandbox host, send there from now on; failed;
 *  unconfigured: the server has no key for where it would go (Apple's sandbox host), so nothing was sent and the token is kept. */
export type SendOutcome = 'sent' | 'gone' | 'sandbox' | 'failed' | 'unconfigured'
/** `reason` is Apple's or Google's word for it, or `timeout`: never the token. */
export interface SendResult { outcome: SendOutcome; reason?: string }

export interface Sender { send(device: PushDevice, notice: PhoneNotice): Promise<SendResult> }

/** Every call to Apple or Google waits at most this long. */
export const SEND_TIMEOUT_MS = 10_000

/** The iOS thread and category, and the Android channel, of Swarm notices: the ones the app's local notices use. */
export const SWARM_CHANNEL = 'swarm-needs-you'

/** `promise`, or a rejection with `timeout` after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
