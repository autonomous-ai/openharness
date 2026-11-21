/** The edge host's startup detector speaks to its master only; no core socket or credential is read. */
import { env } from '../config/env.js'
import { isMasterMessage, type CoreMessage } from '../harnessd/protocol.js'
import { harnessdEnv } from '../lib/harnessdEnv.js'
import type { ServiceProcessOptions } from '../serviceProcess.js'
import type { ServiceProcess } from './process.js'
import { createComponentStartup, type ComponentStartupOptions } from './componentStartup.js'

interface StartupChannel {
  send?: (message: CoreMessage, done: (error?: Error | null) => void) => unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
}
export interface ComponentStartupDeps {
  channel?: StartupChannel
  start?: typeof createComponentStartup
  log?(line: string): void
  runtimeDir?: string
  cableDisabled?: boolean
  testDialPort?: string
}
const HANDSHAKE_MS = 10_000

export function runComponentStartupService(options: ServiceProcessOptions, deps: ComponentStartupDeps = {}): ServiceProcess {
  const channel = deps.channel ?? process
  const log = deps.log ?? console.warn
  const start = deps.start ?? createComponentStartup
  let active: ReturnType<typeof createComponentStartup> | undefined
  let stopped = false
  let initialized = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timeout !== undefined) clearTimeout(timeout)
    timeout = undefined
    active?.stop()
    channel.removeListener('message', hear)
  }
  const failed = (): void => { if (!stopped) { log('[startup] STARTUP_UNAVAILABLE'); stop() } }
  const send = (message: CoreMessage): void => {
    if (stopped) return
    try { if (channel.send) channel.send(message, error => { if (error) failed() }); else failed() } catch { failed() }
  }
  const hear = (message: unknown): void => {
    if (stopped || !isMasterMessage(message)) return
    if (message.type === 'harnessd:shutdown') { stop(); return }
    if (message.type === 'harnessd:peer-started') { active?.started(message.service); return }
    if (message.type !== 'harnessd:peers' || initialized) return
    initialized = true
    // The first snapshot always owns the timer installed before subscribing; stop already fences late messages.
    clearTimeout(timeout)
    timeout = undefined
    const config: ComponentStartupOptions = {
      dataDir: options.dataDir, runtimeDir: deps.runtimeDir ?? env.ADAPTER_RUNTIME_DIR,
      available: new Set(message.available), started: new Set(message.started),
      want: service => send({ type: 'harnessd:want', service }),
      cableDisabled: deps.cableDisabled ?? env.CABLE_DISABLE,
      testDialPort: deps.testDialPort ?? harnessdEnv().HARNESSD_TEST_DIAL_PORT,
      log,
    }
    try { active = start(config); if (stopped) active.stop() } catch { failed() }
  }
  // A snapshot emitted before this listener existed could be lost. Subscribe once, after installation.
  channel.on('message', hear)
  timeout = setTimeout(failed, HANDSHAKE_MS).unref()
  send({ type: 'harnessd:watch-peers' })
  return { stop }
}
