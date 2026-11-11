/** Records OpenClaw fixtures from a real agent database.
 *
 * Runs where OpenClaw runs (the probe container), with Node's own sqlite and zstd, and opens the database
 * read-only. For each scenario it writes `<scenario>.sql`: INSERTs, with every column, for the rows of
 * session_nodes, session_windows, transcript_events, transcript_rewrite_watermarks and
 * session_transcript_active_events that belong to the scenario's session keys, so a test can load
 * `schema.sql` and then the scenario with STRICT tables and foreign keys on. It also writes `schema.sql`.
 *
 * Redaction, because fixtures are committed: an `openclaw.system-prompt` row keeps its route and policy
 * hash and loses its body; a tool result that shows workspace file text loses that text. A compressed row
 * is re-compressed after the edit, and its byte count is updated.
 *
 *   node record-openclaw-fixtures.mjs --out <dir> [--db <openclaw-agent.sqlite>] [--workspace <dir>]
 *     <scenario>=<sessionKey>[,<sessionKey>…] …
 */
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const REDACTED = '<redacted>';
// What a reader needs from a system-prompt row: which model route it was built for. The rest is the
// tool catalog and prompt text.
const SYSTEM_PROMPT_KEPT = new Set(['routeKey', 'restart', 'historyId', 'toolPolicy']);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, db: { type: 'string' }, workspace: { type: 'string' } },
});
if (!values.out || positionals.length === 0) {
  console.error('usage: record-openclaw-fixtures.mjs --out <dir> [--db <path>] [--workspace <dir>] <scenario>=<key>[,<key>…] …');
  process.exit(2);
}
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw');
const dbPath = values.db ?? join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
const workspace = values.workspace ?? join(stateDir, 'workspace');
const db = new DatabaseSync(dbPath, { readOnly: true });
mkdirSync(values.out, { recursive: true });

const meta = db.prepare("select role, schema_version, app_version from schema_meta where role = 'agent'").get();
const header = `-- Recorded from OpenClaw ${meta.app_version} (agent schema ${meta.schema_version}) by cli/scripts/record-openclaw-fixtures.mjs.\n`;

writeFileSync(join(values.out, 'schema.sql'), header + schemaSql());

// Lines long enough to identify a workspace file's text, wherever a tool echoes it.
const workspaceLines = readdirSync(workspace, { withFileTypes: true })
  .filter((f) => f.isFile())
  .flatMap((f) => readFileSync(join(workspace, f.name), 'utf8').split('\n'))
  .map((l) => l.trim())
  .filter((l) => l.length >= 40);

for (const arg of positionals) {
  const [scenario, keyList] = arg.split('=');
  const keys = keyList.split(',');
  const nodes = rowsFor('select * from session_nodes where session_key in (KEYS) order by created_at', keys);
  if (nodes.length !== keys.length) throw new Error(`${scenario}: ${keys.length - nodes.length} of ${keys} not found`);
  const windows = rowsFor('select * from session_windows where session_key in (KEYS) order by created_at', keys);
  const ids = windows.map((w) => w.session_id);
  const events = rowsFor('select * from transcript_events where session_id in (KEYS) order by session_id, seq', ids).map(redact);
  const watermarks = rowsFor('select * from transcript_rewrite_watermarks where session_id in (KEYS) order by session_id', ids);
  const active = rowsFor(
    'select * from session_transcript_active_events where session_id in (KEYS) order by session_id, active_position',
    ids,
  );
  const sql = [
    header + `-- Scenario ${scenario}: ${keys.join(', ')}\n`,
    inserts('session_nodes', nodes),
    inserts('session_windows', windows),
    inserts('transcript_events', events),
    inserts('transcript_rewrite_watermarks', watermarks),
    inserts('session_transcript_active_events', active),
  ].join('');
  writeFileSync(join(values.out, `${scenario}.sql`), sql);
  console.log(`${scenario}: ${nodes.length} nodes, ${windows.length} windows, ${events.length} events, ${active.length} active`);
}

/** The schema as `.schema` prints it, minus what SQLite creates by itself (internal and FTS shadow tables),
 * so the file loads into an empty database. */
function schemaSql() {
  const shadow = new Set(db.prepare("select name from pragma_table_list where type = 'shadow'").all().map((r) => r.name));
  return db
    .prepare("select name, sql from sqlite_schema where sql is not null and name not like 'sqlite_%' order by rowid")
    .all()
    .filter((r) => !shadow.has(r.name))
    .map((r) => `${r.sql};\n`)
    .join('');
}

function rowsFor(sql, list) {
  if (list.length === 0) return [];
  return db.prepare(sql.replace('KEYS', list.map(() => '?').join(','))).all(...list);
}

function redact(row) {
  const text = row.event_json ?? zstdDecompressSync(row.event_zstd).toString('utf8');
  const event = JSON.parse(text);
  if (!redactEvent(event)) return row;
  const json = JSON.stringify(event);
  const bytes = Buffer.byteLength(json);
  if (row.event_json !== null) return { ...row, event_json: json, event_utf8_bytes: row.event_utf8_bytes === null ? null : bytes };
  return { ...row, event_zstd: zstdCompressSync(Buffer.from(json, 'utf8')), event_utf8_bytes: bytes };
}

/** Edits the event in place; true when something was redacted. */
function redactEvent(event) {
  if (event.type === 'custom' && event.customType === 'openclaw.system-prompt' && event.data) {
    let changed = false;
    for (const k of Object.keys(event.data)) {
      if (SYSTEM_PROMPT_KEPT.has(k) || event.data[k] === REDACTED) continue;
      event.data[k] = REDACTED;
      changed = true;
    }
    return changed;
  }
  const message = event.type === 'message' ? event.message : undefined;
  if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return false;
  const showsWorkspace = (s) => typeof s === 'string' && workspaceLines.some((l) => s.includes(l));
  let changed = false;
  for (const part of message.content) {
    if (part.type === 'text' && showsWorkspace(part.text)) (part.text = REDACTED), (changed = true);
  }
  if (message.details && showsWorkspace(message.details.aggregated)) (message.details.aggregated = REDACTED), (changed = true);
  return changed;
}

function inserts(table, rows) {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
  return head + rows.map((r) => `  (${columns.map((c) => literal(r[c])).join(', ')})`).join(',\n') + ';\n';
}

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}
