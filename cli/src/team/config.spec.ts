import { describe, expect, it } from 'vitest'
import type { TeamConfig } from './config.js'
import { isTeamAccount, teamConfigFile } from './config.js'
import { TEAM_CONFIG_FILE } from './layout.js'

describe('the Team config file, by platform', () => {
  // isTeamDaemon (superTabs/teamDaemon.ts) and readTeamConfig must look in the same place on every platform: looking
  // only at the Mac's path, a Linux or Windows Team daemon was never taken for one, and its guard was never installed.
  it('is the Mac\'s on macOS, and where the layout puts it on Linux and Windows', () => {
    expect(teamConfigFile('darwin')).toBe(TEAM_CONFIG_FILE)
    expect(teamConfigFile('linux')).toBe('/etc/harness/team.json')
    expect(teamConfigFile('win32')).toBe('C:\\ProgramData\\Harness\\team.json')
  })
})

describe('whether this process is the Team account', () => {
  // The Buddy folder check (lib/swarmSkills.ts) reads the account through this, so specs set it and never the real macOS user.
  const config = (user: string) => (() => ({ user }) as TeamConfig)
  it('is the account the root-owned config names, and no other, and not one that cannot be read', () => {
    expect(isTeamAccount(config('harness-team'), () => 'harness-team')).toBe(true)
    expect(isTeamAccount(config('harness-team'), () => 'ken')).toBe(false)
    expect(isTeamAccount(() => null, () => 'ken')).toBe(false)
    expect(isTeamAccount(() => { throw new Error('no config') }, () => 'ken')).toBe(false)
    expect(isTeamAccount(config('harness-team'), () => { throw new Error('no user') })).toBe(false)
  })
})
