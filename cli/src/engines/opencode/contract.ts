/**
 * What the core knows of OpenCode without loading its code: declared data, read in line where a launch is built
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of OpenCode's code.
 */

/** The first major whose TUI rejects `-m` / `--agent` and whose sessions live behind its API. */
const OPENCODE_V2_MAJOR = 2

/** Whether a major version (`engines/opencode/version.ts` reads it) is v2 or later; unknown reads as v1. */
export function isOpencodeV2(major: number | null | undefined): boolean {
  return (major ?? 0) >= OPENCODE_V2_MAJOR
}

export const OPENCODE_VERSION = { output: /(\d+)\.\d+\.\d+/, args: ['--version'], timeoutMs: 5_000 } as const

/** Native model changes: v1's picker transaction and v2's service protocol, measured before extraction. */
export const OPENCODE_SESSION_MODEL = {
  label: 'opencode', serviceMajor: OPENCODE_V2_MAJOR, id: /^[A-Za-z0-9_]+$/,
  modelFlags: ['-m', '--model'], modelEquals: '--model=', variantSeparator: '#',
  errors: { sqliteMissing: 'OPENCODE_SQLITE_MISSING', sessionMissing: 'OPENCODE_SESSION_NOT_FOUND',
    writeFailed: 'OPENCODE_DB_WRITE_FAILED', binaryMissing: 'OPENCODE_MISSING',
    switchFailed: 'OPENCODE_MODEL_SWITCH_FAILED', unknownModel: 'OPENCODE_MODEL_UNKNOWN' },
  sqlite: { args: ['-batch', '-bail'], timeoutMs: 15_000, statements: [
    'PRAGMA busy_timeout = 5000;',
    'BEGIN IMMEDIATE;',
    "UPDATE message SET data = json_set(data, '$.model.providerID', {{provider}}, '$.model.modelID', {{model}}) WHERE id = (SELECT id FROM message WHERE session_id = {{session}} AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 1);",
    'SELECT changes();',
    "UPDATE session SET model = json_object('id', {{model}}, 'providerID', {{provider}}, 'variant', 'default') WHERE id = {{session}} AND EXISTS (SELECT 1 FROM message WHERE session_id = {{session}} AND json_extract(data, '$.role') = 'user');",
    'SELECT changes();',
    'COMMIT;',
  ] },
  api: { timeoutMs: 15_000, retryDelayMs: 1_000, list: ['api', 'model.list'], switch: ['api', 'session.switchModel'],
    get: ['api', 'session.get'], paramFlag: '--param', sessionParam: 'sessionID', bodyFlag: '-d',
    missingSession: /SessionNotFoundError|HTTP 404/,
    fields: { data: 'data', model: 'model', id: 'id', alternativeId: 'modelID', provider: 'providerID', variant: 'variant' },
  },
} as const
