import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { command, isOurs, writeJsonAtomic, type HookBlock, type Settings } from '../kit/notifyHooks.js'

/**
 * Merge Machine's user-level Codex hooks without replacing unrelated hooks. A malformed existing
 * file is left untouched: silently replacing it could disable user security/automation hooks.
 *
 * `codexHome` defaults to this machine's own default profile, but a Codex agent launched against a
 * different CODEX_HOME profile (see `Agent.codexHome`/`agent_create`) reads hooks.json from THAT
 * folder, not this one — so `onCreateAgent` calls this again with the chosen profile before
 * spawning such an agent. Idempotent either way.
 */
export function installCodexHooks(port: number, codexHome: string = env.CODEX_HOME): void {
  const hooksPath = join(codexHome, 'hooks.json')
  let settings: Settings = {}
  if (existsSync(hooksPath)) {
    try {
      settings = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Settings
    } catch (err) {
      console.error(`[hooks] Codex hooks file is invalid JSON; leaving it unchanged: ${hooksPath}`)
      console.error('[hooks] fix the file, then restart harness login')
      return
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  const cmd = command(port, 'codex', codexHome)
  const required: Array<{ event: 'SessionStart' | 'UserPromptSubmit'; matcher?: string }> = [
    { event: 'SessionStart', matcher: 'startup|resume|clear|compact' },
    { event: 'UserPromptSubmit' },
  ]
  let changed = false
  for (const { event, matcher } of required) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const foreign = blocks.filter((b) => !isOurs(b))
    const ours = blocks.filter(isOurs)
    const canonical: HookBlock = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd, timeout: 5 }],
    }
    const current = ours[0]
    if (ours.length !== 1 || current?.matcher !== matcher || current?.hooks?.[0]?.command !== cmd) changed = true
    settings.hooks[event] = [...foreign, canonical]
  }

  if (!changed) {
    console.log(`[hooks] Codex SessionStart/UserPromptSubmit hooks already installed → ${hooksPath}`)
    return
  }
  try {
    writeJsonAtomic(hooksPath, settings)
    console.log(`[hooks] installed Codex SessionStart/UserPromptSubmit hooks → ${hooksPath}`)
    console.log('[hooks] Codex requires reviewing these user hooks with /hooks before normal use')
  } catch (err) {
    console.error('[hooks] failed to write Codex hooks.json:', err)
  }
}
