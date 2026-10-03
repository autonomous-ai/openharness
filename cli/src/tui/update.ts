import { isLocalDevBuild, msUntilSlot, type Poller } from '../lib/selfUpdate.js'
import { updateTui } from './install.js'

/** hn follows the installed CLI's automatic-update policy, including after an hn-only release. */
export function startTuiUpdater(opts: {
  currentVersion: string
  isInstalledCopy: boolean
  disabled: boolean
  intervalMs: number
  slotSecond?: number
  log?: (line: string) => void
}): Poller {
  if (!opts.isInstalledCopy || opts.disabled || isLocalDevBuild(opts.currentVersion)) return { stop() {} }
  const log = opts.log ?? ((line: string) => console.log(`[hn-update] ${line.trim()}`))
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let checking = false
  const tick = async (): Promise<void> => {
    if (controller.signal.aborted) return
    timer = setTimeout(() => void tick(), msUntilSlot(Date.now(), opts.slotSecond, opts.intervalMs))
    timer.unref?.()
    if (checking) return
    checking = true
    try {
      await updateTui(log, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) log(`Check failed; will retry: ${error instanceof Error ? error.message : error}`)
    } finally {
      checking = false
    }
  }
  // Independent of the CLI download/handoff: an hn failure must never hold up a CLI fix.
  void tick()
  return { stop() { clearTimeout(timer); controller.abort() } }
}
