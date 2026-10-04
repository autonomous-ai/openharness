/**
 * The engines' own hooks: which registered agent a hook belongs to, what a SessionEnd means, and
 * installing every engine's hooks so they call this daemon.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 12: docs/design/2026-10-03-harnessd.md).
 */
import { chooseHookAgent, type HookServerHandlers } from '../../hookServer.js'
import {
  installAgyHooks, installAmpPlugin, installCodexHooks, installCommandCodeHooks, installCopilotHooks, installCursorHooks,
  installDevinHooks, installGrokHooks, installHermesHooks, installKiloPlugin, installOpencodePlugin, installPiExtension,
  installSessionHooks,
} from '../../lib/hooks.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import type { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import type { TerminalRuntimeRef } from '../../lib/terminalTypes.js'

type ResolveHookAgent = NonNullable<HookServerHandlers['resolveHookAgent']>

export interface EngineHookDeps {
  /** Hints name tmux panes; without tmux there is nothing they can point at. */
  tmuxBackend: unknown
  agentReconciler: Pick<TerminalAgentReconciler, 'triggerHint' | 'trigger'>
  registry: Pick<typeof registry, 'byRuntimeEngine'>
}

export function createEngineHooks({ tmuxBackend, agentReconciler, registry }: EngineHookDeps) {
  const resolveHookAgent: ResolveHookAgent = async ({ engine, runtimeHints, callerPid }) => {
    if (!callerPid) return null
    const resolved: TerminalRuntimeRef[] = []
    for (const hint of runtimeHints ?? []) {
      if (tmuxBackend) resolved.push({ backend: 'tmux', paneId: hint.paneId })
    }
    for (const runtime of resolved) await agentReconciler.triggerHint(runtime, engine)

    const rows = await processRows()
    if (!rows) return null
    const callerBelongsTo = (session: RegisteredSession): boolean => {
      const expectedPid = session.processIdentity?.pid
      if (!expectedPid) return false
      const byPid = new Map(rows.map((row) => [row.pid, row.parentPid]))
      let pid = callerPid
      const visited = new Set<number>()
      while (pid > 0 && !visited.has(pid)) {
        if (pid === expectedPid) return true
        visited.add(pid)
        pid = byPid.get(pid) ?? 0
      }
      return false
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
    for (const runtime of resolved) {
      const candidate = registry.byRuntimeEngine(runtime, engine)
      if (!candidate) continue
      if (callerBelongsTo(candidate)) candidates.set(candidate.agentId, candidate)
      else onHintedRuntime.set(candidate.agentId, candidate)
    }
    const choice = chooseHookAgent([...candidates.values()], [...onHintedRuntime.values()], engine)
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
 * Install every engine's hooks with the port the local server actually bound.
 *
 * One vendor at a time, each behind its own guard: these write into thirteen different settings
 * files owned by thirteen different CLIs, and one that is malformed, read-only or mid-write is not
 * a reason for the other twelve to go uninstalled — let alone for the daemon not to come up.
 */
export function installEngineHooks(port: number): void {
  const hookStep = (vendor: string, install: () => void): void => {
    try { install() } catch (error) {
      console.warn(`[hooks] ${vendor} install skipped · ${error instanceof Error ? error.message : error}`)
    }
  }
  hookStep('claude', () => installSessionHooks(port))
  hookStep('codex', () => installCodexHooks(port))
  hookStep('cursor', () => installCursorHooks(port))
  hookStep('opencode', () => installOpencodePlugin(port))
  hookStep('kilo', () => installKiloPlugin(port))
  hookStep('pi', () => installPiExtension(port))
  // A self-update refreshes plugin files here; running engine processes pick them up according to each
  // vendor's own plugin reload lifecycle.
  hookStep('amp', () => installAmpPlugin(port))
  hookStep('hermes', () => installHermesHooks(port))
  hookStep('devin', () => installDevinHooks(port))
  hookStep('commandcode', () => installCommandCodeHooks(port))
  hookStep('grok', () => installGrokHooks(port))
  hookStep('agy', () => installAgyHooks(port))
  hookStep('copilot', () => installCopilotHooks(port))
}
