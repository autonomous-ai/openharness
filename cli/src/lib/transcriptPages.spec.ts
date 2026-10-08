import { appendFileSync, chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexPageStart, windowCodexLines } from '../engines/codex/normalizer.js'
import { claude, claudeScenario, codex, codexScenario } from '../testing/transcriptScenarios.js'
import { claudePageLine, windowRawLines } from './normalize.js'
import { tailFile } from './transcriptTail.js'
import { LineIndex, pageBefore, TranscriptPager, type HistoryPage, type OpenFile } from './transcriptPages.js'

let dir: string
let files = 0
const fresh = (content: string | Buffer): string => {
  const file = join(dir, `t${++files}.jsonl`)
  writeFileSync(file, content)
  return file
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'transcript-pages-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

type Engine = 'claude' | 'codex'
const window = (engine: Engine, lines: string[], opts: { limit: number; before?: string }) =>
  engine === 'claude' ? windowRawLines(lines, opts) : windowCodexLines(lines, opts)
const asOld = (page: HistoryPage) => ({ window: page.lines, hasMore: page.hasMore, oldestCursor: page.oldestCursor, staleCursor: page.staleCursor })

/** Page back through `file` from its end, both ways, until the start; every page and cursor must match. */
async function pageThrough(engine: Engine, file: string, limit: number): Promise<number> {
  const lines = await tailFile(file, Infinity)
  const pager = new TranscriptPager()
  let before: string | undefined
  for (let pages = 1; ; pages++) {
    const old = window(engine, lines, { limit, before })
    const now = await pager[engine](file, { limit, before })
    expect(asOld(now), `${engine} page ${pages}, limit ${limit}, before ${before}`).toEqual(old)
    expect(now.clipped).toBe(false)
    if (!old.hasMore || old.staleCursor || old.oldestCursor === null) return pages
    before = old.oldestCursor
  }
}

/** These cases do a fixed amount of real file work, the subject here: a page read is reads of a file on disk.
 *  One cut is up to 16 sweeps of a file page by page, and the growing-file case 600 appends, each with an
 *  index update and a whole-file read: hundreds of reads either way. 1.2 to 3.1 s under 12 busy loops on a
 *  12-core Mac (load 50 to 77), and past vitest's 5 s in a full run under more. Room for the reads, not a
 *  wait for anything: none of them waits on a clock. */
const FILE_WORK_TIMEOUT_MS = 30_000

describe('history pages equal the windows cut from the whole file', { timeout: FILE_WORK_TIMEOUT_MS }, () => {
  describe.each([['claude', claudeScenario], ['codex', codexScenario]] as const)('%s', (engine, scenario) => {
    const records = scenario()
    const cuts = records.map((_, index) => index + 1)

    it.each(cuts)('after record %i, with every ending, a half-written record or none, and every page size', async (cut) => {
      for (const ending of ['\n', '\r\n']) {
        const body = records.slice(0, cut).join(ending) + ending
        const variants = [body]
        if (cut < records.length) variants.push(body + records[cut].slice(0, Math.floor(records[cut].length / 2)))
        for (const content of variants) {
          const file = fresh(content)
          expect(await new TranscriptPager().lineCount(file)).toBe((await tailFile(file, Infinity)).length)
          for (const limit of [1, 3, 7, 500]) await pageThrough(engine, file, limit)
        }
      }
    })

    it('reads lines ended by CR alone, and passes over blank ones', async () => {
      const file = fresh(['', ...records.slice(0, 20), '   ', '\t'].join('\r') + '\r\r\n\n')
      for (const limit of [1, 4, 500]) await pageThrough(engine, file, limit)
    })

    it('says a cursor it cannot find is stale, as the old window did', async () => {
      const file = fresh(records.join('\n') + '\n')
      const lines = await tailFile(file, Infinity)
      const pager = new TranscriptPager()
      for (const before of ['nothing-like-it', 'codex:x', `codex:${lines.length + 1}`, 'codex:99999999999999999999']) {
        expect(asOld(await pager[engine](file, { limit: 5, before }))).toEqual(window(engine, lines, { limit: 5, before }))
      }
    })

    it('gives every line, oldest first, when asked for no page at all', async () => {
      const file = fresh(records.join('\n') + '\n')
      const page = await new TranscriptPager()[engine](file, {})
      expect(page.lines).toEqual(await tailFile(file, Infinity))
      expect(page.hasMore).toBe(false)
    })
  })

  it('reads a transcript that is missing, or cannot be read, as an empty one', async () => {
    const pager = new TranscriptPager()
    const missing = join(dir, 'gone.jsonl')
    for (const before of [undefined, 'u1']) {
      expect(asOld(await pager.claude(missing, { limit: 5, before }))).toEqual(windowRawLines([], { limit: 5, before }))
    }
    for (const before of [undefined, 'codex:0', 'codex:1']) {
      expect(asOld(await pager.codex(missing, { limit: 5, before }))).toEqual(windowCodexLines([], { limit: 5, before }))
    }
    expect(await pager.lineCount(missing)).toBe(0)
    const locked = fresh(claudeScenario().join('\n') + '\n')
    chmodSync(locked, 0o000)
    try {
      expect(asOld(await pager.claude(locked, { limit: 5 }))).toEqual(windowRawLines([], { limit: 5 }))
      expect((await pager.claude(locked, { limit: 5, before: 'u1' })).staleCursor).toBe(true)
      expect(await pageBefore(locked, 100, 5, { startsPage: () => true })).toEqual({ lines: [], count: 0, start: 0, hasMore: false, clipped: false })
    } finally { chmodSync(locked, 0o600) }
  })

  it('names the line a cursor stood on when no page is left before it', async () => {
    const records = claudeScenario()
    const file = fresh(records.join('\n') + '\n')
    const first = claudePageLine(records[1]).cursor!
    const lines = await tailFile(file, Infinity)
    const pager = new TranscriptPager()
    // Paging back from the second line leaves only the first, which has no id of its own.
    expect(asOld(await pager.claude(file, { limit: 5, before: first }))).toEqual(windowRawLines(lines, { limit: 5, before: first }))
    const top = claudePageLine(records[0]).cursor
    expect(top).toBeNull()
    const withId = fresh(records.slice(1).join('\n') + '\n')
    const page = await pager.claude(withId, { limit: 5, before: first })
    expect(asOld(page)).toEqual(windowRawLines(await tailFile(withId, Infinity), { limit: 5, before: first }))
    expect(page.oldestCursor).toBe(first)
  })
})

describe('a Claude cursor', () => {
  it('names the newest line with its id, where the old window took the oldest', async () => {
    const twice = claude.user('a prompt written twice')
    const records = [claude.user('one'), twice, claude.user('two'), twice, claude.user('three')]
    const file = fresh(records.join('\n') + '\n')
    const before = claudePageLine(twice).cursor!
    const page = await new TranscriptPager().claude(file, { limit: 1, before })
    expect(page.lines).toEqual([records[2]])
    expect(windowRawLines(await tailFile(file, Infinity), { limit: 1, before }).window).toEqual([records[0]])
  })

  it('is found again from where it was served, and by walking the file when that no longer names it', async () => {
    const records = claudeScenario()
    const file = fresh(records.join('\n') + '\n')
    const pager = new TranscriptPager()
    const first = await pager.claude(file, { limit: 3 })
    const again = await pager.claude(file, { limit: 3, before: first.oldestCursor! })
    expect(again).toEqual(await new TranscriptPager().claude(file, { limit: 3, before: first.oldestCursor! }))
    // Rewritten so the byte remembered for that cursor now starts another line.
    writeFileSync(file, [claude.user('a new first line, longer than before'), ...records].join('\n') + '\n')
    expect(await pager.claude(file, { limit: 3, before: first.oldestCursor! }))
      .toEqual(await new TranscriptPager().claude(file, { limit: 3, before: first.oldestCursor! }))
    // And when the file shrank past it.
    writeFileSync(file, records.slice(0, 2).join('\n') + '\n')
    expect((await pager.claude(file, { limit: 3, before: first.oldestCursor! })).staleCursor).toBe(true)
  })

  it('is matched as a whole id, and an id with characters JSON may escape is read the slow way', async () => {
    const odd = 'id with "quotes" and /slashes/'
    const records = [claude.user('one'), JSON.stringify({ type: 'user', id: odd, message: { role: 'user', content: 'two' } }), claude.user('three')]
    const file = fresh(records.join('\n') + '\n')
    const lines = await tailFile(file, Infinity)
    const pager = new TranscriptPager()
    expect(asOld(await pager.claude(file, { limit: 1, before: odd }))).toEqual(windowRawLines(lines, { limit: 1, before: odd }))
    const prefix = claudePageLine(records[2]).cursor!.slice(0, -1)
    expect((await pager.claude(file, { limit: 1, before: prefix })).staleCursor).toBe(true)
  })

  it('remembers a bounded number of cursors and files', async () => {
    const pager = new TranscriptPager({ capacity: 2 })
    const records = Array.from({ length: 80 }, (_, i) => claude.user(`prompt ${i}`))
    const file = fresh(records.join('\n') + '\n')
    let before: string | undefined
    for (let i = 0; i < 70; i++) before = (await pager.claude(file, { limit: 1, before })).oldestCursor!
    for (let i = 0; i < 3; i++) await pager.claude(fresh(records.join('\n') + '\n'), { limit: 1 })
    expect(await pager.claude(file, { limit: 1, before })).toEqual(await new TranscriptPager().claude(file, { limit: 1, before }))
  })
})

describe('a page held to its size', () => {
  const rules = { startsPage: (line: string) => line.startsWith('{"start"') }
  const start = (n: number, pad = 0) => JSON.stringify({ start: n, pad: 'x'.repeat(pad) })
  const step = (n: number, pad = 0) => JSON.stringify({ step: n, pad: 'x'.repeat(pad) })

  it('ends at the oldest turn that fits, short of its limit, so no turn is split', async () => {
    const records = [start(1), step(1), start(2, 100), step(2, 100), start(3), step(3)]
    const file = fresh(records.join('\n') + '\n')
    const end = Buffer.byteLength(records.join('\n') + '\n')
    // 39 bytes reach back to turn 3, 278 to turn 2: a page of 200 holds turn 3 alone.
    expect(await pageBefore(file, end, 6, rules, 200)).toMatchObject({ lines: records.slice(4), count: 2, hasMore: true, clipped: false })
    expect(await pageBefore(file, end, 6, rules, 300)).toMatchObject({ lines: records.slice(2), count: 4, hasMore: true, clipped: false })
  })

  it('cuts a turn that cannot fit inside it, and says so', async () => {
    const records = [start(1), step(1, 100), step(2, 100), step(3, 100)]
    const file = fresh(records.join('\n') + '\n')
    const page = (await pageBefore(file, Buffer.byteLength(records.join('\n') + '\n'), 2, rules, 250))!
    expect(page).toMatchObject({ lines: records.slice(2), hasMore: true, clipped: true })
  })

  it('counts a line too long to hold where it stands, and leaves it out', async () => {
    const records = [start(1), step(1), step(2, 400), step(3), start(2), step(4)]
    const file = fresh(records.join('\n') + '\n')
    const end = Buffer.byteLength(records.join('\n') + '\n')
    expect(await pageBefore(file, end, 2, rules, 300)).toMatchObject({ lines: records.slice(4), count: 2, hasMore: true })
    // Turn 1 holds the long line: it counts, and the page holds the rest of the turn around it.
    expect(await pageBefore(file, end, 3, rules, 300))
      .toMatchObject({ lines: [records[0], records[1], records[3], records[4], records[5]], count: 6, hasMore: false })
    // Asked for the page right after one ended on a long line: the line still counts toward it.
    const fromLong = (await pageBefore(file, Buffer.byteLength(records.slice(0, 3).join('\n') + '\n'), 1, rules, 300))!
    expect(fromLong).toMatchObject({ lines: [records[0], records[1]], count: 3, hasMore: false })
    const afterReach = (await pageBefore(file, Buffer.byteLength(records.slice(0, 4).join('\n') + '\n'), 1, rules, 300))!
    expect(afterReach).toMatchObject({ lines: [records[0], records[1], records[3]], count: 4 })
    // A long line just before a page that is already complete is the next page's.
    const complete = (await pageBefore(file, Buffer.byteLength(records.slice(0, 4).join('\n') + '\n'), 1, { startsPage: () => true }, 300))!
    expect(complete).toMatchObject({ lines: [records[3]], count: 1, hasMore: true })
  })

  it('pages a Codex rollout through lines too long to hold, every line in exactly one page', async () => {
    const records = codexScenario()
    const file = fresh(records.join('\n') + '\n')
    const pager = new TranscriptPager({ maxBytes: 20_000 })
    const seen: string[] = []
    let before: string | undefined
    let endIndex = records.length
    for (;;) {
      const page = await pager.codex(file, { limit: 4, before })
      seen.unshift(...page.lines)
      const start = Number(page.oldestCursor!.slice('codex:'.length))
      expect(start).toBeLessThan(endIndex)
      endIndex = start
      if (!page.hasMore) break
      before = page.oldestCursor!
    }
    expect(endIndex).toBe(0)
    expect(seen).toEqual(records.filter((record) => Buffer.byteLength(record) <= 20_000))
  })

  it('is no page at all when the file shrinks under the walk', async () => {
    const records = codexScenario()
    const file = fresh(records.join('\n') + '\n')
    const end = Buffer.byteLength(records.join('\n') + '\n')
    let cut = false
    const shrinking = { startsPage: (line: string) => { if (!cut) { cut = true; truncateSync(file, 10) } return codexPageStart(line) } }
    expect(await pageBefore(file, end, 500, shrinking)).toBeNull()
  })
})

describe('LineIndex', { timeout: FILE_WORK_TIMEOUT_MS }, () => {
  const tricky = [
    '{"a":1}', '', '   ', '\t', ' ', '　 ', '﻿', '\u0001', 'é', '{"b":2}',
    Buffer.from([0xff, 0xfe]).toString('latin1'),
  ]

  it('counts what the whole-file reader counts, however lines end and whatever whitespace they hold', async () => {
    for (const ending of ['\n', '\r\n', '\r']) {
      for (let cut = 0; cut <= tricky.length; cut++) {
        for (const last of ['', ending]) {
          const content = tricky.slice(0, cut).join(ending) + (cut ? last : '')
          const file = fresh(content)
          const index = new LineIndex(file)
          await index.update()
          expect(index.count(), JSON.stringify({ ending, cut, last })).toBe((await tailFile(file, Infinity)).length)
        }
      }
    }
  })

  it('reads invalid UTF-8 as a line, as the whole-file reader does', async () => {
    const file = fresh(Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0xc3]), Buffer.from('\n'), Buffer.from([0xe2, 0x80]), Buffer.from('\n')]))
    const index = new LineIndex(file)
    await index.update()
    expect(index.count()).toBe((await tailFile(file, Infinity)).length)
  })

  it('keeps up as the file grows a byte at a time, and finds where any line ends', async () => {
    const content = Buffer.from([...codexScenario().slice(0, 12), '', '  ', claude.user('漢字 📘')].join('\r\n') + '\n')
    const file = fresh('')
    const index = new LineIndex(file, { lines: 2, bytes: 4096 })
    // Byte by byte through the first records, a character split across looks included; then in strides.
    for (let at = 0; at < content.length;) {
      const next = at < 600 ? at + 1 : Math.min(content.length, at + 997)
      appendFileSync(file, content.subarray(at, next))
      at = next
      await index.update()
      expect(index.count(), `after ${at} bytes`).toBe((await tailFile(file, Infinity)).length)
    }
    const lines = await tailFile(file, Infinity)
    expect(index.count()).toBe(lines.length)
    expect(index.length()).toBe(content.length)
    for (let n = 0; n <= lines.length + 1; n++) {
      const end = await index.endOf(n)
      const prefix = fresh(content.subarray(0, end))
      expect((await tailFile(prefix, Infinity)).length, `line ${n}`).toBe(Math.min(n, lines.length))
    }
  })

  it('marks lines by bytes too, so a long stretch of long lines is never read whole to find one', async () => {
    const content = Buffer.from(Array.from({ length: 40 }, (_, i) => codex.reasoning(`${i} ${'x'.repeat(3000)}`)).join('\n') + '\n')
    const file = fresh(content)
    const index = new LineIndex(file, { lines: 1000, bytes: 10_000 })
    await index.update()
    for (const n of [0, 1, 3, 4, 17, 39, 40]) {
      expect((await tailFile(fresh(content.subarray(0, await index.endOf(n))), Infinity)).length, `line ${n}`).toBe(n)
    }
  })

  it('indexes a file again from the start when it shrank, its first bytes changed, or an ending moved', async () => {
    const records = codexScenario()
    const file = fresh(records.join('\n') + '\n')
    const index = new LineIndex(file)
    await index.update()
    expect(index.count()).toBe(records.length)
    writeFileSync(file, records.slice(0, 5).join('\n') + '\n')
    await index.update()
    expect(index.count()).toBe(5)
    // Longer than before, with an ending where one was: only its first bytes tell it is not the file indexed.
    writeFileSync(file, [codex.meta('99.159.0'), ...records.slice(1, 5)].join('\n') + '\n')
    await index.update()
    expect(index.count()).toBe(5)
    const longer = [codex.reasoning('x'.repeat(30)), ...records.slice(1, 5)].join('\n') + '\n'
    expect(Buffer.byteLength(longer)).toBeGreaterThan(Buffer.byteLength([codex.meta('99.159.0'), ...records.slice(1, 5)].join('\n') + '\n'))
    writeFileSync(file, longer)
    await index.update()
    expect(index.count()).toBe(5)
    writeFileSync(file, records.slice(0, 5).join(' ') + '\n' + records.slice(5, 9).join('\n') + '\n')
    await index.update()
    expect(index.count()).toBe((await tailFile(file, Infinity)).length)
  })

  it('reads a file that is gone as empty, and one that appears later from its start', async () => {
    const file = join(dir, 'later.jsonl')
    const index = new LineIndex(file)
    await index.update()
    expect([index.count(), index.length()]).toEqual([0, 0])
    writeFileSync(file, '{"a":1}\n{"b":2}')
    await index.update()
    expect(index.count()).toBe(2)
    expect(await index.endOf(1)).toBe(8)
    rmSync(file)
    await index.update()
    expect(index.count()).toBe(0)
  })

  it('looks and finds one at a time, in the order asked', async () => {
    const records = codexScenario()
    const file = fresh(records.slice(0, 10).join('\n') + '\n')
    const index = new LineIndex(file, { lines: 3, bytes: 1 << 30 })
    await index.update()
    appendFileSync(file, records.slice(10).join('\n') + '\n')
    const [, end] = await Promise.all([index.update(), index.endOf(records.length - 1)])
    expect(end).toBe(Buffer.byteLength(records.slice(0, -1).join('\n') + '\n'))
    // A look that fails leaves the queue running.
    rmSync(file)
    await expect(index.update()).resolves.toBeUndefined()
    await expect(index.endOf(0)).resolves.toBe(0)
  })

  it('stops where a file cut short under it ends, whatever its length said', async () => {
    for (const content of ['{"a":1}\n{"b"', '{"a":1}\n']) {
      const file = fresh(content)
      const shorted: OpenFile = async (path) => {
        const handle = await open(path, 'r')
        return Object.assign(Object.create(handle), {
          stat: async () => ({ ...(await handle.stat()), size: Buffer.byteLength(content) + 50 }),
          read: handle.read.bind(handle),
          close: handle.close.bind(handle),
        })
      }
      const index = new LineIndex(file, undefined, shorted)
      await index.update()
      expect(index.count()).toBe((await tailFile(file, Infinity)).length)
    }
  })

  it('reports a file it cannot read, and keeps answering after', async () => {
    const index = new LineIndex(dir)
    await expect(index.update()).rejects.toThrow()
    const locked = fresh('{"a":1}\n')
    chmodSync(locked, 0o000)
    try { await expect(new LineIndex(locked).update()).rejects.toThrow() } finally { chmodSync(locked, 0o600) }
    const records = codexScenario()
    const file = fresh(records.join('\n') + '\n')
    const gone = new LineIndex(file, { lines: 4, bytes: 1 << 30 })
    await gone.update()
    rmSync(file)
    await expect(gone.endOf(6)).rejects.toThrow()
    await expect(gone.update()).resolves.toBeUndefined()
    expect(gone.count()).toBe(0)
    const pager = new TranscriptPager()
    expect(await pager.lineCount(dir)).toBe(0)
    expect(asOld(await pager.codex(dir, { limit: 2 }))).toEqual(windowCodexLines([], { limit: 2 }))
    expect(asOld(await pager.codex(dir, { limit: 2, before: 'codex:3' }))).toEqual(windowCodexLines([], { limit: 2, before: 'codex:3' }))
    expect(asOld(await pager.codex(dir, {}))).toEqual(windowCodexLines([], { limit: Infinity }))
  })
})

describe('the pager', () => {
  it('says a page is stale when the file shrank under its walk', async () => {
    const pager = new TranscriptPager({ walk: async () => false })
    expect((await pager.claude(fresh(claudeScenario().join('\n') + '\n'), { limit: 2 })).staleCursor).toBe(true)
    expect((await pager.codex(fresh(codexScenario().join('\n') + '\n'), { limit: 2 })).staleCursor).toBe(true)
  })

  it('keeps a bounded number of indexes', async () => {
    const pager = new TranscriptPager({ capacity: 2 })
    const records = codexScenario()
    const files = [1, 2, 3].map(() => fresh(records.join('\n') + '\n'))
    for (const file of [...files, files[0]]) expect(await pager.lineCount(file)).toBe(records.length)
  })

  it('finds a remembered cursor on a last line not yet ended', async () => {
    const records = [claude.user('one'), claude.assistant([claude.text('a')], 'end_turn'), claude.user('two, still being written')]
    const file = fresh(records.join('\n'))
    const pager = new TranscriptPager()
    const first = await pager.claude(file, { limit: 1 })
    expect(first.lines).toEqual([records[2]])
    appendFileSync(file, '\n' + claude.user('three'))
    const lines = await tailFile(file, Infinity)
    expect(asOld(await pager.claude(file, { limit: 1, before: first.oldestCursor! }))).toEqual(windowRawLines(lines, { limit: 1, before: first.oldestCursor! }))
    const unended = fresh(records.join('\n'))
    const page = await pager.claude(unended, { limit: 1 })
    expect(asOld(await pager.claude(unended, { limit: 1, before: page.oldestCursor! })))
      .toEqual(windowRawLines(await tailFile(unended, Infinity), { limit: 1, before: page.oldestCursor! }))
  })
})

