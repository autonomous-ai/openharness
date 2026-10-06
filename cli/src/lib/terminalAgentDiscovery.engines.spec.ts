/**
 * Which engine process owns a pane, for every engine and the ways each is installed and run, through the
 * daemon's own scan (discoverTerminalAgentsFromSnapshot) over panes as the tmux backend reports them.
 * These cases were written against tmuxAgentDiscovery.ts's copy of the same rules, which nothing but its
 * tests ran; they now hold the code that runs.
 */
import { describe, expect, it } from 'vitest'
import type { AgentEngine } from '../engines/types.js'
import { agentCommandOwnershipSnapshot, type AgentCommandOwnershipSnapshot } from './engineBin.js'
import type { ProcessRow } from './tmux.js'
import { discoverTerminalAgentsFromSnapshot, type DiscoveredTerminalAgent } from './terminalAgentDiscovery.js'
import { terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const START = 'Mon Aug 10 12:00:00 2026'
/** A tmux pane as the backend reports it: its root process and folder. */
const paneRoot = (paneId: string, rootPid: number, cwd = '/work/demo'): TerminalRootObservation => ({
  runtime: { backend: 'tmux', paneId }, rootPid, cwd,
})
const pane = paneRoot('%1', 1)
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow => ({
  pid, parentPid, executable, args, startMarker: START,
})
const ownership = (cursor: string[] = [], grok: string[] = []): AgentCommandOwnershipSnapshot => ({
  cursorFileKeys: new Set(cursor),
  grokFileKeys: new Set(grok),
  conflictingFileKeys: new Set(cursor.filter((key) => grok.includes(key))),
  agentCandidates: [],
  cursorAgentCandidates: [],
  grokCandidates: [],
})

/** The scan of these panes; `hints` are pane-scoped engine hints by pane id, as a vendor hook gives them. */
function discover(
  roots: readonly TerminalRootObservation[],
  rows: readonly ProcessRow[],
  daemonPid: number,
  commands: AgentCommandOwnershipSnapshot = agentCommandOwnershipSnapshot(),
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
): ReturnType<typeof discoverTerminalAgentsFromSnapshot> {
  const byRoute = new Map([...hints].map(([paneId, engine]) => [terminalRouteKey({ backend: 'tmux', paneId }), engine]))
  return discoverTerminalAgentsFromSnapshot(roots, rows, daemonPid, ['tmux'], byRoute, commands)
}

/** The scan could not tell who owns the pane, and said so rather than guessing. */
const ambiguous = (result: ReturnType<typeof discover>, paneId: string): boolean =>
  result.ambiguousPlacements.has(terminalPlacementKey({ backend: 'tmux', paneId }))

/** What makes two scans' agents the same agent: the engine, its pane and its process. */
const identity = (agent: DiscoveredTerminalAgent | undefined): unknown =>
  agent && { engine: agent.engine, primaryRuntimeKey: agent.primaryRuntimeKey, processIdentity: agent.processIdentity }

describe('which engine process owns a pane', () => {
  const fixtures: Array<[AgentEngine, string, string]> = [
    ['claude', 'claude', 'claude'],
    ['codex', 'codex', 'codex'],
    ['cursor', 'cursor-agent', 'cursor-agent'],
    ['opencode', 'opencode', 'opencode'],
    ['pi', 'pi', 'pi'],
    ['hermes', 'python', '/opt/hermes-agent/hermes'],
    ['hermes', 'python3', "python3 -I -I -c import sys, runpy; sys.path.insert(0, '/opt/custom'); runpy.run_module('hermes_cli.main', run_name='__main__')"],
    ['commandcode', '⌘ Project', '⌘ Project'],
    ['devin', 'devin', 'devin'],
    ['muse', 'muse-bin-1.2.3', 'muse-bin-1.2.3'],
    ['amp', 'amp', 'amp'],
    ['kilo', 'kilo', 'kilo'],
    ['grok', 'grok', 'grok'],
    ['agy', 'agy', 'agy'],
    ['copilot', 'copilot', 'copilot'],
  ]

  it.each(fixtures)('recognizes the plain %s CLI process', (engine, executable, args) => {
    const result = discover([pane], [row(1, 0, 'zsh'), row(2, 1, executable, args)], 900)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]).toMatchObject({ engine, cwd: '/work/demo', runtimes: [{ backend: 'tmux', paneId: '%1' }] })
  })

  it('classifies each vendor agent alias from the executable file identity', () => {
    const commands = ownership(['cursor-file'], ['grok-file'])
    const cursorRow = { ...row(2, 1, 'agent'), imageFileKey: 'cursor-file' }
    const grokRow = { ...row(2, 1, 'agent'), imageFileKey: 'grok-file' }

    expect(discover([pane], [row(1, 0, 'zsh'), cursorRow], 900, commands)
      .agents[0]?.engine).toBe('cursor')
    expect(discover([pane], [row(1, 0, 'zsh'), grokRow], 900, commands)
      .agents[0]?.engine).toBe('grok')
  })

  it('does not guess an unresolved agent alias and lets a pane-scoped vendor hook resolve it', () => {
    const commands = ownership(['cursor-file'], ['grok-file'])
    const rows = [row(1, 0, 'zsh'), row(2, 1, 'agent')]
    const unresolved = discover([pane], rows, 900, commands)
    expect(unresolved.agents).toEqual([])
    expect(ambiguous(unresolved, '%1')).toBe(true)

    const hinted = discover(
      [pane], rows, 900, commands, new Map([['%1', 'grok']]),
    )
    expect(hinted.agents[0]?.engine).toBe('grok')

    const conflict = ownership(['same-file'], ['same-file'])
    const conflicted = discover(
      [pane], [row(1, 0, 'zsh'), { ...row(2, 1, 'agent'), imageFileKey: 'same-file' }],
      900, conflict, new Map([['%1', 'grok']]),
    )
    expect(conflicted.agents).toEqual([])
    expect(ambiguous(conflicted, '%1')).toBe(true)
  })

  it('does not let a nested sub-agent steal a pane from an unresolved top-level agent alias', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'agent'), row(3, 2, 'codex')],
      900,
      ownership(),
    )
    expect(result.agents).toEqual([])
    expect(ambiguous(result, '%1')).toBe(true)
  })

  it('keeps a file-identified Grok parent while agent-named sub-agent PIDs churn', () => {
    const commands = ownership(['cursor-file'], ['grok-file'])
    const first = discover(
      [pane],
      [row(1, 0, 'zsh'), { ...row(2, 1, 'agent'), imageFileKey: 'grok-file' }, row(3, 2, 'cursor-agent')],
      900,
      commands,
    )
    const second = discover(
      [pane],
      [row(1, 0, 'zsh'), { ...row(2, 1, 'agent'), imageFileKey: 'grok-file' }, row(30, 2, 'cursor-agent')],
      900,
      commands,
    )
    expect(first.agents[0]?.engine).toBe('grok')
    expect(first.agents[0]?.processIdentity.pid).toBe(2)
    expect(identity(first.agents[0])).toEqual(identity(second.agents[0]))
  })

  const wrappers: Array<[AgentEngine, string, string]> = [
    ['claude', 'node', '/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    ['codex', 'node', '/opt/lib/node_modules/@openai/codex/bin/codex.js'],
    ['cursor', 'node', '/opt/cursor-agent/versions/1.2.3/index.js'],
    ['opencode', 'opencode.exe', '/opt/lib/node_modules/opencode-ai/bin/opencode.exe'],
    ['pi', 'node', '/opt/lib/node_modules/pi-coding-agent/dist/cli.js'],
    ['hermes', 'python3', '/opt/hermes-agent/hermes'],
    ['commandcode', 'node', '/opt/lib/node_modules/command-code/dist/index.mjs'],
    ['devin', 'python3', '/opt/devin/cli/_versions/1.2.3/bin/devin'],
    ['muse', 'muse-bin-0.1.0-R708.1', 'muse-bin-0.1.0-R708.1'],
    ['amp', 'node', '/opt/.amp/bin/amp'],
    ['kilo', 'node', '/opt/lib/node_modules/@kilocode/cli/bin/kilo'],
    ['grok', 'node', '/opt/.grok/bin/grok'],
    ['agy', 'agy', '/home/demo/.local/bin/agy'],
    ['copilot', 'node', '/opt/lib/node_modules/@github/copilot/npm-loader.js'],
  ]

  it.each(wrappers)('recognizes the installed/wrapper form for %s', (engine, executable, args) => {
    const result = discover([pane], [row(1, 0, 'zsh'), row(2, 1, executable, args)], 900)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].engine).toBe(engine)
  })

  it('discovers a native Claude version target before it rewrites argv to claude', () => {
    const native = '/home/demo/.local/share/claude/versions/2.1.246'
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, '2.1.246', native)],
      900,
    )
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]).toMatchObject({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }] })
  })

  const installPrefixes = [
    '/usr/local',
    '/opt/homebrew',
    '/nix/store/abc123-agent-cli',
    '/home/test/.local/share/pnpm/global/5',
  ]

  it.each(wrappers.flatMap(([engine, executable, args]) => installPrefixes.map((prefix) => [
    engine,
    executable,
    args.replace('/opt', prefix),
  ] as const)))('recognizes %s under arbitrary install prefix (%s)', (engine, executable, args) => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, executable, args)],
      900,
    )
    expect(result.agents[0]?.engine).toBe(engine)
  })

  it('recognizes an interpreter entrypoint under a quoted install prefix with spaces', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'node', 'node "/Applications/Agent Tools/lib/node_modules/@openai/codex/bin/codex.js"')],
      900,
    )
    expect(result.agents[0]?.engine).toBe('codex')
  })

  it('honors a configured engine path with a custom executable name', () => {
    const previous = process.env.CODEX_PATH
    process.env.CODEX_PATH = '/srv/company-tools/company-coding-agent'
    try {
      const result = discover(
        [pane],
        [row(1, 0, 'zsh'), row(2, 1, 'company-coding-agent', '/srv/company-tools/company-coding-agent')],
        900,
      )
      expect(result.agents[0]?.engine).toBe('codex')
    } finally {
      if (previous === undefined) delete process.env.CODEX_PATH
      else process.env.CODEX_PATH = previous
    }
  })

  it('never treats engine names in prompt arguments as process entrypoints', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'python3', 'python3 /work/runner.py compare claude codex agent opencode pi hermes cmd devin muse amp kilo grok')],
      900,
    )
    expect(result.agents).toEqual([])
  })

  it('does not infer an agent from an engine-named repository path', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'node', 'node /work/codex/tests/runner.js')],
      900,
    )
    expect(result.agents).toEqual([])
  })

  it('does not treat inline shell source as the process entrypoint', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'bash', 'bash -c "printf claude codex kilo"')],
      900,
    )
    expect(result.agents).toEqual([])
  })

  it.each(['kilo', 'kilocode'])('recognizes the public %s wrapper command', (command) => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'node', `node /any/prefix/bin/${command}`)],
      900,
    )
    expect(result.agents[0]?.engine).toBe('kilo')
  })

  it('recognizes Command Code after it rewrites its process title', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, '⌘ Implement lifecycle plan', '⌘ Implement lifecycle plan')],
      900,
    )
    expect(result.agents[0]?.engine).toBe('commandcode')
  })

  it('creates independent agents for two panes running the same engine', () => {
    const result = discover(
      [pane, paneRoot('%2', 10, '/work/other')],
      [row(1, 0, 'zsh'), row(2, 1, 'claude'), row(10, 0, 'zsh'), row(11, 10, 'claude')],
      900,
    )
    expect(result.agents.map((agent) => [agent.runtimes[0].paneId, agent.engine])).toEqual([
      ['%1', 'claude'], ['%2', 'claude'],
    ])
  })

  it('keeps the shallow supported parent and ignores a nested supported sub-agent', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'claude'), row(3, 2, 'codex')],
      900,
    )
    expect(result.agents.map((agent) => agent.engine)).toEqual(['claude'])
  })

  it('keeps the same parent identity while nested sub-agent PIDs churn', () => {
    const first = discover(
      [pane],
      [
        row(1, 0, 'zsh'),
        row(2, 1, 'claude'),
        row(3, 2, 'node', 'node /work/helper.js'),
        row(4, 3, 'codex'),
      ],
      900,
    )
    const second = discover(
      [pane],
      [
        row(1, 0, 'zsh'),
        row(2, 1, 'claude'),
        row(30, 2, 'node', 'node /work/helper.js'),
        row(40, 30, 'agent'),
      ],
      900,
    )
    expect(first.agents[0]?.processIdentity.pid).toBe(2)
    expect(second.agents[0]?.processIdentity.pid).toBe(2)
    expect(identity(first.agents[0])).toEqual(identity(second.agents[0]))
  })

  it('excludes recap/voice/one-shot descendants of the harness daemon', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(20, 1, 'node', 'node cli.js __run'), row(21, 20, 'codex', 'codex exec recap')],
      20,
    )
    expect(result.agents).toEqual([])
  })

  it('does not guess when two top-level supported processes tie', () => {
    const result = discover(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'claude'), row(3, 1, 'codex')],
      900,
    )
    expect(result.agents).toEqual([])
    expect(ambiguous(result, '%1')).toBe(true)
  })
})
