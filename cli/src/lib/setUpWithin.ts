/**
 * Start a grid set-up and wait for it at most [waitMs]. Past that it carries on — the access queue
 * remembers it when it lands, and a later `ensure` waits for it — so a caller that must answer in seconds
 * (a Model Manager being created) is never held for a first install. Never throws: what failed is said by
 * the next thing that uses grid.
 *
 * Its own module because the create that waits is the core's, and grid's set-up is the models service's,
 * in a process of its own (docs/design/2026-10-06-core-boundary-next.md, step 7): the core waits on the
 * port's `ensure` through this, and never loads the set-up's code.
 */
export async function setUpWithin(setUp: () => Promise<unknown>, waitMs: number): Promise<'done' | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), waitMs) })
  try {
    return await Promise.race([setUp().then(() => 'done' as const, () => 'done' as const), waited])
  } finally {
    clearTimeout(timer)
  }
}
