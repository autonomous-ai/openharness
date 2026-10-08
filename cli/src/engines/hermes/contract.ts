/**
 * What the core knows of Hermes without loading its code: declared data (docs/design/2026-10-08-other-engines-out-of-
 * core.md). It imports nothing of Hermes's code.
 */
import { join } from 'node:path'

/** The store a Hermes home keeps its sessions in. */
export function hermesDbPath(home: string): string {
  return join(home, 'state.db')
}

/**
 * Every id a Hermes store keeps a conversation under: the CLI's and the gateway's (`YYYYMMDD_HHMMSS_<hex>`), and
 * an editor's. The ACP adapter names its sessions with a uuid4 (`acp_adapter/session.py`; all six ACP rows on the
 * machine measured were uuids), so their history is readable too. `hermesSessionSource` keeps the narrower shape:
 * it decides whether a hook's session is a pane's own, and editors' sessions never are.
 */
export const HERMES_HISTORY_ID_RE =
  /^(?:[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
