/**
 * Can this daemon read the SQLite stores at all?
 *
 * Four engines keep their conversations in SQLite rather than in a transcript file
 * (`engines/{opencode,kilo,hermes,devin}/reader.ts`), as does one branch of session repair. They read
 * through `lib/sqliteRead`: `node:sqlite` when this Node has it (the installers' Node does), else the
 * `sqlite3` CLI. macOS ships `/usr/bin/sqlite3` in the base system; a stock `ubuntu:24.04` does NOT
 * (measured), and neither does a slim Node image — so on Linux, on a Node without the binding, those
 * four engines silently mirror nothing until the user installs it.
 *
 * Resolved from PATH directly rather than by spawning: this runs on the startup path and the answer is
 * only used for one advisory log line and to gate the one path that still needs the CLI (the opencode
 * store rewrite in `sessionModel.ts`, a write the built-in binding is not used for).
 */
import { binaryOnPath } from './binaryOnPath.js'
import { builtinSqlite } from './sqliteRead.js'

/** Engines that cannot be mirrored without the CLI. Keep in sync with the readers listed above. */
export const SQLITE_BACKED_ENGINES = ['opencode', 'kilo', 'hermes', 'devin'] as const

let cached: boolean | null = null

export function hasSqliteCli(): boolean {
  if (cached !== null) return cached
  cached = binaryOnPath('sqlite3')
  return cached
}

/** Either way to read a store will do. */
export function hasSqliteReader(): boolean {
  return builtinSqlite() !== null || hasSqliteCli()
}

/** One advisory line at startup. Says what is affected and exactly how to fix it — never throws. */
export function sqlitePreflightMessage(): string | null {
  if (hasSqliteReader()) return null
  const install = process.platform === 'linux'
    ? 'sudo apt install sqlite3   (or your distro\'s equivalent)'
    : 'install the sqlite3 CLI and make sure it is on PATH'
  return `[preflight] no SQLite reader (this Node has no node:sqlite, and no sqlite3 CLI on PATH) — ${SQLITE_BACKED_ENGINES.join(', ')}`
    + ` agents cannot be mirrored. Every other engine is unaffected. Fix: ${install}`
}

/** Test seam: forget the cached answer. */
export function resetSqliteAvailabilityCache(): void { cached = null }
