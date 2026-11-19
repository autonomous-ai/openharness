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
