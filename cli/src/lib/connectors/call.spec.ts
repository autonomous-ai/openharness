import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, win32, type PlatformPath } from 'node:path'
import { call, CallFailure, expandHome, forbiddenDirs, identities, identity, tempDir, unc, uploadFile, walk, type Identity, type Verdict } from './call.js'
import type { Store } from './store.js'

// The file system calls the upload check makes. A test that sets `disk.hooks.<name>` is handed the real call and its
// arguments, and answers for it; unset, the real call runs.
type Hook = (real: (...args: never[]) => unknown, ...args: never[]) => unknown
const disk = vi.hoisted(() => ({ hooks: {} as Record<string, Hook | undefined> }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const hooked = (name: 'openSync' | 'fstatSync' | 'statSync' | 'readFileSync' | 'closeSync') => (...args: never[]): unknown => {
    const real = fs[name] as (...args: never[]) => unknown
    return disk.hooks[name] ? disk.hooks[name]!(real, ...args) : real(...args)
  }
  return { ...fs, openSync: hooked('openSync'), fstatSync: hooked('fstatSync'), statSync: hooked('statSync'), readFileSync: hooked('readFileSync'), closeSync: hooked('closeSync') }
})

// The account's own home, which a test that needs one points at a folder of its own: no test writes in the real one.
const account = vi.hoisted(() => ({ home: undefined as string | undefined }))
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: account.home ?? os.userInfo().homedir }) }
})

// Windows' path module while a test sets `windows`, so uploadFile reads a path as it does on Windows, on any platform.
const platform = vi.hoisted(() => ({ windows: false }))
vi.mock('node:path', async importOriginal => {
  const path = await importOriginal<typeof import('node:path') & { default: PlatformPath }>()
  return { ...path, default: new Proxy(path.default, { get: (own, key) => Reflect.get(platform.windows ? path.win32 : own, key) }) }
})

/** A disk for the walk: every path is a folder of its own; `same` lists spellings of one folder, `unread` paths that cannot be read. */
function tree(same: string[][] = [], unread: string[] = []): (path: string) => Identity | undefined {
  const numbers = new Map<string, bigint>()
  const folder = (path: string): string => same.find(spellings => spellings.includes(path))?.[0] ?? path
  return path => {
    if (unread.includes(path)) return undefined
    if (!numbers.has(folder(path))) numbers.set(folder(path), BigInt(numbers.size + 1))
    return { dev: 1n, ino: numbers.get(folder(path))! }
  }
}

/** Whether this account can make a file link: Windows needs a right for it, which CI's runner has. */
const CAN_LINK = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-link-'))
  try { writeFileSync(join(dir, 'a'), ''); symlinkSync(join(dir, 'a'), join(dir, 'b')); return true } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
})()

describe('walk', () => {
  const a = 'C:\\Users\\a'
  const temp = `${a}\\AppData\\Local\\Temp`
  const appData = [`${a}\\AppData`, `${a}\\AppData\\Roaming`, `${a}\\AppData\\Local`]
  const verdict = (file: string, forbidden: string[], temps: string[] = [], on = tree()): Verdict =>
    walk(file, on, forbidden.map(dir => on(dir)!), temps.map(dir => on(dir)!), win32)

  it('fences a file under a forbidden folder, at any depth, and the folder itself', () => {
    for (const file of [`${a}\\.ssh\\id.txt`, `${a}\\.ssh\\keys\\old\\id.txt`, `${a}\\.ssh`]) expect(verdict(file, [`${a}\\.ssh`]), file).toBe('fenced')
    for (const file of [`${a}\\.sshx\\f.txt`, `${a}\\f.txt`, 'C:\\f.txt', 'D:\\Users\\a\\.ssh\\f.txt']) expect(verdict(file, [`${a}\\.ssh`]), file).toBe('open')
  })

  it('fences by the folder, not by how its path is spelled', () => {
    const on = tree([[`${a}\\.ssh`, `${a}\\.SSH`, `${a}\\SSH~1`, 'X:\\.ssh', `\\\\?\\${a}\\.ssh`]])
    for (const file of [`${a}\\.SSH\\id.txt`, `${a}\\SSH~1\\id.txt`, 'X:\\.ssh\\id.txt', `\\\\?\\${a}\\.ssh\\id.txt`]) expect(verdict(file, [`${a}\\.ssh`], [], on), file).toBe('fenced')
  })

  it('tells two folders with one number apart by their device', () => {
    const on = (path: string): Identity => ({ dev: path.startsWith('D:') ? 2n : 1n, ino: 7n })
    expect(walk('C:\\x\\f.txt', on, [{ dev: 1n, ino: 7n }], [], win32)).toBe('fenced')
    expect(walk('D:\\x\\f.txt', on, [{ dev: 1n, ino: 7n }], [], win32)).toBe('open')
  })

  it('leaves the temporary folder open under AppData, but for a forbidden folder inside it or one that is it', () => {
    for (const file of [`${temp}\\x.txt`, `${temp}\\docs\\x.txt`]) expect(verdict(file, appData, [temp]), file).toBe('open')
    for (const file of [`${a}\\AppData\\Roaming\\x.txt`, `${a}\\AppData\\Local\\Foo\\x.txt`, `${a}\\AppData\\LocalLow\\Temp\\x.txt`, `${a}\\AppData\\Local\\Tempx\\x.txt`]) {
      expect(verdict(file, appData, [temp]), file).toBe('fenced')
    }
    expect(verdict(`${temp}\\h\\.ssh\\id.txt`, [...appData, `${temp}\\h\\.ssh`], [temp])).toBe('fenced')
    expect(verdict(`${temp}\\h\\AppData\\Roaming\\x.txt`, [...appData, `${temp}\\h\\AppData`], [temp])).toBe('fenced')
    expect(verdict(`${temp}\\x.txt`, [...appData, temp], [temp])).toBe('fenced')
  })

  it('cannot tell under a folder it cannot read or one with no number, the file\'s own too', () => {
    expect(walk('/home/a/docs/x.txt', tree([], ['/home']), [], [], posix)).toBe('unknown')
    for (const numberless of ['/home/a/docs/x.txt', '/home/a', '/']) {
      expect(walk('/home/a/docs/x.txt', path => ({ dev: 1n, ino: path === numberless ? 0n : 9n }), [], [], posix), numberless).toBe('unknown')
    }
  })

  it('walks a posix path to the root', () => {
    const on = tree()
    const ssh = [on('/home/a/.ssh')!]
    expect(walk('/home/a/.ssh/id.txt', on, ssh, [], posix)).toBe('fenced')
    for (const file of ['/home/a/docs/x.txt', '/x.txt']) expect(walk(file, on, ssh, [], posix), file).toBe('open')
  })
})

describe('identities', () => {
  it('is each folder\'s identity, without the ones not named or not there', () => {
    const on = (path: string): Identity | undefined => path === '/missing' ? undefined : { dev: 1n, ino: BigInt(path.length) }
    expect(identities(['/a', undefined, '/missing', '/bcd'], on)).toEqual([{ dev: 1n, ino: 2n }, { dev: 1n, ino: 4n }])
  })
})

describe('expandHome', () => {
  it('expands ~\\ on Windows', () => {
    expect(expandHome('~\\.ssh\\id.txt', 'C:\\Users\\a', win32)).toBe('C:\\Users\\a\\.ssh\\id.txt')
    expect(expandHome('~/.ssh/id.txt', 'C:\\Users\\a', win32)).toBe('C:\\Users\\a/.ssh/id.txt')
  })

  it('leaves ~\\ alone on posix, where a backslash is part of a name', () => {
    expect(expandHome('~\\.ssh', '/home/a', posix)).toBe('~\\.ssh')
    expect(expandHome('~/.ssh', '/home/a', posix)).toBe('/home/a/.ssh')
    expect(expandHome('~', '/home/a', posix)).toBe('/home/a')
  })
})

describe('unc', () => {
  it('is a Windows path through a share, the local disk\'s admin share too', () => {
    expect(unc('\\\\localhost\\C$\\Users\\a\\x.txt', win32)).toBe(true)
    expect(unc('\\\\server\\share\\x.txt', win32)).toBe(true)
    expect(unc('C:\\Users\\a\\Pictures\\x.png', win32)).toBe(false)
  })

  it('is a share however its separators or device prefix are spelled', () => {
    const shares = ['\\\\host\\share\\x.txt', '//host/share/x.txt', '\\/host\\share\\x.txt', '\\\\?\\UNC\\host\\share\\x.txt',
      '\\\\.\\UNC\\host\\share\\x.txt', '\\\\localhost\\C$\\x.txt', '\\??\\UNC\\host\\share\\x.txt']
    for (const path of shares) expect(unc(path, win32), path).toBe(true)
  })

  // Windows takes `..` in a \\.\ path back to the prefix, out of the drive, so only \\?\, which it never normalizes, is local.
  it('is a share a drive\'s \\\\.\\ path climbs to', () => {
    for (const path of ['\\\\.\\C:\\..\\UNC\\host\\share\\x.txt', '\\\\.\\c:\\x\\../../UNC/host/share/x.txt']) expect(unc(path, win32), path).toBe(true)
  })

  it('is no local drive\'s path, nor its \\\\?\\ path', () => {
    for (const path of ['\\\\?\\C:\\Users\\a\\x.txt', '\\\\?\\c:\\x.txt', 'C:\\x.txt']) expect(unc(path, win32), path).toBe(false)
  })

  it('is never a posix path', () => {
    expect(unc('//server/share/x.txt', posix)).toBe(false)
    expect(unc('//x/y', posix)).toBe(false)
  })
})

describe('forbiddenDirs', () => {
  it('fences the folders under every home, once each', () => {
    const dirs = forbiddenDirs({ HOME: '/tmp/h' }, ['/home/a', '/tmp/h'], posix)
    expect(dirs).toEqual(expect.arrayContaining(['/tmp/h/.ssh', '/home/a/.ssh', '/home/a/.local/share', '/home/a/.claude']))
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('fences the folders under HOME, USERPROFILE and the account\'s own home on Windows', () => {
    expect(forbiddenDirs({ HOME: 'C:\\h', USERPROFILE: 'C:\\Users\\a' }, ['C:\\Users\\b'], win32)).toEqual(expect.arrayContaining(
      ['C:\\h\\.ssh', 'C:\\Users\\a\\.ssh', 'C:\\Users\\b\\.ssh', 'C:\\Users\\b\\.local\\share']))
  })

  it('fences AppData under every home on Windows, and the folders APPDATA and LOCALAPPDATA name', () => {
    expect(forbiddenDirs({ HOME: 'C:\\h', APPDATA: 'D:\\roaming', LOCALAPPDATA: 'D:\\local' }, ['C:\\Users\\a'], win32)).toEqual(expect.arrayContaining(
      ['C:\\h\\AppData', 'C:\\Users\\a\\AppData', 'D:\\roaming', 'D:\\local']))
  })

  it('fences no AppData on posix', () => {
    const env = { HOME: '/tmp/h', HARNESS_CONNECTIONS_DIR: '/tmp/c', APPDATA: '/tmp/roaming', LOCALAPPDATA: '/tmp/local' }
    expect(forbiddenDirs(env, [], posix)).toEqual(['/tmp/c', '/tmp/h/.ssh', '/tmp/h/.gnupg', '/tmp/h/.config', '/tmp/h/.local/share',
      '/tmp/h/.codex', '/tmp/h/.claude', '/tmp/h/.harness', '/etc', '/proc', '/sys'])
  })
})

describe('tempDir', () => {
  it('is the account\'s own AppData\\Local\\Temp on Windows, none on posix or with no home', () => {
    expect(tempDir('C:\\Users\\a', win32)).toBe('C:\\Users\\a\\AppData\\Local\\Temp')
    expect(tempDir('/home/a', posix)).toBeUndefined()
    expect(tempDir(undefined, win32)).toBeUndefined()
  })
})

describe('uploadFile', () => {
  let home: string
  beforeEach(() => {
    // The file system's own spelling: on Windows CI the temporary folder is an 8.3 short name (C:\Users\RUNNER~1).
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'harness-upload-')))
    for (const dir of ['.ssh', '.harness', 'docs']) mkdirSync(join(home, dir))
    for (const dir of ['.ssh', '.harness', 'docs']) writeFileSync(join(home, dir, 'note.txt'), 'x')
  })
  afterEach(() => {
    account.home = undefined
    platform.windows = false
    disk.hooks = {}
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  const refused = (raw: string): unknown => { try { uploadFile(raw, { HOME: home }); return null } catch (error) { return error } }
  /** What one upload answers: 'sent', or the refusal's text. */
  const said = (raw: string, env: NodeJS.ProcessEnv = { HOME: home }): string => { try { uploadFile(raw, env); return 'sent' } catch (error) { return (error as Error).message } }
  /** From here on: the paths an open was tried on, the descriptors opened, and the ones closed. */
  const descriptors = (): { tried: unknown[], opened: unknown[], closed: unknown[] } => {
    const tried: unknown[] = [], opened: unknown[] = [], closed: unknown[] = []
    disk.hooks.openSync = (real, ...args) => { tried.push((args as unknown[])[0]); const fd = real(...args); opened.push(fd); return fd }
    disk.hooks.closeSync = (real, ...args) => { closed.push((args as unknown[])[0]); return real(...args) }
    return { tried, opened, closed }
  }
  /** One request through `call` as far as `fetch`: the body it would send, and what it wrote to stderr in `err`. */
  async function sent(args: string[], err: string[] = [], env: NodeJS.ProcessEnv = { HOME: home }): Promise<string> {
    let body = ''
    vi.stubGlobal('fetch', async (_url: URL, init: { body?: Buffer | string }) => { body = Buffer.from(init.body ?? '').toString('latin1'); return new Response('{}') })
    // A stub: the real Store assumes posix permissions, and this spec runs on Windows too.
    const vault = { root: home, token: () => ({ access_token: 't', source: 'gateway' }) } as unknown as Store
    await call(vault, 'slack', 'POST', 'https://slack.com/api/files.upload', args, { out: () => undefined, err: line => { err.push(line) } }, env)
    return body
  }
  const expectFenced = (raw: string): void => {
    const error = refused(raw)
    expect(error, raw).toBeInstanceOf(CallFailure)
    expect((error as CallFailure).code, raw).toBe(2)
    expect((error as CallFailure).message, raw).toMatch(/not a media file/)
  }

  it('refuses a file inside a folder where credentials or configs live', () => {
    for (const dir of ['.ssh', '.harness']) expectFenced(join(home, dir, 'note.txt'))
  })

  it('refuses it under the account\'s own home, whatever home HOME names', () => {
    account.home = home
    expect(() => uploadFile(join(home, '.ssh', 'note.txt'), { HOME: join(home, 'docs') })).toThrow(/not a media file/)
  })

  it('refuses it however the path is spelled, where the file system reads the spelling as that folder', () => {
    const file = join(home, '.ssh', 'note.txt')
    // Another case (macOS, Windows), the temporary folder as given (a link on macOS, an 8.3 short name on Windows CI),
    // and Windows' \\?\ prefix. A spelling this file system does not read as the file is not one to fence.
    const spellings = [join(home, '.SSH', 'note.txt'), join(tmpdir(), basename(home), '.ssh', 'note.txt'), `\\\\?\\${file}`]
    for (const spelling of spellings.filter(spelling => existsSync(spelling))) expectFenced(spelling)
  })

  it('reads a folder\'s identity from the disk, through a link too', () => {
    const ssh = statSync(join(home, '.ssh'), { bigint: true })
    expect(identity(join(home, '.ssh'))).toEqual({ dev: ssh.dev, ino: ssh.ino })
    expect(identity(join(home, 'none'))).toBeUndefined()
    symlinkSync(join(home, '.ssh'), join(home, 'keys'), 'junction')
    expect(identity(join(home, 'keys'))).toEqual(identity(join(home, '.ssh')))
  })

  // Linux keeps the spelling given in a case-folded folder. Here realpath is made to, on a disk that folds case.
  it('refuses it in a folder whose spelling the file system did not correct, as a case-folded folder on Linux', ctx => {
    if (!existsSync(join(home, '.SSH', 'note.txt'))) ctx.skip()
    vi.spyOn(realpathSync, 'native').mockImplementation(path => String(path))
    expectFenced(join(home, '.SSH', 'note.txt'))
  })

  it('cannot check an upload under a folder with no number', () => {
    disk.hooks.statSync = (real, ...args) => {
      const [path, options] = args as unknown as [string, { bigint?: boolean } | undefined]
      const stat = real(...args) as { dev: bigint, ino: bigint }
      return path === home && options?.bigint ? { dev: stat.dev, ino: 0n } : stat
    }
    const file = join(home, 'docs', 'note.txt')
    expect(refused(file)).toMatchObject({ code: 2, message: `cannot check upload ${file}` })
  })

  it('refuses a hard link, whose other names may be inside such a folder', () => {
    linkSync(join(home, '.ssh', 'note.txt'), join(home, 'docs', 'link.txt'))
    expectFenced(join(home, 'docs', 'link.txt'))
  })

  // Windows opens a share to resolve a path through it, so a share path is refused before realpath, which stands in here
  // for that open.
  it('refuses a share path on Windows before it resolves it, one ~ names too', () => {
    platform.windows = true
    const realpath = vi.spyOn(realpathSync, 'native').mockImplementation(() => { throw new Error('opened') })
    const { tried } = descriptors()
    for (const raw of ['\\\\host\\share\\x.txt', '//host/share/x.txt', '\\\\?\\UNC\\host\\share\\x.txt', '\\\\.\\UNC\\host\\share\\x.txt',
      '\\\\.\\C:\\..\\UNC\\host\\share\\x.txt', '\\??\\UNC\\host\\share\\x.txt']) expectFenced(raw)
    expect(() => uploadFile('~\\x.txt', { HOME: '\\\\host\\share' })).toThrow(/not a media file/)
    expect(realpath).not.toHaveBeenCalled()
    expect(tried).toEqual([])
  })

  // A UNC path exists only on Windows, and only where this account reaches the local disk's admin share.
  it.skipIf(process.platform !== 'win32')('refuses a file through a share on Windows, even one allowed by its local path', ctx => {
    const share = `\\\\localhost\\${home[0]}$${home.slice(2)}\\docs\\note.txt`
    if (!existsSync(share)) ctx.skip()
    expectFenced(share)
  })

  // A junction needs no admin rights, but only Windows has one, and only there is AppData fenced. On Windows CI `home`
  // is in the account's own AppData\Local\Temp, so the junction is inside the one folder of AppData left open.
  it.skipIf(process.platform !== 'win32')('refuses a file reached through a junction to AppData\\Roaming, from the temporary folder too', () => {
    const app = join(home, 'AppData', 'Roaming', 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'note.txt'), 'x')
    symlinkSync(app, join(home, 'docs', 'app'), 'junction')
    expectFenced(join(home, 'docs', 'app', 'note.txt'))
  })

  // The path is swapped for a link into .ssh as the named call about the file runs: before the open, between the
  // open and each check, and before the read.
  it.skipIf(!CAN_LINK).each(['openSync', 'fstatSync', 'statSync', 'readFileSync'] as const)('never sends the file its path was swapped for as %s runs', async name => {
    const file = join(home, 'docs', 'note.txt')
    writeFileSync(file, 'checked')
    writeFileSync(join(home, '.ssh', 'note.txt'), 'secret')
    let swapped = false
    disk.hooks[name] = (real, ...args) => {
      const first = (args as unknown[])[0]
      if (!swapped && (first === file || (typeof first === 'number' && first > 2))) {
        swapped = true
        renameSync(file, `${file}.moved`)
        symlinkSync(join(home, '.ssh', 'note.txt'), file)
      }
      return real(...args)
    }
    const body = await sent(['--form', `file=@${file}`]).catch((error: unknown) => { expect(error).toMatchObject({ code: 2 }); return '' })
    expect(swapped).toBe(true)
    expect(body).not.toContain('secret')
    if (body) expect(body).toContain('\r\n\r\nchecked\r\n')
  })

  // On Windows the temporary folder holding `home` is the account's AppData\Local\Temp, inside the fenced AppData.
  it('returns the resolved file\'s name and every byte, read from the descriptor it checked', async () => {
    const doc = join(home, 'docs', 'note.txt')
    expect(uploadFile(doc, { HOME: home })).toEqual({ name: 'note.txt', content: Buffer.from('x') })
    expect(uploadFile('~/docs/note.txt', { HOME: home })).toEqual({ name: 'note.txt', content: Buffer.from('x') })
    writeFileSync(join(home, 'docs', 'empty.txt'), '')
    expect(uploadFile(join(home, 'docs', 'empty.txt'), { HOME: home }).content.length).toBe(0)
    const large = Buffer.alloc(1 << 20, 7)
    writeFileSync(join(home, 'docs', 'large.png'), large)
    expect(uploadFile(join(home, 'docs', 'large.png'), { HOME: home }).content.equals(large)).toBe(true)
    // Two files in one command: each part carries its own file's name and bytes.
    const body = await sent(['--form', `a=@${doc}`, '--form', `b=@${join(home, 'docs', 'empty.txt')}`, '--form', 'title=t'])
    expect(body).toContain('name="a"; filename="note.txt"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n')
    expect(body).toContain('name="b"; filename="empty.txt"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n')
  })

  it('closes the descriptor whatever the answer', () => {
    linkSync(join(home, '.ssh', 'note.txt'), join(home, 'docs', 'link.txt'))
    mkdirSync(join(home, 'docs', 'dir.txt'))
    for (const [file, answer] of [['docs/note.txt', /^sent$/], ['.ssh/note.txt', /not a media file/], ['docs/link.txt', /not a media file/], ['docs/dir.txt', /not a media file/]] as const) {
      const { opened, closed } = descriptors()
      expect(said(join(home, file)), file).toMatch(answer)
      expect(opened.length, file).toBe(1)
      expect(closed, file).toEqual(opened)
    }
  })

  // An open for reading waits for a FIFO's writer; with O_NONBLOCK it returns at once.
  it.skipIf(process.platform === 'win32')('never waits on a FIFO named as a document', () => {
    execFileSync('mkfifo', [join(home, 'docs', 'pipe.txt')])
    const { opened, closed } = descriptors()
    expect(said(join(home, 'docs', 'pipe.txt'))).toMatch(/not a media file/)
    expect(closed).toEqual(opened)
  }, 5_000)

  it('cannot read a file that is not there, or one this account may not open', () => {
    const missing = join(home, 'docs', 'none.txt')
    expect(said(missing)).toBe(`cannot read upload ${missing}`)
    // Windows has no such mode bits, and root opens anything.
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    writeFileSync(join(home, 'docs', 'locked.txt'), 'x')
    chmodSync(join(home, 'docs', 'locked.txt'), 0)
    expect(said(join(home, 'docs', 'locked.txt'))).toBe(`cannot read upload ${join(home, 'docs', 'locked.txt')}`)
  })

  it('opens nothing that is not named as a media file or document, and checks the resolved name too', ctx => {
    writeFileSync(join(home, 'docs', 'note.exe'), 'x')
    const { tried, opened, closed } = descriptors()
    expect(said(join(home, 'docs', 'note.exe'))).toMatch(/only .* files$/)
    expect(said(join(home, 'docs', 'none.exe'))).toMatch(/only .* files$/)
    expect(tried).toEqual([])
    if (!CAN_LINK) ctx.skip()
    writeFileSync(join(home, 'docs', 'id_rsa'), 'x')
    symlinkSync(join(home, 'docs', 'id_rsa'), join(home, 'docs', 'pic.png'))
    expect(said(join(home, 'docs', 'pic.png'))).toMatch(/only .* files$/)
    symlinkSync(join(home, 'docs', 'note.txt'), join(home, 'docs', 'alias.md'))
    expect(uploadFile(join(home, 'docs', 'alias.md'), { HOME: home }).name).toBe('note.txt')
    expect(closed).toEqual(opened)
  })
})

// A file under the home's Harness folder is never sent, judged by where it really is, while a picture beside that folder is.
describe('uploadFile around the home\'s Harness folder', () => {
  const REFUSED = 'not a media file the helper may send'
  let base: string
  let home: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'connectors-call-'))
    home = join(base, 'home')
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  /** A `.png`, so that the fence refuses it and not the suffix rule. */
  function picture(path: string): string {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'png')
    return path
  }

  it('refuses a file under the home\'s .harness', () => {
    const shot = picture(join(home, '.harness', 'logs', 'shot.png'))
    expect(() => uploadFile(shot, { HOME: home })).toThrow(REFUSED)
  })

  // A junction, which Windows makes with no admin rights; elsewhere the type is ignored and this is a symlink.
  it('a linked root: refuses a file reached through the link, and the same file by its real path', () => {
    const elsewhere = join(base, 'disk', 'harness')
    const shot = picture(join(elsewhere, 'logs', 'shot.png'))
    mkdirSync(home)
    symlinkSync(elsewhere, join(home, '.harness'), 'junction')
    expect(() => uploadFile(join(home, '.harness', 'logs', 'shot.png'), { HOME: home })).toThrow(REFUSED)
    expect(() => uploadFile(shot, { HOME: home })).toThrow(REFUSED)
  })

  it('takes a picture beside it', () => {
    mkdirSync(join(home, '.harness'), { recursive: true })
    const shot = picture(join(home, 'pictures', 'shot.png'))
    expect(uploadFile(shot, { HOME: home })).toEqual({ name: 'shot.png', content: Buffer.from('png') })
  })
})
