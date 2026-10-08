import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { command, HOOK_SCRIPT, isOurs, type Settings } from '../kit/notifyHooks.js'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

// SessionStart/UserPromptSubmit bind mutable engine-session metadata to the process agent. SessionEnd
// only asks discovery to reconcile: the process, not the hook, owns the tile lifetime. UserPromptSubmit
// is the CATCH hook, so a SessionStart missed because the adapter started late is repaired on first input.
// Stop/StopFailure are the authoritative turn-close signals (Stop = normal finish incl. max_tokens/
// refusal; StopFailure = turn ended on an API error, where Stop does NOT fire) — they close a turn even
// when the JSONL-derived turn_ended is missed. Neither supports a matcher (silently ignored).
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure'] as const

/** `settingsPath`: another Claude Code home's settings, for a home the person moved (lib/engineHomes.ts). */
export function installSessionHooks(port: number, settingsPath: string = SETTINGS_PATH): void {
  let settings: Settings = {}
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Settings
  } catch {
    // missing / unreadable → start from empty settings
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  const cmd = command(port, 'claude')
  let changed = false
  let updated = false // true when an EXISTING block's command changed (path/port drift)

  for (const event of EVENTS) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and
    // keep every non-ours block untouched.
    const foreign = blocks.filter((b) => !isOurs(b))
    const oursBlocks = blocks.filter(isOurs)
    if (oursBlocks.length > 1) changed = true // dropping duplicates is a change

    // The one canonical block for this event with the CURRENT command (path + port). If a prior
    // block existed with a different command (moved checkout / dev↔dist / changed port), this
    // overwrites it in place.
    const existingCmd = oursBlocks[0]?.hooks?.find((h) => isOurs({ hooks: [h] }))?.command
    if (oursBlocks.length === 0) changed = true
    else if (existingCmd !== cmd) { changed = true; updated = true }

    settings.hooks[event] = [...foreign, { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]
  }

  if (!changed) {
    console.log('[hooks] Claude session + turn (Stop/StopFailure) hooks already installed')
    return
  }

  try {
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    // Both name the file written: a daemon can write several (every moved home gets its own), and the
    // end-to-end harness checks each one it names is inside its throwaway root.
    console.log(
      updated
        ? `[hooks] updated (path/port changed) → ${HOOK_SCRIPT} --port ${port} in ${settingsPath}`
        : `[hooks] installed Claude session + turn (Stop/StopFailure) hooks → ${settingsPath}`,
    )
    console.log('[hooks] (takes effect on the next claude session start)')
  } catch (err) {
    console.error('[hooks] failed to write settings.json:', err)
  }
}
