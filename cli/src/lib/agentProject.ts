import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { insideGitCheckout } from './gitProject.js'

const exec = promisify(execFile)
export type AgentProject = {
  name: string
  cwd: string
  root: string | null
  remote: string | null
  branch: string | null
  /** Inside a linked worktree rather than the repository's own checkout. */
  worktree?: true
  /** The branch still has the name Harness made up at Start; the session's replaces it. */
  branchPending?: true
}

/** Compare remote repositories without publishing embedded credentials or transport syntax. */
export function canonicalRepository(raw: string | null): string | null {
  if (!raw) return null
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(raw)
  try {
    const url = new URL(scp && !raw.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : raw)
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol) || !url.hostname) return null
    let path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (!path || /[\x00-\x20]/.test(path)) return null
    const host = url.hostname.toLowerCase()
    if (host === 'github.com' || host === 'bitbucket.org') path = path.toLowerCase()
    const defaultPort = url.protocol === 'ssh:' ? '22' : url.protocol === 'git:' ? '9418' : ''
    const port = url.port === defaultPort ? '' : url.port
    return `${host}${port ? `:${port}` : ''}/${path}`
  } catch { return null }
}

/** Bounded subprocesses, no shell, network, or repository mutation. */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  // Every agent's folder is read here as it starts, and a fresh Mac's first harness runs in a
  // folder with no `.git`: git's own answer there (exit 128), without running Apple's git stub.
  if (!(await insideGitCheckout(cwd))) throw Object.assign(new Error('not a Git checkout'), { code: 128 })
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete (environment as NodeJS.ProcessEnv)[key]
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout: 1500, maxBuffer: 16 * 1024, encoding: 'utf8',
    env: environment,
  })
  return stdout.trim() || null
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  return runGit(cwd, args).catch(() => null)
}

/** Read the two config values in one Git process. Git still resolves includes,
 * worktree config and precedence; the last matching value wins, as with --get. */
async function projectConfig(cwd: string, branch: string | null) {
  const marker = branch && !branch.startsWith('Detached ') ? `branch.${branch}.harness` : null
  const keys = ['remote.origin.url', ...(marker ? [marker] : [])]
  const pattern = `^(${keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
  let output: string | null
  try { output = await runGit(cwd, ['config', '--null', '--get-regexp', pattern]) }
  catch (error) {
    if ((error as { code?: string | number }).code === 1) return { remote: null, pending: false }
    // A large set of duplicate values can exceed the combined output bound.
    // Keep the individual reads as a fallback so metadata remains available.
    return { remote: await git(cwd, ['config', '--get', 'remote.origin.url']),
      pending: marker !== null && await git(cwd, ['config', '--get', marker]) === 'placeholder' }
  }
  const values = new Map<string, string | null>()
  for (const record of output?.split('\0') ?? []) {
    if (!record) continue
    // -z separates records with NUL and each key from its value with a newline.
    // A valueless entry has no newline and overrides an earlier value too.
    const separator = record.indexOf('\n')
    const key = separator < 0 ? record : record.slice(0, separator)
    values.set(key, separator < 0 ? null : record.slice(separator + 1).trim() || null)
  }
  return { remote: values.get('remote.origin.url') ?? null, pending: marker !== null && values.get(marker) === 'placeholder' }
}

/** Read paths and a resolved branch in one process. Absolute output preserves
 * linked worktree names even when cwd is a subdirectory or a symlink. */
async function repositoryPaths(cwd: string): Promise<{ root: string; common: string | null; branch?: string | null } | null> {
  try {
    if (!(await stat(cwd)).isDirectory()) return null
  } catch (error) {
    // Historical sessions can point at deleted temporary folders. Other stat
    // failures still defer to Git rather than asserting that a checkout is gone.
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
  }
  let output: string | null
  let resolved = true
  try {
    output = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--abbrev-ref=loose', 'HEAD'])
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string }
    // An unborn HEAD exits 128 after printing the two valid paths and HEAD.
    // Keep those paths, then let symbolic-ref read the unborn branch as before.
    output = failed.code === 128 && typeof failed.stdout === 'string' ? failed.stdout.trim() || null : null
    resolved = false
  }
  if (!output) return null
  const paths = output.split('\n')
  // Ambiguous HEAD names can omit the ref while still exiting successfully.
  if (resolved && paths.length === 2 && paths.every(isAbsolute)) return { root: paths[0], common: paths[1] }
  if (paths.length === 3 && paths.slice(0, 2).every(isAbsolute) && (resolved || paths[2] === 'HEAD')) {
    // A resolved literal HEAD is detached; undefined means symbolic-ref is
    // still needed (unborn, ambiguous, or the compatibility path below).
    return { root: paths[0], common: paths[1], ...(resolved ? { branch: paths[2] === 'HEAD' ? null : paths[2] } : {}) }
  }
  // Older Git prints an unrecognised --path-format flag literally. Ambiguous
  // output (including a newline in a physical path) retains the separate reads.
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  return root ? { root, common: await git(root, ['rev-parse', '--git-common-dir']) } : null
}

// Only four folders run Git at once, including cache refreshes.
let running = 0
const waiting: Array<() => void> = []
async function inspect(cwd: string): Promise<AgentProject> {
  if (running >= 4) await new Promise<void>(resolve => waiting.push(resolve))
  else running++
  try {
    const paths = await repositoryPaths(cwd)
    if (!paths) return { name: basename(cwd) || cwd, cwd, root: null, remote: null, branch: null }
    const { root, common } = paths
    // A checkout on no branch still says where it is, as the desktop's own reader does.
    const branch = (paths.branch === undefined
      ? await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : paths.branch)
      ?? await git(cwd, ['rev-parse', '--short', 'HEAD']).then(sha => sha && `Detached ${sha}`)
    const { remote, pending } = await projectConfig(cwd, branch)
    // A linked worktree is named for its repository, not its folder.
    const main = common && basename(common) === '.git' ? dirname(resolve(root, common)) : root
    return {
      name: basename(main), cwd, root, remote: canonicalRepository(remote), branch,
      ...(main !== root ? { worktree: true as const } : {}), ...(pending ? { branchPending: true as const } : {}),
    }
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/** Cheap freshness check for known Git metadata, including linked worktrees and
 * nested repositories created under a previously inspected directory. Git still
 * resolves all values; these stamps only avoid repeating it when nothing moved.
 * Untracked config includes are covered by the bounded full-refresh interval. */
async function metadataStamp(cwd: string, project: AgentProject): Promise<string | null> {
  try {
    if (project.root && !project.branch) return null
    const physical = await realpath(cwd)
    const directory = await stat(physical)
    if (!directory.isDirectory()) return null
    const paths = new Set<string>()
    for (let path = physical, depth = 0; depth < 128; depth++) {
      paths.add(join(path, '.git'))
      if (path === project.root || dirname(path) === path) break
      path = dirname(path)
    }
    const smallFile = async (path: string): Promise<string | null> => {
      paths.add(path)
      const info = await stat(path).catch(error => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      })
      if (!info) return null
      if (!info.isFile() || info.size > 16 * 1024) throw new Error('Uncacheable Git metadata')
      return (await readFile(path, 'utf8')).trim()
    }
    if (project.root) {
      const marker = join(project.root, '.git')
      const info = await stat(marker)
      let gitDir = marker
      if (!info.isDirectory()) {
        const markerText = await smallFile(marker)
        if (!markerText?.startsWith('gitdir: ')) return null
        gitDir = resolve(project.root, markerText.slice(8))
      }
      paths.add(join(gitDir, 'HEAD'))
      paths.add(join(gitDir, 'config'))
      paths.add(join(gitDir, 'config.worktree'))
      const common = await smallFile(join(gitDir, 'commondir'))
      if (common) paths.add(join(resolve(gitDir, common), 'config'))
    }
    paths.add(process.env.GIT_CONFIG_GLOBAL || join(homedir(), '.gitconfig'))
    paths.add(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'config'))
    paths.add(process.env.GIT_CONFIG_SYSTEM || '/etc/gitconfig')
    const stamps = await Promise.all([...paths].map(async path => {
      const info = await stat(path).catch(error => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      })
      // Index/lock activity changes the .git directory's mtime without changing
      // this projection. Its identity, HEAD and config are the relevant inputs.
      return [path, !info ? null : info.isDirectory()
        ? [info.dev, info.ino, 'directory']
        : [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]]
    }))
    // A visible .git marker with no resolved repository can mean an unavailable
    // checkout or a failed Git process, not a stable non-repository folder.
    if (!project.root && stamps.some(([path, stamp]) => typeof path === 'string' && path.endsWith('/.git') && stamp !== null)) return null
    return JSON.stringify([physical, directory.dev, directory.ino, stamps])
  } catch { return null }
}

/** A `cwd` worth running Git in: absolute, bounded, printable. Exported for the SCM seam
 *  (`scm/scmProjects.ts`), which must answer null for exactly the folders this does. */
export function validProjectCwd(cwd: string | null | undefined): cwd is string {
  return !!cwd && isAbsolute(cwd) && cwd.length <= 4096 && !/[\x00-\x1f\x7f]/.test(cwd)
}

export function createAgentProjectReader(lookup: (cwd: string) => Promise<AgentProject> = inspect) {
  type Entry = { at: number; gitAt: number; pending: boolean; stamp: string | null; value: Promise<AgentProject> }
  const cache = new Map<string, Entry>()
  const trim = () => {
    // Pending work must survive both expiry and eviction, otherwise a slow
    // queue creates duplicate Git subprocesses for the same directory.
    for (const [key, entry] of cache) {
      if (cache.size <= 1024) break
      if (!entry.pending) cache.delete(key)
    }
  }
  const read = (cwd: string | null, now = Date.now()): Promise<AgentProject | null> => {
    if (!validProjectCwd(cwd)) return Promise.resolve(null)
    const found = cache.get(cwd)
    if (found && (found.pending || now - found.at < 15_000)) {
      cache.delete(cwd)
      cache.set(cwd, found)
      return found.value
    }
    const started = Date.now()
    const entry: Entry = { at: now, gitAt: found?.gitAt ?? now, pending: true, stamp: null, value: null! }
    entry.value = (async () => {
      const previous = found ? await found.value : null
      const before = previous ? await metadataStamp(cwd, previous) : null
      if (found?.stamp && before === found.stamp && now - found.gitAt < 60_000) {
        entry.stamp = before
        return previous!
      }
      const value = await lookup(cwd)
      const after = await metadataStamp(cwd, value)
      // Only reuse a snapshot if its inputs stayed stable across the Git read.
      // A first lookup has no resolved Git directory yet and warms this on the
      // next refresh; a checkout racing a lookup never becomes a cached fact.
      entry.stamp = before && before === after ? after : null
      entry.gitAt = now + Math.max(0, Date.now() - started)
      return value
    })().finally(() => {
      entry.pending = false
      entry.at = now + Math.max(0, Date.now() - started)
      trim()
    })
    cache.delete(cwd)
    cache.set(cwd, entry)
    trim()
    return entry.value
  }
  return { read, forget: (cwd: string) => { cache.delete(cwd) } }
}

// Agent lists and push frames share this reader. Branch changes still become
// visible within 15 seconds; unchanged historical paths do not fork Git again.
const projects = createAgentProjectReader()
export const agentProject = projects.read
/** Forget what was read for `cwd`, as after renaming its branch. */
export const forgetAgentProject = projects.forget
