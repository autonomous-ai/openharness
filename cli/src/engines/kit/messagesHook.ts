/**
 * Agent Messages' hook (docs/design/2026-10-10-agent-messages.md), as the daemon installs it: at an agent's tool
 * call, the messages waiting in its pane's inbox (messages/inbox.ts) become the model's context before its next
 * request (`hookSpecificOutput.additionalContext` after PostToolUse: Claude Code 2.1.296, Codex 0.162.1). No
 * keystroke reaches the pane, so a draft or a permission dialog is never touched, and a teammate's words never
 * arrive as the person's.
 *
 * Its own command, apart from notify.mjs, which stays free of model-visible output (#684,
 * coreIsolation.spec.ts). The daemon writes the script itself, into the inbox root, rather than shipping a second
 * file beside cli.js that every installer and the updater would have to carry. The installed command is a shell
 * test that starts Node only when the pane's inbox folder exists, so a tool call with nothing waiting pays one
 * `sh`, never a Node start.
 *
 * The script claims each file by renaming it into `claimed/`: whatever claims a file first delivers it, so the
 * daemon typing it into an idle agent and this hook never both do. It prints nothing it did not claim, and always
 * exits 0: an engine shows a failing hook's output to the model, which a message must never be. A Claude Code
 * sub-agent's tool call carries its own `agent_id`, and a Codex sub-agent's another session: neither takes the
 * agent's messages.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import type { HookBlock } from './notifyHooks.js'

/** What marks the block as Agent Messages' own, whichever folder its command names. */
export const MESSAGES_HOOK_MARK = 'harness-agent-messages'

/** The script, written to `<root>/hook.mjs`. Plain Node, no dependency. */
export const MESSAGES_HOOK_SOURCE = `#!/usr/bin/env node
// Agent Messages' hook, written by the Harness daemon (cli/src/engines/kit/messagesHook.ts). Do not edit.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ITEM = 64 * 1024
const MAX_INPUT = 1024 * 1024

function arg(name) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

/** The hook's input, as the engine wrote it: bounded, and read for a moment at most. */
function readInput() {
  return new Promise((resolve) => {
    let raw = ''
    const done = () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } }
    const timer = setTimeout(done, 1000)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk; if (raw.length > MAX_INPUT) { clearTimeout(timer); resolve({}) } })
    process.stdin.on('end', () => { clearTimeout(timer); done() })
    process.stdin.on('error', () => { clearTimeout(timer); resolve({}) })
  })
}

async function main() {
  const root = arg('--root')
  const pane = process.env.TMUX_PANE || ''
  if (!root || !/^%\\d{1,9}$/.test(pane)) return
  const number = pane.slice(1)
  const dir = join(root, 'inbox', number)
  const input = await readInput()
  // A Claude Code sub-agent's tool call carries its own agent_id: its context is not the agent's.
  if (input && typeof input === 'object' && input.agent_id) return
  const session = typeof input?.session_id === 'string' ? input.session_id : ''
  let names = []
  try { names = readdirSync(dir).filter((name) => /^[0-9a-z._-]{1,120}\\.json$/.test(name)).sort() } catch { return }
  const claimed = join(root, 'claimed')
  mkdirSync(claimed, { recursive: true, mode: 0o700 })
  const texts = []
  for (const name of names) {
    const file = join(dir, name)
    let item
    try {
      if (statSync(file).size > MAX_ITEM) continue
      item = JSON.parse(readFileSync(file, 'utf8'))
    } catch { continue }
    if (!item || typeof item.text !== 'string' || !item.text) continue
    // Another conversation in this pane: a Codex sub-agent runs its hooks from its parent's pane.
    if (typeof item.session === 'string' && item.session && session && item.session !== session) continue
    try { renameSync(file, join(claimed, number + '-' + name)) } catch { continue }
    texts.push(item.text)
  }
  try { rmdirSync(dir) } catch { /* something still waits, or another hook emptied it */ }
  if (!texts.length) return
  const event = typeof input?.hook_event_name === 'string' ? input.hook_event_name : 'PostToolUse'
  // A pipe is written asynchronously on macOS: exit only once the engine has it all.
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: texts.join('\\n\\n') } }), resolve))
}

main().catch(() => {}).finally(() => process.exit(0))
`

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command an engine runs at each tool call: a shell test first, Node only when something waits. */
export function messagesCommand(root: string, node: string = managedNodePath()): string {
  const script = join(root, 'hook.mjs')
  return `p=${shellQuote(join(root, 'inbox'))}/"\${TMUX_PANE#%}"; [ -n "\${TMUX_PANE:-}" ] && [ -d "$p" ] || exit 0; `
    + `${shellQuote(node)} ${shellQuote(script)} --root ${shellQuote(root)}; exit 0 # ${MESSAGES_HOOK_MARK}`
}

/** Only the complete literal command we publish is ours to replace or approve.
 * A marker in somebody else's script, or a shell suffix, grants no ownership. */
export function isMessagesCommand(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 64 * 1024 || value.includes('\0')) return false
  const words = value.match(/'(?:[^']|'\\'')*'/g)
  if (words?.length !== 4) return false
  const [inbox, node, script, root] = words.map(word => word.slice(1, -1).replace(/'\\''/g, "'"))
  if (![inbox, node, script, root].every(isAbsolute) || !/^(?:node|nodejs)(?:\.exe)?$/.test(basename(node))
    || inbox !== join(root, 'inbox') || script !== join(root, 'hook.mjs')) return false
  return value === messagesCommand(root, node)
}

/** Whether a block is Agent Messages' own. */
export function isMessagesBlock(block: HookBlock): boolean {
  return Array.isArray(block?.hooks) && block.hooks.some(hook => hook?.type === 'command' && isMessagesCommand(hook.command))
}

/** Write the script where the command runs it, when it is not already there as it should be. */
export function writeMessagesHook(root: string): void {
  const file = join(root, 'hook.mjs')
  try { if (readFileSync(file, 'utf8') === MESSAGES_HOOK_SOURCE) return } catch { /* not written yet */ }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, MESSAGES_HOOK_SOURCE, { mode: 0o700 })
  renameSync(temporary, file)
}
