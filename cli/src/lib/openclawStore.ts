/**
 * Where an OpenClaw session's agent database is on this machine.
 *
 * The state folder is not in the TUI's arguments (it renames its process to a bare `openclaw`) and not in the
 * transcript. What the TUI does show is the file it holds open: `<stateDir>/state/openclaw.sqlite` (`ps-*.txt`,
 * Linux `/proc/<pid>/fd`, macOS `lsof`). That is the one exact answer, and it also covers a `--profile` or `--dev`
 * TUI, whose state folder is `~/.openclaw-<name>`. Where open files cannot be read (Windows), or for a session
 * whose TUI has exited, OpenClaw's own default is used: `OPENCLAW_STATE_DIR`, else `~/.openclaw`.
 *
 * The agent's folder is `<stateDir>/agents/<agentId>/agent/` unless `openclaw.json` moves it
 * (`agents.entries.<id>.agentDir`). The config is read, never written.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { env } from '../config/env.js'
import { OPENCLAW_KEY, openclawAgentDb } from '../engines/openclaw/contract.js'
import { nativeOpenFiles } from './nativeConversation.js'

/** A TUI keeps its state folder for its whole life; a pid read again after this long may be another process. */
const CACHE_MS = 60_000
const CACHE_LIMIT = 64
const cache = new Map<number, { stateDir: string; at: number }>()
const said = new Set<string>()

function once(line: string): void {
  if (said.has(line)) return
  if (said.size >= CACHE_LIMIT) said.clear()
  said.add(line)
  console.warn(line)
}

/** The state folder from the files a TUI holds open, or null when it holds no state database. */
export function stateDirOfOpenFiles(files: readonly string[]): string | null {
  const database = files.find((file) => basename(file) === 'openclaw.sqlite' && basename(dirname(file)) === 'state')
  return database ? dirname(dirname(database)) : null
}

/** The state folder of the TUI with this pid: its open state database, else OpenClaw's default. */
export async function openclawStateDir(pid: number, openFiles: (pid: number) => Promise<string[]> = nativeOpenFiles): Promise<string> {
  const hit = cache.get(pid)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.stateDir
  let held: string | null = null
  if (pid > 0) {
    try {
      held = stateDirOfOpenFiles(await openFiles(pid))
    } catch (error) {
      // Windows has neither /proc nor lsof; a TUI that exited has no files. The default is still right for most.
      once(`[openclaw] open files of ${pid} unreadable · ${error instanceof Error ? error.message : String(error)} · using ${env.OPENCLAW_STATE_DIR}`)
    }
  }
  if (!held) return env.OPENCLAW_STATE_DIR
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(pid, { stateDir: held, at: Date.now() })
  return held
}

/** `agents.entries.<id>.agentDir` from the state folder's config, when the person moved the agent's folder. */
async function configuredAgentDir(stateDir: string, agentId: string): Promise<string | null> {
  const path = join(stateDir, 'openclaw.json')
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return null }
  try {
    const config = JSON.parse(text) as { agents?: { entries?: Record<string, { agentDir?: unknown }> } }
    const dir = config.agents?.entries?.[agentId]?.agentDir
    if (typeof dir !== 'string' || !dir.trim()) return null
    const expanded = dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir
    return isAbsolute(expanded) ? expanded : join(stateDir, expanded)
  } catch (error) {
    once(`[openclaw] ${path} unreadable · ${error instanceof Error ? error.name : 'unknown'} · using the default agent folder`)
    return null
  }
}

/** The agent database that holds `key` (`agent:<agentId>:<key>`), for the TUI with this pid; null for no key. */
export async function openclawSessionDb(key: string, pane: { pid: number }, openFiles?: (pid: number) => Promise<string[]>): Promise<string | null> {
  const agentId = OPENCLAW_KEY.exec(key)?.[1]
  if (!agentId) return null
  const stateDir = await openclawStateDir(pane.pid, openFiles)
  return openclawAgentDb(stateDir, agentId, await configuredAgentDir(stateDir, agentId))
}
