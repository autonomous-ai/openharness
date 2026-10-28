import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readMachineMcp } from '../lib/machineMcp.js'
import { mcpServersCommand } from './mcpServers.js'

function run(argv: string[], env: NodeJS.ProcessEnv = {}, dataDir = mkdtempSync(join(tmpdir(), 'mcp-servers-'))) {
  const out: string[] = []
  const err: string[] = []
  const code = mcpServersCommand(argv, { dataDir, env, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n'), dataDir }
}

describe('harness mcp-servers (#1872)', () => {
  it('adds, lists and removes a server for the person', () => {
    const added = run(['add', 'lamp', '--engine', 'claude', '--engine', 'codex', '--', 'lamp-mcp', '--lamp', 'lamp-75c9'])
    expect(added.code).toBe(0)
    expect(added.out).toBe('lamp added: agents started from now on get it (claude, codex).')
    expect(readMachineMcp(added.dataDir).servers.lamp).toEqual({ command: 'lamp-mcp', args: ['--lamp', 'lamp-75c9'], engines: ['claude', 'codex'], projects: [] })
    expect(run([], {}, added.dataDir).out).toBe('lamp\tlamp-mcp --lamp lamp-75c9\tengines claude,codex\tprojects every folder')
    expect(run(['remove', 'lamp'], {}, added.dataDir).code).toBe(0)
    expect(readMachineMcp(added.dataDir).servers).toEqual({})
  })

  it('refuses an agent outright, even when it says the person said yes', () => {
    for (const env of [{ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, { CODEX_THREAD_ID: 't' }, { AI_AGENT: 'cursor' }]) {
      const tried = run(['add', 'lamp', '--person-said-yes', '--', 'lamp-mcp'], env)
      expect(tried.code).toBe(5)
      expect(tried.err).toMatch(/may not change this machine's MCP servers/)
      expect(readMachineMcp(tried.dataDir).servers).toEqual({})
    }
    // Listing is fine for anyone on this machine.
    expect(run(['list'], { CODEX_THREAD_ID: 't' }).code).toBe(0)
  })

  it('refuses what it cannot keep, and says the usage for what it cannot read', () => {
    expect(run(['add', 'harness', '--', 'x']).err).toMatch(/not harness/)
    expect(run(['add', 'lamp', '--engine', 'hermes', '--', 'x']).err).toBe('hermes: this Harness attaches machine MCP servers to claude and codex only, so far.')
    // No tool approval is kept: the flag is not one.
    expect(run(['add', 'lamp', '--approve-tools', '--', 'x']).code).toBe(2)
    expect(run(['add', 'lamp', 'lamp-mcp']).code).toBe(2)
    expect(run(['add', 'lamp', '--']).code).toBe(2)
    expect(run(['remove', 'nothing']).code).toBe(1)
  })
})
