import { join } from 'node:path'
import { HERMES_INTERFACE } from '../hermes/contract.js'
import { readYamlSetting } from './yamlSetting.js'

/** Whether [home]'s config sets Hermes to start its TUI. Read each time: a person may change it between two installs. */
export async function hermesHomeIsTui(home: string): Promise<boolean> {
  const value = await readYamlSetting(join(home, HERMES_INTERFACE.file), HERMES_INTERFACE.section, HERMES_INTERFACE.key, HERMES_INTERFACE.maxBytes)
  return value?.trim().toLowerCase() === HERMES_INTERFACE.tui
}

// The homes a record was read in this daemon's life: their Hermes keeps one, whatever its version reads as. At the
// limit the set starts again, and a home is learned again from its next record.
const MAX_RECORD_HOMES = 256
const recordHomes = new Set<string>()

/** True the first time [home] is remembered. */
export function rememberRecordHome(home: string): boolean {
  if (recordHomes.has(home)) return false
  if (recordHomes.size >= MAX_RECORD_HOMES) recordHomes.clear()
  recordHomes.add(home)
  return true
}

export function isRecordHome(home: string): boolean {
  return recordHomes.has(home)
}

export function forgetRecordHomes(): void { recordHomes.clear() }
