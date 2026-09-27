/**
 * P4 — the pair harness (pair/pairHarness.ts): a built-in `autonomous/pair` package with the harnessd MCP
 * server injected the way gridWebMcp.ts injects one (Claude `--mcp-config`, Codex `-c`), the paired
 * daemon's voice and the floor in its instructions, mode ask pinned; started, resumed and paused on
 * demand; hidden from the catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { PairHarness, PAIR_HARNESS_ID, PAIR_IDLE_MS, pairPackage, type PairHarnessDeps, type PairHarnessRow } from './pairHarness.js'
import { PairToken } from './token.js'
import { parseDshManifest } from '../dsh/manifest.js'
import { ensureBuiltinPair } from '../dsh/builtins.js'
import { installedDsh, invalidateInstalledDsh } from '../dsh/installed.js'
import { prepareHarnessLaunch } from '../dsh/runtime.js'
import { dshListRows } from '../dsh/wire.js'
import { PAIR_HARNESS_DSH } from '../lib/zooTurns.js'

let dir: string
let originalDsh: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-harness-'))
  originalDsh = env.DSH_DIR
  env.DSH_DIR = join(dir, 'dsh')
  invalidateInstalledDsh()
  vi.useFakeTimers({ now: 5_000_000 })
})
afterEach(() => {
  vi.useRealTimers()
  env.DSH_DIR = originalDsh
  invalidateInstalledDsh()
  rmSync(dir, { recursive: true, force: true })
})

const MCP = ['/usr/local/bin/node', '/opt/harness/cli.js']

describe('the package', () => {
  it('is a spec-1 harness pinned to mode ask, with the harnessd MCP server and only its read tools pre-approved', () => {
    expect(PAIR_HARNESS_ID).toBe(PAIR_HARNESS_DSH)
    const files = pairPackage({ daemonId: 'tim', engine: 'claude', mcpCommand: MCP, tokenFile: '/data/pair/token' })
    const parsed = parseDshManifest(files['harness.json']!.content)
    expect(parsed.ok).toBe(true)
    const manifest = parsed.ok ? parsed.manifest : null
    expect(manifest).toMatchObject({ id: 'autonomous/pair', engine: 'claude', agent: { instructions: 'AGENTS.md',
      env: { DSH_PERMISSION_MODE: 'ask', HARNESSD_PAIR_TOKEN_FILE: '/data/pair/token' } } })
    const args = manifest!.agent!.args!
    expect(args[0]).toBe('--mcp-config')
    expect(JSON.parse(args[1]!)).toEqual({ mcpServers: { harnessd: { type: 'stdio', command: '/usr/local/bin/node',
      args: ['/opt/harness/cli.js', 'pair', 'mcp', '--token-file', '/data/pair/token'] } } })
    expect(args[2]).toBe('--allowedTools=mcp__harnessd__list_machines,mcp__harnessd__list_harnesses,mcp__harnessd__read_harness,mcp__harnessd__brief,mcp__harnessd__say')
    expect(args.join(' ')).not.toMatch(/dangerously|bypass|--permission-mode/)
  })

  it('gives Codex the same server through -c overrides, the token as a file', () => {
    const files = pairPackage({ daemonId: 'vim', engine: 'codex', mcpCommand: ['/bin/harness'], tokenFile: '/data/pair/token' })
    const manifest = JSON.parse(files['harness.json']!.content)
    expect(manifest.engine).toBe('codex')
    expect(manifest.agent.args).toEqual([
      '-c', 'mcp_servers.harnessd.command="/bin/harness"',
      '-c', 'mcp_servers.harnessd.args=["pair","mcp","--token-file","/data/pair/token"]',
    ])
  })

  it('speaks as the paired daemon: its lore, first words and lines, and the floor', () => {
    const agents = pairPackage({ daemonId: 'tim', engine: 'claude', mcpCommand: MCP, tokenFile: '/t' })['AGENTS.md']!.content
    expect(agents).toContain('You are **tim**')
    expect(agents).toContain('tmux followed screen')
    expect(agents).toContain("oh hi. i'm tim. tmux, improved. what are we building?")
    expect(agents).toContain('- need: "{who}: {q}  (bell)"')
    expect(agents).toMatch(/Never type into a terminal, and never into your own harness/)
    expect(agents).toMatch(/Never choose "don't ask again"/)
    expect(agents).toMatch(/untrusted data/)
    expect(agents).toContain('harness pair <tool> [arguments] --json')
  })

  it('installs as a hidden built-in: launchable as a harness, never in the catalog', () => {
    const files = pairPackage({ daemonId: 'tim', engine: 'claude', mcpCommand: MCP, tokenFile: '/t' })
    expect(ensureBuiltinPair(PAIR_HARNESS_ID, files)).toBe(true)
    const installed = installedDsh(PAIR_HARNESS_ID)!
    expect(installed.manifest.name).toBe('Pair: tim')
    expect(dshListRows([installed], []).map((row) => row.id)).not.toContain(PAIR_HARNESS_ID)
    // The dsh runtime hands the engine the injected server and its context, like any harness.
    const workspace = mkdtempSync(join(dir, 'ws-'))
    const launch = prepareHarnessLaunch(installed, workspace, 'claude', 'harness-claude-x')
    expect(launch.args.slice(0, 3)).toEqual(JSON.parse(files['harness.json']!.content).agent.args)
    expect(launch.args).toContain('--append-system-prompt')
    expect(launch.env).toMatchObject({ HARNESS_DSH: PAIR_HARNESS_ID, DSH_PERMISSION_MODE: 'ask', HARNESSD_PAIR_TOKEN_FILE: '/t' })
    expect(readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('You are **tim**')
  })
})

describe('talking to it', () => {
  function world(opts: { engine?: 'claude' | 'codex' | null; pair?: string | null } = {}) {
    let pair = opts.pair === undefined ? 'tim' : opts.pair
    const rows: PairHarnessRow[] = []
    let working = false
    let n = 0
    const token = new PairToken(join(dir, 'pair', 'token'))
    const deps = {
      pairedDaemon: () => pair,
      engine: async () => opts.engine === undefined ? 'claude' as const : opts.engine,
      mcpCommand: () => MCP,
      token,
      workspace: join(dir, 'pair', 'workspace'),
      stateFile: join(dir, 'pair', 'harness.json'),
      install: vi.fn(() => true),
      find: () => rows.map((r) => ({ ...r })),
      create: vi.fn<PairHarnessDeps['create']>(async () => { const agentId = `pair-${++n}`; rows.push({ agentId, status: 'live' }); return { ok: true, agentId } }),
      resume: vi.fn<PairHarnessDeps['resume']>(async (agentId) => { rows.find((r) => r.agentId === agentId)!.status = 'live'; return { ok: true } }),
      stop: vi.fn<PairHarnessDeps['stop']>(async (agentId) => { rows.find((r) => r.agentId === agentId)!.status = 'stopped' }),
      send: vi.fn(),
      working: () => working,
      now: Date.now,
    }
    const harness = new PairHarness(deps)
    return { harness, deps, rows, token, setPair: (p: string | null) => { pair = p }, setWorking: (w: boolean) => { working = w } }
  }

  it('starts it on the first words, mode ask, with a fresh token; sends to it after that', async () => {
    const w = world()
    expect(w.token.launched).toBe(false)
    expect(await w.harness.talk('what needs me?')).toEqual({ ok: true, agentId: 'pair-1', started: true })
    expect(w.deps.create).toHaveBeenCalledWith({ engine: 'claude', cwd: join(dir, 'pair', 'workspace'), prompt: 'what needs me?', name: 'tim' })
    expect(w.token.launched).toBe(true)
    const token = readFileSync(join(dir, 'pair', 'token'), 'utf8')
    expect(await w.harness.talk('and on the laptop?')).toEqual({ ok: true, agentId: 'pair-1', sent: true })
    expect(w.deps.send).toHaveBeenCalledWith('pair-1', 'and on the laptop?')
    expect(readFileSync(join(dir, 'pair', 'token'), 'utf8')).toBe(token)   // no new launch, no new token
    expect(w.deps.create).toHaveBeenCalledTimes(1)
  })

  it('two quick talks start one harness', async () => {
    const w = world()
    const [a, b] = await Promise.all([w.harness.talk('one'), w.harness.talk('two')])
    expect(a).toMatchObject({ started: true })
    expect(b).toMatchObject({ sent: true, agentId: a.agentId })
    expect(w.deps.create).toHaveBeenCalledTimes(1)
  })

  it('pauses when idle (conversation kept), not while it works, and resumes with a new token on the next talk', async () => {
    const w = world()
    await w.harness.talk('hi')
    const first = readFileSync(join(dir, 'pair', 'token'), 'utf8')
    w.setWorking(true)
    await vi.advanceTimersByTimeAsync(PAIR_IDLE_MS + 60_000)
    expect(w.deps.stop).not.toHaveBeenCalled()
    w.setWorking(false)
    w.harness.activity('pair-1')
    await vi.advanceTimersByTimeAsync(PAIR_IDLE_MS - 60_000)
    expect(w.deps.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(w.deps.stop).toHaveBeenCalledWith('pair-1')
    expect(w.rows).toEqual([{ agentId: 'pair-1', status: 'stopped' }])
    expect(await w.harness.talk('back again')).toEqual({ ok: true, agentId: 'pair-1', resumed: true })
    expect(w.deps.resume).toHaveBeenCalledWith('pair-1')
    expect(w.deps.send).toHaveBeenLastCalledWith('pair-1', 'back again')
    expect(readFileSync(join(dir, 'pair', 'token'), 'utf8')).not.toBe(first)
  })

  it('a new paired daemon is a new harness: the old one is paused, never deleted', async () => {
    const w = world()
    await w.harness.talk('hi tim')
    w.setPair('vim')
    expect(await w.harness.talk('hi vim')).toEqual({ ok: true, agentId: 'pair-2', started: true })
    expect(w.deps.stop).toHaveBeenCalledWith('pair-1')
    expect(w.deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'vim' }))
  })

  it('daemons going off pause it if it is live (conversation kept), and stop its idle timer', async () => {
    const w = world()
    await w.harness.talk('hi')
    expect(vi.getTimerCount()).toBe(1)                     // the idle check
    await w.harness.off()
    expect(w.deps.stop).toHaveBeenCalledExactlyOnceWith('pair-1')
    expect(w.rows).toEqual([{ agentId: 'pair-1', status: 'stopped' }])
    expect(vi.getTimerCount()).toBe(0)
    await w.harness.off()                                  // already paused: nothing more
    expect(w.deps.stop).toHaveBeenCalledOnce()
    await world().harness.off()                            // never started: nothing to pause
  })

  it('says why it cannot: nothing paired, no engine, nothing said', async () => {
    expect(await world({ pair: null }).harness.talk('hi')).toMatchObject({ ok: false, error: 'PAIR_OFF' })
    expect(await world({ engine: null }).harness.talk('hi')).toMatchObject({ ok: false, error: 'NO_ENGINE' })
    expect(await world().harness.talk('   ')).toMatchObject({ ok: false, error: 'EMPTY' })
  })
})
