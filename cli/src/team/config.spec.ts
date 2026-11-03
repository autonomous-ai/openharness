import { describe, expect, it } from 'vitest'
import { teamConfigFile } from './config.js'
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
