import type { PushDevice } from './devices.js'

/**
 * One notification for one person's phones (task #2905), as the phone's own notices word it (mobile
 * lib/swarm/swarm_notices.dart): who and where, never what was written. `key` is the phone's key for the same notice, so the
 * app never posts it a second time; `link` is the phone's `swarm:` payload, which opens the thread at the reply.
 *
 * `slot` is the notification it shows in, the one the app's own notice for the same thing uses (task #3248): a tag's or a
 * decision's own key, and one per thread for its replies, so a newer reply replaces the one before and the app's notice
 * replaces the push instead of showing beside it. `quiet` shows it with no sound and no banner: it only replaces what that
 * slot showed. `thread` is a reply's thread and Activity row, by which repeats are found (push/repeats.ts).
 */
export interface PhoneNotice {
  personId: string; key: string; title: string; subtitle: string; body: string; link: string; slot: string; quiet?: true
  thread?: { tabId: string; conversationId: string; threadId: string; rowId: string; at: number }
}

/** The app's id for the notice in `slot` (mobile lib/notify/system_notices.dart swarmNoticeIdFor: FNV-1a over UTF-16 code
 *  units, kept positive at each step): APNs's collapse id, so a push and the app's notice for it are one notification. */
export function swarmNoticeId(slot: string): number {
  const text = `swarm\n${slot}`
  let hash = 0x811c9dc5
  // Math.imul keeps the product's low 32 bits, all the mask reads: Dart multiplies in 64 bits, past a double's precision.
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) & 0x7fffffff
  return hash
}

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
/** The Android channel of a quiet push (task #3248), which the app makes with no sound: Android's channel, not the message,
 *  decides whether a notification sounds. */
export const SWARM_QUIET_CHANNEL = 'swarm-quiet'

/** `promise`, or a rejection with `timeout` after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
