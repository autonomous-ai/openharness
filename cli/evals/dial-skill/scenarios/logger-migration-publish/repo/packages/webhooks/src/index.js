import { log } from '../../../lib/logger-v1.js'

export async function deliver(url, body, send) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await send(url, body)
      log.info(`delivered to ${url} on attempt ${attempt}`)
      return true
    } catch (err) {
      log.error('delivery failed', err)
    }
  }
  log.warn(`gave up on ${url}`)
  return false
}
