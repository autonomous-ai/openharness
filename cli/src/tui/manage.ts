import { installTui, updateTui } from './install.js'
import { inspectHnLauncher, repairHnLauncher, reportHnLauncher } from './launcher.js'

/** One explicit operation repairs both the downloaded binary and the command on PATH. */
export async function installManagedTui(script: string, log: (line: string) => void): Promise<void> {
  await installTui(log)
  await repairHnLauncher(script, log)
  await reportHnLauncher(log)
}

export async function updateManagedTui(script: string, force: boolean, log: (line: string) => void): Promise<void> {
  const launcher = await inspectHnLauncher()
  if (force && launcher.kind === 'legacy' && !process.env.HARNESS_TUI_BIN) {
    await installManagedTui(script, log)
    return
  }
  await updateTui(log)
  await reportHnLauncher(log)
}
