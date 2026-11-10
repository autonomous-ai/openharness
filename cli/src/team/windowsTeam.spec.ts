import { describe, expect, it } from 'vitest'
import {
  WINDOWS_GH_BUILDS, runWindowsPrivacyCheck, windowsGroupSids, windowsPrivacyProbes,
  windowsUnzipScript, windowsUserSid, type WindowsPrivacyDeps,
} from './windowsTeam.js'

const config = { ownerHome: 'C:\\Users\\DELL', sentinel: 'C:\\Users\\DELL\\.harness-team-privacy' }
const errno = (code: string) => Object.assign(new Error(code), { code })

describe('windowsPrivacyProbes', () => {
  it('names the Windows places, in order, by %USERPROFILE%, never by the owner\'s path', () => {
    const probes = windowsPrivacyProbes(config)
    expect(probes.map((p) => [p.item, p.kind, p.paths])).toEqual([
      ['sentinel', 'read', ['C:\\Users\\DELL\\.harness-team-privacy']],
      ['home-listing', 'list', ['C:\\Users\\DELL']],
      ['gitconfig', 'read', ['C:\\Users\\DELL\\.gitconfig']],
      ['ssh', 'list', ['C:\\Users\\DELL\\.ssh']],
      ['projects', 'list', ['source\\repos', 'code', 'Code', 'Projects', 'src', 'Documents'].map((p) => `C:\\Users\\DELL\\${p}`)],
      ['credentials', 'list', ['C:\\Users\\DELL\\AppData\\Roaming\\Microsoft\\Credentials', 'C:\\Users\\DELL\\AppData\\Local\\Microsoft\\Credentials']],
      ['chrome', 'list', ['C:\\Users\\DELL\\AppData\\Local\\Google\\Chrome\\User Data']],
      ['edge', 'list', ['C:\\Users\\DELL\\AppData\\Local\\Microsoft\\Edge\\User Data']],
    ])
    for (const probe of probes) expect(probe.what).not.toContain('DELL')
    expect(probes.filter((p) => p.mustExist).map((p) => p.item)).toEqual(['sentinel', 'home-listing'])
  })
})

describe('runWindowsPrivacyCheck', () => {
  const deps = (over: Partial<WindowsPrivacyDeps> = {}): WindowsPrivacyDeps => ({
    open: () => { throw errno('EPERM') }, list: () => { throw errno('EACCES') }, groupSids: () => ['S-1-5-32-545', 'S-1-1-0'], now: () => 5, ...over,
  })

  it('passes when every place is refused and the account is not an administrator', () => {
    expect(runWindowsPrivacyCheck(config, deps())).toEqual({ passed: true, checkedAt: 5 })
  })

  it('skips a place that is not there, since every account may learn a name exists (Bypass traverse checking)', () => {
    const missing = new Set(['C:\\Users\\DELL\\.gitconfig', 'C:\\Users\\DELL\\code', 'C:\\Users\\DELL\\AppData\\Local\\Google\\Chrome\\User Data'])
    const check = runWindowsPrivacyCheck(config, deps({
      open: (path) => { throw errno(missing.has(path) ? 'ENOENT' : 'EPERM') },
      list: (path) => { throw errno(missing.has(path) ? 'ENOENT' : 'EPERM') },
    }))
    expect(check.passed).toBe(true)
  })

  it('fails when the sentinel is missing or readable, naming it', () => {
    const missing = runWindowsPrivacyCheck(config, deps({ open: () => { throw errno('ENOENT') } }))
    expect(missing).toMatchObject({ passed: false, item: 'sentinel' })
    const read = runWindowsPrivacyCheck(config, deps({ open: () => undefined }))
    expect(read).toMatchObject({ passed: false, item: 'sentinel', detail: 'The team account could read the privacy sentinel in your profile.' })
  })

  it('fails on the first place the team account can list', () => {
    const check = runWindowsPrivacyCheck(config, deps({
      list: (path) => { if (path.endsWith('Edge\\User Data')) return; throw errno('EPERM') },
    }))
    expect(check).toMatchObject({ passed: false, item: 'edge' })
  })

  it('fails for an administrator, deny-only or not', () => {
    expect(runWindowsPrivacyCheck(config, deps({ groupSids: () => ['S-1-5-32-544'] }))).toMatchObject({ passed: false, item: 'standard-user' })
  })
})

describe('windowsUserSid', () => {
  it('reads the SID whoami /user prints, a name with a comma included, and nothing else', () => {
    expect(windowsUserSid('"desktop-0tfh0oj\\dell","S-1-5-21-3073114020-2660841771-734626734-1001"\r\n')).toBe('S-1-5-21-3073114020-2660841771-734626734-1001')
    expect(windowsUserSid('"CORP\\Smith, Jo","S-1-5-21-1-2-3-1105"\r\n')).toBe('S-1-5-21-1-2-3-1105')
    expect(windowsUserSid('')).toBeNull()
    expect(windowsUserSid('"x","not a sid"')).toBeNull()
  })
})

describe('windowsGroupSids', () => {
  it('reads every group SID whoami lists, a deny-only Administrators included, and a name with a comma', () => {
    const stdout = [
      '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
      '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
      '"DESKTOP\\Team, Inc","Alias","S-1-5-21-1-2-3-1009","Mandatory group, Enabled by default, Enabled group"',
      '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
      '',
    ].join('\r\n')
    expect(windowsGroupSids(stdout)).toEqual(['S-1-1-0', 'S-1-5-32-544', 'S-1-5-21-1-2-3-1009', 'S-1-16-8192'])
  })
})

describe('the gh builds for Windows', () => {
  it('are GitHub\'s zips of 2.103.3, pinned by sha256 and size', () => {
    expect(WINDOWS_GH_BUILDS.x64).toEqual({
      version: '2.103.3', archiveRoot: 'gh_2.103.3_windows_amd64', binary: 'bin\\gh.exe', format: 'zip', size: 15_197_187,
      sha256: '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0',
      url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_amd64.zip',
    })
    expect(WINDOWS_GH_BUILDS.arm64).toEqual({
      version: '2.103.3', archiveRoot: 'gh_2.103.3_windows_arm64', binary: 'bin\\gh.exe', format: 'zip', size: 13_637_549,
      sha256: '197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484',
      url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_arm64.zip',
    })
  })

  it('unpack with Expand-Archive, the paths passed as inputs, never in the script\'s text', () => {
    const unzip = windowsUnzipScript('C:\\Users\\harnessteam\\.harness\\runtime\\.gh-staging-1\\gh.zip', 'C:\\Users\\harnessteam\\.harness\\runtime\\gh_2.103.3_windows_amd64')
    expect(unzip.script).toBe('Expand-Archive -LiteralPath $env:HARNESS_ARCHIVE -DestinationPath $env:HARNESS_INTO -Force')
    expect(unzip.inputs).toEqual({ HARNESS_ARCHIVE: 'C:\\Users\\harnessteam\\.harness\\runtime\\.gh-staging-1\\gh.zip', HARNESS_INTO: 'C:\\Users\\harnessteam\\.harness\\runtime\\gh_2.103.3_windows_amd64' })
  })
})
