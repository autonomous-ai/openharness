/**
 * Harness's VS Code extension brought to this CLI's version, looked at once each time the devices' process starts, as a
 * CLI update restarts it (docs/plans/2026-11-17-dial-vscode-extension-design.md, "Brought current with the CLI"). Only an
 * extension that is on is brought current: one the person uninstalled stays uninstalled, as Claude Code's plugin does
 * (cable/dialPluginSetup.ts). Nothing is recorded: VS Code's own record of its extensions is the truth.
 */
import type { VscodeChange, VscodeStatus } from '../devices/vscodeExtension.js'

export const UPDATE_RETRY_MS = 3_600_000

export interface VscodeExtensionUpdateDeps {
  platform: NodeJS.Platform
  status(): VscodeStatus
  /** This build's extension version; null with no built extension. */
  version(): string | null
  enable(): Promise<VscodeChange>
  after(ms: number, run: () => void): () => void
  count(kind: 'updated' | 'failed' | 'left removed', reason?: string): void
}

/** One look now; a failed update is tried again an hour later, while the process runs. An enable that throws or
 *  rejects is a failed update. */
export function startVscodeExtensionUpdate(deps: VscodeExtensionUpdateDeps): void {
  const update = async (): Promise<void> => {
    let change: VscodeChange
    try {
      change = await deps.enable()
    } catch {
      change = { vscode: 'off', error: 'failed' }
    }
    if (change.vscode === 'on') {
      deps.count('updated')
      return
    }
    deps.count('failed', 'error' in change ? change.error : 'failed')
    deps.after(UPDATE_RETRY_MS, look)
  }
  const look = (): void => {
    if (deps.platform === 'win32') return
    const version = deps.version()
    if (version === null) return
    const status = deps.status()
    if (status.vscode === 'absent') return
    if (status.vscode === 'off') {
      deps.count('left removed')
      return
    }
    if (status.version !== version) void update()
  }
  look()
}
