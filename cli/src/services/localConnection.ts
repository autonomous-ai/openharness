/** Local transport for every service process; the core owns no endpoint state for a service. */
import WebSocket from 'ws'
import { daemonPipe, type LocalDaemonOptions } from '../lib/windows/daemonPipe.js'
import { pipeWebSocket, type PipeTarget } from '../lib/windows/pipeClient.js'

export function serviceConnector(
  where: { dataDir: string; port: number }, options: LocalDaemonOptions = {},
): (url: string, signal: AbortSignal) => WebSocket | Promise<WebSocket> {
  let discovering: Promise<PipeTarget | null> | null = null
  return (url, signal) => {
    signal.throwIfAborted()
    if ((options.platform ?? process.platform) !== 'win32') return new WebSocket(url)
    // An edge host has many services. Share their simultaneous process-table proof, never a cached
    // endpoint: the next connection must read the new core's record and token after a restart.
    if (!discovering) {
      discovering = Promise.resolve().then(() => (options.pipe ?? daemonPipe)(where.dataDir, where.port))
      void discovering.then(() => { discovering = null }, () => { discovering = null })
    }
    return discovering.then((target) => {
      signal.throwIfAborted()
      if (!target) throw new Error('SERVICE_ENDPOINT_UNAVAILABLE')
      return pipeWebSocket(target)
    })
  }
}
