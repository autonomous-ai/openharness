import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tailFile, tailFileUntil } from './transcriptTail.js'

describe('backward transcript suffix', () => {
  let directory: string, file: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'recap-tail-')); file = join(directory, 'history.jsonl') })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it.each(['\n', '\r\n', '\r'])('matches full readline records with %j separators', async (separator) => {
    const rows = ['older', '  ', 'boundary', 'é📘漢字'.repeat(25_000), '', 'answer', 'tail']
    writeFileSync(file, rows.join(separator))
    const full = await tailFile(file, Infinity)
    expect(await tailFileUntil(file, (line) => line === 'boundary' ? 'stop' : 'keep')).toEqual(full.slice(full.indexOf('boundary')))
  })

  it.each([0, 1, 2, 3, 65_535, 65_536, 65_537])('preserves UTF-8 and a boundary across chunks with %i bytes of tail padding', async (padding) => {
    const rows = ['older', 'boundary📘', 'é📘漢字'.repeat(18_000), 'x'.repeat(padding)]
    writeFileSync(file, rows.join('\n') + '\n')
    expect(await tailFileUntil(file, (line) => line === 'boundary📘' ? 'stop' : 'keep')).toEqual(rows.slice(1).filter(Boolean))
  })

  it('stops before reading older records once it finds the boundary', async () => {
    writeFileSync(file, 'older'.repeat(100_000) + '\nboundary\nanswer\n')
    const seen: string[] = []
    expect(await tailFileUntil(file, (line) => { seen.push(line); return line === 'boundary' ? 'stop' : 'keep' })).toEqual(['boundary', 'answer'])
    expect(seen).toEqual(['answer', 'boundary'])
  })

  it('returns the entire file when there is no boundary, including a final unterminated line', async () => {
    writeFileSync(file, 'first\n\nsecond\nlast')
    expect(await tailFileUntil(file, () => 'keep')).toEqual(await tailFile(file, Infinity))
  })

  it('drops skipped records and stops on a boundary even if all later records are skipped', async () => {
    writeFileSync(file, 'older\nboundary\nignored\nanswer\nignored\n')
    const select = (line: string) => line === 'boundary' ? 'stop' : line === 'ignored' ? 'skip' : 'keep'
    expect(await tailFileUntil(file, select)).toEqual(['boundary', 'answer'])
    writeFileSync(file, 'older\nboundary\nignored\n')
    expect(await tailFileUntil(file, select)).toEqual(['boundary'])
    expect(await tailFileUntil(file, () => 'skip')).toEqual([])
  })

  it.each([65_534, 65_535, 65_536])('preserves CRLF split around the chunk edge with %i trailing bytes', async (padding) => {
    writeFileSync(file, 'older\r\nboundary\r\n' + 'x'.repeat(padding))
    expect(await tailFileUntil(file, (line) => line === 'boundary' ? 'stop' : 'keep')).toEqual(['boundary', 'x'.repeat(padding)])
  })

  it('matches readline with mixed separators and empty records at both file edges', async () => {
    writeFileSync(file, '\n\r\nfirst\rsecond\nthird\r\nfourth\r\n\n')
    expect(await tailFileUntil(file, () => 'keep')).toEqual(await tailFile(file, Infinity))
  })

  it('handles an empty or missing transcript', async () => {
    expect(await tailFileUntil(file, () => 'stop')).toEqual([])
    writeFileSync(file, '')
    expect(await tailFileUntil(file, () => 'stop')).toEqual([])
  })

  it('reads the opening snapshot when the file grows during the read', async () => {
    writeFileSync(file, 'boundary\n' + 'middle'.repeat(30_000) + '\nanswer\n')
    let appended = false
    const result = await tailFileUntil(file, (line) => {
      if (!appended) { appended = true; appendFileSync(file, 'later\n') }
      return line === 'boundary' ? 'stop' : 'keep'
    })
    expect(result).toEqual(['boundary', 'middle'.repeat(30_000), 'answer'])
  })

  it('does not return a mixed result after truncation between chunks', async () => {
    writeFileSync(file, 'boundary\n' + 'middle'.repeat(30_000) + '\nanswer\n')
    let truncated = false
    expect(await tailFileUntil(file, () => {
      if (!truncated) { truncated = true; truncateSync(file, 0) }
      return 'keep'
    })).toEqual([])
  })

  it('returns no result when boundary parsing fails and allows a retry', async () => {
    writeFileSync(file, 'boundary\nanswer\n')
    expect(await tailFileUntil(file, () => { throw new Error('parse failed') })).toEqual([])
    expect(await tailFileUntil(file, () => 'stop')).toEqual(['answer'])
  })
})
