/**
 * The git and the gh the CLI runs, each by an absolute path found once per process.
 *
 * Node on Windows looks for a bare name in the child's working folder before PATH (docs/windows-rules.md §2), so a
 * `git.exe` committed into a repository would run as `git` there. Prepending a folder to PATH, as tmux does
 * (tmuxOnPath.ts), cannot fix that: the working folder is looked in first. A path names one file wherever it runs.
 * On macOS a daemon launchd starts has a PATH without Homebrew's, so the login shell is asked next, as for tmux.
 */
import { isAbsolute, win32 } from 'node:path'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { resolveViaLoginShell } from './tmuxOnPath.js'
import { fileExists, gitForWindowsRoots, programFilesRoots, scoopRoots } from './windows/gitBash.js'

export type Program = 'git' | 'gh'

export interface ProgramSearch {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Windows: whether a file is at this path. */
  isFile?: (path: string) => boolean
  /** macOS and Linux: where the login shell finds the program (tmuxOnPath.ts `resolveViaLoginShell`). */
  loginShell?: () => Promise<string | null>
}

/** The absolute path of the git to run, or null. Never a file in the working folder. */
export function findGit(search: ProgramSearch = {}): Promise<string | null> {
  // Git for Windows' installer puts git.exe in <root>\cmd; Scoop puts a shim that starts it in <root>\shims.
  return findProgram('git', search, (env) => [
    ...gitForWindowsRoots(env).map((root) => win32.join(root, 'cmd')),
    ...scoopRoots(env).map((root) => win32.join(root, 'shims')),
  ])
}

/** The absolute path of the gh to run, or null. Never a file in the working folder. */
export function findGh(search: ProgramSearch = {}): Promise<string | null> {
  return findProgram('gh', search, (env) => [
    ...programFilesRoots(env).map((root) => win32.join(root, 'GitHub CLI')),
    ...scoopRoots(env).map((root) => win32.join(root, 'shims')),
  ])
}

async function findProgram(name: Program, search: ProgramSearch, installFolders: (env: NodeJS.ProcessEnv) => string[]): Promise<string | null> {
  const { platform = process.platform, env = process.env, isFile = fileExists, loginShell = () => resolveViaLoginShell(name) } = search
  // A relative PATH entry names a folder under the one the program runs in.
  if (platform !== 'win32') return resolveBinaryOnPath(name, env, isAbsolute) ?? await loginShell()
  // The .exe alone: a .cmd runs only through cmd.exe.
  const folders = [...(env.PATH ?? '').split(';'), ...installFolders(env)].filter(fixedFolder)
  return folders.map((folder) => win32.join(folder, `${name}.exe`)).find((path) => isFile(path)) ?? null
}

/** A folder that is the same whatever folder a program runs in: a drive's (C:\…) or a share's (\\server\…). Any other
 *  is looked up from the working folder, `\tools` included (from its drive). */
function fixedFolder(folder: string): boolean {
  return /^(?:[A-Za-z]:\\|\\\\[^\\])/.test(win32.normalize(folder))
}

/** A path found is kept for the process; a miss asks again next time, as git may be installed while the daemon runs;
 *  none rejects as spawn does for a missing program, so each caller's ENOENT handling reads it as before. */
export function createProgramPath(name: Program, find: () => Promise<string | null>): () => Promise<string> {
  let search: Promise<string> | undefined
  // The callers that ask while a search runs share it: a busy start asks the login shell once, not once per git.
  return () => search ??= find()
    .then((found) => found ?? Promise.reject(missingProgram(name)))
    .catch((error: unknown) => {
      search = undefined
      throw error
    })
}

function missingProgram(name: Program): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT', syscall: `spawn ${name}`, path: name })
}

export const gitPath = createProgramPath('git', () => findGit())
export const ghPath = createProgramPath('gh', () => findGh())
