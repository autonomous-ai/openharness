/**
 * workspace — the folder the test agent is created in, laid out like a person's real project:
 * a script tool (`tools/calc.sh`), an MCP server registered for the engine (`e2e_calc`), and the
 * two logs those write to. The scenario (`smokeChecks.ts`) names them; the probe reads the logs.
 *
 *   <cwd>/tools/calc.sh              the script tool (copied from workspace/calc.sh)
 *   <cwd>/.codex/config.toml         codex: project-level MCP server (loaded once the folder is trusted)
 *   <cwd>/.mcp.json                  claude: project-level MCP server
 *   <cwd>/.e2e/calc-tool.log         one line per script call
 *   <cwd>/.e2e/calc-mcp.log          one line per MCP tools/call
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, renameSync, realpathSync } from 'node:fs'
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

export function logPath(cwd: string, kind: LogKind): string {
  return join(cwd, '.e2e', kind === 'tool' ? 'calc-tool.log' : 'calc-mcp.log')
}

/** Lay the workspace out for `engine`. Idempotent. Returns what was written, for the trace. */
export function prepareWorkspace(cwd: string, engine: string): { tool: string; mcpServer: string; mcpConfig: string | null } {
  mkdirSync(join(cwd, 'tools'), { recursive: true })
  mkdirSync(join(cwd, '.e2e'), { recursive: true })
  const tool = join(cwd, 'tools', 'calc.sh')
  writeFileSync(tool, CALC_SH)
  chmodSync(tool, 0o755)
  for (const kind of ['tool', 'mcp'] as const) writeFileSync(logPath(cwd, kind), '', { flag: 'a' })

  // The MCP server runs from the workspace too, so the engine's config points at a path that exists
  // on every machine the e2e runs on.
  const mcpServer = join(cwd, 'tools', 'calc-mcp.mjs')
  writeFileSync(mcpServer, CALC_MCP_MJS)
  const mcpLog = logPath(cwd, 'mcp')
  let mcpConfig: string | null = null
  if (engine === 'codex') {
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    mcpConfig = join(cwd, '.codex', 'config.toml')
    writeFileSync(mcpConfig, [
      `# e2e workspace — the MCP server the scenario asks for by name.`,
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `command = "node"`,
      `args = [${JSON.stringify(mcpServer)}, ${JSON.stringify(mcpLog)}]`,
      ``,
    ].join('\n'))
  } else if (engine === 'claude') {
    mcpConfig = join(cwd, '.mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: [mcpServer, mcpLog] } } }, null, 2) + '\n')
    preApproveClaudeMcp(cwd, [MCP_SERVER_NAME])
  }
  return { tool, mcpServer, mcpConfig }
}

/**
 * Claude Code loads a project's `.mcp.json` servers only once the person approved them; the answer
 * is kept in `~/.claude.json` as `projects[<cwd>].enabledMcpjsonServers`. For a workspace this run
 * made, that answer is the run's to give — same posture and same file handling as the daemon's
 * `preTrustClaudeProject` (lib/claudeTrust.ts): only add, never touch a shape we did not expect.
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

/** The log's lines right now (empty when it does not exist yet). */
export function readLog(cwd: string, kind: LogKind): string[] {
  try {
    return readFileSync(logPath(cwd, kind), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
