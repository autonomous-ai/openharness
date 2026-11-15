/**
 * The other engines' streams with their worker in this process, as a core under an older master runs them
 * (services/inline.ts): the core's side (core/engines/otherStreams.ts) over the worker's requests
 * (engines/others/streamRequests.ts), each request and answer crossing as JSON, as they cross the worker's link.
 */
import { createOtherStreams, type OtherStreamsDeps } from '../core/engines/otherStreams.js'
import { otherStreamRequests } from '../engines/others/streamRequests.js'
import { createOtherStreams as createWorkerStreams, type OtherStreamsDeps as WorkerDeps } from '../engines/others/streams.js'
import { Watcher } from '../watcher/watcher.js'

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function inProcessOtherStreams(deps: Pick<OtherStreamsDeps, 'bySession' | 'frame'> & Partial<OtherStreamsDeps>
  & { watcher?: WorkerDeps['watcher'] }) {
  const watcher = deps.watcher ?? new Watcher()
  const worker = createWorkerStreams({ watcher })
  const requests = otherStreamRequests({ streams: worker })
  const streams = createOtherStreams({ reattach: () => {}, log: () => {}, ...deps,
    call: deps.call ?? (async (type, payload) => json(await requests[type](json(payload), { owner: true, local: true }) as Record<string, unknown>)) })
  return {
    streams, worker, requests,
    stop: async (): Promise<void> => {
      streams.stop()
      worker.clear()
      if (!deps.watcher) await (watcher as Watcher).stop()
    },
  }
}
