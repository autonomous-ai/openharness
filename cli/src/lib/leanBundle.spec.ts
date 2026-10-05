import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLeanBundle, writeLeanBundle, type LeanBundle } from './leanBundle.js'

// The writer the build uses (it cannot import TypeScript): what is read back here is what the release
// carries.
// @ts-expect-error — plain ESM with no declaration file, imported to hold the build to the runtime
const { LEAN_MARKER, leanBlock } = await import('../../scripts/lib/leanBlock.mjs') as {
  LEAN_MARKER: string
  leanBlock: (code: string | Uint8Array) => string
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const LEAN = 'console.log("the master and the services")\n'
const CLI = '#!/usr/bin/env node\nconsole.log("the whole CLI")\n/*! a dependency\'s notice */\n'

describe('the lean bundle cli.js carries', () => {
  it('is read back as the build wrote it, with the sha256 of the whole cli.js it came from', () => {
    const bundle = Buffer.from(CLI + leanBlock(LEAN))
    expect(readLeanBundle(bundle)).toEqual({ code: Buffer.from(LEAN), sha256: sha256(LEAN), bundleSha256: sha256(bundle) })
  })

  it('is none in a cli.js that carries none, or anything else that looks like its start', () => {
    expect(readLeanBundle(Buffer.from(CLI))).toBeNull()
    // The marker in the code, as a minified bundle folds the reader's own two pieces back together.
    expect(readLeanBundle(Buffer.from(`const marker = "${LEAN_MARKER}"; /* a comment */ console.log(marker)\n`))).toBeNull()
    expect(readLeanBundle(Buffer.from(`${CLI}${LEAN_MARKER}unterminated`))).toBeNull()
  })

  it('is none when it does not match its checksum, or cannot be unpacked', () => {
    const block = leanBlock(LEAN)
    const [, sum, packed] = /:([0-9a-f]{64}):([^*]+)\*\//.exec(block)!
    expect(readLeanBundle(Buffer.from(CLI + block.replace(sum, sha256('something else'))))).toBeNull()
    expect(readLeanBundle(Buffer.from(CLI + block.replace(packed, Buffer.from('not brotli').toString('base64'))))).toBeNull()
    expect(readLeanBundle(Buffer.from(`${CLI}${LEAN_MARKER}not-a-sum:${packed}*/\n`))).toBeNull()
    expect(readLeanBundle(Buffer.from(`${CLI}${LEAN_MARKER}${sum}*/\n`))).toBeNull()
  })
})

describe('writing the lean bundle out', () => {
  let dir: string
  beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'lean-')), 'lean') })
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))
  const lean = (code: string): LeanBundle => ({ code: Buffer.from(code), sha256: sha256(code), bundleSha256: 'b' })

  it('writes it under its checksum, for its owner alone, and leaves a copy that matches alone', () => {
    const path = writeLeanBundle(dir, lean(LEAN))
    expect(path).toBe(join(dir, `harnessd-${sha256(LEAN).slice(0, 16)}.mjs`))
    expect(readFileSync(path, 'utf8')).toBe(LEAN)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const written = statSync(path).mtimeMs
    expect(writeLeanBundle(dir, lean(LEAN))).toBe(path)
    expect(statSync(path).mtimeMs).toBe(written)
  })

  it('writes over a copy that does not match, and removes every other lean bundle', () => {
    const path = writeLeanBundle(dir, lean(LEAN))
    writeFileSync(path, 'changed on disk')
    writeFileSync(join(dir, 'harnessd-0123456789abcdef.mjs'), 'an older build')
    writeFileSync(join(dir, 'harnessd-0123456789abcdef.mjs.123.tmp'), 'a write a crash cut short')
    writeFileSync(join(dir, 'notes.txt'), 'not a lean bundle')
    expect(writeLeanBundle(dir, lean(LEAN))).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe(LEAN)
    expect(readdirSync(dir).sort()).toEqual([`harnessd-${sha256(LEAN).slice(0, 16)}.mjs`, 'notes.txt'])
  })

  it('says why when the folder cannot be written', () => {
    writeFileSync(join(dir, '..', 'blocked'), 'a file where the folder would go')
    expect(() => writeLeanBundle(join(dir, '..', 'blocked'), lean(LEAN))).toThrow()
    expect(existsSync(join(dir, '..', 'blocked', 'lean'))).toBe(false)
  })
})
