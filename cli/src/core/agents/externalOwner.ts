/** Only core may stop an external owner. Worker observations are revalidated at every signal. */
import { verifiedForegroundJob } from '../../lib/externalOwnerControl.js'
import { externalProcessGeneration } from '../../lib/externalProcessGeneration.js'
import { processExists } from '../../lib/processLiveness.js'
import type { ExternalResumeIntent } from '../../lib/externalResume.js'

export async function stopExternalOwner(owner: NonNullable<ExternalResumeIntent['owner']>, deps: {
  current(): boolean
  /** Fresh exact conversation, terminal, ownership class and incarnation, after asynchronous work. */
  same(): Promise<boolean>
  generation?: typeof externalProcessGeneration
  exists?: typeof processExists
  job?: typeof verifiedForegroundJob
  beforeSignal?(signal: NodeJS.Signals): void
  afterSignal?(signal: NodeJS.Signals): void
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const generation = deps.generation ?? externalProcessGeneration
  const exists = deps.exists ?? processExists
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref() }))
  const process = owner.process
  const sameProcess = () => generation(process.pid) === owner.generation
  const wait = async (budget: number) => {
    for (let elapsed = 0; elapsed < budget; elapsed += 100) {
      if (!deps.current()) return false
      if (!exists(process.pid)) return true
      if (!sameProcess()) return false
      await sleep(100)
    }
    return deps.current() && !exists(process.pid)
  }
  for (const [signal, budget] of [['SIGTERM', 5_000], ['SIGKILL', 2_000]] as const) {
    if (!deps.current()) return false
    if (!exists(process.pid)) return true
    const job = await (deps.job ?? verifiedForegroundJob)(process.pid).catch(() => 'unknown' as const)
    if (job === 'unknown') return false
    if (!await deps.same() || !deps.current() || !sameProcess()) return false
    try {
      deps.beforeSignal?.(signal)
      if (!deps.current() || !sameProcess()) return false
      ;(deps.kill ?? ((pid, name) => globalThis.process.kill(pid, name)))(job ? -job : process.pid, signal)
      deps.afterSignal?.(signal)
    }
    catch { return deps.current() && !exists(process.pid) }
    if (await wait(budget)) return true
  }
  // The exited process no longer proves who owns its terminal. Do not write escape sequences into
  // a terminal that may already be running another conversation or the person's next command.
  return false
}
