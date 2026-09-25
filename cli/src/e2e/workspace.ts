/**
 * workspace — the folder the test agent is created in, laid out like a person's real project:
 * a script tool (`tools/calc.sh`), an MCP server registered for the engine (`e2e_calc`), and the
 * two logs those write to. The scenario (`smokeChecks.ts`) names them; the probe reads the logs.
 *
 *   <cwd>/tools/calc.sh              the script tool (copied from workspace/calc.sh)
 *   <cwd>/.mcp.json                  claude: project-level MCP server
 *   ~/.codex/config.toml             codex: registered with `codex mcp add` — see below
 *   <cwd>/.e2e/calc-tool.log         one line per script call
 *   <cwd>/.e2e/calc-mcp.log          one line per MCP tools/call
 *
 * The two engines differ, and both shapes here were measured against the installed CLIs rather than
 * assumed:
 *
 *   * claude reads `<cwd>/.mcp.json` — `claude mcp list` in the workspace lists `e2e_calc` and a
 *     headless run really reaches the server. The agent runs in the app's default mode (`auto`), so
 *     the project's `.claude/settings.json` allows the steps' tools the way a person who answered
 *     "don't ask again" has them (`allowClaudeProjectTools`).
 *   * codex has NO project-level MCP config. A `<cwd>/.codex/config.toml` is never read (from inside
 *     such a workspace, `codex mcp list` does not list the server), so registration goes through
 *     codex's own `codex mcp add`, which writes `~/.codex/config.toml`, with its tools always allowed
 *     (`approveCodexMcpTools`) — and `removeCodexMcp` takes the entry out again when the run is over.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, renameSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LogKind } from './smokeChecks.js'

// Both assets are written from these strings, not copied from beside this file: the published CLI is
// ONE bundled `cli.js` (build-bundle.mjs), and files next to the source never reach an installed
// machine. The originals under `workspace/` are the readable copies; the spec pins them equal.
export const CALC_SH = `#!/bin/sh
# e2e calc tool — the "tool the user already has in their folder". Usage: tools/calc.sh add|sub A B
# Every call is logged next to it (\`.e2e/calc-tool.log\`) so the e2e can prove the tool was used.
op="$1"; a="$2"; b="$3"
case "$op" in
  add) r=$((a + b)) ;;
  sub) r=$((a - b)) ;;
  *) echo "usage: calc.sh add|sub A B" >&2; exit 2 ;;
esac
dir=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$dir/.e2e"
printf '%s %s %s %s = %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$op" "$a" "$b" "$r" >> "$dir/.e2e/calc-tool.log"
echo "$r"
`

export const CALC_MCP_MJS = `#!/usr/bin/env node
/**
 * e2e_calc — the smallest MCP server that can prove "the tool still uses MCP after a switch".
 *
 * stdio transport, newline-delimited JSON-RPC, two tools: add(a, b) and sub(a, b). Every call is
 * appended to the log file given as argv[2] (\`<ts> <tool> <a> <b> = <result>\`), so the e2e has hard
 * evidence the model went THROUGH the server rather than doing the arithmetic in its head.
 * No SDK on purpose: nothing to install in the scratch workspace the test agent runs in.
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.argv[2]
const TOOLS = [
  { name: 'add', description: 'Add two numbers: a + b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'sub', description: 'Subtract two numbers: a - b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}

function log(line) {
  if (logFile) appendFileSync(logFile, \`\${new Date().toISOString()} \${line}\\n\`)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req
  if (id === undefined) return // notification (notifications/initialized, …)
  switch (method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'e2e_calc', version: '1.0.0' } } })
      return
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const name = params?.name
      const a = Number(params?.arguments?.a)
      const b = Number(params?.arguments?.b)
      if ((name !== 'add' && name !== 'sub') || Number.isNaN(a) || Number.isNaN(b)) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: \`error: unknown tool or bad arguments (\${name})\` }], isError: true } })
        return
      }
      const result = name === 'add' ? a + b : a - b
      log(\`\${name} \${a} \${b} = \${result}\`)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(result) }] } })
      return
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: \`method not found: \${method}\` } })
  }
})
`

export const MCP_SERVER_NAME = 'e2e_calc'
/** The tools `CALC_MCP_MJS` serves. */
export const CALC_MCP_TOOLS = ['add', 'sub'] as const

/**
 * What a person using claude in this project has long since answered "Yes, and don't ask again"
 * to: the file tools, the project's script, reading a file with cat, and the project's MCP server —
 * kept by claude in the project's `.claude/settings.json` (`permissions.allow`), with the `.mcp.json`
 * server approved in the same file (`enabledMcpjsonServers`). Measured on claude 2.1.274 + Haiku in
 * `auto`: without it the first step stopped on "This command requires approval" for
 * `bash tools/calc.sh add 40 2`.
 */
export function allowClaudeProjectTools(cwd: string): void {
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  const settings = {
    permissions: {
      allow: [
        'Read', 'Write', 'Edit',
        'Bash(tools/calc.sh:*)', 'Bash(./tools/calc.sh:*)', 'Bash(bash tools/calc.sh:*)', 'Bash(sh tools/calc.sh:*)',
        'Bash(cat:*)',
        `mcp__${MCP_SERVER_NAME}`,
      ],
    },
    enabledMcpjsonServers: [MCP_SERVER_NAME],
  }
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
}

export function logPath(cwd: string, kind: LogKind): string {
  return join(cwd, '.e2e', kind === 'tool' ? 'calc-tool.log' : 'calc-mcp.log')
}

export interface WorkspaceLayout {
  tool: string
  mcpServer: string
  /** Where this engine's MCP registration ended up, or null when there is none. */
  mcpConfig: string | null
  /** How it got there — or, when `mcpConfig` is null, why the MCP steps cannot pass. */
  mcpNote: string
}

/**
 * Register the workspace's MCP server with codex, through codex's own command.
 *
 * `remove` first so a stale entry from an interrupted run (pointing at a workspace that no longer
 * exists) cannot survive as a server codex fails to start. Both calls are best-effort: a codex too
 * old for `mcp add` must leave a run without MCP rather than without a run, and the caller reports
 * that in the trace.
 */
export function registerCodexMcp(mcpServer: string, mcpLog: string, bin = 'codex'): { ok: true } | { ok: false; detail: string } {
  const run = (args: string[]): string => execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  try { run(['mcp', 'remove', MCP_SERVER_NAME]) } catch { /* not registered — the normal case */ }
  try {
    run(['mcp', 'add', MCP_SERVER_NAME, '--', 'node', mcpServer, mcpLog])
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return { ok: false, detail: (e.stderr || e.message || String(err)).trim().split('\n')[0] }
  }
  // Registered is not the same as visible: ask codex what it sees, so a run never starts believing
  // in a server the engine will not load.
  try {
    if (!run(['mcp', 'list']).includes(MCP_SERVER_NAME)) return { ok: false, detail: `codex mcp add reported success but 'codex mcp list' does not show ${MCP_SERVER_NAME}` }
  } catch { /* `mcp list` can fail on its own (a broken unrelated server); the add is what matters */ }
  return { ok: true }
}

/**
 * Mark the server's tools as always allowed, the entry codex writes itself when a person answers a
 * tool's approval with "always allow" — how every MCP tool on a working developer's machine ends up
 * (`[mcp_servers.<server>.tools.<tool>] approval_mode = "approve"`). Without it a tool with no
 * `readOnlyHint` needs approval on every call (codex-rs/core/src/mcp_tool_call.rs
 * `requires_mcp_tool_approval`), and in `auto` that approval is codex's reviewer, which asks for a
 * model named `codex-auto-review` — one only OpenAI serves: on the grid it answered 503 and codex
 * refused the call (openai/codex#24879). Nested under the server's table, so `codex mcp remove`
 * takes it out with the server.
 */
export function approveCodexMcpTools(configPath: string, tools: readonly string[]): void {
  const lines = tools.map((t) => `\n[mcp_servers.${MCP_SERVER_NAME}.tools.${t}]\napproval_mode = "approve"\n`).join('')
  writeFileSync(configPath, lines, { flag: 'a' })
}

/** Take the entry back out — the run's own cleanup, so the next run starts from a clean config. */
export function removeCodexMcp(bin = 'codex'): boolean {
  try {
    execFileSync(bin, ['mcp', 'remove', MCP_SERVER_NAME], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

/**
 * Lay the workspace out for `engine`. Idempotent. Returns what was written, for the trace.
 *
 * `codexBin` exists so a test can watch the registration without running the real `codex mcp add`:
 * that command writes the developer's own `~/.codex/config.toml`, and a unit test has no business
 * leaving an entry there pointing at a temp folder it is about to delete.
 */
export function prepareWorkspace(cwd: string, engine: string, opts: { codexBin?: string; codexConfig?: string } = {}): WorkspaceLayout {
  mkdirSync(join(cwd, 'tools'), { recursive: true })
  mkdirSync(join(cwd, '.e2e'), { recursive: true })
  const tool = join(cwd, 'tools', 'calc.sh')
  writeFileSync(tool, CALC_SH)
  chmodSync(tool, 0o755)
  for (const kind of ['tool', 'mcp'] as const) writeFileSync(logPath(cwd, kind), '', { flag: 'a' })

  // read / write / edit (smokeChecks.ts): one set of files per side, so the grid side can never pass
  // (named `info-N.txt`, not `secret-N.txt`: gpt-6-luna refused outright to read a file called
  // "secret" — "I can't provide the contents of a file named notes/secret-1.txt" — and a test that
  // provokes a refusal measures the refusal, not the switch)
  // on what the first side left. The token is made HERE, fresh for every run, and written nowhere
  // but its file — not in a prompt, not in a log — so the only way to name it is to read it.
  mkdirSync(join(cwd, 'notes'), { recursive: true })
  mkdirSync(join(cwd, 'out'), { recursive: true })
  for (const n of [1, 2]) {
    writeFileSync(join(cwd, 'notes', `info-${n}.txt`), `${freshToken()}\n`)
    writeFileSync(join(cwd, 'notes', `todo-${n}.txt`), `# todo ${n}\nstatus: pending\n`)
  }

  // The MCP server runs from the workspace too, so the engine's config points at a path that exists
  // on every machine the e2e runs on.
  const mcpServer = join(cwd, 'tools', 'calc-mcp.mjs')
  writeFileSync(mcpServer, CALC_MCP_MJS)
  const mcpLog = logPath(cwd, 'mcp')
  let mcpConfig: string | null = null
  let mcpNote = `${engine} has no MCP registration here: the MCP steps cannot pass`
  if (engine === 'codex') {
    const registered = registerCodexMcp(mcpServer, mcpLog, opts.codexBin ?? 'codex')
    if (registered.ok) {
      mcpConfig = opts.codexConfig ?? join(homedir(), '.codex', 'config.toml')
      approveCodexMcpTools(mcpConfig, CALC_MCP_TOOLS)
      mcpNote = `registered with \`codex mcp add\`, tools ${CALC_MCP_TOOLS.join('/')} always allowed (codex does not read a project-level .codex/config.toml)`
    } else {
      mcpNote = `codex mcp add failed: ${registered.detail}`
    }
  } else if (engine === 'claude') {
    mcpConfig = join(cwd, '.mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: [mcpServer, mcpLog] } } }, null, 2) + '\n')
    preApproveClaudeMcp(cwd, [MCP_SERVER_NAME])
    allowClaudeProjectTools(cwd)
    mcpNote = 'project .mcp.json; the steps\' tools always allowed in .claude/settings.json'
  }
  return { tool, mcpServer, mcpConfig, mcpNote }
}

/**
 * Claude Code loads a project's `.mcp.json` servers only once the person approved them; the answer
 * is kept in `~/.claude.json` as `projects[<cwd>].enabledMcpjsonServers`. For a workspace this run
 * made, that answer is the run's to give — same posture and same file handling as the daemon's
 * `preTrustClaudeProject` (lib/claudeTrust.ts): only add, never touch a shape we did not expect.
 *
 * Measured against claude 2.1.x, this is NOT what carries the MCP steps, and the file says so rather
 * than leaving the next reader to re-measure: claude rewrites `~/.claude.json` at startup and the
 * key is gone afterwards (`claude mcp list` still says "Pending approval"). What actually reaches
 * the server is the `full` permission mode the agent is created in. Kept because it costs one write
 * and is the right answer if a future claude honours it; never relied on.
 */
export function preApproveClaudeMcp(cwd: string, names: string[], home = homedir()): 'approved' | 'already' | 'skipped' {
  const file = join(home, '.claude.json')
  if (!existsSync(file)) return 'skipped'
  let config: unknown
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return 'skipped'
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isObj(config)) return 'skipped'
  if (config.projects !== undefined && !isObj(config.projects)) return 'skipped'
  const projects = (config.projects ?? {}) as Record<string, unknown>
  const existing = projects[cwd]
  if (existing !== undefined && !isObj(existing)) return 'skipped'
  const current = Array.isArray(existing?.enabledMcpjsonServers) ? (existing!.enabledMcpjsonServers as unknown[]) : []
  if (names.every((n) => current.includes(n))) return 'already'
  projects[cwd] = { allowedTools: [], ...(existing ?? {}), enabledMcpjsonServers: [...current, ...names.filter((n) => !current.includes(n))] }
  config.projects = projects
  // Atomic, through a symlink (dotfile managers link ~/.claude.json), like the daemon does.
  const target = realpathSync(file)
  const tmp = `${target}.e2e-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
  return 'approved'
}

/**
 * Accept Claude Code's Bypass Permissions warning ahead of time.
 *
 * `--dangerously-skip-permissions` does not go straight to the prompt the first time: an
 * interactive claude draws a full-screen "WARNING: Claude Code running in Bypass Permissions mode"
 * with **"No, exit" selected**, and on Enter it exits 1 — the pane becomes a shell and every check
 * of the run is stuck with no engine behind it. (A headless `claude -p` never shows it, which is
 * why the flag looks harmless until it runs in a pane.) The answer is remembered in `~/.claude.json`
 * as `bypassPermissionsModeAccepted`, a key read out of claude 2.1.281's own binary rather than
 * guessed — so the run gives it the same way a person would, once, before the agent starts.
 *
 * It is NOT sufficient on its own, and the next reader should not have to find that out in a failed
 * run: on the pass that proved this, the flag was written (`accepted`) and the warning still came up
 * — `paneProbe`'s `claude-bypass-accept` answered it, and the leg passed. So the dialog handler is
 * what carries the run and this write is the belt: cheap, correct, and it may be what keeps the
 * screen away on a machine that reads the flag earlier.
 */
export function preAcceptClaudeBypassMode(home = homedir()): 'accepted' | 'already' | 'skipped' {
  const file = join(home, '.claude.json')
  if (!existsSync(file)) return 'skipped'
  let config: unknown
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return 'skipped'
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'skipped'
  const conf = config as Record<string, unknown>
  if (conf.bypassPermissionsModeAccepted === true) return 'already'
  conf.bypassPermissionsModeAccepted = true
  const target = realpathSync(file)
  const tmp = `${target}.e2e-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(conf, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
  return 'accepted'
}

const WORDS = ['kiwi', 'tulip', 'cobalt', 'maple', 'otter', 'saffron', 'glacier', 'lantern', 'pepper', 'quartz', 'harbor', 'violet', 'ember', 'falcon', 'juniper', 'meadow']

/** `kiwi-4821-tulip`: two words and four digits, ~2.5 million combinations, new every run. */
export function freshToken(): string {
  return `${WORDS[randomInt(WORDS.length)]}-${randomInt(1000, 10000)}-${WORDS[randomInt(WORDS.length)]}`
}

/** A workspace file's content, or null when it does not exist — what the probe checks write/edit/read against. */
export function readWorkspaceFile(cwd: string, relPath: string): string | null {
  try {
    return readFileSync(join(cwd, relPath), 'utf8')
  } catch {
    return null
  }
}

/** The log's lines right now (empty when it does not exist yet). */
export function readLog(cwd: string, kind: LogKind): string[] {
  try {
    return readFileSync(logPath(cwd, kind), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
