import { scoped } from '../../../lib/logger-v1.js'

const log = scoped('[mailer]')

export function send(to, subject) {
  if (!to.includes('@')) {
    log.warn(`skipped ${to}: not an address`)
    return false
  }
  log.info(`sent "${subject}" to ${to}`)
  return true
}
