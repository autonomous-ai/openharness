/**
 * The gate's clean-up runs every step whatever the ones before it did: on 2026-11-17 a VS Code that did not exit held
 * the clean-up's first wait past the hook's bound, three times, and LaunchServices' unregister, the root's removal and
 * the preferences' check after it never ran.
 */

/** The promise's value, or a rejection naming `what` once `ms` pass first. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let bound: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        bound = setTimeout(() => reject(new Error(`${what}: did not finish in ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(bound)
  }
}

export type Step = readonly [name: string, run: () => unknown]

/** Runs each step in turn, each within `ms`, and throws every step's failure at the end as one. */
export async function cleanUp(steps: readonly Step[], ms: number): Promise<void> {
  const failures: Error[] = []
  for (const [name, run] of steps) {
    const ran = Promise.resolve().then(run).catch((error: unknown) => {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    try {
      await within(ran, ms, name)
    } catch (error) {
      failures.push(error as Error)
    }
  }
  if (failures.length) throw new AggregateError(failures, `the clean-up failed: ${failures.map(({ message }) => message).join('; ')}`)
}
