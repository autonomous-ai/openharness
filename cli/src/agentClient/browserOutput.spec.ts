import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browserFolder, BrowserFilesError, capOutput, KEPT_FILES, OUTPUT_CAP_CHARS, saveScreenshot } from './browserOutput.js'

const dirs: string[] = []
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-output-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

const AT = new Date(Date.UTC(2026, 10, 11, 9, 5, 7, 42))
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
// Root writes anywhere, so a folder it cannot write does not exist for it.
const asRoot = process.geteuid?.() === 0

/** Throws whatever `run` throws, or fails the test when it throws nothing. */
const thrown = (run: () => unknown): unknown => {
  try { run() } catch (error) { return error }
  throw new Error('it did not throw')
}

describe('browserFolder', () => {
  it('is $TMPDIR/browser, made 0700', () => {
    const tmp = fresh()
    const folder = browserFolder({ TMPDIR: tmp })
    expect(folder).toBe(join(tmp, 'browser'))
    expect(statSync(folder).isDirectory()).toBe(true)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
  })

  it('closes a folder that was left open', () => {
    const tmp = fresh()
    mkdirSync(join(tmp, 'browser'), { mode: 0o755 })
    chmodSync(join(tmp, 'browser'), 0o755)
    expect(statSync(browserFolder({ TMPDIR: tmp })).mode & 0o777).toBe(0o700)
  })
})

describe('saveScreenshot', () => {
  it('writes the screenshot whole and gives back only its path', () => {
    const tmp = fresh()
    const path = saveScreenshot({ TMPDIR: tmp }, JPEG.toString('base64'), AT)
    expect(path).toBe(join(tmp, 'browser', 'shot-20261111-090507-042.jpg'))
    expect(readFileSync(path).equals(JPEG)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('never writes over a screenshot taken in the same millisecond', () => {
    const tmp = fresh()
    const first = saveScreenshot({ TMPDIR: tmp }, JPEG.toString('base64'), AT)
    const second = saveScreenshot({ TMPDIR: tmp }, Buffer.from('second').toString('base64'), AT)
    expect(second).not.toBe(first)
    expect(readFileSync(first).equals(JPEG)).toBe(true)
    expect(readFileSync(second, 'utf8')).toBe('second')
  })
})

describe('capOutput', () => {
  it('prints text under the cap as it is and writes no file', () => {
    const tmp = fresh()
    const text = 'x'.repeat(OUTPUT_CAP_CHARS)
    expect(capOutput({ TMPDIR: tmp }, text, AT)).toBe(text)
    expect(existsSync(join(tmp, 'browser'))).toBe(false)
  })

  it('cuts longer text at the cap, saves it whole, and ends with the line that names the file', () => {
    const tmp = fresh()
    const text = 'a'.repeat(OUTPUT_CAP_CHARS) + 'tail'
    const path = join(tmp, 'browser', 'output-20261111-090507-042.txt')
    expect(capOutput({ TMPDIR: tmp }, text, AT))
      .toBe(`${'a'.repeat(OUTPUT_CAP_CHARS)}\nCut at ${OUTPUT_CAP_CHARS} characters. The whole output: ${path}`)
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('never cuts a character in half', () => {
    const tmp = fresh()
    const text = 'a'.repeat(OUTPUT_CAP_CHARS - 1) + '😀' + 'tail'
    expect(capOutput({ TMPDIR: tmp }, text, AT).split('\n')[0]).toBe('a'.repeat(OUTPUT_CAP_CHARS - 1))
  })

  it('is 8000 characters, under what both engines keep of a command (measurements of 2026-11-11)', () => {
    expect(OUTPUT_CAP_CHARS).toBe(8_000)
  })
})

describe('the folder keeps the newest files', () => {
  it(`keeps ${KEPT_FILES}: one more deletes the oldest, whatever its kind`, () => {
    const tmp = fresh()
    const folder = browserFolder({ TMPDIR: tmp })
    // Written out of name order, so the oldest is found by its time, not its name.
    for (let i = 0; i < KEPT_FILES; i++) {
      const name = i % 2 ? `shot-old-${i}.jpg` : `output-old-${i}.txt`
      writeFileSync(join(folder, name), 'old')
      const at = new Date(Date.UTC(2026, 0, 1) + (KEPT_FILES - i) * 1000)
      utimesSync(join(folder, name), at, at)
    }
    const oldest = `shot-old-${KEPT_FILES - 1}.jpg`

    const shot = saveScreenshot({ TMPDIR: tmp }, JPEG.toString('base64'), AT)
    const names = readdirSync(folder)
    expect(names).toHaveLength(KEPT_FILES)
    expect(names).not.toContain(oldest)
    expect(existsSync(shot)).toBe(true)

    const next = `output-old-${KEPT_FILES - 2}.txt`
    capOutput({ TMPDIR: tmp }, 'b'.repeat(OUTPUT_CAP_CHARS + 1), AT)
    expect(readdirSync(folder)).toHaveLength(KEPT_FILES)
    expect(readdirSync(folder)).not.toContain(next)
  })
})

describe('when the files cannot be written (Review Focus 3)', () => {
  const cases: Array<[string, () => NodeJS.ProcessEnv]> = [
    ['with no TMPDIR', () => ({})],
    ['with an empty TMPDIR', () => ({ TMPDIR: '' })],
    ['with browser a file', () => {
      const tmp = fresh()
      writeFileSync(join(tmp, 'browser'), 'not a folder')
      return { TMPDIR: tmp }
    }],
  ]
  if (!asRoot) {
    cases.push(['with a TMPDIR that cannot be written', () => {
      const tmp = fresh()
      chmodSync(tmp, 0o500)
      return { TMPDIR: tmp }
    }])
  }

  for (const [name, env] of cases) {
    it(`${name}, a screenshot and long output throw one line and write nothing elsewhere`, () => {
      const cwd = readdirSync(process.cwd())
      for (const run of [
        () => saveScreenshot(env(), JPEG.toString('base64'), AT),
        () => capOutput(env(), 'c'.repeat(OUTPUT_CAP_CHARS + 1), AT),
      ]) {
        const error = thrown(run)
        expect(error).toBeInstanceOf(BrowserFilesError)
        expect((error as Error).message).not.toContain('\n')
        expect((error as Error).message.length).toBeGreaterThan(0)
      }
      expect(readdirSync(process.cwd())).toEqual(cwd)
    })
  }

  it('a browser folder that is a link elsewhere is refused, and nothing is written through it', () => {
    const tmp = fresh()
    const folder = browserFolder({ TMPDIR: tmp })
    rmSync(folder, { recursive: true })
    const elsewhere = fresh()
    mkdirSync(join(elsewhere, 'target'), { mode: 0o700 })
    symlinkSync(join(elsewhere, 'target'), folder)
    expect(thrown(() => saveScreenshot({ TMPDIR: tmp }, JPEG.toString('base64'), AT))).toBeInstanceOf(BrowserFilesError)
    expect(readdirSync(join(elsewhere, 'target'))).toEqual([])
  })
})
