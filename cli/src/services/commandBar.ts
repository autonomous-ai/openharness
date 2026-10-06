/**
 * The command bar: JEV's decisions for the window's command bar and ⌘K (lib/commandBar.ts), an experiment
 * that runs in a process of its own, started when one of its requests arrives. Moved out of the core as it
 * was (docs/design/2026-10-06-core-boundary-next.md, "Light features"): the core keeps only its doors, and
 * nothing in the core depends on it. Off, or its process down, its requests are refused SERVICE_UNAVAILABLE.
 *
 * Its two doors, with the answers each gave from the core:
 * - `command_bar`, a request on the socket (a remote owner's app, or a window here): the decision, or
 *   `{ error, detail }`. At most two at once per connection and eight in all, and a connection that closes
 *   has its own aborted (lib/ownerCommands.ts did both, keyed by the socket's connection id; the core now
 *   gives that id with every request, and says when it closes: `Asker.connection`, `closed`).
 * - `command_bar_http`, the hook server's `/api/command-bar/status` and `/resolve` (lib/commandBarHttp.ts),
 *   which checks who asks and reads the body, and asks here on a connection of its own for each HTTP request:
 *   the HTTP status and body to answer with. Only a process on this computer may ask it.
 *
 * One `CommandBarService` answers both, so its own bounds (two decisions at once, twenty a minute) hold
 * across the doors, as they did when both called the core's one instance.
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { CommandBarError, CommandBarService, commandBarService } from '../lib/commandBar.js'

/** The requests the command bar answers, declared in core/api.ts for the core to route. */
export { COMMAND_BAR_REQUESTS } from '../core/api.js'

/** What the command bar decides with: lib/commandBar.ts's service, or a test's. */
export interface Commands {
  status(): Promise<unknown>
  decide(raw: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>
}

/**
 * The JEV decisions, with what the tests point them at. `HARNESS_TEST_JEV_URL` (end-to-end tests only,
 * e2e/commandBar.e2e.ts) sends them to a fake Decisions endpoint on this computer instead of OpenRouter:
 * a loopback `http:` origin only, so a stray setting can never send the key anywhere else.
 */
export function commandsFor(env: NodeJS.ProcessEnv = process.env): Commands {
  const fake = env.HARNESS_TEST_JEV_URL
  if (!fake) return commandBarService
  const url = new URL(fake)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('HARNESS_TEST_JEV_URL must be a loopback http: URL')
  return new CommandBarService({ fetch: (_endpoint, init) => fetch(url, init) })
}

export function startCommandBar(_core: CoreApi, commands: Commands = commandsFor()): ServiceRequests {
  /** The socket's decisions in flight, each with the connection that asked: what its limits count. */
  const pending = new Map<object, unknown>()
  return {
    command_bar: async (payload, asker, closed) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      // A request with no connection (from a core before connections were given) counts as its own.
      const connection = asker.connection ?? {}
      if (pending.size >= 8 || [...pending.values()].filter((id) => id === connection).length >= 2) return { error: 'BUSY' }
      const request = {}
      pending.set(request, connection)
      try {
        return await commands.decide(payload.request, closed)
      } catch (error) {
        return error instanceof CommandBarError
          ? { error: error.code, detail: error.message }
          : { error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' }
      } finally { pending.delete(request) }
    },
    command_bar_http: async (payload, asker, closed) => {
      // The hook server's door asks as this computer; a remote client is not that door.
      if (!asker.local) return { error: 'UNSUPPORTED' }
      const fail = (status: number, code: string, message: string) => ({ status, body: { success: false, error: { code, message } } })
      try {
        const data = payload.route === 'status' ? await commands.status() : await commands.decide(payload.body, closed)
        return { status: 200, body: { success: true, data } }
      } catch (error) {
        return error instanceof CommandBarError ? fail(error.status, error.code, error.message) : fail(502, 'UNAVAILABLE', 'Command bar unavailable.')
      }
    },
  }
}
