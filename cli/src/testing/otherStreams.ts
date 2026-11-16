/** The other engines' streams, for a spec of the core that follows none of their sessions (core/engines/otherStreams.ts). */
import type { OtherStreams } from '../core/engines/otherStreams.js'

export function noOtherStreams(): OtherStreams {
  return {
    unavailable: () => {},
    locateStore: async () => ({ store: null }),
    open: async () => null, get: () => undefined, has: () => false, ready: () => false, close: async () => [], closeIf: async () => false, drain: async () => {}, drainAll: async () => {},
    tail: async () => {}, openTurn: async () => [], task: () => {}, paneRead: () => false, paneDue: () => true, release: () => {},
    forget: () => {}, connected: () => {}, disconnected: () => {}, stop: () => {},
  }
}
