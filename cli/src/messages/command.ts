/**
 * `harness send`: an agent messages its teammates in a tab with Agent Messages on
 * (docs/design/2026-10-10-agent-messages.md). Run in the agent's own pane: the pane says who is sending.
 *
 *   harness send                       who is in this tab, and the rules
 *   harness send <name>[,<name>] text  message them (or --text-file PATH)
 *
 * It asks the daemon that made the pane, the way an engine's hook does (`@harness_daemon` and the hook routes),
 * so a development daemon beside the release one is never confused with it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { env } from '../config/env.js'
import { readAuthSession } from '../lib/authSession.js'
import { HARNESS_OWNER_OPTION } from '../lib/harnessSessionLabel.js'
import { MessageError } from './model.js'
import { messagesRpc, type Rpc } from './rpc.js'

export const SEND_USAGE = `harness send — message your teammates in this tab

  harness send                          who is here, and how to work together
  harness send <name>[,<name>] "text"   message one or more teammates
  harness send <name> --text-file PATH  a longer message, from a file

Run it in your own harness pane. Agent Messages must be on in the tab (the chat icon on the tab), except
between a harness and the harnesses it started on this machine.
Use --json for structured output.`

export interface SendArgs { names: string[]; text: string; json: boolean }

export function parseSendArgs(argv: readonly string[], read: (path: string) => string = (path) => readFileSync(path, 'utf8')): SendArgs {
  let json = false, file: string | null = null
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--json') json = true
    else if (value === '--text-file') {
      if (argv[i + 1] === undefined) throw new MessageError('USAGE', SEND_USAGE)
      file = argv[++i]
    } else if (value === '--help' || value === '-h') throw new MessageError('USAGE', SEND_USAGE)
    // After the recipients, a word that starts with dashes is the message's own (a Markdown `---`, `--force`).
    else if (value.startsWith('-') && !words.length) throw new MessageError('USAGE', SEND_USAGE)
    else words.push(value)
  }
  const [to, ...rest] = words
  const names = to ? to.split(',').map((n) => n.trim()).filter(Boolean) : []
  const text = file !== null ? read(file) : rest.join(' ')
  if (!names.length && (text || file !== null)) throw new MessageError('USAGE', SEND_USAGE)
  return { names, text, json }
}

/** The daemon that made this pane: its port and data folder, from the pane's owner tag and the hook routes. */
export function paneOwner(pane: string, tmux: (args: string[]) => string = (args) => execFileSync('tmux', args, { encoding: 'utf8', timeout: 2000 }),
  routesDir: string = env.HARNESS_HOOK_ROUTES_DIR): { port: number; dataDir: string } | null {
  try {
    const tag = tmux(['display-message', '-p', '-t', pane, `#{${HARNESS_OWNER_OPTION}}`]).trim()
    if (!/^[0-9a-f]{16}$/.test(tag)) return null
    const record = JSON.parse(readFileSync(join(routesDir, `${tag}.json`), 'utf8')) as { port?: unknown; dataDir?: unknown }
    if (typeof record.dataDir !== 'string' || !isAbsolute(record.dataDir) || !Number.isInteger(record.port)) return null
    return { port: record.port as number, dataDir: record.dataDir }
  } catch { return null }
}

/** One recipient's line: what became of the message for them. */
export function formatSent(reply: Record<string, unknown>): string {
  if (typeof reply.roster === 'string') {
    const recent = (Array.isArray(reply.recent) ? reply.recent as Record<string, unknown>[] : []).map((m) => {
      const who = Array.isArray(m.to) ? `to ${(m.to as unknown[]).join(', ')}` : `from ${String(m.from)}`
      const first = String(m.text ?? '').split('\n')[0]
      return `  [${String(m.id)} ${who}] ${first.length > 160 ? `${first.slice(0, 157)}…` : first} (${String(m.state)})`
    })
    return recent.length ? `${reply.roster}\n\nYour last messages:\n${recent.join('\n')}` : reply.roster
  }
  const id = String(reply.id ?? '')
  const lines = (Array.isArray(reply.recipients) ? reply.recipients as Record<string, unknown>[] : []).map((r) => {
    const via = r.via === 'hook' ? ' (at its tool call)' : r.via === 'prompt' ? ' (as a prompt)' : ''
    return `${id} → ${String(r.name)}: ${String(r.state)}${via}${r.reason ? ` · ${String(r.reason)}` : ''}`
  })
  return lines.join('\n')
}

export async function sendCommand(argv: readonly string[], deps: {
  rpc?: Rpc
  pane?: string | undefined
  owner?: typeof paneOwner
  out?: (line: string) => void
  err?: (line: string) => void
} = {}): Promise<number> {
  const out = deps.out ?? ((line) => console.log(line))
  const err = deps.err ?? ((line) => console.error(line))
  let args: SendArgs
  try { args = parseSendArgs(argv) } catch (error) {
    err((error as Error).message)
    return 2
  }
  const pane = 'pane' in deps ? deps.pane : process.env.TMUX_PANE
  if (!pane) {
    err('Run harness send from a harness pane: it says who is sending.')
    return 1
  }
  const owner = (deps.owner ?? paneOwner)(pane)
  let machineId = readAuthSession()?.machineId ?? env.ADAPTER_COMPUTER_ID ?? ''
  if (!machineId) try { machineId = readFileSync(env.ADAPTER_COMPUTER_ID_FILE, 'utf8').trim() } catch { /* asked below */ }
  try {
    const reply = await (deps.rpc ?? messagesRpc)({ port: owner?.port ?? env.PORT, dataDir: owner?.dataDir ?? env.ADAPTER_DATA_DIR, machineId },
      { action: 'send', pane, ...(args.names.length ? { to: args.names } : {}), ...(args.text ? { text: args.text } : {}) }, 30_000)
    out(args.json ? JSON.stringify(reply, null, 2) : formatSent(reply))
    return 0
  } catch (error) {
    if (args.json) out(JSON.stringify({ error: error instanceof MessageError ? error.code : 'FAILED', detail: (error as Error).message }))
    else err((error as Error).message)
    return 1
  }
}
