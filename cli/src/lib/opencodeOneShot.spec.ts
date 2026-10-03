import { describe, expect, it } from 'vitest'
import { opencodeOneShotSpawn } from './oneshot.js'

describe('OpenCode recap isolation', () => {
  it('overrides the session database and workspace while keeping provider credentials available', () => {
    const parent = {
      OPENCODE_DB: '/real/custom.db', PWD: '/real/repository',
      XDG_DATA_HOME: '/user/data', XDG_CONFIG_HOME: '/user/config',
      TMUX: '/real/socket', TMUX_PANE: '%4',
    }
    const child = opencodeOneShotSpawn('provider/model', parent, '/scratch/recap')
    expect(child.env).toMatchObject({
      OPENCODE_DB: '/scratch/recap/opencode.db', PWD: '/scratch/recap',
      XDG_DATA_HOME: '/user/data', XDG_CONFIG_HOME: '/user/config',
    })
    expect(child.env.TMUX).toBeUndefined()
    expect(child.env.TMUX_PANE).toBeUndefined()
    expect(child.args).toEqual(['run', '--pure', '--format', 'json', '--model', 'provider/model'])
    expect(parent.OPENCODE_DB).toBe('/real/custom.db')
  })
})
