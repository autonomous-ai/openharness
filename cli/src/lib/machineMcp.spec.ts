import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { machineMcpArgs, machineMcpFor, machineMcpLaunchArgs, parseMachineMcp, readMachineMcp, writeMachineMcp, type MachineMcpServers } from './machineMcp.js'

const lamp = (over: Partial<MachineMcpServers[string]> = {}): MachineMcpServers[string] =>
  ({ command: 'lamp-mcp', args: ['--lamp', 'lamp-75c9'], engines: [], projects: [], ...over })

describe('machine MCP servers (#1872)', () => {
  it('attaches a stdio server to Claude Code in the one-token form, beside the person\'s own', () => {
    const args = machineMcpArgs('claude', { lamp: lamp() })
    expect(args).toEqual([`--mcp-config=${JSON.stringify({ mcpServers: { lamp: { type: 'stdio', command: 'lamp-mcp', args: ['--lamp', 'lamp-75c9'] } } })}`])
    // Variadic `--mcp-config <configs...>` would swallow a first prompt after a two-token form; never strict, and no tool
    // is approved ahead of the engine's own question.
    expect(args.some((arg) => arg === '--mcp-config' || arg === '--strict-mcp-config' || arg.startsWith('--allowedTools'))).toBe(false)
  })

  it('attaches it to Codex as -c mcp_servers.<name>, with no approval mode', () => {
    expect(machineMcpArgs('codex', { lamp: lamp({ args: ['--lamp', 'lamp "x"'] }) })).toEqual([
      '-c', 'mcp_servers.lamp.command="lamp-mcp"',
      '-c', 'mcp_servers.lamp.args=["--lamp","lamp \\"x\\""]',
    ])
  })

  it('adds nothing for an engine with no path yet, and says which servers it skipped', () => {
    expect(machineMcpArgs('hermes', { lamp: lamp() })).toEqual([])
    expect(machineMcpArgs('claude', {})).toEqual([])
    expect(machineMcpFor({ lamp: lamp({ engines: ['claude', 'hermes'] }) }, 'hermes', '/x', '/home/p')).toEqual({ servers: {}, noPath: ['lamp'] })
    // An entry for every engine means every engine with a path: nothing to say at a Hermes launch.
    expect(machineMcpFor({ lamp: lamp() }, 'hermes', '/x', '/home/p')).toEqual({ servers: {}, noPath: [] })
  })

  it('chooses by engine and by Harness project folder', () => {
    const servers = { lamp: lamp({ engines: ['codex'] }), desk: lamp({ projects: ['desk'] }) }
    const names = (engine: string, cwd: string | null) => Object.keys(machineMcpFor(servers, engine, cwd, '/home/p').servers)
    expect(names('claude', '/home/p/harnesses/desk/src')).toEqual(['desk'])
    expect(names('codex', '/home/p/harnesses/other')).toEqual(['lamp'])
    expect(names('codex', '/home/p/harnesses/desk')).toEqual(['lamp', 'desk'])
    expect(names('claude', '/home/p/harnesses/desk-2')).toEqual([])
    expect(names('claude', null)).toEqual([])
  })

  it('refuses an entry out of shape, keeps a later Harness\'s engine names, and reads a file whole or not at all', () => {
    for (const [servers, says] of [
      [{ harness: lamp() }, /not harness/], [{ 'Lamp-1': lamp() }, /a name is/], [{ lamp: { ...lamp(), command: '' } }, /command/],
      [{ lamp: { ...lamp(), engines: ['nonesuch'] } }, /engine names/], [{ lamp: { ...lamp(), projects: ['../x'] } }, /project names/],
    ] as const) {
      const parsed = parseMachineMcp(JSON.stringify({ servers: { ok: lamp(), ...servers } }))
      expect(parsed.ok).toBe(false)
      expect(parsed.ok ? '' : parsed.why).toMatch(says)
    }
    const later = parseMachineMcp(JSON.stringify({ servers: { lamp: { ...lamp(), engines: ['copilot'], approveTools: true, env: { A: 'b' } } } }))
    expect(later).toEqual({ ok: true, servers: { lamp: lamp({ engines: ['copilot'] }) } })
    expect(parseMachineMcp('{not json').ok).toBe(false)
    expect(parseMachineMcp(JSON.stringify({ servers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, lamp()])) })).ok).toBe(false)
  })

  it('writes the file whole and the person\'s alone, and a launch reads it; one others could write, or that does not parse, adds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'machine-mcp-'))
    const file = join(dir, 'mcp-servers.json')
    expect(machineMcpLaunchArgs('claude', '/x', dir)).toEqual([])
    writeMachineMcp({ lamp: lamp() }, dir)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readMachineMcp(dir).servers.lamp.command).toBe('lamp-mcp')
    expect(machineMcpLaunchArgs('codex', '/x', dir)[1]).toBe('mcp_servers.lamp.command="lamp-mcp"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (process.platform !== 'win32') {
      chmodSync(file, 0o664)
      expect(readMachineMcp(dir).why).toMatch(/writable by others \(mode 664\): chmod 600 it/)
      expect(machineMcpLaunchArgs('codex', '/x', dir)).toEqual([])
      chmodSync(file, 0o600)
    }
    writeFileSync(file, readFileSync(file, 'utf8').replace('"lamp-mcp"', '""'))
    expect(readMachineMcp(dir).why).toMatch(/command/)
    expect(machineMcpLaunchArgs('codex', '/x', dir)).toEqual([])
    expect(warn.mock.calls.at(-1)?.[0]).toMatch(/^\[agent\] machine MCP servers not added · /)
    warn.mockRestore()
  })
})
