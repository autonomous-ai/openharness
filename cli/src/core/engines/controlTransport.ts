import { readerEngine, READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { sessionBinding } from './sessionBinding.js'

export async function boundedControl<T>(work: Promise<T>, ms: number, unavailable: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), ms) })]) }
  finally { clearTimeout(timer) }
}

export interface ControlTransportDeps {
  handles(engine: string): boolean
  resolve(id: string): RegisteredSession | undefined
  call(service: string, method: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
}
interface Contract {
  version: number
  capabilities: string
  inFlight: number
  capable(reply: Record<string, unknown>, engine: ReaderEngine): boolean
  result(reply: Record<string, unknown>): void
  unavailable(): Error
  error(error: unknown): Error
  connectionChanged(service: string): void
}

/** Shared control lifetime, not engine behavior. Binding and connection never follow a replacement. */
export function createControlTransport(deps: ControlTransportDeps, contract: Contract) {
  const states = new Map(Object.values(READER_SERVICES).map(service => [service as string, { generation: 0, connected: false, capable: false, pending: 0 }]))
  const bind = (registered: RegisteredSession) => {
    const engine = registered.engine
    if (!readerEngine(engine)) return undefined
    const session = structuredClone(registered), binding = sessionBinding(registered), service = READER_SERVICES[engine]
    const isolated = deps.handles(engine), state = states.get(service)!
    const generation = state.generation + (state.connected ? 0 : 1)
    const sameSession = () => sessionBinding(deps.resolve(session.agentId)) === binding
    const current = () => sameSession() && (!isolated || (state.connected && state.generation === generation))
    const run = async <T>(ms: number, work: (allowed: () => boolean, call: (method: string, payload: Record<string, unknown>) => Promise<void>) => Promise<T>): Promise<T> => {
      if (!sameSession() || state.pending >= contract.inFlight) throw contract.unavailable()
      state.pending++
      let active = true
      const deadline = performance.now() + ms
      const allowed = () => active && performance.now() < deadline && current()
      const call = async (method: string, payload: Record<string, unknown>) => {
        const reply = await deps.call(service, method, { version: contract.version, ...payload }, Math.max(1, Math.ceil(deadline - performance.now())))
        if (!allowed()) throw contract.unavailable()
        contract.result(reply)
      }
      try {
        return await boundedControl((async () => {
          if (isolated && !state.capable) {
            // A first startup can finish this intent; a reconnect cannot resume it.
            if (state.generation !== generation && (state.connected || state.generation !== generation - 1)) throw contract.unavailable()
            const reply = await deps.call(service, contract.capabilities, { version: contract.version }, ms)
            if (!allowed() || !contract.capable(reply, engine)) throw contract.unavailable()
            state.capable = true
          }
          if (!allowed()) throw contract.unavailable()
          const value = await work(allowed, call)
          if (!allowed()) throw contract.unavailable()
          return value
        })(), ms, contract.unavailable)
      } catch (error) { throw contract.error(error) }
      finally { active = false; state.pending-- }
    }
    return { engine, service, session, isolated, run }
  }
  const connection = (service: string, connected: boolean) => {
    const state = states.get(service)
    if (state) { state.generation++; state.connected = connected; state.capable = false }
    contract.connectionChanged(service)
  }
  return { bind, connected: (service: string) => connection(service, true), disconnected: (service: string) => connection(service, false) }
}
