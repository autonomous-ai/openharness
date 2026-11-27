/** The flags a session's engine process was launched with, as the readers of its effort need them. Types only: the core's
 *  runtime profiles load it without the vendors' launch code (architecture.spec.ts). */
import type { RegisteredSession } from './registry.js'

/** The model and effort [session]'s engine was launched with as flags ([RegisteredSession.launchModel]): none on a grid, whose
 *  relaunch passes none of them (launchOverrides.ts), though its row keeps them for the move home (review of #4090). */
export function launchFlagsOf(session: Pick<RegisteredSession, 'launchModel' | 'gridLaunch'>): RegisteredSession['launchModel'] {
  return session.gridLaunch ? undefined : session.launchModel
}
