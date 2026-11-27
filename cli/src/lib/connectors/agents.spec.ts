/**
 * The MCP shim agents run, written into the vault's private folder: in a throwaway home, never ~/.claude or ~/.codex.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sync } from './agents.js'
import { MCP_SHIM_SOURCE } from './mcpShimSource.js'
import { Store } from './store.js'

// Pass-through, recording each path written to by name and each rename's target.
const disk = vi.hoisted(() => ({ events: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] !== 'number') disk.events.push(`write ${String(args[0])}`)
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.events.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
  }
})

let home: string
let env: NodeJS.ProcessEnv
let vault: Store
let shim: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'connector-agents-'))
  env = { HOME: home, PATH: '', XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex') }
  vault = new Store(join(home, '.harness', 'connections'), env)
  shim = join(vault.root, 'mcp-shim.mjs')
  vault.save('linear', { access_token: 'secret', source: 'dcr', mcp_entry: { url: 'https://mcp.linear.example/mcp', headers: {} } })
  // A shim an older build wrote: the next sync writes this build's.
  mkdirSync(vault.root, { recursive: true })
  writeFileSync(shim, '// an older shim\n')
  disk.events = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('the MCP shim', () => {
  it('the save goes through a temporary file renamed onto the target', () => {
    sync(vault, env, [], 'darwin')
    expect(readFileSync(shim, 'utf8')).toBe(MCP_SHIM_SOURCE)
    expect(disk.events).toContain(`rename ${shim}`)
    expect(disk.events).not.toContain(`write ${shim}`)
  })

  it('a file at the old temporary name is left alone', () => {
    const old = `${shim}.${process.pid}.tmp`
    writeFileSync(old, 'not this writer\'s')
    sync(vault, env, [], 'darwin')
    expect(readFileSync(shim, 'utf8')).toBe(MCP_SHIM_SOURCE)
    expect(readFileSync(old, 'utf8')).toBe('not this writer\'s')
  })
})

// PowerShell 5's `Set-Content -Encoding utf8` saves a config with a BOM, which Claude Code reads past; `Out-File` saves
// UTF-16, and another tool may save Latin-1. Read as UTF-8 those came back with U+FFFD in place of each byte.
describe('an agent config a Windows tool saved', () => {
  it('gives Claude Code its servers in a .claude.json saved with a BOM', () => {
    const claude = join(home, '.claude.json')
    writeFileSync(claude, `\uFEFF${JSON.stringify({ numStartups: 3 })}`)
    expect(sync(vault, env, undefined, 'darwin').claude).toEqual(['linear'])
    const data = JSON.parse(readFileSync(claude, 'utf8'))
    expect(data.numStartups).toBe(3)
    expect(Object.keys(data.mcpServers)).toEqual(['linear'])
  })

  it('leaves a .claude.json that is not UTF-8 exactly as it is', () => {
    const claude = join(home, '.claude.json'), bytes = Buffer.from('{"note":"caf\xe9"}', 'latin1')
    writeFileSync(claude, bytes)
    sync(vault, env, undefined, 'darwin')
    expect(readFileSync(claude)).toEqual(bytes)
  })

  it('leaves a config.toml that is not UTF-8 exactly as it is', () => {
    const codex = join(home, '.codex', 'config.toml'), bytes = Buffer.from('model = "caf\xe9"\n', 'latin1')
    mkdirSync(join(home, '.codex'))
    writeFileSync(codex, bytes)
    sync(vault, env, undefined, 'darwin')
    expect(readFileSync(codex)).toEqual(bytes)
  })
})
