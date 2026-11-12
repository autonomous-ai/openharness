/** Explicit inline composition; supervised core does not import Codex's provider move. */
import { windowsEngineArgv } from '../lib/windows/launch.js'
import type { MoveProvider } from './facets/providerMove.js'
import { moveCodexConversation } from './codex/providerMove.js'

const codex: MoveProvider = async ({ command, ...ask }) => {
  try {
    // On Windows an npm shim's batch file cannot be spawned (lib/windows/launch.ts).
    return { threadId: await moveCodexConversation({ ...ask, argv: (codexArgs) => windowsEngineArgv('codex', [command, ...codexArgs]) }) }
  } catch (error) { return { refused: (error instanceof Error ? error.message : String(error)).slice(0, 500) } }
}
export const providerMoveFor = (engine: string): MoveProvider | undefined => engine === 'codex' ? codex : undefined
