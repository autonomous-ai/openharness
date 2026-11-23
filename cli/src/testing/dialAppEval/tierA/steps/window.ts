// Tier A's steps on the windows, as the devices' listener hears them: the app in front and the ChatGPT app's window
// title from `harness hardware watch`, and the session the Claude app shows from the harness-device mod. The editors'
// and Orca's fakes reach the listener the same way (handlerOf, tell).
import { frontAppId } from '../../../../cable/hosts/frontApp.js'
import { frontName } from '../../types.js'
import type { ListenerHandler, ListenerStreamHandler } from '../../../../services/devicesListener.js'
import type { StepHandler, TierAWorld } from '../world.js'

/** The devices' own handler of a message type, as their listener hands it: none opened fails the step. */
export function handlerOf<T extends ListenerHandler | ListenerStreamHandler>(world: TierAWorld, type: string): T {
  const handler = world.listener[type]
  if (!handler) throw new Error(`the devices opened no listener for ${type}`)
  return handler as T
}

/** One message to the listener, as its sender writes it: a handler that answers anything refused it. */
export async function tell(world: TierAWorld, message: { type: string } & Record<string, unknown>): Promise<void> {
  const answer: unknown = await handlerOf<ListenerHandler>(world, message.type).handle(message, new AbortController().signal)
  if (answer !== undefined) throw new Error(`the devices' listener refused a ${message.type}: ${String(answer)}`)
}

export const windowSteps: { front: StepHandler<'front'>; thread: StepHandler<'thread'>; attach: StepHandler<'attach'> } = {
  front: (world, step) => {
    world.front = step.app
    // The watch sends what the product makes of the OS's own name, so a platform where it cannot tell an app is graded
    // as the person sees it.
    return tell(world, { type: 'front', app: frontAppId(frontName(world.platform, step.app)) })
  },
  thread: (world, step) => tell(world, { type: 'thread', title: step.title }),
  // The mod names the Claude Code session the app attached: its cliSessionId.
  attach: (world, step) => tell(world, { type: 'attach', sessionId: world.session(step.session).id }),
}
