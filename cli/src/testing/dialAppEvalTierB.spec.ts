import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { App, Platform } from './dialAppEval/types.js'

// The dial eval's tier B harness, the parts that need no daemon. It is outside tsconfig's rootDir (src), so it is loaded
// untyped, as fakeEngineUntil.spec.ts loads the harness.
const driver = await import('../../e2e/harness/appEvalDriver.js' as string) as {
  writeRecordingOpen(path: string, runs: string): void
  linksFail(path: string, apps: readonly App[]): void
  openRuns(runs: string, platform: Platform): Array<{ argv: string[]; ok: boolean }>
}

let dir = ''
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A recording open in a throwaway folder: its path and the file it notes its runs in. */
function open(): { path: string; runs: string; run(...args: string[]): number | null } {
  dir = mkdtempSync(join(tmpdir(), 'tier-b-open-'))
  const path = join(dir, 'open')
  const runs = join(dir, 'runs.log')
  driver.writeRecordingOpen(path, runs)
  return { path, runs, run: (...args) => spawnSync(path, args).status }
}

const CHATGPT_LINK = 'codex://threads/00000000-0000-4000-a000-000000007431'
const CLAUDE_LINK = 'claude://code/continue?session=local_00000000-0000-4000-9000-000000000061'

describe("tier B's recording open", () => {
  it('notes each run with its exit, as the command it stands for: open on macOS, xdg-open on Linux', () => {
    const o = open()
    expect(o.run('-b', 'com.openai.codex', CHATGPT_LINK)).toBe(0)
    expect(driver.openRuns(o.runs, 'darwin')).toEqual([{ argv: ['open', '-b', 'com.openai.codex', CHATGPT_LINK], ok: true }])
    expect(driver.openRuns(o.runs, 'linux')).toEqual([{ argv: ['xdg-open', '-b', 'com.openai.codex', CHATGPT_LINK], ok: true }])
  })

  it('fails the links of an app the world says fails, on every platform, and no other app\'s', () => {
    const o = open()
    driver.linksFail(o.path, ['chatgpt'])
    expect(o.run(CHATGPT_LINK)).toBe(1)
    expect(o.run(CLAUDE_LINK)).toBe(0)
    driver.linksFail(o.path, [])
    expect(o.run(CHATGPT_LINK)).toBe(0)
    expect(driver.openRuns(o.runs, 'linux')).toEqual([
      { argv: ['xdg-open', CHATGPT_LINK], ok: false }, { argv: ['xdg-open', CLAUDE_LINK], ok: true }, { argv: ['xdg-open', CHATGPT_LINK], ok: true },
    ])
  })

  it('has noted nothing before its first run', () => {
    const o = open()
    expect(driver.openRuns(o.runs, 'darwin')).toEqual([])
  })
})
