/** The service side of the shared relay. Public IDs are restored by core, never by a service choosing a recipient. */
import { clientStreamId, replyStreamId, type ClientStreamEndpoint, type ClientStreamEvent, type ClientStreamSpec,
  type StreamPayload } from '../lib/clientStreamContract.js'
import type { CoreConnection } from './process.js'

interface Held {
  connection: string
  streamId?: string
  incomingEnded: boolean
  outgoingEnded: boolean
}

export function createServiceClientStreams(spec: ClientStreamSpec, endpoint: () => ClientStreamEndpoint | null) {
  let core: CoreConnection | null = null
  const grants = new Map<string, Held>()
  const streams = new Map<string, string>()
  const release = (grant: string): void => {
    const held = grants.get(grant)
    if (held?.streamId && streams.get(held.streamId) === grant) streams.delete(held.streamId)
    grants.delete(grant)
  }
  const close = (connection?: string): void => {
    endpoint()?.closed(connection)
    for (const [grant, held] of grants) if (connection === undefined || held.connection === connection) release(grant)
  }
  const frame = (connection: string, type: string, payload: StreamPayload): boolean => {
    const id = spec.opened === type ? payload.requestId : payload.streamId
    const grant = typeof id === 'string' ? spec.ids === 'reply' && type !== spec.opened ? streams.get(id) : id : undefined
    const held = grant ? grants.get(grant) : undefined
    if (!core?.notice || !grant || !held || held.connection !== connection || !spec.up.includes(type)) {
      if (type === spec.opened && replyStreamId(payload.streamId)) endpoint()?.refused(typeof id === 'string' ? id : '', payload.streamId)
      return false
    }
    if (type === spec.opened && replyStreamId(payload.streamId)) { held.streamId = payload.streamId; streams.set(payload.streamId, grant) }
    core.notice('client_stream', { grant, type, payload })
    if (type === spec.end) held.outgoingEnded = true
    if (type === spec.close || held.incomingEnded && held.outgoingEnded || type === spec.opened && !held.streamId) release(grant)
    return true
  }
  return {
    frame,
    bytes: (framed: Uint8Array): boolean => core?.sendBinary?.(framed) ?? false,
    event(payload: StreamPayload): boolean {
      if (payload.kind === 'client_stream') {
        const { grant, connection, type, asker } = payload
        if (!clientStreamId(grant) || typeof connection !== 'string' || typeof type !== 'string' || !spec.down.includes(type)
          || !asker || typeof asker !== 'object' || typeof (asker as { local?: unknown }).local !== 'boolean'
          || typeof (asker as { owner?: unknown }).owner !== 'boolean') return true
        const raw = payload.payload
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true
        let held = grants.get(grant)
        if (type === spec.open) {
          if (!held) {
            if (grants.size >= spec.grants) return true
            held = { connection, incomingEnded: false, outgoingEnded: false }
            grants.set(grant, held)
          }
        } else if (!held || held.connection !== connection) return true
        if (held!.connection !== connection) return true
        if (type === spec.end) held!.incomingEnded = true
        const event: ClientStreamEvent = { grant, connection, type, payload: raw as StreamPayload, asker: asker as ClientStreamEvent['asker'] }
        if (!endpoint()?.frame(event)) {
          frame(connection, spec.opened ?? spec.close, { [spec.opened ? 'requestId' : 'streamId']: grant, error: spec.refused.unavailable })
          release(grant)
        } else if (spec.ids === 'client' && (type === spec.close || held!.incomingEnded && held!.outgoingEnded)) release(grant)
        return true
      }
      if (payload.kind === 'client_stream_refused') {
        if (!clientStreamId(payload.grant)) return true
        const grant = payload.grant
        const held = grants.get(grant)
        const id = replyStreamId(payload.streamId) ? payload.streamId : held?.streamId
        endpoint()?.refused(grant, id, held?.connection)
        release(grant)
        return true
      }
      if (payload.kind === 'client_stream_control') {
        const grant = payload.grant
        if (grant !== null && (typeof grant !== 'string' || !grants.has(grant))) return true
        const control = payload.payload
        if (control && typeof control === 'object' && !Array.isArray(control)) endpoint()?.control(grant as string | null, control as StreamPayload)
        return true
      }
      if (payload.kind === 'client_stream_closed') {
        if (payload.connection === undefined || typeof payload.connection === 'string') close(payload.connection)
        return true
      }
      return false
    },
    binary: (framed: Uint8Array): boolean => endpoint()?.binary(framed) ?? false,
    closed: close,
    connected(connection: CoreConnection): void {
      if (core && core !== connection) close()
      core = connection
      void connection.query('client_streams', {}).then(answer => {
        if (core === connection && answer.ok !== true) console.warn(`[streams] ${spec.service} UNAVAILABLE`)
      }, () => { if (core === connection) console.warn(`[streams] ${spec.service} UNAVAILABLE`) })
    },
    disconnected(): void { if (core) { core = null; close() } },
  }
}
