import { describe, expect, it } from 'vitest'
import { encodedCommandArgs, powershellPath, withUtf8Output, type PowershellResult } from '../windows/powershell.js'
import { expandWindowsVariables, removeUserPathEntry, withoutPathEntry } from './windowsPath.js'

const env = { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
const bin = 'C:\\Users\\u\\.harness\\bin'

describe('withoutPathEntry', () => {
  it('drops the folder however it was written, and keeps every other entry as written', () => {
    expect(withoutPathEntry(`%LOCALAPPDATA%\\Microsoft\\WindowsApps;${bin};C:\\tools`, bin, env))
      .toBe('%LOCALAPPDATA%\\Microsoft\\WindowsApps;C:\\tools')
    expect(withoutPathEntry('C:\\tools;%USERPROFILE%\\.harness\\bin', bin, env)).toBe('C:\\tools')
    expect(withoutPathEntry('C:\\tools;"c:\\users\\U\\.HARNESS\\bin\\";;D:\\x', bin, env)).toBe('C:\\tools;;D:\\x')
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

  it('makes every script print UTF-8, so a non-ASCII PATH entry reaches Node unchanged', () => {
    // Into a pipe, Windows PowerShell writes the console's OEM code page: a profile named `Jö` would come back changed.
    expect(withUtf8Output('Write-Output 1')).toBe('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\nWrite-Output 1')
  })
})

describe('removeUserPathEntry', () => {
  const ok = (stdout: string): PowershellResult => ({ status: 0, stdout, stderr: '' })
  function runner(...answers: PowershellResult[]) {
    const calls: Array<{ script: string; inputs: Record<string, string> }> = []
    return { calls, run: (script: string, inputs: Record<string, string> = {}) => { calls.push({ script, inputs }); return answers.shift()! } }
  }

  it('writes the value back without the folder, as the kind it was, and says so', () => {
    const r = runner(ok(JSON.stringify({ value: `C:\\tools;${bin}`, kind: 'ExpandString' })), ok(''))
    expect(removeUserPathEntry(bin, r.run, env)).toEqual({ state: 'removed', folder: bin })
    expect(r.calls[0].inputs).toEqual({ HARNESS_PATH_NAME: 'Path' })
    expect(r.calls[1].inputs).toEqual({ HARNESS_PATH_NAME: 'Path', HARNESS_PATH_VALUE: 'C:\\tools', HARNESS_PATH_KIND: 'ExpandString' })
    expect(r.calls[1].script).toContain('SendMessageTimeout')
  })

  it('writes nothing when the folder is not on it, or there is no user PATH', () => {
    const absent = runner(ok(JSON.stringify({ value: 'C:\\tools', kind: 'String' })))
    expect(removeUserPathEntry(bin, absent.run, env)).toEqual({ state: 'absent', folder: bin })
    expect(absent.calls).toHaveLength(1)
    const none = runner(ok(JSON.stringify({ value: null, kind: 'None' })))
    expect(removeUserPathEntry(bin, none.run, env)).toEqual({ state: 'absent', folder: bin })
  })

  it('says what failed, and never edits a value of another kind', () => {
    expect(removeUserPathEntry(bin, runner({ status: 1, stdout: '', stderr: 'denied' }).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not read your PATH (denied)' })
    expect(removeUserPathEntry(bin, runner(ok(JSON.stringify({ value: bin, kind: 'MultiString' }))).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'your PATH is a MultiString value, which Harness does not edit' })
    expect(removeUserPathEntry(bin, runner(ok(JSON.stringify({ value: bin, kind: 'String' })), { status: 5, stdout: '', stderr: 'no' }).run, env))
      .toEqual({ state: 'failed', folder: bin, detail: 'could not write your PATH (no)' })
  })
})
