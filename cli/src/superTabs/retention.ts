/** A shared contribution belongs to its Super Tab even while no terminal is shown.
 * Keep the last confirmed roster across host/network restarts; only a successful
 * roster read may release it to automatic cleanup. This grants no input access. */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { identifier, object } from './wire.js'

interface Retention { version: 1; machines: Record<string, string[]> }
export const retentionFile = (dataDir: string) => join(dataDir, 'super-tabs', 'retained.json')

function read(file: string): Retention {
  if (!existsSync(file) && !existsSync(`${file}.ready`)) return { version: 1, machines: {} }
  if (statSync(file).size > 4 * 1024 * 1024) throw new Error('Super Tab retention is too large. Automatic cleanup is paused.')
  const value = object(JSON.parse(readFileSync(file, 'utf8')))
  if (value.version !== 1 || !value.machines || typeof value.machines !== 'object' || Array.isArray(value.machines)
    || Object.entries(value.machines).some(([machine, ids]) => !identifier(machine) || !Array.isArray(ids) || !ids.every(identifier))) {
    throw new Error('Super Tab retention is unreadable. Automatic cleanup is paused.')
  }
  return value as unknown as Retention
}

export function retainedHarnesses(dataDir: string): Set<string> {
  return new Set(Object.values(read(retentionFile(dataDir)).machines).flat())
}

export function retainContributions(dataDir: string, machineId: string, rows: unknown[]): void {
  if (!identifier(machineId)) throw new Error('Invalid Super Tab retention machine.')
  const ids = new Set<string>()
  for (const item of rows) {
    const row = object(item), agent = object(row.agent)
    if (!identifier(row.tabId) || !identifier(agent.harnessId) || agent.machineId !== machineId) {
      throw new Error('Invalid Super Tab retention roster.')
    }
    ids.add(agent.harnessId)
  }
  const file = retentionFile(dataDir), previous = read(file)
  const wanted = [...ids].sort()
  if (JSON.stringify(previous.machines[machineId]) === JSON.stringify(wanted)) return
  previous.machines[machineId] = wanted
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.next`, JSON.stringify(previous), { mode: 0o600, flush: true })
  renameSync(`${file}.next`, file)
  if (!existsSync(`${file}.ready`)) writeFileSync(`${file}.ready`, '1', { mode: 0o600, flush: true })
}
