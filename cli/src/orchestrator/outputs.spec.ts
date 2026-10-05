import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readFile: vi.fn(actual.readFile),
  }
})

import { checkOutputs, globToRegExp, readVerdictSnapshot } from './outputs.js'
import * as fsp from 'node:fs/promises'

describe('output globs', () => {
  it.each([
    ['*.step', 'part.step', true], ['*.step', 'sub/part.step', false], ['renders/*.png', 'renders/a.png', true],
    ['**/*.png', 'a.png', true], ['**/*.png', 'a/b/c.png', true], ['out/**', 'out/x/y.mp4', true],
    ['file?.json', 'file1.json', true], ['file?.json', 'file/.json', false], ['a.b', 'axb', false], ['(x)+', '(x)+', true],
  ])('%s vs %s', (glob, path, expected) => { expect(globToRegExp(glob).test(path)).toBe(expected) })
})

describe('checkOutputs', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'outputs-')) })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))
  const write = (path: string, text = 'x') => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text) }

  it('passes when every glob matches and lists files once, sorted', async () => {
    write('b.step'); write('a.step'); write('dimensions.json')
    expect(await checkOutputs(cwd, { files: ['*.step', '*.step', 'dimensions.json'] })).toEqual({ ok: true, files: ['a.step', 'b.step', 'dimensions.json'] })
  })
  it('names what is missing, including the verdict', async () => {
    write('a.step')
    expect(await checkOutputs(cwd, { files: ['*.step', '*.stl'], verdict: 'ready' })).toEqual({ ok: false, missing: ['*.stl', '.harness/verdict.json with ready: true'] })
  })
  it('accepts a ready verdict and rejects a not-ready, oversized or linked one', async () => {
    write('a.step')
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true }))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: true })
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: false }))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    write('.harness/verdict.json', '{ not json')
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true, pad: 'x'.repeat(1024 * 1024) }))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    rmSync(join(cwd, '.harness/verdict.json')); write('elsewhere.json', JSON.stringify({ spec: 1, ready: true }))
    symlinkSync(join(cwd, 'elsewhere.json'), join(cwd, '.harness/verdict.json'))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
  })
  it('rejects .harness as a symlink to an outside folder', async () => {
    write('a.step')
    rmSync(join(cwd, '.harness'), { recursive: true, force: true })
    const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'verdict.json'), JSON.stringify({ spec: 1, ready: true }))
    symlinkSync(outside, join(cwd, '.harness'))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false })
    rmSync(outside, { recursive: true, force: true })
  })
  it('rejects verdict when readFile fails', async () => {
    write('a.step')
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true }))
    const readFileMock = fsp.readFile as any
    readFileMock.mockRejectedValueOnce(new Error('read failed'))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false, missing: ['.harness/verdict.json with ready: true'] })
    vi.restoreAllMocks()
  })
  it('rejects verdict when read buffer exceeds size bound', async () => {
    write('a.step')
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true }))
    const readFileMock = fsp.readFile as any
    const verdictJson = JSON.stringify({ spec: 1, ready: true, pad: 'é'.repeat(600_000) })
    const buffer = Buffer.from(verdictJson, 'utf8')
    readFileMock.mockResolvedValueOnce(buffer)
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false, missing: ['.harness/verdict.json with ready: true'] })
    vi.restoreAllMocks()
  })
  it('rejects verdict when second lstat fails on verdict file', async () => {
    write('a.step')
    write('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true }))
    const lstatMock = fsp.lstat as any
    lstatMock.mockResolvedValueOnce({ isDirectory: () => true }).mockRejectedValueOnce(new Error('permission denied'))
    expect(await checkOutputs(cwd, { files: ['a.step'], verdict: 'ready' })).toMatchObject({ ok: false, missing: ['.harness/verdict.json with ready: true'] })
    vi.restoreAllMocks()
  })
  it('ignores upstream inputs and symlinks', async () => {
    write('inputs/part/a.step')
    write('real/a.step')
    const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'b.step'), 'x')
    symlinkSync(join(outside, 'b.step'), join(cwd, 'b.step')); symlinkSync(outside, join(cwd, 'linked'))
    expect(await checkOutputs(cwd, { files: ['**/*.step'] })).toEqual({ ok: true, files: ['real/a.step'] })
    rmSync(outside, { recursive: true, force: true })
  })
  it('snapshots a verdict as ready and counts, or nothing', async () => {
    mkdirSync(join(cwd, '.harness'))
    writeFileSync(join(cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, findings: [{ severity: 'error' }, { severity: 'warning' }, { severity: 'warning' }] }))
    expect(await readVerdictSnapshot(cwd)).toEqual({ ready: false, errors: 1, warnings: 2 })
    writeFileSync(join(cwd, '.harness/verdict.json'), '{nope')
    expect(await readVerdictSnapshot(cwd)).toBeUndefined()
    expect(await readVerdictSnapshot(join(cwd, 'missing'))).toBeUndefined()
  })
  it('bounds the walk and the number of matches', async () => {
    for (let i = 0; i < 65; i++) write(`many/${i}.png`)
    expect(await checkOutputs(cwd, { files: ['many/*.png'] })).toEqual({ ok: false, missing: ['at most 64 output files (matched 65)'] })
    let deep = 'd'; for (let i = 0; i < 20; i++) deep += '/d'
    write(`${deep}/x.bin`)
    expect(await checkOutputs(cwd, { files: ['**/x.bin'] })).toMatchObject({ ok: false })
  })
  it('skips the loop check logs when it looks for outputs', async () => {
    mkdirSync(join(cwd, '.harness/loop'), { recursive: true }); writeFileSync(join(cwd, '.harness/loop/1.stdout.log'), 'x')
    mkdirSync(join(cwd, 'logs')); writeFileSync(join(cwd, 'logs/run.log'), 'y')
    expect(await checkOutputs(cwd, { files: ['**/*.log'] })).toEqual({ ok: true, files: ['logs/run.log'] })
  })
  it.each([
    ['.harness/loop is a link', 'logs', '.harness/loop', 'logs/1.stdout.log'],
    ['.harness is a link', 'sub', '.harness', 'sub/loop/1.stdout.log'],
  ])('skips the loop check logs where they really are when %s', async (_name, target, link, real) => {
    write(real); write('other/run.log', 'y')
    mkdirSync(join(cwd, link, '..'), { recursive: true }); symlinkSync(join(cwd, target), join(cwd, link))
    expect(await checkOutputs(cwd, { files: ['**/*.log'] })).toEqual({ ok: true, files: ['other/run.log'] })
  })
  it('refuses folders too large to walk', async () => {
    for (let i = 0; i < 10_001; i++) writeFileSync(join(cwd, `f${i}`), '')
    await expect(checkOutputs(cwd, { files: ['f1'] })).rejects.toMatchObject({ code: 'OUTPUTS_TOO_LARGE' })
  })
})
