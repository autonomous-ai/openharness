import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { placeholderBranch, plausibleBranchName, worktreeFolderName } from './agentNames.js'
import { branchOwner } from './branchOwner.js'

const exec = promisify(execFile)

export class GitProjectError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function validGitPath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path)
}

async function git(path: string, args: string[], timeout = 4000): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete (env as NodeJS.ProcessEnv)[key]
  return (await exec('git', ['--no-optional-locks', '-C', path, ...args], {
    timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env,
  })).stdout.replace(/\r?\n$/, '')
}

/** `git worktree list --porcelain`, main checkout first. A bare repository has no files and a
 *  prunable entry lost its folder, so neither is somewhere to work. */
type Worktree = { path: string; ref: string | null; usable: boolean }
function parseWorktrees(output: string): Worktree[] {
  return output.split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n')
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) return []
    return [{
      path,
      ref: lines.find(line => line.startsWith('branch '))?.slice('branch '.length) ?? null,
      usable: !lines.some(line => line === 'bare' || line.startsWith('prunable')),
    }]
  })
}
/** `branch.<name>.harness` in the repository's config marks a branch Harness made: `placeholder` while
 *  its name waits for the session's, `created` once it has one or was named at Start. */
export const HARNESS_BRANCH_KEY = 'harness'
async function harnessBranches(path: string): Promise<Set<string>> {
  const out = await git(path, ['config', '--get-regexp', `^branch\\..*\\.${HARNESS_BRANCH_KEY}$`]).catch(() => '')
  return new Set(out.split('\n').flatMap(line => {
    const key = line.split(' ')[0] ?? ''
    return key.startsWith('branch.') && key.endsWith(`.${HARNESS_BRANCH_KEY}`) ? [key.slice(7, -(HARNESS_BRANCH_KEY.length + 1))] : []
  }))
}
const worktrees = (path: string) => git(path, ['worktree', 'list', '--porcelain']).then(parseWorktrees, () => [])
const real = (path: string) => realpath(path).catch(() => normalize(path))
const isDirectory = (path: string) => stat(path).then(info => info.isDirectory(), () => false)

/** The main checkout, when `root` is one of its linked worktrees. */
async function mainCheckout(root: string, trees: Worktree[]): Promise<string | null> {
  if (trees.length < 2 || !trees[0]!.usable) return null
  const here = await real(root)
  if (await real(trees[0]!.path) === here) return null
  for (const tree of trees.slice(1)) if (await real(tree.path) === here) return trees[0]!.path
  return null
}

/** Read only: listing a branch never checks it out or fetches from a remote. */
export async function readGitProject(path: string) {
  if (!validGitPath(path)) return { error: 'INVALID_PATH' }
  let root: string
  try { root = await git(path, ['rev-parse', '--show-toplevel']) }
  catch (error) {
    const failure = error as { code?: number | string; killed?: boolean }
    return !failure.killed && failure.code === 128 ? { isGit: false, branches: [] } : { error: 'GIT_UNAVAILABLE' }
  }
  try {
    const [branch, refs, trees, originHead, marked, owner] = await Promise.all([
      git(path, ['symbolic-ref', '--quiet', 'HEAD']).then(ref => ref.replace(/^refs\/heads\//, '')).catch(() => null),
      git(path, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(symref)', 'refs/heads', 'refs/remotes']),
      worktrees(path),
      git(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => null),
      harnessBranches(path),
      branchOwner(),
    ])
    const checkedOut = new Map(trees.flatMap(tree => tree.usable && tree.ref ? [[tree.ref, tree.path] as const] : []))
    const branches = refs.split('\n').filter(Boolean).flatMap(line => {
      const [ref, name, symbolic] = line.split('\t')
      if (!ref || !name || symbolic) return []
      const worktree = checkedOut.get(ref)
      const harness = !ref.startsWith('refs/remotes/') && (marked.has(name) || name.startsWith('harness/'))
      return [{ ref, name, remote: ref.startsWith('refs/remotes/'), ...(worktree ? { worktree } : {}), ...(harness ? { harness } : {}) }]
    })
    // Where new work starts by default: the remote's default branch, as a clone names it, else its
    // main or master.
    const known = new Set(branches.map(row => row.ref))
    const defaultRef = [originHead, 'refs/remotes/origin/main', 'refs/remotes/origin/master'].find(ref => ref && known.has(ref))
    const found = { isGit: true, root, branch, branches, owner, ...(defaultRef ? { defaultRef } : {}) }
    // A worktree is a temporary folder. The launcher shows its repository.
    const main = await mainCheckout(root, trees)
    if (!main) return found
    const prefix = (await git(path, ['rev-parse', '--show-prefix']).catch(() => '')).replace(/\/$/, '')
    const mainFolder = prefix && await isDirectory(join(main, prefix)) ? join(main, prefix) : main
    const mainBranch = trees[0]!.ref?.replace(/^refs\/heads\//, '')
    return { ...found, mainFolder, ...(mainBranch ? { mainBranch } : {}) }
  } catch { return { error: 'GIT_UNAVAILABLE' } }
}

/** `refs/remotes/origin/fix/typo` → origin, fix/typo, and a refspec updating exactly that ref. */
function remoteBranch(ref: string | undefined): { remote: string; branch: string; refspec: string } | null {
  const match = /^refs\/remotes\/([A-Za-z0-9._][A-Za-z0-9._-]*)\/([A-Za-z0-9._]\S*)$/.exec(ref ?? '')
  if (!match || match[2] === 'HEAD') return null
  return { remote: match[1]!, branch: match[2]!, refspec: `+refs/heads/${match[2]}:refs/remotes/${match[1]}/${match[2]}` }
}

export type GitProjectOptions = {
  root: string
  worktree: boolean
  /** Worktree on: what a new branch starts from. Worktree off: the branch the folder is on. */
  ref?: string
  /** The worktree's branch: created from `ref`, or with `existingBranch` checked out as it is. */
  branchName?: string
  existingBranch?: boolean
  /** `branchName` was made up (`deehw/brave-otter`): the session's name replaces it once there is one. */
  placeholder?: boolean
  pick?: (n: number) => number
}

/** Worktree on: a new worktree under `<root>/worktrees/<repository>`, on `branchName` — created from
 * `ref`, or with `existingBranch` an existing local branch checked out as it is. Without a name one
 * is made up (`harness/brave-otter`). A remote base is fetched first, briefly.
 *
 * Worktree off: the folder on the local `ref`. A branch that already has a worktree opens there; any
 * other is switched to, only in a folder with nothing uncommitted. With `branchName` the folder moves
 * to that new branch, made where it is now, uncommitted changes and all. */
export async function prepareGitProject(source: string, options: GitProjectOptions): Promise<string> {
  if (!validGitPath(source) || (options.branchName !== undefined && !plausibleBranchName(options.branchName))
      || (options.existingBranch && !options.branchName)) {
    throw new GitProjectError('INVALID_PROJECT_SOURCE', 'Choose a Git project folder.')
  }
  const existing = options.existingBranch === true
  // A new branch for the folder itself: `ref` names it and does not exist.
  const creating = !options.worktree && !!options.branchName && !existing
  let root: string, head: string, prefix: string
  try {
    root = await git(source, ['rev-parse', '--show-toplevel'])
    if (options.ref && !creating) {
      if (!/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/.test(options.ref)) throw new Error('Invalid branch')
      await git(source, ['show-ref', '--verify', '--hash', '--', options.ref])
    }
    // New work starts from where its branch is now, not from the last fetch: a remote branch is
    // fetched; a local one is fetched against its upstream and the newer of the two taken, so nothing
    // only the local one has is lost. Offline, slow or refused, it starts from what is here.
    let start = existing ? `refs/heads/${options.branchName}` : creating ? 'HEAD' : options.ref ?? 'HEAD'
    const remote = options.worktree && !existing ? remoteBranch(options.ref) : null
    const upstream = options.worktree && !existing && !remote && options.ref
      ? await git(source, ['for-each-ref', '--format=%(upstream)', options.ref]).then(ref => remoteBranch(ref) ? ref : null, () => null)
      : null
    const fetch = remote ?? remoteBranch(upstream ?? undefined)
    if (fetch) await git(source, ['fetch', '--quiet', '--no-tags', fetch.remote, fetch.refspec], 10_000).catch(() => '')
    // Behind or level with its upstream: the upstream is the newer.
    if (upstream && options.ref && await git(source, ['merge-base', '--is-ancestor', options.ref, upstream]).then(() => true, () => false)) {
      start = upstream
    }
    head = await git(source, ['rev-parse', '--verify', '--end-of-options', `${start}^{commit}`])
    prefix = await git(source, ['rev-parse', '--show-prefix'])
    if (prefix && await git(source, ['cat-file', '-t', `${head}:${prefix.replace(/\/$/, '')}`]) !== 'tree') throw new Error('Missing folder')
  } catch {
    throw new GitProjectError('GIT_PROJECT_UNAVAILABLE', 'Choose a Git project and branch with at least one commit. For a new folder, turn Worktree off.')
  }
  const inside = (folder: string) => prefix ? join(folder, prefix.replace(/\/$/, '')) : folder
  const trees = await worktrees(source)
  if (creating) {
    const name = options.branchName!
    if (await git(source, ['show-ref', '--verify', '--quiet', '--', `refs/heads/${name}`]).then(() => true, () => false)) {
      throw new GitProjectError('BRANCH_EXISTS', `A branch named ${name} already exists. Choose it instead.`)
    }
    try { await git(source, ['check-ref-format', '--branch', name]) }
    catch { throw new GitProjectError('INVALID_BRANCH', `${name} is not a valid branch name.`) }
    try { await git(source, ['switch', '-c', name]) }
    catch { throw new GitProjectError('BRANCH_SWITCH_FAILED', `Could not create ${name} here.`) }
    return source
  }
  if (!options.worktree) {
    if (!options.ref?.startsWith('refs/heads/')) throw new GitProjectError('INVALID_BRANCH', 'Choose a local branch, or turn Worktree on.')
    const current = await git(source, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null)
    if (current === options.ref) return source
    // A branch that already has a worktree is worked on there: Git would refuse to check it out
    // twice, and the folder is not the person's concern.
    for (const tree of trees) {
      if (tree.usable && tree.ref === options.ref && await isDirectory(tree.path)) return inside(tree.path)
    }
    const status = await git(source, ['status', '--porcelain']).catch(() => null)
    if (status !== '') {
      throw new GitProjectError('BRANCH_SWITCH_FAILED', 'This folder has uncommitted changes. Commit or stash them before switching branches, or turn Worktree on.')
    }
    try {
      await git(source, ['switch', '--', options.ref.slice('refs/heads/'.length)], 120_000)
      return source
    } catch {
      throw new GitProjectError('BRANCH_SWITCH_FAILED', 'Could not switch branches. Commit or stash conflicting changes, or turn Worktree on.')
    }
  }
  // Grouped by repository, so the leaf only needs the branch.
  const repository = trees[0]?.usable ? basename(trees[0].path) : basename(root)
  const taken = new Set((await git(source, ['for-each-ref', '--format=%(refname)', 'refs/heads']).catch(() => '')).split('\n'))
  const branch = options.branchName ?? placeholderBranch(taken, await branchOwner(), options.pick)
  const placeholder = !options.branchName || options.placeholder === true
  if (existing) {
    if (!taken.has(`refs/heads/${branch}`)) throw new GitProjectError('GIT_PROJECT_UNAVAILABLE', 'That branch is no longer available. Choose another branch.')
    if (trees.some(tree => tree.ref === `refs/heads/${branch}`)) {
      throw new GitProjectError('BRANCH_IN_USE', `${branch} is checked out in another worktree. Turn Worktree off to open it there.`)
    }
  } else {
    if (taken.has(`refs/heads/${branch}`)) throw new GitProjectError('BRANCH_EXISTS', `A branch named ${branch} already exists. Choose another name.`)
    try { await git(source, ['check-ref-format', '--branch', branch]) }
    catch { throw new GitProjectError('INVALID_BRANCH', `${branch} is not a valid branch name.`) }
  }
  let destination: string | undefined
  try {
    const home = join(options.root, 'worktrees')
    const parent = join(home, repository)
    await mkdir(parent, { recursive: true })
    // Spotlight would index every checkout again.
    if (process.platform === 'darwin') await writeFile(join(home, '.metadata_never_index'), '').catch(() => {})
    const leaf = worktreeFolderName(branch)
    // mkdir reserves the name atomically, so simultaneous starts never share a worktree.
    for (let attempt = 1; attempt <= 100 && !destination; attempt++) {
      const folder = join(parent, attempt === 1 ? leaf : `${leaf}-${attempt}`)
      try { await mkdir(folder); destination = folder }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  } catch { destination = undefined }
  if (!destination) throw new GitProjectError('WORKTREE_FAILED', 'Could not create a worktree folder. Check folder permissions, then retry.')
  const remote = remoteBranch(options.ref)
  try {
    await git(source, existing
      ? ['worktree', 'add', '--', destination, branch]
      // A remote branch checked out under its own name tracks it; a new branch from one must not,
      // or it would push onto the base.
      : remote && remote.branch === branch
        ? ['worktree', 'add', '--track', '-b', branch, '--', destination, options.ref!]
        : ['worktree', 'add', '--no-track', '-b', branch, '--', destination, head], 120_000)
  } catch {
    // Keep any partial checkout and branch available for recovery.
    throw new GitProjectError('WORKTREE_FAILED', `Could not create the worktree at ${destination}. Check Git and folder permissions, then retry.`)
  }
  // Harness made this branch: its cleanup may remove it, and a made-up name gives way to the session's.
  if (!existing) {
    await git(source, ['config', `branch.${branch}.${HARNESS_BRANCH_KEY}`, placeholder ? 'placeholder' : 'created']).catch(() => '')
  }
  await copyIncluded(root, destination)
  return inside(destination)
}

/** `.worktreeinclude` (gitignore syntax) in the repository names ignored files a new worktree needs
 * and Git will not bring: `.env`, local config. Only files both listed and ignored are copied, never
 * over one the checkout has. A copy that fails leaves the worktree as Git made it. */
async function copyIncluded(from: string, to: string): Promise<void> {
  const include = join(from, '.worktreeinclude')
  try {
    if (!(await stat(include)).isFile()) return
  } catch { return }
  const list = (exclude: string) => git(from, ['ls-files', '-z', '--others', '--ignored', '--directory', exclude])
    .then(out => out.split('\0').filter(Boolean), () => [] as string[])
  const [listed, ignored] = await Promise.all([list(`--exclude-from=${include}`), list('--exclude-standard')])
  const isIgnored = (entry: string) => ignored.some(path => path === entry || (path.endsWith('/') && entry.startsWith(path)))
  for (const entry of listed.filter(isIgnored).slice(0, 200)) {
    const relative = entry.replace(/\/$/, '')
    if (relative.split('/').includes('..')) continue
    const target = join(to, relative)
    try { await lstat(target); continue } catch { /* free */ }
    try {
      await mkdir(dirname(target), { recursive: true })
      await cp(join(from, relative), target, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true, preserveTimestamps: true })
    } catch { /* the worktree stays as Git made it */ }
  }
}
