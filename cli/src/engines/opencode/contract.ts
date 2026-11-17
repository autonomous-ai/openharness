

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


/**
 * Whether an OpenCode 2 session is in a turn, by its own record. v2 keeps its conversation in `session_message`
 * (the `message` table the transcript reader polls stays empty, so the daemon's turn state never opens for it)
 * and writes a `user` row as a turn starts and an `idle` row as it ends — `outcome` succeeded, interrupted or
 * failed alike. Measured on 2.0.24's store: 550 `idle` rows since it began writing them (2026-09-28), and no
 * session since left with a `user` after its last `idle`.
 * Real OpenCode 2.0.29 stores show 18 row pairs that disagree with seq ordering and 40 (session_id, time_created)
 * ties. Rows are read by time_created first, seq only tying within the millisecond, the same order the readers use.
 */
export const OPENCODE_V2_TURN = {
  sql: "SELECT type FROM session_message WHERE session_id = ? AND type IN ('user', 'idle') ORDER BY time_created DESC, seq DESC LIMIT 1;",
  opens: 'user',
} as const


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
