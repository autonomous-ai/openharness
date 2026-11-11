/**
 * OpenClaw: one SQLite store per agent, `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite` (agent schema 27,
 * OpenClaw 2026.11.2, `engines/openclaw/__fixtures__/`). `session_nodes` holds one row a key (`agent:<id>:<key>`, the
 * id a TUI resumes), with how it was made (`created_via`), its name (`label`, `display_name`) and when it last moved
 * (`last_activity_at`, epoch ms). The conversation itself is `transcript_events`, read through the engine's reader.
 *
 * Sub-agent runs (`spawn`), scheduled ones (`cron`) and OpenClaw's own (`internal`) are nobody's conversation, and a
 * recap or a resume of one would spend the person's quota on a run they never started: they are never offered.
 * The store's `session_transcript_fts` holds no text in the recorded stores, so the index reads the history.
 *
 * The TUI renames its process to a bare `openclaw` and holds only the Gateway's state database open, never the agent
 * store: nothing says which key a process has open, so no owner is claimed.
 */
import { join } from 'node:path'
import { OPENCLAW_KEY, openclawAgentDb } from '../../../engines/openclaw/contract.js'
import { openclawMessagesToEvents } from '../../../engines/openclaw/normalizer.js'
import { readOpenclawHistory } from '../../../engines/openclaw/reader.js'
import { hasSqliteReader } from '../../sqliteAvailability.js'
import { LIST_LIMIT, checkedSql, readSql, rowsOf, splitCounts, storeStamp, tally, type Counting, type SqlRead, type Tally } from './opencode.js'
import { absoluteFolder, entries, epochMs, text } from './support.js'
import type { ExternalProvider, ExternalSession, ScanContext } from './types.js'
import { externalReadFailed } from '../evidence.js'

export interface OpenclawOptions {
  stateDir: string
  /** How a statement is run; tests replace it. */
  read?: SqlRead
  /** Whether this machine can read SQLite at all; tests replace it. */
  available?: () => boolean
}

/** Agents a scan looks into: a person has `main` and maybe a few more, never hundreds. */
const MAX_AGENTS = 16
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The newest keys a person made, with the folder their window's header names, and how many rows each rule kept out
 * (a row with a null id is a count). A key with no message row was never used.
 */
const LIST_SQL = "SELECT * FROM (SELECT n.session_key AS id, coalesce(n.label, n.display_name, '') AS title,"
  + ' coalesce(n.last_activity_at, n.updated_at) AS active,'
  + " (SELECT CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.cwd') END FROM transcript_events e"
  + ' WHERE e.session_id = n.current_session_id AND e.seq = 0) AS cwd, \'\' AS skip, NULL AS n'
  + ' FROM session_nodes n WHERE coalesce(n.created_via, \'\') NOT IN (\'spawn\', \'cron\', \'internal\')'
  + " AND EXISTS (SELECT 1 FROM transcript_events m WHERE m.session_id = n.current_session_id AND m.message_role IN ('user', 'assistant'))"
  + ` ORDER BY coalesce(n.last_activity_at, n.updated_at, 0) DESC LIMIT ${LIST_LIMIT})`
  + " UNION ALL SELECT NULL, NULL, NULL, NULL, CASE WHEN coalesce(created_via, '') IN ('spawn', 'cron', 'internal') THEN created_via ELSE '' END AS skip,"
  + ' count(*) AS n FROM session_nodes GROUP BY skip'

export function openclawProvider(options: OpenclawOptions): ExternalProvider & Counting {
  const read = checkedSql(options.read ?? readSql)
  const available = options.available ?? hasSqliteReader
  let counts: Tally = {}
  return {
    engine: 'openclaw',
    lastScan: () => counts,
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      counts = {}
      if (!available()) { externalReadFailed(new Error('SQLite unavailable'), 'conversation reader'); return [] }
      const agents = (await entries(join(options.stateDir, 'agents')))
        .filter((entry) => entry.isDirectory() && AGENT_ID.test(entry.name)).slice(0, MAX_AGENTS)
      const found: ExternalSession[] = []
      for (const agent of agents) {
        const dbPath = openclawAgentDb(options.stateDir, agent.name)
        const stamp = await storeStamp(dbPath)
        if (!stamp) continue
        const listed = await ctx.memo(`openclaw:${dbPath}`, stamp, async () => {
          const rows = await rowsOf(read, dbPath, LIST_SQL)
          return rows && splitCounts(rows)
        })
        await ctx.pace()
        if (!listed) continue
        for (const [reason, n] of Object.entries(listed.counts)) tally(counts, reason, n)
        for (const row of listed.rows) {
          const key = text(row.id)
          if (!OPENCLAW_KEY.test(key)) { tally(counts, 'badId'); continue }
          // A session `/model` made before any message records `/`, the Gateway's own folder: nowhere to resume it.
          const cwd = absoluteFolder(row.cwd)
          if (!cwd || cwd === '/') { tally(counts, 'noFolder'); continue }
          if (ctx.excluded(cwd)) { tally(counts, 'excluded'); continue }
          found.push({
            sessionId: key, engine: 'openclaw', cwd, origin: 'terminal', title: text(row.title).trim(),
            mtime: epochMs(row.active) ?? 0, transcriptPath: null,
            readHistory: async () => openclawMessagesToEvents(await readOpenclawHistory(dbPath, key)),
          })
        }
      }
      counts.found = found.length
      return found
    },
  }
}
