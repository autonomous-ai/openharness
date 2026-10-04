/**
 * The source-control seam: what Harness asks of a project's SCM, in one shape, so a second system can
 * be added beside git rather than swapped in — the rule CONTRIBUTING.md already sets for multiplexers.
 * Today the only implementation wraps the git path — `gitProject.ts` (detect, prepare),
 * `agentProject.ts` (describe), `branchNaming.ts` (rename), `worktreeSweep.ts` (sweep) — and changes
 * nothing about it. The git assumptions those modules make (the `.git` file marker,
 * `branch.<name>.harness` config keys, `refs/heads/…` validation, `git status --porcelain` as
 * "dirty") stay inside the git implementation and never reach a caller.
 *
 * Nothing in this file runs a subprocess. `parseScmLaunchRecord` is here rather than beside the
 * implementations because the registry rehydrates rows with it and must not pull the implementations
 * (and their git modules) in just to validate one field — the same split `gridLaunch.ts` makes with
 * `parseGridLaunchOverride`.
 */
import type { AgentProject } from '../lib/agentProject.js'
import type { readGitProject } from '../lib/gitProject.js'

/** `none` is a folder no SCM claims: a real answer, not an error. */
export type ScmKind = 'git' | 'none'

/** What `git_project_info` answers when the folder IS a repository: `readGitProject`'s found shape. */
export type GitProjectInfo = Extract<Awaited<ReturnType<typeof readGitProject>>, { root: string }>

/**
 * The read-only probe's answer (`scm_project_info`). `kind: 'none'` with no `error` is a folder no SCM
 * claims; `error` carries the first implementation's failure code (`GIT_UNAVAILABLE`, `INVALID_PATH`,
 * `FORBIDDEN`) when one could not even look. `git` is present exactly when `kind` is `git`.
 */
export type ScmDetectResult = { kind: ScmKind; git?: GitProjectInfo; error?: string }

/** What the launcher's probe passes through to `readGitProject`: the same fence and refresh. */
export interface ScmDetectOptions {
  refresh?: boolean
  knownRoots?: string[]
}

/**
 * What `AgentFrame.project` carries: a superset of `AgentProject`, with the SCM named. `kind: 'none'`
 * is a folder no SCM claims — `root`, `remote` and `branch` are null, exactly as `agentProject`
 * reports them. `worktree` and `branchPending` keep their names for wire compatibility; another SCM
 * sets them with the same meaning (an isolated workspace; a name still the made-up one).
 */
export type ScmDescription = AgentProject & { kind: ScmKind }

/**
 * What a pane has to be launched WITH for the workspace to be the same one on every relaunch — the
 * SCM's half of what `gridLaunchRecord` is for a grid. Kept on the registry row (`scmLaunch`), so a
 * pane recreated after a reboot or respawned in place gets the same environment `agent_create` gave
 * it. Git needs nothing: the worktree is a folder and the folder is the row's `cwd`. A tagged union, so
 * an SCM whose workspace binding travels in environment variables adds its own member.
 */
export type ScmLaunchRecord = { kind: 'git' }

/** A record as the registry file has it, or null for anything else — an unknown kind, a half-formed
 *  record, a hand-edited row. A dropped record is relaunched without, never with a guess. */
export function parseScmLaunchRecord(raw: unknown): ScmLaunchRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record.kind === 'git') return { kind: 'git' }
  return null
}

/** `prepareGitProject`'s worktree options, with SCM-neutral names. */
export interface PrepareOptions {
  /** Harness's own folder (`~/harnesses`); the isolated workspace is made under it. */
  root: string
  /** What the workspace's work starts from — git: a `refs/heads/…` or `refs/remotes/…` ref.
   *  Absent: the SCM's own default (git: `HEAD`). */
  base?: string
  /** The name the workspace's line of work takes — git: its branch. Absent: made up. */
  name?: string
  /** `name` exists already and is taken as it is, rather than created from `base`. */
  existing?: boolean
  /** `name` was made up (`brave-otter`): the session's title replaces it once there is one (`rename`). */
  placeholder?: boolean
  /** Test seam for the made-up name (`agentNames.placeholderBranch`). */
  pick?: (n: number) => number
}

export interface ScmProject {
  readonly kind: Exclude<ScmKind, 'none'>
  /** Read-only probe for the launcher (today: `readGitProject` → `git_project_info`). Never mutates. */
  detect(path: string, options?: ScmDetectOptions): Promise<ScmDetectResult>
  /** Make an isolated workspace for one harness (today: `prepareGitProject` with `worktree: true`). */
  prepareIsolated(source: string, options: PrepareOptions): Promise<{ cwd: string; launchRecord: ScmLaunchRecord }>
  /** What a frame says about `cwd` (today: `agentProject`), or null when `cwd` is not this SCM's. */
  describe(cwd: string): Promise<ScmDescription | null>
  /** Once the session has a title (today: `nameBranchAfterSession`): the new name, or null when nothing was renamed. */
  rename(cwd: string, title: string | null): Promise<string | null>
  /** Remove idle isolated workspaces nothing uses (today: `sweepWorktrees`); the paths removed. */
  sweep(input: { root: string; inUse: Iterable<string | null | undefined>; now?: number; idleMs?: number }): Promise<string[]>
  /** Env to put in the pane at launch and every relaunch (git: nothing). */
  launchEnv(record: ScmLaunchRecord): Record<string, string>
  /** Before Harness itself writes into project files the SCM may hold read-only (the instruction files
   *  a harness or saved APIs append to). `paths` are relative to `cwd` and need not exist. Git has
   *  nothing to do and leaves this out, so no subprocess runs. */
  prepareWrite?(cwd: string, paths: readonly string[]): Promise<void>
  /** Forget what `describe` cached for `cwd`, as after a rename (today: `forgetAgentProject`). The
   *  cache is the implementation's, so its invalidation is too. */
  forget?(cwd: string): void
}
