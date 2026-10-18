/**
 * Shared tabs' relay (`TabRelay`, core/api.ts) asked across a process boundary, as their keys are (lib/tabKeyWire.ts):
 * Agent Messages in the edge host asks the core (`tab_relay`, core/messagesLink.ts), and the core asks the gateway,
 * which holds the sockets (`gateway_tab_relay`, gateway/gatewayProcess.ts). One call per method, `{ method, args }`,
 * answered `{ result }`, `{}`, or `{ error }` with why; the three methods are the only ones answered.
 *
 * What a side that cannot answer falls back to is `TAB_RELAY_OFF`'s: nothing opened, nothing sent (false).
 * What the relay said comes back the other way (`GatewayEvents.tabFrame`), read here as the shape it must be.
 */
import type { TabFrame, TabRelay } from '../core/api.js'

type Payload = Record<string, unknown>

export const TAB_RELAY_METHODS = ['open', 'send', 'close'] as const
export type TabRelayMethod = (typeof TAB_RELAY_METHODS)[number]

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const isRecord = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const record = (value: unknown): Payload => (isRecord(value) ? value : {})

/**
 * One call answered from `relay`. Ids are taken as strings; the frame is passed as it came, for the relay to refuse
 * what is not one (gateway/tabRelay.ts). A failure is answered `{ error }`, never thrown across the link.
 */
export async function answerTabRelay(relay: TabRelay, payload: Payload): Promise<Payload> {
  const [a, b, c] = Array.isArray(payload.args) ? payload.args as unknown[] : []
  try {
    switch (payload.method) {
      case 'open': await relay.open(text(a)); return {}
      case 'send': return { result: await relay.send(text(a), text(b), c as Payload) }
      case 'close': relay.close(text(a)); return {}
      default: return { error: 'UNKNOWN_METHOD' }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The relay as the asker holds it: each method a call. No answer, or no link at all, is nothing sent. */
export function askTabRelay(call: (payload: Payload) => Promise<Payload>): TabRelay {
  const ask = (method: TabRelayMethod, args: unknown[]): Promise<Payload> => call({ method, args }).catch((): Payload => ({}))
  return {
    open: async (sharedTabId) => { await ask('open', [sharedTabId]) },
    send: async (sharedTabId, to, payload) => (await ask('send', [sharedTabId, to, payload])).result === true,
    // Told in order with the rest, never waited on.
    close: (sharedTabId) => { void ask('close', [sharedTabId]) },
  }
}

/** What the relay said, as it came over a link: null when it names no tab, and only the parts that are what they must be. */
export function tabFrameOf(value: unknown): TabFrame | null {
  const event = record(value)
  if (typeof event.sharedTabId !== 'string' || !event.sharedTabId) return null
  const frame: TabFrame = { sharedTabId: event.sharedTabId }
  const from = record(event.from)
  if (typeof from.machineId === 'string' && typeof from.userId === 'string') frame.from = { machineId: from.machineId, userId: from.userId }
  if (isRecord(event.payload)) frame.payload = event.payload
  if (typeof event.undeliverable === 'string') frame.undeliverable = event.undeliverable
  const closed = record(event.closed)
  if (typeof closed.code === 'number') frame.closed = { code: closed.code, reason: text(closed.reason) }
  if (event.ready === true) frame.ready = true
  return frame
}
