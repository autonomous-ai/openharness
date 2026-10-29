import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { machineMcpArgs, readMachineMcp } from '../lib/machineMcp.js'
import { applyOpencode, CHROMIUM, DESKTOP_MCP, PLAYWRIGHT_MCP, setComputerUse, computerUseAvailable, computerUseCommand, computerUseServers, computerUseOn } from './computerUse.js'

describe('harness computer-use', () => {
  let dataDir: string
  const lines: { out: string[]; err: string[] } = { out: [], err: [] }
  const onOs = () => true
  const noOpencode = { path: '/nowhere/opencode.json', major: () => null, reload: () => {} }
  const run = (argv: string[], over: Parameters<typeof computerUseCommand>[1] = {}) => computerUseCommand(argv, {
    dataDir, home: '/home/me', exists: onOs, env: {}, inPane: false, opencode: noOpencode,
    out: (line) => lines.out.push(line), err: (line) => lines.err.push(line), ...over,
  })

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'computer-use-')); lines.out = []; lines.err = [] })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('is off until the person turns it on', () => {
    expect(run([])).toBe(0)
    expect(lines.out.join('\n')).toContain('Computer use is off')
    expect(computerUseOn(readMachineMcp(dataDir).servers)).toBe(false)
  })

  it('attaches Playwright on the OS\'s Chromium and the desktop to every agent, and takes them off again', () => {
    expect(run(['on'])).toBe(0)
    const { servers } = readMachineMcp(dataDir)
    expect(servers.playwright).toEqual({
      command: '/usr/bin/node',
      args: [PLAYWRIGHT_MCP, '--executable-path', CHROMIUM, '--isolated', '--output-dir', '/home/me/.cache/harness-os/playwright-mcp'],
      engines: [], projects: [],
    })
    expect(servers.desktop).toEqual({ command: '/usr/bin/python3', args: [DESKTOP_MCP], engines: [], projects: [] })
    expect(lines.out.at(-1)).toContain('Restart a running harness')
    // What a Claude Code launch then carries.
    expect(machineMcpArgs('claude', servers).join(' ')).toContain(PLAYWRIGHT_MCP)
    expect(run(['off'])).toBe(0)
    expect(readMachineMcp(dataDir).servers).toEqual({})
  })

  it('keeps the person\'s own servers when it turns on and off', () => {
    writeFileSync(join(dataDir, 'mcp-servers.json'), JSON.stringify({ servers: { lamp: { command: 'lamp-mcp' } } }), { mode: 0o600 })
    setComputerUse(true, dataDir, '/home/me', noOpencode)
    expect(Object.keys(readMachineMcp(dataDir).servers).sort()).toEqual(['desktop', 'lamp', 'playwright'])
    setComputerUse(false, dataDir, '/home/me', noOpencode)
    expect(Object.keys(readMachineMcp(dataDir).servers)).toEqual(['lamp'])
  })

  it('refuses an agent, and one in a Harness pane, and changes nothing', () => {
    expect(run(['on'], { env: { CLAUDECODE: '1' } })).toBe(5)
    expect(run(['on'], { inPane: true })).toBe(5)
    expect(lines.err.join('\n')).toContain('phone')
    expect(readMachineMcp(dataDir).servers).toEqual({})
    // Asking how they are is anyone's.
    expect(run([], { env: { CLAUDECODE: '1' } })).toBe(0)
  })

  it('says a computer without them has none', () => {
    expect(run(['on'], { exists: () => false })).toBe(1)
    expect(lines.err.join('\n')).toContain('Harness OS')
    expect(computerUseAvailable((path) => path !== CHROMIUM)).toBe(false)
  })

  it('does not write over a file it cannot read', () => {
    writeFileSync(join(dataDir, 'mcp-servers.json'), 'not json', { mode: 0o600 })
    expect(run(['on'])).toBe(1)
    expect(readFileSync(join(dataDir, 'mcp-servers.json'), 'utf8')).toBe('not json')
  })

  describe('OpenCode, through its own config', () => {
    const opencode = (major: number | null) => {
      const reload = vi.fn()
      return { path: join(dataDir, 'opencode', 'opencode.json'), major: () => major, reload }
    }
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

    it('puts them under mcp.servers for OpenCode 2, as `opencode mcp add` does, reloads it, and takes them out', () => {
      const oc = opencode(2)
      mkdirSync(join(dataDir, 'opencode'))
      writeFileSync(oc.path, JSON.stringify({ model: 'opencode/free', mcp: { servers: { mine: { type: 'local', command: ['mine'] } } } }))
      expect(setComputerUse(true, dataDir, '/home/me', oc)).toEqual({ on: true })
      const servers = read(oc.path).mcp.servers
      expect(servers.desktop).toEqual({ type: 'local', command: ['/usr/bin/python3', DESKTOP_MCP] })
      expect(servers.playwright.command.slice(0, 2)).toEqual(['/usr/bin/node', PLAYWRIGHT_MCP])
      expect(oc.reload).toHaveBeenCalledTimes(1)
      setComputerUse(false, dataDir, '/home/me', oc)
      expect(read(oc.path)).toEqual({ model: 'opencode/free', mcp: { servers: { mine: { type: 'local', command: ['mine'] } } } })
      expect(oc.reload).toHaveBeenCalledTimes(2)
    })

    it('puts them directly under mcp, enabled, for OpenCode 1, and leaves no empty mcp behind', () => {
      const oc = opencode(1)
      setComputerUse(true, dataDir, '/home/me', oc)
      expect(read(oc.path).mcp.desktop).toEqual({ type: 'local', command: ['/usr/bin/python3', DESKTOP_MCP], enabled: true })
      setComputerUse(false, dataDir, '/home/me', oc)
      expect(read(oc.path)).toEqual({})
    })

    it('keeps a server of the person\'s own under the same name, and says so', () => {
      const oc = opencode(2)
      mkdirSync(join(dataDir, 'opencode'))
      writeFileSync(oc.path, JSON.stringify({ mcp: { servers: { playwright: { type: 'local', command: ['npx', '@playwright/mcp'] } } } }))
      expect(setComputerUse(true, dataDir, '/home/me', oc)).toEqual({ on: true, note: expect.stringContaining('its own playwright') })
      expect(read(oc.path).mcp.servers.playwright.command).toEqual(['npx', '@playwright/mcp'])
      setComputerUse(false, dataDir, '/home/me', oc)
      expect(read(oc.path).mcp.servers).toEqual({ playwright: { type: 'local', command: ['npx', '@playwright/mcp'] } })
    })

    it('leaves a config that is not plain JSON, and one OpenCode is not installed for, alone', () => {
      const oc = opencode(2)
      mkdirSync(join(dataDir, 'opencode'))
      writeFileSync(oc.path, '{ // mine\n}')
      expect(setComputerUse(true, dataDir, '/home/me', oc)).toEqual({ on: true, note: expect.stringContaining('not plain JSON') })
      expect(readFileSync(oc.path, 'utf8')).toBe('{ // mine\n}')
      expect(oc.reload).not.toHaveBeenCalled()
      const absent = opencode(null)
      expect(applyOpencode(true, absent, '/home/me')).toBeNull()
      expect(existsSync(absent.path) && readFileSync(absent.path, 'utf8')).toContain('mine')
    })
  })

  it('answers usage for anything else', () => {
    expect(run(['maybe'])).toBe(2)
    expect(run(['on', 'now'])).toBe(2)
    expect(run(['--help'])).toBe(0)
    expect(Object.keys(computerUseServers())).toEqual(['playwright', 'desktop'])
  })
})
