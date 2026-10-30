/**
 * Shared machines in their own process (the edge host; services/sharedMachinesProcess.ts), as the core
 * reaches it: a guest's harness (`guestLaunch`), asked when a guest's New Harness arrives and never in a
 * connection's line. An answer that does not come (the process is down, or slower than its wait,
 * core/api.ts `LONG_ANSWERS`), or one not shaped as a launch, is the fallback: guest access unavailable.
 * The argv and the variables are checked here, as strings, because the core runs them in a pane.
 */
import { GUEST_LAUNCH_UNAVAILABLE, type GuestLaunch, type SharedMachinesCorePort } from './api.js'

/** Ask shared machines' process (core/serviceLinks.ts `call`, for `sharedMachines`): never rejects. */
export type CallSharedMachines = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
const stringMap = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')

export function createSharedMachinesLink(call: CallSharedMachines): SharedMachinesCorePort {
  return {
    guestLaunch: async (input): Promise<GuestLaunch> => {
      const answer = await call('guestLaunch', { ...input })
      if (answer.ok === true && typeof answer.workspace === 'string' && strings(answer.argv) && stringMap(answer.env)) {
        return { ok: true, workspace: answer.workspace, argv: answer.argv, env: answer.env }
      }
      if (answer.ok === false && typeof answer.error === 'string') {
        return { ok: false, error: answer.error, ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
      }
      return GUEST_LAUNCH_UNAVAILABLE
    },
    // The process stops its own relay.
    stop: () => {},
  }
}
