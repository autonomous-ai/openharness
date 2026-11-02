import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inheritedAccountDataFolder } from './homeDataFolder.js'

const ACCOUNT = '/Users/real'
const REAL_DATA = '/Users/real/.harness/cli/data'

describe('an ADAPTER_DATA_DIR inherited from the account under another HOME', () => {
  it('is recognised: the account\'s own folder while HOME is a throwaway', () => {
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway', ADAPTER_DATA_DIR: REAL_DATA }, ACCOUNT, 'darwin')).toBe(true)
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway', ADAPTER_DATA_DIR: `${REAL_DATA}/` }, ACCOUNT, 'linux')).toBe(true)
  })

  it('is left alone under the account\'s own HOME', () => {
    expect(inheritedAccountDataFolder({ HOME: ACCOUNT, ADAPTER_DATA_DIR: REAL_DATA }, ACCOUNT, 'darwin')).toBe(false)
  })

  it('is left alone when it names a folder of its own choosing', () => {
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway', ADAPTER_DATA_DIR: '/tmp/throwaway/data' }, ACCOUNT, 'darwin')).toBe(false)
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway', ADAPTER_DATA_DIR: '/Users/real/.harnessx/data' }, ACCOUNT, 'darwin')).toBe(false)
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway', ADAPTER_DATA_DIR: '/Users/real/.harness' }, ACCOUNT, 'darwin')).toBe(false)
  })

  it('needs both a HOME and a variable, and is not decided on Windows', () => {
    expect(inheritedAccountDataFolder({ ADAPTER_DATA_DIR: REAL_DATA }, ACCOUNT, 'darwin')).toBe(false)
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway' }, ACCOUNT, 'darwin')).toBe(false)
    expect(inheritedAccountDataFolder({ HOME: '/tmp/throwaway', ADAPTER_DATA_DIR: REAL_DATA }, ACCOUNT, 'win32')).toBe(false)
  })
})

describe('real locations', () => {
  it('a HOME that links to the account home is the account home, and a deliberate folder there stays', () => {
    const base = mkdtempSync(join(tmpdir(), 'home-data-folder-'))
    try {
      const account = join(base, 'account')
      mkdirSync(join(account, '.harness', 'cli', 'data'), { recursive: true })
      const link = join(base, 'link')
      symlinkSync(account, link)
      expect(inheritedAccountDataFolder({ HOME: link, ADAPTER_DATA_DIR: join(account, '.harness', 'cli', 'data') }, account, 'darwin')).toBe(false)
      expect(inheritedAccountDataFolder({ HOME: join(base, 'other'), ADAPTER_DATA_DIR: join(link, '.harness', 'cli', 'data') }, account, 'darwin')).toBe(true)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
})

describe('config/startHome', () => {
  const saved = { argv: process.argv, data: process.env.ADAPTER_DATA_DIR, home: process.env.HOME }
  afterEach(() => {
    process.argv = saved.argv
    if (saved.data === undefined) delete process.env.ADAPTER_DATA_DIR; else process.env.ADAPTER_DATA_DIR = saved.data
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home
    vi.doUnmock('node:os')
    vi.resetModules()
  })

  async function load(command: string): Promise<string | undefined> {
    vi.resetModules()
    vi.doMock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), userInfo: () => ({ homedir: ACCOUNT }) }))
    process.argv = ['node', 'cli.js', command]
    process.env.HOME = '/tmp/throwaway'
    process.env.ADAPTER_DATA_DIR = REAL_DATA
    await import('../config/startHome.js')
    return process.env.ADAPTER_DATA_DIR
  }

  it('start under a throwaway HOME drops the inherited folder, so the data folder follows HOME', async () => {
    expect(await load('start')).toBeUndefined()
  })

  it.each(['stop', 'logout', 'update', 'reset'])('%s follows HOME too, and says it dropped the variable', async (command) => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await load(command)).toBeUndefined()
    expect(said).toHaveBeenCalledWith(expect.stringContaining('ignoring ADAPTER_DATA_DIR='))
    said.mockRestore()
  })

  it('a command an agent reaches its own daemon with keeps the variable', async () => {
    expect(await load('super-tab')).toBe(REAL_DATA)
  })
})
