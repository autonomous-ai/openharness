/** Display readers may keep last-good data. Admission must know when one of those reads failed. */
import { AsyncLocalStorage } from 'node:async_hooks'

interface Evidence { reason?: string; requirePresent: boolean }
const evidence = new AsyncLocalStorage<Evidence>()
export const externalEvidenceActive = (): boolean => evidence.getStore() !== undefined

/** Called even by readers which intentionally swallow errors for their display-only callers. */
export function externalReadFailed(error: unknown, operation = 'read'): void {
  const current = evidence.getStore()
  if (!current || current.reason) return
  if (!current.requirePresent && (error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
  current.reason = `The conversation's ${operation} could not be verified.`
}

export async function externalEvidence<T>(read: () => Promise<T>, requirePresent = false): Promise<
  { ok: true; value: T } | { ok: false; detail: string }
> {
  const current: Evidence = { requirePresent }
  return evidence.run(current, async () => {
    try {
      const value = await read()
      return current.reason ? { ok: false, detail: current.reason } : { ok: true, value }
    } catch {
      return { ok: false, detail: current.reason ?? 'The conversation could not be verified.' }
    }
  })
}
