import type { NativeStopHost } from '../facets/nativeControl.js'
import { nativeEnvelope, type NativeStopAction } from './nativeControlProtocol.js'

/** The person's message when core could not be asked: the stop is not confirmed, so the pane stays. */
export const NATIVE_UNCONFIRMED = 'Could not confirm the conversation stopped on its engine\'s server; its pane remains open'

/** A stop's questions to core, one at a time, each answered yes or no; anything else ends the stop. */
export function createNativeStopHost(ask: (action: NativeStopAction) => Promise<Record<string, unknown>>): NativeStopHost {
  const call = async (action: NativeStopAction) => {
    const reply = await ask(action)
    if (!nativeEnvelope(reply, ['value', 'error']) || reply.error !== undefined || typeof reply.value !== 'boolean') throw new Error(NATIVE_UNCONFIRMED)
    return reply.value
  }
  return { current: () => call({ kind: 'current' }), pending: () => call({ kind: 'pending' }), settled: () => call({ kind: 'settled' }) }
}
