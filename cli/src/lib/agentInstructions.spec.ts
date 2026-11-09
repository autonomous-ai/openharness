import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstructionsError, readInstructions, writeInstructions } from './agentInstructions.js'

/** The protocol's limit for a file and for a text, written out: the apps are built against this number. */
const LIMIT = 65_536

// What a real disk will not show on demand: the one rename that can fail after the new bytes are safely on disk, so a spec
// can watch what is left behind; a rename held at the last step, so a spec can watch what else goes on meanwhile; and how
// many bytes a read really took from a file, to prove it is bounded.
const disk = vi.hoisted(() => ({ failRename: null as Error | null, holdRename: null as Promise<void> | null, renameHeld: false, bytesRead: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (disk.failRename) { const error = disk.failRename; disk.failRename = null; throw error }
      if (disk.holdRename) { const hold = disk.holdRename; disk.holdRename = null; disk.renameHeld = true; await hold; disk.renameHeld = false }
      return actual.rename(from, to)
    }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle) as (...call: unknown[]) => Promise<{ bytesRead: number }>
      handle.read = (async (...call: unknown[]) => { const result = await read(...call); disk.bytesRead += result.bytesRead; return result }) as typeof handle.read
      return handle
    }),
  }
})

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
/** `n` characters of 3 bytes each in UTF-8, and `n` of 4. */
const cjk = (n: number) => String.fromCodePoint(0x4e2d).repeat(n)
const emoji = (n: number) => String.fromCodePoint(0x1f600).repeat(n)
const sup = (n: number) => String.fromCodePoint(n)
/** An unpaired surrogate is no character: written as UTF-8 it becomes U+FFFD. Built by code, never written out in the source. */
const lone = (unit: number) => String.fromCharCode(unit)

/** Names that are not one file name that every computer of the account can keep as `<name>.md`, and why. */
const BAD_NAMES: Array<[string, unknown]> = [
  ['empty', ''], ['only spaces', '   '], ['not a string', undefined], ['a number', 7], ['null', null], ['an object', { a: 1 }],
  ['a dot', '.'], ['two dots', '..'], ['a hidden file', '.env'], ['a forward slash', 'a/b'], ['a way up', '../Faye'], ['a back slash', 'a\\b'],
  ['a NUL', 'a\0b'], ['a new line', 'a\nb'], ['a tab inside', 'a\tb'], ['DEL', 'a\x7fb'], ['a C1 control', 'a\x85b'],
  ['101 characters', 'x'.repeat(101)],
  // What Windows will not have in a file name, and which would make the same agent's file a different thing there.
  ...['<', '>', ':', '"', '|', '?', '*'].map((character): [string, unknown] => [`a ${character}, which Windows forbids`, `Faye${character}Ken`]),
  ['a trailing dot', 'Faye.'], ['trailing dots', 'Faye..'],
  // Device names, with or without an extension, in any case: a device and not a file on Windows.
  ...['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM0', 'LPT0', 'NUL.txt', 'aux.foo.bar'].map((device): [string, unknown] => [`the device name ${device}`, device]),
  ['a superscript device name', `COM${sup(0xb9)}`],
  // 200 bytes with `.md` is what a file name of 255 leaves room for, and CJK and emoji names are 3 and 4 bytes a character.
  ['66 CJK characters (201 bytes with .md)', cjk(66)], ['100 CJK characters', cjk(100)], ['50 emoji (203 bytes with .md)', emoji(50)],
]
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
  afterEach(async () => {
    disk.failRename = null; disk.holdRename = null; disk.renameHeld = false
    await rm(join(cwd, '..'), { recursive: true, force: true })
  })

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
      // A sparse 200 MB file is refused having taken one byte past the limit from it, not the file.
      await truncate(file(), 200 * 1024 * 1024)
      disk.bytesRead = 0
      expect(await code(readInstructions(cwd, 'Faye'))).toBe('TOO_LARGE')
      expect(disk.bytesRead).toBe(LIMIT + 1)
    })

    it('refuses an agents that is a file, not a folder', async () => {
      await writeFile(join(cwd, 'agents'), 'not a folder')
      expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
      expect(await code(writeInstructions(cwd, 'Faye', 'x', ''))).toBe('UNSAFE_PATH')
      expect(await readFile(join(cwd, 'agents'), 'utf8')).toBe('not a folder')
    })

    it('does not guess at a file that is not UTF-8, and says so by name: saving the guess would change the person\'s bytes', async () => {
      await put(Buffer.from([0x66, 0xff, 0xfe, 0x66]))
      expect(await code(readInstructions(cwd, 'Faye'))).toBe('NOT_UTF8')
    })

    it.each(BAD_NAMES)('refuses a name that is %s', async (_what, name) => {
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

    // The rules are for the names a disk cannot keep, not for names that merely look like them: an agent called Console,
    // or Con Man, or COM10, or one with a name in Chinese or with emoji in it, has an instructions file.
    it.each([
      ['Console'], ['Auxiliary'], ['nulls'], ['comma'], ['COM10'], ['lpt10'], ['LPT'], ['Con Man'], ['Faye v2'], ['a.b'], ['x'.repeat(100)],
      [cjk(65)], [emoji(49)], [`${cjk(10)} ${emoji(3)} Faye`],
    ])('keeps the file of a name like %s', async (name) => {
      expect(await writeInstructions(cwd, name, 'mine', '')).toEqual({ version: sha256('mine') })
      expect(await readInstructions(cwd, name)).toEqual({ text: 'mine', version: sha256('mine') })
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

    // Written as UTF-8 an unpaired surrogate becomes U+FFFD, so the file would not hold what was sent and the version given
    // back would not be of it: the writer's own editor would then say a change had been made that nobody made.
    it('refuses text with an unpaired surrogate, whole or cut off, before it touches the disk', async () => {
      for (const [what, text] of [
        ['a high one alone', `a${lone(0xd83d)}b`], ['a low one alone', lone(0xde00)], ['an emoji cut off at the end', `ok${lone(0xd83d)}`],
        ['a pair the wrong way round', lone(0xde00) + lone(0xd83d)],
      ]) expect(await code(writeInstructions(cwd, 'Faye', text, '')), what).toBe('BAD_TEXT')
      await expect(stat(join(cwd, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' })
      // A pair the right way round is one character, and is kept whole.
      const saved = await writeInstructions(cwd, 'Faye', `fine ${emoji(1)}`, '')
      expect(saved.version).toBe(sha256(`fine ${emoji(1)}`))
      expect(await readFile(file(), 'utf8')).toBe(`fine ${emoji(1)}`)
    })

    // The folder is made once a save is certain to go ahead, so a refused one leaves nothing behind it but the person's own files.
    it('makes the agents folder only for a save that goes ahead: a refused one leaves none', async () => {
      for (const [what, attempt, refusal] of [
        ['a version for a file that is not there', () => writeInstructions(cwd, 'Faye', 'x', sha256('was here')), 'CHANGED'],
        ['no version for a file that is not there', () => writeInstructions(cwd, 'Faye', 'x', undefined), 'CHANGED'],
        ['text that is not a string', () => writeInstructions(cwd, 'Faye', 5, ''), 'BAD_TEXT'],
        ['text over the limit', () => writeInstructions(cwd, 'Faye', 'a'.repeat(LIMIT + 1), ''), 'TOO_LARGE'],
        ['an unpaired surrogate', () => writeInstructions(cwd, 'Faye', lone(0xd800), ''), 'BAD_TEXT'],
        ['a name that is not one', () => writeInstructions(cwd, '../Faye', 'x', ''), 'BAD_NAME'],
      ] as const) {
        expect(await code(attempt()), what).toBe(refusal)
        await expect(stat(join(cwd, 'agents')), what).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(await readdir(cwd)).toEqual([])
      await writeInstructions(cwd, 'Faye', 'x', '')
      expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
    })

    describe('two saves of one file', () => {
      it('take turns: of eight that saw the same version, the first is saved and the other seven are CHANGED', async () => {
        await put('old')
        const { version } = await readInstructions(cwd, 'Faye')
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => writeInstructions(cwd, 'Faye', `save ${i}`, version)))
        expect(results.map((result) => result.status)).toEqual(['fulfilled', ...Array(7).fill('rejected')])
        for (const result of results.slice(1)) expect(result).toMatchObject({ reason: { code: 'CHANGED' } })
        expect(await readFile(file(), 'utf8')).toBe('save 0')
        expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
      })

      it('each go through when each names the version of the one before it: none is lost to a race, none is refused', async () => {
        await put('v0')
        const texts = ['one', 'two', 'three', 'four']
        const saved = await Promise.all(texts.map((text, i) => writeInstructions(cwd, 'Faye', text, sha256(i === 0 ? 'v0' : texts[i - 1]))))
        expect(saved.map((one) => one.version)).toEqual(texts.map(sha256))
        expect(await readFile(file(), 'utf8')).toBe('four')
      })

      it('go on after one fails: the next is neither held up nor lost', async () => {
        await put('old')
        const { version } = await readInstructions(cwd, 'Faye')
        disk.failRename = Object.assign(new Error('rename failed'), { code: 'EBUSY' })
        const [first, second] = await Promise.allSettled([writeInstructions(cwd, 'Faye', 'first', version), writeInstructions(cwd, 'Faye', 'second', version)])
        expect(first).toMatchObject({ status: 'rejected', reason: { code: 'EBUSY' } })
        expect(second).toEqual({ status: 'fulfilled', value: { version: sha256('second') } })
        expect(await readFile(file(), 'utf8')).toBe('second')
        expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
      })

      it('are no queue for another file: a save of one waits for nobody\'s turn but its own', async () => {
        await put('old')
        const { version } = await readInstructions(cwd, 'Faye')
        let release!: () => void
        disk.holdRename = new Promise<void>((resolve) => { release = resolve })
        const slow = writeInstructions(cwd, 'Faye', 'slow', version)
        await vi.waitFor(() => expect(disk.renameHeld).toBe(true), { timeout: 10_000 })
        expect(await writeInstructions(cwd, 'Ken', 'quick', '')).toEqual({ version: sha256('quick') })
        expect(await readFile(file('Faye'), 'utf8')).toBe('old')
        release()
        expect(await slow).toEqual({ version: sha256('slow') })
        expect(await readFile(file('Faye'), 'utf8')).toBe('slow')
      })
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

    // No read can give such a file's text, so no writer has seen it: whatever version it names, a save over it is refused
    // for what the file is, never as a change somebody else made.
    it('refuses to save over a file that is not UTF-8, by name, whatever version the writer names', async () => {
      const bytes = Buffer.from([0x66, 0xff, 0xfe, 0x66])
      await put(bytes)
      for (const seen of ['', sha256(bytes), sha256('older'), undefined]) {
        expect(await code(writeInstructions(cwd, 'Faye', 'mine', seen)), String(seen)).toBe('NOT_UTF8')
      }
      expect(await readFile(file())).toEqual(bytes)
      expect(await readdir(join(cwd, 'agents'))).toEqual(['Faye.md'])
    })

    it.each(BAD_NAMES)('refuses a name that is %s, and makes no folder', async (_what, name) => {
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
      disk.failRename = Object.assign(new Error('rename failed'), { code: 'EBUSY' })
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
