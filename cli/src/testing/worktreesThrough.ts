import type { WorkspacesPort } from '../core/api.js'

type WorktreeModule = Pick<typeof import('../lib/worktreeDeletion.js'), 'inspectWorkspace' | 'inspectWorktree' | 'removeReviewedWorktree'>

/**
 * A purge's worktrees (lib/purgeAgentService.ts `worktrees`), answered as the workspaces service answers them
 * (lib/worktreeDeletion.ts `reviewWorktree`, `removeWorktree`), each read from [module] as it is called: a spec's spy on
 * `inspectWorktree` or `removeReviewedWorktree` is what runs, as it was while the purge called them itself.
 */
export function worktreesThrough(module: WorktreeModule): () => Pick<WorkspacesPort, 'describeWorkspace' | 'reviewWorktree' | 'removeWorktree'> {
  const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
  const port: ReturnType<ReturnType<typeof worktreesThrough>> = {
    describeWorkspace: (target, others) => module.inspectWorkspace(target, others),
    reviewWorktree: (target, others) => module.inspectWorktree(target, others)
      .then(review => ({ ok: true as const, review }), (error: unknown) => ({ ok: false as const, reason: reason(error) })),
    removeWorktree: (review, target, others, discard) => module.removeReviewedWorktree(review, target, others, discard)
      .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, reason: reason(error) })),
  }
  return () => port
}
