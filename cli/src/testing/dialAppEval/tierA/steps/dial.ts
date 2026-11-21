// Tier A's steps on the dial: a tap, a swipe, and its cable pulled and plugged in again, through the loopback dial on
// the devices' real cable.
import type { StepHandler } from '../world.js'

export const dialSteps: { tap: StepHandler<'tap'>; swipe: StepHandler<'swipe'>; unplug: StepHandler<'unplug'>; replug: StepHandler<'replug'> } = {
  tap: async (world, step) => { world.dial.tap(world.agentId(step.session)) },
  // The rest that opens the session after a swipe is the cable's own timer: the step only turns the dial.
  swipe: async (world, step) => { world.dial.swipe(world.agentId(step.session)) },
  unplug: async (world) => { world.dial.unplug() },
  replug: async (world) => { world.dial.replug() },
}
