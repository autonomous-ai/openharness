import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstructionsError, readInstructions, writeInstructions } from './agentInstructions.js'

/** The protocol's limit for a file and for a text, written out: the apps are built against this number. */
const LIMIT = 65_536

// The one rename that can fail after the new bytes are safely on disk, so a spec can watch what is left behind.
const failRename = vi.hoisted(() => ({ next: null as Error | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(async (from: string, to: string) => {
    if (failRename.next) { const error = failRename.next; failRename.next = null; throw error }
    return actual.rename(from, to)
  }) }
})

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const posix = process.platform !== 'win32'
// A folder the account cannot write to is still writable to root, so those cases mean nothing there.
const unprivileged = posix && process.getuid?.() !== 0

describe('an agent\'s instructions file, agents/<name>.md in its own folder', () => {
  let cwd: string
  let outside: string
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-instructions-'))
    cwd = join(root, 'project')
    outside = join(root, 'outside')
    await mkdir(cwd)
    await mkdir(outside)
  })
  afterEach(async () => { failRename.next = null; await rm(join(cwd, '..'), { recursive: true, force: true }) })

  const file = (name = 'Faye') => join(cwd, 'agents', `${name}.md`)
  const put = async (text: string | Buffer, name = 'Faye') => { await mkdir(join(cwd, 'agents'), { recursive: true }); await writeFile(file(name), text) }
  const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error) => error instanceof InstructionsError ? error.code : error)

  describe('reading it', () => {
    it('gives its text, and the SHA-256 of its bytes as the version', async () => {
      await put('Be brief.\n')
      expect(await readInstructions(cwd, 'Faye')).toEqual({ text: 'Be brief.\n', version: sha256('Be brief.\n') })
      expect((await readInstructions(cwd, 'Faye')).version).toMatch(/^[0-9a-f]{64}$/)
    })

    it('says there is no file, with no version, when there is no agents folder or no such file', async () => {
      expect(await readInstructions(cwd, 'Faye')).toEqual({ text: null, version: '' })
      await mkdir(join(cwd, 'agents'))
      expect(await readInstructions(cwd, 'Faye')).toEqual({ text: null, version: '' })
    })

    it('says there is no file when the project folder is not there, and creates nothing', async () => {
      const gone = join(cwd, 'moved-away')
      expect(await readInstructions(gone, 'Faye')).toEqual({ text: null, version: '' })
      await expect(stat(gone)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('reads the file of the trimmed name', async () => {
      await put('hi', 'Faye')
      expect((await readInstructions(cwd, '  Faye \n')).text).toBe('hi')
    })

    it('hands back every byte as written: a byte-order mark, Windows line ends, any script', async () => {
      const text = '\u{FEFF}line one\r\nline two \u{2014} \u{1EA3}nh \u{1F600}\r\n'
      await put(text)
      expect((await readInstructions(cwd, 'Faye')).text).toBe(text)
    })

    it('reads a file of exactly the limit, and refuses one byte over, and a huge one without reading it whole', async () => {
      await put(Buffer.alloc(LIMIT, 97))
      expect((await readInstructions(cwd, 'Faye')).text).toHaveLength(LIMIT)
      await put(Buffer.alloc(LIMIT + 1, 97))
      expect(await code(readInstructions(cwd, 'Faye'))).toBe('TOO_LARGE')
      // A sparse 200 MB file: reading it whole would take a while and a lot of memory; it is refused at the limit.
      await truncate(file(), 200 * 1024 * 1024)
      const started = Date.now()
      expect(await code(readInstructions(cwd, 'Faye'))).toBe('TOO_LARGE')
      expect(Date.now() - started).toBeLessThan(2_000)
    })

    it('refuses an agents that is a file, not a folder', async () => {
      await writeFile(join(cwd, 'agents'), 'not a folder')
      expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
      expect(await code(writeInstructions(cwd, 'Faye', 'x', ''))).toBe('UNSAFE_PATH')
      expect(await readFile(join(cwd, 'agents'), 'utf8')).toBe('not a folder')
    })

    it('does not guess at a file that is not UTF-8: saving the guess would change the person\'s bytes', async () => {
      await put(Buffer.from([0x66, 0xff, 0xfe, 0x66]))
      await expect(readInstructions(cwd, 'Faye')).rejects.toMatchObject({ code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })
    })

    it.each([
      ['empty', ''], ['only spaces', '   '], ['not a string', undefined], ['a number', 7], ['null', null], ['an object', { a: 1 }],
      ['a dot', '.'], ['two dots', '..'], ['a hidden file', '.env'], ['a forward slash', 'a/b'], ['a way up', '../Faye'], ['a back slash', 'a\\b'],
      ['a NUL', 'a\0b'], ['a new line', 'a\nb'], ['a tab inside', 'a\tb'], ['DEL', 'a\u007fb'], ['a C1 control', 'a\u0085b'],
      ['101 characters', 'x'.repeat(101)],
    ])('refuses a name that is %s', async (_what, name) => {
      expect(await code(readInstructions(cwd, name))).toBe('BAD_NAME')
    })

    it('accepts a name of 100 characters, spaces and any script inside', async () => {
      const name = `${'x'.repeat(96)} \u{1EA3}nh`
      expect(name).toHaveLength(100)
      await put('long', name)
      expect((await readInstructions(cwd, name)).text).toBe('long')
      await put('space', 'Faye the PM')
      expect((await readInstructions(cwd, 'Faye the PM')).text).toBe('space')
    })

    it.skipIf(!posix)('fails with what the disk said, never as "no file", when the disk cannot look: a project path that loops', async () => {
      const loop = join(cwd, '..', 'loop')
      await symlink('loop', loop)
      await expect(readInstructions(loop, 'Faye')).rejects.toMatchObject({ code: 'ELOOP' })
      await expect(writeInstructions(loop, 'Faye', 'x', '')).rejects.toMatchObject({ code: 'ELOOP' })
    })

    describe.skipIf(!posix)('never through a link', () => {
      it('refuses an agents folder that is a link, to anywhere: the file behind it is not read', async () => {
        await writeFile(join(outside, 'Faye.md'), 'SECRET outside the project')
        await symlink(outside, join(cwd, 'agents'))
        expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
      })

      it('refuses an agents folder that is a link even to a folder inside the project', async () => {
        await mkdir(join(cwd, 'docs'))
        await writeFile(join(cwd, 'docs', 'Faye.md'), 'inside, but not where it should be')
        await symlink(join(cwd, 'docs'), join(cwd, 'agents'))
        expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
      })

      it('refuses a file that is a link, to a file outside, to one inside, and to nothing', async () => {
        await writeFile(join(outside, 'secret.md'), 'SECRET outside the project')
        await mkdir(join(cwd, 'agents'))
        await writeFile(join(cwd, 'notes.md'), 'inside')
        for (const target of [join(outside, 'secret.md'), join(cwd, 'notes.md'), join(outside, 'not-there.md')]) {
          await rm(file(), { force: true })
          await symlink(target, file())
          expect(await code(readInstructions(cwd, 'Faye')), target).toBe('UNSAFE_PATH')
        }
      })

      it('refuses what is not a plain file: a folder, a named pipe', async () => {
        await mkdir(file(), { recursive: true })
        expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
        await rm(file(), { recursive: true })
        // A pipe with no writer would hold an open for ever: it is turned away before anything opens it.
        execFileSync('mkfifo', [file()])
        expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
      })

      it('lets the project folder itself sit behind links, as /tmp does on a Mac', async () => {
        await put('through the front door')
        const front = join(cwd, '..', 'front')
        await symlink(cwd, front)
        expect((await readInstructions(front, 'Faye')).text).toBe('through the front door')
      })
    })
  })

  describe('saving it', () => {
    it('makes the agents folder and the file, and says the new version', async () => {
      const saved = await writeInstructions(cwd, 'Faye', 'Be brief.\n', '')
      expect(saved).toEqual({ version: sha256('Be brief.\n') })
      expect(await readFile(file(), 'utf8')).toBe('Be brief.\n')
      expect(await readInstructions(cwd, 'Faye')).toEqual({ text: 'Be brief.\n', version: saved.version })
    })

    it('replaces the file when the writer saw its current version, and leaves nothing else in the folder', async () => {
      await put('old')
      const { version } = await readInstructions(cwd, 'Faye')
      expect(await writeInstructions(cwd, 'Faye', 'new', version)).toEqual({ version: sha256('new') })
      expect(await readFile(file(), 'utf8')).toBe('new')
      expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
    })

    it('can save an empty file, whose version is still a hash, never the "no file" empty string', async () => {
      const saved = await writeInstructions(cwd, 'Faye', '', '')
      expect(saved.version).toBe(sha256(''))
      expect(await readInstructions(cwd, 'Faye')).toEqual({ text: '', version: sha256('') })
    })

    it('writes every character as given, in UTF-8, the trimmed name\'s file', async () => {
      const text = '\u{FEFF}m\u{1ED9}t\r\n\u{1F600}'
      await writeInstructions(cwd, ' Faye ', text, '')
      expect(await readFile(file())).toEqual(Buffer.from(text, 'utf8'))
    })

    it('refuses a save over a file the writer did not see, and keeps the file as it is', async () => {
      await put('what is there now')
      const before = (await readInstructions(cwd, 'Faye')).version
      for (const seen of ['', sha256('older'), undefined, 3, null, before.toUpperCase()]) {
        expect(await code(writeInstructions(cwd, 'Faye', 'mine', seen)), String(seen)).toBe('CHANGED')
      }
      expect(await readFile(file(), 'utf8')).toBe('what is there now')
      expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
    })

    it('refuses a save whose file has gone since it was read, and makes none', async () => {
      expect(await code(writeInstructions(cwd, 'Faye', 'mine', sha256('was here')))).toBe('CHANGED')
      await expect(stat(file())).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses text that is not a string, before it touches the disk', async () => {
      for (const text of [undefined, null, 5, {}, ['a']]) {
        expect(await code(writeInstructions(cwd, 'Faye', text, '')), String(text)).toBe('BAD_TEXT')
      }
      await expect(stat(join(cwd, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('takes text of exactly the limit in bytes and refuses one byte over, counting UTF-8 bytes not characters', async () => {
      const exact = `${'\u{20AC}'.repeat(21_845)}a`
      expect(Buffer.byteLength(exact)).toBe(LIMIT)
      const saved = await writeInstructions(cwd, 'Faye', exact, '')
      expect(saved.version).toBe(sha256(exact))
      const over = `${exact}a`
      expect(await code(writeInstructions(cwd, 'Faye', over, saved.version))).toBe('TOO_LARGE')
      expect(await code(writeInstructions(cwd, 'Faye', '\u{20AC}'.repeat(21_846), saved.version))).toBe('TOO_LARGE')
      expect(await readFile(file(), 'utf8')).toBe(exact)
    })

    it('refuses to save over a file that is over the limit: its version cannot be checked', async () => {
      await put(Buffer.alloc(LIMIT + 1, 97))
      expect(await code(writeInstructions(cwd, 'Faye', 'short', sha256('anything')))).toBe('TOO_LARGE')
      expect((await readFile(file())).length).toBe(LIMIT + 1)
    })

    it('overwrites a file that is not UTF-8 only when the writer names its exact bytes, which no read can give', async () => {
      const bytes = Buffer.from([0x66, 0xff, 0xfe, 0x66])
      await put(bytes)
      expect(await code(writeInstructions(cwd, 'Faye', 'mine', ''))).toBe('CHANGED')
      expect(await writeInstructions(cwd, 'Faye', 'mine', sha256(bytes))).toEqual({ version: sha256('mine') })
    })

    it.each([['empty', ''], ['a dot', '.'], ['a way up', '../Faye'], ['a slash', 'a/b'], ['a back slash', 'a\\b'], ['a NUL', 'a\0b'], ['a hidden name', '.Faye'],
      ['too long', 'x'.repeat(101)], ['not a string', 4]])('refuses a name that is %s, and makes no folder', async (_what, name) => {
      expect(await code(writeInstructions(cwd, name, 'x', ''))).toBe('BAD_NAME')
      await expect(stat(join(cwd, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(cwd)).toEqual([])
    })

    it('never makes the project folder itself: a project that has been moved away is a failure to save', async () => {
      const gone = join(cwd, 'moved-away')
      await expect(writeInstructions(gone, 'Faye', 'x', '')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(gone)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('fails, leaving the file as it was, when the folder cannot be written', async (context) => {
      if (!unprivileged) return context.skip()
      await put('keep me')
      const { version } = await readInstructions(cwd, 'Faye')
      await chmod(join(cwd, 'agents'), 0o500)
      try {
        await expect(writeInstructions(cwd, 'Faye', 'lost', version)).rejects.toMatchObject({ code: 'EACCES' })
      } finally { await chmod(join(cwd, 'agents'), 0o700) }
      expect(await readFile(file(), 'utf8')).toBe('keep me')
      expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
    })

    it('leaves the old file whole and no temporary file when the last step fails', async () => {
      await put('keep me')
      const { version } = await readInstructions(cwd, 'Faye')
      failRename.next = Object.assign(new Error('rename failed'), { code: 'EBUSY' })
      await expect(writeInstructions(cwd, 'Faye', 'half', version)).rejects.toMatchObject({ code: 'EBUSY' })
      expect(await readFile(file(), 'utf8')).toBe('keep me')
      expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
    })

    it('does not loosen a file the person made private, and gives a new one the folder\'s usual mode', async (context) => {
      if (!posix) return context.skip()
      await put('private')
      await chmod(file(), 0o600)
      const { version } = await readInstructions(cwd, 'Faye')
      await writeInstructions(cwd, 'Faye', 'still private', version)
      expect((await stat(file())).mode & 0o777).toBe(0o600)
      await writeInstructions(cwd, 'New', 'x', '')
      const made = (await stat(file('New'))).mode & 0o777
      expect(made & 0o111).toBe(0)
      expect(made & 0o600).toBe(0o600)
    })

    describe.skipIf(!posix)('never through a link', () => {
      it('writes nothing through an agents folder that is a link, whether it leads out or stays in, or leads nowhere', async () => {
        const targets = [outside, join(cwd, 'docs'), join(outside, 'not-there')]
        await mkdir(join(cwd, 'docs'))
        for (const target of targets) {
          await rm(join(cwd, 'agents'), { force: true })
          await symlink(target, join(cwd, 'agents'))
          expect(await code(writeInstructions(cwd, 'Faye', 'planted', '')), target).toBe('UNSAFE_PATH')
        }
        expect(await readdir(outside)).toEqual([])
        expect(await readdir(join(cwd, 'docs'))).toEqual([])
        await expect(lstat(join(outside, 'not-there'))).rejects.toMatchObject({ code: 'ENOENT' })
      })

      it('writes nothing through a file that is a link: the file it points at is left alone', async () => {
        await writeFile(join(outside, 'precious.md'), 'precious')
        await mkdir(join(cwd, 'agents'))
        await symlink(join(outside, 'precious.md'), file())
        for (const seen of ['', sha256('precious')]) {
          expect(await code(writeInstructions(cwd, 'Faye', 'overwritten', seen))).toBe('UNSAFE_PATH')
        }
        expect(await readFile(join(outside, 'precious.md'), 'utf8')).toBe('precious')
        expect((await lstat(file())).isSymbolicLink()).toBe(true)
      })

      it('writes nothing where the file is a folder or a named pipe', async () => {
        await mkdir(file(), { recursive: true })
        expect(await code(writeInstructions(cwd, 'Faye', 'x', ''))).toBe('UNSAFE_PATH')
        await rm(file(), { recursive: true })
        execFileSync('mkfifo', [file()])
        expect(await code(writeInstructions(cwd, 'Faye', 'x', ''))).toBe('UNSAFE_PATH')
        expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
      })
    })
  })
})
