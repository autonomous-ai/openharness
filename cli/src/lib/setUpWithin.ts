/**
 * Start a grid set-up and wait for it at most [waitMs]. Past that it carries on — the access queue
 * remembers it when it lands, and a later `ensure` waits for it — so a caller that must answer in seconds
 * (a Model Manager being created) is never held for a first install. Never throws: what failed is said by
 * the next thing that uses grid.
 *
 * Shared by the component's setup wait and the core's bounded workspace-path capture. The operation
 * keeps its original owner after the wait expires; this helper neither retries nor starts a new one.
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
