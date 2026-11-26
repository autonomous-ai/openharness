// The old logger: printf-style text lines on stderr. Deprecated: MIGRATION.md moves every package to ./logger.js.
import { format } from 'node:util'

const LEVELS = ['debug', 'info', 'warn', 'error']
const threshold = Math.max(0, LEVELS.indexOf(process.env.LOG_LEVEL ?? 'info'))

function write(level, prefix, args) {
  if (LEVELS.indexOf(level) < threshold) return
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${prefix}${format(...args)}\n`)
}

function make(prefix) {
  return Object.fromEntries(LEVELS.map((level) => [level, (...args) => write(level, prefix, args)]))
}

export const log = make('')

export function scoped(prefix) {
  return make(`${prefix} `)
}

export function timed(label, fn) {
  const started = performance.now()
  try {
    return fn()
  } finally {
    log.info('%s took %dms', label, Math.round(performance.now() - started))
  }
}
