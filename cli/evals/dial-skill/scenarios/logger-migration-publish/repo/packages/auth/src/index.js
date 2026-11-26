import { log } from '../../../lib/logger-v1.js'

export function parseClaims(token) {
  try {
    const [, payload] = token.split('.')
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (err) {
    log.error('could not parse token claims', err)
    return null
  }
}

export function isExpired(claims, now = Date.now()) {
  const expired = claims.exp * 1000 <= now
  if (expired) log.info(`token for ${claims.sub} expired`)
  return expired
}
