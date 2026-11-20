/**
 * Windows' own programs are run by their full paths in System32 (`systemProgram` and `powershellPath`, ./powershell.ts):
 * Node on Windows looks for a bare name in the folder it runs in before PATH. Read as text, as noWindow.spec.ts reads
 * `detached`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { powershellPath, systemProgram } from './powershell.js'

const PROGRAMS = ['cmd', 'icacls', 'powershell', 'reg', 'schtasks', 'taskkill', 'tasklist', 'whoami']
/** One of them by its bare name, as what a call runs: a spawn's or a runner's first argument, or a command's `file`. */
const BARE = new RegExp(String.raw`(?:\b(?:spawn|spawnSync|execFile|execFileSync|run|runner|runGuestCommand)\)?\(|\bfile:)\s*(['"\x60])(?:${PROGRAMS.join('|')})(?:\.exe)?\1`, 'g')
/** Files that name one bare, and why that runs System32's. */
const RESOLVED_ELSEWHERE: Record<string, string> = {
  'harnessd/platform.ts': 'defaultPlatformDeps runs each command of the Task Scheduler service from System32 (windowsProgram)',
}

describe('Windows programs by their full paths', () => {
  it("name System32 in the first of SystemRoot and windir that is a drive's folder, else C:\\Windows", () => {
    expect(systemProgram('whoami.exe', { SystemRoot: 'D:\\Win', windir: 'E:\\Win' })).toBe('D:\\Win\\System32\\whoami.exe')
    expect(systemProgram('whoami.exe', { windir: 'E:\\Win' })).toBe('E:\\Win\\System32\\whoami.exe')
    expect(systemProgram('whoami.exe', {})).toBe('C:\\Windows\\System32\\whoami.exe')
    // An empty or relative value would name a folder under the one the command runs in.
    expect(systemProgram('whoami.exe', { SystemRoot: '', windir: 'E:\\Win' })).toBe('E:\\Win\\System32\\whoami.exe')
    expect(systemProgram('whoami.exe', { SystemRoot: 'Windows', windir: '.' })).toBe('C:\\Windows\\System32\\whoami.exe')
    expect(powershellPath({ SystemRoot: '' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('the check finds a bare name as what a call runs', () => {
    const found = (text: string) => [...text.matchAll(BARE)].length
    expect(found("spawn('taskkill', ['/pid'])")).toBe(1)
    expect(found("(deps.runner ?? runGuestCommand)('schtasks.exe', [])")).toBe(1)
    expect(found("({ file: 'powershell.exe', args })")).toBe(1)
    expect(found("spawn(systemProgram('taskkill.exe'), [])")).toBe(0)
    expect(found("quoted('powershell')")).toBe(0)
  })

  // Test code runs in the repository; what a person runs does not.
  it('no file under cli/src runs one by a bare name', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url))
    const bare = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((file) => file.split('\\').join('/'))
      .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/\.(spec|test)\.ts$/.test(file) && !file.startsWith('testing/'))
      .flatMap((file) => [...readFileSync(join(src, file), 'utf8').matchAll(BARE)].map((match) => [file, match[0]] as const))
    expect(bare.filter(([file]) => !(file in RESOLVED_ELSEWHERE)).map(([file, call]) => `${file}: ${call}`)).toEqual([])
    // A file listed that no longer names one goes from the list.
    expect(Object.keys(RESOLVED_ELSEWHERE).filter((file) => !bare.some(([named]) => named === file))).toEqual([])
  })
})
