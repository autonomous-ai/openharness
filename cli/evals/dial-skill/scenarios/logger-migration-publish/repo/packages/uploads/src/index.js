import { scoped } from '../../../lib/logger-v1.js'

const log = scoped('[uploads]')
const MAX_BYTES = 5 * 1024 * 1024

export function accept(file) {
  if (file.size > MAX_BYTES) {
    log.warn('rejected %s: %d bytes', file.name, file.size)
    return false
  }
  if (!/\.(png|jpe?g|pdf)$/i.test(file.name)) {
    log.warn(`rejected ${file.name}: type not allowed`)
    return false
  }
  log.info('accepted', { name: file.name, size: file.size })
  return true
}
