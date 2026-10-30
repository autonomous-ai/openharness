import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launch } from '../claude/launch.js'
import { recordInheritedMcp } from './inheritedMcp.js'

const contract = launch.inheritedMcp!
let home: string
let userHome: string
let folder: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'inherited-mcp-')))
  userHome = join(home, '.claude')
  folder = join(home, 'harnesses', 'snake-game')
  mkdirSync(folder, { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const write = (path: string, value: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
const local = () => JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')) as Record<string, unknown>

describe('the MCP servers a folder Harness made inherits from above', () => {
  it('records Claude Code\'s own default, "continue without", for a server in the home\'s .mcp.json, as Enter would', () => {
    write(join(home, '.mcp.json'), { mcpServers: { argent: { command: 'argent' } } })
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual(['argent'])
    expect(local()).toEqual({ disabledMcpjsonServers: ['argent'] })
    expect(statSync(join(folder, '.claude', 'settings.local.json')).mode & 0o777).toBe(0o600)
    // Asked once: a second launch there finds it decided.
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual([])
    expect(local()).toEqual({ disabledMcpjsonServers: ['argent'] })
  })

  it('takes every folder above, once a name, and never the folder\'s own file', () => {
    write(join(home, '.mcp.json'), { mcpServers: { argent: {}, shared: {} } })
    write(join(home, 'harnesses', '.mcp.json'), { mcpServers: { shared: {}, notes: {} } })
    write(join(folder, '.mcp.json'), { mcpServers: { mine: {} } })
    expect(recordInheritedMcp(contract, folder, userHome).sort()).toEqual(['argent', 'notes', 'shared'])
    expect((local().disabledMcpjsonServers as string[]).sort()).toEqual(['argent', 'notes', 'shared'])
  })

  it('leaves a server the person decided in their user settings, and everything when they approve all', () => {
    write(join(home, '.mcp.json'), { mcpServers: { argent: {}, off: {}, other: {} } })
    write(join(userHome, 'settings.json'), { enabledMcpjsonServers: ['argent'], disabledMcpjsonServers: ['off'] })
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual(['other'])
    rmSync(join(folder, '.claude'), { recursive: true })
    write(join(userHome, 'settings.json'), { enableAllProjectMcpServers: true })
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual([])
  })

  it('keeps what the folder\'s settings say, and changes nothing it cannot read', () => {
    write(join(home, '.mcp.json'), { mcpServers: { argent: {}, extra: {} } })
    write(join(folder, '.claude', 'settings.local.json'), { model: 'haiku', disabledMcpjsonServers: ['extra'] })
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual(['argent'])
    expect(local()).toEqual({ model: 'haiku', disabledMcpjsonServers: ['extra', 'argent'] })
    // A settings file that is not an object, or an unreadable .mcp.json, is left as it is.
    write(join(folder, '.claude', 'settings.local.json'), '[1]')
    write(join(home, '.mcp.json'), { mcpServers: { more: {} } })
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual([])
    expect(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')).toBe('[1]')
    rmSync(join(folder, '.claude'), { recursive: true })
    write(join(home, '.mcp.json'), '{ not json')
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual([])
    write(join(home, '.mcp.json'), { mcpServers: ['argent'] })
    expect(recordInheritedMcp(contract, folder, userHome)).toEqual([])
  })
})
