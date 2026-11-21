/**
 * The MCP servers a folder inherits from the folders above it, settled as the engine's own question settles them by
 * default (facets/launch.ts `InheritedMcpContract`). Recorded only where the folder's trust is (engines/launchPrep.ts):
 * a folder Harness made empty itself, whose every question is Harness's to answer so its agent starts at once.
 *
 * Only ever adds the engine's default answer, "no", for a server nobody decided: never for one in the folder itself (that
 * folder's content is the person's), never for one the person's user settings decide, never over a settings file that
 * does not parse. Nothing else in a file is changed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InheritedMcpContract } from '../facets/launch.js'
import { replaceConfigFile } from './folderTrust.js'

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file's JSON object; null for none, or anything but an object. */
function readObject(file: string): Record<string, unknown> | null {
  try { return mcpObject(readFileSync(file, 'utf8')) } catch { return null }
}

export function mcpObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try { const value: unknown = JSON.parse(text); return isPlainObject(value) ? value : null } catch { return null }
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** The servers named by the project file in every folder above [folder], nearest first, each once. */
function inherited(contract: InheritedMcpContract, folder: string): string[] {
  const found: string[] = []
  for (let above = dirname(folder); ; above = dirname(above)) {
    const servers = readObject(join(above, contract.file))?.[contract.servers]
    if (isPlainObject(servers)) for (const name of Object.keys(servers)) if (!found.includes(name)) found.push(name)
    if (dirname(above) === above) return found
  }
}

/**
 * Record the engine's default "no" in [folder] for each server it inherits that nobody decided, as its question would on
 * Enter. [userHome] is the engine's home, whose user settings the person's decisions are in. Returns the names it
 * recorded now.
 */
export function recordInheritedMcp(contract: InheritedMcpContract, folder: string, userHome: string): string[] {
  const servers = inherited(contract, folder)
  if (!servers.length) return []
  const user = readObject(join(userHome, contract.user.file)) ?? {}
  const file = join(folder, contract.settings)
  const exists = existsSync(file)
  const settings = exists ? readObject(file) : {}
  const prepared = prepareInheritedMcp(contract, servers, user, settings)
  if (!prepared) return []
  const { text, fresh } = prepared
  if (exists) replaceConfigFile(file, text)
  else {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.harness-${process.pid}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, file)
  }
  return fresh
}

/** Shared with setup: only the native default negative answer is added. */
export function prepareInheritedMcp(contract: InheritedMcpContract, servers: readonly string[], user: Record<string, unknown>,
  settings: Record<string, unknown> | null): { text: string; fresh: string[] } | null {
  if (user[contract.user.approveAll] === true) return null
  const decided = new Set([...names(user[contract.user.approved]), ...names(user[contract.user.rejected])])
  // A settings file Harness cannot read is the person's to fix: it is left exactly as it is.
  if (settings === null) return null
  const rejected = names(settings[contract.rejected])
  const fresh = servers.filter((name) => !decided.has(name) && !rejected.includes(name))
  if (!fresh.length) return null
  const text = JSON.stringify({ ...settings, [contract.rejected]: [...rejected, ...fresh] }, null, 2)
  return { text, fresh }
}
