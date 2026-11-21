// Tier A's steps on live sessions: their hooks, and the app quitting and coming back (Task 12 builds them).
import { StepNotBuilt } from '../../types.js'
import type { StepHandler } from '../world.js'

export const sessionsSteps: { hook: StepHandler<'hook'>; quit: StepHandler<'quit'>; relaunch: StepHandler<'relaunch'> } = {
  hook: async () => { throw new StepNotBuilt('hook', 'a') },
  quit: async () => { throw new StepNotBuilt('quit', 'a') },
  relaunch: async () => { throw new StepNotBuilt('relaunch', 'a') },
}
