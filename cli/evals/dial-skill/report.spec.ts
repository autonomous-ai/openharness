import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const BUILDER = join(import.meta.dirname, 'build-report-lite.mjs')

let flow: string

beforeEach(() => {
  flow = mkdtempSync(join(tmpdir(), 'dial-report-'))
})

afterEach(() => {
  rmSync(flow, { recursive: true, force: true })
})

it("gives a condition's row its scenario's split", () => {
  writeFileSync(join(flow, '_state.json'), JSON.stringify({ train_ids: ['a.claude'], val_ids: [], test_ids: [] }))
  mkdirSync(join(flow, 'baseline'))
  writeFileSync(join(flow, 'baseline', 'results.jsonl'),
    JSON.stringify({ prompt_id: 'a.claude.crowd', rep: 0, grade: { score: 1 } }) + '\n')

  execFileSync(process.execPath, [BUILDER, flow], { stdio: 'pipe' })

  expect(readFileSync(join(flow, 'trajectory', 'scores.tsv'), 'utf8')).toContain('a.claude.crowd\ttrain\t')
})

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r) + '\n').join('')

/** The Variants table's rows, as the text of their cells. */
const variantRows = (html: string) => html.split('<h2>Variants</h2>')[1].split('</table>')[0].split('<tr').slice(1)
  .map((tr) => [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()))
  .filter((cells) => cells.length)

it('aggregates each variant per condition, a row with none read as clean', () => {
  writeFileSync(join(flow, '_state.json'), JSON.stringify({ train_ids: ['a.claude', 'b.claude'], val_ids: [], test_ids: [] }))
  mkdirSync(join(flow, 'baseline'))
  writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
    { prompt_id: 'a.claude', rep: 0, grade: { score: 4 } },
    { prompt_id: 'b.claude.clean', rep: 0, grade: { score: 2 } },
    { prompt_id: 'a.claude.crowd', rep: 0, grade: { score: -2 } },
    { prompt_id: 'b.claude.crowd', rep: 0, status: 'truncated', grade: { score: 4 } },
  ]))
  writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([{ prompt_id: 'b.claude.crowd', rep: 1, failure_class: 'timeout' }]))

  execFileSync(process.execPath, [BUILDER, flow], { stdio: 'pipe' })

  // variant, condition, change, model, mean, cases, truncated, failed attempts
  expect(variantRows(readFileSync(join(flow, 'report.html'), 'utf8'))).toEqual([
    ['baseline', 'clean', '', '', '3.000', '2', '0', '0'],
    ['baseline', 'crowd', '', '', '-2.000', '1', '1', '1 (timeout 1)'],
  ])
})
