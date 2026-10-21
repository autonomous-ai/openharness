/**
 * The one installer of the engines' declared hook settings (facets/hooks.ts `HookSettings`): Harness's block
 * merged into the settings file an engine reads its hooks from, every other block left as it was.
 *
 * It runs eagerly before launch. Unknown files are held, foreign commands are
 * preserved, and hook and approval destinations are inspected before publication.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../../config/env.js'
import { HARNESS_AGENT_TOOLS, HARNESS_AGENT_VERBS, type HookSettings } from '../facets/hooks.js'
import { prepareReviewed } from './hookReview.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { isMessagesBlock, messagesCommand, writeMessagesHook } from './messagesHook.js'
import { HOOK_SCRIPT, hookArgv, hooksNotInstalled, hooksNotOnWindows, identitySettings, isManagedHook, foreignHookBlocks, quoteHookCommand, type CommandHook, type HookBlock, type Settings } from './notifyHooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation, type HookPreparationAttempt } from './nativeHookFiles.js'
import type { NativeHookOptions } from './nativeLocations.js'
import { hostPlatform } from './windowsFiles.js'

/** The engines whose hooks run the notify.mjs command. */
export type HookEngine = Parameters<typeof hookArgv>[1]

/** The home an engine's settings are in when core names none. */
export function defaultHookHome(settings: HookSettings): string {
  return 'setting' in settings.home ? env[settings.home.setting] : join(homedir(), settings.home.inHome)
}

/**
 * The hook of ours that [settings]' engine runs, as its runner on [platform] takes [argv]. That is one line, or, for an
 * engine that starts a program itself (Claude Code's exec form on Windows), the program and its `args`. Null on
 * Windows for an engine that declares no runner there.
 */
export function notifyHookEntry(settings: HookSettings, argv: string[], platform: NodeJS.Platform = hostPlatform()): { command: string; args?: string[] } | null {
  const runner = platform === 'win32' ? settings.win32Runner : 'bash'
  if (!runner) return null
  const quoted = quoteHookCommand(runner, argv)
  return Array.isArray(quoted) ? { command: quoted[0], args: quoted.slice(1) } : { command: quoted }
}

export async function installHookSettings(engine: HookEngine, settings: HookSettings, port: number, home: string = defaultHookHome(settings), options: NativeHookOptions = {},
  platform: NodeJS.Platform = hostPlatform()): Promise<boolean> {
  const files = [join(home, settings.file), ...(settings.reviewed ? [join(home, settings.reviewed.file)] : [])]
  // A startup refresh and a launch share the entire installation. Releasing the
  // reservation between notify and Messages let each revoke the other's second
  // stage, so a healthy launch could be held by the daemon's own refresh.
  try {
    // Inside the try: a path the engine's Windows runner would misread is refused here (quoteHookCommand), and that
    // is a failed install with its reason, not a rejection (B4.1 review).
    const entry = notifyHookEntry(settings, hookArgv(port, engine, settings.commandNamesHome ? home : undefined, undefined, options.environment), platform)
    if (!entry) return hooksNotOnWindows(engine)
    return await runHookPreparation(files, async attempt => {
      await installNotifyHooks(settings, port, home, entry, attempt, platform)
      // Windows: Agent Messages' block is a POSIX shell line, and the allowance names the POSIX launcher. Neither is
      // installed there yet (Phase B4 notes), so neither is the confirmation of the required files that stage uses.
      if (platform !== 'win32') {
        const required = files.map(file => inspectHookFile(file))
        const verifyRequired = () => { attempt.verify(); for (const file of required) file.verify() }
        if (settings.inbox || settings.allow) await installMessagesBlock(settings, home, attempt, verifyRequired)
      }
      return true
    }, { ...options, identity: JSON.stringify([engine, identitySettings(settings, platform), port, home, entry.args ? [entry.command, entry.args] : entry.command, env.HARNESS_AGENT_MESSAGES_DIR]) })
  } catch (err) {
    const line = hooksNotInstalled(engine, err, platform)
    if (line) { console.error(line); return false }
    console.error(settings.messages.failed.replace(/\{(file|script|port)\}/g, (_, name: string) =>
      name === 'file' ? files[0] : name === 'script' ? HOOK_SCRIPT : String(port)), err)
    return false
  }
}

/**
 * Agent Messages' block (kit/messagesHook.ts) in the engine's settings: exactly one, in its event, running the
 * current command, every other block as it was; its script beside the inboxes; and for Codex, the block
 * recorded as reviewed like Harness's others. Harness's allowance goes in the same write where it is a list in
 * the same file, or in its own rules file. It shares their reservation and deadline. An optional failure is
 * harmless only while the required hooks remain exactly as confirmed; an uncertain partial write holds launch.
 * A message can still reach an idle agent, typed, and a command not allowed asks, as before.
 */
async function installMessagesBlock(settings: HookSettings, home: string, attempt: HookPreparationAttempt, verifyRequired: () => void): Promise<void> {
  const file = join(home, settings.file)
  const root = env.HARNESS_AGENT_MESSAGES_DIR
  const inboxCommand = messagesCommand(root)
  const { inbox, allow } = settings
  let blockChanged = inbox !== undefined
  try {
    verifyRequired()
    const observed = inspectHookFile(file)
    const current = (observed.content === null ? {} : JSON.parse(observed.content)) as Settings
    if (!current || typeof current !== 'object' || Array.isArray(current) || !current.hooks || typeof current.hooks !== 'object'
      || Array.isArray(current.hooks) || (inbox && current.hooks[inbox.event] !== undefined && !Array.isArray(current.hooks[inbox.event]))) {
      throw new HookPreparationHeld('the hook settings do not have the declared object shape')
    }
    let allowed = false
    if (allow && 'list' in allow) for (const group of harnessRules(allow.rules)) allowed = withRules(current, allow.list, group, allow.unless) || allowed
    if (inbox) {
      const blocks = current.hooks[inbox.event] ?? []
      const ours = blocks.filter(isMessagesBlock)
      blockChanged = ours.length !== 1 || ours[0].matcher !== undefined || ours[0].hooks?.length !== 1
        || ours[0].hooks[0]?.command !== inboxCommand || ours[0].hooks[0]?.timeout !== settings.timeout
      current.hooks[inbox.event] = [...foreignHookBlocks(blocks, isMessagesBlock), { hooks: [{ type: 'command', command: inboxCommand, timeout: settings.timeout }] }]
    }
    const changed = allowed || blockChanged
    const next = changed ? JSON.stringify(current, null, 2) + '\n' : observed.content!
    const reviewed = settings.reviewed ? prepareReviewed(settings.reviewed, home, file, JSON.parse(next) as Settings) : null
    reviewed?.verify()
    const published = await observed.replace(next, attempt)
    const approval = await reviewed?.commit(attempt)
    published.verify(); approval?.verify()
    if (inbox) writeMessagesHook(root)
  } catch (err) {
    const reason = err instanceof Error ? err.message : err
    if (blockChanged) console.warn(`[hooks] Agent Messages' hook not installed in ${file} (messages reach its agents once they are idle):`, reason)
    else {
      // The hook was already in place and only the allowance was refused (a read-only file): its script is
      // still kept current, and the log names what failed rather than calling the hook missing.
      console.warn(`[hooks] could not allow Harness's agent commands in ${file} (the engine asks before each one):`, reason)
      if (inbox) try { writeMessagesHook(root) } catch { /* the hook runs nothing it cannot find; messages wait for idle */ }
    }
    verifyRequired()
  }
  if (allow && 'file' in allow) {
    // Each path written as a Starlark string's contents: the file's rules are `prefix_rule(pattern=["…"])`.
    try { writeRulesFile(join(home, allow.file), harnessRules(allow.rules, (path) => JSON.stringify(path).slice(1, -1)).flat().join('\n')) } catch (err) {
      console.warn(`[hooks] could not allow Harness's agent commands in ${join(home, allow.file)} (the engine asks before each one):`, err instanceof Error ? err.message : err)
    }
  }
}

/**
 * The declared rules as this computer has them (facets/hooks.ts HarnessAllowance): its paths in place of
 * `{launcher}`, `{node}` and `{cli}`, every verb as one Starlark list in place of `{verbs}`, and a rule that names
 * `{verb}` or `{tool}` once for each agent verb. In groups that are added together or not at all: the rules naming no
 * verb, then each verb's rules of one kind (`Bash(…)`, `mcp__…`), its spellings of the same command.
 */
export function harnessRules(rules: readonly string[], quote: (path: string) => string = (path) => path): string[][] {
  const paths: Record<string, string> = {
    launcher: join(env.HARNESS_BIN_DIR, 'harness'), node: managedNodePath(), cli: join(env.ADAPTER_CLI_DIR, 'cli.js'),
  }
  const verbs = `[${HARNESS_AGENT_VERBS.map((verb) => JSON.stringify(verb)).join(', ')}]`
  const fill = (rule: string, verb?: keyof typeof HARNESS_AGENT_TOOLS): string => rule.replace(/\{(launcher|node|cli|verbs|verb|tool)\}/g,
    (_, name: string) => name === 'verbs' ? verbs : name === 'verb' ? verb! : name === 'tool' ? HARNESS_AGENT_TOOLS[verb!] : quote(paths[name]))
  const perVerb = (rule: string) => /\{(verb|tool)\}/.test(rule)
  const kind = (rule: string) => /^[A-Za-z]*/.exec(rule)![0]
  const whole = rules.filter((rule) => !perVerb(rule)).map((rule) => fill(rule))
  const kinds = [...new Set(rules.filter(perVerb).map(kind))]
  return [...(whole.length ? [whole] : []),
    ...HARNESS_AGENT_VERBS.flatMap((verb) => kinds.map((k) => rules.filter((rule) => perVerb(rule) && kind(rule) === k).map((rule) => fill(rule, verb))))]
}

/**
 * Add a group of `rules` to the list at `[table, list]` (`permissions.allow`), creating what is missing and keeping
 * every other rule. A shape Harness does not know is left as it is: the person's rules are never rewritten to fit.
 * None of the group is added where one of the person's `unless` lists (`deny`, `ask`) touches any of it.
 */
function withRules(settings: Settings, [table, list]: readonly [string, string], rules: readonly string[], unless: readonly string[] = []): boolean {
  const at = settings[table] ?? {}
  if (!at || typeof at !== 'object' || Array.isArray(at)) return false
  const lists = at as Record<string, unknown>
  const current = lists[list] ?? []
  if (!Array.isArray(current)) return false
  const theirs = unless.flatMap((name) => Array.isArray(lists[name]) ? (lists[name] as unknown[]).filter((rule): rule is string => typeof rule === 'string') : [])
  if (rules.some((rule) => theirs.some((other) => touches(other, rule)))) return false
  const missing = rules.filter((rule) => !current.includes(rule))
  if (!missing.length) return false
  settings[table] = { ...at, [list]: [...current, ...missing] }
  return true
}

/**
 * Whether the person's rule names the same command as ours, a broader one or a narrower one: with the closing
 * parenthesis and a trailing wildcard left off, one starts with the other. `Bash(harness:*)`, `Bash(harness close
 * --now)`, `Bash` and `mcp__harness` all touch `Bash(harness close:*)` or `mcp__harness__harness_close`; an unrelated
 * prefix such as `Bash(har*)` does too, which only leaves an allow out.
 */
function touches(theirs: string, ours: string): boolean {
  const stem = (rule: string) => rule.replace(/\)$/, '').replace(/(:\*|\s*\*)$/, '').trimEnd()
  const a = stem(theirs), b = stem(ours)
  return a.length > 0 && (b.startsWith(a) || a.startsWith(b))
}

/** The head of Harness's rules file: what it is for, and that Harness keeps it. */
export const RULES_HEADER = `# Written by Harness, which rewrites it: do not edit. Its agent commands (harness ${HARNESS_AGENT_VERBS.join(', ')})\n`
  + "# need Harness's daemon, which Codex's sandbox cannot reach, so they run outside it without asking. What each\n"
  + '# may do is for Harness to decide: Settings > Experimental, and an agent gives work to and closes only what it started.\n'

/** A rules file Harness owns whole: written atomically, and only when it does not already say exactly this. */
function writeRulesFile(file: string, rules: string): void {
  const text = `${RULES_HEADER}${rules}\n`
  try { if (readFileSync(file, 'utf8') === text) return } catch { /* not written yet */ }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
}

async function installNotifyHooks(settings: HookSettings, port: number, home: string, entry: { command: string; args?: string[] }, attempt: HookPreparationAttempt,
  platform: NodeJS.Platform): Promise<boolean> {
  const file = join(home, settings.file)
  const say = (line: string): string => line.replace(/\{(file|script|port)\}/g, (_, name: string) =>
    name === 'file' ? file : name === 'script' ? HOOK_SCRIPT : String(port))
  // Ours as this platform reads a hook: on Windows a line for its runner, or exec form (kit/notifyHooks.ts isManagedHook).
  const isOurs = (block: HookBlock): boolean => Array.isArray(block?.hooks) && block.hooks.some(hook => isManagedHook(hook, platform))
  // A hook already there is the current one when its line is. On Windows its arguments too: exec form keeps them in
  // `args`, so a check of `command` alone saw any port as current (B4.2 review), and there a line with a stray `args`
  // is drift. Off Windows the line alone decides, as it always has (mac/Linux unchanged).
  const sameHook = (hook: CommandHook | undefined): boolean => hook?.command === entry.command
    && ((platform !== 'win32' && entry.args === undefined) || JSON.stringify(hook.args) === JSON.stringify(entry.args))
  const { messages } = settings
  const observed = inspectHookFile(file)
  const current = (observed.content === null ? {} : JSON.parse(observed.content)) as Settings
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks)))) {
    throw new HookPreparationHeld('the hook settings do not have the declared object shape')
  }
  current.hooks ??= {}
  let changed = false
  let updated = false // true when an EXISTING block's command changed (path/port drift)

  for (const { event, matcher } of settings.events) {
    if (current.hooks[event] !== undefined && !Array.isArray(current.hooks[event])) throw new HookPreparationHeld('a hook event is not a list')
    const blocks = current.hooks[event] ?? []
    // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and keep every
    // non-ours block untouched.
    const foreign = foreignHookBlocks(blocks, isOurs)
    const ours = blocks.filter(isOurs)
    if (ours.length !== 1) changed = true // none yet, or duplicates to drop
    const existing = ours[0]
    if (existing) {
      // A prior block with a different command (moved checkout / dev↔dist / changed port / interpreter) is
      // overwritten in place by the canonical one below.
      const existingHook = settings.upToDate.command === 'first-ours'
        ? existing.hooks?.find((h) => isOurs({ hooks: [h] }))
        : existing.hooks?.[0]
      if (!sameHook(existingHook)) { changed = true; updated = true }
      if (settings.upToDate.matcher && existing.matcher !== matcher) changed = true
    }
    current.hooks[event] = [...foreign, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: entry.command, ...(entry.args ? { args: entry.args } : {}), timeout: settings.timeout }] }]
  }

  const next = changed ? JSON.stringify(current, null, 2) + '\n' : observed.content!
  const reviewed = settings.reviewed ? prepareReviewed(settings.reviewed, home, file, JSON.parse(next) as Settings, platform) : null
  reviewed?.verify()
  if (!changed) {
    const published = await observed.replace(next, attempt)
    console.log(say(messages.current))
    // Installed by an earlier start, or by a release before the engine asked: recorded now, as the file has it.
    const approval = await reviewed?.commit(attempt)
    published.verify(); approval?.verify()
    return true
  }

  const published = await observed.replace(next, attempt)
  console.log(say(updated && messages.updated ? messages.updated : messages.installed))
  console.log(say(messages.after))
  const approval = await reviewed?.commit(attempt)
  published.verify(); approval?.verify()
  return true
}
