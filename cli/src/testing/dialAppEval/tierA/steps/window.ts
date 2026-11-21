// Tier A's steps on the windows: the app in front, as `harness hardware watch` tells the devices' listener, and the
// window's title and the Claude mod's attach (Task 13 builds those two).
import { StepNotBuilt, type App } from '../../types.js'
import type { ListenerHandler } from '../../../../services/devicesListener.js'
import type { StepHandler } from '../world.js'

/** The watch's app id of each: the ChatGPT app is Codex's, and any other app in front is none the dial follows. */
const FRONT: Readonly<Record<App | 'other', string>> = { claude: 'claude', chatgpt: 'codex', other: 'none' }

export const windowSteps: { front: StepHandler<'front'>; thread: StepHandler<'thread'>; attach: StepHandler<'attach'> } = {
  front: async (world, step) => {
    const handler = world.listener.front as ListenerHandler | undefined
    if (!handler) throw new Error('the devices opened no listener for the app in front')
    const answer = await handler.handle({ type: 'front', app: FRONT[step.app] }, new AbortController().signal)
    if (answer !== undefined) throw new Error(`the devices' listener refused the app in front: ${String(answer)}`)
  },
  thread: async () => { throw new StepNotBuilt('thread', 'a') },
  attach: async () => { throw new StepNotBuilt('attach', 'a') },
}
