/**
 * `session_get` answered the way the daemon answers it, for a socket a spec builds on its own. The request
 * left the socket's switch for the core (core/transcripts/history.ts), and cli.ts binds it, so a bare
 * socket answers it UNSUPPORTED. This binds it the same way: over the registry and the saved harnesses, the
 * socket's own pager and the engines' stores.
 */
import { join } from 'node:path'
import type { BackendSocket } from '../backendSocket.js'
import { env } from '../config/env.js'
import { createHistory } from '../core/transcripts/history.js'
import { hermesDbForSession } from '../lib/hermesHome.js'
import { registry } from '../lib/registry.js'
import { stoppedAgents } from '../lib/stoppedAgents.js'

export function bindHistory(socket: BackendSocket): void {
  socket.historyProvider = createHistory({
    resolve: (id) => registry.resolve(id),
    stopped: () => stoppedAgents.list(),
    pages: socket.transcriptPages,
    dbs: { opencode: join(env.OPENCODE_DATA_DIR, 'opencode.db'), kilo: join(env.KILO_DATA_DIR, 'kilo.db'), devin: join(env.DEVIN_HOME, 'sessions.db') },
    hermesDb: (s) => hermesDbForSession(s),
  }).sessionGet
}
