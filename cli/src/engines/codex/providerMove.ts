/**
 * A Codex conversation moved between a grid and the own login, forked while no client holds it.
 *
 * A fork keeps the instructions saved in the conversation (`core/src/session/mod.rs`: config, then history, then the
 * model's own). An OpenAI model's say "call functions.exec"; a grid model has no such tool, so it calls it, Codex answers
 * `unsupported call: exec`, and the turn never ends. So the fork starts with the instructions Codex gives the
 * destination model in a new conversation. They stay in the new thread's metadata, so the pane's plain `codex resume`
 * needs no extra flags. The history and the source conversation are not touched.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import gridInstructions from './gridInstructions.json' with { type: 'json' }

const REQUEST_MS = 30_000

export interface CodexMove {
  sessionId: string
  toGrid: boolean
  /** The launch's own arguments: its `-c` pairs select the provider, its `-m` the model. */
  args: readonly string[]
  /** The full argv for these Codex arguments: on Windows an npm shim's batch file cannot be spawned (lib/windows/launch.ts). */
  argv: (args: readonly string[]) => string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

/** `-c` pairs and the model from a pane's argv. `codex app-server` takes `-c` but refuses `-m`. */
export function appServerArgs(args: readonly string[]): { config: string[]; model: string | null } {
  const config: string[] = []
  let model: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && args[i + 1] !== undefined) config.push('-c', args[++i])
    else if (args[i] === '-m' && args[i + 1] !== undefined) model = args[++i]
  }
  return { config, model }
}

/** The instructions Codex's catalog gives a model. Null for a model it does not list, or a Codex with no such command. */
async function catalogInstructions(move: CodexMove, slug: string): Promise<string | null> {
  const output = await new Promise<string>((resolve) => {
    const [command, ...args] = move.argv(['debug', 'models', ...appServerArgs(move.args).config])
    const child = spawn(command!, args, { env: move.env, stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    const timer = setTimeout(() => child.kill(), REQUEST_MS)
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(text) })
  })
  try {
    const card = JSON.parse(output).models?.find((entry: { slug?: string }) => entry.slug === slug)
    return typeof card?.base_instructions === 'string' ? card.base_instructions : null
  } catch { return null }
}

function appServer(move: CodexMove) {
  const [command, ...args] = move.argv(['app-server', ...appServerArgs(move.args).config])
  const child: ChildProcessWithoutNullStreams = spawn(command!, args, { env: move.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let next = 1
  const waiting = new Map<number, { resolve(result: any): void; reject(error: Error): void }>()
  const fail = (error: Error) => { for (const entry of waiting.values()) entry.reject(error); waiting.clear() }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Codex exited during the move')))
  child.stderr.resume()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    const entry = typeof message.id === 'number' ? waiting.get(message.id) : undefined
    if (!entry) return
    waiting.delete(message.id)
    if (message.error) entry.reject(new Error(String(message.error.message ?? 'Codex refused the request')))
    else entry.resolve(message.result)
  })
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Codex did not answer ${method}`)) }, REQUEST_MS)
    waiting.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  return { child, request, notify: (method: string) => child.stdin.write(`${JSON.stringify({ method })}\n`) }
}

/** Returns the new conversation's id, ready for `codex resume`. Throws, having left the source as it was. */
export async function moveCodexConversation(move: CodexMove): Promise<string> {
  const server = appServer(move)
  try {
    await server.request('initialize', { clientInfo: { name: 'harness', version: '1' } })
    server.notify('initialized')
    const { model } = appServerArgs(move.args)
    // The launch's model, or the fork asks the new provider for the one the conversation was on.
    const params: Record<string, unknown> = { threadId: move.sessionId, ...(model ? { model } : {}), ...(move.cwd ? { cwd: move.cwd } : {}) }
    if (move.toGrid) {
      params.baseInstructions = gridInstructions.instructions
    } else {
      const listed = await server.request('model/list', { includeHidden: true })
      const slug = model ?? listed?.data?.find((entry: { isDefault?: boolean }) => entry.isDefault)?.model
      const instructions = typeof slug === 'string' ? await catalogInstructions(move, slug) : null
      if (instructions) params.baseInstructions = instructions
    }
    const forked = await server.request('thread/fork', params)
    const threadId: unknown = forked?.thread?.id
    if (typeof threadId !== 'string') throw new Error('Codex returned no conversation id for the fork')
    return threadId
  } finally { server.child.kill() }
}
