/**
 * Where an engine's hook finds the daemon that made its pane.
 *
 * Claude Code's and Codex's hooks are installed once per computer (~/.claude/settings.json,
 * $CODEX_HOME/hooks.json), and the command each daemon installs names its own port and data folder. With
 * two daemons on one computer, a dev daemon beside the release one, the last to start rewrote the entry,
 * and every other daemon's agents' hooks went to it and were turned away: the pane was not its own.
 *
 * So each daemon also records, once it is listening, its data folder and port under the tag it puts on
 * every pane it makes (`harnessPaneOwner`, `@harness_daemon`), one file per tag in a folder all of this
 * user's daemons share. The hook (hook/notify.mjs `routeToPaneOwner`) reads the tag off its pane, finds the
 * record, checks the data folder in it hashes to that tag, and reports there, whichever daemon's command
 * ran it. The installed entry stays one entry; its own `--port` and `--data-dir` serve a pane without a
 * tag, or one whose daemon keeps no record (an older build), as before.
 *
 * A record is never removed when its daemon stops: a hook for that daemon's pane then fails to post, and
 * its offline write lands in that daemon's own registry, which it reads when it is back. Removed, the
 * hook would fall back to the command's daemon, which turns away a pane that is not its own.
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { harnessPaneOwner } from './harnessSessionLabel.js'

export interface HookRoute {
  /** The daemon's data folder, symlinks resolved: where the hook reads its credential and writes offline. */
  dataDir: string
  /** The TCP port the daemon's hook server bound. */
  port: number
}

export function hookRouteFile(tag: string, dir: string = env.HARNESS_HOOK_ROUTES_DIR): string {
  return join(dir, `${tag}.json`)
}

function canonical(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/**
 * Record that the daemon of [dataDir] listens on [port], for hooks from the panes it tags. Called once
 * the hook server is bound, with the port it bound. Never throws: a daemon that cannot write the record
 * still serves every hook of a command it installed itself, and says why the others may miss it.
 */
export function publishHookRoute(dataDir: string, port: number, dir: string = env.HARNESS_HOOK_ROUTES_DIR): void {
  const tag = harnessPaneOwner(dataDir)
  const target = hookRouteFile(tag, dir)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // The hook refuses a folder or record others can write (notify.mjs secureStateDirectory): it would
    // send this daemon's hook credential wherever such a record pointed.
    chmodSync(dir, 0o700)
    writeFileSync(temporary, JSON.stringify({ dataDir: canonical(dataDir), port } satisfies HookRoute) + '\n', { mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    console.warn(`[hooks] could not record this daemon's hook route in ${dir}: ${error instanceof Error ? error.message : error}`
      + ' · hooks installed by another daemon will not reach this one\'s agents')
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** The record for [tag], as the hook reads it; null when there is none or it is not that tag's own. */
export function readHookRoute(tag: string, dir: string = env.HARNESS_HOOK_ROUTES_DIR): HookRoute | null {
  try {
    const value = JSON.parse(readFileSync(hookRouteFile(tag, dir), 'utf8')) as Partial<HookRoute>
    if (typeof value.dataDir !== 'string' || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65_535) return null
    return harnessPaneOwner(value.dataDir) === tag ? { dataDir: value.dataDir, port: value.port! } : null
  } catch { return null }
}
