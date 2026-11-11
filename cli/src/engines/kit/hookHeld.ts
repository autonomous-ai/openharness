/**
 * A hook preparation that cannot go ahead, and why. A leaf module that imports nothing, so the Windows file helpers
 * (windowsFiles.ts) can throw it without an import cycle through nativeHookFiles.ts, which re-exports it.
 */
export class HookPreparationHeld extends Error {
  /** What holds it, as a sentence's end: the message without its "is waiting" prefix (notifyHooks.ts `hooksNotInstalled`). */
  readonly reason: string
  constructor(detail: string) { super(`Hook preparation is waiting: ${detail}`); this.name = 'HookPreparationHeld'; this.reason = detail }
}

/**
 * The notify.mjs every hook line runs is not there. A line naming it was installed anyway, and Codex's SessionStart then
 * failed at every start, so the agent never bound and nothing said why (a lean build, end to end, 2026-11-11).
 */
export class HookScriptMissing extends HookPreparationHeld {
  constructor(script: string) { super(`notify.mjs is missing (${script}), so no hook of Harness's could run`); this.name = 'HookScriptMissing' }
}
