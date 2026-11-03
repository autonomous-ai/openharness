/**
 * What a daemon's backend socket says it is (`?client=`, `?v=`), read by the backend's lib/wsAttribution.ts.
 * Prod, 2026-10-28: 2,304 of 2,308 web-ws opens in 15 minutes declared nothing, so nobody could say which client
 * churned (WebSocket roadmap Phase 0). `relay`: the daemon's relays (web-ws, observer-ws, agent-messages-ws);
 * `link`: `harness link connect`'s one-shot socket.
 */
import { VERSION } from '../version.js'

export function declaredClientQuery(client: 'relay' | 'link'): string {
  return `client=${client}&v=${encodeURIComponent(VERSION)}`
}
