/**
 * A hook preparation that cannot go ahead, and why. A leaf module that imports nothing, so the Windows file helpers
 * (windowsFiles.ts) can throw it without an import cycle through nativeHookFiles.ts, which re-exports it.
 */
export class HookPreparationHeld extends Error {
  /** What holds it, as a sentence's end: the message without its "is waiting" prefix (notifyHooks.ts `hooksNotInstalled`). */
  readonly reason: string
  constructor(detail: string) { super(`Hook preparation is waiting: ${detail}`); this.name = 'HookPreparationHeld'; this.reason = detail }
}
