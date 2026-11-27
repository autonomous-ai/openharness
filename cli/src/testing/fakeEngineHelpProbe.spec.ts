import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from '../lib/engineBin.js'
import { engineProcessMatch, readProcessRows, type ProcessRow } from '../lib/processTable.js'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as fakeCodexAppServer.spec.ts
// loads it.
const { fakeEngineShim } = await import('../../e2e/harness/daemon.js' as string) as {
  fakeEngineShim: (name: 'claude' | 'codex', config: Record<string, unknown>) => string
}

// No engine's file is known here: a row is judged by what `ps` prints of it alone, never by an engine this machine has.
const NO_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(), agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

let root = ''
let started: ChildProcess | undefined

afterEach(() => {
  try { if (started?.pid) process.kill(-started.pid, 'SIGKILL') } catch { /* already gone */ }
  started = undefined
  rmSync(root, { recursive: true, force: true })
})

/** [pid]'s row and every row under it, parents first. */
function tree(rows: readonly ProcessRow[], pid: number): ProcessRow[] {
  const found = rows.filter((row) => row.pid === pid)
  for (let at = 0; at < found.length; at++) found.push(...rows.filter((row) => row.parentPid === found[at].pid))
  return found
}

// The launch script asks the engine's help before each run (engines/kit/launchStartup.ts `ownedFlagProbe`), and
// discovery skips that probe (lib/processTable.ts `engineCapabilityProbe`). The fake Codex's help child was named
// `codex` with the script after it, so discovery recorded it as the engine for as long as it ran, and a close a second
// later said "Its conversation is kept" of a Codex that never bound one (CLI end to end run 43746252131, shard 4;
// docs/plans/2026-11-16-codex-help-race-design.md). Codex 0.167.0's own two probe processes are both skipped.
describe('the fake engines\' help, held open', () => {
  it.each([
    ['claude', ['--help'], [false]],
    ['codex', ['--help'], [false, false]],
    ['codex', ['-h'], [false, false]],
    // Not alone on the command line, so no probe to discovery: the child keeps the engine's name, as an engine run does.
    ['codex', ['-c', 'x=1', '--help'], [true, true]],
  ] as const)('%s %j: which of its processes discovery takes for the engine is %j', async (engine, args, engineHere) => {
    root = mkdtempSync(join(tmpdir(), 'fake-help-probe-'))
    mkdirSync(join(root, 'bin'))
    const bin = join(root, 'bin', engine)
    // Held far longer than the test reads it for: afterEach ends it, and it ends by itself if that fails.
    writeFileSync(bin, fakeEngineShim(engine, {
      port: 1, dataDir: join(root, 'data'), claudeProjectsDir: join(root, 'claude'), codexHome: join(root, 'codex'), root, hookLog: join(root, 'hooks.log'),
      helpDelayMs: 60_000,
    }), { mode: 0o755 })
    const help = spawn(bin, [...args], { stdio: 'ignore', detached: true })
    started = help
    const rows = await vi.waitFor(async () => {
      const mine = tree(await readProcessRows() ?? [], help.pid!)
      expect(mine).toHaveLength(engineHere.length)
      return mine
    }, { timeout: 20_000, interval: 100 })
    expect(rows.map((row) => engineProcessMatch(row, engine, NO_OWNERS).score > 0)).toEqual(engineHere)
  }, 30_000)
})
