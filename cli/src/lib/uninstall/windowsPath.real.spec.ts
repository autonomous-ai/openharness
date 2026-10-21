import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runPowershell } from '../windows/powershell.js'
import { ANNOUNCE_ENVIRONMENT_CHANGE, removeUserPathEntry, WRITE_USER_PATH } from './windowsPath.js'

/**
 * The real registry, on Windows only, and never the person's environment: a `Path` value in a key of this test's own,
 * HKCU\Software\HarnessTest\<pid>. HARNESS_UNINSTALL_ENV_KEY points there for the whole file, so a case that forgot
 * its key would still not reach HKCU\Environment.
 */
const root = 'Software\\HarnessTest'
const key = `${root}\\${process.pid}`
const bin = `${process.env.USERPROFILE}\\.harness\\bin`

const clear = () => {
  const done = runPowershell('[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:HARNESS_TEST_ROOT, $false)', { HARNESS_TEST_ROOT: root })
  expect(done.status, done.stderr).toBe(0)
}

/** Sets value Path of [where] to [value], of [kind]. */
function set(value: string, kind: 'String' | 'ExpandString', where = key): void {
  const done = runPowershell(
    '$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:HARNESS_TEST_KEY); $k.SetValue(\'Path\', $env:HARNESS_TEST_VALUE, [Microsoft.Win32.RegistryValueKind]$env:HARNESS_TEST_KIND); $k.Close()',
    { HARNESS_TEST_KEY: where, HARNESS_TEST_VALUE: value, HARNESS_TEST_KIND: kind },
  )
  expect(done.status, done.stderr).toBe(0)
}

/** Value Path of [where], raw, then `|` and its kind; `none` when it is not there. */
function get(where = key): string {
  const done = runPowershell(
    "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:HARNESS_TEST_KEY); $v = if ($k) { $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames') } else { $null }; if ($null -eq $v) { [Console]::Out.Write('none') } else { [Console]::Out.Write($v + '|' + $k.GetValueKind('Path')) }",
    { HARNESS_TEST_KEY: where },
  )
  expect(done.status, done.stderr).toBe(0)
  return done.stdout
}

// A ceiling, not a timing check: each case starts Windows PowerShell (and Add-Type compiles), ~5 s on windows-latest.
describe.runIf(process.platform === 'win32')('removeUserPathEntry on this account', { timeout: 60_000 }, () => {
  const guard = process.env.HARNESS_UNINSTALL_ENV_KEY
  beforeAll(() => { clear(); process.env.HARNESS_UNINSTALL_ENV_KEY = key })
  beforeEach(() => { process.env.HARNESS_UNINSTALL_ENV_KEY = key })
  afterAll(() => {
    if (guard === undefined) delete process.env.HARNESS_UNINSTALL_ENV_KEY
    else process.env.HARNESS_UNINSTALL_ENV_KEY = guard
    clear()
  })

  it('ends a script with exit 1 and the bare message at its first error, .NET or cmdlet', () => {
    const thrown = runPowershell("[Console]::Out.Write('before'); [void][System.IO.File]::ReadAllText('C:\\harness-no-such-folder\\x'); [Console]::Out.Write('after')")
    expect(thrown.status).toBe(1)
    expect(thrown.stdout).toBe('before')
    expect(thrown.stderr).toBe("Could not find a part of the path 'C:\\harness-no-such-folder\\x'.")
    expect(thrown.stderr).not.toContain('CLIXML')
    const cmdlet = runPowershell("Get-Item -LiteralPath 'C:\\harness-no-such-folder'; [Console]::Out.Write('after')")
    expect(cmdlet.status).toBe(1)
    expect(cmdlet.stdout).toBe('')
    expect(cmdlet.stderr).toMatch(/^Cannot find path 'C:\\harness-no-such-folder' because it does not exist\.$/)
  })

  it('removes the folder from an ExpandString value and keeps its other entries unexpanded', () => {
    set('%USERPROFILE%\\x;%USERPROFILE%\\.harness\\bin', 'ExpandString')
    expect(removeUserPathEntry(bin, runPowershell, process.env, 'Path', key)).toEqual({ state: 'removed', folder: bin })
    expect(get()).toBe('%USERPROFILE%\\x|ExpandString')
  })

  it('removes it from a REG_SZ value, which stays REG_SZ', () => {
    set(`C:\\tools;${bin}\\;D:\\x`, 'String')
    expect(removeUserPathEntry(bin, runPowershell, process.env, 'Path', key)).toEqual({ state: 'removed', folder: bin })
    expect(get()).toBe('C:\\tools;D:\\x|String')
  })

  it('deletes the value when the folder was all it held', () => {
    set('%USERPROFILE%\\.harness\\bin', 'ExpandString')
    expect(removeUserPathEntry(bin, runPowershell, process.env, 'Path', key)).toEqual({ state: 'removed', folder: bin })
    expect(get()).toBe('none')
  })

  it('removes a folder under a non-ASCII profile, and keeps a non-ASCII entry byte for byte', () => {
    const profile = 'C:\\Users\\J\u00f6 \u65e5'
    const kept = `${profile}\\tools`
    set(`${kept};${profile}\\.harness\\bin`, 'ExpandString')
    expect(removeUserPathEntry(`${profile}\\.harness\\bin`, runPowershell, process.env, 'Path', key).state).toBe('removed')
    expect(get()).toBe(`${kept}|ExpandString`)
  })

  it('leaves the value as another program left it when it changed between the read and the write', () => {
    set(`C:\\tools;${bin}`, 'String')
    const racing = (script: string, inputs: Record<string, string> = {}) => {
      if (script === WRITE_USER_PATH) set(`C:\\tools;${bin};C:\\new`, 'String')
      return runPowershell(script, inputs)
    }
    expect(removeUserPathEntry(bin, racing, process.env, 'Path', key)).toEqual({
      state: 'failed', folder: bin, detail: 'your PATH changed while Harness was removing its folder, so Harness left it as it was',
    })
    expect(get()).toBe(`C:\\tools;${bin};C:\\new|String`)
  })

  it('takes a value that differs only by a soft hyphen as changed, and leaves it', () => {
    // -cne compares by culture and calls these equal; the write compares ordinally.
    set(`C:\\tools;${bin}`, 'String')
    const hyphened = `C:\\to\u00adols;${bin}`
    const racing = (script: string, inputs: Record<string, string> = {}) => {
      if (script === WRITE_USER_PATH) set(hyphened, 'String')
      return runPowershell(script, inputs)
    }
    expect(removeUserPathEntry(bin, racing, process.env, 'Path', key)).toEqual({
      state: 'failed', folder: bin, detail: 'your PATH changed while Harness was removing its folder, so Harness left it as it was',
    })
    expect(get()).toBe(`${hyphened}|String`)
  })

  it('writes nothing when it is not told what to do', () => {
    set(bin, 'String')
    const done = runPowershell(WRITE_USER_PATH, { HARNESS_PATH_KEY: key, HARNESS_PATH_NAME: 'Path', HARNESS_PATH_KIND: 'String', HARNESS_PATH_EXPECTED: bin })
    expect(done.status).toBe(1)
    expect(done.stderr).toBe("no PATH action was given ('')")
    expect(get()).toBe(`${bin}|String`)
  })

  it('goes to HARNESS_UNINSTALL_ENV_KEY, never to Environment, when a test forgets its key or names another', () => {
    const guarded = `${key}\\guarded`
    process.env.HARNESS_UNINSTALL_ENV_KEY = guarded
    set(`C:\\tools;${bin}`, 'String', guarded)
    set(`C:\\tools;${bin}`, 'String')
    expect(removeUserPathEntry(bin, runPowershell, process.env).state).toBe('removed')
    expect(get(guarded)).toBe('C:\\tools|String')
    set(`C:\\tools;${bin}`, 'String', guarded)
    expect(removeUserPathEntry(bin, runPowershell, process.env, 'Path', key).state).toBe('removed')
    expect(get(guarded)).toBe('C:\\tools|String')
    expect(get()).toBe(`C:\\tools;${bin}|String`)
  })

  it('fails, and reads nothing, when HARNESS_UNINSTALL_ENV_KEY names a key outside Software\\HarnessTest or one that is not there', () => {
    // A folder on no PATH: even a guard that let Environment through would find nothing to write.
    const nowhere = 'C:\\harness-guard-test-not-on-any-path'
    for (const stray of ['Environment', 'Software\\Other', 'Software\\HarnessTest', 'Software\\HarnessTestX\\1']) {
      process.env.HARNESS_UNINSTALL_ENV_KEY = stray
      expect(removeUserPathEntry(nowhere, runPowershell, process.env)).toEqual({
        state: 'failed', folder: nowhere,
        detail: `could not read your PATH (HARNESS_UNINSTALL_ENV_KEY is for tests, and must name a key under Software\\HarnessTest (it is '${stray}'))`,
      })
    }
    process.env.HARNESS_UNINSTALL_ENV_KEY = `${key}\\missing`
    expect(removeUserPathEntry(nowhere, runPowershell, process.env)).toEqual({
      state: 'failed', folder: nowhere, detail: 'could not read your PATH (HARNESS_UNINSTALL_ENV_KEY is for tests; its key does not exist)',
    })
    const write = runPowershell(WRITE_USER_PATH, { HARNESS_PATH_KEY: key, HARNESS_PATH_NAME: 'Path', HARNESS_PATH_ACTION: 'delete', HARNESS_PATH_KIND: 'String', HARNESS_PATH_EXPECTED: 'x' })
    expect([write.status, write.stderr]).toEqual([1, 'HARNESS_UNINSTALL_ENV_KEY is for tests; its key does not exist'])
  })

  it('announces a change in the environment without a note', () => {
    // A broadcast with nothing changed in HKCU\Environment: Explorer reads the same values again.
    const done = runPowershell(ANNOUNCE_ENVIRONMENT_CHANGE)
    expect(done.status, done.stderr).toBe(0)
    expect(done.stdout).toBe('')
  })
})
