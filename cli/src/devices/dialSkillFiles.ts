// The dial skill's two files in the daemon's data folder, which outlive the devices' process. dial-skill.json says
// whether each engine is On, and the skills folders the command wrote into; its one writer is the `harness device`
// command. dial-skill-homes.json lists the skills folders the devices service wrote into; its one writer is that
// service. A Turn off finds every folder in both.
import { closeSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type DialEngine = 'claude' | 'codex'

export const DIAL_SKILL_FILE = 'dial-skill.json'
export const DIAL_SKILL_HOMES_FILE = 'dial-skill-homes.json'
/** Folders an engine's list holds at most: a few homes today, so ten times that still fits. */
export const MAX_HOMES = 64

/** Two full lists of the longest paths, with room for JSON's quotes and escapes: each file holds two lists. */
const MAX_FILE_BYTES = 256 * 1024
const MAX_PATH_BYTES = 1024
const CONTROL = /\p{Cc}/u

/** A key is absent when the file gives that engine no answer. */
export interface DialSkillAnswers { claude?: boolean; codex?: boolean }

export interface DialSkillHomes { claude: string[]; codex: string[] }

/** [file] parsed as JSON; undefined when it is missing, unreadable, longer than [max] bytes or not JSON. */
const readJson = (file: string, max: number): unknown => {
  try {
    const fd = openSync(file, 'r')
    try {
      // One byte past the limit tells a file at the limit from a longer one.
      const buffer = Buffer.alloc(max + 1)
      let length = 0
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null)
        if (read === 0) break
        length += read
      }
      return length > max ? undefined : JSON.parse(buffer.toString('utf8', 0, length))
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** Written whole and renamed into place, so a reader never sees half a file. */
const writeJson = (file: string, value: unknown): string | undefined => {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
    return undefined
  } catch (error) {
    rmSync(temporary, { force: true })
    return (error as NodeJS.ErrnoException).code ?? 'FAILED'
  }
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * A path a list holds: Turn off removes from every folder a list holds, so only a path that names one folder exactly
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

const answersOf = (file: Record<string, unknown>): DialSkillAnswers => {
  const answers: DialSkillAnswers = {}
  if (typeof file.claude === 'boolean') answers.claude = file.claude
  if (typeof file.codex === 'boolean') answers.codex = file.codex
  return answers
}

const writtenOf = (file: Record<string, unknown>): DialSkillHomes => {
  const homes = fields(file.homes)
  return { claude: homesOf(homes.claude), codex: homesOf(homes.codex) }
}

export function readAnswers(dataDir: string): DialSkillAnswers {
  return answersOf(settingOf(dataDir))
}

/** The skills folders the command wrote into: a Turn off removes from them too, whatever home the command that runs it
 *  has (its own CODEX_HOME or CLAUDE_CONFIG_DIR). */
export function readWritten(dataDir: string): DialSkillHomes {
  return writtenOf(settingOf(dataDir))
}

/**
 * undefined once saved; else the error's code (EACCES), never its message, which names the path. [written], when given,
 * becomes the folders the command wrote into for [engine]; else they stay.
 */
export function writeAnswer(dataDir: string, engine: DialEngine, on: boolean, written?: string[]): string | undefined {
  // Read right before the write, so the other engine's answer and folders stay.
  const file = settingOf(dataDir)
  const homes = writtenOf(file)
  if (written) homes[engine] = homesOf(written)
  const setting = { ...answersOf(file), [engine]: on, ...(homes.claude.length || homes.codex.length ? { homes } : {}) }
  return writeJson(join(dataDir, DIAL_SKILL_FILE), setting)
}

export function readHomes(dataDir: string): DialSkillHomes {
  const file = fields(readJson(join(dataDir, DIAL_SKILL_HOMES_FILE), MAX_FILE_BYTES))
  return { claude: homesOf(file.claude), codex: homesOf(file.codex) }
}

/** Kept as a read keeps them, so the file never holds a folder a Turn off would not find. */
export function writeHomes(dataDir: string, homes: DialSkillHomes): string | undefined {
  return writeJson(join(dataDir, DIAL_SKILL_HOMES_FILE), { claude: homesOf(homes.claude), codex: homesOf(homes.codex) })
}
