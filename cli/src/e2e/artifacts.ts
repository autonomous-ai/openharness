/**
 * artifacts — where a run leaves what people and the watchdog read AFTERWARDS.
 *
 * Two places, on purpose:
 *   - `outDir()`: scratch under $TMPDIR (`grid-matrix-out/`) — the agent's workspace, dry-run reports.
 *   - `runDir(session)`: the durable review bundle, under the harness's own data dir
 *     (`<ADAPTER_DATA_DIR>/e2e/runs/<session>/`), one folder per run:
 *         trace.json        the report (legs, trace, pane tails, watchdog verdict)
 *         manifest.json     ids + how to reopen everything (opencode session, daemon log, workspace)
 *         daemon.log        the daemon's lines for this run's agent/session, cut from harness.log
 *         watchdog.jsonl    the opencode agent's raw event stream (every tool call it made)
 *         watchdog.md       its review, as text
 *         workspace/        tools/, .codex/ or .mcp.json, .e2e/*.log — the tool/MCP call logs
 *         evidence/         what the watchdog saved while reproducing (proxy req/res, bisect table)
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { env } from '../config/env.js'

export function outDir(): string {
  const dir = join(tmpdir(), 'grid-matrix-out')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function runsRoot(): string {
  return join(env.ADAPTER_DATA_DIR, 'e2e', 'runs')
}

export function runDir(session: string): string {
  const dir = join(runsRoot(), session.replace(/[^A-Za-z0-9._@>-]/g, '-'))
  mkdirSync(join(dir, 'evidence'), { recursive: true })
  return dir
}
