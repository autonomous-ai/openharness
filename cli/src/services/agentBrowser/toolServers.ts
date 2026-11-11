/**
 * One tool server per ready browser, held by the daemon (spec: Where the tool server runs): `podman exec -i
 * harness-browser-<profile> node /opt/harness-browser/browser-tools.mjs`, started at the browser's first command or
 * window, started again after it exits, ended when the browser stops. Held here, it
 * keeps the current tab and the snapshot's refs between two `harness browser` commands, and the order of commands and
 * the person's Stop are decided in one place. One JSON-RPC message per line, and no MCP handshake: the tool server
 * answers `tools/call` and `window` only.
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export interface ToolChild {
  stdin: Writable
  stdout: Readable
  stderr?: Readable | null
  once(event: 'exit' | 'error', listener: () => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type ToolReply = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

export type ToolFailure = 'BUSY' | 'STOPPED' | 'ENDED' | 'TOOL_TIMEOUT' | 'TOOL_FAILED'

type CallResult = { reply: ToolReply } | { error: ToolFailure }
type WindowResult = { width: number; height: number } | { error: 'WINDOW_FAILED' }

/** Commands that may wait behind the running one. The page is one shared thing, so they run one at a time. */
export const MAX_WAITING = 8
/** A window the tool server has not sized by then failed (its CDP call hangs); the panel tries again at its next resize. */
export const WINDOW_MS = 5_000

// The tool server's own limits (browser-tools.mjs), which it enforces 5 s late so Playwright's clearer message wins.
// A call still running 10 s past its tool's limit is hung, and so is its tool server.
const TOOL_MS = 20_000
const OWN_MS: Record<string, number> = { browser_navigate: 60_000, browser_wait: 30_000 }
const GRACE_MS = 10_000

export function runLimitMs(tool: string): number {
  return (OWN_MS[tool] ?? TOOL_MS) + GRACE_MS
}

type Rpc = { id?: unknown; result?: unknown }

interface Child {
  process: ToolChild
  /** It answered a line. One that exits after that ended; one that never answered could not start. */
  answered: boolean
  /** It exited, or was ended or killed here: what it says or does after that is nobody's. */
  gone: boolean
  /** The lines written and not answered yet, by id. Each hears its reply, or null when the child goes first. */
  pending: Map<number, (reply: Rpc | null) => void>
}

interface Call {
  tool: string
  args: Record<string, unknown>
  human: string
  gone: AbortSignal | undefined
  done: (result: CallResult) => void
  /** Its asker went while it waited: it leaves the queue and never runs. */
  left: () => void
}

interface Server {
  child: Child | null
  running: { call: Call; timer: NodeJS.Timeout } | null
  waiting: Call[]
}

const WINDOW_FAILED = { error: 'WINDOW_FAILED' } as const

export class ToolServers {
  private readonly servers = new Map<string, Server>()
  private nextId = 1

  constructor(private readonly deps: { spawn: (agentId: string) => ToolChild; log: (line: string) => void }) {}

  /** One tool call, after those that arrived before it. `gone` aborts a call that still waits. */
  call(agentId: string, tool: string, args: Record<string, unknown>, human: string, gone?: AbortSignal): Promise<CallResult> {
    return new Promise((resolve) => {
      // An asker that went before its call arrived is answered by nobody: it never runs.
      if (gone?.aborted) return resolve({ error: 'ENDED' })
      const server = this.serverOf(agentId)
      if (server.waiting.length >= MAX_WAITING) return resolve({ error: 'BUSY' })
      const call: Call = {
        tool, args, human, gone, done: resolve,
        left: () => {
          server.waiting.splice(server.waiting.indexOf(call), 1)
          resolve({ error: 'ENDED' })
        },
      }
      gone?.addEventListener('abort', call.left, { once: true })
      server.waiting.push(call)
      this.next(agentId, server)
    })
  }

  /** Chrome's window, written at once, beside whatever call runs. */
  window(agentId: string, width: number, height: number): Promise<WindowResult> {
    return new Promise((resolve) => {
      const child = this.childOf(agentId, this.serverOf(agentId))
      if (!child) return resolve(WINDOW_FAILED)
      // Never kills the child: a window that hangs is the panel's to try again, and a command may be running.
      const timer = setTimeout(() => {
        child.pending.delete(id)
        resolve(WINDOW_FAILED)
      }, WINDOW_MS)
      const id = this.write(child, 'window', { width, height }, (reply) => {
        clearTimeout(timer)
        // An image from before has no `window` method, and answers an error.
        const size = reply?.result as { width?: unknown; height?: unknown } | undefined
        resolve(typeof size?.width === 'number' && typeof size.height === 'number' ? { width: size.width, height: size.height } : WINDOW_FAILED)
      })
    })
  }

  /** Ends the agent's tool server and answers every running and waiting call with `why`. How many it answered. */
  end(agentId: string, why: 'STOPPED' | 'ENDED'): number {
    const server = this.servers.get(agentId)
    if (!server) return 0
    this.servers.delete(agentId)
    const { running, waiting, child } = server
    server.running = null
    server.waiting = []
    if (running) {
      clearTimeout(running.timer)
      running.call.done({ error: why })
    }
    for (const call of waiting) {
      call.gone?.removeEventListener('abort', call.left)
      call.done({ error: why })
    }
    if (child) {
      // Its input closed, the tool server exits without closing the person's Chrome (browser-tools.mjs).
      child.process.stdin.end()
      this.forget(server, child)
    }
    return (running ? 1 : 0) + waiting.length
  }

  endAll(): void {
    for (const agentId of [...this.servers.keys()]) this.end(agentId, 'ENDED')
  }

  private serverOf(agentId: string): Server {
    let server = this.servers.get(agentId)
    if (!server) {
      server = { child: null, running: null, waiting: [] }
      this.servers.set(agentId, server)
    }
    return server
  }

  /** The agent's tool server, started when it has none. Null when it cannot start. */
  private childOf(agentId: string, server: Server): Child | null {
    if (server.child) return server.child
    let process: ToolChild
    try {
      process = this.deps.spawn(agentId)
    } catch {
      // The cause's words can name a path; the name is enough to act on.
      this.deps.log(`agent browser ${agentId}: its tool server did not start`)
      return null
    }
    const child: Child = { process, answered: false, gone: false, pending: new Map() }
    server.child = child
    // A write after the child died fails here; its exit answers what waits.
    process.stdin.on('error', () => {})
    // Its stderr can name an address a page went to: read, so the pipe never fills, and dropped.
    process.stderr?.resume()
    createInterface({ input: process.stdout }).on('line', line => this.heard(child, line))
    const exited = () => {
      if (child.gone) return
      this.deps.log(`agent browser ${agentId}: its tool server exited`)
      this.forget(server, child)
    }
    process.once('exit', exited)
    process.once('error', exited)
    return child
  }

  /** Starts the next waiting call when none runs. */
  private next(agentId: string, server: Server): void {
    while (!server.running) {
      const call = server.waiting.shift()
      if (!call) return
      call.gone?.removeEventListener('abort', call.left)
      const child = this.childOf(agentId, server)
      if (child) this.run(agentId, server, child, call)
      else call.done({ error: 'TOOL_FAILED' })
    }
  }

  private run(agentId: string, server: Server, child: Child, call: Call): void {
    const limit = runLimitMs(call.tool)
    const finish = (result: CallResult) => {
      if (server.running !== running) return
      clearTimeout(running.timer)
      server.running = null
      call.done(result)
      this.next(agentId, server)
    }
    const id = this.write(child, 'tools/call', { name: call.tool, arguments: call.args, _harness: { human: call.human } }, (reply) => {
      if (!reply) finish({ error: child.answered ? 'ENDED' : 'TOOL_FAILED' })
      else finish(typeof reply.result === 'object' && reply.result !== null ? { reply: reply.result as ToolReply } : { error: 'TOOL_FAILED' })
    })
    const running = {
      call,
      timer: setTimeout(() => {
        child.pending.delete(id)
        this.deps.log(`agent browser ${agentId}: ${call.tool} ran past ${limit / 1_000} s; its tool server is started again`)
        // Hung on Chrome: its input closed and the exec killed, so the next call starts a fresh tool server.
        child.process.stdin.end()
        child.process.kill()
        this.forget(server, child)
        finish({ error: 'TOOL_TIMEOUT' })
      }, limit),
    }
    server.running = running
  }

  private write(child: Child, method: string, params: Record<string, unknown>, heard: (reply: Rpc | null) => void): number {
    const id = this.nextId++
    child.pending.set(id, heard)
    child.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return id
  }

  /** A line from the child: the reply to one of its lines, or nothing anyone waits for. */
  private heard(child: Child, line: string): void {
    let reply: Rpc | null
    try {
      reply = JSON.parse(line) as Rpc | null
    } catch {
      return
    }
    const id = reply?.id as number
    const waiting = child.pending.get(id)
    if (!waiting) return
    child.pending.delete(id)
    child.answered = true
    waiting(reply)
  }

  /** The child is no longer the agent's: the next call starts another, and what waited on it hears it went. */
  private forget(server: Server, child: Child): void {
    child.gone = true
    server.child = null
    const pending = [...child.pending.values()]
    child.pending.clear()
    for (const heard of pending) heard(null)
  }
}
