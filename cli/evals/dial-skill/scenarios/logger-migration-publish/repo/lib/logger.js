// The new logger: one JSON record per line on stderr, so the log pipeline can index each event and its fields.
const LEVELS = ['debug', 'info', 'warn', 'error']
const EVENT = /^[a-z][a-z0-9_]*$/
const threshold = Math.max(0, LEVELS.indexOf(process.env.LOG_LEVEL ?? 'info'))

const isPlain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

function record(name, base, level, args) {
  const [event, fields = {}] = args
  // Checked before the level filter, so a call in an old shape fails in tests even when its level is not written.
  if (args.length > 2) throw new TypeError(`${name}: log.${level} takes (event, fields), got ${args.length} arguments`)
  if (typeof event !== 'string' || !EVENT.test(event)) {
    throw new TypeError(`${name}: log.${level} needs a snake_case event, got ${JSON.stringify(event)}`)
  }
  if (!isPlain(fields)) throw new TypeError(`${name}: log.${level} fields must be a plain object`)
  if (LEVELS.indexOf(level) < threshold) return
  const out = { time: new Date().toISOString(), level, pkg: name, event, ...base, ...fields }
  if (fields.error instanceof Error) out.error = { name: fields.error.name, message: fields.error.message }
  process.stderr.write(`${JSON.stringify(out)}\n`)
}

export function createLogger(name, base = {}) {
  const logger = Object.fromEntries(LEVELS.map((level) => [level, (...args) => record(name, base, level, args)]))
  logger.child = (fields) => createLogger(name, { ...base, ...fields })
  return logger
}
