import { env } from '../config/env.js'

/** The REST base for the backend's control endpoints, derived from the WS URL (wss→https, ws→http). In a file of its own:
 *  the core and the gateway need the base, not the CLI's calls beside it (lib/controlPlane.ts). */
export function backendHttpBase(): string {
  return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}
