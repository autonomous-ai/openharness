import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstructionsError, readInstructions, readSharedInstructions, writeInstructions } from './agentInstructions.js'

/** The protocol's limit for a file and for a text, written out: the apps are built against this number. */
const LIMIT = 65_536

// What a real disk will not show on demand: the one rename that can fail after the new bytes are safely on disk, so a spec
// can watch what is left behind; a rename held at the last step, so a spec can watch what else goes on meanwhile; a file
// that cannot be opened, as a failing disk would not open it; a file swapped for a named pipe, or for a link, and a folder
// on its way swapped for a link out, just before it is opened, the moment a check of it cannot see; and how many bytes a read
// really took from a file, to prove it is bounded.
const disk = vi.hoisted(() => ({
  failRename: null as Error | null, holdRename: null as Promise<void> | null, renameHeld: false, failOpenOf: null as string | null,
  swapForPipe: null as string | null, swapForLink: null as { file: string; to: string } | null,
  swapFolderForLink: null as { folder: string; to: string } | null, bytesRead: 0,
}))
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
      if (disk.failOpenOf && String(args[0]).endsWith(disk.failOpenOf)) throw Object.assign(new Error('input/output error'), { code: 'EIO' })
      if (disk.swapForPipe && String(args[0]).endsWith(disk.swapForPipe)) { await actual.rm(String(args[0])); execFileSync('mkfifo', [String(args[0])]) }
      if (disk.swapForLink && String(args[0]).endsWith(disk.swapForLink.file)) { await actual.rm(String(args[0])); await actual.symlink(disk.swapForLink.to, String(args[0])) }
      if (disk.swapFolderForLink) {
        const { folder, to } = disk.swapFolderForLink, at = String(args[0]).indexOf(`/${folder}/`)
        if (at >= 0) { const dir = String(args[0]).slice(0, at + folder.length + 1); await actual.rm(dir, { recursive: true }); await actual.symlink(to, dir) }
      }
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle) as (...call: unknown[]) => Promise<{ bytesRead: number }>
      handle.read = (async (...call: unknown[]) => { const result = await read(...call); disk.bytesRead += result.bytesRead; return result }) as typeof handle.read
      return handle
    }),
  }
})

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
/** `n` characters of 3 bytes each in UTF-8, and `n` of 4; and one of 2 bytes. */
const cjk = (n: number) => String.fromCodePoint(0x4e2d).repeat(n)
const emoji = (n: number) => String.fromCodePoint(0x1f600).repeat(n)
const latin = String.fromCodePoint(0xe9)
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
    disk.failRename = null; disk.holdRename = null; disk.renameHeld = false; disk.failOpenOf = null; disk.swapForPipe = null
    disk.swapForLink = null; disk.swapFolderForLink = null
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

    // A save is a file renamed over the old one: a read at the same time is one file or the other, whole, so the version it
    // gives is always that of the text it gives. Not on Windows, where a program holding the file open (a scanner, an indexer)
    // can make a rename over it fail whatever this does. Every save is fsynced: on a Mac with other builds running that took over
    // the default 5 s, so this has its own limit.
    it.skipIf(!posix)('gives a file whole when it is saved at the same time: its version is that of its text', async () => {
      await put('Version 0')
      let version = sha256('Version 0'), saving = true
      const saves = (async () => {
        try { for (let i = 1; i <= 10; i++) version = (await writeInstructions(cwd, 'Faye', `Version ${i}`, version)).version } finally { saving = false }
      })()
      const seen: Array<{ text: string | null; version: string }> = []
      while (saving) seen.push(await readInstructions(cwd, 'Faye'))
      await saves
      expect(seen.length).toBeGreaterThan(0)
      for (const one of seen) expect(one.version).toBe(sha256(one.text!))
    }, 30_000)

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

  // What instructs most agents is the project's own AGENTS.md and CLAUDE.md, in the folder the agent works in, whether or not
  // it has a file of its own here. They are shown beside it and never written: the person sees what the agent is told there.
  describe('the files that instruct it besides, AGENTS.md and CLAUDE.md in its folder (read only)', () => {
    const project = (name: string, content: string | Buffer) => writeFile(join(cwd, name), content)
    /** What is shown, and what is there and not shown, with why. */
    const read = (folder = cwd) => readSharedInstructions(folder)
    // The two files of the agent's folder as they are told: where, and which engine loads each (Codex AGENTS.md, Claude Code CLAUDE.md).
    const shownAgents = (text: string, truncated = false) => ({ name: 'AGENTS.md', path: 'AGENTS.md', loadedBy: ['codex'], text, truncated })
    const shownClaude = (text: string, truncated = false) => ({ name: 'CLAUDE.md', path: 'CLAUDE.md', loadedBy: ['claude'], text, truncated })
    const leftOut = (name: 'AGENTS.md' | 'CLAUDE.md', why: string, error?: unknown) =>
      ({ name, path: name, loadedBy: name === 'AGENTS.md' ? ['codex'] : ['claude'], why, ...(error ? { error } : {}) })
    const shown = async () => (await read()).shared

    it('gives AGENTS.md and then CLAUDE.md, each whole, however they were made', async () => {
      await project('CLAUDE.md', 'Claude rules\n')
      await project('AGENTS.md', 'Agent rules\n')
      expect(await read()).toEqual({
        shared: [
          shownAgents('Agent rules\n'),
          shownClaude('Claude rules\n'),
        ],
        skipped: [],
      })
    })

    it('gives only those that are there, and nothing, making nothing, when none is', async () => {
      expect(await read()).toEqual({ shared: [], skipped: [] })
      await project('CLAUDE.md', 'only this one')
      expect(await read()).toEqual({ shared: [shownClaude('only this one')], skipped: [] })
      await rm(join(cwd, 'CLAUDE.md'))
      await project('AGENTS.md', 'and now only that')
      expect(await read()).toEqual({ shared: [shownAgents('and now only that')], skipped: [] })
      await rm(join(cwd, 'AGENTS.md'))
      expect(await read()).toEqual({ shared: [], skipped: [] })
      expect(await readdir(cwd)).toEqual([])
    })

    it('says there are none when the project folder is not there, and creates nothing', async () => {
      const gone = join(cwd, 'moved-away')
      expect(await read(gone)).toEqual({ shared: [], skipped: [] })
      await expect(stat(gone)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('hands back every byte as written: a byte-order mark, Windows line ends, any script', async () => {
      const text = '\u{FEFF}line one\r\nline two \u{2014} \u{1EA3}nh \u{1F600}\r\n'
      await project('AGENTS.md', text)
      expect(await shown()).toEqual([shownAgents(text)])
    })

    it('reads no subfolder and no other name: only what an engine loads, where it loads it', async () => {
      await mkdir(join(cwd, 'agents'))
      await mkdir(join(cwd, 'docs'))
      await writeFile(join(cwd, 'agents', 'AGENTS.md'), 'SECRET of the agents folder')
      await writeFile(join(cwd, 'docs', 'CLAUDE.md'), 'SECRET of a subfolder')
      for (const other of ['AGENT.md', 'CLAUDE.md.bak', 'GEMINI.md', 'README.md', 'claude.txt', '.cursorrules']) await project(other, 'SECRET of another file')
      expect(await read()).toEqual({ shared: [], skipped: [] })
    })

    // What an agent really gets is more than its folder's two files, and which of them an engine loads differs: Claude Code reads
    // CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md in the folder and in every folder above it; Codex reads, in each folder from
    // the project's root down to the agent's, AGENTS.override.md or else AGENTS.md, one file and not an empty one. So each file comes
    // with where it is, from the agent's folder, and with the engines that load it, and one that nothing loads comes with none.
    describe('what the engines really load', () => {
      const tree = () => join(cwd, '..')
      const repo = () => join(tree(), 'repo')
      const app = () => join(repo(), 'packages', 'app')
      const at = async (path: string, text = path) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) }
      /** Where each file is, and which engines load it. */
      const loads = async (folder: string) => (await read(folder)).shared.map((one) => [one.path, one.loadedBy])
      const git = async (folder: string) => { await mkdir(join(folder, '.git'), { recursive: true }) }

      it('gives the five files of the folder in a fixed order, each with its engines, and an override takes Codex from AGENTS.md', async () => {
        for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) await at(join(cwd, name), name)
        const result = await read()
        expect(result.shared.map((one) => [one.name, one.path, one.loadedBy])).toEqual([
          ['AGENTS.md', 'AGENTS.md', []], ['CLAUDE.md', 'CLAUDE.md', ['claude']], ['AGENTS.override.md', 'AGENTS.override.md', ['codex']],
          ['CLAUDE.local.md', 'CLAUDE.local.md', ['claude']], ['CLAUDE.md', '.claude/CLAUDE.md', ['claude']],
        ])
        expect(result.shared.every((one) => one.text === one.path && one.truncated === false)).toBe(true)
        expect(result.skipped).toEqual([])
      })

      // Codex takes the first of the two that is there, and only then sees it is empty: an empty override leaves that folder nothing.
      it('takes Codex from AGENTS.md for an override that is empty too, and gives it to neither; and to no empty AGENTS.md', async () => {
        await at(join(cwd, 'AGENTS.md'), 'rules')
        await at(join(cwd, 'AGENTS.override.md'), ' \n')
        expect(await loads(cwd)).toEqual([['AGENTS.md', []], ['AGENTS.override.md', []]])
        await rm(join(cwd, 'AGENTS.override.md'))
        await at(join(cwd, 'AGENTS.md'), '\n\n')
        expect(await loads(cwd)).toEqual([['AGENTS.md', []]])
        await at(join(cwd, 'AGENTS.override.md'), ' \n')
        await at(join(cwd, 'AGENTS.md'), '\n\n')
        expect(await loads(cwd)).toEqual([['AGENTS.md', []], ['AGENTS.override.md', []]])
        await rm(join(cwd, 'AGENTS.md'))
        await at(join(cwd, 'AGENTS.override.md'), 'the override alone')
        expect(await loads(cwd)).toEqual([['AGENTS.override.md', ['codex']]])
      })

      it('passes over an override that is a folder, takes one that is not text, and does not know of one the disk failed on', async () => {
        await at(join(cwd, 'AGENTS.md'), 'rules')
        await mkdir(join(cwd, 'AGENTS.override.md'))
        const folder = await read()
        expect(folder.shared.map((one) => [one.path, one.loadedBy])).toEqual([['AGENTS.md', ['codex']]])
        expect(folder.skipped.map((one) => [one.path, one.why, one.loadedBy])).toEqual([['AGENTS.override.md', 'not_a_file', []]])
        await rm(join(cwd, 'AGENTS.override.md'), { recursive: true })
        await writeFile(join(cwd, 'AGENTS.override.md'), Buffer.from([0xff]))
        const bad = await read()
        expect(bad.shared.map((one) => [one.path, one.loadedBy])).toEqual([['AGENTS.md', []]])
        expect(bad.skipped.map((one) => [one.path, one.why, one.loadedBy])).toEqual([['AGENTS.override.md', 'not_text', ['codex']]])
        disk.failOpenOf = 'AGENTS.override.md'
        const failed = await read()
        expect(failed.shared.map((one) => [one.path, one.loadedBy])).toEqual([['AGENTS.md', ['codex']]])
        expect(failed.skipped.map((one) => [one.path, one.why, one.loadedBy])).toEqual([['AGENTS.override.md', 'unreadable', ['codex']]])
      })

      // Codex finds the project's root however far up its `.git` is; only the nearest folders' files are read.
      it('finds a project root more than five folders up, and gives Codex the AGENTS.md of the folders between', async () => {
        await git(repo())
        const deep = join(repo(), 'a', 'b', 'c', 'd', 'e', 'f', 'g')
        await at(join(dirname(deep), 'AGENTS.md'), 'one up')
        await at(join(repo(), 'CLAUDE.md'), 'SECRET seven up')
        await mkdir(deep, { recursive: true })
        expect(await loads(deep)).toEqual([['../AGENTS.md', ['codex']]])
      })

      it('gives the files of the folders above up to the project\'s root, nearest first, and each folder\'s in the same order', async () => {
        await git(repo())
        await at(join(repo(), 'AGENTS.md'))
        await at(join(repo(), 'CLAUDE.md'))
        await at(join(repo(), 'packages', 'AGENTS.md'))
        await at(join(repo(), 'packages', 'CLAUDE.md'))
        await at(join(app(), 'CLAUDE.local.md'))
        expect(await loads(app())).toEqual([
          ['CLAUDE.local.md', ['claude']],
          ['../AGENTS.md', ['codex']], ['../CLAUDE.md', ['claude']],
          ['../../AGENTS.md', ['codex']], ['../../CLAUDE.md', ['claude']],
        ])
      })

      it('reads above the project\'s root only what Claude Code loads there: CLAUDE.md, not AGENTS.md', async () => {
        await git(repo())
        await at(join(tree(), 'CLAUDE.md'), 'above the root')
        await at(join(tree(), 'AGENTS.md'), 'SECRET above the root')
        await mkdir(app(), { recursive: true })
        const result = await read(app())
        expect(result.shared.map((one) => [one.path, one.loadedBy, one.text])).toEqual([['../../../CLAUDE.md', ['claude'], 'above the root']])
        expect(JSON.stringify(result)).not.toContain('SECRET')
      })

      it('reads a project with no `.git` as Codex does, from its own folder alone, and Claude Code by every folder above', async () => {
        await at(join(tree(), 'CLAUDE.md'), 'above')
        await at(join(tree(), 'AGENTS.md'), 'SECRET above')
        await at(join(cwd, 'AGENTS.md'), 'here')
        expect(await loads(cwd)).toEqual([['AGENTS.md', ['codex']], ['../CLAUDE.md', ['claude']]])
      })

      it('takes a worktree, whose `.git` is a file, for the project\'s root: nothing of the repository around it is Codex\'s', async () => {
        await at(join(app(), '.git'), 'gitdir: /somewhere/else')
        await at(join(repo(), 'AGENTS.md'), 'SECRET of the repository around')
        await at(join(repo(), 'CLAUDE.md'), 'of the repository around')
        await at(join(app(), 'AGENTS.md'), 'its own')
        const result = await read(app())
        expect(result.shared.map((one) => [one.path, one.loadedBy])).toEqual([['AGENTS.md', ['codex']], ['../../CLAUDE.md', ['claude']]])
        expect(JSON.stringify(result)).not.toContain('SECRET')
      })

      it('looks in five folders above and no more', async () => {
        const deep = join(tree(), 'a', 'b', 'c', 'd', 'e', 'f', 'g')
        await mkdir(deep, { recursive: true })
        let folder = deep
        for (let up = 1; up <= 7; up++) { folder = dirname(folder); await at(join(folder, 'CLAUDE.md'), `up ${up}`) }
        expect((await read(deep)).shared.map((one) => one.text)).toEqual(['up 1', 'up 2', 'up 3', 'up 4', 'up 5'])
      })

      it.skipIf(!posix)('holds a file above or beside the folder to the rules of a file: a link is followed only inside the project', async () => {
        await git(repo())
        await at(join(repo(), 'CLAUDE.md'), 'the one of the repository')
        await at(join(tree(), 'CLAUDE.md'), 'SECRET above the root')
        await mkdir(app(), { recursive: true })
        await symlink('../../CLAUDE.md', join(app(), 'CLAUDE.md'))
        await symlink(join(tree(), 'CLAUDE.md'), join(app(), 'CLAUDE.local.md'))
        const result = await read(app())
        // A link inside the repository is followed, from a folder inside it: the folder's own CLAUDE.md is the repository's.
        expect(result.shared.filter((one) => one.path === 'CLAUDE.md').map((one) => one.text)).toEqual(['the one of the repository'])
        // A link out of the repository, to the file above it, is not: the file above is shown where it is, never by the link.
        expect(result.skipped).toEqual([{ name: 'CLAUDE.local.md', path: 'CLAUDE.local.md', loadedBy: ['claude'], why: 'link' }])
        expect(result.shared.map((one) => one.path)).toEqual(['CLAUDE.md', '../../CLAUDE.md', '../../../CLAUDE.md'])
      })

      it.skipIf(!posix)('never follows a link above the project\'s root, and says it is a link', async () => {
        await git(repo())
        await at(join(tree(), 'real.md'), 'SECRET')
        await symlink('real.md', join(tree(), 'CLAUDE.md'))
        await mkdir(app(), { recursive: true })
        expect(await read(app())).toEqual({ shared: [], skipped: [{ name: 'CLAUDE.md', path: '../../../CLAUDE.md', loadedBy: ['claude'], why: 'link' }] })
      })

      it.skipIf(!posix)('goes through a `.claude` that is a link only to a place inside the project', async () => {
        await at(join(cwd, 'shared-claude', 'CLAUDE.md'), 'inside')
        await symlink('shared-claude', join(cwd, '.claude'))
        expect(await loads(cwd)).toEqual([['.claude/CLAUDE.md', ['claude']]])
        await rm(join(cwd, '.claude'))
        await at(join(outside, 'CLAUDE.md'), 'SECRET outside')
        await symlink(outside, join(cwd, '.claude'))
        expect(await read()).toEqual({ shared: [], skipped: [{ name: 'CLAUDE.md', path: '.claude/CLAUDE.md', loadedBy: ['claude'], why: 'link' }] })
      })

      // The folders above can hold as much as the folder does, and a reply carries all of it: what is read is held to 256 KiB, and
      // the files after that are there and not shown.
      it('reads no more than 256 KiB of text in all, and says the files after it are there and not shown', async () => {
        for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) await at(join(cwd, name), 'x'.repeat(LIMIT))
        await at(join(tree(), 'CLAUDE.md'), 'in a folder above')
        disk.bytesRead = 0
        const result = await read()
        expect(result.shared.map((one) => one.path)).toEqual(['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md'])
        expect(result.skipped).toEqual([
          { name: 'CLAUDE.md', path: '.claude/CLAUDE.md', loadedBy: ['claude'], why: 'too_much' },
          { name: 'CLAUDE.md', path: '../CLAUDE.md', loadedBy: ['claude'], why: 'too_much' },
        ])
        expect(disk.bytesRead).toBe(4 * LIMIT)
      })

      // A Mac's disk ignores case by default: there `claude.md` is the file the engine opens as CLAUDE.md, and it is no link, though
      // its real path is spelled otherwise. Above the project, where no link is followed, it must still be read as the file it is.
      it('reads a file whose name differs from the engine\'s only in case, on a disk that ignores case, as the plain file it is', async (context) => {
        await at(join(cwd, 'claude.md'), 'lower case')
        if (!await stat(join(cwd, 'CLAUDE.md')).then(() => true, () => false)) return context.skip()
        await at(join(tree(), 'claude.md'), 'above, lower case')
        expect(await read()).toEqual({
          shared: [shownClaude('lower case'), { name: 'CLAUDE.md', path: '../CLAUDE.md', loadedBy: ['claude'], text: 'above, lower case', truncated: false }],
          skipped: [],
        })
      })

      it('says what is not shown with where it is and which engines would load it', async () => {
        await git(repo())
        await at(join(repo(), 'CLAUDE.md'), 'of the repository')
        await writeFile(join(repo(), 'AGENTS.md'), Buffer.from([0xff]))
        await mkdir(join(app(), 'CLAUDE.local.md'), { recursive: true })
        expect(await read(app())).toEqual({
          shared: [{ name: 'CLAUDE.md', path: '../../CLAUDE.md', loadedBy: ['claude'], text: 'of the repository', truncated: false }],
          skipped: [
            { name: 'CLAUDE.local.md', path: 'CLAUDE.local.md', loadedBy: ['claude'], why: 'not_a_file' },
            { name: 'AGENTS.md', path: '../../AGENTS.md', loadedBy: ['codex'], why: 'not_text', error: expect.objectContaining({ code: 'NOT_UTF8' }) },
          ],
        })
      })
    })

    describe('the limit', () => {
      it('is 64 KiB each: a file of exactly that is whole, one byte over is cut there and says so', async () => {
        await project('AGENTS.md', Buffer.alloc(LIMIT, 97))
        await project('CLAUDE.md', Buffer.alloc(LIMIT + 1, 98))
        const [agents, claude] = await shown()
        expect(agents).toEqual(shownAgents('a'.repeat(LIMIT)))
        expect(claude).toEqual(shownClaude('b'.repeat(LIMIT), true))
      })

      // The text stops at a whole character: a cut through one drops the part of it that is there, so what is shown is valid
      // text and not above the limit.
      it.each([
        ['a 2-byte character', 1, latin], ['a 3-byte character', 1, cjk(1)], ['a 3-byte character', 2, cjk(1)],
        ['an emoji', 1, emoji(1)], ['an emoji', 2, emoji(1)], ['an emoji', 3, emoji(1)],
      ])('is cut at a character: %s with %i byte(s) before the limit', async (_what, inside, character) => {
        // `inside` bytes of the character are in the first 64 KiB and the rest of it is past the limit.
        const content = Buffer.from(`${'a'.repeat(LIMIT - inside)}${character}tail`)
        await project('AGENTS.md', content)
        const [one] = await shown()
        expect(one).toEqual(shownAgents('a'.repeat(LIMIT - inside), true))
        expect(Buffer.byteLength(one.text)).toBeLessThanOrEqual(LIMIT)
      })

      it.each([['a 2-byte character', latin, 2], ['a 3-byte character', cjk(1), 3], ['an emoji', emoji(1), 4]])(
        'keeps a character that ends exactly at the limit: %s', async (_what, character, size) => {
          await project('AGENTS.md', `${'a'.repeat(LIMIT - size)}${character}tail`)
          const [one] = await shown()
          expect(one).toEqual(shownAgents(`${'a'.repeat(LIMIT - size)}${character}`, true))
          expect(Buffer.byteLength(one.text)).toBe(LIMIT)
        })

      it('takes one byte past the limit from a huge file, not the file', async () => {
        await project('AGENTS.md', '')
        await truncate(join(cwd, 'AGENTS.md'), 200 * 1024 * 1024)
        disk.bytesRead = 0
        const [one] = await shown()
        expect(one).toMatchObject({ name: 'AGENTS.md', truncated: true })
        expect(one.text).toHaveLength(LIMIT)
        expect(disk.bytesRead).toBe(LIMIT + 1)
      })

      it('shows the start of a file that goes bad only after the limit: that part is never looked at', async () => {
        await project('AGENTS.md', Buffer.concat([Buffer.alloc(LIMIT, 97), Buffer.from([0xff, 0xfe, 0xff])]))
        expect(await read()).toEqual({ shared: [shownAgents('a'.repeat(LIMIT), true)], skipped: [] })
      })
    })

    // Left out, and no more: the person's own file and the other shared one are still shown. What is told is told to the caller,
    // by the file's name and a code and nothing of the file: a file that is not text, and a disk that fails.
    it('leaves out a file that is not UTF-8, cut off in the middle of a character or not, and tells which', async () => {
      await project('CLAUDE.md', 'fine')
      for (const bytes of [[0x66, 0xff, 0xfe, 0x66], [0x61, 0xe2, 0x82]]) {
        await project('AGENTS.md', Buffer.from(bytes))
        expect(await read(), String(bytes)).toEqual({
          shared: [shownClaude('fine')],
          skipped: [leftOut('AGENTS.md', 'not_text', expect.objectContaining({ code: 'NOT_UTF8' }))],
        })
      }
    })

    it('leaves out a file the disk fails on, and tells which: never a path, never a word of it', async () => {
      await project('AGENTS.md', 'SECRET words')
      await project('CLAUDE.md', 'fine')
      disk.failOpenOf = 'AGENTS.md'
      expect(await read()).toEqual({
        shared: [shownClaude('fine')],
        skipped: [leftOut('AGENTS.md', 'unreadable', expect.objectContaining({ code: 'EIO' }))],
      })
    })

    it.skipIf(!unprivileged)('leaves out a file this user may not open, and tells which: the other is still shown', async () => {
      await project('AGENTS.md', 'SECRET words')
      await project('CLAUDE.md', 'fine')
      await chmod(join(cwd, 'AGENTS.md'), 0)
      expect(await read()).toEqual({
        shared: [shownClaude('fine')],
        skipped: [leftOut('AGENTS.md', 'unreadable', expect.objectContaining({ code: 'EACCES' }))],
      })
    })

    it.skipIf(!posix)('tells of each file it would look for when the disk cannot look at the folder at all: a project path that loops', async () => {
      const loop = join(cwd, '..', 'loop')
      await symlink('loop', loop)
      const result = await read(loop)
      expect(result.shared).toEqual([])
      expect(result.skipped.map(({ path, why, error }) => [path, why, (error as NodeJS.ErrnoException).code])).toEqual(
        ['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'].map((path) => [path, 'unreadable', 'ELOOP']))
    })

    it('never writes them: a save of the agent\'s own file leaves both as they were', async () => {
      await project('AGENTS.md', 'agents as they were')
      await project('CLAUDE.md', 'claude as it was')
      const saved = await writeInstructions(cwd, 'Faye', 'mine', '')
      await writeInstructions(cwd, 'Faye', 'mine again', saved.version)
      expect(await readFile(join(cwd, 'AGENTS.md'), 'utf8')).toBe('agents as they were')
      expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('claude as it was')
      expect((await readdir(cwd)).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'agents'])
    })

    // The person's editor, a script or a checkout writes these files while the owner has them open on another computer: a file
    // is replaced by a new one renamed over it, or written in place, and a read can fall anywhere in between. Not run on Windows,
    // where a program holding a file open (a scanner, an indexer) can make a rename over it fail whatever this does. These do
    // real writes and reads, which on a Mac with other builds running took over the default 5 s: so they have their own limit.
    describe('written while it is read', () => {
      /** [step] again and again, a turn at a time, until the function this returns is awaited. */
      const writing = (step: (turn: number) => Promise<void>) => {
        let going = true
        const done = (async () => {
          for (let turn = 0; going; turn++) { await step(turn); await new Promise<void>((resolve) => setImmediate(resolve)) }
        })()
        return async () => { going = false; await done }
      }

      it.skipIf(!posix)('shows a file replaced by a new one renamed over it as one text or the other, never a mix', async () => {
        const one = 'a'.repeat(50_000), two = 'b'.repeat(50_000)
        await project('AGENTS.md', one)
        const stop = writing(async (turn) => {
          await project('.next', turn % 2 ? one : two)
          await rename(join(cwd, '.next'), join(cwd, 'AGENTS.md'))
        })
        try {
          for (let i = 0; i < 30; i++) {
            const { shared, skipped } = await read()
            expect(skipped).toEqual([])
            expect([one, two], `read ${i}`).toContain(shared[0].text)
          }
        } finally { await stop() }
      }, 30_000)

      // Caught half way, text of 3-byte characters can end inside one: that read leaves the file out as not text, and no read fails.
      it.skipIf(!posix)('shows a file written in place as what it held when it was caught, or leaves it out as not text', async () => {
        const text = cjk(20_000)
        await project('AGENTS.md', text)
        const stop = writing((turn) => project('AGENTS.md', turn % 2 ? text : cjk(10_000)))
        try {
          for (let i = 0; i < 30; i++) {
            const { shared, skipped } = await read()
            for (const one of shared) expect(one.text.replaceAll(cjk(1), ''), `read ${i}`).toBe('')
            for (const lost of skipped) expect(lost, `read ${i}`).toMatchObject({ why: 'not_text', error: { code: 'NOT_UTF8' } })
          }
        } finally { await stop() }
      }, 30_000)
    })

    describe.skipIf(!posix)('only a plain file, and a link only where it stays inside the project', () => {
      it('leaves out what is not a plain file, a folder or a named pipe, which is never opened, and says it is not a file', async () => {
        await mkdir(join(cwd, 'AGENTS.md'))
        execFileSync('mkfifo', [join(cwd, 'CLAUDE.md')])
        expect(await read()).toEqual({ shared: [], skipped: [leftOut('AGENTS.md', 'not_a_file'), leftOut('CLAUDE.md', 'not_a_file')] })
      })

      it('says why of each of the two, in their order, when neither is shown', async () => {
        await symlink('nowhere', join(cwd, 'AGENTS.md'))
        await project('CLAUDE.md', Buffer.from([0xff]))
        expect(await read()).toEqual({
          shared: [],
          skipped: [leftOut('AGENTS.md', 'link'), leftOut('CLAUDE.md', 'not_text', expect.objectContaining({ code: 'NOT_UTF8' }))],
        })
      })

      // The check of a file and its opening are two steps. A file swapped for a named pipe between them (a checkout, a program of
      // the person's) would hold the open for ever, and read as empty if it did not: it is opened without waiting, and the handle
      // is looked at again. This is the swap itself, made just before the open.
      it('is not held up by a file swapped for a named pipe after it was checked, and shows nothing of it', async () => {
        await project('AGENTS.md', 'a plain file when it was checked')
        await project('CLAUDE.md', 'fine')
        disk.swapForPipe = 'AGENTS.md'
        expect(await read()).toEqual({ shared: [shownClaude('fine')], skipped: [leftOut('AGENTS.md', 'not_a_file')] })
      })

      it('holds the agent\'s own file to the same: a swap for a named pipe is refused, to a read and to a save', async () => {
        await put('a plain file when it was checked')
        disk.swapForPipe = 'Faye.md'
        expect(await code(readInstructions(cwd, 'Faye'))).toBe('UNSAFE_PATH')
        await rm(file())
        await put('a plain file again')
        expect(await code(writeInstructions(cwd, 'Faye', 'mine', sha256('a plain file again')))).toBe('UNSAFE_PATH')
      })

      it('lets the project folder itself sit behind links, as /tmp does on a Mac', async () => {
        await project('AGENTS.md', 'through the front door')
        const front = join(cwd, '..', 'front')
        await symlink(cwd, front)
        expect(await read(front)).toEqual({ shared: [shownAgents('through the front door')], skipped: [] })
      })

      // A project often makes one of the two the other, or keeps the text in one place (`docs/ai/AGENTS.md`) and links to it. A
      // link is followed when, with every link on the way resolved, it ends at a plain file inside the project, and only then:
      // what it leads to is looked at where it is, and opened as the file that was looked at.
      describe('a link that stays inside the project is followed, and one that leaves it never', () => {
        const agents = () => join(cwd, 'AGENTS.md')
        const secret = () => join(outside, 'secret.md')
        beforeEach(async () => { await writeFile(secret(), 'SECRET outside the project') })

        it.each([
          ['a file beside it, by a relative link', async () => { await project('real.md', 'the text'); await symlink('real.md', agents()) }],
          ['a file beside it, by an absolute link', async () => { await project('real.md', 'the text'); await symlink(join(cwd, 'real.md'), agents()) }],
          ['a file in a subfolder', async () => {
            await mkdir(join(cwd, 'docs'))
            await writeFile(join(cwd, 'docs', 'rules.md'), 'the text')
            await symlink('docs/rules.md', agents())
          }],
          ['a file by a way that goes down and up again', async () => {
            await mkdir(join(cwd, 'docs'))
            await project('real.md', 'the text')
            await symlink('docs/../real.md', agents())
          }],
          ['a file at the end of a chain of links', async () => {
            await project('real.md', 'the text')
            await symlink('real.md', join(cwd, 'mid.md'))
            await symlink('mid.md', agents())
          }],
          ['a file in a folder that is itself a link inside the project', async () => {
            await mkdir(join(cwd, 'real-docs'))
            await writeFile(join(cwd, 'real-docs', 'rules.md'), 'the text')
            await symlink('real-docs', join(cwd, 'docs'))
            await symlink('docs/rules.md', agents())
          }],
        ])('follows a link to %s', async (_what, set) => {
          await set()
          expect(await read()).toEqual({ shared: [shownAgents('the text')], skipped: [] })
        })

        it('shows both when one is a link to the other, as projects often make them, the one text under each name', async () => {
          await project('AGENTS.md', 'the one text')
          await symlink('AGENTS.md', join(cwd, 'CLAUDE.md'))
          expect(await read()).toEqual({ shared: [shownAgents('the one text'), shownClaude('the one text')], skipped: [] })
          await rm(join(cwd, 'AGENTS.md'))
          await rm(join(cwd, 'CLAUDE.md'))
          await project('CLAUDE.md', 'the other text')
          await symlink('CLAUDE.md', join(cwd, 'AGENTS.md'))
          expect(await read()).toEqual({ shared: [shownAgents('the other text'), shownClaude('the other text')], skipped: [] })
        })

        it('holds what it leads to to the same rules as a file: the limit, and text', async () => {
          await project('big.md', Buffer.alloc(LIMIT + 1, 98))
          await project('bad.md', Buffer.from([0xff]))
          await symlink('big.md', agents())
          await symlink('bad.md', join(cwd, 'CLAUDE.md'))
          expect(await read()).toEqual({
            shared: [shownAgents('b'.repeat(LIMIT), true)],
            skipped: [leftOut('CLAUDE.md', 'not_text', expect.objectContaining({ code: 'NOT_UTF8' }))],
          })
        })

        it.each([
          ['a file outside, by an absolute link', async () => { await symlink(secret(), agents()) }],
          ['a file outside, by a way up', async () => { await symlink('../outside/secret.md', agents()) }],
          ['a file outside, at the end of a chain of links', async () => {
            await symlink(secret(), join(cwd, 'mid.md'))
            await symlink('mid.md', agents())
          }],
          ['a file outside, through a folder that is a link out', async () => {
            await symlink(outside, join(cwd, 'docs'))
            await symlink('docs/secret.md', agents())
          }],
          ['a file outside, by a way that goes in and comes out again', async () => {
            await mkdir(join(cwd, 'docs'))
            await symlink('docs/../../outside/secret.md', agents())
          }],
          ['a file in a folder whose name only starts like the project\'s', async () => {
            await mkdir(join(cwd, '..', 'project-other'))
            await writeFile(join(cwd, '..', 'project-other', 'secret.md'), 'SECRET outside the project')
            await symlink('../project-other/secret.md', agents())
          }],
          ['the project\'s folder', async () => { await symlink('.', agents()) }],
          ['the folder above the project', async () => { await symlink('..', agents()) }],
          ['nothing', async () => { await symlink('nowhere.md', agents()) }],
          ['itself', async () => { await symlink('AGENTS.md', agents()) }],
        ])('never follows a link to %s, and says it is a link', async (_what, set) => {
          await set()
          const result = await read()
          expect(result).toEqual({ shared: [], skipped: [leftOut('AGENTS.md', 'link')] })
          expect(JSON.stringify(result)).not.toContain('SECRET')
        })

        it('says a link to a folder or a named pipe inside the project is not a file, and never opens the pipe', async () => {
          await mkdir(join(cwd, 'docs'))
          execFileSync('mkfifo', [join(cwd, 'pipe')])
          await symlink('docs', agents())
          await symlink('pipe', join(cwd, 'CLAUDE.md'))
          expect(await read()).toEqual({ shared: [], skipped: [leftOut('AGENTS.md', 'not_a_file'), leftOut('CLAUDE.md', 'not_a_file')] })
        })

        it.skipIf(!unprivileged)('says a link to a file this user may not open is unreadable', async () => {
          await project('real.md', 'SECRET inside the project')
          await chmod(join(cwd, 'real.md'), 0)
          await symlink('real.md', agents())
          expect(await read()).toEqual({ shared: [], skipped: [leftOut('AGENTS.md', 'unreadable', expect.objectContaining({ code: 'EACCES' }))] })
        })

        // What a link leads to is looked at, and then opened: a folder on the way swapped for a link out between the two would
        // open a file outside by a path that was inside a moment ago. The handle is checked to be the file that was looked at.
        it('is not led out by a folder swapped for a link after the file was looked at', async () => {
          await mkdir(join(cwd, 'docs'))
          await writeFile(join(cwd, 'docs', 'rules.md'), 'inside the project')
          await writeFile(join(outside, 'rules.md'), 'SECRET outside the project')
          await symlink('docs/rules.md', agents())
          disk.swapFolderForLink = { folder: 'docs', to: outside }
          const result = await read()
          expect(result).toEqual({ shared: [], skipped: [leftOut('AGENTS.md', 'not_a_file')] })
          expect(JSON.stringify(result)).not.toContain('SECRET')
        })

        it('is not led out by the file swapped for a link after it was looked at: it is opened without following one', async () => {
          await project('real.md', 'inside the project')
          await symlink('real.md', agents())
          disk.swapForLink = { file: 'real.md', to: secret() }
          const result = await read()
          expect(result).toEqual({ shared: [], skipped: [leftOut('AGENTS.md', 'unreadable', expect.objectContaining({ code: 'ELOOP' }))] })
          expect(JSON.stringify(result)).not.toContain('SECRET')
        })
      })
    })
  })
})
