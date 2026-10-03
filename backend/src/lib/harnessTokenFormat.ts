import { createHash, randomBytes } from 'node:crypto'

/**
 * The shape of the tokens Harness issues itself (lib/harnessSession.ts), apart from the store behind
 * them — so the auth path everything imports (lib/ssoAuth.ts) can tell one from an Autonomous token
 * without importing Redis, which connects on import.
 *
 * A prefix, then 32 random bytes: an Autonomous access token is a JWT (`eyJ…`), so the two can never
 * be mistaken for each other, and a token that turns up in a log says where it came from.
 */
export const HARNESS_ACCESS_PREFIX = 'hna_'
export const HARNESS_REFRESH_PREFIX = 'hnr_'
export const HARNESS_HANDOFF_PREFIX = 'hnh_'
/** In a computer's sign-in QR: what the phone that scans it approves. */
export const HARNESS_QR_PREFIX = 'hnq_'
/** Held by the computer showing that QR, to learn the answer and claim the session. Never shown. */
export const HARNESS_QR_POLL_PREFIX = 'hnp_'

const BODY = /^[A-Za-z0-9_-]{43}$/

const shaped = (token: unknown, prefix: string): token is string =>
  typeof token === 'string' && token.startsWith(prefix) && BODY.test(token.slice(prefix.length))

export const isHarnessAccessToken = (token: unknown): token is string => shaped(token, HARNESS_ACCESS_PREFIX)
export const isHarnessRefreshToken = (token: unknown): token is string => shaped(token, HARNESS_REFRESH_PREFIX)
export const isHarnessHandoffCode = (token: unknown): token is string => shaped(token, HARNESS_HANDOFF_PREFIX)
export const isHarnessQrCode = (token: unknown): token is string => shaped(token, HARNESS_QR_PREFIX)
export const isHarnessQrPollToken = (token: unknown): token is string => shaped(token, HARNESS_QR_POLL_PREFIX)

export function newHarnessToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

/** Only this is ever stored: a dump of Redis or Mongo must not be a key store. */
export function harnessTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
