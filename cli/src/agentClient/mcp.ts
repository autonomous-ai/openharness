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
import { EXIT, VIA_MCP_ENV } from './commands.js'
import { ENGINES, TERMINAL_ENGINE } from '../engines/types.js'

/** Newest first: the client's own when it is one of these, else the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** What an agent is told once, as it connects: when Harness is the right tool, and whose harnesses are whose. */
export const INSTRUCTIONS = `Harness runs coding agents (Claude Code, Codex, and other engines) in sessions of their own, on this computer or the person's other machines. The person can watch and join every one in the Harness app.

Every harness spends the person's tokens. Start one (harness_start) only for work that can run in parallel with yours, needs another model's view (a review, a second opinion from Codex), takes long, or belongs in its own folder. Do quick work yourself. Give it a project name (project), never a folder of your own: Harness owns and trusts a project folder it makes (~/harnesses/<name>), so the agent needs no approval; a folder you name makes Claude Code or Codex ask the person to trust it, and it waits until they answer.

Call harness_whoami first: it says whether you may start harnesses now. Then list (harness_list), search what was already said or decided (harness_search), and see the machines you may run on (harness_machines). Put everything in the task. More work for a harness you started goes by harness_tell, once you have read its answer, while the person allows it; a message to a teammate in your tab by harness_send, while Agent Messages are on; otherwise start a new harness with the fuller task. Never give work to, or close, a harness you did not start: those are the person's.

Name every harness. Then wait for it (harness_wait), read its answer (harness_read), and close it once you have its answer (harness_close). At most 4 of yours at once, and a harness another agent started may not start harnesses itself. Never ask a harness to publish, deploy, delete or push.

Each answer ends with Next: the call to make next. A refusal is final: do not retry it; tell the person, or do the work yourself.`

/** How long `harness_wait` waits when not told: within what MCP clients allow a call. Codex ends one at 60 s unless its
 *  config says otherwise (`tool_timeout_sec`, developers.openai.com/codex/mcp), so 120 s ended every long wait as an
 *  error there; the agent calls again for more. */
const WAIT_DEFAULT_S = 45
const WAIT_MAX_S = 600

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  /** The `harness` words for these arguments. */
  argv: (args: Record<string, unknown>, cwd: string) => string[]
}

/** The agents a harness may be started with: every engine but the terminal (a shell pane is not an agent). */
export const STARTABLE_AGENTS = ENGINES.filter((engine) => engine !== TERMINAL_ENGINE)

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const TOOLS: Tool[] = [
  {
    name: 'harness_whoami',
    description: 'Who you are to Harness: which agent, on which machine, inside Harness or not; whether you may start harnesses now and, if not, who can change that; how many of yours are open and how many starts are left. Call it first, and whenever a start is refused.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    argv: () => ['whoami'],
  },
  {
    name: 'harness_list',
    description: 'The harnesses on a machine, this one unless machine names another: name, agent, state (working, idle, needs the person), who started each ("you" for yours), when it was last active, its folder, and what it is about.',
    inputSchema: schema({
      all: { type: 'boolean', description: 'Also the ones stopped in the last week.' },
      machine: { type: 'string', description: 'Another of the person\'s machines, by name (harness_machines), to list its harnesses: those you started there too.' },
    }),
    annotations: { readOnlyHint: true },
    // A harness started on another machine was in no list: `ps` lists one machine, and the tool named none.
    argv: (a) => ['ps', ...(str(a.machine) ? ['--machine', str(a.machine)] : []), ...(a.all === true ? ['--all'] : [])],
  },
  {
    name: 'harness_search',
    description: 'Search the conversations on this computer for the words that say them: every turn of every harness, live or stopped. It finds where something was already said or decided, before starting new work.',
    inputSchema: schema({ words: { type: 'string', description: 'The words to find, as you would say them.' }, limit: { type: 'number', minimum: 1, description: 'How many results (10 by default).' }, when: { type: 'string', description: 'Limit to a time range, as the CLI words it: "last week", "yesterday", "3 days ago", "on monday".' } }, ['words']),
    annotations: { readOnlyHint: true },
    argv: (a) => ['search', str(a.words), ...(str(a.when) ? [str(a.when)] : []), ...(typeof a.limit === 'number' && a.limit > 0 ? ['--limit', String(Math.floor(a.limit))] : [])],
  },
  {
    name: 'harness_machines',
    description: 'The machines on this account: name, status (running or offline), and which is this one. Use the name for harness_start machine to run a harness on another of the person\'s machines.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    argv: () => ['machines'],
  },
  {
    name: 'harness_start',
    description: 'Start a new harness: an agent in a session of its own, working on [task] in a new [project] Harness makes and owns (no approval needed), or in an existing [folder] (the engine asks the person to trust it). Prefer project. Returns within a minute; wait for it with harness_wait and read its answer with harness_read. If its agent is still being installed then, it starts by itself: follow it by its name, and never start it again.',
    inputSchema: schema({
      task: { type: 'string', description: 'The whole task, as you would write it to a colleague: what to do, where, and what to answer with.' },
      project: { type: 'string', description: 'For scratch or new work, always prefer this: a name for a new project folder Harness makes (~/harnesses/<name>) and trusts, so the agent needs no approval. With neither, Harness names one.' },
      folder: { type: 'string', description: 'Only for work that must live in an existing folder: an absolute path, or one relative to where this server runs. Claude Code and Codex ask the person to trust a folder Harness did not make, and wait until they answer — so prefer project.' },
      name: { type: 'string', description: 'A short name to call it by (e.g. "reviewer"). Always give one.' },
      agent: { type: 'string', enum: [...STARTABLE_AGENTS], description: 'The agent to run: Claude Code (default), Codex, or another harness engine (opencode, pi, cursor, …).' },
      machine: { type: 'string', description: 'Another of the person\'s machines, by name, to run it there.' },
      model: { type: 'string', description: 'The model it launches with, as the agent names it (haiku, opus, gpt-5.4-mini); its own default when left out.' },
    }, ['task', 'name']),
    // Starting a harness only adds one, on the person's own machines. Said so, Codex runs it without asking: a tool
    // that says nothing counts as destructive and open-world there, so `codex exec` refused every start ("MCP tool
    // call requires approval, but approval policy is never") and interactive Codex asked each time (codex-rs
    // core/src/mcp_tool_call.rs `requires_mcp_tool_approval`, 0.162.1). What an agent may start is Harness's to
    // decide (Settings ▸ Experimental, the spawn limits).
    annotations: { destructiveHint: false, openWorldHint: false },
    argv: (a, cwd) => {
      // A folder was required, and a relative one was resolved against this server's folder, so an MCP agent could not
      // ask for a project Harness makes: Codex started Claude Code in an empty ~/work, which waited on its trust question
      // (a clean VM, CLI 0.3.75, 2026-10-11). Both given, `harness new` says to name one.
      const folder = str(a.folder), project = str(a.project)
      const where = folder ? [isAbsolute(folder) || folder.startsWith('~') ? folder : resolve(cwd, folder)] : []
      return ['new', str(a.agent) || 'claude', ...(str(a.machine) ? ['--machine', str(a.machine)] : []), ...(str(a.model) ? ['--model', str(a.model)] : []), ...where,
        ...(project || !folder ? ['--new', ...(project ? [project] : [])] : []),
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
    name: 'harness_tell',
    description: 'Give more work to a harness you started, on any machine, in the conversation it already has: typed into it once it is free, or given at its next tool call while it works. Read its answer first (harness_read); then wait for the new one (harness_wait) and read it. Only a harness you started, and only while the person allows it (Harness Settings, agents-tell-agents); a refusal says so.',
    inputSchema: schema({
      name: { type: 'string', description: 'The harness you started.' },
      text: { type: 'string', description: 'The work, as you would write it to a colleague: what to do and what to answer with.' },
    }, ['name', 'text']),
    // As harness_send: words into a harness the caller started, and nothing more; said so, Codex does not ask.
    annotations: { destructiveHint: false, openWorldHint: false },
    argv: (a) => ['tell', str(a.name), '--', typeof a.text === 'string' ? a.text : ''],
  },
  {
    name: 'harness_send',
    description: 'Send a message to a teammate: a harness in the same tab as you, while Agent Messages are on (Settings ▸ Experimental, off by default). Refused anywhere else, even to a harness you started.',
    inputSchema: schema({ to: { type: 'string', description: 'The teammate\'s name.' }, text: { type: 'string' } }, ['to', 'text']),
    // A message adds to a teammate's inbox in this tab and nothing more; as harness_start, said so Codex does not ask.
    annotations: { destructiveHint: false, openWorldHint: false },
    argv: (a) => ['send', str(a.to), typeof a.text === 'string' ? a.text : ''],
  },
  {
    name: 'harness_close',
    description: 'Close a harness you started, once it is done. Its conversation is kept: the person can resume it. Refused while it works, unless now is true.',
    inputSchema: schema({ name: { type: 'string' }, now: { type: 'boolean', description: 'Close it even while it works.' } }, ['name']),
    // Not destructive: the conversation is kept and the person can resume it, and Harness itself lets an agent close only
    // what it started. Said so, Codex closes without asking even where the server was added by hand (`codex mcp add`),
    // not only through the plugin's manifest: a close that waits on approval in `codex exec` left the harness running
    // (2026-10-12, in a clean VM).
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
  /** How long `initialize` waits for `harness whoami` before it answers without it (5 s). */
  whoamiMs?: number
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** The answer to one JSON-RPC message, or null for a notification. */
export async function answer(message: Message, deps: McpDeps, state: { client?: string } = {}): Promise<Record<string, unknown> | null> {
  const id = message.id
  const isRequest = id !== undefined && id !== null
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: isRequest ? id : null, error: { code, message: text } })
  if (typeof message.method !== 'string') return isRequest ? fail(-32600, 'Invalid request') : null
  // Both name their sender by its pane: an agent outside Harness has none to send or tell from.
  const tools = TOOLS.filter((tool) => (tool.name !== 'harness_send' && tool.name !== 'harness_tell') || deps.inPane)
  switch (message.method) {
    case 'initialize': {
      const asked = str(message.params?.protocolVersion)
      const info = message.params?.clientInfo as { name?: unknown } | undefined
      state.client = str(info?.name)
      // Where the agent is and what it may do, as it connects: the block `harness whoami` prints. It never holds the
      // connection up: without it in time, the instructions alone.
      let timer: NodeJS.Timeout | undefined
      const here = await Promise.race([
        deps.run(['whoami'], callerEnv(deps, state.client)).catch(() => null),
        new Promise<null>((done) => { timer = setTimeout(() => done(null), deps.whoamiMs ?? 5_000); timer.unref?.() }),
      ]).finally(() => clearTimeout(timer))
      const now = here && here.code === EXIT.ok && here.out.trim() ? `Right now:\n${here.out.trim()}\n\n` : ''
      return reply({
        protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'harness', title: 'Harness', version: VERSION },
        instructions: `${now}${INSTRUCTIONS}`,
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
  // The verbs then name their next steps as this server's tools.
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), [VIA_MCP_ENV]: '1' }
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
  // A refusal is an answer too: an error invites a retry, and a refusal is not retried.
  const answered = ran.code === EXIT.ok || ran.code === EXIT.refused || (tool === 'harness_wait' && (ran.code === EXIT.needsInput || ran.code === EXIT.stopped))
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
