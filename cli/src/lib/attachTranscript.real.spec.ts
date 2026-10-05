/**
 * Opt-in, read-only: the end-first attach against the whole-history fold on THIS computer's own Claude
 * Code and Codex transcripts.
 *
 *   ATTACH_REAL_TRANSCRIPTS=1 npx vitest run src/lib/attachTranscript.real.spec.ts
 *
 * `ATTACH_REAL_LIMIT` (default 150) caps the newest transcripts taken per engine. Each one is copied
 * first — live sessions keep writing to theirs — and compared at its end and at a few earlier record
 * boundaries, including the events the rest of the file would then stream. A transcript too large for
 * the oracle to hold is attached end-first only.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonical, fromTheEnd, goalForgotten, wholeHistory, type Engine } from '../testing/transcriptOracle.js'

const enabled = process.env.ATTACH_REAL_TRANSCRIPTS === '1'
const limit = Number(process.env.ATTACH_REAL_LIMIT ?? 150)
/** The oracle holds a whole transcript; past this it would be the bug it checks for. */
const ORACLE_BYTES = 48 * 1024 * 1024
/** Earlier cut points are written out as copies, so only for transcripts this small. */
const CUT_BYTES = 8 * 1024 * 1024

function walk(dir: string, depth: number): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  return entries.flatMap((name) => {
    const path = join(dir, name)
    if (name.endsWith('.jsonl')) return [path]
    return depth > 0 && !name.includes('.') ? walk(path, depth - 1) : []
  })
}

const newest = (files: string[]) => files
  .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, limit)
  .map(({ path }) => path)

const transcripts: Array<[Engine, string]> = enabled
  ? [
      ...newest(walk(join(homedir(), '.claude', 'projects'), 1)).map((path): [Engine, string] => ['claude', path]),
      ...newest(walk(join(homedir(), '.codex', 'sessions'), 3)).map((path): [Engine, string] => ['codex', path]),
    ]
  : []

const scratch = enabled ? mkdtempSync(join(tmpdir(), 'attach-real-')) : ''
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

describe.skipIf(!enabled)('end-first attach on this computer’s transcripts', () => {
  it.each(transcripts.map(([engine, path], index) => [index, engine, path.slice(homedir().length)] as const))(
    '#%i %s ~%s',
    async (index, engine, relative) => {
      const copy = join(scratch, `${index}.jsonl`)
      copyFileSync(join(homedir(), relative), copy)
      const size = statSync(copy).size
      const tail = await fromTheEnd(engine, copy, false)
      expect(tail.next).toBeLessThanOrEqual(size)
      if (size > ORACLE_BYTES) return
      const whole = await wholeHistory(engine, copy, false)
      expect(tail.turnOpen).toBe(whole.turnOpen)
      expect(tail.opened).toEqual(whole.opened)
      expect(tail.profile).toEqual(whole.profile)
      expect(tail.content).toBe(whole.content)
      if (size > CUT_BYTES) return

      const records = readFileSync(copy, 'utf8').split('\n').filter((line) => line.trim())
      const cuts = [...new Set([1, Math.floor(records.length / 3), Math.floor((2 * records.length) / 3), records.length - 1])]
        .filter((cut) => cut > 0 && cut < records.length)
      for (const cut of cuts) {
        writeFileSync(copy, records.slice(0, cut).join('\n') + '\n')
        const before = await wholeHistory(engine, copy, false)
        const after = await fromTheEnd(engine, copy, false)
        expect(after.turnOpen, `cut ${cut}`).toBe(before.turnOpen)
        expect(after.opened, `cut ${cut}`).toEqual(before.opened)
        expect(after.profile, `cut ${cut}`).toEqual(before.profile)
        const rest = records.slice(cut)
        const expected = rest.flatMap(before.ingest)
        expect(canonical(rest.flatMap(after.ingest)), `cut ${cut}`)
          .toEqual(canonical(engine === 'codex' ? goalForgotten(records, cut, expected) : expected))
      }
    },
    300_000,
  )
})
