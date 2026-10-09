/**
 * The one installer of the engines' declared hook settings (facets/hooks.ts `HookSettings`): Harness's block
 * merged into the settings file an engine reads its hooks from, every other block left as it was.
 *
 * It replaces Claude Code's and Codex's own installers, statement for statement, and writes the same bytes,
 * modes and log lines in every state their files were recorded in (engines/hookInstallers.golden.spec.ts).
 * It runs in core, synchronously: at daemon start (core/engines/hooks.ts) and before a Codex agent starts in
 * a profile of its own (core/agents/create.ts), where a hook installed late is a hook that never fires.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../../config/env.js'
import type { HookSettings } from '../facets/hooks.js'
import { command, HOOK_SCRIPT, isOurs, writeJsonAtomic, type Settings } from './notifyHooks.js'

/** The engines whose hooks run the notify.mjs command. */
export type HookEngine = Parameters<typeof command>[1]

/** The home an engine's settings are in when core names none. */
export function defaultHookHome(settings: HookSettings): string {
  return 'setting' in settings.home ? env[settings.home.setting] : join(homedir(), settings.home.inHome)
}

export function installHookSettings(engine: HookEngine, settings: HookSettings, port: number, home: string = defaultHookHome(settings)): void {
  const file = join(home, settings.file)
  const say = (line: string): string => line.replace(/\{(file|script|port)\}/g, (_, name: string) =>
    name === 'file' ? file : name === 'script' ? HOOK_SCRIPT : String(port))
  const { messages } = settings
  let current: Settings = {}
  if (settings.unreadable === 'replace') {
    try {
      current = JSON.parse(readFileSync(file, 'utf-8')) as Settings
    } catch {
      // missing / unreadable → start from empty settings
    }
  } else if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf-8')) as Settings
    } catch {
      for (const line of messages.malformed ?? []) console.error(say(line))
      return
    }
  }

  if (!current.hooks || typeof current.hooks !== 'object') current.hooks = {}
  const cmd = command(port, engine, settings.commandNamesHome ? home : undefined)
  let changed = false
  let updated = false // true when an EXISTING block's command changed (path/port drift)

  for (const { event, matcher } of settings.events) {
    const blocks = Array.isArray(current.hooks[event]) ? current.hooks[event] : []
    // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and keep every
    // non-ours block untouched.
    const foreign = blocks.filter((b) => !isOurs(b))
    const ours = blocks.filter(isOurs)
    if (ours.length !== 1) changed = true // none yet, or duplicates to drop
    const existing = ours[0]
    if (existing) {
      // A prior block with a different command (moved checkout / dev↔dist / changed port / interpreter) is
      // overwritten in place by the canonical one below.
      const existingCmd = settings.upToDate.command === 'first-ours'
        ? existing.hooks?.find((h) => isOurs({ hooks: [h] }))?.command
        : existing.hooks?.[0]?.command
      if (existingCmd !== cmd) { changed = true; updated = true }
      if (settings.upToDate.matcher && existing.matcher !== matcher) changed = true
    }
    current.hooks[event] = [...foreign, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: settings.timeout }] }]
  }

  if (!changed) {
    console.log(say(messages.current))
    return
  }

  try {
    if (settings.write === 'atomic') writeJsonAtomic(file, current)
    else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(current, null, 2) + '\n')
    }
    console.log(say(updated && messages.updated ? messages.updated : messages.installed))
    console.log(say(messages.after))
  } catch (err) {
    console.error(say(messages.failed), err)
  }
}
