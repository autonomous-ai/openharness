/** A managed YAML hook block and exact-command approvals, applied from eager engine declarations. */
import { isMap, isScalar, Lexer, parseDocument, visit } from 'yaml'
import { basename, join } from 'node:path'
import { HookPreparationHeld, inspectHookFile, type HookFilePublication, runHookPreparation, type HookPreparationAttempt, type HookPreparationOptions } from './nativeHookFiles.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { isManagedHookCommand } from './notifyHooks.js'
import { nativeHookHomes, type NativeHookHomes } from './nativeHookHomes.js'
import { failure, type HookFileRemoval } from './hookRemoval.js'

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
function stripOwnedBlocks(rule: NativeYamlHooks, config: string, hookLines: ReadonlySet<number>, removal = false): { cleaned: string; foreignHooks: boolean; removed: number } {
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
      // Uninstall: the one blank line the installer put before its block (`hooksBlock`) goes with it.
      if (removal && out.at(-1) === '') out.pop()
      continue
    }
    if (hookLines.has(i) && !/^hooks:\s*$/.test(line)) foreignHooks = true
    if (hookLines.has(i) && /^hooks:\s*$/.test(line)) {
      let j = i + 1
      while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('\t') || lines[j].trim() === '')) j++
      const body = lines.slice(i + 1, j)
      if (isOwnedHooksBody(rule, body)) {
        removed++
        // Uninstall keeps the blank lines after the mapping: they separate what the person wrote.
        let end = j
        if (removal) while (end > i + 1 && lines[end - 1].trim() === '') end--
        i = end - 1
        continue
      }
      foreignHooks = true
      out.push(line)
      continue
    }
    out.push(line)
  }
  const cleaned = out.join('\n')
  return { cleaned: removal ? cleaned : cleaned.replace(/\n{3,}$/, '\n'), foreignHooks, removed }
}

/** What one home's installation said, held until every home before it has said its own. */
type HomeLines = Array<{ stream: 'log' | 'error'; args: unknown[] }>

/** Installs only homes with a config, each with its own command and allowlist. */
export async function installNativeYamlHooks(rule: NativeYamlHooks, commandForHome: (home: string) => string, selectedHome?: string, options: HookPreparationOptions & { createMissing?: boolean } = {}): Promise<boolean> {
  const homes = selectedHome ? [selectedHome] : nativeHookHomes(rule.homes, rule.home)
  // Homes are prepared four at a time, but what each says is printed in the homes' order: the default
  // home, then its profiles. Printed as each finished, a profile's lines came before the default home's
  // whenever its disk confirmation returned first, which the Hermes golden (otherHooks.golden.spec.ts)
  // caught on busy CI shards. Before the pool (#1158) the homes were installed, and logged, in order.
  const lines: HomeLines[] = homes.map(() => []), finished = homes.map(() => false)
  let next = 0, printed = 0, installed = true
  const print = () => {
    for (; printed < homes.length && finished[printed]; printed++) {
      for (const { stream, args } of lines[printed]) console[stream](...args)
    }
  }
  const worker = async () => {
    while (next < homes.length) {
      const index = next++, home = homes[index]
      try {
        if (!await installIn(rule, commandForHome(home), home, options, lines[index])) installed = false
      } finally { finished[index] = true; print() }
    }
  }
  // The declared catalog includes up to 64 profiles. Starting them all at once
  // starved the same tail behind the preparation pool on every healthy retry.
  await Promise.all(Array.from({ length: Math.min(4, homes.length) }, worker))
  return installed
}

/** Why a config is reported though nothing in it was removed: Harness's commands are in the person's own mapping. */
export const YAML_HOOKS_KEPT = "Harness's hook commands are in a hooks: mapping Harness did not write; remove them by hand."

/** A `hooks:` mapping left in [cleaned] that runs one of Harness's commands for this engine. */
function managedHooksIn(rule: NativeYamlHooks, cleaned: string): boolean {
  const document = parseDocument(cleaned, { strict: true, uniqueKeys: false, prettyErrors: false })
  if (!isMap(document.contents)) return false
  let found = false
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || pair.key.value !== 'hooks') continue
    visit(pair.value, { Scalar(_, node) {
      if (typeof node.value === 'string' && isManagedHookCommand(node.value) && rule.ownership.every((fragment) => (node.value as string).includes(fragment))) {
        found = true
        return visit.BREAK
      }
    } })
  }
  return found
}

/**
 * `harness uninstall`: every block this installer owns (`stripOwnedBlocks`: the delimited one and a bare one an older
 * release left), and Harness's approvals, out of each home's files. Both files are read and prepared before either is
 * written, as the installer does, so an approvals file that cannot be changed leaves the config as it was too, and is
 * the file reported. A foreign `hooks:` mapping is left alone, as the installer leaves it, and reported when Harness's
 * commands are in it. A config with CRLF line ends throughout is read as LF and written back with CRLF.
 */
export async function removeNativeYamlHooks(rule: NativeYamlHooks, homes: readonly string[]): Promise<HookFileRemoval[]> {
  const outcomes: HookFileRemoval[] = []
  for (const home of homes) {
    const configPath = join(home, rule.homes.file)
    const allowlistPath = join(home, rule.allowlist)
    // The file being worked on, which a failure is reported against; and what was written before it.
    let at = configPath
    let done: HookFileRemoval[] = []
    try {
      outcomes.push(...await runHookPreparation([configPath, allowlistPath], async (attempt) => {
        at = configPath
        done = []
        const observed = inspectHookFile(configPath)
        let config: { next: string; removed: number } | null = null
        let kept: string | undefined
        if (observed.content !== null) {
          const crlf = observed.content.includes('\r\n') && !/(?:^|[^\r])\n/.test(observed.content)
          const text = crlf ? observed.content.replace(/\r\n/g, '\n') : observed.content
          const original = parseDocument(text, { strict: true, uniqueKeys: false, prettyErrors: false })
          if (original.errors.length || (original.contents !== null && !isMap(original.contents))) {
            throw new HookPreparationHeld('the YAML configuration is not a complete mapping')
          }
          const hookLines = new Set<number>()
          if (isMap(original.contents)) for (const pair of original.contents.items) {
            if (isScalar(pair.key) && pair.key.value === 'hooks' && pair.key.range) hookLines.add(text.slice(0, pair.key.range[0]).split('\n').length - 1)
          }
          const { cleaned, foreignHooks, removed } = stripOwnedBlocks(rule, text, hookLines, true)
          if (foreignHooks && managedHooksIn(rule, cleaned)) kept = YAML_HOOKS_KEPT
          if (removed > 0) {
            const next = cleaned.trim() ? cleaned : ''
            // The person's own duplicate keys are theirs, read by Hermes as before: only an error the removal made counts.
            const duplicates = (yaml: string) => parseDocument(yaml, { strict: true, uniqueKeys: true, prettyErrors: false }).errors
              .filter((error) => error.code === 'DUPLICATE_KEY').length
            const left = parseDocument(next, { strict: true, uniqueKeys: false, prettyErrors: false })
            if (left.errors.length || (left.contents !== null && !isMap(left.contents)) || duplicates(next) > duplicates(text)) {
              throw new HookPreparationHeld('the YAML configuration would not stay a complete mapping')
            }
            config = { next: crlf ? next.replace(/\n/g, '\r\n') : next, removed }
          }
        }
        at = allowlistPath
        const approvals = inspectHookFile(allowlistPath)
        let allowlist: { next: string; removed: number } | null = null
        if (approvals.content !== null) {
          let data: { approvals?: Array<{ command?: string }> }
          try { data = JSON.parse(approvals.content) } catch { throw new HookPreparationHeld('the hook approvals are not a readable list') }
          if (!data || typeof data !== 'object' || Array.isArray(data) || (data.approvals !== undefined && !Array.isArray(data.approvals))) {
            throw new HookPreparationHeld('the hook approvals are not a readable list')
          }
          const all = data.approvals ?? []
          const left = all.filter((a) => !(typeof a?.command === 'string' && isManagedHookCommand(a.command)
            && rule.ownership.every((fragment) => a.command!.includes(fragment))))
          if (left.length !== all.length) {
            allowlist = { next: JSON.stringify({ ...data, approvals: left }, null, 2) + '\n', removed: all.length - left.length }
            approvals.prepare(allowlist.next)
          }
        }
        at = configPath
        if (config) observed.prepare(config.next)
        if (config) {
          ;(await observed.replace(config.next, attempt)).verify()
          done.push({ file: configPath, removed: config.removed, ...(kept ? { kept } : {}) })
        } else if (kept) done.push({ file: configPath, removed: 0, kept })
        if (allowlist) {
          at = allowlistPath
          ;(await approvals.replace(allowlist.next, attempt)).verify()
          done.push({ file: allowlistPath, removed: allowlist.removed })
        }
        return done
      }, { identity: JSON.stringify(['uninstall', rule.begin, home]) }))
    } catch (error) {
      outcomes.push(...done, { file: at, removed: 0, failed: failure(error) })
    }
  }
  return outcomes
}

async function installIn(rule: NativeYamlHooks, cmd: string, home: string, options: HookPreparationOptions & { createMissing?: boolean }, lines: HomeLines): Promise<boolean> {
  const log = (...args: unknown[]) => { lines.push({ stream: 'log', args }) }
  const error = (...args: unknown[]) => { lines.push({ stream: 'error', args }) }
  const configPath = join(home, rule.homes.file)
  try { return await runHookPreparation([configPath, join(home, rule.allowlist)], async attempt => {
    const observed = inspectHookFile(configPath)
    if (observed.content === null && !options.createMissing) {
      if (home === rule.home) log(message(rule.messages.missing, { file: configPath }))
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
      error(message(rule.messages.foreign, { file: configPath }))
      error(rule.messages.manual)
      for (const event of rule.events) error(`[hooks]   ${event}: [{ command: ${JSON.stringify(cmd)}, timeout: ${rule.timeout} }]`)
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
      log(rule.messages.current + (home === rule.home ? '' : ` (${basename(home)})`))
      return true
    }

    const installed = await observed.replace(next, attempt), approved = await approve(attempt)
    installed.verify(); approved.verify()
    log(
      removed > 1
        ? message(rule.messages.collapsed, { removed: String(removed), file: configPath })
        : message(rule.messages.installed, { file: configPath }),
    )
    log(rule.messages.after)
    return true
  }, { ...options, identity: JSON.stringify([rule, cmd, home]) }) } catch (err) {
    error(rule.messages.failed, err)
    return false
  }
}

