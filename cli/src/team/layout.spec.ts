import { describe, expect, it } from 'vitest'
import {
  TEAM_CONFIG_FILE, TEAM_HOME, TEAM_LABEL, TEAM_PLIST, TEAM_SHARED_DIR, TEAM_SHARED_MARK, TEAM_STATUS_DIR, TEAM_STATUS_FILE,
  checkPath, teamLayout,
} from './layout.js'

describe('teamLayout', () => {
  it('holds today\'s macOS values on darwin', () => {
    const mac = teamLayout('darwin')!
    expect(mac.platform).toBe('darwin')
    expect(mac.home).toBe(TEAM_HOME)
    expect(mac.home).toBe('/Users/harnessteam')
    expect(mac.sharedDir).toBe(TEAM_SHARED_DIR)
    expect(mac.sharedMark).toBe(TEAM_SHARED_MARK)
    expect(mac.configFile).toBe(TEAM_CONFIG_FILE)
    expect(mac.statusDir).toBe(TEAM_STATUS_DIR)
    expect(mac.statusFile).toBe(TEAM_STATUS_FILE)
    expect(mac.service).toEqual({ kind: 'launchd', label: TEAM_LABEL, file: TEAM_PLIST })
    expect(mac.relayDir('owner-placeholder')).toBe('/Users/Shared/.harness-team-relay-owner-placeholder')
    expect(mac.group).toBe('staff')
  })

  it('holds the Linux places on linux', () => {
    expect({ ...teamLayout('linux')!, relayDir: undefined }).toEqual({
      platform: 'linux',
      home: '/home/harnessteam',
      sharedDir: '/etc/harness',
      sharedMark: '/etc/harness/.made-by-harness-team-setup',
      configFile: '/etc/harness/team.json',
      statusDir: '/var/lib/harness/team',
      statusFile: '/var/lib/harness/team/status.json',
      service: { kind: 'systemd', label: 'harness-team.service', file: '/etc/systemd/system/harness-team.service' },
      relayDir: undefined,
      group: 'harnessteam',
    })
    expect(teamLayout('linux')!.relayDir('owner-placeholder')).toBe('/var/lib/harness/team-relay-owner-placeholder')
  })

  it('is null on a platform with no Harness Team account', () => {
    expect(teamLayout('freebsd')).toBeNull()
    expect(teamLayout('aix')).toBeNull()
  })

  it('passes its own POSIX paths through checkPath', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const layout = teamLayout(platform)!
      for (const path of [layout.home, layout.sharedDir, layout.sharedMark, layout.configFile, layout.statusDir, layout.statusFile,
        layout.service.file, layout.relayDir('owner-placeholder')]) expect(checkPath(path)).toBe(path)
    }
  })
})
