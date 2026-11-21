// Tier A's steps on the dial: a tap, a swipe, and its cable pulled and plugged in again (Task 13 builds them).
import { StepNotBuilt } from '../../types.js'
import type { StepHandler } from '../world.js'

export const dialSteps: { tap: StepHandler<'tap'>; swipe: StepHandler<'swipe'>; unplug: StepHandler<'unplug'>; replug: StepHandler<'replug'> } = {
  tap: async () => { throw new StepNotBuilt('tap', 'a') },
  swipe: async () => { throw new StepNotBuilt('swipe', 'a') },
  unplug: async () => { throw new StepNotBuilt('unplug', 'a') },
  replug: async () => { throw new StepNotBuilt('replug', 'a') },
}
