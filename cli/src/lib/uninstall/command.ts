/**
 * `harness uninstall [--yes] [--keep-data]`: Harness off this computer, on every OS (spec section 5).
 *
 * The order is not the order a person would list the parts in:
 *  1. the harnesses, through the running daemon, which knows which process is each one's, while it is there to ask;
 *  2. the login service, before the daemon: launchd's KeepAlive and the scheduled task's five-minute trigger would
 *     otherwise start it again in the middle;
 *  3. the daemon, then whatever the terminal host still runs (before anything under runtime/pty goes);
 *  4. the hooks, once no daemon is left to write them back on its next start;
 *  5. the launchers and the PATH entry, then the files. On Windows a program cannot delete the node.exe it runs from,
 *     nor bin\harness.exe while it waits for that node.exe, so the files go in a cmd.exe that waits for this process
 *     to exit (removal.ts).
 * A service that would not go, or a daemon that would not stop, ends it before anything is deleted: what was left
 * would start a program that is no longer there. Everything after that is reported, and the rest is still done.
 *
 * The spawn lock is held for the service and the daemon only. The harnesses are stopped before it, through the daemon
 * (the brief's order: a `harness start` cannot land while a stop of each harness runs, since the daemon is up and
 * holds its record). It is released before the hooks and the files: by then there is no service to start a daemon,
 * and a `harness start` the person runs in between starts one that the files' removal takes away under it. Accepted
 * (B5.9 review, M9): holding the lock through the files would make that start wait, then fail the same way.
 *
 * The summary is what a person trusts to know whether Harness is gone: it never says "uninstalled" over files that were
 * not removed, nor over a step that did not start. Each problem is a plain clause, what went wrong in brackets after
 * it, then what it leaves or what to do.
 */
import { posix, win32 } from 'node:path'
import type { HookFileRemoval } from '../../engines/kit/hookRemoval.js'
import type { SpawnLockOwner, SpawnLockPurpose } from '../daemonSpawnLock.js'
import type { AgentsStopped } from './agents.js'
import type { PtyHostEnd } from './ptyHosts.js'
import { RC_MARKER, type RcOutcome } from './rcFiles.js'
import { DESKTOP_STATE, removalPlan, RemovalRefused, type FinalRemoval, type RemovalPlan, type RootEntry } from './removal.js'
import type { PathRemoval } from './windowsPath.js'

export const UNINSTALL_USAGE = [
  'Usage: harness uninstall [--yes] [--keep-data]',
  '',
  '  Removes Harness from this computer: stops every harness and the Harness daemon, takes it out of the login',
  '  service, removes the hooks it added to your agents, its commands and PATH entry, and ~/.harness.',
  '',
  '  --yes, -y     do not ask first',
  '  --keep-data   keep your sign-in, this computer\'s identity, history and settings for a later install',
].join('\n')

const KNOWN = new Set(['--yes', '-y', '--keep-data'])

export interface UninstallService {
  name: string
  present(): boolean
  unregister(): { ok: true } | { ok: false; detail: string }
}

export type PathStep = { kind: 'windows'; result: PathRemoval } | { kind: 'rc'; edits: RcOutcome[]; keptFor: string[] }

/**
 * What a hook file is, for the sentence about it: an engine's settings (Harness's entries among the person's), a file
 * that is Harness's whole (a plugin, Codex's rules file), Codex's records of hooks it reviewed, or the list of homes the
 * person moved an engine to.
 */
export type HookFileKind = 'settings' | 'file' | 'reviews' | 'adopted'
export interface UninstallHookFile extends HookFileRemoval {
  kind?: HookFileKind
  /** Codex's hooks.json, whose review records are keyed by each hook's place in it. */
  codex?: true
  /** Claude Code's settings, whose permission rules are Harness's by their text alone. */
  claude?: true
}

export interface HookFileLabels {
  claudeSettings: ReadonlySet<string>
  codexSettings: ReadonlySet<string>
  reviews: ReadonlySet<string>
  whole: ReadonlySet<string>
  /** removeHooks.ts ADOPTED_HOMES: the report's name for the homes it could not read. */
  adopted: string
  /** nativeHookYaml.ts YAML_HOOKS_KEPT: Harness's commands left in a mapping Harness did not write. */
  hooksLeft: string
}

/** [hook] with what kind of file it is. Hooks of Harness's left in a file are a failure to report, not a kept file. */
export function labelHookRemoval(hook: HookFileRemoval, labels: HookFileLabels): UninstallHookFile {
  const kind: HookFileKind = hook.file === labels.adopted ? 'adopted' : labels.reviews.has(hook.file) ? 'reviews' : labels.whole.has(hook.file) ? 'file' : 'settings'
  const labelled: UninstallHookFile = {
    ...hook, kind,
    ...(labels.codexSettings.has(hook.file) ? { codex: true as const } : {}),
    ...(labels.claudeSettings.has(hook.file) ? { claude: true as const } : {}),
  }
  if (hook.kept === labels.hooksLeft) {
    delete labelled.kept
    labelled.failed = 'they are in a hooks: section Harness did not write'
  }
  return labelled
}

/**
 * The daemon lock could not be taken. `busy`: another Harness command (a start, an update) held it for longer than the
 * uninstall waits, and the message says who. `foreign`: the lock's path holds something this CLI did not make, which no
 * other command is going to release; the message says what (daemonSpawnLock.ts SpawnLockBusyError `reason`).
 */
export class UninstallLockBusy extends Error {
  override name = 'UninstallLockBusy'
  constructor(readonly kind: 'busy' | 'foreign', detail: string) { super(detail) }
}

const LOCK_PURPOSE: Record<SpawnLockPurpose, string> = {
  start: 'started', update: 'updated', handoff: 'restarted for an update', stop: 'stopped', login: 'signed in',
}

/** Who holds the daemon lock, as a person reads it: "Harness is being updated by process 51, for 4 seconds". */
export function lockHolder(owner: Pick<SpawnLockOwner, 'pid' | 'purpose' | 'since'>, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - owner.since) / 1000))
  return `Harness is being ${LOCK_PURPOSE[owner.purpose] ?? 'used'} by process ${owner.pid}, for ${plural(seconds, 'second')}`
}

export interface UninstallDeps {
  platform: NodeJS.Platform
  cwd: string
  home: string
  /** ~/.harness, the product root (config/env.ts). */
  root: string
  cliDir: string
  dataDir: string
  authDir: string
  isTTY: boolean
  /** Harness OS: its package owns the CLI (lib/platformDaemon.ts osDaemonUnit). */
  harnessOs: boolean
  /** The Harness terminal pane this command was typed in (HARNESS_PANE on Windows, TMUX_PANE elsewhere), if any. */
  pane: string | null
  /**
   * Writes the uninstall marker (removal.ts UNINSTALL_MARKER): the desktop app starts no daemon while it is there.
   * The step that removes the files removes it last; [unmarkUninstalling] does on every other way out.
   */
  markUninstalling(): void
  unmarkUninstalling(): void
  ask(question: string): Promise<string>
  daemonPid(): number | null
  alive(pid: number): boolean
  stopAgents(): Promise<AgentsStopped>
  service: UninstallService | null
  /** Under the daemon spawn lock; rejects with UninstallLockBusy when another Harness command holds it too long. */
  withLock<T>(fn: () => Promise<T>): Promise<T>
  stopDaemon(): Promise<{ pid: number | null; stopped: boolean }>
  endPtyHosts(): Promise<PtyHostEnd[]>
  removeHooks(): Promise<UninstallHookFile[]>
  /** mac and Linux: the launchers in ~/.local/bin (on Windows they are in ~\.harness\bin, with the rest). A launcher
   *  removed is its path; one that could not be, the path and why. */
  removeLaunchers(): Array<string | { path: string; failed: string }>
  removePathEntry(): PathStep
  listEntries(dir: string): RootEntry[]
  exists(path: string): boolean
  /** removal.ts checkRemovable: throws RemovalRefused for a plan removeNow or the last step would refuse. */
  checkRemovable(plan: RemovalPlan): void
  /** Throws RemovalRefused, removing nothing, on a plan it will not carry out. */
  removeNow(plan: RemovalPlan): string[]
  /** Throws RemovalRefused, writing and starting nothing, on a plan it will not carry out. */
  scheduleFinalRemoval(plan: RemovalPlan): FinalRemoval
  /** What stays that is not Harness's to remove (grid's own sign-in). */
  afterword(): void
  out(line: string): void
  err(line: string): void
  tildify(path: string): string
}

function inside(root: string, path: string, windows: boolean): boolean {
  const p = windows ? win32 : posix
  let [base, at] = [p.resolve(root), p.resolve(path)]
  if (windows) [base, at] = [base.toLowerCase(), at.toLowerCase()]
  return at === base || at.startsWith(base + p.sep)
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** A sentence ending in a full stop, without it: the report's lines are clauses. */
const clause = (text: string): string => text.trim().replace(/\.$/, '')

/** hookRemoval.ts gets this from nativeHookFiles.ts, for a whole file that is a link: Harness never deletes through one. */
const ALIAS = 'the plugin entry is an alias'

/** Where Windows keeps the user's PATH, as a person finds it: the Start menu's search finds this name. */
const WINDOWS_PATH_SETTING = 'Edit environment variables for your account'

/** The pid is not named: before the stop it is only the pid file's, which a reboot can leave naming another process. */
function whatItDoes(deps: UninstallDeps, daemon: number | null, keepData: boolean): string[] {
  const root = deps.tildify(deps.root)
  return [
    'harness uninstall removes Harness from this computer:',
    ...(daemon !== null ? ['  · stops every harness running here, then the Harness daemon'] : []),
    ...(deps.service?.present() ? [`  · takes the Harness daemon out of ${deps.service.name}, so it no longer starts at login`] : []),
    // The rules are recognized by their text: one the person added that is the same as Harness's cannot be told apart (B5.5).
    '  · removes the hooks and permission rules Harness added to Claude Code, Codex and your other agents (a rule of yours that is the same as one of Harness\'s goes too)',
    deps.platform === 'win32'
      ? `  · removes ${deps.tildify(win32.join(deps.root, 'bin'))} from your PATH`
      : '  · removes the harness and hn commands, and the PATH line the installer added',
    keepData
      ? `  · deletes the program in ${root}, and keeps your sign-in, this computer's identity, history and settings there`
      : `  · deletes ${root}: your sign-in, this computer's identity, history and settings (--keep-data keeps them)`,
    '',
  ]
}

function planFor(deps: UninstallDeps, keepData: boolean): RemovalPlan {
  return removalPlan({
    platform: deps.platform, root: deps.root, home: deps.home, entries: deps.listEntries(deps.root),
    cliDir: deps.cliDir, cliEntries: deps.listEntries(deps.cliDir), dataDir: deps.dataDir, keepData,
  })
}

/** A refusal's sentence, with the home as ~ and what to do next. */
function refusal(deps: UninstallDeps, error: RemovalRefused): string {
  const said = clause(error.message).split(deps.root).join(deps.tildify(deps.root))
  const next = /a link to another folder$/.test(said) ? ' Remove the link yourself, and the folder it points to if it is Harness\'s.' : ''
  return `${said}. Nothing was removed.${next}`
}

function reportHooks(deps: UninstallDeps, hooks: readonly UninstallHookFile[], problems: string[]): void {
  let codex: string | undefined
  let claude: string | undefined
  for (const hook of hooks) {
    const file = deps.tildify(hook.file)
    const kind = hook.kind ?? 'settings'
    if (hook.removed) {
      if (kind === 'file') deps.out(`✓ removed ${file}`)
      else if (kind === 'reviews') deps.out(`✓ removed Codex's record of Harness's hooks from ${file}`)
      else deps.out(`✓ removed Harness's hooks from ${file}`)
      if (hook.codex) codex ??= file
      if (hook.claude) claude ??= file
    }
    if (hook.failed) {
      const link = hook.failed === ALIAS
      const why = link ? 'the file is a link' : hook.failed
      if (kind === 'adopted') problems.push(`could not read which other folders Claude Code and Codex were moved to (${why}), so Harness's hooks were removed from their usual folders only`)
      // A record of a hook that is gone matches nothing Codex runs: it is left, said, and not a reason to fail.
      else if (kind === 'reviews') deps.out(`· left Codex's record of Harness's hooks in ${file} (${why}): it does nothing once the hooks are gone`)
      else if (kind === 'file') problems.push(`${file} is still there (${why}): remove it by hand`)
      else problems.push(`Harness's hooks are still in ${file} (${why}): ${link ? 'remove it by hand' : 'remove the entries that run notify.mjs'}`)
    }
    if (hook.kept) deps.out(`· kept ${file}: it is ${hook.kept}`)
  }
  // Said again here, and not only in the question: --yes never asks it (B5.9 review, M7).
  if (claude) deps.out(`· if you had added a permission rule in ${claude} that is the same as one of Harness's, it went too: add it again if you need it`)
  // Codex keys each record of a reviewed hook by its place in hooks.json: taking Harness's block out moves the person's.
  if (codex) deps.out(`· Codex may ask you to review your own hooks again: it remembers the hooks you reviewed by their place in ${codex}, and taking Harness's out moved them`)
}

function reportPath(deps: UninstallDeps, path: PathStep, problems: string[]): void {
  if (path.kind === 'windows') {
    if (path.result.state === 'removed') {
      deps.out(`✓ removed ${deps.tildify(path.result.folder)} from your PATH`)
      if (path.result.note) deps.out(`· ${path.result.note}`)
    }
    if (path.result.state === 'failed') {
      const folder = deps.tildify(path.result.folder)
      problems.push(`Harness could not take ${folder} off your PATH (${path.result.detail}): remove it yourself in "${WINDOWS_PATH_SETTING}"`)
    }
    return
  }
  for (const edit of path.edits) {
    if (edit.removed) deps.out(`✓ removed the PATH line Harness added to ${deps.tildify(edit.file)}`)
    if (edit.failed) problems.push(`could not edit ${deps.tildify(edit.file)} (${edit.failed}): remove the line "${RC_MARKER}" and the line under it`)
    if (edit.changedByPerson) deps.out(`· kept a "${RC_MARKER}" line in ${deps.tildify(edit.file)}: the line under it was changed, so it is yours now`)
  }
  if (path.keptFor.length) {
    const named = path.keptFor.slice(0, 3).join(', ') + (path.keptFor.length > 3 ? ' and more' : '')
    deps.out(`· kept the PATH line in your shell's startup file: ~/.local/bin also holds ${named}, which ${path.keptFor.length === 1 ? 'needs' : 'need'} it`)
  }
}

/**
 * The files. Returns false when they were not removed nor set to be: the uninstall is then only partly done.
 * [handover.done] is set once the Windows last step has them, and the uninstall marker with them.
 */
function removeFiles(deps: UninstallDeps, keepData: boolean, problems: string[], handover: { done: boolean }): boolean {
  const windows = deps.platform === 'win32'
  const root = deps.tildify(deps.root)
  let plan: RemovalPlan
  try {
    // Made again: the harnesses, the daemon and the terminal host may have changed what is in the root since the check.
    plan = planFor(deps, keepData)
    // Nothing to take: no step to start, and no line about it.
    if (!plan.remove.length && (!plan.removeRoot || !deps.exists(deps.root))) return true
    // What stays in the root besides what could not be removed: the desktop app's state, or with --keep-data the data.
    const what = keepData ? `the program in ${root}` : plan.removeRoot ? root : `everything in ${root} except ${plan.kept.join(', ')}`
    if (windows) {
      const final = deps.scheduleFinalRemoval(plan)
      // What Windows said, in brackets, for a bug report; the sentence around it is the person's.
      if (!final.ok) { problems.push(`${final.reason} (${final.detail}) ${final.manual}`); return false }
      handover.done = true
      deps.out(`✓ ${what} goes once this command has exited (anything left is listed in ${final.log})`)
    } else {
      const left = deps.removeNow(plan)
      for (const stayed of left) if (stayed !== plan.root) problems.push(`could not remove ${deps.tildify(stayed)}: delete it yourself`)
      // rmdir, never a recursive remove: the root goes only when what the plan named was all that was in it.
      if (left.includes(plan.root)) {
        problems.push(left.length > 1 ? `${root} is still there, with what could not be removed in it`
          : `${root} is still there: something was added to it during the uninstall. Look in it, then delete it yourself`)
      }
      if (!left.length) deps.out(keepData ? `✓ removed the program from ${root}` : `✓ removed ${what}`)
    }
  } catch (error) {
    if (error instanceof RemovalRefused) problems.push(`${clause(error.message)}. None of its files were deleted`)
    else problems.push(`Harness could not remove its files in ${root} (${message(error)}): delete ${root} yourself once this command has finished`)
    return false
  }
  if (plan.kept.some((name) => DESKTOP_STATE.test(name))) {
    deps.out(`· kept the Harness desktop app's own settings in ${root}: the app sets Harness up again when it starts. Remove the app to remove them.`)
  }
  return true
}

/**
 * One step after the daemon has stopped. An error nobody expected is one more problem in the summary, with what it
 * leaves: the steps after it still run, and the person still reads what was done (B5.9 review, M4).
 */
async function step(problems: string[], failed: (detail: string) => string, run: () => unknown): Promise<void> {
  try { await run() } catch (error) { problems.push(failed(message(error))) }
}

export async function uninstallCommand(argv: readonly string[], deps: UninstallDeps): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) { deps.out(UNINSTALL_USAGE); return 0 }
  const unknown = argv.find((arg) => !KNOWN.has(arg))
  if (unknown !== undefined) { deps.err(`Unknown option for harness uninstall: ${unknown}\n\n${UNINSTALL_USAGE}`); return 2 }
  const yes = argv.includes('--yes') || argv.includes('-y')
  const keepData = argv.includes('--keep-data')
  const windows = deps.platform === 'win32'
  if (deps.harnessOs) { deps.err('✗ Harness is part of this Harness operating system, which keeps it installed. Nothing was removed.'); return 1 }
  // Stopping the harnesses, then the daemon and the terminal host, ends this pane and the command in it: before
  // anything is removed, or with the service and the daemon gone and the hooks and files still there, and no summary.
  if (deps.pane) {
    deps.err('✗ This terminal is one of Harness\'s, which the uninstall closes before it has finished. Run harness uninstall from a terminal outside Harness.')
    return 1
  }
  if (windows && inside(deps.root, deps.cwd, true)) {
    deps.err(`✗ This terminal is in ${deps.tildify(deps.cwd)}, which the uninstall removes, and Windows cannot delete a folder a terminal is in. Run \`cd ~\`, then run it again.`)
    return 1
  }
  let daemon: number | null
  try {
    // A root the last step would refuse is refused now, before a harness, the service or the daemon is touched (I1).
    deps.checkRemovable(planFor(deps, keepData))
    daemon = deps.daemonPid()
    if (!yes) {
      if (!deps.isTTY) { deps.err('✗ harness uninstall asks before it removes anything. Run it in a terminal, or add --yes. Nothing was removed.'); return 1 }
      for (const line of whatItDoes(deps, daemon, keepData)) deps.out(line)
      const answer = (await deps.ask('  Remove Harness from this computer? [y/N] ')).trim().toLowerCase()
      if (answer !== 'y' && answer !== 'yes') { deps.out('Nothing was removed.'); return 1 }
    }
  } catch (error) {
    if (error instanceof RemovalRefused) deps.err(`✗ ${refusal(deps, error)}`)
    // Before the first step: whatever went wrong, nothing has been touched yet (B5.9 review round 2).
    else deps.err(`✗ harness uninstall could not start (${clause(message(error))}). Nothing was removed.`)
    return 1
  }
  // From here the daemon goes, and a desktop app that is open would start it again: on the files being removed, which it
  // then holds until a reboot. The marker stops it until the files are gone.
  deps.markUninstalling()
  const handover = { done: false }
  try {
    return await removeHarness(deps, daemon, keepData, handover)
  } finally {
    if (!handover.done) { try { deps.unmarkUninstalling() } catch { /* a marker left behind stops counting on its own */ } }
  }
}

/** Everything after the question: the steps in the order the comment at the top gives. */
async function removeHarness(deps: UninstallDeps, daemon: number | null, keepData: boolean, handover: { done: boolean }): Promise<number> {
  const windows = deps.platform === 'win32'
  const problems: string[] = []
  const notDeleted = 'None of Harness\'s files were deleted.'

  // A daemon that did not answer is a problem only once the stop shows there was one: a pid file left by a crash or a
  // reboot can name a live process that is not Harness's, and nothing then went wrong (I2).
  let unreachable: string | undefined
  if (daemon !== null) {
    // stopEveryAgent reports a daemon it cannot reach; anything else it throws is read the same way.
    const agents = await deps.stopAgents().catch((error: unknown) => ({ stopped: 0, failed: [], unreachable: message(error) }))
    if (agents.unreachable) unreachable = `Harness could not ask the Harness daemon to stop the harnesses (${clause(agents.unreachable)}), so some harnesses may still be running`
    if (agents.stopped) deps.out(`✓ stopped ${plural(agents.stopped, 'harness', 'harnesses')}`)
    for (const failed of agents.failed) problems.push(`the harness ${failed.name} did not stop (${failed.error}), so it may still be running`)
  }

  let halted: string | null
  let ended: number | null = null
  try {
    halted = await deps.withLock(async () => {
      if (deps.service?.present()) {
        const removed = deps.service.unregister()
        if (!removed.ok) {
          return `${deps.service.name} would not let go of the Harness daemon (${clause(removed.detail)}). ${notDeleted} Try again; if it keeps failing, run \`harness service uninstall\` to see why.`
        }
        deps.out(`✓ removed the Harness daemon from ${deps.service.name}: it no longer starts at login`)
      }
      const stopped = await deps.stopDaemon()
      if (stopped.pid !== null && deps.alive(stopped.pid)) {
        return `The Harness daemon (pid ${stopped.pid}) did not stop. ${notDeleted} Run \`harness stop\`, then \`harness uninstall\` again.`
      }
      // launchd's bootout stops the daemon as it unregisters it, and the stop then finds none. A pid the stop found to
      // be another process's now (Windows gives freed pids out again) is still alive, and is not named.
      ended = stopped.pid ?? (daemon !== null && !deps.alive(daemon) ? daemon : null)
      if (ended !== null) deps.out(`✓ stopped the Harness daemon (pid ${ended})`)
      return null
    })
  } catch (error) {
    if (error instanceof UninstallLockBusy && error.kind === 'foreign') {
      deps.err(`✗ Harness found something it did not make where it keeps its daemon lock (${clause(error.message)}). ${notDeleted}`)
    } else if (error instanceof UninstallLockBusy) {
      deps.err(`✗ Another Harness command is using the Harness daemon (${clause(error.message)}). ${notDeleted} Try again in a moment.`)
    } else {
      deps.err(`✗ Harness could not stop the Harness daemon (${clause(message(error))}). ${notDeleted} Run \`harness stop\`, then \`harness uninstall\` again.`)
    }
    return 1
  }
  if (halted) { deps.err(`✗ ${halted}`); return 1 }
  if (unreachable && ended !== null) problems.unshift(unreachable)

  await step(problems, (detail) => `Harness could not end its terminal host (${detail}), so some terminals may still be open`, async () => {
    for (const host of await deps.endPtyHosts()) {
      if (host.how === 'left') problems.push(`the Harness terminal host is still running (pid ${host.pid}: ${host.detail}), so some terminals may still be open`)
      else if (host.panes) deps.out(`✓ ended ${plural(host.panes, 'terminal')} in the Harness terminal host`)
    }
  })

  await step(problems, (detail) => `Harness could not remove its hooks from your agents' settings (${detail}), so your agents may still try to reach Harness`,
    async () => reportHooks(deps, await deps.removeHooks(), problems))

  if (!windows) {
    await step(problems, (detail) => `Harness could not remove the harness and hn commands (${detail}): delete them from ~/.local/bin yourself`, () => {
      for (const launcher of deps.removeLaunchers()) {
        if (typeof launcher === 'string') deps.out(`✓ removed ${deps.tildify(launcher)}`)
        else problems.push(`could not remove ${deps.tildify(launcher.path)} (${launcher.failed}): delete it yourself`)
      }
    })
  }

  await step(problems, (detail) => `Harness could not take itself off your PATH (${detail}): remove its entry yourself`,
    () => reportPath(deps, deps.removePathEntry(), problems))

  const filesDone = removeFiles(deps, keepData, problems, handover)
  if (!keepData) {
    const root = deps.tildify(deps.root)
    for (const dir of [deps.dataDir, deps.authDir]) {
      if (!inside(deps.root, dir, windows) && deps.exists(dir)) deps.out(`· left ${deps.tildify(dir)}: it is outside ${root} (ADAPTER_DATA_DIR or HARNESS_AUTH_DIR names it); delete it yourself if it is Harness's`)
    }
  }
  // A note about what is not Harness's: nothing to report when it cannot be said.
  try { deps.afterword() } catch { /* the summary is what matters */ }

  if (problems.length) {
    deps.err(filesDone ? '✗ Harness is uninstalled, except:' : '✗ Harness is only partly uninstalled:')
    // A problem may name paths on lines of their own: those are indented under it.
    for (const problem of problems) deps.err(`  · ${problem.replace(/\n {2}/g, '\n      ')}`)
    return 1
  }
  deps.out(keepData ? 'Harness is uninstalled. Your sign-in and history are kept for the next install.' : 'Harness is uninstalled.')
  return 0
}
