/** Coalesce nested read-only proofs within one synchronous call, never across
 * an await or a publication. Every nested observation still pins the root. */
export function createNativeHookReadFence(full: () => void, identity: () => void, captureRoute: () => () => void,
  changedRoute: (error: unknown) => boolean,
) {
  let reading: Array<() => void> | undefined
  const synchronously = <T>(read: () => T): T => {
    const value = read()
    if (value !== null && (typeof value === 'object' || typeof value === 'function')
      && typeof (value as { then?: unknown }).then === 'function') {
      // An accidentally async callback loses this scope before its continuation
      // runs. Contain a later rejection while refusing its observation now.
      void Promise.resolve(value).catch(() => {})
      throw new TypeError('Native hook read fences require synchronous callbacks')
    }
    return value
  }
  return {
    verify() { if (reading) identity(); else full() },
    run<T>(read: () => T, after?: () => void): T {
      if (reading) {
        identity()
        const value = synchronously(read)
        if (after) reading.push(after)
        return value
      }
      for (let attempt = 0;; attempt++) {
        full()
        const route = captureRoute()
        const finalChecks: Array<() => void> = []
        reading = finalChecks
        let value: T
        try { value = synchronously(read); route() }
        catch (error) {
          if (!changedRoute(error) || attempt >= 2) throw error
          // A sibling write may change an ancestor stamp. Discard this entire
          // read and its result, then reacquire it under fresh complete proofs.
          continue
        } finally { reading = undefined }
        full()
        // These are cheap owner/deadline checks, queued by nested readers too.
        // A full filesystem proof may consume their remaining time budget.
        for (const check of finalChecks) synchronously(check)
        if (after) synchronously(after)
        return value
      }
    },
  }
}
