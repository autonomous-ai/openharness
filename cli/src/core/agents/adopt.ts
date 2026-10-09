/** Core decides admission. Search supplies observations, never ownership or control authority. */
import { existsSync } from 'node:fs'
import type { AgentEngine } from '../../engines/types.js'
import { engineLabel } from '../../lib/agentNames.js'
import { externalSessionRequest, externalUnavailable, type ExternalSessionAnswer, type ExternalSessionRequest } from '../../lib/externalSessionWire.js'
import type { SessionOwner } from '../../lib/sessionSearch/external.js'

export interface AdoptDeps {
  inspect(request: ExternalSessionRequest): Promise<ExternalSessionAnswer>
  held(id: string): boolean
}

export function adoptionDecision(sessionId: string, engine: AgentEngine, takeOver: 'idle' | 'now' | 'wait' | null, answer: ExternalSessionAnswer, held: (id: string) => boolean): { ok: true; cwd: string; title: string; owner: SessionOwner | null; busy: boolean; launchArgs: readonly string[] } | { ok: false; error: string; detail: string } {
    if (held(sessionId)) {
      return { ok: false, error: 'SESSION_IN_HARNESS', detail: 'This conversation is already a harness here.' }
    }
    if (!answer.ok) return answer
    const found = answer.session
    if (found && [found.sessionId, ...found.aliases ?? []].some(held)) {
      return { ok: false, error: 'SESSION_IN_HARNESS', detail: 'This conversation is already a harness here.' }
    }
    if (!found) return { ok: false, error: 'SESSION_NOT_FOUND', detail: 'This conversation is no longer on this machine.' }
    if (found.engine !== engine) return { ok: false, error: 'INVALID_ENGINE', detail: `This is a ${found.engine} conversation.` }
    // Codex will not resume a conversation it archived ("session <id> is archived. Run `codex unarchive
    // <id>` to unarchive it first"), and search finds archived ones: opened, the pane only printed that
    // error and the harness never started. Refused before anything starts or is stopped.
    if (found.archived) {
      return { ok: false, error: 'SESSION_ARCHIVED', detail: `Codex archived this conversation. Run \`codex unarchive ${found.sessionId}\` in a terminal, then open it here.` }
    }
    // The Codex app keeps a thread in a folder of its own, which people tidy away. Checked before
    // anything is stopped: a take-over that then cannot open would only have closed it.
    if (!existsSync(found.cwd)) {
      return { ok: false, error: 'SESSION_FOLDER_GONE', detail: `The folder it ran in is gone: ${found.cwd}` }
    }
    const title = found.title
    const launchArgs = found.launchArgs ?? []
    const owner = answer.owner
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
    const busy = answer.busy
    if (busy && (takeOver === null || takeOver === 'idle')) {
      return { ok: false, error: 'SESSION_BUSY_IN_TERMINAL', detail: `${engineName} is working on it in a terminal.` }
    }
    if (takeOver === null) {
      return { ok: false, error: 'SESSION_OPEN_IN_TERMINAL', detail: `It is open in ${engineName} in a terminal. Moving it here quits it there.` }
    }
    return { ok: true, cwd: found.cwd, title, owner, busy, launchArgs }
  }


export function createAdoption(deps: AdoptDeps) {
  const inspect = (sessionId: string, engine: AgentEngine) => {
    const request = externalSessionRequest({ sessionId, engine })
    return request ? deps.inspect(request) : Promise.resolve(externalUnavailable())
  }
  return {
    adoptableSession: async (sessionId: string, engine: AgentEngine, takeOver: 'idle' | 'now' | 'wait' | null) =>
      adoptionDecision(sessionId, engine, takeOver, await inspect(sessionId, engine), deps.held),
    heldBy: async (sessionId: string, owner: SessionOwner): Promise<'same' | 'free' | 'other'> => {
      const answer = await inspect(sessionId, owner.engine)
      if (!answer.ok) return 'other'
      const now = answer.owner
      if (!now) return 'free'
      return now.pid === owner.pid && !!now.tty && !now.fromArgs && !now.harness && !now.unverified ? 'same' : 'other'
    },
  }
}
export type Adoption = ReturnType<typeof createAdoption>
