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
