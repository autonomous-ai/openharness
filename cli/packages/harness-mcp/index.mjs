/**
 * `npx -y @autonomous-ai/harness-mcp`: Harness's MCP server for clients that install servers from npm. Harness is
 * not an npm package (its installer brings its own Node and tmux, cli/scripts/install.sh), so this finds the
 * `harness` command and runs `harness mcp` in its place. Where Harness is not installed it still answers, with one
 * tool that says how to install it: an agent that found Harness in a directory can then ask its person to.
 *
 * No dependencies: it runs before anything is installed.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'

export const INSTALL = 'curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash'

/** Where `harness` is: HARNESS_BIN, else the PATH, else where the installer links it (a client may start this with
 *  a PATH that leaves out ~/.local/bin). */
export function findHarness(env = process.env, home = homedir(), executable = isExecutable) {
  const candidates = [
    env.HARNESS_BIN,
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'harness')),
    join(home, '.local', 'bin', 'harness'),
  ].filter(Boolean)
  return candidates.find((path) => executable(path)) ?? null
}

function isExecutable(path) {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

const SETUP_TEXT = (platform) => platform === 'win32'
  ? 'Harness runs on macOS and Linux. On Windows, install it inside WSL, and run this server from there.'
  : [
    'Harness is not installed on this computer. It runs coding agents (Claude Code, Codex) in sessions of their own that the person can watch, and gives you tools to start, wait for, read and close them.',
    '',
    'To install it, ask the person, then run:',
    `  ${INSTALL}`,
    '  harness start',
    '',
    'No account is needed for harnesses on this computer. Then restart this MCP server (or your client) to get the Harness tools.',
    'More: https://harness.autonomous.ai/agents',
  ].join('\n')

/** The answer to one JSON-RPC message while Harness is not installed, or null for a notification. */
export function setupAnswer(message, platform = process.platform) {
  const id = message?.id
  const isRequest = id !== undefined && id !== null
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  switch (message?.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'harness', title: 'Harness (not installed)', version: '0.1.0' },
        instructions: SETUP_TEXT(platform),
      })
    case 'ping': return reply({})
    case 'tools/list':
      return reply({ tools: [{
        name: 'harness_setup',
        description: 'Harness is not installed here. Call this for how to install it, which gives you tools to start, wait for, read and close other coding agents.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      }] })
    case 'tools/call':
      if (message.params?.name !== 'harness_setup') return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(message.params?.name)}` } }
      return reply({ content: [{ type: 'text', text: SETUP_TEXT(platform) }] })
    default:
      return isRequest ? { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message?.method)}` } } : null
  }
}

/** Serve [setupAnswer] on newline-delimited JSON-RPC until the input ends. */
export async function serveSetup(input = process.stdin, output = process.stdout, platform = process.platform) {
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      continue
    }
    const reply = setupAnswer(message, platform)
    if (reply) output.write(`${JSON.stringify(reply)}\n`)
  }
}

/** Run `harness mcp` in this process's place: its stdio, its exit, and the signals a client stops it with. */
export function runHarness(path, run = spawn) {
  return new Promise((done) => {
    const child = run(path, ['mcp'], { stdio: 'inherit' })
    const forward = (signal) => () => child.kill(signal)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward(signal))
    child.on('error', () => done(1))
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
}
