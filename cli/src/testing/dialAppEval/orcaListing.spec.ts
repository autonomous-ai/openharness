import { describe, expect, it } from 'vitest'
import { createOrcaReads, type OrcaTabs } from '../../cable/hosts/orca.js'
import { orcaLayout, orcaListing } from './orcaListing.js'
import { orcaPaneHandle, orcaTerminalHandle, orcaWorktreeId, type Scenario, type SessionDef, type SessionKey, type StepOf } from './types.js'

// Out of their layout's order on purpose: the listing orders them, not the catalog.
const SESSIONS: SessionDef[] = [
  { key: 'c', app: 'orca', id: '00000000-0000-4000-8c00-000000000063', title: 'Eval gamma', cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab: 1 },
  { key: 'b', app: 'orca', id: '00000000-0000-4000-8c00-000000000062', title: 'Eval beta', cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab: 0, split: 1, engine: 'codex' },
  { key: 'a', app: 'orca', id: '00000000-0000-4000-8c00-000000000061', title: 'Eval alpha', cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab: 0, split: 0 },
  { key: 'e', app: 'orca', id: '00000000-0000-4000-8c00-000000000065', title: 'Eval epsilon', cwd: '/work/eval-w2', ageMs: 0, worktree: 'w2', tab: 1, handle: 'none' },
  { key: 'd', app: 'orca', id: '00000000-0000-4000-8c00-000000000064', title: 'Eval delta', cwd: '/work/eval-w2', ageMs: 0, worktree: 'w2' },
]
const SCENARIO: Scenario = {
  id: 'OX', app: 'orca', title: 'Eval listing', dims: ['D1'], platforms: ['darwin'], tiers: ['a'], heldOut: false,
  sessions: SESSIONS, steps: [], checks: [], probes: [],
}
const LAYOUT: StepOf<'orca.layout'> = { kind: 'orca.layout', worktrees: ['w2', 'w1'] }
const H = (key: SessionKey): string => orcaTerminalHandle(key)
/** Every pane open, on its first launch's handle. */
const allOpen = (key: SessionKey): string | undefined => orcaPaneHandle(SESSIONS.find((s) => s.key === key)!, 0)

/** The listing as the devices read it: through Orca's real reads, with a `run` that prints it. */
async function readBack(listing: object): Promise<OrcaTabs> {
  const reads = createOrcaReads({
    platform: 'linux',
    onPath: (name) => (name === 'orca-ide' ? '/opt/eval/orca/resources/bin/orca-ide' : null),
    exists: () => false,
    run: async () => ({ code: 0, stdout: JSON.stringify(listing) }),
    spawn: () => { throw new Error('no watch here') },
    mtime: () => null,
  })
  const tabs = await reads.orcaTabs()
  if (tabs === null) throw new Error('the reads refused the listing')
  return tabs
}

const read = (open = allOpen, renamed: Record<SessionKey, string> = {}, folder?: (path: string) => string) =>
  readBack(orcaListing(orcaLayout(SCENARIO, LAYOUT, open, folder), renamed))

describe("Orca's terminal list", () => {
  it("the tabs come in the step's worktree order, then by tab, a split's first pane before its second", async () => {
    expect((await read()).tabs.map((t) => t.handle)).toEqual([H('d'), H('e'), H('a'), H('b'), H('c')])
  })

  it('a tab is titled by its first pane, and a renamed one reads as renamed with the person\'s title', async () => {
    expect((await read()).tabs.filter((t) => t.handle === H('a') || t.handle === H('b'))).toEqual([
      { handle: H('a'), title: 'Eval alpha' }, { handle: H('b'), title: 'Eval alpha' },
    ])
    const renamed = (await read(allOpen, { b: 'Eval pair' })).tabs
    expect(renamed.filter((t) => t.handle === H('a') || t.handle === H('b'))).toEqual([
      { handle: H('a'), title: 'Eval pair', renamed: true }, { handle: H('b'), title: 'Eval pair', renamed: true },
    ])
    expect(renamed.find((t) => t.handle === H('c'))).toEqual({ handle: H('c'), title: 'Eval gamma' })
  })

  it("each terminal row holds its pane's handle, its worktree's path and id, and its engine as the agent's identity", async () => {
    const listing = orcaListing(orcaLayout(SCENARIO, LAYOUT, allOpen), {}) as { result: { terminals: unknown[] } }
    expect(listing.result.terminals).toContainEqual(expect.objectContaining({
      handle: H('b'), worktreePath: '/work/eval-w1', worktreeId: orcaWorktreeId('w1'), title: 'Eval beta', agentIdentity: 'codex',
    }))
    expect((await read()).terminals).toEqual([
      { handle: H('d'), worktreePath: '/work/eval-w2', agentIdentity: 'claude' },
      { handle: H('e'), worktreePath: '/work/eval-w2', agentIdentity: 'claude' },
      { handle: H('a'), worktreePath: '/work/eval-w1', agentIdentity: 'claude' },
      { handle: H('b'), worktreePath: '/work/eval-w1', agentIdentity: 'codex' },
      { handle: H('c'), worktreePath: '/work/eval-w1', agentIdentity: 'claude' },
    ])
  })

  it("the worktrees map names each handle's worktree id", async () => {
    expect((await read()).worktrees).toEqual(new Map([
      [H('d'), orcaWorktreeId('w2')], [H('e'), orcaWorktreeId('w2')],
      [H('a'), orcaWorktreeId('w1')], [H('b'), orcaWorktreeId('w1')], [H('c'), orcaWorktreeId('w1')],
    ]))
  })

  it('a pane open names no handle for is not listed', async () => {
    const tabs = await read((key) => (key === 'a' ? undefined : allOpen(key)))
    expect(tabs.tabs.map((t) => t.handle)).toEqual([H('d'), H('e'), H('b'), H('c')])
    expect(tabs.terminals.map((t) => t.handle)).not.toContain(H('a'))
    // The tab's first pane gone, its other names it.
    expect(tabs.tabs.find((t) => t.handle === H('b'))).toEqual({ handle: H('b'), title: 'Eval beta' })
  })

  it("a session whose hooks name no handle is listed on its key's handle", async () => {
    expect((await read()).terminals.find((t) => t.handle === orcaTerminalHandle('e'))).toEqual(
      { handle: orcaTerminalHandle('e'), worktreePath: '/work/eval-w2', agentIdentity: 'claude' })
  })

  it('with no layout step the list holds nothing', async () => {
    expect(orcaLayout(SCENARIO, undefined, allOpen)).toEqual([])
    expect(await readBack(orcaListing([], {}))).toEqual({ tabs: [], terminals: [], worktrees: new Map() })
  })

  it('a handle two open sessions share is one terminal, at the first of them by split, with the identity given; with none '
    + 'given each session keeps its own engine', async () => {
    const at = (key: SessionKey, tab: number, split: number, engine?: 'codex'): SessionDef => ({ key, app: 'orca', id: `eval-${key}`,
      title: `Eval ${key}`, cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab, split, ...(engine === undefined ? {} : { engine }) })
    // x and y share y's handle, x declared first but split second; b is a Codex of its own.
    const of: Scenario = { ...SCENARIO, sessions: [at('x', 0, 1, 'codex'), at('y', 0, 0), at('b', 1, 0, 'codex')] }
    const open = (key: SessionKey): string => H(key === 'b' ? 'b' : 'y')
    const panes = (identity?: (key: SessionKey) => 'claude' | 'codex') =>
      orcaLayout(of, { kind: 'orca.layout', worktrees: ['w1'] }, open, undefined, identity)[0]!.panes.map((p) => [p.key, p.handle, p.identity])
    expect(panes()).toEqual([['y', H('y'), 'claude'], ['b', H('b'), 'codex']])
    expect(panes((key) => (key === 'y' ? 'codex' : 'claude'))).toEqual([['y', H('y'), 'codex'], ['b', H('b'), 'claude']])
    const listed = await readBack(orcaListing(orcaLayout(of, { kind: 'orca.layout', worktrees: ['w1'] }, open), {}))
    expect([listed.tabs.map((t) => t.handle), listed.terminals.map((t) => t.handle)]).toEqual([[H('y'), H('b')], [H('y'), H('b')]])
  })

  it("folder writes each worktree path as the tier's own", async () => {
    const tabs = await read(allOpen, {}, (path) => `/tmp/eval-root${path}`)
    expect(new Set(tabs.terminals.map((t) => t.worktreePath))).toEqual(new Set(['/tmp/eval-root/work/eval-w1', '/tmp/eval-root/work/eval-w2']))
    // Orca's id of a worktree is the same in both tiers.
    expect(tabs.worktrees.get(H('a'))).toBe(orcaWorktreeId('w1'))
  })
})
