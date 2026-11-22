/**
 * A tier A spec's guard on starting a process: the spec mocks `node:child_process` and `child_process` with `refused`,
 * which refuses every way to start one and notes it in `reached`, and its afterEach finds `reached` empty. A stand-in
 * the spec missed would otherwise run this machine's own `orca`, `open` or `ps`.
 *
 * vi.hoisted loads it before the mocks are in place: it imports nothing.
 */
export const reached: string[] = []

export async function refused(real: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const actual = await real()
  const refuse = (name: string) => () => {
    reached.push(name)
    throw new Error(`tier A starts no process (${name})`)
  }
  const starts = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
    .map((name) => [name, refuse(name)]))
  return { ...actual, ...starts, default: { ...(actual.default as object), ...starts } }
}
