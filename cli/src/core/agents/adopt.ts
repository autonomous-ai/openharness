/**
 * Adopting a conversation Harness did not start: whether one discovery found can be opened here as a
 * harness, and taking it over from a terminal that has it open — now, or once its turn ends — never
 * from an app, and never from a pane that is Harness's own.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { existsSync } from 'node:fs'
import type { AgentEngine } from '../../engines/types.js'
import { engineLabel } from '../../lib/agentNames.js'
import { sid } from '../../lib/log.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { processAlive, stopSessionOwner, type ExternalSessions, type OpenSessions, type SessionOwner } from '../../lib/sessionSearch/external.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'

export interface AdoptDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  byAgent: (agentId: string) => RegisteredSession | undefined
  stoppedAgents: Pick<StoppedAgentStore, 'list'>
  externalSessions: Pick<ExternalSessions, 'get' | 'scan'>
  openSessions: Pick<OpenSessions, 'owner' | 'busy'>
  /** Session search, when it is on: the title it indexed for a conversation. */
  search: { session(sessionId: string): { title?: string } | undefined } | null | undefined
}

export function createAdoption({ bySession, byAgent, stoppedAgents, externalSessions, openSessions, search }: AdoptDeps) {
  /**
   * Whether a conversation Harness did not start can be opened here as a harness: one discovery found
   * (looked for again if it is new), on this engine, not already a harness, and not open in a running
   * process — a terminal or the engine's app that still has it would write it too.
   *
   * One open in a terminal can be taken over ([takeOver]): the terminal's process is stopped and the
   * conversation resumes here. Asked without it, the refusal says whether that process is mid-turn,
   * so the person can choose to wait for the turn to end or stop it now. An app's is never stopped.
   */
  const adoptableSession = async (sessionId: string, engine: AgentEngine, takeOver: 'idle' | 'now' | 'wait' | null): Promise<{ ok: true; cwd: string; title: string; owner: SessionOwner | null; busy: boolean; launchArgs: readonly string[] } | { ok: false; error: string; detail: string }> => {
    const held = (id: string) => !!bySession(id) || stoppedAgents.list().some((s) => s.sessionId === id)
    if (held(sessionId)) {
      return { ok: false, error: 'SESSION_IN_HARNESS', detail: 'This conversation is already a harness here.' }
    }
    const found = externalSessions.get(sessionId) ?? (await externalSessions.scan(), externalSessions.get(sessionId))
    if (found && [found.sessionId, ...found.aliases ?? []].some(held)) {
      return { ok: false, error: 'SESSION_IN_HARNESS', detail: 'This conversation is already a harness here.' }
    }
    if (!found) return { ok: false, error: 'SESSION_NOT_FOUND', detail: 'This conversation is no longer on this machine.' }
    if (found.engine !== engine) return { ok: false, error: 'INVALID_ENGINE', detail: `This is a ${found.engine} conversation.` }
    // The Codex app keeps a thread in a folder of its own, which people tidy away. Checked before
    // anything is stopped: a take-over that then cannot open would only have closed it.
    if (!existsSync(found.cwd)) {
      return { ok: false, error: 'SESSION_FOLDER_GONE', detail: `The folder it ran in is gone: ${found.cwd}` }
    }
    const title = found.title || search?.session(sessionId)?.title || ''
    const launchArgs = found.launchArgs ?? []
    const owner = await openSessions.owner(sessionId)
    if (!owner) return { ok: true, cwd: found.cwd, title, owner: null, busy: false, launchArgs }
    const engineName = engineLabel(engine)
    // A process in one of Harness's own panes is an agent the daemon is still binding: never stopped.
    if (owner.harness) return { ok: false, error: 'SESSION_IN_HARNESS', detail: 'This conversation is already a harness here.' }
    // Started on it, as its arguments say, and perhaps moved on since — or in a pane nobody could check
    // was not Harness's own: not opened twice, never stopped.
    if (owner.fromArgs || owner.unverified) {
      return { ok: false, error: 'SESSION_OPEN_ELSEWHERE', detail: `It may be open in ${engineName} in a terminal. Close it there, then open it here.` }
    }
    if (!owner.tty) {
      return { ok: false, error: 'SESSION_OPEN_ELSEWHERE', detail: `It is open in ${engineName}'s app or an editor. Close it there, then open it here.` }
    }
    const busy = await openSessions.busy(owner)
    if (busy && (takeOver === null || takeOver === 'idle')) {
      return { ok: false, error: 'SESSION_BUSY_IN_TERMINAL', detail: `${engineName} is working on it in a terminal.` }
    }
    if (takeOver === null) {
      return { ok: false, error: 'SESSION_OPEN_IN_TERMINAL', detail: `It is open in ${engineName} in a terminal. Moving it here quits it there.` }
    }
    return { ok: true, cwd: found.cwd, title, owner, busy, launchArgs }
  }

  /**
   * A conversation taken over when its turn ends (`takeOver: 'wait'`): its pane waits for the
   * terminal's process to go (engineLaunch `waitForPid`), and this stops that process once the turn
   * is over. It gives up when the harness does — closed, or Ctrl-C in its pane — and when the person
   * quits it in the terminal themselves, which is the pane's cue as well.
   */
  const takeOverWhenIdle = async (agentId: string, owner: SessionOwner, sessionId: string): Promise<void> => {
    for (;;) {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref?.() })
      if (byAgent(agentId)?.launch?.state !== 'starting' || !processAlive(owner.pid)) return
      // Moved on in that terminal (`/resume`, `/new`): its turn is another conversation's now, and it
      // is left alone. The pane still waits for it to quit, and then opens this one.
      if (await heldBy(sessionId, owner) !== 'same') {
        console.log(`[agent] take over ${sid(sessionId)} · pid ${owner.pid} moved on · left running`)
        return
      }
      if (await openSessions.busy(owner)) continue
      const stopped = await stopSessionOwner(owner)
      console.log(`[agent] take over ${sid(sessionId)} · turn ended · pid ${owner.pid} ${stopped ? 'stopped' : 'did not stop'}`)
      return
    }
  }

  /**
   * Who holds [sessionId] now, against the [owner] seen when the person chose: `same` (that process,
   * still a terminal's, by hard evidence, not one of Harness's own), `free` (nobody), or `other`.
   * Asked again right before anything is stopped: the terminal may have moved to other work since.
   */
  const heldBy = async (sessionId: string, owner: SessionOwner): Promise<'same' | 'free' | 'other'> => {
    const now = await openSessions.owner(sessionId)
    if (!now) return 'free'
    return now.pid === owner.pid && !!now.tty && !now.fromArgs && !now.harness && !now.unverified ? 'same' : 'other'
  }
  return { adoptableSession, takeOverWhenIdle, heldBy }
}

export type Adoption = ReturnType<typeof createAdoption>
