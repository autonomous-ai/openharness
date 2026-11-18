import type { RegisteredSession } from '../lib/registry.js'
import type { WindowFocus } from './api.js'
import { paneReadIdentity } from './transcripts/readIdentity.js'

export interface WindowFocusDeps {
  machineId(): string
  byAgent(agentId: string): RegisteredSession | undefined
  /** The current conditional-selection validator; replacement revokes an outstanding answer. */
  validator(): object | null
  validate(revision: string, connection: string): Promise<boolean>
  changed(state: WindowFocus, machineId: string, agentId: string | null, connection: string): void
}

/** One desk's actual window state. Components may validate a conditional selection; only this owner
 * applies it, after the local socket has checked its original physical window. */
export function createWindowFocus(deps: WindowFocusDeps) {
  let form: WindowFocus['form'] = null, voice: WindowFocus['voice'] = null
  const state = (): WindowFocus => ({ form: form ? { ...form } : null, voice: voice ? { ...voice } : null })
  const apply = (machineId: string, agentId: string | null, connId: string): true => {
    form = { machineId, connId }
    if (agentId === null) {
      if (voice?.connId === connId) voice = null
    } else voice = { machineId, agentId, connId }
    deps.changed(state(), machineId, agentId, connId)
    return true
  }
  return {
    state,
    disconnected(connId: string): WindowFocus {
      if (form?.connId === connId) form = null
      if (voice?.connId === connId) voice = null
      return state()
    },
    select(machineId: string, agentId: string | null, connId: string, revision?: string): boolean | Promise<false | (() => boolean)> {
      if (revision === undefined) return apply(machineId, agentId, connId)
      const validator = deps.validator(), target = agentId ? deps.byAgent(agentId) : undefined
      if (!revision || revision.length > 128 || !validator || machineId !== deps.machineId() || !target || target.identityHold) return false
      const originalForm = form, originalVoice = voice, binding = paneReadIdentity(target)
      return deps.validate(revision, connId).then(current => {
        if (!current) return false as const
        return (): boolean => {
          if (machineId !== deps.machineId() || deps.validator() !== validator || form !== originalForm || voice !== originalVoice ||
            paneReadIdentity(deps.byAgent(agentId!)) !== binding) return false
          return apply(machineId, agentId, connId)
        }
      })
    },
  }
}
