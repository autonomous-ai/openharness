// The dial skill's two files in the daemon's data folder, which outlive the devices' process. dial-skill.json says what
// `harness device <engine> disable` and `harness device vscode disable` removed, the skills folders the command wrote
// into, the Orca homes its `enable` turned Claude Code's plugin on in (`pluginHomes`), and that a connect of Orca's own
// plugin once succeeded (`orcaConnected`); its one writer is that command, and the devices service leaves what it
// removed alone. dial-setup.json is the devices service's own record of
// a dial's setup: a dial attached here once, the CLI versions that last set Claude Code's plugin and Harness's VS Code
// extension up, the skills folders it wrote into, and the Orca homes it turned the plugin on in (`pluginHomes`); its
// one writer is that service. A `disable` finds every folder in both. Each file keeps its own list of Orca homes, so
// neither has a second writer, and a home in either counts as turned on once.
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type DialEngine = 'claude' | 'codex'

export const DIAL_SKILL_FILE = 'dial-skill.json'
export const DIAL_SETUP_FILE = 'dial-setup.json'
/** Folders an engine's list holds at most: a few homes today, so ten times that still fits. */
export const MAX_HOMES = 64
/** What a day's tally counts of each engine's setup, in the order its line says them. */
export const SETUP_COUNTS = ['set up', 'updated', 'failed', 'left removed'] as const
export type SetupCount = typeof SETUP_COUNTS[number]

/** Three full lists of the longest paths, with room for JSON's quotes: each file holds three lists. Paths whose
 *  characters JSON escapes can outgrow it, and such a file is not written. */
const MAX_FILE_BYTES = 256 * 1024
const MAX_PATH_BYTES = 1024
const CONTROL = /\p{Cc}/u
/** A CLI version: a value edited by hand is compared with this CLI's own, so nothing but a version is kept. */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/

export interface DialSkillHomes { claude: string[]; codex: string[] }

/** What `harness device <engine> disable` and `harness device vscode disable` removed; a key is absent when it removed
 *  nothing. */
export interface DialRemoved { claude?: true; codex?: true; vscode?: true }

/** [pluginHomes]: the Orca homes the devices turned Claude Code's plugin on in, by real path. */
export interface DialSetupRecord { dial: boolean; plugin?: string; vscode?: string; homes: DialSkillHomes; pluginHomes: string[] }

/** A file read: [unread] when it is there but could not be read (EACCES, EIO, EMFILE), so it reads as empty, and
 *  nothing may be written from that read: it would lose what the file holds. */
export type Read<T> = T & { unread?: true }

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'FAILED'

/** [file] parsed as JSON; undefined when it is missing, longer than [max] bytes or not JSON. One that is there but
 *  cannot be read throws. */
const readJson = (file: string, max: number): unknown => {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw error
  }
  // One byte past the limit tells a file at the limit from a longer one.
  const buffer = Buffer.alloc(max + 1)
  let length = 0
  try {
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
    }
  } finally {
    closeSync(fd)
  }
  if (length > max) return undefined
  try {
    return JSON.parse(buffer.toString('utf8', 0, length))
  } catch {
    return undefined
  }
}

/** [read], or [empty] said unread when its file could not be read. */
const orUnread = <T extends object>(read: () => T, empty: T): Read<T> => {
  try {
    return read()
  } catch {
    return { ...empty, unread: true }
  }
}

/** Written whole and on disk before it is renamed into place, so a reader, or a crash, never sees half a file. One a
 *  read would drop as too long is not written: EFBIG. */
const writeJson = (file: string, value: unknown): string | undefined => {
  const text = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return 'EFBIG'
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    return undefined
  } catch (error) {
    rmSync(temporary, { force: true })
    return codeOf(error)
  }
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * A path a list holds: a `disable` removes from every folder a list holds, so only a path that names one folder exactly
 * is kept. Equal to its own resolve(): absolute, with no `..`, `.`, `//` or trailing `/`; no control character; at most
 * 1024 bytes. A skill goes only into a folder that passes, so none is written that a list would drop.
 */
export const listable = (path: string): boolean =>
  Buffer.byteLength(path) <= MAX_PATH_BYTES && !CONTROL.test(path) && resolve(path) === path

/** A list damaged or edited by hand keeps only what it may hold. */
const homesOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const kept = new Set<string>()
  for (const path of value) {
    if (kept.size === MAX_HOMES) break
    if (typeof path === 'string' && listable(path)) kept.add(path)
  }
  return [...kept]
}

const settingOf = (dataDir: string): Record<string, unknown> => fields(readJson(join(dataDir, DIAL_SKILL_FILE), MAX_FILE_BYTES))

const writtenOf = (file: Record<string, unknown>): DialSkillHomes => {
  const homes = fields(file.homes)
  return { claude: homesOf(homes.claude), codex: homesOf(homes.codex) }
}

/** The skills folders the command wrote into: a `disable` removes from them too, whatever home the command that runs it
 *  has (its own CODEX_HOME or CLAUDE_CONFIG_DIR). */
export function readWritten(dataDir: string): Read<DialSkillHomes> {
  return orUnread(() => writtenOf(settingOf(dataDir)), { claude: [], codex: [] })
}

/** Only true is a removal: the old menu's booleans at the top of the file are another thing and are not read. */
const removedOf = (file: Record<string, unknown>): DialRemoved => {
  const marks = fields(file.removed)
  const removed: DialRemoved = {}
  if (marks.claude === true) removed.claude = true
  if (marks.codex === true) removed.codex = true
  if (marks.vscode === true) removed.vscode = true
  return removed
}

export function readRemoved(dataDir: string): Read<DialRemoved> {
  return orUnread(() => removedOf(settingOf(dataDir)), {})
}

/** The Orca homes `harness device claude enable` turned the plugin on in, by real path. */
export function readPluginHomes(dataDir: string): Read<{ homes: string[] }> {
  return orUnread(() => ({ homes: homesOf(settingOf(dataDir).pluginHomes) }), { homes: [] })
}

interface DialSetting { removed: DialRemoved; homes: DialSkillHomes; pluginHomes: string[]; orcaConnected: boolean }

/**
 * dial-skill.json read right before the write and [change]d, so what the change leaves stays; one that cannot be read is
 * left. undefined once saved; else the error's code (EACCES), never its message, which names the path. The old menu's
 * answers are not carried, so they leave the file at its next write.
 */
const rewriteSetting = (dataDir: string, change: (setting: DialSetting) => void): string | undefined => {
  let file: Record<string, unknown>
  try {
    file = settingOf(dataDir)
  } catch (error) {
    return codeOf(error)
  }
  const setting = { removed: removedOf(file), homes: writtenOf(file), pluginHomes: homesOf(file.pluginHomes), orcaConnected: file.orcaConnected === true }
  change(setting)
  const { removed, homes, pluginHomes, orcaConnected } = setting
  return writeJson(join(dataDir, DIAL_SKILL_FILE), {
    ...(removed.claude || removed.codex || removed.vscode ? { removed } : {}),
    ...(homes.claude.length || homes.codex.length ? { homes } : {}),
    ...(pluginHomes.length ? { pluginHomes } : {}),
    ...(orcaConnected ? { orcaConnected } : {}),
  })
}

/** undefined once saved, else the error's code. [written], when given, becomes the folders the command wrote into for
 *  [what], an engine; else they stay. */
export function writeRemoved(dataDir: string, what: keyof DialRemoved, removed: boolean, written?: string[]): string | undefined {
  return rewriteSetting(dataDir, (setting) => {
    if (removed) setting.removed[what] = true
    else delete setting.removed[what]
    if (written && what !== 'vscode') setting.homes[what] = homesOf(written)
  })
}

/** Replaces the command's Orca homes whole; the removals and the skills folders stay. undefined once saved, else the
 *  error's code. */
export function writePluginHomes(dataDir: string, homes: string[]): string | undefined {
  return rewriteSetting(dataDir, (setting) => {
    setting.pluginHomes = homesOf(homes)
  })
}

/** Whether a connect of Orca's plugin once succeeded: Harness then offers it no more. Only true counts. */
export function readOrcaConnected(dataDir: string): Read<{ connected: boolean }> {
  return orUnread(() => ({ connected: settingOf(dataDir).orcaConnected === true }), { connected: false })
}

/** undefined once saved, else the error's code. Nothing clears it: a person who removed the plugin in Orca is not
 *  offered it again. */
export function writeOrcaConnected(dataDir: string): string | undefined {
  return rewriteSetting(dataDir, (setting) => {
    setting.orcaConnected = true
  })
}

/** A record damaged or edited by hand keeps only what it may hold, and one is written as a read keeps it, so the file
 *  never holds a folder a `disable` would not find. A record from before Orca's homes (#4399) holds none. */
const setupOf = (value: unknown): DialSetupRecord => {
  const file = fields(value)
  return {
    dial: file.dial === true,
    ...(typeof file.plugin === 'string' && VERSION.test(file.plugin) ? { plugin: file.plugin } : {}),
    ...(typeof file.vscode === 'string' && VERSION.test(file.vscode) ? { vscode: file.vscode } : {}),
    homes: writtenOf(file),
    pluginHomes: homesOf(file.pluginHomes),
  }
}

export function readSetup(dataDir: string): Read<DialSetupRecord> {
  return orUnread(() => setupOf(readJson(join(dataDir, DIAL_SETUP_FILE), MAX_FILE_BYTES)), setupOf(undefined))
}

/** undefined once saved; else the error's code: EINVAL for a plugin or VS Code value a read would drop, so the plugin
 *  or the extension would read as never set up. */
export function writeSetup(dataDir: string, record: DialSetupRecord): string | undefined {
  if ([record.plugin, record.vscode].some((version) => version !== undefined && !VERSION.test(version))) return 'EINVAL'
  return writeJson(join(dataDir, DIAL_SETUP_FILE), setupOf(record))
}
