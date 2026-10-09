/**
 * Put a RESUMED opencode session on a model, by writing what its own picker writes.
 *
 * ## Why a session launched with `-m` needs this at all
 *
 * When `opencode --session <id>` loads, the TUI sets its current model from the LAST USER MESSAGE's
 * `data.model` (`{providerID, modelID, variant?}` — `packages/tui/src/component/prompt/index.tsx`,
 * v1.18.31), which overrides `-m`; the server's prompt path falls back to the `session.model` column
 * (`{"id","providerID","variant":"default"}`). Nothing else — config `model`, `model.json`, `--fork`
 * — changes a resumed session's model (upstream: anomalyco/opencode #26901, #26351, #45204). So a
 * retarget that respawns with `--session` lands the right provider, key and argv on a pane that then
 * answers on the OLD model, and only the engine's own footer says so.
 *
 * The picker is the only writer opencode ships, and what it writes is those two rows. This writes the
 * same two rows, through SQL, in one transaction, before the respawn — so the TUI opens already on
 * the model, with nothing typed into it and no dependence on the picker's layout.
 *
 * ## Access
 *
 * The `sqlite3` CLI, exactly as `reader.ts` reads this DB: same binary, same `ENOENT` → "sqlite3
 * missing", no native dependency. opencode opens the DB in WAL mode with its own `busy_timeout 5000`,
 * so a concurrent UPDATE from here is safe; `PRAGMA busy_timeout` on this side covers a write that
 * lands during its checkpoint. ⚠️ Never copy, replace or delete the DB or its `-wal` / `-shm` files:
 * other opencode processes have them open, and that is how this DB was damaged during research.
 *
 * ## Rows
 *
 * Only the session's latest user message and its `session` row. Assistant messages, older user
 * messages, `event` rows and every other session are left alone. A session with no user message yet
 * has nothing to rewrite — and does not need it: with no message to restore from, the TUI takes `-m`
 * on the respawn. That case is reported as `OPENCODE_SESSION_NOT_FOUND` and the caller proceeds.
 *
 * ## v2
 *
 * Everything above is 1.x. OpenCode 2.0 keeps its sessions in `session_v2` / `session_message` (the
 * v1 tables are still there, and empty for every new session — so the SQL above finds nothing and
 * answers `OPENCODE_SESSION_NOT_FOUND`, which the retarget used to read as fine), its TUI has no
 * `-m`, and one background service owns the store. It also ships a writer: the service's
 * `session.switchModel` operation, reachable as `opencode api session.switchModel`. Measured on
 * 2.0.18 against a scratch session: the row's model changed, a `model-switched` message was
 * appended, a TUI attached to the session switched live, and `opencode -s <id>` (with or without
 * `--standalone`) reopened on the new model. So on v2 this goes through the API and never touches
 * the DB — [switchOpencodeSessionModel]. The service accepts a model it does not know without
 * complaint, so success is read back with `session.get` rather than assumed.
 */

export { opencodeModelFromArgv, parseOpencodeModelId, setOpencodeSessionModel, switchOpencodeSessionModel, applyOpencodeSessionModel } from '../launchControl.js'
export type { OpencodeSessionModel, SetOpencodeSessionModelResult, OpencodeApiRun } from '../launchControl.js'
