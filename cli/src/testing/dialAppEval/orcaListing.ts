// Orca's `terminal list` for a scenario, the same in both tiers: tier A's world answers it to the real reads, tier B's
// fake Orca prints it (docs/plans/2026-11-22-dial-eval-orca-plan.md, Decision 3).
import { engineOf, type Engine, orcaWorktreeId, type Scenario, type SessionKey, type StepOf } from './types.js'

export interface OrcaPane { key: SessionKey; handle: string; title: string; tab: number; split: number; identity?: Engine }
export interface OrcaWorktree { key: string; path: string; panes: OrcaPane[] }

/**
 * Orca's layout now: `layout`'s worktrees in its order, each with the panes `open` names a handle for, by tab, then split.
 * A handle two open sessions share is one terminal, the first of them by split: one tmux client in an Orca tab runs
 * them all (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md, "Tier A's model change"). `folder` writes a catalog
 * path as the tier's own (tier B's world.folder). The identity is `identity`'s for the pane's session, as tier A names
 * the engine tmux shows in that terminal, as Orca does; else the session's engine, as tier B's sessions share no handle.
 */
export function orcaLayout(scenario: Scenario, layout: StepOf<'orca.layout'> | undefined,
  open: (key: SessionKey) => string | undefined, folder: (path: string) => string = (path) => path,
  identity?: (key: SessionKey) => Engine): OrcaWorktree[] {
  if (layout === undefined) return []
  return layout.worktrees.map((key) => {
    const panes: OrcaPane[] = []
    for (const s of scenario.sessions) {
      if (s.worktree !== key) continue
      const handle = open(s.key)
      if (handle === undefined) continue
      // A tmux session's pane is Orca's too, and Orca saw Claude Code start in it (the PM, 2026-11-22).
      panes.push({ key: s.key, handle, title: s.title, tab: s.tab ?? 0, split: s.split ?? 0, identity: identity?.(s.key) ?? engineOf(s) })
    }
    panes.sort((x, y) => x.tab - y.tab || x.split - y.split)
    return { key, path: folder(`/work/eval-${key}`), panes: panes.filter((p, i) => panes.findIndex((q) => q.handle === p.handle) === i) }
  })
}

/** What `orca terminal list --json --include-visual-layouts` prints for it, in Orca 1.4.256's shapes as
 *  e2e/harness/fakeOrca.ts prints them: `visualLayouts` (group, tabs, `terminal` leaves, `pane-split` first then second),
 *  `terminals` rows with handle, worktreePath, worktreeId, title and agentIdentity, `totalCount`, `truncated: false`. */
export function orcaListing(worktrees: readonly OrcaWorktree[], renamed: Readonly<Record<SessionKey, string>>): object {
  const terminals: object[] = []
  const visualLayouts = worktrees.map((worktree) => {
    const worktreeId = orcaWorktreeId(worktree.key)
    const tabs = [...new Set(worktree.panes.map((p) => p.tab))].map((tab) => {
      const tabId = `${worktree.key}-t${tab}`
      const panes = worktree.panes.filter((p) => p.tab === tab)
      for (const p of panes) {
        terminals.push({ handle: p.handle, worktreePath: worktree.path, worktreeId, title: p.title,
          ...(p.identity === undefined ? {} : { agentIdentity: p.identity }) })
      }
      return { tabId, title: tabTitle(panes, renamed), activeLeafId: `${tabId}-p${panes[0]!.split}`, panes: paneTree(panes, tabId) }
    })
    return { worktreeId, worktreePath: worktree.path,
      root: { type: 'group', groupId: `${worktree.key}-g`, activeTabId: tabs[0]?.tabId ?? null, tabs } }
  })
  return { id: 'eval', ok: true, result: { terminals, visualLayouts, totalCount: terminals.length, truncated: false } }
}

/** A tab's title: the person's rename (a key of `renamed` among its panes), else its lowest split's title. */
export function tabTitle(panes: ReadonlyArray<Pick<OrcaPane, 'key' | 'title' | 'split'>>,
  renamed: Readonly<Record<SessionKey, string>>): string {
  const rename = panes.find((p) => Object.hasOwn(renamed, p.key))
  if (rename !== undefined) return renamed[rename.key]!
  return panes.reduce((lowest, p) => (p.split < lowest.split ? p : lowest)).title
}

/** A tab's panes in split order: the first leaf, then the rest split off as `second`. */
function paneTree([pane, ...rest]: readonly OrcaPane[], tabId: string): object {
  const leaf = { type: 'terminal', handle: pane!.handle, tabId, leafId: `${tabId}-p${pane!.split}`, title: pane!.title,
    connected: true, active: false }
  return rest.length === 0 ? leaf : { type: 'pane-split', direction: 'horizontal', first: leaf, second: paneTree(rest, tabId) }
}
