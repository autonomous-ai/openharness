/** Literal launch values are composed once, at the final dispatch boundary. No settings reads or writes. */
import { launchContract } from '../launches.js'
import { fill } from './launchArgs.js'
import type { PreparedLaunchSettings } from './nativeLaunchSettings.js'

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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

/** A settings value of [args] as an object, or null for one that is not (a settings file's path). */
const settingsObject = (value: string | undefined): Record<string, unknown> | null => value === undefined ? null : jsonObject(value)

/** Two settings objects as one, as the engine merges its settings files, and lists (hooks) kept from both. */
const both = (into: unknown, value: unknown): unknown => Array.isArray(into) && Array.isArray(value) ? [...into, ...value]
  : isRecord(into) && isRecord(value) ? { ...into, ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, both(into[key], child)])) }
    : value

/**
 * [args] with every settings object given by [flag] merged into one, where the first was: the engine keeps only the
 * last. Optional status and a caller's own settings stay in their original precedence order. Left as they are when any of them is not an object.
 */
export function joinedSettings(flag: string, args: readonly string[]): string[] {
  const at: number[] = []
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag) at.push(i++)
  if (at.length < 2) return [...args]
  const objects = at.map((i) => settingsObject(args[i + 1]))
  if (objects.some((object) => object === null)) return [...args]
  const one = JSON.stringify(objects.reduce<unknown>((into, object) => both(into, object), {}))
  const skipped = new Set(at.slice(1).flatMap((i) => [i, i + 1]))
  return args.flatMap((arg, i) => i === at[0]! + 1 ? [one] : skipped.has(i) ? [] : [arg])
}

export function joinedInstructions(engine: string, given: readonly string[]): string[] {
  const settings = launchContract(engine)?.statusLine
  const args = settings ? joinedSettings(settings.args[0]!, given) : [...given]
  const told = launchContract(engine)?.harnessInstructions
  if (told?.kind !== 'append') return args
  const flag = told.args[0]
  const texts: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) { texts.push(args[++i]); continue }
    rest.push(args[i])
  }
  return texts.length ? [...rest, flag, texts.join('\n\n')] : rest
}

/** The caller uses this one selected snapshot for both the native command and its terminal argv. */
export function launchSettingsArgs(engine: string, base: readonly string[], prepared?: PreparedLaunchSettings | null): string[] {
  if (!prepared?.current()) return [...base]
  const launch = launchContract(engine), values = prepared.values
  const instructions = launch?.harnessInstructions
  const args: string[] = []
  if (values.instructions !== null && instructions?.kind === 'append') {
    args.push(...instructions.args.map(arg => fill(arg, 'text', values.instructions!)))
  } else if (values.instructions !== null && instructions?.kind === 'config') {
    args.push(...instructions.config.args.map(arg => fill(arg, 'value', JSON.stringify(values.instructions))))
  }
  if (values.settings !== null && launch?.statusLine) args.push(...launch.statusLine.args.map(arg => fill(arg, 'settings', values.settings!)))
  return args.length ? joinedInstructions(engine, [...base, ...args]) : [...base]
}
