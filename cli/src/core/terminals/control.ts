/**
 * Terminal control: reading a pane and typing, submitting and sending keys to it, through a control
 * lease: a short one that lapses after 15 s of quiet, or one pinned for as long as a caller holds the
 * pane (a question being answered, a sequence of keys). A pinned lease that stops validating is not
 * quietly replaced: every later action on that pane fails until it is unpinned, so a sequence never
 * continues in a pane that changed under it.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 2: docs/design/2026-10-03-harnessd.md).
 */
import type { RegisteredSession } from '../../lib/registry.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { TERMINAL_LEASE_REFUSED, terminalActionNotStarted, type SubmitOptions, type TerminalActionResult } from '../../lib/terminalTypes.js'

export type TerminalControlBackend = Pick<TerminalBackendCoordinator,
  'acquireLease' | 'validateLease' | 'capture' | 'captureLease' | 'submitText' | 'submitTextLease'
  | 'submitTextForLease' | 'typeLiteralLease' | 'sendLegacyKeyLease' | 'validate'>

export interface TerminalControlDeps {
  /** The agent a target names: its agent id, session id or pane. */
  resolve: (target: string) => RegisteredSession | undefined
  terminals: TerminalControlBackend
}

export function createTerminalControl({ resolve, terminals }: TerminalControlDeps) {
  const terminalSession = (target: string): RegisteredSession | undefined => resolve(target)
  const controlLeases = new Map<string, { lease: Awaited<ReturnType<typeof terminals.acquireLease>> & { state: 'succeeded' }; expiresAt: number }>()
  const pinnedControls = new Set<string>()
  const invalidControls = new Set<string>()
  const CONTROL_LEASE_IDLE_MS = 15_000
  const leasedTerminal = async (session: RegisteredSession): Promise<Extract<Awaited<ReturnType<typeof terminals.acquireLease>>, { state: 'succeeded' }> | null> => {
    const pinned = pinnedControls.has(session.agentId)
    if (pinned && invalidControls.has(session.agentId)) return null
    const current = controlLeases.get(session.agentId)
    if (current && (pinned || current.expiresAt > Date.now())) {
      if (!await terminals.validateLease(current.lease.value, session)) {
        controlLeases.delete(session.agentId)
        if (pinned) invalidControls.add(session.agentId)
        return null
      }
      current.expiresAt = Date.now() + CONTROL_LEASE_IDLE_MS
      return current.lease
    }
    controlLeases.delete(session.agentId)
    const acquired = await terminals.acquireLease(session)
    if (acquired.state !== 'succeeded') return null
    const value = { lease: acquired, expiresAt: Date.now() + CONTROL_LEASE_IDLE_MS }
    controlLeases.set(session.agentId, value)
    return acquired
  }
  const pinTerminalControl = (target: string): (() => void) | null => {
    const session = terminalSession(target)
    if (!session || pinnedControls.has(session.agentId)) return null
    pinnedControls.add(session.agentId)
    invalidControls.delete(session.agentId)
    return () => {
      pinnedControls.delete(session.agentId)
      invalidControls.delete(session.agentId)
      controlLeases.delete(session.agentId)
    }
  }
  const invalidateTerminalControl = (agentId: string): void => {
    controlLeases.delete(agentId)
    if (pinnedControls.has(agentId)) invalidControls.add(agentId)
  }
  const captureTerminal = async (target: string, historyLines?: number): Promise<string | null> => {
    const session = terminalSession(target)
    if (!session) return null
    const pinned = pinnedControls.has(session.agentId)
    if (pinned && invalidControls.has(session.agentId)) return null
    let activeLease = controlLeases.get(session.agentId)
    if (activeLease && !pinned && activeLease.expiresAt <= Date.now()) {
      controlLeases.delete(session.agentId)
      activeLease = undefined
    }
    const leased = activeLease || pinned ? await leasedTerminal(session) : null
    if ((activeLease || pinned) && !leased) return null
    const result = leased
      ? await terminals.captureLease(leased.value, { historyLines })
      : await terminals.capture(session, { historyLines })
    return result.state === 'succeeded' ? result.value : null
  }
  const terminalActionSucceeded = (result: Awaited<ReturnType<typeof terminals.submitText>>): boolean =>
    result.state === 'succeeded'
  const submitTerminalAction = async (target: string, text: string, options?: SubmitOptions): Promise<TerminalActionResult> => {
    const session = terminalSession(target)
    if (!session) return terminalActionNotStarted('terminal agent is unavailable')
    const lease = await leasedTerminal(session)
    if (!lease) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    const result = pinnedControls.has(session.agentId)
      ? await terminals.submitTextLease(lease.value, text, options)
      : await terminals.submitTextForLease(session, lease.value, text, options)
    if (result.state !== 'succeeded' && pinnedControls.has(session.agentId)) invalidateTerminalControl(session.agentId)
    return result
  }
  const submitTerminal = async (target: string, text: string): Promise<boolean> => {
    return terminalActionSucceeded(await submitTerminalAction(target, text))
  }
  const typeTerminal = async (target: string, text: string): Promise<boolean> => {
    const session = terminalSession(target)
    if (!session) return false
    const lease = await leasedTerminal(session)
    if (!lease) return false
    const succeeded = terminalActionSucceeded(await terminals.typeLiteralLease(lease.value, text))
    if (!succeeded && pinnedControls.has(session.agentId)) invalidateTerminalControl(session.agentId)
    return succeeded
  }
  const keyTerminalAction = async (target: string, key: string): Promise<TerminalActionResult> => {
    const session = terminalSession(target)
    if (!session) return terminalActionNotStarted('terminal session is unavailable')
    const lease = await leasedTerminal(session)
    if (!lease) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    const result = await terminals.sendLegacyKeyLease(lease.value, key)
    if (result.state !== 'succeeded' && pinnedControls.has(session.agentId)) invalidateTerminalControl(session.agentId)
    return result
  }
  const keyTerminal = async (target: string, key: string): Promise<boolean> => {
    return terminalActionSucceeded(await keyTerminalAction(target, key))
  }
  const validateTerminal = async (session: RegisteredSession): Promise<boolean> =>
    (await terminals.validate(session)).state === 'alive'
  /**
   * Whether a session's terminal is known to be gone: the agent is dormant, tmux has no such pane, or
   * another process is in it. Not the same question as `validateTerminal`, which is the one to ask before
   * writing to a pane: a probe that could not answer (it timed out, or the process table could not be
   * read) is no reason to write, and no evidence either that the terminal is gone.
   */
  const terminalGone = async (session: RegisteredSession): Promise<boolean> =>
    (await terminals.validate(session)).state === 'gone'
  return {
    pinnedControls, pinTerminalControl, invalidateTerminalControl, captureTerminal, submitTerminalAction,
    submitTerminal, typeTerminal, keyTerminalAction, keyTerminal, validateTerminal, terminalGone,
  }
}

export type TerminalControl = ReturnType<typeof createTerminalControl>
