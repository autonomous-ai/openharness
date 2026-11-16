// The dial skill's two files in the daemon's data folder, which outlive the devices' process. dial-skill.json says
// whether each engine is On; its one writer is the `harness device` command. dial-skill-homes.json lists the skills
// folders the devices service wrote into, so a Turn off finds them; its one writer is that service.
import { closeSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type DialEngine = 'claude' | 'codex'

export const DIAL_SKILL_FILE = 'dial-skill.json'
export const DIAL_SKILL_HOMES_FILE = 'dial-skill-homes.json'
/** Folders an engine's list holds at most: a few homes today, so ten times that still fits. */
export const MAX_HOMES = 64

/** Two booleans: anything larger is not ours. */
const MAX_ANSWERS_BYTES = 1024
/** Two full lists of the longest paths, with room for JSON's quotes and escapes. */
const MAX_HOMES_BYTES = 256 * 1024
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

export function readAnswers(dataDir: string): DialSkillAnswers {
  const file = fields(readJson(join(dataDir, DIAL_SKILL_FILE), MAX_ANSWERS_BYTES))
  const answers: DialSkillAnswers = {}
  if (typeof file.claude === 'boolean') answers.claude = file.claude
  if (typeof file.codex === 'boolean') answers.codex = file.codex
  return answers
}

/** undefined once saved; else the error's code (EACCES), never its message, which names the path. */
export function writeAnswer(dataDir: string, engine: DialEngine, on: boolean): string | undefined {
  // Read right before the write, so the other engine's answer stays.
  return writeJson(join(dataDir, DIAL_SKILL_FILE), { ...readAnswers(dataDir), [engine]: on })
}

/** Turn off removes from every folder the list holds, so only a path that names one folder exactly is kept: a
 *  relative path, a `..` or a control character in a list damaged or edited by hand reads as no folder. */
const homesOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const kept = new Set<string>()
  for (const path of value) {
    if (kept.size === MAX_HOMES) break
    if (typeof path === 'string' && resolve(path) === path && !CONTROL.test(path) && Buffer.byteLength(path) <= MAX_PATH_BYTES) kept.add(path)
  }
  return [...kept]
}

export function readHomes(dataDir: string): DialSkillHomes {
  const file = fields(readJson(join(dataDir, DIAL_SKILL_HOMES_FILE), MAX_HOMES_BYTES))
  return { claude: homesOf(file.claude), codex: homesOf(file.codex) }
}

/** Kept as a read keeps them, so the file never holds a folder a Turn off would not find. */
export function writeHomes(dataDir: string, homes: DialSkillHomes): string | undefined {
  return writeJson(join(dataDir, DIAL_SKILL_HOMES_FILE), { claude: homesOf(homes.claude), codex: homesOf(homes.codex) })
}
