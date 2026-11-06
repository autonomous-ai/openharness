/**
 * Carrying one Claude conversation's transcript from one account's home to another's, so `claude --resume <id>` under the
 * other CLAUDE_CONFIG_DIR finds the same conversation (a PM moving between its machine's Claude accounts, spec
 * 2026-11-06-pm-account-rotation). The source is never touched: the account it came from keeps its copy.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { env } from '../config/env.js'

export interface CarriedTranscript { transcriptPath: string; copied: boolean }

/** The ids Claude writes, as `findResumedTranscript` accepts them: nothing here may name a path outside `projects`. */
const SESSION_ID = /^[0-9a-f-]{16,128}$/i

const notFound = (detail: string): Error => Object.assign(new Error(detail), { code: 'NOT_FOUND' })

/** `<home>/projects`; the default account (no CLAUDE_CONFIG_DIR) is the daemon's own projects folder. */
const projectsOf = (home: string | undefined): string => home === undefined ? env.CLAUDE_PROJECTS_DIR : join(home, 'projects')

/**
 * The folder Claude names for [cwd]: every character but a letter or digit becomes `-`. It is only tried first; the
 * encoding is Claude's to define, so the project folders are listed when it misses (as session repair does:
 * `findResumedTranscript`, engines/claude/sessionStore.ts `byId`).
 */
const encodedCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

function locate(projects: string, cwd: string, file: string): string | null {
  const guess = join(projects, encodedCwd(cwd), file)
  if (existsSync(guess)) return guess
  let folders: string[]
  try { folders = readdirSync(projects) } catch { return null }
  for (const folder of folders) {
    const path = join(projects, folder, file)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * [from] and [to] are Claude homes (`undefined`: the default account). Copies the session file into [to]'s `projects`,
 * beside the folder it was found in, unless both homes' `projects` are the same folder (an Orca-style profile links
 * `projects` to the default's): then nothing is copied and the path stays. Throws `NOT_FOUND` when [from] has no such file.
 */
export function carryClaudeTranscript(from: string | undefined, to: string | undefined, cwd: string, sessionId: string): CarriedTranscript {
  if (!SESSION_ID.test(sessionId)) throw notFound('The session id is not one Claude writes.')
  const file = `${sessionId}.jsonl`
  const source = locate(projectsOf(from), cwd, file)
  if (!source) throw notFound(`No transcript of ${sessionId} in that Claude account.`)
  const targetProjects = projectsOf(to)
  mkdirSync(targetProjects, { recursive: true, mode: 0o700 })
  if (realpathSync(projectsOf(from)) === realpathSync(targetProjects)) return { transcriptPath: source, copied: false }
  const folder = basename(dirname(source))
  const directory = join(targetProjects, folder)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const transcriptPath = join(directory, file)
  // Whole file or none: a resume must never open half a transcript.
  const partial = `${transcriptPath}.${process.pid}.tmp`
  try {
    copyFileSync(source, partial)
    renameSync(partial, transcriptPath)
  } finally { rmSync(partial, { force: true }) }
  return { transcriptPath, copied: true }
}
