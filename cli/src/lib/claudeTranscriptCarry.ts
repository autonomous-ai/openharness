/**
 * Carrying one Claude conversation's transcript from one account's home to another's, so `claude --resume <id>` under the
 * other CLAUDE_CONFIG_DIR finds the same conversation (a PM moving between its machine's Claude accounts, spec
 * 2026-11-06-pm-account-rotation). The source is never touched: the account it came from keeps its copy.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { env } from '../config/env.js'

export interface CarriedTranscript { transcriptPath: string; copied: boolean }

/** The ids Claude writes, as `findResumedTranscript` accepts them: nothing here may name a path outside `projects`. */
const SESSION_ID = /^[0-9a-f-]{16,128}$/i

const notFound = (detail: string): Error => Object.assign(new Error(detail), { code: 'NOT_FOUND' })
const unsafe = (): Error => new Error('The Claude transcript path is unsafe.')

/** `<home>/projects`; the default account (no CLAUDE_CONFIG_DIR) is the daemon's own projects folder. */
const projectsOf = (home: string | undefined): string => home === undefined ? env.CLAUDE_PROJECTS_DIR : join(home, 'projects')

/**
 * The folder Claude names for [cwd]: every character but a letter or digit becomes `-`. It is only tried first; the
 * encoding is Claude's to define, so the project folders are listed when it misses (as session repair does:
 * `findResumedTranscript`, engines/claude/sessionStore.ts `byId`).
 */
const encodedCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

function inspect(path: string): Stats | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function requireDirectory(path: string): void {
  if (!inspect(path)?.isDirectory()) throw unsafe()
}

function requireFile(path: string): Stats | undefined {
  const info = inspect(path)
  if (info && !info.isFile()) throw unsafe()
  return info
}

function locate(projects: string, cwd: string, file: string): string | null {
  const guessedFolder = encodedCwd(cwd)
  const inFolder = (folder: string): string | null => {
    const directory = join(projects, folder)
    if (!inspect(directory)) return null
    requireDirectory(directory)
    const path = join(directory, file)
    return requireFile(path) ? path : null
  }
  const guess = guessedFolder ? inFolder(guessedFolder) : null
  if (guess) return guess
  for (const folder of readdirSync(projects, { withFileTypes: true })) {
    // Only the projects root may be shared. Never inspect sessions through a linked child.
    if (!folder.isDirectory() || folder.name === guessedFolder) continue
    const path = inFolder(folder.name)
    if (path) return path
  }
  return null
}

function copyTranscript(source: string, transcriptPath: string): void {
  const info = requireFile(source)
  if (!info) throw notFound('The Claude transcript is no longer available.')
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let partial: string | undefined
  try {
    const opened = fstatSync(sourceFd)
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw unsafe()
    const temporary = `${transcriptPath}.${randomUUID()}.tmp`
    const targetFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    partial = temporary
    try {
      // Bounded memory even for a long-running PM; copy from the inspected descriptor, never reopen its path.
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let remaining = opened.size
      while (remaining > 0) {
        const count = readSync(sourceFd, buffer, 0, Math.min(remaining, buffer.length), null)
        if (!count) throw unsafe()
        for (let written = 0; written < count;) {
          const countWritten = writeSync(targetFd, buffer, written, count - written)
          if (!countWritten) throw unsafe()
          written += countWritten
        }
        remaining -= count
      }
    } finally { closeSync(targetFd) }
    requireDirectory(dirname(source))
    requireDirectory(dirname(transcriptPath))
    requireFile(transcriptPath)
    // Whole file or none: a resume must never open half a transcript.
    renameSync(partial, transcriptPath)
    partial = undefined
  } finally {
    try { closeSync(sourceFd) } finally {
      if (partial) rmSync(partial, { force: true })
    }
  }
}

/**
 * [from] and [to] are Claude homes (`undefined`: the default account). Copies the session file into [to]'s `projects`,
 * beside the folder it was found in, unless both homes' `projects` are the same folder (an Orca-style profile links
 * `projects` to the default's): then nothing is copied and the path stays. Throws `NOT_FOUND` when [from] has no such file.
 */
export function carryClaudeTranscript(from: string | undefined, to: string | undefined, cwd: string, sessionId: string): CarriedTranscript {
  if (!SESSION_ID.test(sessionId)) throw notFound('The session id is not one Claude writes.')
  try {
    const file = `${sessionId}.jsonl`
    if (!inspect(projectsOf(from))) throw notFound('No transcript in that Claude account.')
    // Orca shares this root deliberately; use its resolved path and reject links below it.
    const sourceProjects = realpathSync(projectsOf(from))
    requireDirectory(sourceProjects)
    const source = locate(sourceProjects, cwd, file)
    if (!source) throw notFound('No transcript in that Claude account.')
    mkdirSync(projectsOf(to), { recursive: true, mode: 0o700 })
    const targetProjects = realpathSync(projectsOf(to))
    requireDirectory(targetProjects)
    const folder = basename(dirname(source))
    if (sourceProjects === targetProjects) return { transcriptPath: join(projectsOf(from), folder, file), copied: false }
    const directory = join(targetProjects, folder)
    if (!inspect(directory)) mkdirSync(directory, { mode: 0o700 })
    requireDirectory(directory)
    const transcriptPath = join(directory, file)
    requireFile(transcriptPath)
    copyTranscript(source, transcriptPath)
    return { transcriptPath: join(projectsOf(to), folder, file), copied: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'NOT_FOUND') throw error
    // The restart response reaches clients: filesystem errors must not reveal account paths or file contents.
    throw Object.assign(new Error('Could not safely carry the Claude transcript. Check the account’s projects folder for linked or special files.'), { code: 'TRANSCRIPT_COPY_FAILED' })
  }
}
