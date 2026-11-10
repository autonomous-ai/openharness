import { describe, expect, it } from 'vitest'
import { TEAM_CONFIG_FILES, TeamInputError, checkPath, checkWindowsPath, checkWindowsUser } from './layout.js'

describe('the Team config\'s place', () => {
  it('passes its own checks on every platform', () => {
    for (const platform of ['darwin', 'linux'] as const) expect(checkPath(TEAM_CONFIG_FILES[platform])).toBe(TEAM_CONFIG_FILES[platform])
    expect(checkWindowsPath(TEAM_CONFIG_FILES.win32)).toBe(TEAM_CONFIG_FILES.win32)
  })
})

describe('checkWindowsPath', () => {
  it('takes a plain absolute drive path', () => {
    for (const path of ['C:\\', 'C:\\Users\\owner-placeholder', 'D:\\Work Folder\\a_b.c@d+e', 'c:\\ProgramData\\Harness\\team.json']) {
      expect(checkWindowsPath(path)).toBe(path)
    }
  })

  it('refuses relative, UNC, .., quoted and \\\\?\\ paths', () => {
    const bad = [
      'Users\\owner', 'C:Users\\owner', '\\Users\\owner', 'C:/Users/owner', // relative, drive-relative, rooted without a drive, slashes
      '\\\\server\\share\\x', '\\\\?\\C:\\Users\\owner', '\\\\.\\C:\\x', // UNC, the long-path and device forms
      'C:\\Users\\..\\Windows', 'C:\\Users\\.\\owner', 'C:\\Users\\\\owner', 'C:\\Users\\owner\\', // .., ., an empty segment, a trailing \
      "C:\\Users\\o'brien", 'C:\\Users\\a"b', 'C:\\Users\\a$(x)', 'C:\\Users\\a`b', 'C:\\Users\\a\nb', 'C:\\Users\\a;b',
    ]
    for (const path of bad) expect(() => checkWindowsPath(path, 'home'), JSON.stringify(path)).toThrow(TeamInputError)
  })
})

describe('checkWindowsPath, for what cmd.exe expands and Windows drops', () => {
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

describe('checkWindowsUser', () => {
  it('takes a local account name, nothing else', () => {
    expect(checkWindowsUser('DELL')).toBe('DELL')
    expect(checkWindowsUser('Jo Smith')).toBe('Jo Smith')
    for (const name of ['', ' x', 'x ', 'a.', "o'brien", 'a\\b', 'DOMAIN\\x', 'a@b', 'x'.repeat(21), 'a"b', 'a%b']) {
      expect(() => checkWindowsUser(name), name).toThrow(/not a usable/)
    }
  })
})
