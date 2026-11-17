/** Connection-owned streams shared by the viewer and Browser services. Payload policy stays in those processes. */
import { randomUUID } from 'node:crypto'
import { CLIENT_STREAMS, CLIENT_STREAM_CONTROL_BYTES, CLIENT_STREAM_HELD_FRAMES, CLIENT_STREAM_QUEUE_BYTES,
  clientStreamId, replyStreamId, type ClientStreamEndpoint, type ClientStreamEvent, type ClientStreamSink,
  type ClientStreamSpec, type StreamAsker, type StreamPayload } from '../lib/clientStreamContract.js'
import { clientStreamLocalFrame } from '../lib/terminalBinary.js'
import { ON_DEMAND_START_MS } from './serviceLinks.js'

interface Client {
  connection: string
  grants: Set<Grant>
  requests: Map<string, Grant>
  streams: Map<string, Grant>
  pending: number
  bytes: number
}
interface Grant {
  token: string
  client: Client
  id: string
  streamId?: string
  pending: boolean
  bytes: number
  unread: number
  incomingEnded: boolean
  outgoingEnded: boolean
  timer?: ReturnType<typeof setTimeout>
  asker: StreamAsker
}
interface Held { grant: Grant; event: ClientStreamEvent; bytes: number }
interface Service {
  spec: ClientStreamSpec
  incarnation: object | null
  ready: boolean
  seen: boolean
  unstarted: boolean
  grants: Map<string, Grant>
  clients: Map<string, Client>
  binary: Map<string, Grant>
  pending: number
  bytes: number
  held: Held[]
  heldBytes: number
  startTimer?: ReturnType<typeof setTimeout>
  warned: boolean
}

export interface ClientStreamsDeps {
  endpoint(service: string): ClientStreamEndpoint | null
  disabled(service: string): boolean
  send(service: string, connection: string, type: string, payload: StreamPayload, final: boolean): boolean
  sendBinary(service: string, connection: string, frame: Uint8Array): boolean
  wake(service: string): void
  log?(line: string): void
  specs?: readonly ClientStreamSpec[]
  startWaitMs?: number
}

export function createClientStreams(deps: ClientStreamsDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const services = new Map<string, Service>()
  const frames = new Map<string, Service>()
  const binaryKinds = new Map<number, Service>()
  const reservedPrefixes: string[] = []
  for (const spec of deps.specs ?? CLIENT_STREAMS) {
    if (services.has(spec.service) || !spec.down.includes(spec.open) || !spec.down.includes(spec.close)
      || !spec.up.includes(spec.close) || (spec.opened && !spec.up.includes(spec.opened))
      || [spec.grants, spec.perConnection, spec.pending, spec.pendingPerConnection, spec.idBytes, spec.connectionIdBytes, spec.waitMs]
        .some(value => !Number.isSafeInteger(value) || value <= 0)
      || spec.perConnection > spec.grants || spec.pending > spec.grants || spec.pendingPerConnection > spec.pending) {
      throw new Error('CLIENT_STREAM_DECLARATION')
    }
    const service: Service = { spec, incarnation: null, ready: false, seen: false, unstarted: false,
      grants: new Map(), clients: new Map(), binary: new Map(), pending: 0, bytes: 0, held: [], heldBytes: 0, warned: false }
    services.set(spec.service, service)
    if (spec.reservedPrefix) reservedPrefixes.push(spec.reservedPrefix)
    for (const type of spec.down) {
      if (frames.has(type) || !type || type.startsWith('terminal_') || type === 'message') throw new Error('CLIENT_STREAM_DECLARATION')
      frames.set(type, service)
    }
    if (spec.binary) {
      if (binaryKinds.has(spec.binary.kind) || spec.binary.kind < 8 || !Number.isSafeInteger(spec.binary.chunkBytes)
        || spec.binary.chunkBytes <= 0 || spec.binary.unreadBytes < spec.binary.chunkBytes) throw new Error('CLIENT_STREAM_DECLARATION')
      binaryKinds.set(spec.binary.kind, service)
    }
  }

  const send = (service: Service, client: Client, type: string, payload: StreamPayload): boolean =>
    deps.send(service.spec.service, client.connection, type, payload, type === service.spec.close || type === service.spec.opened && payload.streamId === undefined)
  const reject = (service: Service, connection: string, id: string, error: string): void => {
    const spec = service.spec
    deps.send(spec.service, connection, spec.opened ?? spec.close, { [spec.opened ? 'requestId' : 'streamId']: id, error }, true)
  }
  const unavailable = (service: Service): string => deps.disabled(service.spec.service)
    ? service.spec.refused.disabled : service.spec.refused.unavailable

  const discardHeld = (service: Service, grant?: Grant): void => {
    service.held = grant ? service.held.filter(each => each.grant !== grant) : []
    service.heldBytes = service.held.reduce((total, each) => total + each.bytes, 0)
    if (!service.held.length && service.startTimer) { clearTimeout(service.startTimer); service.startTimer = undefined }
  }
  const release = (service: Service, grant: Grant): boolean => {
    if (!service.grants.delete(grant.token)) return false
    if (grant.timer) clearTimeout(grant.timer)
    const client = grant.client
    client.grants.delete(grant)
    if (client.requests.get(grant.id) === grant) client.requests.delete(grant.id)
    if (grant.streamId && client.streams.get(grant.streamId) === grant) client.streams.delete(grant.streamId)
    if (grant.streamId && service.binary.get(grant.streamId) === grant) service.binary.delete(grant.streamId)
    if (grant.pending) { service.pending--; client.pending-- }
    service.bytes -= grant.bytes
    client.bytes -= grant.bytes
    if (!client.grants.size) {
      service.bytes -= Buffer.byteLength(client.connection)
      service.clients.delete(client.connection)
    }
    discardHeld(service, grant)
    return true
  }
  const live = (service: Service, grant: Grant): void => {
    if (!grant.pending) return
    grant.pending = false
    service.pending--; grant.client.pending--
    if (grant.timer) clearTimeout(grant.timer)
    grant.timer = undefined
    grant.client.requests.delete(grant.id)
  }
  const end = (service: Service, grant: Grant, reason: StreamPayload, tellService = true): void => {
    if (!release(service, grant)) return
    if (service.spec.ids === 'reply' && !grant.streamId) reject(service, grant.client.connection, grant.id, service.spec.refused.unavailable)
    else send(service, grant.client, service.spec.close, { streamId: grant.streamId!, ...reason })
    if (tellService) deps.endpoint(service.spec.service)?.refused(grant.token, grant.streamId, grant.client.connection)
  }
  const markFailedStart = (service: Service): void => {
    service.startTimer = undefined
    service.unstarted = true
    const grants = new Set(service.held.map(each => each.grant))
    discardHeld(service)
    for (const grant of grants) end(service, grant, service.spec.closed.unavailable, false)
  }
  const forward = (service: Service, grant: Grant, type: string, payload: StreamPayload): boolean => {
    const event: ClientStreamEvent = { grant: grant.token, connection: grant.client.connection, type, payload, asker: grant.asker }
    if (service.ready) return deps.endpoint(service.spec.service)?.frame(event) ?? false
    if (!service.spec.firstStart || service.seen || service.unstarted || deps.disabled(service.spec.service)) return false
    const bytes = Buffer.byteLength(JSON.stringify(payload))
    if (service.heldBytes + bytes > CLIENT_STREAM_QUEUE_BYTES || service.held.length >= CLIENT_STREAM_HELD_FRAMES) return false
    service.held.push({ grant, event, bytes }); service.heldBytes += bytes
    if (!service.startTimer) {
      deps.wake(service.spec.service)
      service.startTimer = setTimeout(() => markFailedStart(service), deps.startWaitMs ?? ON_DEMAND_START_MS)
      service.startTimer.unref?.()
    }
    return true
  }

  const allowed = (spec: ClientStreamSpec, asker: StreamAsker): boolean => asker.guest === undefined
    && (spec.audience === 'account' ? asker.local || asker.accountOwner === true : asker.owner)
  const open = (service: Service, connection: string, payload: StreamPayload, asker: StreamAsker): void => {
    const spec = service.spec, id = payload[spec.ids === 'reply' ? 'requestId' : 'streamId']
    if (spec.ids === 'reply' ? typeof id !== 'string' : !clientStreamId(id)) return
    const publicId = id as string
    if (!allowed(spec, asker)) { if (spec.refused.denied) reject(service, connection, publicId, spec.refused.denied); return }
    let client = service.clients.get(connection)
    const duplicate = spec.ids === 'reply' ? client?.requests.get(publicId) : client?.streams.get(publicId)
    if (duplicate) {
      if (spec.ids === 'client' && !forward(service, duplicate, spec.open, { ...payload, streamId: duplicate.token })) {
        end(service, duplicate, spec.closed.failedInput)
      }
      return
    }
    if (deps.disabled(spec.service) || (!service.ready && (!spec.firstStart || service.seen || service.unstarted))) {
      reject(service, connection, publicId, unavailable(service)); return
    }
    // Reserve the reply-selected UUID before asking: an answer cannot turn one reserved slot into two.
    const bytes = Buffer.byteLength(publicId) + 36 + (spec.ids === 'reply' ? 36 : 0)
    const connectionBytes = client ? 0 : Buffer.byteLength(connection)
    if (service.grants.size >= spec.grants || (client?.grants.size ?? 0) >= spec.perConnection
      || service.pending >= spec.pending || (client?.pending ?? 0) >= spec.pendingPerConnection
      || service.bytes + connectionBytes + bytes > spec.idBytes || (client?.bytes ?? connectionBytes) + bytes > spec.connectionIdBytes) {
      reject(service, connection, publicId, spec.refused.limit); return
    }
    if (!client) {
      client = { connection, grants: new Set(), requests: new Map(), streams: new Map(), pending: 0, bytes: connectionBytes }
      service.clients.set(connection, client); service.bytes += connectionBytes
    }
    const grant: Grant = { token: randomUUID(), client, id: publicId, pending: true, bytes, unread: 0,
      incomingEnded: false, outgoingEnded: false, asker }
    service.grants.set(grant.token, grant); client.grants.add(grant)
    service.pending++; client.pending++; service.bytes += bytes; client.bytes += bytes
    if (spec.ids === 'reply') {
      client.requests.set(publicId, grant)
      grant.timer = setTimeout(() => {
        log(`[streams] ${spec.service} OPEN_TIMEOUT`)
        end(service, grant, spec.closed.unavailable)
      }, spec.waitMs)
      grant.timer.unref?.()
    } else {
      grant.streamId = publicId
      client.streams.set(publicId, grant)
      if (service.ready) live(service, grant)
    }
    const field = spec.ids === 'reply' ? 'requestId' : 'streamId'
    if (!forward(service, grant, spec.open, { ...payload, [field]: grant.token })) end(service, grant, spec.closed.failedInput)
  }

  const clearService = (service: Service): void => {
    service.ready = false
    service.seen = true
    service.incarnation = null
    for (const grant of [...service.grants.values()]) end(service, grant, service.spec.closed.unavailable, false)
    discardHeld(service)
    service.warned = false
  }
  const answer = (service: Service, grant: Grant, type: string, payload: StreamPayload): boolean => {
    const spec = service.spec
    if (!spec.up.includes(type)) return false
    if (spec.opened === type) {
      if (!grant.pending || payload.requestId !== grant.token) return false
      const streamId = payload.streamId
      if (streamId !== undefined) {
        if (!replyStreamId(streamId)) { end(service, grant, spec.closed.unavailable); return false }
        const duplicate = service.binary.get(streamId)
        if (duplicate) {
          end(service, duplicate, spec.closed.unavailable)
          end(service, grant, spec.closed.unavailable)
          return false
        }
        grant.streamId = streamId
        grant.client.streams.set(streamId, grant)
        service.binary.set(streamId, grant)
      }
      live(service, grant)
      const sent = send(service, grant.client, type, { ...payload, requestId: grant.id })
      if (!streamId) release(service, grant)
      else if (!sent) end(service, grant, spec.closed.failedOutput)
      return sent
    }
    if (spec.ids === 'reply' && (type !== spec.close || payload.streamId !== grant.streamId)) return false
    if (spec.ids === 'client' && payload.streamId !== grant.token) return false
    const translated = spec.ids === 'client' ? { ...payload, streamId: grant.id } : payload
    if (type === spec.close) release(service, grant)
    else if (type === spec.end) grant.outgoingEnded = true
    const sent = send(service, grant.client, type, translated)
    if (type !== spec.close) {
      if (!sent) end(service, grant, spec.closed.failedOutput)
      else if (grant.incomingEnded && grant.outgoingEnded) release(service, grant)
    }
    return sent
  }

  return {
    handles(type: string): boolean { return frames.has(type) || reservedPrefixes.some(prefix => type.startsWith(prefix)) },
    frame(connection: string, type: string, payload: StreamPayload, asker: StreamAsker): boolean {
      const service = frames.get(type)
      if (!service) return reservedPrefixes.some(prefix => type.startsWith(prefix))
      const spec = service.spec
      if (type === spec.open) { open(service, connection, payload, asker); return true }
      if (spec.ids === 'client' && !allowed(spec, asker)) return true
      const id = payload.streamId
      const grant = typeof id === 'string' ? service.clients.get(connection)?.streams.get(id) : undefined
      if (!grant) {
        if (spec.ids === 'client' && type !== spec.close && clientStreamId(id) && !service.ready) reject(service, connection, id, unavailable(service))
        return true
      }
      if (type === spec.ack && typeof payload.bytes === 'number' && Number.isFinite(payload.bytes) && payload.bytes > 0) {
        grant.unread = Math.max(0, grant.unread - payload.bytes)
      }
      if (type === spec.end) grant.incomingEnded = true
      const translated = spec.ids === 'client' ? { ...payload, streamId: grant.token } : payload
      if (!forward(service, grant, type, translated)) end(service, grant, spec.closed.failedInput)
      else if (spec.ids === 'client' && (type === spec.close || grant.incomingEnded && grant.outgoingEnded)) release(service, grant)
      return true
    },
    binary(connection: string, framed: Uint8Array): boolean {
      const read = clientStreamLocalFrame(framed)
      if (!read) return false
      const service = binaryKinds.get(read.kind)
      if (!service) return false
      const grant = service.binary.get(read.streamId)
      if (grant?.client.connection === connection && (!service.ready || !deps.endpoint(service.spec.service)?.binary(framed))) {
        end(service, grant, service.spec.closed.failedInput)
      }
      return true
    },
    closed(connection?: string): void {
      for (const service of services.values()) {
        const grants = connection === undefined ? [...service.grants.values()] : [...service.clients.get(connection)?.grants ?? []]
        for (const grant of grants) release(service, grant)
        deps.endpoint(service.spec.service)?.closed(connection)
      }
    },
    connected(name: string): ClientStreamSink | null {
      const service = services.get(name)
      if (!service) return null
      // Initial held requests belong to this first connection. A replacement revokes everything from its predecessor.
      if (service.incarnation || service.seen) clearService(service)
      const incarnation = service.incarnation = {}
      service.unstarted = false
      service.warned = false
      return {
        frame: (token, type, payload) => {
          if (service.incarnation !== incarnation || !service.ready) return false
          const grant = service.grants.get(token)
          if (!grant) {
            if (type === service.spec.opened && replyStreamId(payload.streamId) && !service.binary.has(payload.streamId)) deps.endpoint(name)?.refused(token, payload.streamId)
            return false
          }
          return answer(service, grant, type, payload)
        },
        binary: framed => {
          if (service.incarnation !== incarnation || !service.ready) return false
          const read = clientStreamLocalFrame(framed)
          if (!read || read.kind !== service.spec.binary?.kind || read.compressed || read.bytes.length > service.spec.binary.chunkBytes) {
            if (!service.warned) log(`[streams] ${name} INVALID_BINARY ${framed.length} bytes`)
            service.warned = true
            return false
          }
          const grant = service.binary.get(read.streamId)
          if (!grant) return false
          if (grant.unread + read.bytes.length > service.spec.binary.unreadBytes
            || !deps.sendBinary(name, grant.client.connection, framed)) {
            end(service, grant, service.spec.closed.failedOutput); return false
          }
          grant.unread += read.bytes.length
          return true
        },
      }
    },
    serving(name: string): boolean {
      const service = services.get(name)
      if (!service?.incarnation) return false
      service.ready = true
      service.seen = true
      const held = service.held
      discardHeld(service)
      for (const each of held) {
        if (!service.grants.has(each.grant.token)) continue
        live(service, each.grant)
        if (!deps.endpoint(name)?.frame(each.event)) end(service, each.grant, service.spec.closed.failedInput)
      }
      return true
    },
    disconnected(name: string): void { const service = services.get(name); if (service) clearService(service) },
    control(source: string, name: string, token: string | null, payload: StreamPayload): void {
      const service = services.get(name)
      if (source !== 'gateway' || !service?.ready || JSON.stringify(payload).length > CLIENT_STREAM_CONTROL_BYTES) return
      if (token !== null && !service.grants.has(token)) return
      deps.endpoint(name)?.control(token, payload)
    },
    /** A trusted transport knows a public binary ID, never a private grant. */
    controlStream(source: string, streamId: string, payload: StreamPayload): void {
      if (source !== 'gateway' || JSON.stringify(payload).length > CLIENT_STREAM_CONTROL_BYTES) return
      for (const service of services.values()) {
        const grant = service.binary.get(streamId)
        if (service.ready && grant) deps.endpoint(service.spec.service)?.control(grant.token, payload)
      }
    },
  }
}

export type ClientStreams = ReturnType<typeof createClientStreams>
