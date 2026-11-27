import { expect, it, vi } from 'vitest'
import { backgroundCommands } from './backgroundCommands.js'
import type { ProcessRow } from './processTable.js'

// Claude Code 2.1.322, macOS, zsh 5.9: `ps -axo pid=,ppid=,args=` under one engine, 2026-11-12 (home and command replaced).
const SHELL = "/bin/zsh -c source '/Users/u/Library/Application Support/claude/shell-snapshots/snapshot-zsh-1794472199641-2xja85.sh' 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval 'sleep 40' < /dev/null && pwd -P >| /tmp/claude-9e33-cwd"
const MCP = '/Users/u/.codegraph/versions/v1.6.2/node --liftoff-only --disable-warning=ExperimentalWarning /Users/u/.codegraph/versions/v1.6.2/lib/dist/bin/codegraph.js serve --mcp'

const ENGINE = { pid: 500, executable: 'claude', startMarker: 'Thu Nov 12 10:00:01 2026' }
const row = (pid: number, parentPid: number, args: string): ProcessRow => ({ pid, parentPid, executable: args.split(' ')[0], startMarker: 'Thu Nov 12 10:00:02 2026', args })
const TABLE: ProcessRow[] = [
  { ...ENGINE, parentPid: 499, args: 'claude --resume abc' },
  row(501, 500, SHELL),                 // a background command
  row(502, 501, SHELL),                 // its pipeline's subshell: the same argv, not the engine's child
  row(503, 501, 'sleep 600'),
  row(504, 500, MCP), row(505, 500, 'caffeinate -i -t 300'),
  row(601, 600, SHELL),                 // another harness's
]
const claude = { engine: 'claude', agentId: 'a1', sessionId: 's1', processIdentity: ENGINE } as const
const on = (rows: ProcessRow[] | null, platform: NodeJS.Platform = 'darwin') => ({ rows: vi.fn(async () => rows), platform })

it('Claude Code: its Bash tool\'s shells among the engine\'s direct children, in one read', async () => {
  const deps = on(TABLE)
  expect(await backgroundCommands(claude, deps)).toBe(1)
  expect(deps.rows).toHaveBeenCalledTimes(1)
  expect(await backgroundCommands(claude, on(TABLE.filter((r) => r.pid !== 501 && r.pid !== 502)))).toBe(0)
  expect(await backgroundCommands(claude, on(TABLE, 'linux'))).toBe(1)
})

it('is null, never 0, where it cannot look', async () => {
  expect(await backgroundCommands(claude, on(null))).toBeNull()                                   // ps failed
  expect(await backgroundCommands(claude, on(TABLE.slice(1)))).toBeNull()                         // the engine is gone
  expect(await backgroundCommands({ ...claude, processIdentity: { ...ENGINE, startMarker: 'another start' } }, on(TABLE))).toBeNull()   // its pid, reused
  expect(await backgroundCommands({ ...claude, processIdentity: null }, on(TABLE))).toBeNull()
  const windows = on(TABLE, 'win32')
  expect(await backgroundCommands(claude, windows)).toBeNull()
  expect(windows.rows).not.toHaveBeenCalled()
  expect(await backgroundCommands(claude, { rows: async () => { throw new Error('ps') }, platform: 'darwin' })).toBeNull()
})

it.each(['codex', 'openclaw', 'opencode', 'terminal'] as const)('%s is not known, and reads no table', async (engine) => {
  const deps = on(TABLE)
  expect(await backgroundCommands({ ...claude, engine }, deps)).toBeNull()
  expect(deps.rows).not.toHaveBeenCalled()
})

it('Hermes: its own list, in the home that holds the session', async () => {
  const module = { hermesHomeForSession: vi.fn(async () => '/h/profiles/p'), hermesBackgroundCommands: vi.fn(async () => 3) }
  const session = { engine: 'hermes', agentId: 'a2', sessionId: '20261112_100000_bbbbbb', hermesHome: '/h/profiles/p', processIdentity: null } as const
  expect(await backgroundCommands(session, { hermes: async () => module })).toBe(3)
  expect(module.hermesBackgroundCommands).toHaveBeenCalledWith('/h/profiles/p', '20261112_100000_bbbbbb')
  expect(await backgroundCommands({ ...session, sessionId: '' }, { hermes: async () => module })).toBeNull()   // not bound yet
  expect(await backgroundCommands(session, { hermes: async () => null })).toBeNull()                           // its code could not load
})
