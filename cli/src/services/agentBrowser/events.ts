/**
 * One `podman events` stream per daemon tells the service when one of its browsers exits, so nothing polls (spec §
 * Lifecycle, Health). Measured on Podman 5.8.1: one JSON object per line, an exit is `"Status":"died"` with the
 * container's labels under `Attributes`, and every `podman exec` adds `exec` and `exec_died`, hundreds a minute while
 * a viewer is open, so the stream asks for `died` alone and anything else is ignored.
 */
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Podman } from './podman.js'

const FIRST_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
// A stream that stayed up this long was healthy: its drop starts the backoff over.
const HEALTHY_MS = 30_000
// About two minutes of tries, then none until Podman answers a browser start (wake). Unbounded, a stopped Podman
// machine had an idle daemon spawn `podman events`, a failing `podman ps` and a log line every 30 s (review, 2026-11-10).
const MAX_RETRIES = 8

function exitedAgent(line: string, daemonId: string): string | null {
  let event: { Status?: unknown; Type?: unknown; Attributes?: Record<string, unknown> }
  try {
    event = JSON.parse(line) as typeof event
  } catch {
    return null
  }
  if (event.Status !== 'died' || event.Type !== 'container' || event.Attributes?.['harness.daemon'] !== daemonId) return null
  const agentId = event.Attributes['harness.agent']
  return typeof agentId === 'string' ? agentId : null
}

export function watchEvents(
  podman: Podman,
  daemonId: string,
  on: { exited: (agentId: string) => void; reconnected: () => void; log: (line: string) => void },
): { close(): void; wake(): void } {
  const args = ['events', '--format', 'json', '--filter', 'event=died', '--filter', `label=harness.daemon=${daemonId}`]
  let child: ChildProcess | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let live = false
  let delay = FIRST_DELAY_MS
  let retries = 0

  const connect = (again: boolean) => {
    timer = null
    live = true
    const startedAt = Date.now()
    let ended = false
    const dropped = () => {
      if (ended || closed) return
      ended = true
      live = false
      if (Date.now() - startedAt >= HEALTHY_MS) {
        delay = FIRST_DELAY_MS
        retries = 0
      }
      // Said when the stream goes down and when it gives up, never once per try.
      if (retries === 0) on.log('agent browser: the event stream dropped; reconnecting with backoff')
      if (retries >= MAX_RETRIES) {
        on.log(`agent browser: the event stream failed ${MAX_RETRIES} times in a row; it waits for Podman to answer a browser start`)
        return
      }
      retries += 1
      timer = setTimeout(() => connect(true), delay)
      delay = Math.min(delay * 2, MAX_DELAY_MS)
    }
    try {
      child = podman.spawn(args)
    } catch {
      dropped()
      return
    }
    child.on('error', dropped)
    child.on('close', dropped)
    child.stderr?.resume()
    createInterface({ input: child.stdout! }).on('line', line => {
      const agentId = exitedAgent(line, daemonId)
      if (agentId) on.exited(agentId)
    })
    // Exits while the stream was down are not replayed: the service looks once at what runs.
    if (again) on.reconnected()
  }

  connect(false)
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      child?.kill()
    },
    /** Podman just answered: a stream that gave up, or waits out its backoff, connects now with the backoff reset. */
    wake() {
      if (closed || live) return
      if (timer) clearTimeout(timer)
      delay = FIRST_DELAY_MS
      retries = 0
      connect(true)
    },
  }
}
