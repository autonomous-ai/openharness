import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRecordsBackward, streamRecords, tailFile, tailFileCapped, tailFileUntil, WHOLE_READ_CAP_BYTES } from './transcriptTail.js'

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

describe('record walks', () => {
  let directory: string, file: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'record-walk-')); file = join(directory, 't.jsonl') })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  const records = ['first', 'é📘漢字'.repeat(30_000), '{"third":3}', 'x'.repeat(70_000), 'last']
  const offsets = (text: string, separator: string) => {
    const out: number[] = []
    let at = 0
    for (const part of text.split(separator)) { if (part.trim()) out.push(Buffer.byteLength(text.slice(0, at))); at += part.length + separator.length }
    return out
  }
  const backward = async (end?: number, max?: number) => {
    const seen: Array<[string, number]> = []
    const whole = await scanRecordsBackward(file, end ?? (await import('node:fs')).statSync(file).size, (bytes, offset) => { seen.push([bytes.toString('utf8'), offset]) }, max)
    return { whole, seen: seen.reverse() }
  }
  const forward = async (start = 0, end?: number, complete = (_: string) => true, max?: number, stopAt?: string) => {
    const seen: Array<[string, number]> = []
    const read = await streamRecords(file, start, end ?? (await import('node:fs')).statSync(file).size, (line, offset) => {
      seen.push([line, offset])
      return line === stopAt
    }, complete, max)
    return { read, seen }
  }

  it.each(['\n', '\r\n', '\r'])('agree on every record and where it starts with %j separators', async (separator) => {
    const text = records.join(separator) + separator
    writeFileSync(file, text)
    const expected = records.map((record, index) => [record, offsets(text, separator)[index]])
    expect((await backward()).seen).toEqual(expected)
    expect((await forward()).seen).toEqual(expected)
    expect((await forward()).read).toEqual({ next: Buffer.byteLength(text), records: 5, partial: false })
  })

  it('skip blank records by JavaScript trim rules, without dropping invisible but non-blank ones', async () => {
    writeFileSync(file, ['a', '   ', '\u00a0\u2028\ufeff', '\u0001', '\t', 'b'].join('\n'))
    const expected = [['a', 0], ['\u0001', Buffer.byteLength('a\n   \n\u00a0\u2028\ufeff\n')], ['b', Buffer.byteLength('a\n   \n\u00a0\u2028\ufeff\n\u0001\n\t\n')]]
    expect((await backward()).seen).toEqual(expected)
    expect((await forward()).seen).toEqual(expected)
  })

  it('stop when the visitor says so', async () => {
    writeFileSync(file, 'a\nb\nc\n')
    const seen: string[] = []
    expect(await scanRecordsBackward(file, 6, (bytes) => { seen.push(bytes.toString()); return bytes.toString() === 'b' })).toBe(true)
    expect(seen).toEqual(['c', 'b'])
    expect(await forward(0, undefined, undefined, undefined, 'b')).toEqual({ read: { next: 4, records: 2, partial: false }, seen: [['a', 0], ['b', 2]] })
  })

  it('pass over a record longer than the limit, whether or not it spans chunks', async () => {
    for (const big of ['y'.repeat(100), 'y'.repeat(200_000)]) {
      writeFileSync(file, `a\n${big}\nb\n`)
      const at = Buffer.byteLength(`a\n${big}\n`)
      expect((await backward(undefined, 50)).seen).toEqual([['a', 0], ['b', at]])
      expect((await forward(0, undefined, undefined, 50)).seen).toEqual([['a', 0], ['b', at]])
      writeFileSync(file, `${big}\nb`)
      expect((await backward(undefined, 50)).seen).toEqual([['b', big.length + 1]])
      writeFileSync(file, `a\n${big}`)
      expect((await forward(0, undefined, undefined, 50)).read).toEqual({ next: 2, records: 1, partial: false })
    }
  })

  it('leave a final record without its line ending to the reader after, unless it is complete', async () => {
    writeFileSync(file, '{"a":1}\n{"b":')
    expect(await forward(0, undefined, (line) => { try { JSON.parse(line); return true } catch { return false } }))
      .toEqual({ read: { next: 8, records: 1, partial: true }, seen: [['{"a":1}', 0]] })
    writeFileSync(file, '{"a":1}\n{"b":2}')
    expect((await forward(0, undefined, () => true)).read).toEqual({ next: 15, records: 2, partial: false })
    writeFileSync(file, '{"a":1}\n   ')
    expect((await forward(0, undefined, () => false)).read).toEqual({ next: 8, records: 1, partial: false })
  })

  it('start mid-file and keep a CRLF split across the chunk edge together', async () => {
    writeFileSync(file, 'skip\r\n' + 'z'.repeat(65_535) + '\r\nend\r\n')
    expect(await forward(6)).toEqual({
      read: { next: 6 + 65_535 + 2 + 5, records: 2, partial: false },
      seen: [['z'.repeat(65_535), 6], ['end', 6 + 65_535 + 2]],
    })
  })

  it('report a file that shrank under the walk', async () => {
    writeFileSync(file, 'a\nb\n')
    expect(await scanRecordsBackward(file, 500, () => {})).toBe(false)
    expect(await streamRecords(file, 0, 500, () => {}, () => true)).toBeNull()
  })

  it('walk nothing in an empty range', async () => {
    writeFileSync(file, 'a\n')
    expect(await scanRecordsBackward(file, 0, () => { throw new Error('visited') })).toBe(true)
    expect(await streamRecords(file, 2, 2, () => { throw new Error('fed') }, () => true)).toEqual({ next: 2, records: 0, partial: false })
  })
})

describe('tailFile', () => {
  let directory: string, file: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'tail-file-')); file = join(directory, 't.jsonl') })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('returns nothing for a count that is not a positive number', async () => {
    writeFileSync(file, 'a\nb\n')
    expect(await tailFile(file, Number.NaN)).toEqual([])
    expect(await tailFile(file, -Infinity)).toEqual([])
    expect(await tailFile(file, 0)).toEqual([])
    expect(await tailFile(file, 1.9)).toEqual(['b'])
  })
})

describe('tailFileCapped', () => {
  let directory: string, file: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'tail-capped-')); file = join(directory, 't.jsonl') })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('reads a file under the cap whole, as tailFile does, with the same line rules', async () => {
    writeFileSync(file, '{"a":1}\r\n\n{"b":"é"}\r{"c":3}\n   \n{"d":4}')
    expect(await tailFileCapped(file)).toEqual({ lines: await tailFile(file, Infinity), truncated: false })
    expect((await tailFileCapped(file)).lines).toEqual(['{"a":1}', '{"b":"é"}', '{"c":3}', '{"d":4}'])
    expect(WHOLE_READ_CAP_BYTES).toBe(64 * 1024 * 1024)
  })

  it('keeps only the newest records that fit, in order, and says older ones were left', async () => {
    const records = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(90) }))
    writeFileSync(file, records.join('\n') + '\n')
    const each = Buffer.byteLength(records[0])
    expect(await tailFileCapped(file, each * 3)).toEqual({ lines: records.slice(-3), truncated: true })
    expect(await tailFileCapped(file, each * 3 + 1)).toEqual({ lines: records.slice(-3), truncated: true })
    expect(await tailFileCapped(file, each * 10)).toEqual({ lines: records, truncated: false })
    // A newest record bigger than the cap: nothing that fits is newer, so nothing is read.
    expect(await tailFileCapped(file, each - 1)).toEqual({ lines: [], truncated: true })
  })

  it('reads nothing of a file that is not there', async () => {
    expect(await tailFileCapped(join(directory, 'gone.jsonl'))).toEqual({ lines: [], truncated: false })
  })
})
