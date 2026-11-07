/**
 * The argv that has an engine add a line to the pull requests it opens (facets/launch.ts `AttributionContract`), for
 * a harness another agent started (lib/agentAttribution.ts). Shared mechanics on the declaration alone, run in core
 * with the rest of a launch's argv. The person's own settings are read as the engine reads them, at each launch: the
 * line goes beside the engine's own, never replaces a value of theirs, and is not added where they hid the
 * engine's attribution.
 */
import { dirname, join, parse, resolve } from 'node:path'
import type { AttributionContract, InstructionAttribution, SettingAttribution } from '../facets/launch.js'
import { fill, topLevelEntry } from './launchArgs.js'

/** Where a launch's settings are, found by the caller (engines/launches.ts `attributionArgs`). */
export interface AttributionFiles {
  /** The engine's home for this launch: the person's own settings are in it. */
  home: string
  /** The person's home folder: a folder's own config is looked for up to it, never in it. */
  personal: string
  /** The harness's folder, or null where it has none. */
  cwd: string | null
  /** A file's text, or null when it is absent or cannot be read. */
  read: (path: string) => string | null
}

/** The argv for `line`, or none where the person's settings say not to add it. */
export function attributionArgsIn(contract: AttributionContract, line: string, files: AttributionFiles): string[] {
  return contract.kind === 'setting' ? settingArgs(contract, line, files) : instructionArgs(contract, [attributionInstruction(contract, line)], files)
}

/** One instruction for an instruction engine: its text, and what in the person's own value says it is there already. */
export interface Instruction { text: string; mark: string }

/** The pull request line as an instruction engine is told it. */
export const attributionInstruction = (contract: { instruction: string }, line: string): Instruction => ({ text: fill(contract.instruction, 'line', line), mark: line })

/** The argv that gives an instruction engine [instructions] after the person's own value, in one config value. */
export function instructionsArgsIn(contract: InstructionAttribution, instructions: readonly Instruction[], files: AttributionFiles): string[] {
  return instructions.length ? instructionArgs(contract, instructions, files) : []
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A later file's value over an earlier one's, objects merged key by key: how Claude Code merges its settings files. */
export const merged = (into: unknown, value: unknown): unknown => isRecord(into) && isRecord(value)
  ? { ...into, ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, merged(into[key], child)])) }
  : value

export function jsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    // The engine reports a file it cannot parse and goes on without it; so does this.
    return null
  }
}

function settingArgs(contract: SettingAttribution, line: string, files: AttributionFiles): string[] {
  const paths = [join(files.home, contract.file), ...(files.cwd ? contract.folder.map((name) => join(files.cwd!, name)) : [])]
  let setting: unknown
  let legacy: unknown
  for (const path of paths) {
    const settings = jsonObject(files.read(path))
    if (!settings) continue
    if (Object.hasOwn(settings, contract.key)) setting = merged(setting, settings[contract.key])
    if (contract.legacy && Object.hasOwn(settings, contract.legacy.key)) legacy = settings[contract.legacy.key]
  }
  // Hidden by the person: every line, the pull request's, or every line by the older setting.
  if (setting === false) return []
  const named = isRecord(setting) ? setting : {}
  const text = named[contract.field]
  if (text === '') return []
  if (contract.legacy && legacy === false && !contract.legacy.until.some((field) => named[field] !== undefined)) return []
  const theirs = typeof text === 'string' ? text : contract.own
  if (theirs.includes(line)) return []
  const settings = JSON.stringify({ [contract.key]: { [contract.field]: `${theirs}\n${line}` } })
  return contract.args.map((arg) => fill(arg, 'settings', settings))
}

function instructionArgs(contract: InstructionAttribution, instructions: readonly Instruction[], files: AttributionFiles): string[] {
  const config = join(files.home, contract.file)
  // A folder's own config: the engine reads it over the person's, and `-c` would replace it. Left alone. Looked for
  // up to the home folder, not in it: `~/.codex/config.toml` is the person's own config, not a folder's.
  if (files.cwd) {
    const personal = resolve(files.personal)
    for (let dir = resolve(files.cwd); dir !== personal && dir !== parse(dir).root; dir = dirname(dir)) {
      const path = join(dir, contract.folder)
      if (path === config) continue
      const toml = files.read(path)
      if (toml !== null && topLevelEntry(toml, contract.key).state !== 'absent') return []
    }
  }
  const toml = files.read(config)
  const theirs = toml === null ? { state: 'absent' as const } : topLevelEntry(toml, contract.key)
  if (theirs.state === 'unreadable') return []
  // What their value holds already is not said twice.
  const ours = instructions.filter(({ mark }) => !(theirs.state === 'set' && theirs.value.includes(mark)))
  if (!ours.length) return []
  const instruction = ours.map(({ text }) => text).join('\n\n')
  const value = theirs.state === 'set' && theirs.value ? `${theirs.value}\n\n${instruction}` : instruction
  return contract.args.map((arg) => fill(arg, 'value', JSON.stringify(value)))
}
