import { execFile } from 'node:child_process'
import { patientExec } from './patientExec.js'
import type { TerminalBackend } from './terminalBackend.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  terminalEnterWithheld,
  type SubmitOptions,
  type TerminalActionResult,
  type TerminalCaptureOptions,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalInventoryResult,
  type TerminalLogicalKey,
  type TerminalProcessExpectation,
  type TerminalReadResult,
  type TerminalRespawnRequest,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
  type TmuxRuntimeRef,
  type RuntimeValidation,
} from './terminalTypes.js'
import { inTmuxRoom } from './tmuxControlGate.js'
import { TmuxControlStream } from './tmuxStream.js'
import {
  captureTmuxPane,
  ENGINE_EXIT_PANE_OPTION,
  listPaneTitles,
  LSTART_MARKER_RE,
  lookupPaneEngineProcess,
  sendKeyToTmux,
  sendLiteralToTmux,
  paneOptionScope,
  paneStyleArgs,
  sendToTmux,
  setPaneMouseOn,
  setPaneStyle,
} from './tmux.js'
import { env } from '../config/env.js'
import { HARNESS_OWNER_OPTION, harnessPaneOwner, ownerCommand } from './harnessSessionLabel.js'
import { tmuxFeatures, type TmuxFeatures } from './tmuxVersion.js'
import { DEFAULT_HOST_THEME, windowStyleOf, type HostTheme } from './hostTheme.js'
import { machineNames } from './machineNames.js'
import { isNoTmuxServerError, listTmuxPanes } from './tmuxAgentDiscovery.js'
import { sameProcessIdentity, terminalRouteKey } from './terminalRuntime.js'

// Every tmux call here: a held event loop must not turn a timeout into a failure, or into an empty
// answer that reads as a pane that was never made (patientExec.ts).
const run = patientExec(execFile)

const TMUX_KEYS: Record<TerminalLogicalKey, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backtab: 'BTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  backspace: 'BSpace',
  delete: 'DC',
  pageup: 'PPage',
  pagedown: 'NPage',
  'ctrl-c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl-u': 'C-u',
  'ctrl-w': 'C-w',
  space: 'Space',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
}

/** Why a launch with its own environment was refused on this tmux, in words a person can act on. */
function tmuxTooOldForEnv(version: string, what: string): string {
  return `this machine's tmux is older than ${version}, the first version that can give ${what} its own environment. Upgrade tmux.`
}

function legacyActionResult(ok: boolean, operation: string): TerminalActionResult {
  // The legacy helper has spawned tmux before it reports false, so execution cannot safely be ruled out.
  return ok ? TERMINAL_ACTION_SUCCEEDED : terminalActionPossiblyExecuted(`${operation} did not complete`)
}

/**
 * The argv for removing [names] from session [sessionId]'s environment.
 *
 * Exported so a spec can pin the exact command without a tmux server. `-u` REMOVES the variable;
 * the `-e VAR=` form that `respawn-pane` accepts would set it to an empty string instead, and an
 * engine handed an empty base URL does not fall back to its own login — it dials the empty string.
 */
export function clearEnvArgs(sessionId: string, names: readonly string[]): string[] {
  const args: string[] = []
  for (const name of names) {
    if (args.length) args.push(';')
    args.push('set-environment', '-t', sessionId, '-u', name)
  }
  return args
}

export class TmuxBackend implements TerminalBackend<TmuxRuntimeRef> {
  readonly name = 'tmux' as const
  readonly instanceId = 'tmux:default'

  /** What each Harness pane's `window-style` was last set to, so a scan re-applies only changes. */
  private readonly styledPanes = new Map<string, string>()
  private readonly desiredStyles = new Map<string, string>()
  private readonly stylingPanes = new Set<string>()

  /**
   * [hostTheme] answers with the desktop's current pane colours (see `hostTheme.ts`); read at every
   * use rather than captured, so a theme the app sends later reaches sessions created after it.
   * [owner] is the tag this daemon's panes carry (`HARNESS_OWNER_OPTION`), read at every create for
   * the same reason as the theme: the data folder is the daemon's to move.
   * [observeMachineName] reads the machine's name as tmux titles the new pane with it (lib/machineNames.ts).
   */
  constructor(
    private readonly hostTheme: () => HostTheme = () => DEFAULT_HOST_THEME,
    private readonly owner: () => string = () => harnessPaneOwner(env.ADAPTER_DATA_DIR),
    private readonly observeMachineName: () => void = () => machineNames.observe(),
    /** What this machine's tmux can do (`tmuxVersion.ts`): a command an older tmux does not know fails
     *  the whole command list it is chained into, and every agent create with it. */
    private readonly features: () => Promise<TmuxFeatures> = tmuxFeatures,
  ) {}

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<TmuxRuntimeRef>> {
    // tmux titles the pane it is about to make with the machine's name as it is now, and an engine
    // that sets no title keeps it. Read here, that name is refused even if the machine has another
    // by the next title sweep: a name it had only between two sweeps would otherwise never be seen.
    this.observeMachineName()
    const features = await this.features()
    const variables = Object.entries(request.env ?? {})
    // `-e` (tmux 3.2+) puts these in the SESSION environment rather than the launch argv, so a grid
    // relay key never lands in `ps` output for the life of the agent. Callers refuse a grid or a
    // harness on an older tmux by name (`tmuxSupportsSessionEnv()`); whatever else reaches here with
    // variables on one is refused here, saying why, rather than handed to tmux to answer with its
    // usage text — and never moved into the argv, where a secret would show.
    if (variables.length && !features.sessionEnv) return terminalActionNotStarted(tmuxTooOldForEnv('3.2', 'a new session'))
    const owner = this.owner()
    const args = ['new-session', '-d', '-P', '-F', '#{pane_id}']
    if (request.cwd) args.push('-c', request.cwd)
    if (request.label) args.push('-s', request.label)
    for (const [key, value] of variables) args.push('-e', `${key}=${value}`)
    // Trailing args after this point become the session's shell-command. tmux execs them directly
    // (no shell interposed) when given as separate argv elements, so no quoting/escaping is needed.
    if (request.command?.length) args.push(...this.ownedCommand(features, owner, request.command))
    // Pane options where tmux has them, so these go with the pane wherever the person moves it and never
    // change the rest of a window of theirs; the agent's own new window before tmux 3.0.
    const scope = paneOptionScope(features)
    // Keep the pane when its process dies, so an engine that exits immediately (not logged in, bad
    // config) still has its error text readable afterwards instead of taking the whole session down
    // with it. Chained into THIS tmux invocation on purpose: an engine can exit in under a
    // millisecond, and a second `set-option` call loses that race — measured, the session was
    // already gone before the follow-up command could reach the server.
    // Whoever created the pane owns turning this back off; see `clearPaneRemainOnExit`.
    args.push(';', 'set-option', scope, 'remain-on-exit', 'on')
    // An agent's session never has a client attached, so a person's `set -g destroy-unattached on`
    // (in their ~/.tmux.conf, which this server loads) ended every agent the moment it was made, and
    // Harness could not run at all on their machine (found end to end, e2e/tmuxconf.e2e.ts). Turned
    // off for this session only, in this same invocation, before the server can act on it.
    args.push(';', 'set-option', 'destroy-unattached', 'off')
    // Same invocation, same reason: an engine asks its terminal for its colours (OSC 10/11) in its
    // first milliseconds and never again, so the style has to be there before the engine is.
    const style = windowStyleOf(this.hostTheme())
    args.push(';', ...paneStyleArgs(features, style))
    // Whose pane it is, from its first instant: another daemon on this tmux server scanning a moment
    // later must already see it is not its own. On the pane, which keeps it wherever the person moves
    // it (see HARNESS_OWNER_OPTION); before tmux 3.0, on the window, and in the start command.
    args.push(';', 'set-option', scope, HARNESS_OWNER_OPTION, owner)
    // `killed`/`signal` come from execFile's own error shape, which ErrnoException alone does not declare.
    type ExecError = NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }
    // A new session is a notification to every control client: on a tmux before 3.7, not while one
    // attaches (tmuxControlGate.ts).
    const result = await inTmuxRoom('notify', () => new Promise<{ error: ExecError | null; stdout: string; stderr: string }>((resolve) => {
      run('tmux', args, { timeout: 5_000 }, (error, stdout, stderr) => resolve({
        error: error as ExecError | null,
        stdout,
        stderr,
      }))
    }), features)
    if (result.error) {
      if (result.error.code === 'ENOENT') return terminalActionNotStarted('tmux is unavailable')
      // tmux says exactly why it refused — "duplicate session", "protocol version mismatch",
      // a .tmux.conf error, a directory it cannot enter. Dropping stderr here turned every one of
      // those into the same unactionable SPAWN_FAILED, diagnosable only by reading the daemon log
      // on the machine that failed, which does not have the reason either.
      const detail = result.stderr.trim().split('\n')[0]?.slice(0, 200)
        // execFile reports a timeout kill as SIGTERM with no stderr — the one failure whose cause
        // is not in tmux's own output.
        || (result.error.killed ? 'tmux did not answer within 5s' : result.error.message.slice(0, 200))
      return terminalActionPossiblyExecuted(`tmux session creation did not complete: ${detail}`)
    }
    const paneId = result.stdout.trim()
    if (!/^%\d+$/.test(paneId)) {
      return terminalActionPossiblyExecuted('tmux created a session without returning its root pane')
    }
    await setPaneMouseOn(paneId)
    this.styledPanes.set(paneId, style)
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId } }
  }

  /**
   * [command] as this daemon starts it. Before tmux 3.0, through `ownerCommand`, so the pane's start
   * command carries the tag that a window option cannot keep once the person moves the pane. An empty
   * command is tmux's default shell, and stays that: `/usr/bin/env` with nothing to run would print the
   * environment and exit.
   */
  private ownedCommand(features: TmuxFeatures, owner: string, command: readonly string[] = []): string[] {
    return features.paneOptions || !command.length ? [...command] : ownerCommand(owner, command)
  }

  /**
   * Replace the process running in an existing pane, with a different environment.
   *
   * `-k` kills what is there first; without it tmux refuses a live pane. `remain-on-exit` is turned on
   * in the SAME invocation and for the same reason as in `create`: a respawned engine that dies
   * immediately (a rejected key, a model the grid does not serve) must leave its error on screen
   * instead of taking the pane down with it. Whoever calls this owns turning it back off.
   */
  /**
   * Why [respawn] would refuse this request on this machine's tmux, or null when it would try. Asked by a
   * restart BEFORE it stops the engine it replaces: a respawn refused after the kill left the agent with
   * a dead pane and no engine.
   */
  async respawnRefusal(request: Pick<TerminalRespawnRequest, 'env'>): Promise<string | null> {
    // `respawn-pane -e` is tmux 3.0; refused before, for the reason `create` gives.
    return Object.keys(request.env ?? {}).length && !(await this.features()).respawnEnv ? tmuxTooOldForEnv('3.0', 'a respawned pane') : null
  }

  async respawn(runtime: TmuxRuntimeRef, request: TerminalRespawnRequest): Promise<TerminalActionResult> {
    const refused = await this.respawnRefusal(request)
    if (refused) return terminalActionNotStarted(refused)
    const features = await this.features()
    const variables = Object.entries(request.env ?? {})
    const scope = paneOptionScope(features)
    // The engine-exit marker is the pane's, and a respawned pane is a new launch: cleared here, in
    // the same invocation, or the new engine would read as exited the moment it started. A `-p` here
    // before tmux 3.0 failed the whole list, the respawn with it, so no agent could restart there.
    const args = [
      'set-option', scope, '-t', runtime.paneId, 'remain-on-exit', 'on', ';',
      'set-option', scope, '-t', runtime.paneId, ENGINE_EXIT_PANE_OPTION, '', ';',
      'respawn-pane', '-k',
    ]
    if (request.cwd) args.push('-c', request.cwd)
    for (const [key, value] of variables) args.push('-e', `${key}=${value}`)
    // A respawn replaces the pane's start command, which carries its tag before tmux 3.0 (`create`).
    args.push('-t', runtime.paneId, ...this.ownedCommand(features, this.owner(), request.command))
    const result = await new Promise<{ error: NodeJS.ErrnoException | null; stderr: string }>((resolve) => {
      run('tmux', args, { timeout: 5_000 }, (error, _stdout, stderr) => resolve({
        error: error as NodeJS.ErrnoException | null,
        stderr,
      }))
    })
    if (!result.error) return TERMINAL_ACTION_SUCCEEDED
    if (result.error.code === 'ENOENT') return terminalActionNotStarted('tmux is unavailable')
    // `-k` means the old process may already be gone even though the new one never started, so this
    // cannot be reported as "nothing happened".
    const detail = result.stderr.trim().split('\n')[0]?.slice(0, 200) || result.error.message.slice(0, 200)
    return terminalActionPossiblyExecuted(`tmux could not respawn the pane: ${detail}`)
  }

  async kill(runtime: TmuxRuntimeRef): Promise<TerminalActionResult> {
    if (!/^%\d+$/.test(runtime.paneId)) return terminalActionNotStarted('invalid tmux pane identity')
    // Discovered harnesses can share a tmux session with unrelated work. The
    // canonical pane id is the entire target; never widen this to kill-session.
    // The last pane gone closes its session, a notification to every control client: on a tmux before
    // 3.7, not while one attaches (tmuxControlGate.ts).
    const ok = await inTmuxRoom('notify', () => new Promise<boolean>((resolve) => {
      run('tmux', ['kill-pane', '-t', runtime.paneId], { timeout: 5_000 }, (error) => resolve(!error))
    }))
    if (ok) return TERMINAL_ACTION_SUCCEEDED
    // The engine may have exited and removed its pane before the parallel PID
    // check completed. Only authoritative inventory makes that an idempotent success.
    // Use all panes here: discovery deliberately hides sessions that were renamed
    // or created elsewhere, and their absence from discovery is not proof of exit.
    const absent = await new Promise<boolean>(resolve => {
      run('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { timeout: 2_000 }, (error, stdout) => {
        if (error) { resolve(isNoTmuxServerError(error.message)); return }
        const ids = stdout.trim().split('\n').filter(Boolean)
        // A running server lists a pane at the least: an empty listing is a read that was lost, not proof.
        resolve(ids.length > 0 && ids.every(id => /^%\d+$/.test(id)) && !ids.includes(runtime.paneId))
      })
    })
    if (absent) return TERMINAL_ACTION_SUCCEEDED
    return legacyActionResult(false, 'tmux pane close')
  }

  /**
   * Remove [names] from the environment of the session that owns [runtime].
   *
   * A pane created by `new-session -e` put those variables in the SESSION environment, and
   * `respawn-pane` inherits it — so respawning with no `-e` flags would leave the old grid in place
   * while reporting a clean swap. This is what makes "back to your own login" actually true.
   */
  async clearEnv(runtime: TmuxRuntimeRef, names: readonly string[]): Promise<TerminalActionResult> {
    if (!names.length) return legacyActionResult(true, 'tmux clear environment')
    const sessionId = await this.resolveSessionId(runtime.paneId)
    if (!sessionId) return terminalActionNotStarted('tmux session could not be resolved from pane')
    const ok = await new Promise<boolean>((resolve) => {
      run('tmux', clearEnvArgs(sessionId, names), { timeout: 5_000 }, (error) => resolve(!error))
    })
    return legacyActionResult(ok, 'tmux clear environment')
  }

  /** The id of the session that owns [paneId], or null when tmux will not say. */
  private resolveSessionId(paneId: string): Promise<string | null> {
    return new Promise((resolve) => {
      run('tmux', ['display-message', '-p', '-t', paneId, '#{session_id}'], { timeout: 2_000 }, (error, stdout) => {
        const value = stdout.trim()
        resolve(!error && /^\$\d+$/.test(value) ? value : null)
      })
    })
  }

  /**
   * Re-arm `remain-on-exit` on an already-live pane, mirroring what `create()` does at spawn time.
   *
   * Restart must call this BEFORE killing the pane's engine process. `clearPaneRemainOnExit` turns
   * this off the moment an agent is first confirmed (see `cli.ts`'s `onCreateAgent`), so without
   * re-arming it here tmux destroys the pane — and, being its only pane, the whole session — the
   * instant the old process exits.
   */
  async holdOpen(runtime: TmuxRuntimeRef): Promise<TerminalActionResult> {
    const scope = paneOptionScope(await this.features())
    const ok = await new Promise<boolean>((resolve) => {
      run('tmux', ['set-option', scope, '-t', runtime.paneId, 'remain-on-exit', 'on'], { timeout: 2_000 }, (error) => {
        resolve(!error)
      })
    })
    return legacyActionResult(ok, 'tmux remain-on-exit re-arm')
  }

  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    const titles = await listPaneTitles()
    return {
      state: 'succeeded',
      value: new Map([...titles].map(([paneId, title]) => [terminalRouteKey({ backend: 'tmux', paneId }), title])),
    }
  }

  async inventory(): Promise<TerminalInventoryResult> {
    const result = await listTmuxPanes(this.owner())
    if (!result.ok) return { state: 'unavailable', reason: result.error }
    this.restyle(result.panes.map((pane) => pane.tmuxPane))
    return {
      state: 'available',
      roots: result.panes.map((pane) => ({
        runtime: { backend: 'tmux' as const, paneId: pane.tmuxPane },
        rootPid: pane.rootPid,
        cwd: pane.cwd,
      })),
    }
  }

  /**
   * Retroactive, on every scan: a pane from before this build, one that outlived a daemon restart,
   * or every pane after the app changed its palette. Fire-and-forget — a scan that misses one
   * because tmux was briefly slow catches it on the next pass. Panes that are gone are forgotten
   * so a reused pane id is styled afresh. Each pane on its own (`setPaneStyle`), never its window:
   * the person may have moved it into a window of theirs.
   */
  private restyle(panes: readonly string[]): void {
    const style = windowStyleOf(this.hostTheme())
    const live = new Set(panes)
    for (const pane of this.desiredStyles.keys()) {
      if (!live.has(pane)) this.desiredStyles.delete(pane)
    }
    for (const pane of this.styledPanes.keys()) {
      if (!live.has(pane)) this.styledPanes.delete(pane)
    }
    for (const pane of panes) {
      this.desiredStyles.set(pane, style)
      this.applyStyle(pane)
    }
  }

  private applyStyle(pane: string): void {
    const style = this.desiredStyles.get(pane)
    if (style === undefined || this.stylingPanes.has(pane) || this.styledPanes.get(pane) === style) return
    // Serialize writes per pane: scans can overlap a slow tmux command or a theme change.
    this.stylingPanes.add(pane)
    void setPaneStyle(pane, style).then((applied) => {
      if (applied && this.desiredStyles.has(pane)) this.styledPanes.set(pane, style)
    }).finally(() => {
      this.stylingPanes.delete(pane)
      // Apply a newer theme immediately, but retry a failed unchanged write on the next scan.
      if (this.desiredStyles.get(pane) !== style) this.applyStyle(pane)
    })
  }

  async validate(runtime: TmuxRuntimeRef, expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    try {
      const found = await lookupPaneEngineProcess(runtime.paneId, expected.engine)
      if (!found.ok) return { state: found.unknown ? 'unknown' : 'gone', reason: found.reason }
      const live = found.identity
      // A saved marker that is not a C-locale `lstart` stamp was written either by the pre-fix parser,
      // with its fields shifted, or by a `ps` that still inherited the user's LC_TIME (see psEnv in
      // lib/childLocale.ts). Either way it can never equal the corrected stamp for the same live
      // process, so comparing it would report a running engine as gone — once, on the upgrade that
      // fixed the reading. The pane still has a matching engine process; take it.
      //
      // Resume's checkSessionRuntime makes the same allowance. The coordinator passes persisted
      // identities directly here when validating or acquiring a terminal lease.
      if (expected.processIdentity && !LSTART_MARKER_RE.test(expected.processIdentity.startMarker)) {
        return { state: 'alive' }
      }
      if (expected.processIdentity && !sameProcessIdentity(expected.processIdentity, live)) {
        return { state: 'gone', reason: 'process changed under tmux pane', replaced: true }
      }
      return { state: 'alive' }
    } catch {
      return { state: 'unknown', reason: 'tmux runtime probe failed' }
    }
  }

  async capture(runtime: TmuxRuntimeRef, options: TerminalCaptureOptions = {}): Promise<TerminalReadResult<string>> {
    const captured = await captureTmuxPane(runtime.paneId, options.historyLines, {
      visible: options.mode === 'visible',
      ansi: options.ansi,
    })
    return captured === null
      ? { state: 'failed', reason: 'tmux capture failed' }
      : { state: 'succeeded', value: captured }
  }

  async typeLiteral(runtime: TmuxRuntimeRef, text: string): Promise<TerminalActionResult> {
    return legacyActionResult(await sendLiteralToTmux(runtime.paneId, text), 'tmux literal input')
  }

  async submitText(runtime: TmuxRuntimeRef, text: string, options?: SubmitOptions): Promise<TerminalActionResult> {
    const sent = await sendToTmux(runtime.paneId, text, options?.beforeEnter, options?.allowed)
    return typeof sent === 'boolean' ? legacyActionResult(sent, 'tmux submission') : terminalEnterWithheld(sent.withheld)
  }

  async sendKey(runtime: TmuxRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    return legacyActionResult(await sendKeyToTmux(runtime.paneId, TMUX_KEYS[key]), 'tmux key input')
  }

  async setTitle(runtime: TmuxRuntimeRef, title: string): Promise<TerminalActionResult> {
    const ok = await new Promise<boolean>((resolve) => {
      run('tmux', ['select-pane', '-t', runtime.paneId, '-T', title.slice(0, 200)], { timeout: 2_000 }, (error) => {
        resolve(!error)
      })
    })
    return legacyActionResult(ok, 'tmux title update')
  }

  async notify(runtime: TmuxRuntimeRef, title: string, body: string): Promise<TerminalActionResult> {
    const message = `${title.slice(0, 200)}: ${body.slice(0, 1_000)}`
    const ok = await new Promise<boolean>((resolve) => {
      run('tmux', ['display-message', '-t', runtime.paneId, '--', message], { timeout: 2_000 }, (error) => {
        resolve(!error)
      })
    })
    return legacyActionResult(ok, 'tmux notification')
  }

  /**
   * Stream a pane's bytes. Deliberately NOT gated on identifying the engine process in it.
   *
   * Streaming and injection need different thresholds, and they used to share one. This path
   * addresses the PANE — `capture-pane -t %N` out, `send-keys -t %N` in — and a tmux pane id is
   * monotonic and never reused within a server, so the id alone is a safe address. Injection is the
   * one that types into whatever process owns the pane, and it keeps validating: see
   * `TerminalBackendCoordinator.validateLease` and the lease dispatch fallbacks. The reaper
   * (`coordinator.validate`) keeps validating too.
   *
   * Requiring a match here made the pane unviewable in exactly the situations where seeing it is the
   * whole point: an engine that crashed, one stopped at a first-run prompt under a process the
   * matcher does not cover, or a pane that has fallen back to a bare shell. The agent was listed, and
   * clicking it produced "TERMINAL FROZEN · no <engine> process under tmux pane" instead of the
   * screen that would have explained why. A pane that is genuinely gone still fails, one line later:
   * `TmuxControlStream.open` reads `paneMeta` first and refuses a missing pane and a multi-pane
   * window. Dropping the check also takes a whole-process-table `ps` scan off every terminal open.
   *
   * `expected` stays in the signature because `TerminalBackend` defines it; it is intentionally
   * unused here.
   */
  async openStream(
    runtime: TmuxRuntimeRef,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly?: boolean,
  ): Promise<TerminalReadResult<TerminalStreamHandle<TmuxRuntimeRef>>> {
    void expected
    return TmuxControlStream.open(runtime.paneId, size, sink, readOnly)
  }
}
