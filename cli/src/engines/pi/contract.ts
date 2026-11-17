import type { SessionFolder, SessionHeader } from '../kit/sessionIdentity.js'


// Pi accepts custom ids. A .jsonl suffix makes --session interpret the value as a file instead.
export const PI_SESSION_ID = /^(?!.*\.jsonl$)[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/

export const PI_HEADER: SessionHeader = {
  bytes: [16 * 1024, 1024 * 1024], type: 'session',
  id: { field: ['id'], pattern: PI_SESSION_ID }, cwd: ['cwd'],
}

/** Bound control checks the same native header and canonical workspace as exact discovery. */
export const PI_CONTROL_IDENTITY = {
  maxBytes: PI_HEADER.bytes.at(-1)!, maxRecords: 1, type: PI_HEADER.type,
  id: PI_HEADER.id.field, idPattern: PI_HEADER.id.pattern, cwd: PI_HEADER.cwd, canonicalWorkspace: true,
} as const satisfies import('../kit/controlIdentity.js').ControlIdentityRule

export const PI_FOLDER: SessionFolder = {
  prefix: '--', suffix: '--', trim: /^[/\\]/, mangle: /[/\\:]/g, replacement: '-',
}
