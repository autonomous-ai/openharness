import { machineMcpArgs } from './machineMcp.js'

/**
 * The launch argv that gives a browser agent its `browser` MCP server, `harness browser-mcp`. The relay finds its agent
 * by its pane, so the arguments are the same for every agent and carry no id.
 *
 * Claude Code: no `--allowedTools`; the spike measured that `--permission-mode auto`, a Swarm agent's default, runs MCP
 * tools without a prompt. Codex: command and args only, as its approval of MCP tools was not measured.
 */
export function browserMcpArgs(engine: 'claude' | 'codex', harnessPath: string): string[] {
  return machineMcpArgs(engine, { browser: { command: harnessPath, args: ['browser-mcp'], engines: [], projects: [] } })
}
