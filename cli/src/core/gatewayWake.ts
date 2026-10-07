/**
 * When the gateway's process starts (harnessd/services.ts `gateway`, on demand since protocol 4).
 *
 * As the core starts, before it binds, when the gateway has work of its own here: this machine is signed in (the
 * relay to the backend, the remote clients' sessions, the trust group and the device key log), or anything is
 * paired (`e2e/paired.json`: a browser, a phone, a Wi-Fi device) or linked directly (the Wi-Fi device's direct
 * links). Asked that early, it comes up beside the core, as it did when it started with every other process, and
 * a phone reaches this machine as soon as it did. Otherwise the first thing that needs it asks for it
 * (core/gatewayLink.ts): a pairing, a window's E2EE request, a key or device command, the Wi-Fi device's service.
 * Signed out with nothing paired it has nothing to do: the relay is never dialed, and nothing could reach it.
 */
import { DIRECT_LINKS, PAIRINGS, savedRows } from './devicesWake.js'

/** Why the gateway is needed as the core starts, as the log says it; null when it is not. */
export function gatewayNeeded(deps: { signedIn: boolean; dataDir: string; read?: (file: string) => string }): string | null {
  if (deps.signedIn) return 'signed in'
  if (savedRows(deps.dataDir, PAIRINGS, deps.read).length) return 'a pairing'
  return savedRows(deps.dataDir, DIRECT_LINKS, deps.read).length ? 'a direct link' : null
}

/** At the core's start: the gateway's process asked for when it runs out here and is needed. */
export function wakeGateway(deps: { outOfProcess: ReadonlySet<string>; signedIn: boolean; dataDir: string; want(service: string): void; log?(line: string): void }): void {
  const why = deps.outOfProcess.has('gateway') ? gatewayNeeded(deps) : null
  if (!why) return
  ;(deps.log ?? console.log)(`[gateway] ${why}: asking for the gateway's process`)
  deps.want('gateway')
}
