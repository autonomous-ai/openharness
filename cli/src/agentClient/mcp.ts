/**
 * `harness mcp`: the agent verbs as an MCP server on stdin and stdout (docs/design/2026-10-11-agent-client.md), for
 * agents that reach their tools through MCP rather than a shell: Claude Desktop, Cursor, Windsurf, and Claude Code or
 * Codex with the Harness plugin. One server is one agent's session.
 *
 * Each call runs the verb as `harness` itself, in a process of its own with this server's environment, so what an
 * agent may do is decided where it is for the shell's verbs (`agentOrigin`, `close`), and the answer is the text the
 * verb prints. The server tells the verbs whose session it is when the agent's own environment does not
 * (`outsideCaller`): one caller per server, never the person.
 *
 * Newline-delimited JSON-RPC 2.0, as MCP's stdio transport is. Nothing but protocol goes to stdout.
 */
import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { VERSION } from '../version.js'
import { AGENT_SESSION_ENV } from './model.js'
import { EXIT } from './commands.js'

/** Newest first: the client's own when it is one of these, else the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** What an agent is told once, as it connects: when Harness is the right tool, and whose harnesses are whose. */
export const INSTRUCTIONS = `Harness runs coding agents (Claude Code, Codex) in sessions of their own, on this computer or the person's other machines. The person can watch and join every one in the Harness app.

Start a harness (harness_start) for work that can run beside yours, needs another agent's view (a review, a second opinion from Codex), takes long, or belongs in its own folder. Do small, quick work yourself.

List first (harness_list). Send follow-ups for the same work to the harness you started for it, not a new one. Never give work to, or close, a harness you did not start: those are the person's.

Name every harness. Then wait for it (harness_wait), read its answer (harness_read), and close it when you are done (harness_close). Never ask a harness to publish, deploy, delete or push.`

/** How long `harness_wait` waits when not told: within what MCP clients allow a call. */
const WAIT_DEFAULT_S = 120
const WAIT_MAX_S = 600

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  /** The `harness` words for these arguments. */
  argv: (args: Record<string, unknown>, cwd: string) => string[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const TOOLS: Tool[] = [
  {
    name: 'harness_list',
    description: 'The harnesses on this machine: name, agent, state (working, idle, needs-input), who started each ("you" for yours), when it was last active, its folder, and what it is about.',
    inputSchema: schema({ all: { type: 'boolean', description: 'Also the ones stopped in the last week.' } }),
    annotations: { readOnlyHint: true },
    argv: (a) => ['ps', ...(a.all === true ? ['--all'] : [])],
  },
  {
    name: 'harness_start',
    description: 'Start a new harness: an agent in a session of its own, working on [task] in [folder]. Returns at once; wait for it with harness_wait and read its answer with harness_read.',
    inputSchema: schema({
      task: { type: 'string', description: 'The whole task, as you would write it to a colleague: what to do, where, and what to answer with.' },
      folder: { type: 'string', description: 'The folder to work in: an absolute path, or one relative to where this server runs.' },
      name: { type: 'string', description: 'A short name to call it by (e.g. "reviewer"). Always give one.' },
      agent: { type: 'string', enum: ['claude', 'codex'], description: 'Claude Code (default) or Codex.' },
      machine: { type: 'string', description: 'Another of the person\'s machines, by name, to run it there.' },
    }, ['task', 'folder', 'name']),
    argv: (a, cwd) => {
      const folder = str(a.folder)
      return ['new', str(a.agent) || 'claude', ...(str(a.machine) ? [`@${str(a.machine)}`] : []), isAbsolute(folder) || folder.startsWith('~') ? folder : resolve(cwd, folder || '.'),
        '--name', str(a.name), '--task', typeof a.task === 'string' ? a.task : '']
    },
  },
  {
    name: 'harness_wait',
    description: `Wait until harnesses stop working, then say each one's state. Waits up to timeout_seconds (${WAIT_DEFAULT_S} by default); if they are still working then, call it again.`,
    inputSchema: schema({
      names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The harnesses to wait for.' },
      any: { type: 'boolean', description: 'Return when the first one is done, not all.' },
      timeout_seconds: { type: 'number', minimum: 1, maximum: WAIT_MAX_S },
    }, ['names']),
    annotations: { readOnlyHint: true },
    argv: (a) => {
      const names = Array.isArray(a.names) ? a.names.map(str).filter(Boolean) : []
      const seconds = typeof a.timeout_seconds === 'number' && a.timeout_seconds > 0 ? Math.min(Math.ceil(a.timeout_seconds), WAIT_MAX_S) : WAIT_DEFAULT_S
      return ['wait', names.join(','), ...(a.any === true ? ['--any'] : []), '--timeout', `${seconds}s`]
    },
  },
  {
    name: 'harness_read',
    description: 'A harness\'s state and its last turn: what it was asked and what it answered.',
    inputSchema: schema({ name: { type: 'string' }, chars: { type: 'number', minimum: 1, description: 'How much of the answer (4000 characters by default).' } }, ['name']),
    annotations: { readOnlyHint: true },
    argv: (a) => ['show', str(a.name), ...(typeof a.chars === 'number' && a.chars > 0 ? ['--chars', String(Math.floor(a.chars))] : [])],
  },
  {
    name: 'harness_send',
    description: 'Send a message to a harness you started, while it works: a follow-up, a correction, more context.',
    inputSchema: schema({ to: { type: 'string', description: 'The harness\'s name.' }, text: { type: 'string' } }, ['to', 'text']),
    argv: (a) => ['send', str(a.to), typeof a.text === 'string' ? a.text : ''],
  },
  {
    name: 'harness_close',
    description: 'Close a harness you started, once it is done. Its conversation is kept: the person can resume it. Refused while it works, unless now is true.',
    inputSchema: schema({ name: { type: 'string' }, now: { type: 'boolean', description: 'Close it even while it works.' } }, ['name']),
    annotations: { destructiveHint: true },
    argv: (a) => ['close', str(a.name), ...(a.now === true ? ['--now'] : [])],
  },
]

export interface Ran { code: number; out: string; err: string }
export type Runner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<Ran>

/** `harness <argv>` as this process was started: the same script and Node options, so sources and bundle alike. */
export function harnessRunner(scriptPath: string): Runner {
  return (argv, env) => new Promise((done) => {
    const child = spawn(process.execPath, [...process.execArgv, scriptPath, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => done({ code: 1, out, err: err || error.message }))
    child.on('close', (code) => done({ code: code ?? 1, out, err }))
  })
}

export interface McpDeps {
  run: Runner
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** This server's session: one a server, as its parent is the agent that started it. */
  session?: string
  /** Messages reach only a harness's pane, and an agent outside Harness has none to answer from. */
  inPane?: boolean
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** The answer to one JSON-RPC message, or null for a notification. */
export async function answer(message: Message, deps: McpDeps, state: { client?: string } = {}): Promise<Record<string, unknown> | null> {
  const id = message.id
  const isRequest = id !== undefined && id !== null
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: isRequest ? id : null, error: { code, message: text } })
  if (typeof message.method !== 'string') return isRequest ? fail(-32600, 'Invalid request') : null
  const tools = TOOLS.filter((tool) => tool.name !== 'harness_send' || deps.inPane)
  switch (message.method) {
    case 'initialize': {
      const asked = str(message.params?.protocolVersion)
      const info = message.params?.clientInfo as { name?: unknown } | undefined
      state.client = str(info?.name)
      return reply({
        protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'harness', title: 'Harness', version: VERSION },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: tools.map(({ argv: _argv, ...tool }) => tool) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === message.params?.name)
      if (!tool) return fail(-32602, `Unknown tool: ${String(message.params?.name)}`)
      const args = (message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {}) as Record<string, unknown>
      const ran = await deps.run(tool.argv(args, deps.cwd ?? process.cwd()), callerEnv(deps, state.client))
      return reply(result(tool.name, ran))
    }
    default:
      return isRequest ? fail(-32601, `Method not found: ${message.method}`) : null
  }
}

/**
 * The environment a verb runs with: this server's, and whose session it is when the agent did not say (Claude Code's
 * and Codex's shells do; an MCP server's environment may not). `AI_AGENT` names the agent, as its client said.
 */
export function callerEnv(deps: McpDeps, client = ''): NodeJS.ProcessEnv {
  const env = { ...(deps.env ?? process.env) }
  if (deps.inPane || (env.CLAUDECODE === '1' && env.CLAUDE_CODE_SESSION_ID) || env.CODEX_THREAD_ID) return env
  if (!env.AI_AGENT) env.AI_AGENT = agentOfClient(client)
  env[AGENT_SESSION_ENV] = deps.session ?? `mcp-${process.ppid}`
  return env
}

/** The agent an MCP client is, by the name it gives in `initialize` (seen: Claude Code's, Codex's), as `AI_AGENT` names it. */
export function agentOfClient(client: string): string {
  const name = client.trim().toLowerCase()
  if (name === 'claude-code') return 'claude-code'
  if (name.startsWith('codex')) return 'codex'
  if (name.startsWith('cursor')) return 'cursor'
  if (name === 'claude-ai' || name === 'claude-desktop') return 'claude-desktop'
  return name.replace(/[^\w.-]+/g, '-').replace(/_/g, '-').slice(0, 40) || 'mcp-client'
}

/** A verb's exit as a tool's result: its text, and an error only when it failed. Waiting that ends on the person, a
 *  stop or the clock is an answer, not a failure. */
export function result(tool: string, ran: Ran): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const text = [ran.out.trim(), ran.err.trim()].filter(Boolean).join('\n')
  if (tool === 'harness_wait' && ran.code === EXIT.timeout) {
    return { content: [{ type: 'text', text: `${text ? `${text}\n` : ''}Still working. Call harness_wait again to keep waiting.` }] }
  }
  const answered = ran.code === EXIT.ok || (tool === 'harness_wait' && (ran.code === EXIT.needsInput || ran.code === EXIT.stopped))
  return answered ? { content: [{ type: 'text', text: text || 'Done.' }] } : { content: [{ type: 'text', text: text || `harness exited ${ran.code}` }], isError: true }
}

/** Serve MCP on stdin and stdout until stdin closes. */
export async function mcpCommand(deps: McpDeps, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<number> {
  const state: { client?: string } = {}
  const lines = createInterface({ input, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let message: Message
    try { message = JSON.parse(line) } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      continue
    }
    // Calls run side by side: a wait must not hold up a list.
    const job = answer(message, deps, state)
      .then((reply) => { if (reply) output.write(`${JSON.stringify(reply)}\n`) })
      .catch((error) => { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: String((error as Error)?.message ?? error) } })}\n`) })
      .finally(() => pending.delete(job))
    pending.add(job)
  }
  await Promise.all(pending)
  return 0
}
