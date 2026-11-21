import type { RegisteredSession } from '../../lib/registry.js'

const BINDING_FIELDS = ['agentId', 'sessionId', 'engine', 'active', 'registeredAt', 'boundAt',
  'transcriptPath', 'tmuxPane', 'primaryRuntimeKey', 'identityHold', 'evidenceRevision'] as const

/** Keep the equality of scalar values in the former JSON array, including absent and nonfinite values. */
const scalar = (value: RegisteredSession[typeof BINDING_FIELDS[number]]) =>
  value == null || typeof value === 'number' && !Number.isFinite(value) ? null : value

/** Registry rows can change in place. Capture values once; freshly check every field at every effect.
 * Repeated full JSON bindings copied long transcript paths on every input guard (2026-11-18 profile). */
export function captureSessionBinding(session: RegisteredSession | undefined): (current: RegisteredSession | undefined) => boolean {
  if (!session) return current => !current
  const values = new Array<ReturnType<typeof scalar>>(BINDING_FIELDS.length)
  for (let i = 0; i < BINDING_FIELDS.length; i++) values[i] = scalar(session[BINDING_FIELDS[i]])
  const nested = JSON.stringify([session.runtimes, session.processIdentity])
  return current => {
    if (!current) return false
    for (let i = 0; i < BINDING_FIELDS.length; i++) {
      if (scalar(current[BINDING_FIELDS[i]]) !== values[i]) return false
    }
    return JSON.stringify([current.runtimes, current.processIdentity]) === nested
  }
}

/**
 * The record a write begun under `typed` finishes under: `now` when it is `typed`'s launch, bound since,
 * otherwise `typed` itself, whose binding a fenced reading then refuses. An engine draws its composer
 * before its first hook binds the conversation, so a message typed in that gap sees its record rebuilt
 * before the Enter, the same agent in the same pane and process. A first startup can finish this
 * intent; a rebind, a rotation, another pane or another process cannot resume it.
 */
export function launchBound(typed: RegisteredSession, now: RegisteredSession | undefined): RegisteredSession {
  const starting = typed.launch !== undefined && typed.boundAt === null
  return starting && now !== undefined && now.agentId === typed.agentId && now.engine === typed.engine
    && now.registeredAt === typed.registeredAt && now.tmuxPane === typed.tmuxPane && now.primaryRuntimeKey === typed.primaryRuntimeKey
    // Unknown while starting, a process found since is the one the pane started; one known when typed must stay.
    && (!typed.processIdentity || JSON.stringify(now.processIdentity) === JSON.stringify(typed.processIdentity))
    ? now : typed
}
