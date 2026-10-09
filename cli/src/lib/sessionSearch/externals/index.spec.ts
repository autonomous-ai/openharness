import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { env } from '../../../config/env.js'
import { loadEngine } from '../../../engines/inProcess.js'
import { scanMemo } from './support.js'
import { externalPaths, externalProviders } from './index.js'
import { EXTERNAL_ENGINES, type ProcessView } from './types.js'

// The other engines' readers are their own code, loaded on first use; a test may say one could not be.
vi.mock('../../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})

describe('where each engine keeps its conversations', () => {
  it("follows each engine's own overrides before Harness's defaults", () => {
    const paths = externalPaths({
      CURSOR_CONFIG_DIR: '/cfg/cursor', CURSOR_DATA_DIR: '/data/cursor',
      OPENCODE_DB: '/db/opencode.db', KILO_DB: 'kilo-dev.db',
      PI_CODING_AGENT_DIR: '/pi/agent', PI_CODING_AGENT_SESSION_DIR: '/pi/moved',
    })
    expect(paths).toMatchObject({
      cursorConfigDir: '/cfg/cursor', cursorDataDir: '/data/cursor',
      opencodeDb: '/db/opencode.db', kiloDb: join(env.KILO_DATA_DIR, 'kilo-dev.db'),
      piAgentDir: '/pi/agent', piSessionDir: '/pi/moved',
    })
  })

  it("uses the defaults where nothing is overridden, and XDG for Cursor's chats", () => {
    const paths = externalPaths({ XDG_CONFIG_HOME: '/xdg', OPENCODE_DB: ':memory:' })
    expect(paths).toMatchObject({
      claudeProjectsDir: env.CLAUDE_PROJECTS_DIR, codexHome: env.CODEX_HOME,
      cursorConfigDir: '/xdg/cursor', cursorDataDir: env.CURSOR_HOME,
      opencodeDb: join(env.OPENCODE_DATA_DIR, 'opencode.db'), kiloDb: join(env.KILO_DATA_DIR, 'kilo.db'),
      piAgentDir: join(env.PI_HOME, 'agent'),
    })
    expect(paths.piSessionDir).toBeUndefined()
    expect(externalPaths({}).cursorConfigDir).toBe(env.CURSOR_HOME)
    expect(externalPaths({ CURSOR_CONFIG_DIR: '  ', XDG_CONFIG_HOME: ' ', CURSOR_DATA_DIR: '' })).toMatchObject({
      cursorConfigDir: env.CURSOR_HOME, cursorDataDir: env.CURSOR_HOME,
    })
    // The process's own environment by default.
    expect(externalPaths().codexHome).toBe(env.CODEX_HOME)
  })

  it('has one provider per engine that keeps its conversations on disk, Kilo through OpenCode’s', () => {
    const engines = externalProviders(externalPaths({ PI_CODING_AGENT_SESSION_DIR: '/pi/moved' })).map((provider) => provider.engine)
    expect([...engines].sort()).toEqual([...EXTERNAL_ENGINES].sort())
    expect(externalProviders().length).toBe(EXTERNAL_ENGINES.length)
  })
})

describe('the other engines\' readers, loaded on first use', () => {
  const none: ProcessView = { list: async () => [], openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true }
  const missing = '/nonexistent/adoption-root'
  const paths = () => externalPaths({ CURSOR_CONFIG_DIR: missing, CURSOR_DATA_DIR: missing, OPENCODE_DB: `${missing}/opencode.db`, KILO_DB: `${missing}/kilo.db`, PI_CODING_AGENT_DIR: missing })

  it('loads nothing until a scan or a question needs a reader, and each engine\'s own code once', async () => {
    vi.mocked(loadEngine).mockClear()
    const providers = externalProviders(paths())
    expect(loadEngine).not.toHaveBeenCalled()
    const cursor = providers.find((provider) => provider.engine === 'cursor')!
    await cursor.scan(scanMemo({ excluded: [] }).context())
    await cursor.owners!(none)
    await cursor.busy!({ pid: 1, record: '' })
    expect(vi.mocked(loadEngine).mock.calls).toEqual([['cursor']])
    // Kilo explicitly asks OpenCode's shared store reader; its own runtime entry stays independent.
    vi.mocked(loadEngine).mockClear()
    for (const engine of ['kilo', 'claude', 'codex']) await providers.find((provider) => provider.engine === engine)!.owners!(none)
    expect(vi.mocked(loadEngine).mock.calls).toEqual([['opencode']])
  })

  it('lists nothing and holds nothing open for an engine whose code could not be loaded', async () => {
    vi.mocked(loadEngine).mockResolvedValueOnce(null)
    const devin = externalProviders(paths()).find((provider) => provider.engine === 'devin')!
    expect(await devin.scan(scanMemo({ excluded: [] }).context())).toEqual([])
    expect(await devin.owners!(none)).toEqual([])
    expect(await devin.busy!({ pid: 1, record: '' })).toBeNull()
  })

  it('treats a reader that could not be built as that engine unavailable, said once, never as a failed scan', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const devinProvider = vi.fn(() => { throw new Error('bad store path') })
    vi.mocked(loadEngine).mockResolvedValueOnce({ devinProvider } as never)
    const devin = externalProviders(paths()).find((provider) => provider.engine === 'devin')!
    for (let scan = 0; scan < 2; scan++) expect(await devin.scan(scanMemo({ excluded: [] }).context())).toEqual([])
    expect(await devin.owners!(none)).toEqual([])
    expect(await devin.busy!({ pid: 1, record: '' })).toBeNull()
    expect(devinProvider).toHaveBeenCalledOnce()
    expect(error.mock.calls).toEqual([['[engine devin] adoption reader unavailable · bad store path']])
    error.mockRestore()
  })
})
