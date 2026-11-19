import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expandFolder, folderValues, KNOWN_FOLDERS_TIMEOUT_MS, readAppDataFolders, RegFailure, regQuery, SHELL_FOLDERS, systemRoot,
  USER_SHELL_FOLDERS, type AppDataFolders, type RegQuery, type RegRun,
} from './knownFolders.js'

const EXPLORER = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
const home = 'C:\\Users\\a'
/** A key's values as reg.exe prints them: a blank line, the key, each value indented by four spaces. */
const printed = (key: string, ...values: [name: string, type: string, data: string | Buffer][]): Buffer => Buffer.concat([
  Buffer.from(`\r\n${EXPLORER}\\${key}\r\n`),
  ...values.flatMap(([name, type, data]) => [Buffer.from(`    ${name}    ${type}    `), Buffer.from(data), Buffer.from('\r\n')]), Buffer.from('\r\n')])
const user = (roaming: string | Buffer = '%USERPROFILE%\\AppData\\Roaming', local: string | Buffer = '%USERPROFILE%\\AppData\\Local'): Buffer =>
  printed('User Shell Folders', ['AppData', 'REG_EXPAND_SZ', roaming], ['Desktop', 'REG_EXPAND_SZ', '%USERPROFILE%\\Desktop'], ['Local AppData', 'REG_EXPAND_SZ', local])
const shell = (roaming: string | Buffer = `${home}\\AppData\\Roaming`, local: string | Buffer = `${home}\\AppData\\Local`): Buffer =>
  printed('Shell Folders', ['AppData', 'REG_SZ', roaming], ['Local AppData', 'REG_SZ', local])
/** A registry that answers `first` for User Shell Folders and `second` for Shell Folders; `asked` holds each run's keys. */
const keys = (first: Buffer | RegFailure, second: Buffer | RegFailure): RegQuery & { asked: string[][] } => {
  const asked: string[][] = []
  return Object.assign((list: string[]) => { asked.push(list); return list.map(key => key === USER_SHELL_FOLDERS ? first : second) }, { asked })
}
/** `ö` as code page 437 prints it: one byte, not UTF-8. */
const OEM = Buffer.concat([Buffer.from('D:\\Redirect '), Buffer.from([0x94]), Buffer.from('\\Roaming')])
const S32 = 'C:\\Windows\\System32'
/** Each answer as text, a failure as `RegFailure: <message>`: a plain Error or a string never passes for either. */
const shown = (answers: unknown[]): string[] => answers.map(answer => answer instanceof RegFailure ? `RegFailure: ${answer.message}`
  : Buffer.isBuffer(answer) ? answer.toString('latin1') : `not an answer: ${String(answer)}`)

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
})

// This Mac's systemRoot() is C:\Windows: the GLOBALROOT path does not resolve here.
describe('regQuery', () => {
  it('runs one hidden cmd.exe from the system folder, its console in UTF-8, bounded, with nothing of this process\'s environment', () => {
    for (const name of ['PATH', 'SystemRoot', 'ComSpec']) vi.stubEnv(name, 'Z:\\evil')
    const run = vi.fn<RegRun>(() => ({ status: 0, stdout: Buffer.from('a\r\nharness-key-read\r\nb\r\nharness-key-read\r\n') }))
    expect(shown(regQuery([USER_SHELL_FOLDERS, SHELL_FOLDERS], run))).toEqual(['a\r\n', 'b\r\n'])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(`${S32}\\cmd.exe`, ['/d', '/s', '/c',
      `"\"${S32}\\chcp.com\" 65001 >nul & (\"${S32}\\reg.exe\" query \"${USER_SHELL_FOLDERS}\" && echo harness-key-read || echo harness-key-failed) & (\"${S32}\\reg.exe\" query \"${SHELL_FOLDERS}\" && echo harness-key-read || echo harness-key-failed)"`],
    { env: { SystemRoot: 'C:\\Windows' }, timeout: 3_000, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] })
    expect(KNOWN_FOLDERS_TIMEOUT_MS).toBe(3_000)
  })

  it('answers each key, and a key reg.exe could not read as a failure', () => {
    const answer = (stdout: string) => shown(regQuery([USER_SHELL_FOLDERS, SHELL_FOLDERS], () => ({ status: 0, stdout: Buffer.from(stdout) })))
    expect(answer('a\r\nharness-key-read\r\nharness-key-failed\r\n')).toEqual(['a\r\n', 'RegFailure: reg.exe could not read a key'])
    // The second marker missing.
    expect(answer('a\r\nharness-key-read\r\n')).toEqual(['a\r\n', 'RegFailure: reg.exe could not read a key'])
    // cmd.exe's echo keeps the space before `||`: the marker is the line with its spaces aside.
    expect(answer('a\r\nharness-key-read \r\nb\r\nharness-key-read \r\n')).toEqual(['a\r\n', 'b\r\n'])
  })

  it('names the run\'s failure for every key, with no path', () => {
    const failures = (result: ReturnType<RegRun>) => shown(regQuery([USER_SHELL_FOLDERS, SHELL_FOLDERS], () => result))
    const error = (code: string) => Object.assign(new Error(`spawnSync C:\\Windows\\System32\\cmd.exe ${code}`), { code })
    const said = [
      failures({ status: null, stdout: Buffer.alloc(0), error: error('ETIMEDOUT') }),
      failures({ status: null, stdout: Buffer.alloc(0), error: error('ENOENT') }),
      failures({ status: 1, stdout: Buffer.from('a\r\nharness-key-read\r\n') }),
    ]
    expect(said).toEqual([
      ['RegFailure: cmd.exe timed out', 'RegFailure: cmd.exe timed out'],
      ['RegFailure: cmd.exe did not start', 'RegFailure: cmd.exe did not start'],
      ['RegFailure: cmd.exe exited 1', 'RegFailure: cmd.exe exited 1'],
    ])
    expect(said.flat().filter(message => message.includes('\\'))).toEqual([])
  })
})

describe('folderValues', () => {
  it('reads AppData and Local AppData among a key\'s values', () => {
    expect(folderValues(user())).toEqual({ roaming: '%USERPROFILE%\\AppData\\Roaming', local: '%USERPROFILE%\\AppData\\Local', unreadable: { roaming: false, local: false } })
  })

  it('takes text values by name, in any case, with the spaces of a folder\'s name', () => {
    expect(folderValues(printed('Shell Folders', ['APPDATA', 'REG_SZ', 'C:\\Program Files\\A B'], ['local appdata', 'REG_SZ', 'D:\\L M'])))
      .toEqual({ roaming: 'C:\\Program Files\\A B', local: 'D:\\L M', unreadable: { roaming: false, local: false } })
    expect(folderValues(printed('Shell Folders', ['AppData', 'REG_DWORD', '0x1']))).toEqual({ unreadable: { roaming: false, local: false } })
    expect(folderValues(printed('Shell Folders', ['AppData Backup', 'REG_SZ', 'D:\\x'], ['My Local AppData', 'REG_SZ', 'D:\\y'])))
      .toEqual({ unreadable: { roaming: false, local: false } })
  })

  it('ignores what reg.exe says around the values', () => {
    // reg.exe translates its own messages: these bytes are a French Windows' code page, not UTF-8.
    const said = Buffer.concat([Buffer.from('Fin de la recherche : 2 correspondance(s) trouvée(s).\r\n', 'latin1'), Buffer.from('ERROR: x\r\n')])
    expect(folderValues(Buffer.concat([said, user(), said]))).toEqual(folderValues(user()))
  })

  it('cannot read a value reg.exe printed outside UTF-8, or with a ?', () => {
    const unspelled = { local: '%USERPROFILE%\\AppData\\Local', unreadable: { roaming: true, local: false } }
    expect(folderValues(user(OEM))).toEqual(unspelled)
    expect(folderValues(user('D:\\D?\\Roaming'))).toEqual(unspelled)
    expect(folderValues(user('D:\\Dữ liệu\\Roaming')).roaming).toBe('D:\\Dữ liệu\\Roaming')
  })
})

describe('expandFolder', () => {
  it('puts the home it is given for %USERPROFILE%, and takes no value with another variable', () => {
    expect(expandFolder('%USERPROFILE%\\AppData\\Roaming', home)).toBe('C:\\Users\\a\\AppData\\Roaming')
    expect(expandFolder('%userprofile%\\AppData\\Roaming', home)).toBe('C:\\Users\\a\\AppData\\Roaming')
    expect(expandFolder('D:\\Redirect\\Roaming', undefined)).toBe('D:\\Redirect\\Roaming')
    // A lone % is a name's.
    expect(expandFolder('D:\\100%\\Roaming', home)).toBe('D:\\100%\\Roaming')
    expect(expandFolder('%USERPROFILE%\\x', undefined)).toBeUndefined()
    expect(expandFolder('%HOMESHARE%\\AppData', home)).toBeUndefined()
    expect(expandFolder('%USERPROFILE%\\%USERNAME%', home)).toBeUndefined()
    expect(expandFolder('', home)).toBeUndefined()
  })
})

describe('readAppDataFolders', () => {
  const both = { roaming: ['C:\\Users\\a\\AppData\\Roaming'], local: ['C:\\Users\\a\\AppData\\Local'] }

  it('is both keys\' folders, each once, both keys asked in one run', () => {
    const query = keys(user(), shell())
    expect(readAppDataFolders(home, query)).toEqual(both)
    expect(query.asked).toEqual([[USER_SHELL_FOLDERS, SHELL_FOLDERS]])
  })

  it('fences a moved AppData, and the place the other key still names', () => {
    expect(readAppDataFolders(home, keys(user('D:\\Redirect\\Roaming'), shell())).roaming).toEqual(['D:\\Redirect\\Roaming', 'C:\\Users\\a\\AppData\\Roaming'])
  })

  it('skips a value with another variable for the other key\'s', () => {
    const folders = readAppDataFolders(home, keys(user('%HOMESHARE%\\AppData'), shell('H:\\AppData')))
    expect(folders.roaming).toEqual(['H:\\AppData'])
    expect(folders.failure).toBeUndefined()
  })

  it('expands %USERPROFILE% with the home it is given, not the environment\'s', () => {
    vi.stubEnv('USERPROFILE', 'Z:\\evil')
    expect(readAppDataFolders(home, keys(user(), shell()))).toEqual(both)
  })

  it('keeps what it read and names the failure when a key cannot be read', () => {
    expect(readAppDataFolders(home, keys(user('D:\\Redirect\\Roaming'), new RegFailure('reg.exe could not read a key'))))
      .toEqual({ roaming: ['D:\\Redirect\\Roaming'], local: ['C:\\Users\\a\\AppData\\Local'], failure: 'reg.exe could not read a key' })
    expect(readAppDataFolders(home, keys(new RegFailure('cmd.exe timed out'), new RegFailure('cmd.exe timed out'))))
      .toEqual({ roaming: [], local: [], failure: 'cmd.exe timed out' })
  })

  it('names a folder reg.exe could not spell, unless the user\'s key gave it', () => {
    const unspelled = 'reg.exe printed a folder it could not spell'
    // The user's key is the one that says where the folder is now.
    expect(readAppDataFolders(home, keys(user(OEM), shell(OEM)))).toEqual({ roaming: [], local: ['C:\\Users\\a\\AppData\\Local'], failure: unspelled })
    expect(readAppDataFolders(home, keys(user(OEM), shell()))).toEqual({ ...both, failure: unspelled })
    expect(readAppDataFolders(home, keys(user(), shell(OEM))).failure).toBeUndefined()
    expect(readAppDataFolders(home, keys(user('%HOMESHARE%\\AppData'), shell(OEM))).failure).toBe(unspelled)
    // A key that could not be read is named first.
    expect(readAppDataFolders(home, keys(user(OEM), new RegFailure('reg.exe could not read a key'))).failure).toBe('reg.exe could not read a key')
  })
})

describe('appDataFolders', () => {
  /** A fresh module each case: what it read is kept for the rest of the process. */
  const fresh = async () => { vi.resetModules(); return (await import('./knownFolders.js')).appDataFolders }
  const reader = (folders: AppDataFolders & { failure?: string }) => vi.fn((_home: string | undefined) => folders)

  it('reads once in a process, and says a failure once', async () => {
    const appDataFolders = await fresh()
    const read = reader({ roaming: ['a'], local: ['b'], failure: 'cmd.exe timed out' })
    const failed = vi.fn()
    expect(appDataFolders(home, failed, read, 'win32')).toEqual({ roaming: ['a'], local: ['b'] })
    expect(appDataFolders(home, failed, read, 'win32')).toEqual({ roaming: ['a'], local: ['b'] })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(home)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledWith('cmd.exe timed out')
  })

  it('says nothing when the read had no failure', async () => {
    const appDataFolders = await fresh()
    const read = reader({ roaming: ['a'], local: ['b'] })
    const failed = vi.fn()
    expect(appDataFolders(home, failed, read, 'win32')).toEqual({ roaming: ['a'], local: ['b'] })
    expect(appDataFolders(home, failed, read, 'win32')).toEqual({ roaming: ['a'], local: ['b'] })
    expect(read).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
  })

  it('reads nothing on macOS and Linux', async () => {
    const appDataFolders = await fresh()
    const read = reader({ roaming: ['a'], local: ['b'], failure: 'cmd.exe timed out' })
    const failed = vi.fn()
    expect(appDataFolders(home, failed, read, 'darwin')).toEqual({ roaming: [], local: [] })
    expect(appDataFolders(home, failed, read, 'linux')).toEqual({ roaming: [], local: [] })
    expect(read).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })
})
