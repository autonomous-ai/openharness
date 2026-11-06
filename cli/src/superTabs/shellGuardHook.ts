/**
 * The shell guard's hook (superTabs/shellGuard.ts), which a Swarm agent's engine runs before each tool call
 * (lib/agentShellGuard.ts). Claude Code and Codex hand it the same JSON on stdin (`tool_name`, `tool_input`, `cwd`)
 * and read the same answer on stdout: a `PreToolUse` decision of `deny` with its reason, or nothing, which leaves the call
 * to the session's own permissions (the old Buddy guard's shape, __fixtures__/buddy-guard-before-2832.mjs; Codex 0.166's
 * `PreToolUseHookSpecificOutputWire`). It imports nothing but the guard and Node's own modules: it runs at every command.
 */
import { readFileSync } from 'node:fs'
import { fileRefusal, machineFacts, shellRefusal, type GuardFacts } from './shellGuard.js'

/** Claude Code's tools that write a file at a path they are given. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The command a shell tool call runs: Claude Code's `Bash` gives a line, Codex may give a line or its argv. */
function commandOf(input: Record<string, unknown>): string | null {
  const command = input.command ?? input.cmd
  if (typeof command === 'string') return command
  if (Array.isArray(command) && command.every((word) => typeof word === 'string')) {
    return command.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(' ')
  }
  return null
}

/** The reason the tool call [call] is refused, or null to leave it to the session's permissions. */
export function guardDecision(call: unknown, factsFor: (cwd: string) => GuardFacts = machineFacts): string | null {
  if (!call || typeof call !== 'object') return null
  const { tool_name: tool, tool_input: input, cwd } = call as Record<string, unknown>
  if (!input || typeof input !== 'object') return null
  const facts = factsFor(typeof cwd === 'string' && cwd ? cwd : process.cwd())
  const fields = input as Record<string, unknown>
  if (typeof tool === 'string' && FILE_TOOLS.has(tool)) {
    const path = fields.file_path ?? fields.notebook_path
    return typeof path === 'string' ? fileRefusal(path, facts) : null
  }
  // Codex's patches name their files inside the patch; they are not a shell's command.
  if (tool === 'apply_patch') return null
  const command = commandOf(fields)
  return command === null ? null : shellRefusal(command, facts)
}

/** What the hook prints for [reason]: a deny both engines read, or nothing. */
export function hookReply(reason: string | null): string {
  if (reason === null) return ''
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`
}

/** The hook's answer for the text the engine wrote on stdin. A call it cannot read is left to the session's permissions:
 *  the engines always send JSON, and a guard that refused everything it could not parse would stop an agent's work. */
export function hookAnswer(stdin: string, factsFor?: (cwd: string) => GuardFacts): string {
  let call: unknown
  try { call = JSON.parse(stdin) } catch { return '' }
  return hookReply(guardDecision(call, factsFor))
}

/** The internal CLI entry calls this without loading the daemon or normal CLI commands. */
export function runShellGuard(): void {
  process.stdout.write(hookAnswer(readFileSync(0, 'utf8')))
}
