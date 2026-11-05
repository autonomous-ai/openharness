/**
 * The Team account model API on Windows (./model.ts). The Mac writes it as root inside the Team home. On Windows that
 * would be an elevated write in a folder the Team account controls, where a link it planted could aim the write anywhere.
 * So it goes as the sign-in does: the owner leaves it in the handover folder (./windowsScript.ts), which only they, the
 * Team account and administrators can open, and the Team daemon takes it and writes its own files, as itself, with no
 * administrator prompt. Read fresh by every launch (lib/apiConnections.ts), so its daemon needs no restart.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from "node:path"
import { WINDOWS_TEAM_HANDOFF_DIR } from "./windowsLayout.js"
import type { TeamStatus } from "./privacy.js"

export const WINDOWS_TEAM_MODEL_FILE = `${WINDOWS_TEAM_HANDOFF_DIR}\\team-model`
/** A saved API and its settings: far under this. A file over it is no handover. */
const MAX_BYTES = 64 * 1024

export interface TeamModelHandoff { connections: string; payload: string }

/** The owner side. Never through a link: the folder must be a plain one, and any file there a plain file. */
export function writeModelHandoff(handoff: TeamModelHandoff, file: string = WINDOWS_TEAM_MODEL_FILE): void {
  const folder = lstatSync(dirname(file))
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("the handover folder is not a plain folder: run harness team setup again")
  writeFileSync(file, JSON.stringify(handoff))
}

/** The Team account side: what the owner left, read once and deleted, or null. What is not one is deleted unread. */
export function takeModelHandoff(file: string = WINDOWS_TEAM_MODEL_FILE): TeamModelHandoff | null {
  let info
  try { info = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) {
    unlinkSync(file)
    throw new Error("the model handover was not a plain file; it was deleted unread")
  }
  const text = readFileSync(file, "utf8")
  unlinkSync(file)
  try {
    const parsed = JSON.parse(text) as Partial<TeamModelHandoff>
    if (typeof parsed.connections === "string" && typeof parsed.payload === "string") return { connections: parsed.connections, payload: parsed.payload }
  } catch { /* said below */ }
  throw new Error("that file was not a model handover; it was deleted")
}

function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const next = `${file}.${process.pid}.next`
  writeFileSync(next, text, { mode: 0o600 })
  renameSync(next, file)
}

/** As ./model.ts MERGE does on a Mac: only the engine keys it owns change, and a clear removes only those. */
export function applyTeamModel(handoff: TeamModelHandoff, places: { home: string; dataDir: string }): void {
  const payload = JSON.parse(handoff.payload) as { clear: boolean; model?: string; env?: Record<string, string> }
  const saved = join(places.dataDir, "api-connections", "connections.json")
  if (payload.clear) rmSync(saved, { force: true })
  else writeAtomically(saved, handoff.connections)
  const settingsFile = join(places.home, ".claude", "settings.json")
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown> } catch { /* none yet */ }
  const env = settings.env && typeof settings.env === "object" ? { ...settings.env as Record<string, string> } : {}
  for (const key of payload.clear ? ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] : Object.keys(payload.env ?? {})) delete env[key]
  if (!payload.clear) Object.assign(env, payload.env)
  if (Object.keys(env).length) settings.env = env
  else delete settings.env
  if (payload.clear) delete settings.model
  else settings.model = payload.model
  writeAtomically(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
}

/** One look, from the Team daemon. Tells the owner through the status file, never with the key. Never throws. */
export function receiveTeamModel(input: { file?: string; home: string; dataDir: string; now: () => number
  report: (update: Pick<TeamStatus, "model">) => void }): void {
  try {
    const handoff = takeModelHandoff(input.file)
    if (!handoff) return
    applyTeamModel(handoff, input)
    input.report({ model: { state: "applied", at: input.now() } })
  } catch (error) {
    try { input.report({ model: { state: "failed", at: input.now(), detail: (error as Error).message } }) } catch { /* the owner times out, and says so */ }
  }
}
