import { log } from '../../../lib/logger-v1.js'

export function nextRun(everyMinutes, last) {
  if (everyMinutes < 1) {
    log.error('bad interval %d', everyMinutes)
    throw new RangeError('interval must be at least one minute')
  }
  const next = new Date(last.getTime() + everyMinutes * 60_000)
  log.debug('next run', { at: next.toISOString() })
  return next
}
