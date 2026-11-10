import { describe, expect, it } from 'vitest'
import { teamConfigFile } from './config.js'
import { TEAM_CONFIG_FILE } from './layout.js'

describe('the Team config file, by platform', () => {
  // Every platform's Team account must find its config: looking only at the Mac's path, a Linux or Windows one was never
  // found.
  it('is the Mac\'s on macOS, and where the layout puts it on Linux and Windows', () => {
    expect(teamConfigFile('darwin')).toBe(TEAM_CONFIG_FILE)
    expect(teamConfigFile('linux')).toBe('/etc/harness/team.json')
    expect(teamConfigFile('win32')).toBe('C:\\ProgramData\\Harness\\team.json')
  })
})
