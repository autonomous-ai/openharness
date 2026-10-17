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
 * The summary is what a person trusts to know whether Harness is gone: it never says "uninstalled" over files that were
 * not removed, nor over a step that did not start.
 */
import { posix, win32 } from 'node:path'
import type { HookFileRemoval } from '../../engines/kit/hookRemoval.js'
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
}

export interface HookFileLabels {
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
  const labelled: UninstallHookFile = { ...hook, kind, ...(labels.codexSettings.has(hook.file) ? { codex: true as const } : {}) }
  if (hook.kept === labels.hooksLeft) {
    delete labelled.kept
    labelled.failed = 'they are in a hooks: section Harness did not write'
  }
  return labelled
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
  ask(question: string): Promise<string>
  daemonPid(): number | null
  alive(pid: number): boolean
  stopAgents(): Promise<AgentsStopped>
  service: UninstallService | null
  /** Under the daemon spawn lock; rejects with a sentence when another Harness command holds it too long. */
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

function whatItDoes(deps: UninstallDeps, daemon: number | null, keepData: boolean): string[] {
  const root = deps.tildify(deps.root)
  return [
    'harness uninstall removes Harness from this computer:',
    ...(daemon !== null ? [`  · stops every harness running here, then the Harness daemon (pid ${daemon})`] : []),
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

function reportHooks(deps: UninstallDeps, hooks: readonly UninstallHookFile[], problems: string[]): void {
  let codex: string | undefined
  for (const hook of hooks) {
    const file = deps.tildify(hook.file)
    const kind = hook.kind ?? 'settings'
    if (hook.removed) {
      if (kind === 'file') deps.out(`✓ removed ${file}`)
      else if (kind === 'reviews') deps.out(`✓ removed Codex's record of Harness's hooks from ${file}`)
      else deps.out(`✓ removed Harness's hooks from ${file}`)
      if (hook.codex) codex ??= file
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
  // Codex keys each record of a reviewed hook by its place in hooks.json: taking Harness's block out moves the person's.
  if (codex) deps.out(`· Codex may ask you to review your own hooks again: it remembers the hooks you reviewed by their place in ${codex}, and taking Harness's out moved them`)
}

function reportPath(deps: UninstallDeps, path: PathStep, problems: string[]): void {
  if (path.kind === 'windows') {
    if (path.result.state === 'removed') {
      deps.out(`✓ removed ${deps.tildify(path.result.folder)} from your PATH`)
      if (path.result.note) deps.out(`· ${path.result.note}`)
    }
    if (path.result.state === 'failed') problems.push(`${deps.tildify(path.result.folder)} is still on your PATH: ${path.result.detail}`)
    return
  }
  for (const edit of path.edits) {
    if (edit.removed) deps.out(`✓ removed the PATH line Harness added to ${deps.tildify(edit.file)}`)
    if (edit.failed) problems.push(`could not edit ${deps.tildify(edit.file)} (${edit.failed}): remove the line "${RC_MARKER}" and the line under it`)
    if (edit.changedByPerson) deps.out(`· kept a "${RC_MARKER}" line in ${deps.tildify(edit.file)}: the line under it was changed, so it is yours now`)
  }
  if (path.keptFor.length) {
    const named = path.keptFor.slice(0, 3).join(', ') + (path.keptFor.length > 3 ? ' and more' : '')
    deps.out(`· kept the PATH line in your shell's startup file: ~/.local/bin also holds ${named}, which need it`)
  }
}

/** The files. Returns false when they were not removed nor set to be: the uninstall is then only partly done. */
function removeFiles(deps: UninstallDeps, keepData: boolean, problems: string[]): boolean {
  const windows = deps.platform === 'win32'
  const root = deps.tildify(deps.root)
  let plan: RemovalPlan
  try {
    plan = removalPlan({
      platform: deps.platform, root: deps.root, home: deps.home, entries: deps.listEntries(deps.root),
      cliDir: deps.cliDir, cliEntries: deps.listEntries(deps.cliDir), dataDir: deps.dataDir, keepData,
    })
    // Nothing to take: no step to start, and no line about it.
    if (!plan.remove.length && (!plan.removeRoot || !deps.exists(deps.root))) return true
    // What stays in the root besides what could not be removed: the desktop app's state, or with --keep-data the data.
    const what = keepData ? `the program in ${root}` : plan.removeRoot ? root : `everything in ${root} except ${plan.kept.join(', ')}`
    if (windows) {
      const final = deps.scheduleFinalRemoval(plan)
      if (!final.ok) { problems.push(`${final.reason} ${final.manual}`); return false }
      deps.out(`✓ ${what} goes once this command has exited (anything left is listed in ${final.log})`)
    } else {
      const left = deps.removeNow(plan)
      for (const stayed of left) if (stayed !== plan.root) problems.push(`could not remove ${deps.tildify(stayed)}`)
      // rmdir, never a recursive remove: the root goes only when what the plan named was all that was in it.
      if (left.includes(plan.root)) {
        problems.push(left.length > 1 ? `${root} is still there, with what could not be removed in it`
          : `${root} is still there: something was added to it during the uninstall. Look in it, then delete it yourself`)
      }
      if (!left.length) deps.out(keepData ? `✓ removed the program from ${root}` : `✓ removed ${what}`)
    }
  } catch (error) {
    if (!(error instanceof RemovalRefused)) throw error
    problems.push(`${clause(error.message)}. None of its files were deleted`)
    return false
  }
  if (plan.kept.some((name) => DESKTOP_STATE.test(name))) {
    deps.out(`· kept the Harness desktop app's own settings in ${root}: the app sets Harness up again when it starts. Remove the app to remove them.`)
  }
  return true
}

export async function uninstallCommand(argv: readonly string[], deps: UninstallDeps): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) { deps.out(UNINSTALL_USAGE); return 0 }
  const unknown = argv.find((arg) => !KNOWN.has(arg))
  if (unknown !== undefined) { deps.err(`Unknown option for harness uninstall: ${unknown}\n\n${UNINSTALL_USAGE}`); return 2 }
  const yes = argv.includes('--yes') || argv.includes('-y')
  const keepData = argv.includes('--keep-data')
  const windows = deps.platform === 'win32'
  if (deps.harnessOs) { deps.err('✗ Harness is part of this Harness operating system, which keeps it installed. Nothing was removed.'); return 1 }
  if (windows && inside(deps.root, deps.cwd, true)) {
    deps.err(`✗ This terminal is in ${deps.tildify(deps.cwd)}, which the uninstall removes, and Windows cannot delete a folder a terminal is in. Run \`cd ~\`, then run it again.`)
    return 1
  }
  const daemon = deps.daemonPid()
  if (!yes) {
    if (!deps.isTTY) { deps.err('✗ harness uninstall asks before it removes anything. Run it in a terminal, or add --yes. Nothing was removed.'); return 1 }
    for (const line of whatItDoes(deps, daemon, keepData)) deps.out(line)
    const answer = (await deps.ask('  Remove Harness from this computer? [y/N] ')).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') { deps.out('Nothing was removed.'); return 1 }
  }
  const problems: string[] = []

  if (daemon !== null) {
    const agents = await deps.stopAgents()
    if (agents.unreachable) {
      const why = clause(agents.unreachable)
      problems.push(`could not ask the Harness daemon to stop its harnesses: ${why.charAt(0).toLowerCase()}${why.slice(1)}`)
    }
    if (agents.stopped) deps.out(`✓ stopped ${plural(agents.stopped, 'harness', 'harnesses')}`)
    for (const failed of agents.failed) problems.push(`${failed.name} did not stop (${failed.error})`)
  }

  let halted: string | null
  try {
    halted = await deps.withLock(async () => {
      if (deps.service?.present()) {
        const removed = deps.service.unregister()
        if (!removed.ok) return `${deps.service.name} would not let go of the Harness daemon: ${removed.detail}`
        deps.out(`✓ removed the Harness daemon from ${deps.service.name}: it no longer starts at login`)
      }
      const stopped = await deps.stopDaemon()
      if (stopped.pid !== null && deps.alive(stopped.pid)) return `the Harness daemon (pid ${stopped.pid}) did not stop`
      // launchd's bootout stops the daemon as it unregisters it, and the stop then finds none. A pid the stop found to
      // be another process's now (Windows gives freed pids out again) is still alive, and is not named.
      const ended = stopped.pid ?? (daemon !== null && !deps.alive(daemon) ? daemon : null)
      if (ended !== null) deps.out(`✓ stopped the Harness daemon (pid ${ended})`)
      return null
    })
  } catch (error) {
    deps.err(`✗ ${clause(message(error))}. Nothing was deleted.`)
    return 1
  }
  if (halted) { deps.err(`✗ ${clause(halted)}. Nothing was deleted: run harness uninstall again once it has stopped.`); return 1 }

  for (const host of await deps.endPtyHosts()) {
    if (host.how === 'left') problems.push(`the Harness terminal host (pid ${host.pid}) is still running: ${host.detail}`)
    else if (host.panes) deps.out(`✓ ended ${plural(host.panes, 'terminal')} in the Harness terminal host`)
  }

  reportHooks(deps, await deps.removeHooks(), problems)

  if (!windows) {
    for (const launcher of deps.removeLaunchers()) {
      if (typeof launcher === 'string') deps.out(`✓ removed ${deps.tildify(launcher)}`)
      else problems.push(`could not remove ${deps.tildify(launcher.path)} (${launcher.failed})`)
    }
  }

  reportPath(deps, deps.removePathEntry(), problems)

  const filesDone = removeFiles(deps, keepData, problems)
  if (!keepData) {
    const root = deps.tildify(deps.root)
    for (const dir of [deps.dataDir, deps.authDir]) {
      if (!inside(deps.root, dir, windows) && deps.exists(dir)) deps.out(`· left ${deps.tildify(dir)}: it is outside ${root} (ADAPTER_DATA_DIR or HARNESS_AUTH_DIR names it); delete it yourself if it is Harness's`)
    }
  }
  deps.afterword()

  if (problems.length) {
    deps.err(filesDone ? '✗ Harness is uninstalled, except:' : '✗ Harness is only partly uninstalled:')
    // A problem may name paths on lines of their own: those are indented under it.
    for (const problem of problems) deps.err(`  · ${problem.replace(/\n {2}/g, '\n      ')}`)
    return 1
  }
  deps.out(keepData ? 'Harness is uninstalled. Your sign-in and history are kept for the next install.' : 'Harness is uninstalled.')
  return 0
}
