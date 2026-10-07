import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRouterOneShot } from '../lib/oneshot.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { BUDGET_MS, cleanName, defaultNamers, KEEP, PROMPT, RETRY_MS, startWindowNames, WINDOW_NAMES_REQUESTS, windowAsk, type Namer } from './windowNames.js'

vi.mock('../lib/oneshot.js', () => ({ runRouterOneShot: vi.fn(async () => ({ text: 'Harness TUI\n', sessionId: null })) }))
// The real `opencode models` path, run with a command that lists nothing.
vi.mock('../lib/engineBin.js', () => ({ opencodeBin: () => '/bin/echo' }))

const ASKER = { local: true, owner: true }
type Repo = { kind: string; name: string; root: string | null; remote: string | null; branch: string | null }
const agent = (agentId: string, engine: string, cwd: string) => ({ agentId, sessionId: `s-${agentId}`, engine, cwd }) as RegisteredSession

/** The user's window (2026-10-07): two harnesses in autonomous-harness, one in aptis-notes (no git), a shell. */
const AGENTS: Record<string, [string, string, string]> = {
  tui: ['TUI layout spacing consistency', 'claude', '/work/harness'],
  lm: ['Lm studio respawn on quit', 'claude', '/work/harness-lm'],
  pi: ['pi:c', 'pi', '/work/aptis'],
  sh: ['Terminal harness 10-6 11:25', 'terminal', '/work/harness'],
  grid: ['Grid relay respawn prod', 'codex', '/work/grid'],
  mob: ['Mobile login screen', 'pi', '/work/mobile-test'],
  // Pi's own title before it has one: the folder alone.
  pidefault: ['π - mobile-test', 'pi', '/work/mobile-test'],
  loose: ['Fix the build', 'claude', '/work/loose'],
  // Harnesses with no title yet, as the user's xiaozhi-esp32 window had (2026-10-07).
  untitled: ['OpenCode harness 10-7 16:45', 'opencode', '/work/harness'],
  numbered: ['harness-3', 'claude', '/work/harness'],
  blank: ['', 'claude', '/work/harness'],
}
const HARNESS = 'github.com/autonomous-ai/autonomous-harness'
// As describeScmProject reads them on the user's machine (2026-10-07).
const REPOS: Record<string, Repo> = {
  '/work/harness': { kind: 'git', name: 'autonomous-harness', root: '/work/harness', remote: HARNESS, branch: 'main' },
  // A linked worktree of the same repo: a root of its own, the same remote, its own branch.
  '/work/harness-lm': { kind: 'git', name: 'autonomous-harness', root: '/worktrees/gentle-walrus', remote: HARNESS, branch: 'lm-studio-stays-closed' },
  '/work/aptis': { kind: 'none', name: 'aptis-notes', root: null, remote: null, branch: null },
  '/work/grid': { kind: 'git', name: 'autonomous-grid-cli', root: '/work/grid', remote: 'github.com/autonomous-ai/autonomous-grid-cli', branch: 'main' },
  '/work/mobile-test': { kind: 'git', name: 'mobile-test', root: '/work/mobile-test', remote: null, branch: 'main' },
  // A repo with no remote and no root git said: known by its name.
  '/work/loose': { kind: 'git', name: 'loose', root: null, remote: null, branch: 'main' },
}
const describeRepo = async (cwd: string | null | undefined): Promise<Repo | null> => {
  if (cwd === '/work/broken') throw new Error('git failed')
  return REPOS[cwd ?? ''] ?? null
}

function setup(over: { dataDir?: string; ask?: (namer: Namer, prompt: string) => Promise<string>; namers?: (engines: string[]) => Promise<Namer[]>; now?: () => number; defaults?: boolean } = {}) {
  const sessions = Object.entries(AGENTS).map(([id, [, engine, cwd]]) => agent(id, engine, cwd))
  sessions.push(agent('broken', 'claude', '/work/broken'), agent('nobranch', 'claude', '/work/nobranch'))
  REPOS['/work/nobranch'] = { kind: 'git', name: 'detached', root: '/work/nobranch', remote: null, branch: null }
  const core = fakeCore({
    dataDir: over.dataDir ?? mkdtempSync(join(tmpdir(), 'window-names-')),
    agents: { byAgent: vi.fn((id: string) => sessions.find((s) => s.agentId === id)), displayName: vi.fn((s: RegisteredSession) => AGENTS[s.agentId]?.[0] ?? s.agentId) },
  })
  const ask = vi.fn(over.ask ?? (async () => 'Harness TUI LMStudio'))
  const namers = vi.fn(over.namers ?? (async () => [{ engine: 'opencode', model: 'opencode/exo-free' } as Namer]))
  const requests = over.defaults ? startWindowNames(core) : startWindowNames(core, { describe: describeRepo, ask, namers, now: over.now })
  const name = (agentIds: unknown) => requests.window_name!({ agentIds }, ASKER) as Promise<Record<string, unknown>>
  return { core, requests, name, ask, namers }
}

describe('window names', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('answer exactly the requests they declare', () => {
    expect(Object.keys(setup().requests)).toEqual([...WINDOW_NAMES_REQUESTS])
  })

  it('show the model the headings of the harnesses in the repo most of them are in — not a shell, not a folder without git', async () => {
    const { core } = setup()
    const ask = await windowAsk(core, ['tui', 'lm', 'pi', 'sh'], describeRepo)
    expect(ask?.prompt).toBe(`${PROMPT}\n- TUI layout spacing consistency    autonomous-harness ⎇ main\n- Lm studio respawn on quit    autonomous-harness ⎇ lm-studio-stays-closed`)
    expect(ask?.engines).toEqual(['claude'])
    // The same harnesses in another order, or one twice: the same window, the same key.
    expect((await windowAsk(core, ['lm', 'tui', 'tui'], describeRepo))?.key).toBe(ask?.key)
    expect(ask?.key.split('\n')[0]).toBe('autonomous-harness')
    // A repo with fewer harnesses is left out; a tie goes to the first in pane order.
    expect((await windowAsk(core, ['grid', 'tui', 'lm'], describeRepo))?.prompt).not.toContain('Grid relay')
    expect((await windowAsk(core, ['grid', 'mob'], describeRepo))?.engines).toEqual(['codex'])
    expect((await windowAsk(core, ['loose'], describeRepo))?.key).toBe('loose\nFix the build    loose ⎇ main')
    // A harness with no title of its own says nothing of its work: left out, and alone, no name asked.
    expect((await windowAsk(core, ['untitled', 'numbered', 'blank', 'tui'], describeRepo))?.prompt).toBe(`${PROMPT}\n- TUI layout spacing consistency    autonomous-harness ⎇ main`)
    expect(await windowAsk(core, ['untitled', 'numbered', 'blank', 'pidefault'], describeRepo)).toBeNull()
    // No harness in a repo (a shell, a folder without git, no branch, a git that fails, an unknown agent): none.
    expect(await windowAsk(core, ['pi', 'sh', 'nobranch', 'broken', 'gone'], describeRepo)).toBeNull()
  })

  it('take only a short plain answer as a name', () => {
    expect(cleanName('Harness TUI LMStudio\n')).toBe('Harness TUI LMStudio')
    expect(cleanName('\x1b[0m> build · exo-free\n\n"Harness   TUI LMStudio."\n')).toBe('Harness TUI LMStudio')
    expect(cleanName('Mobile Test')).toBe('Mobile Test')
    for (const wrong of ['', '\n> build\n', 'Autonomous harness TUI spacing and LM Studio', 'Harness + LMStudio', 'Harness · TUI', 'Harness, TUI', 'A name: Harness', 'x'.repeat(41)]) {
      expect(cleanName(wrong), wrong).toBeNull()
    }
  })

  it('pick OpenCode\'s free models as it lists them now, then the window\'s engines with their small model — never one named here', async () => {
    const listing = 'opencode/exo-free\nopencode/big-pickle\nzai/glm-5\nopencode/mimo-flash-free\nopencode/a-free\nopencode/b-free\n'
    expect(await defaultNamers(['claude', 'codex', 'pi', 'terminal', 'grok'], async () => listing)).toEqual([
      { engine: 'opencode', model: 'opencode/exo-free' }, { engine: 'opencode', model: 'opencode/mimo-flash-free' }, { engine: 'opencode', model: 'opencode/a-free' },
      { engine: 'claude', model: 'haiku', effort: 'low' }, { engine: 'codex', effort: 'low' }, { engine: 'pi' },
    ])
    // No OpenCode: the window's own engines alone.
    expect(await defaultNamers(['opencode'], async () => { throw new Error('ENOENT') })).toEqual([{ engine: 'opencode' }])
    // The real listing, run (a command that lists nothing here).
    expect(await defaultNamers(['claude'])).toEqual([{ engine: 'claude', model: 'haiku', effort: 'low' }])
  })

  it('answer pending at once, name the window behind the request, then answer its name — kept across a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'window-names-'))
    const first = setup({ dataDir })
    expect(await first.name(['tui', 'lm', 'pi'])).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await first.name(['tui', 'lm', 'pi'])).toEqual({ name: 'Harness TUI LMStudio' }))
    expect(first.ask).toHaveBeenCalledTimes(1)
    expect(first.namers).toHaveBeenCalledWith(['claude'])
    expect(JSON.parse(readFileSync(join(dataDir, 'window-names.json'), 'utf8'))[0][1]).toBe('Harness TUI LMStudio')
    // A restart: the name is read back, no model asked.
    const again = setup({ dataDir })
    expect(await again.name(['lm', 'tui'])).toEqual({ name: 'Harness TUI LMStudio' })
    expect(again.ask).not.toHaveBeenCalled()
  })

  it('name one window at a time, and keep the name a window has when it has no repo or no ids', async () => {
    let release!: (text: string) => void
    const { name } = setup({ ask: () => new Promise((resolve) => { release = resolve }) })
    expect(await name(['tui'])).toEqual({ name: null, pending: true })
    expect(await name(['mob'])).toEqual({ name: null, pending: true })
    release('Harness TUI')
    await vi.waitFor(async () => expect(await name(['tui'])).toEqual({ name: 'Harness TUI' }))
    for (const ids of [['pi', 'sh'], [], 'tui', [7, null]]) expect(await name(ids)).toEqual({ name: null })
  })

  it('try the next model when one fails or answers badly; with none, keep the name and ask again only after a while', async () => {
    let now = 1_000
    const tries: string[] = []
    const { name } = setup({
      now: () => now,
      namers: async () => [{ engine: 'opencode', model: 'a' }, { engine: 'opencode', model: 'b' }, { engine: 'claude', model: 'haiku' }],
      ask: async (namer) => {
        tries.push(namer.model!)
        if (namer.model === 'a') throw new Error('gone')
        return namer.model === 'b' ? 'Autonomous harness TUI spacing and LM Studio' : 'Harness TUI'
      },
    })
    expect(await name(['tui'])).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await name(['tui'])).toEqual({ name: 'Harness TUI' }))
    expect(tries).toEqual(['a', 'b', 'haiku'])

    const none = setup({ now: () => now, namers: async () => [] })
    expect(await none.name(['mob'])).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await none.name(['mob'])).toEqual({ name: null }))
    now += RETRY_MS
    expect(await none.name(['mob'])).toEqual({ name: null, pending: true })
  })

  it('give a model that never answers its time and ask the next — a window is never left pending', async () => {
    vi.useFakeTimers()
    try {
      const tries: string[] = []
      const { name } = setup({
        namers: async () => [{ engine: 'opencode', model: 'stuck' }, { engine: 'claude', model: 'haiku' }],
        ask: (namer) => { tries.push(namer.model!); return namer.model === 'stuck' ? new Promise<string>(() => {}) : Promise.resolve('Harness TUI') },
      })
      expect(await name(['tui'])).toEqual({ name: null, pending: true })
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 1)
      expect(tries).toEqual(['stuck'])
      expect(await name(['tui'])).toEqual({ name: null, pending: true })
      await vi.advanceTimersByTimeAsync(1)
      expect(tries).toEqual(['stuck', 'haiku'])
      expect(await name(['tui'])).toEqual({ name: 'Harness TUI' })
    } finally { vi.useRealTimers() }
  })

  it('keep the newest names, read back only well-formed ones, and never fail a request over the disk', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'window-names-'))
    writeFileSync(join(dataDir, 'window-names.json'), JSON.stringify([['k0', 'Old'], ['bad'], 7, ...Array.from({ length: KEEP }, (_, i) => [`k${i + 1}`, `N${i + 1}`])]))
    const { name } = setup({ dataDir, ask: async () => 'Mobile Test' })
    expect(await name(['mob'])).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await name(['mob'])).toEqual({ name: 'Mobile Test' }))
    const kept: Array<[string, string]> = JSON.parse(readFileSync(join(dataDir, 'window-names.json'), 'utf8'))
    expect(kept).toHaveLength(KEEP)
    expect(kept.some(([key]) => key === 'k0' || key === 'k1')).toBe(false)
    expect(kept.at(-1)?.[1]).toBe('Mobile Test')
    // A folder that cannot be written (the scratch folder, the names file): the window keeps its name.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unwritable = setup({ dataDir: '/dev/null/window-names' })
    expect(await unwritable.name(['tui'])).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await unwritable.name(['tui'])).toEqual({ name: null }))
    error.mockRestore()
  })

  it('a name it cannot write is still answered, and the error said', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'window-names-'))
    // The names file is a folder: the scratch folder can be made, the file cannot be written.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'window-names.json.tmp'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { name } = setup({ dataDir })
    expect(await name(['tui'])).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await name(['tui'])).toEqual({ name: 'Harness TUI LMStudio' }))
    expect(error).toHaveBeenCalledWith('[window-names] could not keep the names:', expect.any(String))
    error.mockRestore()
  })

  it('by default ask the small models through one cold one-shot each', async () => {
    const { name } = setup({ defaults: true })
    // (The default reads the repo too: this window's folders are not real repos, so nothing to name.)
    expect(await name(['tui'])).toEqual({ name: null })
    expect(runRouterOneShot).not.toHaveBeenCalled()
    const core = fakeCore({ dataDir: mkdtempSync(join(tmpdir(), 'window-names-')), agents: { byAgent: vi.fn(() => agent('tui', 'claude', '/work/harness')), displayName: vi.fn(() => 'TUI layout spacing consistency') } })
    const requests = startWindowNames(core, { describe: describeRepo, namers: async () => [{ engine: 'claude', model: 'haiku', effort: 'low' }] })
    expect(await requests.window_name!({ agentIds: ['tui'] }, ASKER)).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await requests.window_name!({ agentIds: ['tui'] }, ASKER)).toEqual({ name: 'Harness TUI' }))
    expect(runRouterOneShot).toHaveBeenCalledWith('claude', expect.objectContaining({ model: 'haiku', effort: 'low', timeoutMs: BUDGET_MS, prompt: expect.stringContaining('TUI layout spacing consistency') }))
    // With no namers given, the default ones (no OpenCode here, the window's claude with haiku).
    const plain = startWindowNames(fakeCore({ dataDir: mkdtempSync(join(tmpdir(), 'window-names-')), agents: { byAgent: vi.fn(() => agent('tui', 'claude', '/work/harness')), displayName: vi.fn(() => 'T') } }), { describe: describeRepo })
    expect(await plain.window_name!({ agentIds: ['tui'] }, ASKER)).toEqual({ name: null, pending: true })
    await vi.waitFor(async () => expect(await plain.window_name!({ agentIds: ['tui'] }, ASKER)).toEqual({ name: 'Harness TUI' }))
  })
})
