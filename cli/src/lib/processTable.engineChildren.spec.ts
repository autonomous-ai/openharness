/**
 * The processes whose open files are listed with a launcher's (decision 8, PM 2026-11-15). Rows are npm's Codex 0.169.0
 * as the spike measured it on macOS: a launcher with two `codex` processes right under it, one of which holds the
 * rollout (docs/plans/2026-11-15-process-env-secrets-plan.md, "Spike result").
 */
import { describe, expect, it } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import { ENGINE_CHILDREN_MOST } from './processHeldFiles.js'
import { engineChildren, type ProcessRow } from './processTable.js'

// No installed command is any engine's: each row is named by its argv alone, and nothing walks PATH (#3880).
const OWNERSHIP: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

const CODEX = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'
const row = (pid: number, parentPid: number, argv: string[], extra: Partial<ProcessRow> = {}): ProcessRow => ({
  pid, parentPid, executable: argv[0]!, startMarker: `Sun Nov 15 10:00:${String(pid % 60).padStart(2, '0')} 2026`,
  args: argv.join(' '), nativeArgv: argv, ...extra,
})
const identity = ({ pid, executable, startMarker }: ProcessRow) => ({ pid, executable, startMarker })

const PANE_SHELL = row(1400, 1, ['-zsh'])
const LAUNCHER = row(1437, 1400, ['node', '/opt/homebrew/bin/codex'])
const HOLDER = row(1505, 1437, [CODEX])
const SECOND = row(1546, 1437, [CODEX, 'app-server'])
const TOOL_SHELL = row(1600, 1437, ['/bin/zsh', '-c', 'git status'])

describe('engineChildren', () => {
  it('names a Codex launcher\'s two codex children, lowest pid first, and not the shell beside them', () => {
    const rows = [TOOL_SHELL, SECOND, HOLDER, LAUNCHER, PANE_SHELL]
    expect(engineChildren(rows, 'codex', LAUNCHER, OWNERSHIP)).toEqual([identity(HOLDER), identity(SECOND)])
    expect(engineChildren([TOOL_SHELL, HOLDER, LAUNCHER], 'codex', LAUNCHER, OWNERSHIP)).toEqual([identity(HOLDER)])
    expect(engineChildren([TOOL_SHELL, LAUNCHER], 'codex', LAUNCHER, OWNERSHIP)).toEqual([])
  })

  it('names four children at most, the lowest pids', () => {
    const children = [1520, 1505, 1560, 1546, 1510, 1530].map((pid) => row(pid, LAUNCHER.pid, [CODEX]))
    expect(ENGINE_CHILDREN_MOST).toBe(4)
    const named = engineChildren([LAUNCHER, ...children], 'codex', LAUNCHER, OWNERSHIP).map((child) => child.pid)
    expect(named).toEqual([1505, 1510, 1520, 1530])
    expect(named).not.toContain(1546)
    expect(named).not.toContain(1560)
  })

  it('looks one level down only, and never at a codex whose launcher is gone', () => {
    const below = row(1601, TOOL_SHELL.pid, [CODEX, 'exec', 'review'])
    // After `/quit` the child that holds the rollout outlives its launcher, adopted by pid 1.
    const leftBehind = row(1505, 1, [CODEX])
    expect(engineChildren([LAUNCHER, TOOL_SHELL, below, leftBehind], 'codex', LAUNCHER, OWNERSHIP)).toEqual([])
  })

  it('names no other engine\'s process, and never Hermes\'s shared gateway', () => {
    const claude = row(1700, LAUNCHER.pid, ['/Users/u/.local/bin/claude'])
    expect(engineChildren([LAUNCHER, claude], 'codex', LAUNCHER, OWNERSHIP)).toEqual([])

    const hermes = row(3327, 3300, ['/usr/local/bin/hermes'])
    const gateway = row(3400, hermes.pid, ['python3', '-m', 'hermes_cli.main', 'gateway', 'run', '--quiet'])
    expect(engineChildren([hermes, gateway], 'hermes', hermes, OWNERSHIP)).toEqual([])
    // The spike's Linux Hermes: one engine child right under it, beside the gateway.
    const child = row(3506, hermes.pid, ['/usr/local/bin/hermes'])
    expect(engineChildren([hermes, gateway, child], 'hermes', hermes, OWNERSHIP)).toEqual([identity(child)])
  })

  it('names a child by the files the ownership it is given says are the engine\'s', () => {
    const unnamed = row(1505, LAUNCHER.pid, ['node', '/x/engine.mjs'], { entrypointFileKey: '7:4243' })
    expect(engineChildren([LAUNCHER, unnamed], 'codex', LAUNCHER, OWNERSHIP)).toEqual([])
    const owned = { ...OWNERSHIP, engineFileKeys: new Map([['codex' as const, new Set(['7:4243'])]]) }
    expect(engineChildren([LAUNCHER, unnamed], 'codex', LAUNCHER, owned)).toEqual([identity(unnamed)])
  })
})
