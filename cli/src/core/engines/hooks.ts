/**
 * The engines' own hooks: which registered agent a hook belongs to, what a SessionEnd means, and
 * installing every engine's hooks so they call this daemon.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 12: docs/design/2026-10-03-harnessd.md).
 */
import { engineHooks } from '../../engines/hooks.js'
import { sessionStoreContracts, type SessionStoreEngine } from '../../engines/sessionStoreContracts.js'
import { chooseHookAgent, type HookServerHandlers } from '../../hookServer.js'
import { adoptHomes, movedHomes } from '../../lib/engineHomes.js'
import { loadEngine, type InProcessModules } from '../../engines/inProcess.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import type { ProcessRow } from '../../lib/tmux.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import type { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import type { TerminalRuntimeRef } from '../../lib/terminalTypes.js'

type ResolveHookAgent = NonNullable<HookServerHandlers['resolveHookAgent']>

export interface EngineHookDeps {
  /** Only the core's short pane dispatch/commit, never service preparation or an engine watch. */
  panePending?: (agentId: string) => Promise<unknown> | undefined
  /** Hints name tmux panes; without tmux there is nothing they can point at. */
  tmuxBackend: unknown
  agentReconciler: Pick<TerminalAgentReconciler, 'triggerHint' | 'trigger'>
  registry: Pick<typeof registry, 'byRuntimeEngine'>
}

/**
 * The longest a hook waits for the agent on its pane to record the process it came from. Every relaunch
 * starts its engine before it records it: a resume looks for the process every 250ms, a create or a
 * fork backs off to 750ms, and a restart finds it the same way and then probes it, twice over when it
 * falls back to a new conversation (two 8s discovery budgets, swap.ts). The hook itself is answered
 * before the wait (`onWait`): its client gives up on a reply after 500ms and then writes the registry
 * itself (hook/notify.mjs), so only the daemon's record waits.
 */
export const PROCESS_RECORD_WAIT_MS = 20_000
/** How often a waiting hook reads the rows on its panes again: memory, not a process table. */
const PROCESS_RECORD_POLL_MS = 100

type HookQuery = Parameters<ResolveHookAgent>[0]

/** Which agent holds a pane, and the process it has recorded: what a waiting hook watches change. */
const recordKey = (session: RegisteredSession | undefined): string =>
  session ? `${session.agentId}\u0000${session.processIdentity?.pid ?? ''}\u0000${session.processIdentity?.startMarker ?? ''}` : ''

export function createEngineHooks({ tmuxBackend, agentReconciler, registry, panePending }: EngineHookDeps) {
  /**
   * The agents on the hinted panes: those whose recorded process the caller descends from, the rest,
   * and of the rest those with no live process recorded at all (none yet, or one that has exited).
   * `ancestry` is the hook's own process and those it descends from, read as the hook arrived
   * (`resolveHookAgent`); `table`, the process table to judge the recorded processes by, else a new read.
   */
  const matchCaller = async (resolved: TerminalRuntimeRef[], engine: HookQuery['engine'], ancestry: ReadonlySet<number>, table?: ProcessRow[]) => {
    const rows = table ?? await processRows()
    if (!rows) return null
    const recordedAlive = (session: RegisteredSession): boolean => {
      const recorded = session.processIdentity
      return !!recorded && rows.some((row) => sameProcessIdentity(row, recorded))
    }
    const callerBelongsTo = (session: RegisteredSession): boolean => {
      const expectedPid = session.processIdentity?.pid
      return !!expectedPid && ancestry.has(expectedPid)
    }
    const candidates = new Map<string, RegisteredSession>()
    /**
     * Agents the hint points at whose ancestry we could NOT confirm.
     *
     * Caller ancestry is the strongest evidence and stays the first choice, but it assumes every engine
     * spawns its hook from inside its own process tree — and Cursor does not. Measured on both
     * backends: `agent` in a pane registers fine, then every one of its hooks is rejected because the
     * process that POSTs is not a descendant of the pane's engine, so no session ever binds.
     *
     * Keep that exception specific to Cursor. A delayed hook from an exited process can still name
     * a pane now owned by its replacement; the pane and hook credential alone cannot prove that a
     * Codex (or other engine's) old transcript belongs to the new process.
     */
    const onHintedRuntime = new Map<string, RegisteredSession>()
    const unrecorded: RegisteredSession[] = []
    for (const runtime of resolved) {
      const candidate = registry.byRuntimeEngine(runtime, engine)
      if (!candidate) continue
      if (callerBelongsTo(candidate)) candidates.set(candidate.agentId, candidate)
      else {
        onHintedRuntime.set(candidate.agentId, candidate)
        if (!recordedAlive(candidate)) unrecorded.push(candidate)
      }
    }
    return { candidates, onHintedRuntime, unrecorded }
  }

  /** Resolves when the row on any of these panes records another process (or another agent takes the
   *  pane), or when the wait is over. */
  const recordChanged = async (resolved: TerminalRuntimeRef[], engine: HookQuery['engine']): Promise<void> => {
    const before = resolved.map((runtime) => recordKey(registry.byRuntimeEngine(runtime, engine)))
    // On the monotonic clock: a wall clock stepped forward (a wake, an NTP correction: round 29) ended
    // the wait at its next poll and dropped the hook, and one stepped back kept it polling for the step.
    const deadline = performance.now() + PROCESS_RECORD_WAIT_MS
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROCESS_RECORD_POLL_MS))
      if (resolved.some((runtime, i) => recordKey(registry.byRuntimeEngine(runtime, engine)) !== before[i])) return
    }
  }

  const resolveHookAgent: ResolveHookAgent = async ({ engine, runtimeHints, callerPid, onWait }) => {
    if (!callerPid) return null
    // Who the hook came from, read as it arrives. On Linux dash keeps its `sh -c` as the hook's parent, a
    // shell that exits with the hook (its 500ms, or `onWait`'s answer); read after the reconcile pass or
    // the wait, the ancestry stopped at a pid already gone and a restart's new conversation was never
    // bound (e2e/updates.e2e.ts). macOS's /bin/sh is a bash that execs the hook: never seen there.
    const arrival = processRows()
    const resolved: TerminalRuntimeRef[] = []
    for (const hint of runtimeHints ?? []) {
      if (tmuxBackend) resolved.push({ backend: 'tmux', paneId: hint.paneId })
    }
    // A pass that outran its deadline has not yet opened the agent a hook from a new engine belongs to.
    let overdue = false
    for (const runtime of resolved) if (!await agentReconciler.triggerHint(runtime, engine)) overdue = true

    let table = await arrival
    // A `ps` already running (processRows shares it) may predate the hook's process; the next read has it.
    if (table && !table.some((row) => row.pid === callerPid)) table = await processRows()
    if (!table) return null
    const parents = new Map(table.map((row) => [row.pid, row.parentPid]))
    const ancestry = new Set<number>()
    for (let pid = callerPid; pid > 0 && !ancestry.has(pid); pid = parents.get(pid) ?? 0) ancestry.add(pid)

    let found = (await matchCaller(resolved, engine, ancestry, table))!
    let choice = chooseHookAgent([...found.candidates.values()], [...found.onHintedRuntime.values()], engine)
    // Every relaunch starts its engine before it records the new process — create, fork, resume, a
    // restart and the new conversation it falls back to, a retarget — so a SessionStart in between came
    // from a pid no agent had yet, and was dropped. A resumed Codex agent then never showed its turns
    // (round 23), and a restart's new conversation was never bound (round 24). While the agent on the
    // hook's pane has no live process recorded, the hook now waits for it to record one, and is matched
    // again against that: one rule for every relaunch, with nothing for any of them to remember to do.
    // So does one that came while discovery was too slow to open its agent: the agent appearing on the
    // pane is a change of its record too.
    if (!choice.agent && choice.reason === 'none' && (found.unrecorded.length || overdue)) {
      onWait?.()
      await recordChanged(resolved, engine)
      const again = await matchCaller(resolved, engine, ancestry)
      if (!again) return null
      found = again
      choice = chooseHookAgent([...found.candidates.values()], [...found.onHintedRuntime.values()], engine)
    }
    // Cursor may admit a unique runtime without recorded ancestry. A hook from the engine just
    // dispatched there must not rewrite its row before that pane operation has committed its route.
    // Acknowledge now so the hook client never falls back to writing the registry itself.
    for (;;) {
      const pending = choice.agent && panePending?.(choice.agent.agentId)
      if (!pending) break
      onWait?.()
      try { await pending } catch { return null }
      const again = await matchCaller(resolved, engine, ancestry)
      if (!again) return null
      found = again
      choice = chooseHookAgent([...found.candidates.values()], [...found.onHintedRuntime.values()], engine)
    }
    const { candidates } = found
    if (choice.agent) {
      if (choice.reason === 'runtime') {
        console.log(`[hooks] ${engine} hook accepted on runtime evidence alone`
          + ` · agent=${sid(choice.agent.agentId)} · caller=${callerPid} is outside that engine's process tree`)
      }
      return choice.agent
    }
    // Say WHY, once per rejected hook. "no_matching_engine_process" alone sent two people down the
    // wrong path already: the interesting question is never "did it match" but which of the three
    // gates closed — no runtime resolved from the hint, no registered agent on that runtime, or the
    // hook's own process is not a descendant of the engine we registered.
    const onRuntime = resolved.map((runtime) => registry.byRuntimeEngine(runtime, engine)).filter(Boolean)
    console.log(`[hooks] unmatched ${engine} hook · hints=${(runtimeHints ?? []).map((hint) => `${hint.backend}:${hint.paneId}`).join(',') || 'none'}`
      + ` · resolvedRuntimes=${resolved.length} · agentsOnRuntime=${onRuntime.length}`
      + ` · callerPid=${callerPid}${onRuntime.length && !candidates.size ? ' · caller is not a descendant of that engine process' : ''}`
      + `${candidates.size > 1 ? ` · ambiguous (${candidates.size} candidates)` : ''}`)
    return null
  }

  // SessionEnd describes the mutable engine session, never process lifetime. Reconcile now; discovery
  // decides whether the agent still exists from terminal inventory + ps.
  const onSessionEnd = (_sessionId: string, _reason: string | undefined): void => {
    void agentReconciler.trigger()
  }
  return { resolveHookAgent, onSessionEnd }
}

/**
 * OpenCode's plugin, installed again before an OpenCode spawn (core/agents/create.ts): OpenCode may have moved
 * from 1.x to 2.x under a running daemon, and its new TUI must not find the old server plugin. False when the
 * other engines' installers could not be loaded.
 */
export async function installOpencodePluginBeforeSpawn(port: number): Promise<boolean> {
  const installers = await loadEngine('hooks')
  if (!installers) return false
  installers.installOpencodePlugin(port)
  return true
}

export interface InstallEngineHooksOptions {
  /** Only these engines' hooks (`HOOK_INSTALL_ENGINES`); every engine's when absent. */
  only?: ReadonlySet<string> | null
  /** The daemon's own environment, for the homes it moves; `process.env` when absent. */
  environment?: NodeJS.ProcessEnv
  /** The login shell's environment, when it has been read (`warmLoginShellEnvironment`). */
  loginShell?: Promise<NodeJS.ProcessEnv>
}

/**
 * The other engines' installers, in the order they have always run. Their code is loaded only here, once, as
 * the core starts (engines/inProcess.ts `hooks`), and only when one of them is to be installed.
 */
const OTHER_INSTALLERS: Array<[string, (installers: InProcessModules['hooks']) => (port: number) => void]> = [
  ['cursor', (installers) => installers.installCursorHooks],
  ['opencode', (installers) => installers.installOpencodePlugin],
  ['kilo', (installers) => installers.installKiloPlugin],
  ['pi', (installers) => installers.installPiExtension],
  // A self-update refreshes plugin files here; running engine processes pick them up according to each
  // vendor's own plugin reload lifecycle.
  ['amp', (installers) => installers.installAmpPlugin],
  ['hermes', (installers) => installers.installHermesHooks],
  ['devin', (installers) => installers.installDevinHooks],
  ['commandcode', (installers) => installers.installCommandCodeHooks],
  ['grok', (installers) => installers.installGrokHooks],
  ['agy', (installers) => installers.installAgyHooks],
  ['copilot', (installers) => installers.installCopilotHooks],
]

/**
 * Install every engine's hooks with the port the local server actually bound.
 *
 * One vendor at a time, each behind its own guard: these write into thirteen different settings
 * files owned by thirteen different CLIs, and one that is malformed, read-only or mid-write is not
 * a reason for the other twelve to go uninstalled — let alone for the daemon not to come up.
 *
 * Claude Code's and Codex's first, in line, as before. Then the other engines' installers are loaded, at this
 * same step, which the caller awaits so that nothing it starts next (a restored pane among them) runs before
 * their hooks are in place. Installers that could not be loaded are skipped and named, as one that throws is.
 * Never rejects.
 */
export async function installEngineHooks(port: number, options: InstallEngineHooksOptions = {}): Promise<void> {
  const hookStep = (vendor: string, install: () => void): void => {
    if (options.only && !options.only.has(vendor)) return
    try { install() } catch (error) {
      console.warn(`[hooks] ${vendor} install skipped · ${error instanceof Error ? error.message : error}`)
    }
  }
  // The homes the person moved (lib/engineHomes.ts, by each engine's declared session store) get the hooks
  // too: every one adopted before, those the daemon's own environment names, and those of the login shell
  // every engine is launched through once it has been read. That read is never waited on (cli.ts), so an
  // engine started in the first seconds of a daemon's very first start with a moved home may miss its first hook.
  const installIn = (homes: Array<[SessionStoreEngine, string]>): void => {
    for (const [engine, home] of homes) hookStep(engine, () => engineHooks[engine].installIn(port, home))
  }
  const adopt = (environment: NodeJS.ProcessEnv): void => {
    const moved = (Object.entries(adoptHomes(environment)) as Array<[SessionStoreEngine, string | null]>)
      .filter((found): found is [SessionStoreEngine, string] => !!found[1])
    if (!moved.length) return
    console.log(`[hooks] engines keep their data elsewhere here: ${moved.map(([engine, home]) => `${sessionStoreContracts[engine].product} in ${home}`).join(', ')}`)
    installIn(moved)
  }
  installIn((Object.keys(sessionStoreContracts) as SessionStoreEngine[]).flatMap((engine) => movedHomes(engine).map((home): [SessionStoreEngine, string] => [engine, home])))
  adopt(options.environment ?? process.env)
  void options.loginShell?.then(adopt)
  for (const [engine, hooks] of Object.entries(engineHooks)) hookStep(engine, () => hooks.install(port))
  const others = OTHER_INSTALLERS.filter(([vendor]) => !options.only || options.only.has(vendor))
  if (!others.length) return
  const installers = await loadEngine('hooks')
  for (const [vendor, installer] of others) {
    hookStep(vendor, () => {
      if (!installers) throw new Error('its installer could not be loaded')
      installer(installers)(port)
    })
  }
}
