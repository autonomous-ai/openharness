import { describe, expect, it } from 'vitest'
import {
  WINDOWS_TEAM_CONFIG_FILE, WINDOWS_TEAM_HANDOFF_DIR, WINDOWS_TEAM_HANDOFF_FILE, WINDOWS_TEAM_HOME, WINDOWS_TEAM_SHARED_DIR,
  WINDOWS_TEAM_SHARED_MARK, WINDOWS_TEAM_STATUS_DIR, WINDOWS_TEAM_STATUS_FILE, WINDOWS_TEAM_TASK, WINDOWS_TEAM_TASK_NAME,
  WINDOWS_TEAM_TASK_PATH, checkSid, checkWindowsPath, checkWindowsUser, windowsTeamPaths, windowsTeamRelayDir,
} from './windowsLayout.js'

describe('the Windows layout', () => {
  it('holds the Windows plan\'s table', () => {
    expect(WINDOWS_TEAM_HOME).toBe('C:\\Users\\harnessteam')
    expect(WINDOWS_TEAM_SHARED_DIR).toBe('C:\\ProgramData\\Harness')
    expect(WINDOWS_TEAM_SHARED_MARK).toBe('C:\\ProgramData\\Harness\\.made-by-harness-team-setup')
    expect(WINDOWS_TEAM_CONFIG_FILE).toBe('C:\\ProgramData\\Harness\\team.json')
    expect(WINDOWS_TEAM_STATUS_DIR).toBe('C:\\ProgramData\\Harness\\Team')
    expect(WINDOWS_TEAM_STATUS_FILE).toBe('C:\\ProgramData\\Harness\\Team\\status.json')
    expect(WINDOWS_TEAM_HANDOFF_DIR).toBe('C:\\ProgramData\\Harness\\Team\\handoff')
    expect(WINDOWS_TEAM_HANDOFF_FILE).toBe('C:\\ProgramData\\Harness\\Team\\handoff\\team-handoff')
    expect(WINDOWS_TEAM_TASK_PATH).toBe('\\Harness\\')
    expect(WINDOWS_TEAM_TASK_NAME).toBe('Harness Team')
    expect(WINDOWS_TEAM_TASK).toBe('\\Harness\\Harness Team')
    expect(windowsTeamRelayDir('DELL')).toBe('C:\\ProgramData\\Harness\\team-relay-DELL')
  })

  it('keeps the team account\'s own files in its profile, as on a Mac', () => {
    const paths = windowsTeamPaths()
    expect(paths.cliJs).toBe('C:\\Users\\harnessteam\\.harness\\cli\\cli.js')
    expect(paths.data).toBe('C:\\Users\\harnessteam\\.harness\\cli\\data')
    expect(paths.log).toBe('C:\\Users\\harnessteam\\.harness\\cli\\data\\harness.log')
    expect(paths.runtime).toBe('C:\\Users\\harnessteam\\.harness\\runtime')
    expect(paths.computerId).toBe('C:\\Users\\harnessteam\\.harness\\computer-id')
    expect(paths.npmPrefix).toBe('C:\\Users\\harnessteam\\.local')
    expect(paths.bin).toBe('C:\\Users\\harnessteam\\.local\\bin')
  })
})

describe('checkWindowsPath', () => {
  it('accepts a plain absolute drive path', () => {
    for (const path of ['C:\\Users\\harnessteam', 'C:\\ProgramData\\Harness\\team.json', 'D:\\Users\\Jo Smith\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe', 'C:\\']) {
      expect(checkWindowsPath(path)).toBe(path)
    }
  })

  it('refuses relative, UNC, .., quote and \\\\?\\ paths', () => {
    for (const path of [
      'Users\\harnessteam', '\\Users\\harnessteam', 'C:Users', 'C:/Users/harnessteam', '\\\\server\\share\\x', '\\\\?\\C:\\Users',
      '\\\\.\\C:\\Users', 'C:\\Users\\..\\Windows', 'C:\\Users\\.\\x', "C:\\Users\\o'brien", 'C:\\Users\\x\\', 'C:\\Users\\\\x',
      'C:\\Users\\x%PATH%', 'C:\\Users\\a&b', 'C:\\Users\\a"b', 'C:\\Users\\a\nb', 'C:\\Users\\x.', 'C:\\Users\\x ', 'C:\\Users\\a:b',
      'C:\\Users\\J\u00f6', `C:\\${'a'.repeat(260)}`, '',
    ]) {
      expect(() => checkWindowsPath(path, 'test path'), path).toThrow(/test path must be a plain absolute Windows path/)
    }
  })
})

describe('checkWindowsUser and checkSid', () => {
  it('take a local account name and a SID, nothing else', () => {
    expect(checkWindowsUser('DELL')).toBe('DELL')
    expect(checkWindowsUser('Jo Smith')).toBe('Jo Smith')
    for (const name of ['', ' x', 'x ', 'a.', "o'brien", 'a\\b', 'DOMAIN\\x', 'a@b', 'x'.repeat(21), 'a"b', 'a%b']) {
      expect(() => checkWindowsUser(name), name).toThrow(/not a usable/)
    }
    expect(checkSid('S-1-5-21-3073114020-2660841771-734626734-1001')).toBe('S-1-5-21-3073114020-2660841771-734626734-1001')
    for (const sid of ['', 'S-1', 'S-1-5-', 's-1-5-18', "S-1-5-18'", 'S-1-5-18 ']) expect(() => checkSid(sid), sid).toThrow(/not a SID/)
  })
})
