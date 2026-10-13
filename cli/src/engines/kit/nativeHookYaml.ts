/** A managed YAML hook block and exact-command approvals, applied from eager engine declarations. */
import { isMap, isScalar, Lexer, parseDocument } from 'yaml'
import { basename, join } from 'node:path'
import { HookPreparationHeld, inspectHookFile, type HookFilePublication, runHookPreparation, type HookPreparationAttempt, type HookPreparationOptions } from './nativeHookFiles.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { isManagedHookCommand } from './notifyHooks.js'
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

function prepareAllowlist(rule: NativeYamlHooks, cmd: string, home: string): (attempt: HookPreparationAttempt) => Promise<HookFilePublication> {
  const allowlistPath = join(home, rule.allowlist)
  const observed = inspectHookFile(allowlistPath)
  const data = (observed.content === null ? { approvals: [] } : JSON.parse(observed.content)) as { approvals?: Array<{ event?: string; command?: string }> }
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data.approvals !== undefined && !Array.isArray(data.approvals))) {
    throw new HookPreparationHeld('the hook approvals are not a readable list')
  }
  const previous = data.approvals ?? []
  // Drop OUR stale approvals before adding the current one. Each command change — a new port, a moved
  // install, a new Node runtime — otherwise leaves five dead entries here forever, and the entry is
  // dead the moment the command string it approves is no longer the one we install. Foreign approvals
  // are somebody else's business and are copied through untouched.
  const isOurStaleApproval = (a: { command?: string }) =>
    typeof a?.command === 'string' &&
    isManagedHookCommand(a.command) && rule.ownership.every(fragment => a.command!.includes(fragment)) &&
    a.command !== cmd
  const approvals = previous.filter((a) => !isOurStaleApproval(a))
  let changed = approvals.length !== previous.length
  for (const event of rule.events) {
    // Approvals match exact (event, command) string equality.
    if (approvals.some((a) => a?.event === event && a?.command === cmd)) continue
    approvals.push({ event, command: cmd })
    changed = true
  }
  const next = changed ? JSON.stringify({ ...data, approvals }, null, 2) + '\n' : observed.content!
  observed.prepare(next)
  return attempt => observed.replace(next, attempt)
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
  return commands.length > 0 && commands.every(line => {
    try {
      const cmd: unknown = JSON.parse(line.trim().slice('- command:'.length))
      return isManagedHookCommand(cmd) && rule.ownership.every(fragment => (cmd as string).includes(fragment))
    } catch { return false }
  })
    && body.every(line => !line.trim() || /^\s+- command:/.test(line) || /^\s+timeout:\s+\d+\s*$/.test(line)
      || rule.events.some(event => line === `  ${event}:`))
}

/**
 * Strip every block this installer owns: the delimited BEGIN…END form AND any bare `hooks:` mapping
 * left behind by the earlier buggy rewrite (identified by its notify.mjs commands). Returns the cleaned
 * document plus whether a FOREIGN `hooks:` key survives — the caller must not touch the file then.
 */
function stripOwnedBlocks(rule: NativeYamlHooks, config: string, hookLines: ReadonlySet<number>): { cleaned: string; foreignHooks: boolean; removed: number } {
  const lines = config.split('\n')
  const out: string[] = []
  let removed = 0
  let foreignHooks = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === rule.begin && hookLines.has(i + 1)) {
      // A truncated marker gives no evidence about where the person's remaining
      // configuration begins. Keep the whole document until it can be verified.
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== rule.end) j++
      if (j === lines.length) throw new HookPreparationHeld('the managed YAML block has no closing marker')
      if (lines[i + 1] !== 'hooks:' || !isOwnedHooksBody(rule, lines.slice(i + 2, j))) {
        throw new HookPreparationHeld('the managed YAML block contains unconfirmed configuration')
      }
      i = j
      removed++
      continue
    }
    if (hookLines.has(i) && !/^hooks:\s*$/.test(line)) foreignHooks = true
    if (hookLines.has(i) && /^hooks:\s*$/.test(line)) {
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
export async function installNativeYamlHooks(rule: NativeYamlHooks, commandForHome: (home: string) => string, selectedHome?: string, options: HookPreparationOptions & { createMissing?: boolean } = {}): Promise<boolean> {
  const homes = selectedHome ? [selectedHome] : nativeHookHomes(rule.homes, rule.home)
  let next = 0, installed = true
  const worker = async () => {
    while (next < homes.length) {
      const home = homes[next++]
      if (!await installIn(rule, commandForHome(home), home, options)) installed = false
    }
  }
  // The declared catalog includes up to 64 profiles. Starting them all at once
  // starved the same tail behind the preparation pool on every healthy retry.
  await Promise.all(Array.from({ length: Math.min(4, homes.length) }, worker))
  return installed
}

async function installIn(rule: NativeYamlHooks, cmd: string, home: string, options: HookPreparationOptions & { createMissing?: boolean }): Promise<boolean> {
  const configPath = join(home, rule.homes.file)
  try { return await runHookPreparation([configPath, join(home, rule.allowlist)], async attempt => {
    const observed = inspectHookFile(configPath)
    if (observed.content === null && !options.createMissing) {
      if (home === rule.home) console.log(message(rule.messages.missing, { file: configPath }))
      return false
    }
    // A captured launch owns preparation of its selected home, including its
    // first settings file. A background catalog scan never creates a profile.
    const config = observed.content ?? ''

    const budget = new NativeEvidenceBudget()
    let tokens = 0
    for (const _token of new Lexer().lex(config)) {
      budget.step()
      if (++tokens > 4096) throw new HookPreparationHeld('the YAML configuration exceeds its structure limit')
    }
    // Parse before examining markers: marker-like text inside a quoted scalar
    // is somebody else's configuration. Duplicate managed mappings from older
    // installs are removable, but every remaining key must be unique.
    const original = parseDocument(config, { strict: true, uniqueKeys: false, prettyErrors: false })
    if (original.errors.length || original.warnings.length || (original.contents !== null && !isMap(original.contents))) {
      throw new HookPreparationHeld('the YAML configuration is not a complete mapping')
    }
    const hookLines = new Set<number>()
    if (isMap(original.contents)) for (const pair of original.contents.items) {
      if (isScalar(pair.key) && pair.key.value === 'hooks' && pair.key.range) {
        hookLines.add(config.slice(0, pair.key.range[0]).split('\n').length - 1)
      }
    }
    const { cleaned, foreignHooks, removed } = stripOwnedBlocks(rule, config, hookLines)
    const document = parseDocument(cleaned, { strict: true, uniqueKeys: true, prettyErrors: false })
    budget.step()
    if (document.errors.length || document.warnings.length || (document.contents !== null && !isMap(document.contents))) {
      throw new HookPreparationHeld('the YAML configuration is not a complete mapping')
    }
    if (foreignHooks || document.has('hooks')) {
      console.error(message(rule.messages.foreign, { file: configPath }))
      console.error(rule.messages.manual)
      for (const event of rule.events) console.error(`[hooks]   ${event}: [{ command: ${JSON.stringify(cmd)}, timeout: ${rule.timeout} }]`)
      return false
    }

    const next = `${cleaned.replace(/\s*$/, '')}\n${hooksBlock(rule, cmd)}`
    const combined = parseDocument(next, { strict: true, uniqueKeys: true, prettyErrors: false })
    budget.step()
    if (combined.errors.length || combined.warnings.length) throw new HookPreparationHeld('the managed hooks cannot be appended to this YAML document')
    // Inspect approvals before writing YAML. A malformed or unreadable allowlist
    // must never be replaced with an empty one, nor leave half an installation.
    observed.prepare(next)
    const approve = prepareAllowlist(rule, cmd, home)
    if (next === config) {
      const installed = await observed.replace(config, attempt), approved = await approve(attempt)
      installed.verify(); approved.verify()
      console.log(rule.messages.current + (home === rule.home ? '' : ` (${basename(home)})`))
      return true
    }

    const installed = await observed.replace(next, attempt), approved = await approve(attempt)
    installed.verify(); approved.verify()
    console.log(
      removed > 1
        ? message(rule.messages.collapsed, { removed: String(removed), file: configPath })
        : message(rule.messages.installed, { file: configPath }),
    )
    console.log(rule.messages.after)
    return true
  }, { ...options, identity: JSON.stringify([rule, cmd, home]) }) } catch (err) {
    console.error(rule.messages.failed, err)
    return false
  }
}

