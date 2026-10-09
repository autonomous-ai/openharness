/** A managed YAML hook block and exact-command approvals, applied from eager engine declarations. */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeJsonAtomic } from './notifyHooks.js'
import { nativeHookHomes, type NativeHookHomes } from './nativeHookHomes.js'

export interface NativeYamlHooks {
  home: string
  homes: NativeHookHomes
  begin: string
  end: string
  events: readonly string[]
  timeout: number
  allowlist: string
  ownership: readonly string[]
  messages: { missing: string; foreign: string; manual: string; current: string; installed: string; collapsed: string; after: string; failed: string }
}
function message(template: string, values: Record<string, string>): string {
  return template.replace(/\{(file|removed)\}/g, (_, key: string) => values[key])
}

function allowlistHook(rule: NativeYamlHooks, cmd: string, home: string): void {
  const allowlistPath = join(home, rule.allowlist)
  let data: { approvals?: Array<{ event?: string; command?: string }> } = { approvals: [] }
  try {
    const parsed = JSON.parse(readFileSync(allowlistPath, 'utf-8')) as typeof data
    if (parsed && Array.isArray(parsed.approvals)) data = parsed
  } catch { /* absent or unreadable → start from an empty skeleton */ }
  const previous = data.approvals ?? []
  // Drop OUR stale approvals before adding the current one. Each command change — a new port, a moved
  // install, a new Node runtime — otherwise leaves five dead entries here forever, and the entry is
  // dead the moment the command string it approves is no longer the one we install. Foreign approvals
  // are somebody else's business and are copied through untouched.
  const isOurStaleApproval = (a: { command?: string }) =>
    typeof a?.command === 'string' &&
    rule.ownership.every(fragment => a.command!.includes(fragment)) &&
    a.command !== cmd
  const approvals = previous.filter((a) => !isOurStaleApproval(a))
  let changed = approvals.length !== previous.length
  for (const event of rule.events) {
    // Approvals match exact (event, command) string equality.
    if (approvals.some((a) => a?.event === event && a?.command === cmd)) continue
    approvals.push({ event, command: cmd })
    changed = true
  }
  if (!changed) return
  writeJsonAtomic(allowlistPath, { ...data, approvals })
}

function hooksBlock(rule: NativeYamlHooks, cmd: string): string {
  const entries = rule.events
    .map((event) => `  ${event}:\n    - command: ${JSON.stringify(cmd)}\n      timeout: ${rule.timeout}`)
    .join('\n')
  return `\n${rule.begin}\nhooks:\n${entries}\n${rule.end}\n`
}

/** True for a top-level `hooks:` mapping that is ours (every command runs our notify.mjs for this engine). */
function isOwnedHooksBody(rule: NativeYamlHooks, body: string[]): boolean {
  const commands = body.filter((line) => /^\s*- command:/.test(line))
  return commands.length > 0 && commands.every((line) => rule.ownership.every(fragment => line.includes(fragment)))
}

/**
 * Strip every block this installer owns: the delimited BEGIN…END form AND any bare `hooks:` mapping
 * left behind by the earlier buggy rewrite (identified by its notify.mjs commands). Returns the cleaned
 * document plus whether a FOREIGN `hooks:` key survives — the caller must not touch the file then.
 */
function stripOwnedBlocks(rule: NativeYamlHooks, config: string): { cleaned: string; foreignHooks: boolean; removed: number } {
  const lines = config.split('\n')
  const out: string[] = []
  let removed = 0
  let foreignHooks = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === rule.begin) {
      // Skip through the END marker (or, for a truncated block, to the end of the mapping).
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== rule.end) j++
      i = j < lines.length ? j : lines.length - 1
      removed++
      continue
    }
    if (/^hooks:\s*$/.test(line)) {
      let j = i + 1
      while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('\t') || lines[j].trim() === '')) j++
      const body = lines.slice(i + 1, j)
      if (isOwnedHooksBody(rule, body)) { removed++; i = j - 1; continue }
      foreignHooks = true
      out.push(line)
      continue
    }
    out.push(line)
  }
  return { cleaned: out.join('\n').replace(/\n{3,}$/, '\n'), foreignHooks, removed }
}

/** Installs only homes with a config, each with its own command and allowlist. */
export function installNativeYamlHooks(rule: NativeYamlHooks, commandForHome: (home: string) => string): void {
  for (const home of nativeHookHomes(rule.homes, rule.home)) installIn(rule, commandForHome(home), home)
}

function installIn(rule: NativeYamlHooks, cmd: string, home: string): void {
  const configPath = join(home, rule.homes.file)
  let config = ''
  try {
    config = readFileSync(configPath, 'utf-8')
  } catch {
    if (home === rule.home) console.log(message(rule.messages.missing, { file: configPath }))
    return
  }

  const { cleaned, foreignHooks, removed } = stripOwnedBlocks(rule, config)
  if (foreignHooks) {
    console.error(message(rule.messages.foreign, { file: configPath }))
    console.error(rule.messages.manual)
    for (const event of rule.events) console.error(`[hooks]   ${event}: [{ command: ${JSON.stringify(cmd)}, timeout: ${rule.timeout} }]`)
    return
  }

  const next = `${cleaned.replace(/\s*$/, '')}\n${hooksBlock(rule, cmd)}`
  if (next === config) {
    allowlistHook(rule, cmd, home) // keep the allowlist in sync even when the block is current
    console.log(rule.messages.current + (home === rule.home ? '' : ` (${basename(home)})`))
    return
  }

  try {
    writeFileSync(configPath, next)
    allowlistHook(rule, cmd, home)
    console.log(
      removed > 1
        ? message(rule.messages.collapsed, { removed: String(removed), file: configPath })
        : message(rule.messages.installed, { file: configPath }),
    )
    console.log(rule.messages.after)
  } catch (err) {
    console.error(rule.messages.failed, err)
  }
}

