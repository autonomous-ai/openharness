import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { env } from '../../../config/env.js'
import { externalPaths, externalProviders } from './index.js'
import { EXTERNAL_ENGINES } from './types.js'

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
