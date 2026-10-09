/** Bounded observation admission also applies to the inline/debug service. A hung read occupies a slot. */
import { externalSessionAnswer, externalUnavailable, type ExternalSessionRequest, type ExternalSessionAnswer } from '../../lib/externalSessionWire.js'

export function createExternalInspector(deps: {
  call(request: ExternalSessionRequest): Promise<ExternalSessionAnswer>
  generation(): unknown
  timeoutMs?: number
}) {
  let generation = deps.generation()
  let active = new Set<symbol>()
  return async (request: ExternalSessionRequest): Promise<ExternalSessionAnswer> => {
    const epoch = deps.generation()
    if (epoch !== generation) { generation = epoch; active = new Set() }
    if (active.size >= 4) return externalUnavailable('Waiting for the search service to finish verifying conversations.')
    const token = Symbol(), slots = active
    slots.add(token)
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = Promise.resolve().then(() => deps.call(request)).then(answer =>
      deps.generation() === epoch ? externalSessionAnswer(answer, request) : externalUnavailable(), () => externalUnavailable())
      .finally(() => slots.delete(token))
    try {
      return await Promise.race([read, new Promise<ExternalSessionAnswer>(resolve => {
        timer = setTimeout(() => resolve(externalUnavailable()), deps.timeoutMs ?? 5_000); timer.unref()
      })])
    } finally { clearTimeout(timer) }
  }
}
