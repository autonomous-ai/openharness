/** Pi's folder is lossy. Only its complete first entry establishes the session id and cwd. */
import type { SessionFolder, SessionHeader } from '../kit/sessionIdentity.js'

// Pi accepts custom ids. A .jsonl suffix makes --session interpret the value as a file instead.
export const PI_SESSION_ID = /^(?!.*\.jsonl$)[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/
export const PI_HEADER: SessionHeader = {
  bytes: [16 * 1024, 1024 * 1024], type: 'session',
  id: { field: ['id'], pattern: PI_SESSION_ID }, cwd: ['cwd'],
}
export const PI_FOLDER: SessionFolder = {
  prefix: '--', suffix: '--', trim: /^[/\\]/, mangle: /[/\\:]/g, replacement: '-',
}
