/**
 * `harness browser-mcp`: the `browser` MCP server of an agent with a Browser (lib/browserMcpArgs.ts). A stdio relay, one
 * JSON-RPC message per line. It answers `initialize` and `tools/list` itself from browser-tools.json, so the agent
 * starts with its tools and nothing waits on Podman. Each call asks the pane's daemon for the browser's state and, when
 * it is ready, goes to the tool server inside the container through `podman exec`, started on first use and again after
 * it exits (a container restart ends it).
 */
import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { sendPane } from '../messages/command.js'
import { browserTools } from '../lib/browserToolsAsset.js'
import { ownProcessGroup } from '../lib/windows/noWindow.js'
import { openDaemon, whereFor, type Where } from './daemon.js'

export interface BrowserMcpChild {
  stdin: Writable
  stdout: Readable
  once(event: 'exit' | 'error', listener: () => void): unknown
}

export interface BrowserMcpDeps {
  pane?: string | undefined
  where?: (pane: string) => Where
  ask?: (type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>
  spawn?: (command: string, args: string[], options: SpawnOptions) => BrowserMcpChild
}

type Message = { id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** The state question is local and quick; a daemon this slow is named to the agent rather than waited on. */
const ASK_MS = 5_000
/** The relay's own id for the initialize it replays to each child: a string no engine's numeric ids collide with. */
const INIT_ID = 'harness-browser-mcp-initialize'

const NOT_READY: Record<string, string> = {
  setup: 'Browser is being set up',
  starting: 'Browser is starting',
  needs_setup: "Browser isn't set up",
  podman_install_failed: "Podman didn't install",
  podman_manual: 'Install Podman, then retry',
  podman_old: 'Update Podman, then retry',
  podman_memory: 'Give Podman 4 GB of memory, then retry',
  state_unreadable: "Browser data can't be read",
  podman_down: 'Podman is not running',
  image_failed: 'Browser image failed to build',
  browser_stopped: 'Browser stopped',
  profile_unwritable: "Browser can't save its login",
  proxy_failed: 'Proxy is not reachable',
  browser_limit: 'Too many browsers on this machine',
  device_failed: "Device settings didn't apply",
}

const failed = (text: string) => ({ isError: true, content: [{ type: 'text', text }] })

export function browserMcpCommand(
  io: { stdin: Readable; stdout: Writable; stderr: Writable } = process,
  deps: BrowserMcpDeps = {},
): Promise<number> {
  const pane = 'pane' in deps ? deps.pane : sendPane(process.env)
  const where = pane ? (deps.where ?? whereFor)(pane) : null
  if (!pane || !where?.harnessPane) {
    io.stderr.write('harness browser-mcp runs only as the MCP server of a Harness agent.\n')
    return Promise.resolve(1)
  }
  const ask = deps.ask ?? (async (type, payload, timeoutMs) => {
    const daemon = await openDaemon(where)
    try { return await daemon.request(type, payload, timeoutMs) } finally { daemon.close() }
  })
  const spawn = deps.spawn ?? ((command, args, options) => spawnProcess(command, args, options) as BrowserMcpChild)
  const send = (message: Record<string, unknown>) => io.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

  let initParams: Record<string, unknown> = {}
  let child: { process: BrowserMcpChild; pending: Set<Message['id']> } | null = null

  /** `connection`: Harness's own machine's, when the daemon names one; absent, the person's default. */
  const start = (podman: string, agentId: string, connection: unknown) => {
    // ownProcessGroup: `detached` would flash a console window on Windows (docs/windows-rules.md, rule 1). stderr goes
    // to the engine's MCP log, so a podman refusal ("no such container") is seen there.
    const on = typeof connection === 'string' && connection ? ['--connection', connection] : []
    const exec = spawn(podman, [...on, 'exec', '-i', `harness-browser-${agentId}`, 'node', '/opt/harness-browser/browser-tools.mjs'],
      { ...ownProcessGroup(), stdio: ['pipe', 'pipe', 'inherit'] })
    const made = { process: exec, pending: new Set<Message['id']>() }
    // A write after the child died fails here; its exit answers the calls.
    exec.stdin.on('error', () => {})
    const ended = () => {
      if (child === made) child = null
      for (const id of made.pending) send({ id, result: failed(NOT_READY.browser_stopped) })
      made.pending.clear()
    }
    exec.once('exit', ended)
    exec.once('error', ended)
    createInterface({ input: exec.stdout }).on('line', (line) => {
      let reply: Message
      try { reply = JSON.parse(line) as Message } catch { return }
      if (reply.id === INIT_ID || !made.pending.delete(reply.id)) return
      io.stdout.write(`${line}\n`)
    })
    // The tool server is a fresh MCP server each time: it gets the engine's own handshake before any call.
    const write = (message: Record<string, unknown>) => exec.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    write({ id: INIT_ID, method: 'initialize', params: initParams })
    write({ method: 'notifications/initialized' })
    return made
  }

  const callTool = async (message: Message) => {
    let state: Record<string, unknown>
    try {
      state = await ask('agent_browser_state', { pane }, ASK_MS)
    } catch (error) {
      send({ id: message.id, result: failed(error instanceof Error ? error.message : String(error)) })
      return
    }
    if (state.state !== 'ready') {
      const reason = state.state === 'failed' ? String(state.error) : String(state.state)
      send({ id: message.id, result: failed(NOT_READY[reason] ?? "Browser isn't available right now") })
      return
    }
    child ??= start(String(state.podman), String(state.agentId), state.connection)
    child.pending.add(message.id)
    // The human-input setting rides on every call, so a change in settings applies to the next one.
    child.process.stdin.write(`${JSON.stringify({ ...message, params: { ...message.params, _harness: { human: state.human } } })}\n`)
  }

  return new Promise((done) => {
    createInterface({ input: io.stdin })
      .on('line', (line) => {
        let message: Message
        try { message = JSON.parse(line) as Message } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return }
        // A notification is never answered.
        if (message.id === undefined) return
        if (message.method === 'initialize') {
          initParams = message.params ?? {}
          send({ id: message.id, result: { protocolVersion: initParams.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'browser', version: '1' } } })
        } else if (message.method === 'tools/list') send({ id: message.id, result: browserTools() })
        else if (message.method === 'ping') send({ id: message.id, result: {} })
        else if (message.method === 'tools/call') void callTool(message)
        else send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
      })
      // The engine closed the server: closing the child's stdin ends the tool server, which exits on it without
      // closing the person's Chrome.
      .on('close', () => {
        child?.process.stdin.end()
        done(0)
      })
  })
}
