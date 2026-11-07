/**
 * A Member sets its project up once on its person's computer, and its helpers start from that setup (anh Dee's agent model,
 * task #4693, part B #4698). How to install and build a project is judgment, so the Member's engine does it, as the project's
 * own docs say, and reports the commands it ran. What a helper reuses is code: its worktree gets copies of the Member's
 * installed and built folders, and its start note carries the Member's commands for whatever is still missing.
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { ownProcessGroup } from '../lib/windows/noWindow.js'

const run = promisify(execFile)

/** Folders an install or a build makes, which git ignores. Only these are copied: an ignored `.env` or key file is the
 *  Member's, and a helper is told its own way to get what it needs. */
const SETUP_FOLDERS = new Set(['node_modules', '.dart_tool', '.venv', 'venv', '.gradle', 'Pods', 'target', 'build', 'dist'])
/** A repository with more set-up folders than this is copied only this far; the helper installs the rest. */
const MAX_FOLDERS = 100
/** What a disk without its own clone (NTFS, ext4) answers a forced clone: the copy is skipped, never made byte by byte, so a
 *  helper never doubles a Member's disk use. */
const CLONE_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'])

export type SetupCopy = { copied: string[]; skipped?: 'CLONE_UNSUPPORTED' | 'COPY_FAILED' | 'NOT_READ' }
export type CloneFolder = (from: string, to: string) => Promise<void>

/** The disk's own clone (APFS clonefile, Btrfs and XFS reflinks): a copy that costs no disk until either side changes it. */
const cloneFolder: CloneFolder = (from, to) => cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE, verbatimSymlinks: true, errorOnExist: true, force: false })

/** Copies the Member's set-up folders in [from] into a helper's new worktree [to]. All of them or none: one that fails
 *  takes back the ones before it, so a helper never starts on half a setup. Never throws: a helper whose copy is skipped
 *  starts anyway and runs its Member's steps. */
export async function copySetup(from: string, to: string, clone: CloneFolder = cloneFolder): Promise<SetupCopy> {
  let listed: string
  try {
    listed = (await run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: from, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...ownProcessGroup() })).stdout
  } catch { return { copied: [], skipped: 'NOT_READ' } }
  const folders = listed.split('\0').filter(path => path.endsWith('/')).map(path => path.slice(0, -1))
    .filter(path => SETUP_FOLDERS.has(posix.basename(path)) && !path.split('/').includes('..')).sort().slice(0, MAX_FOLDERS)
  const copied: string[] = []
  for (const folder of folders) {
    // One the helper's checkout already has (a tracked `build/`) stays the checkout's.
    if (await stat(join(to, folder)).then(() => true, () => false)) continue
    try {
      await clone(join(from, folder), join(to, folder))
      copied.push(folder)
    } catch (error) {
      for (const made of [...copied, folder]) await rm(join(to, made), { recursive: true, force: true }).catch(() => {})
      const code = (error as NodeJS.ErrnoException).code ?? ''
      return { copied: [], skipped: !copied.length && CLONE_UNSUPPORTED.has(code) ? 'CLONE_UNSUPPORTED' : 'COPY_FAILED' }
    }
  }
  return { copied }
}

/** A Member's start note: set up once, here, and say so with the commands it ran. */
export function memberLine(tabId: string, projectId: string): string {
  return `You are your person's Member for this project: you set the project up once in this folder, then do its tasks here, one at a time. Before your first task, set the project up once as its own docs say (README, AGENTS.md, CONTRIBUTING): install its dependencies and build it in this folder. Then report it once with harness super-tab --tab ${tabId} command OPERATION_ID - <<'JSON' and this JSON, naming each command you ran: {"type":"agent.setUp","projectId":"${projectId}","ok":true,"steps":["…"]}. If it cannot be set up, send {"type":"agent.setUp","projectId":"${projectId}","ok":false,"reason":"…"} with the reason in one line. Start each task on a new branch from the default branch, in this same folder.`
}

/** A helper's start note: its folder came from its Member's setup, and these are the commands that made it. Quoted, as data. */
export function helperLine(steps: string[]): string {
  const listed = steps.length ? ` Your Member set the project up with these commands; run only the ones still needed:\n${steps.map(step => `> ${step}`).join('\n')}\n` : ' '
  return `You are a helper: your folder was made from your Member's set-up copy of this project, with its installed folders copied where this computer could.${listed}You end when no task waits, so leave nothing running.`
}

/** The Member's reported commands, as the server keeps them: at most ten, each one plain line of 300 characters or fewer. */
export function setUpSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((step): step is string => typeof step === 'string' && !!step.trim() && step.length <= 300
    && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(step)).slice(0, 10)
}
