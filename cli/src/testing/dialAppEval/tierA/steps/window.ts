// Tier A's steps on the windows, as the devices' listener hears them: the app in front and the ChatGPT app's window
// title from `harness hardware watch`, and the session the Claude app shows from the harness-device mod.
import type { App } from '../../types.js'
import type { ListenerHandler } from '../../../../services/devicesListener.js'
import type { StepHandler, TierAWorld } from '../world.js'

/** The watch's app id of each: the ChatGPT app is Codex's, and any other app in front is none the dial follows. */
const FRONT: Readonly<Record<App | 'other', string>> = { claude: 'claude', chatgpt: 'codex', other: 'none' }

/** One message to the listener, as its sender writes it: a handler that answers anything refused it. */
async function tell(world: TierAWorld, message: { type: string } & Record<string, unknown>): Promise<void> {
  const handler = world.listener[message.type] as ListenerHandler | undefined
  if (!handler) throw new Error(`the devices opened no listener for ${message.type}`)
  const answer: unknown = await handler.handle(message, new AbortController().signal)
  if (answer !== undefined) throw new Error(`the devices' listener refused a ${message.type}: ${String(answer)}`)
}

export const windowSteps: { front: StepHandler<'front'>; thread: StepHandler<'thread'>; attach: StepHandler<'attach'> } = {
  front: (world, step) => {
    world.front = step.app
    return tell(world, { type: 'front', app: FRONT[step.app] })
  },
  thread: (world, step) => tell(world, { type: 'thread', title: step.title }),
  // The mod names the Claude Code session the app attached: its cliSessionId.
  attach: (world, step) => tell(world, { type: 'attach', sessionId: world.session(step.session).id }),
}
