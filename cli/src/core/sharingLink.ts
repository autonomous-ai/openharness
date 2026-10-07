/**
 * Share in its own process, as the core sees it (an experiment, step 8; the process's side is
 * services/sharingProcess.ts). The core tells it two things, both from the relay: an observer's frame, which
 * asks for Share's process if it is off (an observer of a share saved here), and the relay's link gone, with
 * every observer on it. Nothing is held for it while it is down: an observer whose frame finds no Share is
 * answered by its own timeout, as one whose owner went offline.
 */
import type { SharingPort } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

export interface SharingLinkDeps {
  /** Ask Share's process (core/serviceLinks.ts `call`, for `sharing`): it asks the master for it while it is off. */
  call(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Tell Share's process something (core/serviceLinks.ts `notify`, for `sharing`). */
  notify(frame: ServiceFrame): boolean
}

export function createSharingLink(deps: SharingLinkDeps): SharingPort {
  return {
    observer: async (connId, type, payload) => { await deps.call('observer', { connId, type, payload }) },
    linkDown: () => { deps.notify({ type: 'service_event', payload: { kind: 'linkDown' } }) },
    // Its process is the master's to stop.
    stop: () => {},
  }
}
