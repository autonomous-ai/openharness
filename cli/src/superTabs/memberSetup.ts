/**
 * A Member sets its project up once on its person's computer, and its helpers start from that setup (anh Dee's agent model,
 * task #4693, part B #4698). How to install and build a project is judgment, so the Member's engine does it, as the project's
 * own docs say, and reports the commands it ran. What a helper reuses is code: its worktree gets copies of the Member's
 * installed and built folders, and its start note carries the Member's commands for whatever is still missing.
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, lstat, rm } from 'node:fs/promises'
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

/** What a copy says when something is already where it writes. */
const EXISTED = new Set(['EEXIST', 'ERR_FS_CP_EEXIST', 'ERR_FS_CP_DIR_TO_NON_DIR', 'ERR_FS_CP_NON_DIR_TO_DIR'])

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
    // Only into a plain folder of the helper's own: one its checkout already has (a tracked `build/`) stays the checkout's, and a
    // link anywhere on the way (a tracked symlink, dangling or not) is never followed out of its folder (security reviews of #3579).
    if (!await freshInside(to, folder)) continue
    try {
      await clone(join(from, folder), join(to, folder))
      copied.push(folder)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      // Only what this copy made goes: a folder there that the copy found in its way (made meanwhile) is someone else's
      // (security review 2 of #3579). The failed one was not there before it, so anything else left of it is the copy's.
      const mine = EXISTED.has(code) ? copied : [...copied, folder]
      for (const made of mine) await rm(join(to, made), { recursive: true, force: true }).catch(() => {})
      return { copied: [], skipped: !copied.length && CLONE_UNSUPPORTED.has(code) ? 'CLONE_UNSUPPORTED' : 'COPY_FAILED' }
    }
  }
  return { copied }
}

/** Whether [folder] (a relative path from git) is not in [root] yet and every folder on its way is a real one, not a link. */
async function freshInside(root: string, folder: string): Promise<boolean> {
  const parts = folder.split('/')
  for (let i = 0; i < parts.length; i++) {
    const info = await lstat(join(root, ...parts.slice(0, i + 1))).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : error)
    if (info instanceof Error) return false
    if (i === parts.length - 1) return info === null
    // A missing folder on the way is made by the copy itself, inside [root].
    if (info && (info.isSymbolicLink() || !info.isDirectory())) return false
    if (!info) return true
  }
  return false
}

/** A Member's start note: set up once, here, and say so with the commands it ran. */
export function memberLine(tabId: string, projectId: string): string {
  return `You are your person's Member for this project: you set the project up once in this folder, then do its tasks here, one at a time. Before your first task, set the project up once as its own docs say (README, AGENTS.md, CONTRIBUTING): install its dependencies and build it in this folder. Then report it once with harness super-tab --tab ${tabId} command OPERATION_ID - <<'JSON' and this JSON, naming each command you ran: {"type":"agent.setUp","projectId":"${projectId}","ok":true,"steps":["…"]}. If it cannot be set up, send {"type":"agent.setUp","projectId":"${projectId}","ok":false,"reason":"…"} with the reason in one line. Start each task on a new branch from the default branch, in this same folder.`
}

/** A helper's start note: its folder came from its Member's setup, and these are the commands that made it, quoted as data. Null
 *  [steps]: its Member is not this computer's own, so its words are not run here (security review 1 of #3579); it sets up itself. */
export function helperLine(steps: string[] | null): string {
  if (!steps) return 'You are a helper: before your task, set the project up in this folder as its own docs say (README, AGENTS.md, CONTRIBUTING). You end when no task waits, so leave nothing running.'
  const listed = steps.length ? ` Your Member set the project up with these commands; run only the ones still needed:\n${steps.map(step => `> ${step}`).join('\n')}\n` : ' '
  return `You are a helper: your folder was made from your Member's set-up copy of this project, with its installed folders copied where this computer could.${listed}You end when no task waits, so leave nothing running.`
}

/** The Member's reported commands, as the server keeps them: at most ten, each one plain line of 300 characters or fewer. */
export function setUpSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((step): step is string => typeof step === 'string' && !!step.trim() && step.length <= 300
    && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(step)).slice(0, 10)
}
