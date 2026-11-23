/**
 * Windows' own programs are run by their full paths in System32 (`systemProgram` and `powershellPath`, ./powershell.ts),
 * in Windows' own folder as the file system names it (`systemRoot`): Node on Windows looks for a bare name in the folder
 * it runs in before PATH, and SystemRoot, windir and ComSpec are whoever runs the command's. The bare names are read as
 * text, as noWindow.spec.ts reads `detached`.
 */
import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceFiles } from '../../testing/sourceFiles.js'
import { powershellPath, systemProgram, systemRoot } from './powershell.js'
import { systemRoot as masterSystemRoot } from '../../harnessd/platform.js'

const PROGRAMS = ['cmd', 'conhost', 'icacls', 'powershell', 'quser', 'reg', 'rundll32', 'schtasks', 'tar', 'taskkill', 'tasklist', 'whoami']
/** One of them by its bare name, as what a call runs: a spawn's, an exec's or a runner's first argument, a command's
 *  `file`, or the fallback for a variable that names one (`ComSpec ?? 'cmd.exe'`). */
const BARE = new RegExp(String.raw`(?:\b(?:spawn|spawnSync|execFile|execFileSync|exec|patientExec|run|runner|runGuestCommand)\)?\(|\bfile:|\?\?|\|\|)\s*(['"\x60])(?:${PROGRAMS.join('|')})(?:\.exe)?\1`, 'g')
/** Files that name one bare, and why that runs System32's. */
const RESOLVED_ELSEWHERE: Record<string, string> = {
  'harnessd/platform.ts': 'defaultPlatformDeps runs each command of the Task Scheduler service from System32 (windowsProgram)',
  // CreateProcessW looks in the PTY host's own folders before System32, and it runs in its home (ptyHost/launch.ts).
  'lib/windows/shell.ts': "a pane's shell, which the PTY host starts",
}

afterEach(() => vi.unstubAllEnvs())

describe('systemRoot', () => {
  it('is where \\\\?\\GLOBALROOT\\SystemRoot leads, asked of the file system', () => {
    const asked: string[] = []
    expect(systemRoot(path => { asked.push(path); return 'D:\\Windows' })).toBe('D:\\Windows')
    expect(asked).toEqual(['\\\\?\\GLOBALROOT\\SystemRoot'])
  })

  it('is C:\\Windows when that does not resolve to a drive\'s folder, whatever the environment says', () => {
    vi.stubEnv('SystemRoot', 'Z:\\evil')
    vi.stubEnv('windir', 'Z:\\evil')
    expect(systemRoot(() => { throw new Error('ENOENT') })).toBe('C:\\Windows')
    expect(systemRoot(() => '\\\\server\\share\\Windows')).toBe('C:\\Windows')
    expect(systemRoot(() => '\\\\?\\GLOBALROOT\\Device\\X')).toBe('C:\\Windows')
  })

  it('is C:\\Windows when cmd.exe would read the folder\'s name as something else', () => {
    for (const name of ['D:\\Win%OS%', 'D:\\a!b', 'D:\\a&b', 'D:\\a"b']) expect(systemRoot(() => name), name).toBe('C:\\Windows')
  })

  it("is what the master's own copy says, for every answer the file system can give", () => {
    // The master keeps a copy (harnessd/platform.ts): it imports only Node, its own folder and the log trimmer.
    const table: Array<[answer: string | Error, root: string]> = [
      ['D:\\Windows', 'D:\\Windows'], ['C:\\WINDOWS', 'C:\\WINDOWS'], [new Error('ENOENT'), 'C:\\Windows'],
      ['\\\\server\\share\\Windows', 'C:\\Windows'], ['\\\\?\\GLOBALROOT\\Device\\X', 'C:\\Windows'], ['Windows', 'C:\\Windows'],
      ...['%', '!', '"', '^', '&', '|', '<', '>'].map((sign): [string, string] => [`D:\\a${sign}b`, 'C:\\Windows']),
    ]
    for (const [answer, root] of table) {
      const real = (path: string) => {
        expect(path).toBe('\\\\?\\GLOBALROOT\\SystemRoot')
        if (answer instanceof Error) throw answer
        return answer
      }
      expect([systemRoot(real), masterSystemRoot(real)], String(answer)).toEqual([root, root])
    }
  })
})

describe('Windows programs by their full paths', () => {
  it('a SystemRoot variable naming another folder is ignored', () => {
    vi.stubEnv('SystemRoot', 'D:\\Elsewhere')
    vi.stubEnv('windir', 'D:\\Elsewhere')
    expect(systemProgram('reg.exe')).not.toContain('Elsewhere')
    expect(systemProgram('reg.exe')).toBe(win32.join(systemRoot(), 'System32', 'reg.exe'))
    expect(powershellPath()).toBe(win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  })

  it('the check finds a bare name as what a call runs', () => {
    const found = (text: string) => [...text.matchAll(BARE)].length
    expect(found("spawn('taskkill', ['/pid'])")).toBe(1)
    expect(found("(deps.runner ?? runGuestCommand)('schtasks.exe', [])")).toBe(1)
    expect(found("({ file: 'powershell.exe', args })")).toBe(1)
    expect(found("await exec('tasklist', ['/fo', 'csv'])")).toBe(1)
    expect(found("process.env.ComSpec ?? 'cmd.exe'")).toBe(1)
    expect(found("spawn(systemProgram('taskkill.exe'), [])")).toBe(0)
    expect(found("quoted('powershell')")).toBe(0)
  })

  // Test code runs in the repository; what a person runs does not.
  it('no file under cli/src runs one by a bare name', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url))
    const bare = sourceFiles(src)
      .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/\.(spec|test)\.ts$/.test(file) && !file.startsWith('testing/'))
      .flatMap((file) => [...readFileSync(join(src, file), 'utf8').matchAll(BARE)].map((match) => [file, match[0]] as const))
    expect(bare.filter(([file]) => !(file in RESOLVED_ELSEWHERE)).map(([file, call]) => `${file}: ${call}`)).toEqual([])
    // A file listed that no longer names one goes from the list.
    expect(Object.keys(RESOLVED_ELSEWHERE).filter((file) => !bare.some(([named]) => named === file))).toEqual([])
  })
})
