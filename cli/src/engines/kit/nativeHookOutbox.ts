/** The short-lived native client retains bytes before sending them. Core may
 * retry those bytes later, but this log never grants authority for a new effect. */
import { createHash } from 'node:crypto'
import { createNativeHookOutboxLog, NativeHookJournalHeld, type NativeHookDelivery, type NativeHookIntake, type NativeHookPhase } from './nativeHookJournal.js'
import { inspectNativeHookOrigin } from './nativeHookOrigin.js'

export const NATIVE_HOOK_OUTBOX_SHARDS = 16
const NAMESPACE = 'native-hook-client:v1'
const idPattern = /^[a-zA-Z0-9_-]{16,96}$/
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const held = (reason: string): never => { throw new NativeHookJournalHeld(reason) }
type Endpoint = '/api/hook/session-start' | '/api/hook/turn-stop' | '/api/hook/session-end' | '/api/hook/turn-start' | '/api/hook/tool-start'
export interface NativeHookClientInput {
  id: string
  firedAt: number
  port: number
  phases: readonly { name: NativeHookPhase; path: Endpoint; body: Record<string, unknown> }[]
}
export interface NativeHookClientDelivery {
  readonly id: string
  readonly fingerprint: string
  readonly firedAt: number
  readonly port: number
  readonly phases: readonly { readonly name: NativeHookPhase; readonly path: Endpoint; readonly body: string; readonly acknowledged: boolean }[]
  verify(): void
}
interface Payload { version: 1; port: number; phases: { name: NativeHookPhase; path: Endpoint; bodyBase64: string }[] }
const paths: Record<NativeHookPhase, readonly Endpoint[]> = {
  registration: ['/api/hook/session-start'], stop: ['/api/hook/turn-stop'],
  event: ['/api/hook/session-end', '/api/hook/turn-start', '/api/hook/tool-start'],
}

/** Placement depends only on the immutable client namespace and ID. Changing
 * the route, body or origin must meet the original record and conflict. */
export function nativeHookOutboxShard(id: string): number {
  if (typeof id !== 'string' || !idPattern.test(id)) held('invalid native client delivery ID')
  return Number.parseInt(hash(`${NAMESPACE}\u0000${id}`).slice(0, 8), 16) % NATIVE_HOOK_OUTBOX_SHARDS
}
const fingerprint = (id: string, firedAt: number, payload: Payload) => hash(JSON.stringify([NAMESPACE, id, firedAt, payload]))
function wireBody(phase: Payload['phases'][number]): string {
  if (typeof phase.bodyBase64 !== 'string' || phase.bodyBase64.length > 4 * Math.ceil(256 * 1024 / 3)) held('invalid native client body encoding')
  const bytes = Buffer.from(phase.bodyBase64, 'base64')
  if (bytes.length > 256 * 1024 || bytes.toString('base64') !== phase.bodyBase64) held('invalid native client body encoding')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function validate(id: string, firedAt: unknown, payload: Payload): void {
  nativeHookOutboxShard(id)
  if (!Number.isSafeInteger(firedAt) || Number(firedAt) <= 0 || !payload || payload.version !== 1
    || !Number.isSafeInteger(payload.port) || payload.port < 1 || payload.port > 65535
    || !Array.isArray(payload.phases) || !(payload.phases.length === 1 || payload.phases.length === 2
      && payload.phases[0].name === 'registration' && payload.phases[1].name === 'stop')) held('invalid native client delivery')
  let origin: string | undefined
  for (const phase of payload.phases) {
    if (!phase || !Object.hasOwn(paths, phase.name) || !paths[phase.name].includes(phase.path)) held('invalid native client phase')
    const body = JSON.parse(wireBody(phase)) as Record<string, unknown>
    if (!body || typeof body !== 'object' || Array.isArray(body)) held('invalid native client body')
    const original = inspectNativeHookOrigin(body.nativeOrigin)
    if (body.callerPid !== original.callerPid) held('native client caller changed')
    const serialized = JSON.stringify(original)
    if (origin !== undefined && origin !== serialized) held('linked native phases have different origins')
    origin = serialized
  }
}

function retained(delivery: NativeHookDelivery): NativeHookClientDelivery {
  const intake = delivery.intake, payload = intake.payload as unknown as Payload
  validate(intake.id, intake.firedAt, payload)
  if (intake.agentId !== NAMESPACE || intake.conversationId !== '' || intake.owner !== undefined
    || JSON.stringify(intake.phases) !== JSON.stringify(payload.phases.map(phase => phase.name))
    || intake.fingerprint !== fingerprint(intake.id, intake.firedAt!, payload)) held('retained native client delivery changed')
  return Object.freeze({ id: intake.id, fingerprint: intake.fingerprint, firedAt: intake.firedAt!, port: payload.port,
    phases: Object.freeze(payload.phases.map(phase => Object.freeze({ name: phase.name, path: phase.path,
      body: wireBody(phase), acknowledged: delivery.acknowledgements!.has(phase.name) }))),
    verify: delivery.verify })
}

/** Each shard has a complete bounded chain. The enclosing catalog must seal its
 * location and allocate its quota before exposing this factory to clients. */
export function createNativeHookOutbox({ shard, ...options }: Omit<Parameters<typeof createNativeHookOutboxLog>[0], 'processKey'> & { shard: number }) {
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= NATIVE_HOOK_OUTBOX_SHARDS) held('invalid native client shard')
  const log = createNativeHookOutboxLog({ maxBytes: 8 * 1024 * 1024, ...options, processKey: `${NAMESPACE}:shard:${shard}` })
  const checkShard = (id: string) => { if (nativeHookOutboxShard(id) !== shard) held('native client delivery belongs to another shard') }
  return {
    async retain(input: NativeHookClientInput): Promise<NativeHookClientDelivery> {
      // Serialize synchronously, before the first await. No retry can send a
      // caller's later edits, change the original time, or pick a new origin.
      const payload: Payload = { version: 1, port: input.port,
        phases: input.phases.map(phase => ({ name: phase.name, path: phase.path, bodyBase64: Buffer.from(JSON.stringify(phase.body)).toString('base64') })) }
      const { id, firedAt } = input
      checkShard(id); validate(id, firedAt, payload)
      const intake: NativeHookIntake = { id, firedAt, fingerprint: fingerprint(id, firedAt, payload), agentId: NAMESPACE,
        conversationId: '', phases: payload.phases.map(phase => phase.name), payload: payload as unknown as Record<string, unknown> }
      return retained(await log.retain(intake))
    },
    async snapshot() {
      const snapshot = await log.snapshot()
      // An ACK observed after a writer crash may precede its directory sync.
      // Expose ownership facts only after confirming the complete retained tail.
      await snapshot.confirm(); snapshot.verify()
      const deliveries = new Map<string, NativeHookClientDelivery>()
      for (const [id, delivery] of snapshot.deliveries) { checkShard(id); deliveries.set(id, retained(delivery)) }
      return { deliveries, verify: snapshot.verify, confirm: snapshot.confirm }
    },
    /** Call only after the protocol confirms durable server ownership. Pending
     * retry/held/uncertain transport outcomes do not acknowledge a phase. This
     * fact transfers responsibility; it never authorizes client task deletion. */
    async acknowledge(delivery: NativeHookClientDelivery, phase: NativeHookPhase): Promise<void> {
      const { id, fingerprint: original } = delivery
      checkShard(id)
      await log.acknowledge(id, original, phase)
    },
    close: log.close,
  }
}
