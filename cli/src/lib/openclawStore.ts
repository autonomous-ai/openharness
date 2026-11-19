/**
 * Where an OpenClaw session's agent database is on this machine.
 *
 * The state folder is not in the TUI's arguments (it renames its process to a bare `openclaw`) and not in the
 * transcript. What the TUI does show is the file it holds open: `<stateDir>/state/openclaw.sqlite` (`ps-*.txt`,
 * Linux `/proc/<pid>/fd`, macOS `lsof`). That is the one exact answer, and it also covers a `--profile` or `--dev`
 * TUI, whose state folder is `~/.openclaw-<name>`. Once bound, the session is read from the folder its TUI held then
 * (`RegisteredSession.openclawStateDir`): a TUI keeps its folder for life, and its pid, once it exits, can name another
 * TUI with another store. Where neither is known (Windows reads no open files), OpenClaw's own default is used:
 * `env.OPENCLAW_STATE_DIR`, resolved as OpenClaw resolves it (`OPENCLAW_STATE_DIR`, else
 * `<OPENCLAW_HOME or home>/.openclaw`).
 *
 * The agent's folder is `<stateDir>/agents/<agentId>/agent/` unless `openclaw.json` moves it
 * (`agents.entries.<id>.agentDir`). The config is read, never written.
 */
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { env } from '../config/env.js'
import { OPENCLAW_KEY, openclawAgentDb } from '../engines/openclaw/contract.js'
import { nativeHeldFiles, nativeOpenFiles } from './nativeConversation.js'
import { observeNativeFile } from '../engines/kit/nativeFileObservation.js'
import { nativeText, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import type { ProcessIdentity } from './terminalTypes.js'
import { errorKind } from './log.js'

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

/** The state folder the TUI with this pid holds open, or null when it holds none or its files cannot be read. */
export async function openclawStateDir(pid: number, openFiles: (pid: number) => Promise<string[]> = nativeOpenFiles): Promise<string | null> {
  const hit = cache.get(pid)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.stateDir
  if (pid <= 0) return null
  let held: string | null = null
  try {
    held = stateDirOfOpenFiles(await openFiles(pid))
  } catch (error) {
    // Windows has neither /proc nor lsof; a TUI that exited has no files.
    once(`[openclaw] open files of ${pid} unreadable · ${errorKind(error)}`)
  }
  if (!held) return null
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(pid, { stateDir: held, at: Date.now() })
  return held
}

/** `agents.entries.<id>.agentDir` from the state folder's config, when the person moved the agent's folder. */
function configuredAgentDir(text: string | undefined, stateDir: string, agentId: string): string | null {
  if (text === undefined) return null
  try {
    const config = JSON.parse(text) as { agents?: { entries?: Record<string, { agentDir?: unknown }> } }
    const dir = config.agents?.entries?.[agentId]?.agentDir
    if (typeof dir !== 'string' || !dir.trim()) return null
    const expanded = dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir
    return isAbsolute(expanded) ? expanded : join(stateDir, expanded)
  } catch { return nativeUnavailable('the OpenClaw location config could not be read completely') }
}

/**
 * The agent database that holds `key` (`agent:<agentId>:<key>`): in the state folder its TUI held when bound, else the
 * one the TUI with this pid holds open, else OpenClaw's default. Null for no key.
 */
export async function openclawSessionDb(
  key: string,
  pane: { pid: number; stateDir?: string | null },
  openFiles?: (pid: number) => Promise<string[]>,
): Promise<string | null> {
  if (!OPENCLAW_KEY.test(key)) return null
  const stateDir = pane.stateDir || (await openclawStateDir(pane.pid, openFiles) ?? env.OPENCLAW_STATE_DIR)
  return (await openclawSessionLocation(key, { pid: pane.pid, stateDir }))?.path ?? null
}

/** One location rule for readers and retained Close authority; no database content is inspected. */
export async function openclawSessionLocation(
  key: string, pane: { pid: number; stateDir?: string | null; processIdentity?: ProcessIdentity | null },
): Promise<{ path: string; verify(): void } | null> {
  const agentId = OPENCLAW_KEY.exec(key)?.[1]
  if (!agentId) return null
  let stateDir = pane.stateDir
  let verifyState = () => {}
  if (!stateDir) {
    // Windows has no native descriptor discovery; its documented initial location is the configured default.
    // On POSIX, only a complete current process/descriptor read can establish that no held profile overrides it.
    if (process.platform === 'win32') stateDir = env.OPENCLAW_STATE_DIR
    else {
      if (!pane.processIdentity || pane.pid !== pane.processIdentity.pid) return nativeUnavailable('the OpenClaw process identity is unavailable')
      const held = await nativeHeldFiles(pane.processIdentity, path => stateDirOfOpenFiles([path]) !== null)
      verifyState = held.verify
      const states = new Set<string>()
      for (const path of held.paths) {
        const selected = stateDirOfOpenFiles([path])
        if (!selected) return nativeUnavailable('the held OpenClaw state location is invalid')
        states.add(selected)
      }
      if (states.size > 1) return nativeUnavailable('the OpenClaw process holds more than one state folder')
      stateDir = states.values().next().value ?? env.OPENCLAW_STATE_DIR
    }
  }
  verifyState()
  try {
    const config = observeNativeFile(join(stateDir, 'openclaw.json'), { maxBytes: 1 << 20, missingOkay: true })
    const path = openclawAgentDb(stateDir, agentId, configuredAgentDir(config.bytes && nativeText(config.bytes), stateDir, agentId))
    verifyState()
    return { path, verify: () => { verifyState(); config.verify() } }
  } catch (error) {
    // Existing optional readers use the default on unreadable config. Close must call verify and cannot borrow
    // that fallback as location authority. No content or path from the config reaches this fixed diagnostic.
    once('[openclaw] LOCATION_CONFIG_UNAVAILABLE · using the default agent folder for optional reads')
    return { path: openclawAgentDb(stateDir, agentId), verify: () => { throw error } }
  }
}
