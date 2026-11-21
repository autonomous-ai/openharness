/**
 * The git and the gh the CLI runs, each by an absolute path found once per process.
 *
 * Node on Windows looks for a bare name in the child's working folder before PATH (docs/windows-rules.md §2), so a
 * `git.exe` committed into a repository would run as `git` there. Prepending a folder to PATH, as tmux does
 * (tmuxOnPath.ts), cannot fix that: the working folder is looked in first. A path names one file wherever it runs.
 * On macOS a daemon launchd starts has a PATH without Homebrew's: a Mac with Homebrew's gh was told to install it
 * beside a working `gh` in every terminal (2026-10-17). So gh is looked for where its installers put it, and then
 * both in the PATH the person's login shell gives.
 */
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, win32 } from 'node:path'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { warmLoginShellEnvironment } from './loginShellEnv.js'
import { fileExists, fixedFolder, gitForWindowsRoots, programFilesRoots, scoopRoots } from './windows/gitBash.js'

export type Program = 'git' | 'gh'

export interface ProgramSearch {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Windows: whether a file is at this path. */
  isFile?: (path: string) => boolean
  /** macOS and Linux: where the login shell finds the program. By default in its PATH as loginShellEnv.ts read it,
   *  once a process (the daemon's as it starts): gh is missing on most computers, and a shell for each miss, up to
   *  5 s each, kept the pull request reader's slots full. The PATH is looked in again at each miss, so a program
   *  installed since into one of its folders is found with no new shell. */
  loginShell?: () => Promise<string | null>
}

/** The absolute path of the git to run, or null. Never a file in the working folder. */
export function findGit(search: ProgramSearch = {}): Promise<string | null> {
  // Git for Windows' installer puts git.exe in <root>\cmd; Scoop puts a shim that starts it in <root>\shims.
  return findProgram('git', search, (env, platform) => platform !== 'win32' ? [] : [
    ...gitForWindowsRoots(env).map((root) => win32.join(root, 'cmd')),
    ...scoopRoots(env).map((root) => win32.join(root, 'shims')),
  ])
}

/** The absolute path of the gh to run, or null. Never a file in the working folder. */
export function findGh(search: ProgramSearch = {}): Promise<string | null> {
  return findProgram('gh', search, (env, platform) => platform !== 'win32'
    // Homebrew on Apple silicon and on Intel, Linuxbrew, and a user install.
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(env.HOME || homedir(), '.local', 'bin')]
    : [...programFilesRoots(env).map((root) => win32.join(root, 'GitHub CLI')), ...scoopRoots(env).map((root) => win32.join(root, 'shims'))])
}

async function findProgram(name: Program, search: ProgramSearch,
  installFolders: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string[]): Promise<string | null> {
  const { platform = process.platform, env = process.env, isFile = fileExists,
    loginShell = async () => resolveBinaryOnPath(name, { PATH: (await warmLoginShellEnvironment()).PATH }, isAbsolute) } = search
  // A relative PATH entry names a folder under the one the program runs in. The login shell last: reading its PATH
  // the first time starts it.
  if (platform !== 'win32') {
    return resolveBinaryOnPath(name, env, isAbsolute)
      ?? resolveBinaryOnPath(name, { PATH: installFolders(env, platform).join(delimiter) }, isAbsolute) ?? await loginShell()
  }
  // The .exe alone: a .cmd runs only through cmd.exe.
  const folders = [...(env.PATH ?? '').split(';'), ...installFolders(env, platform)].filter(fixedFolder)
  return folders.map((folder) => win32.join(folder, `${name}.exe`)).find((path) => isFile(path)) ?? null
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
