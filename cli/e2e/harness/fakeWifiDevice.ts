/**
 * A Wi-Fi device, as the daemon sees one: an identity paired with the machine under the device role,
 * reaching it through the (fake) relay over an end-to-end encrypted session (harness/relayPhone.ts, with
 * the CLI's own client crypto), and speaking the device protocol (docs/autonomous-device-integration.md):
 * a request sealed as `autonomous_device_request`, its answer `autonomous_device_result`, the machine's
 * events `autonomous_device_event`.
 *
 * What the device's own OS does with them it does here the documented way, and no more: an application
 * hello first, and after a `resync` it asks again what it needs (its agents, its receipts by idempotency
 * key). Everything it heard is kept, in order, so a test can say what it was told and when.
 */
import type { FakeBackend } from './fakeBackend.js'
import { RelayPhone, type PhoneFrame } from './relayPhone.js'
import type { Identity } from '../../src/lib/e2ee/core.js'

export type DeviceEvent = Record<string, any> & { type: string }

export class FakeWifiDevice {
  readonly link: RelayPhone

  constructor(options: { backend: FakeBackend; machineId: string; identity: Identity; machinePub: Uint8Array; token: string }) {
    this.link = new RelayPhone(options)
  }

  /** Open its session with the machine through the relay. */
  open(ms = 30_000): Promise<void> {
    return this.link.open(ms)
  }

  /** A request and its answer (`<type>_result`), as the device's OS asks it. */
  async ask(type: string, fields: Record<string, unknown> = {}, ms = 30_000): Promise<Record<string, any>> {
    // Sealed, as its firmware seals every request: the machine refuses one in the clear.
    return this.link.request('autonomous_device_request', { type, ...fields }, ms, true)
  }

  /** The application hello every session starts with. */
  hello(resume?: { serverInstanceId: string; cursor: number }): Promise<Record<string, any>> {
    return this.ask('hello', { proto: 1, ...(resume ? { resume } : {}) })
  }

  /** Every event the machine sent it, in order. */
  events(since = 0): DeviceEvent[] {
    return this.link.frames.slice(since).filter((frame) => frame.type === 'autonomous_device_event').map((frame) => frame.payload as DeviceEvent)
  }

  /** How far it has heard: pass to `nextEvent` or `events` to look only after this point. */
  mark(): number {
    return this.link.frames.length
  }

  /** The first event, from `since` on, that passes `test`. */
  async nextEvent(test: (event: DeviceEvent) => boolean, what: string, since = this.mark(), ms = 45_000): Promise<DeviceEvent> {
    const frame = await this.link.waitFor((f: PhoneFrame) => f.type === 'autonomous_device_event' && test(f.payload as DeviceEvent), ms, what, since)
    return frame.payload as DeviceEvent
  }

  close(): void {
    this.link.close()
  }
}
