import { describe, expect, it } from 'vitest'
import { encodedCommandArgs, powershellPath, withPrelude, type PowershellResult } from '../windows/powershell.js'
import { expandWindowsVariables, PATH_UNANNOUNCED_NOTE, READ_USER_PATH, removeUserPathEntry, withoutPathEntry, WRITE_USER_PATH } from './windowsPath.js'

const env = { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
const bin = 'C:\\Users\\u\\.harness\\bin'

describe('withoutPathEntry', () => {
  it('drops the folder however it was written, and keeps every other entry as written', () => {
    expect(withoutPathEntry(`%LOCALAPPDATA%\\Microsoft\\WindowsApps;${bin};C:\\tools`, bin, env))
      .toBe('%LOCALAPPDATA%\\Microsoft\\WindowsApps;C:\\tools')
    expect(withoutPathEntry('C:\\tools;%USERPROFILE%\\.harness\\bin', bin, env)).toBe('C:\\tools')
    expect(withoutPathEntry('C:\\tools;"c:\\users\\U\\.HARNESS\\bin\\";;D:\\x', bin, env)).toBe('C:\\tools;;D:\\x')
  })

  it('drops every entry that names the folder, and one written with forward slashes', () => {
    expect(withoutPathEntry(`${bin};C:\\tools;%USERPROFILE%\\.harness\\bin\\;D:\\x`, bin, env)).toBe('C:\\tools;D:\\x')
    expect(withoutPathEntry('C:\\tools;C:/Users/u/.harness/bin/', bin, env)).toBe('C:\\tools')
  })

  it('is null when the folder is not there, and empty when it was the only entry', () => {
    expect(withoutPathEntry('C:\\tools;C:\\Users\\u\\.harness\\bin2', bin, env)).toBeNull()
    expect(withoutPathEntry(bin, bin, env)).toBe('')
  })

  it('reads %NAME% as Windows does, and leaves a name it does not know', () => {
    expect(expandWindowsVariables('%userprofile%\\x;%NOPE%\\y', env)).toBe('C:\\Users\\u\\x;%NOPE%\\y')
  })
})

describe('powershell', () => {
  it('runs Windows PowerShell by its full path, with the script encoded', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const args = encodedCommandArgs('Write-Output "é"')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(args[5], 'base64').toString('utf16le')).toBe('Write-Output "é"')
  })

  it('makes every script print UTF-8, and end with exit 1 and the bare message on its first error', () => {
    // Into a pipe, Windows PowerShell writes the console's OEM code page: a profile named `Jö` would come back changed.
    // Without Stop and the trap, a failed SetValue is a printed error and exit 0; with them it is exit 1, and the
    // message alone on stderr instead of an error record serialized as CLIXML.
    expect(withPrelude('Write-Output 1')).toBe([
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      'trap { [Console]::Error.Write($_.Exception.Message); exit 1 }',
      'Write-Output 1',
    ].join('\n'))
  })
})

describe('removeUserPathEntry', () => {
  const ok = (stdout: string, stderr = ''): PowershellResult => ({ status: 0, stdout, stderr })
  const answer = (kind: string, value = '') => ok(`${kind}\n${value}`)
  const timedOut: PowershellResult = { status: null, stdout: '', stderr: '', error: new Error('spawnSync powershell.exe ETIMEDOUT') }
  function runner(...answers: PowershellResult[]) {
    const calls: Array<{ script: string; inputs: Record<string, string> }> = []
    return { calls, run: (script: string, inputs: Record<string, string> = {}) => { calls.push({ script, inputs }); return answers.shift()! } }
  }
  const where = { HARNESS_PATH_KEY: 'Environment', HARNESS_PATH_NAME: 'Path' }

  it('writes the value back without the folder, as the kind it was, only if it is still what was read', () => {
    const r = runner(answer('ExpandString', `C:\\tools;${bin}`), ok(''))
    expect(removeUserPathEntry(bin, r.run, env)).toEqual({ state: 'removed', folder: bin })
    expect(r.calls[0]).toEqual({ script: READ_USER_PATH, inputs: where })
    expect(r.calls[1]).toEqual({
      script: WRITE_USER_PATH,
      inputs: { ...where, HARNESS_PATH_ACTION: 'set', HARNESS_PATH_VALUE: 'C:\\tools', HARNESS_PATH_KIND: 'ExpandString', HARNESS_PATH_EXPECTED: `C:\\tools;${bin}` },
    })
    expect(r.calls[1].script).toContain('SendMessageTimeout')
  })

  it('reads and writes the key and value it is given', () => {
    const r = runner(answer('String', bin), ok(''))
    expect(removeUserPathEntry(bin, r.run, env, 'P', 'Software\\T')).toEqual({ state: 'removed', folder: bin })
    expect(r.calls.map((call) => [call.inputs.HARNESS_PATH_KEY, call.inputs.HARNESS_PATH_NAME])).toEqual([['Software\\T', 'P'], ['Software\\T', 'P']])
  })

  it('deletes the value, by saying so, when the folder was its only entry', () => {
    const r = runner(answer('ExpandString', `${bin}\\`), ok(''))
    expect(removeUserPathEntry(bin, r.run, env)).toEqual({ state: 'removed', folder: bin })
    expect(r.calls[1].inputs).toEqual({ ...where, HARNESS_PATH_ACTION: 'delete', HARNESS_PATH_KIND: 'ExpandString', HARNESS_PATH_EXPECTED: `${bin}\\` })
  })

  it('keeps the first line break only as the separator, and takes stderr beside exit 0 as no failure', () => {
    const r = runner(ok(`String\nC:\\tools;${bin}`, '#< CLIXML <Objs>Preparing modules for first use.</Objs>'), ok('', 'a warning'))
    expect(removeUserPathEntry(bin, r.run, env)).toEqual({ state: 'removed', folder: bin })
    expect(r.calls[1].inputs.HARNESS_PATH_VALUE).toBe('C:\\tools')
  })

  it('writes nothing when the folder is not on it, or there is no user PATH', () => {
    const absent = runner(answer('String', 'C:\\tools'))
    expect(removeUserPathEntry(bin, absent.run, env)).toEqual({ state: 'absent', folder: bin })
    expect(absent.calls).toHaveLength(1)
    const none = runner(answer('None'))
    expect(removeUserPathEntry(bin, none.run, env)).toEqual({ state: 'absent', folder: bin })
    expect(none.calls).toHaveLength(1)
  })

  it('says what failed, and never edits a value of another kind', () => {
    expect(removeUserPathEntry(bin, runner({ status: 1, stdout: '', stderr: 'denied' }).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not read your PATH (denied)' })
    expect(removeUserPathEntry(bin, runner(ok('String')).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not read your PATH (an answer Harness does not understand)' })
    expect(removeUserPathEntry(bin, runner(answer('MultiString', bin)).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'your PATH is a MultiString value, which Harness does not edit' })
    expect(removeUserPathEntry(bin, runner(answer('String', bin), { status: 1, stdout: '', stderr: 'no' }).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not write your PATH (no)' })
  })

  it('leaves the PATH alone when it changed after it was read', () => {
    const r = runner(answer('String', bin), ok('changed'))
    expect(removeUserPathEntry(bin, r.run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'your PATH changed while Harness was removing its folder, so Harness left it as it was' })
  })

  it('says the folder is removed, with a note, when Windows could not be told', () => {
    expect(PATH_UNANNOUNCED_NOTE).toBe('Could not announce the PATH change; terminals opened before you sign in again may still have it.')
    expect(removeUserPathEntry(bin, runner(answer('String', bin), ok('unannounced')).run, env))
      .toEqual({ state: 'removed', folder: bin, note: PATH_UNANNOUNCED_NOTE })
  })

  it('reads the PATH again when the write gave no clear answer', () => {
    const gone = runner(answer('String', `C:\\tools;${bin}`), timedOut, answer('String', 'C:\\tools'))
    expect(removeUserPathEntry(bin, gone.run, env)).toEqual({ state: 'removed', folder: bin, note: PATH_UNANNOUNCED_NOTE })
    expect(gone.calls[2]).toEqual({ script: READ_USER_PATH, inputs: where })
    const deleted = runner(answer('String', bin), timedOut, answer('None'))
    expect(removeUserPathEntry(bin, deleted.run, env)).toEqual({ state: 'removed', folder: bin, note: PATH_UNANNOUNCED_NOTE })
    const still = runner(answer('String', `C:\\tools;${bin}`), timedOut, answer('String', `C:\\tools;${bin}`))
    expect(removeUserPathEntry(bin, still.run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not write your PATH (spawnSync powershell.exe ETIMEDOUT)' })
    const unread = runner(answer('String', bin), timedOut, timedOut)
    expect(removeUserPathEntry(bin, unread.run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not tell whether your PATH was changed (spawnSync powershell.exe ETIMEDOUT)' })
    const odd = runner(answer('String', bin), ok('something else'), answer('String', 'C:\\tools'))
    expect(removeUserPathEntry(bin, odd.run, env)).toEqual({ state: 'removed', folder: bin, note: PATH_UNANNOUNCED_NOTE })
    const oddStill = runner(answer('String', bin), ok('something else'), answer('String', bin))
    expect(removeUserPathEntry(bin, oddStill.run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not write your PATH (an answer Harness does not understand)' })
    const oddUnread = runner(answer('String', bin), ok('something else'), { status: 1, stdout: '', stderr: 'denied' })
    expect(removeUserPathEntry(bin, oddUnread.run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not tell whether your PATH was changed (an answer Harness does not understand)' })
  })

  it('lets a test move every read and write off the real key, only to a test key that exists', () => {
    for (const script of [READ_USER_PATH, WRITE_USER_PATH]) {
      expect(script).toContain("$guard = $env:HARNESS_UNINSTALL_ENV_KEY")
      expect(script).toContain("if ($guard -notmatch '^Software\\\\HarnessTest\\\\[^\\\\]') { throw")
      expect(script).toContain("throw 'HARNESS_UNINSTALL_ENV_KEY is for tests; its key does not exist'")
    }
    expect(WRITE_USER_PATH).toMatch(/if \(\$key -ieq 'Environment'\)/)
    // A guard the script refuses is a failure to see, never "not on your PATH".
    const refused = { status: 1, stdout: '', stderr: 'HARNESS_UNINSTALL_ENV_KEY is for tests; its key does not exist' }
    expect(removeUserPathEntry(bin, runner(refused).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not read your PATH (HARNESS_UNINSTALL_ENV_KEY is for tests; its key does not exist)' })
  })

  it('compares the value it read with the one it is about to replace ordinally', () => {
    expect(WRITE_USER_PATH).toContain('[string]::Equals($now, $env:HARNESS_PATH_EXPECTED, [StringComparison]::Ordinal)')
    expect(WRITE_USER_PATH).not.toContain('$now -cne')
  })
})
