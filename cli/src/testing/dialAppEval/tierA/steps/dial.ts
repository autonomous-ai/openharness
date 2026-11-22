// Tier A's steps on the dial: a tap, a swipe, a stroke, and its cable pulled and plugged in again, through the loopback
// dial on the devices' real cable.
import type { StepHandler } from '../world.js'

export const dialSteps: { tap: StepHandler<'tap'>; swipe: StepHandler<'swipe'>; stroke: StepHandler<'stroke'>; unplug: StepHandler<'unplug'>;
  replug: StepHandler<'replug'> } = {
  tap: async (world, step) => { world.dial.tap(world.agentId(step.session)) },
  // The rest that opens the session after a swipe is the cable's own timer: the step only turns the dial.
  swipe: async (world, step) => { world.dial.swipe(world.agentId(step.session)) },
  // Three lines toward older ones, as dialVscode.e2e.ts strokes: the finger down, three moves of 8, and lifted.
  stroke: async (world) => {
    world.dial.send({ t: 'scroll', phase: 'down', dy: 0, v: 0 })
    for (let move = 0; move < 3; move++) world.dial.send({ t: 'scroll', phase: 'move', dy: 8, v: 0 })
    world.dial.send({ t: 'scroll', phase: 'up', dy: 0, v: 0 })
  },
  unplug: async (world) => { world.dial.unplug() },
  replug: async (world) => { world.dial.replug() },
}
