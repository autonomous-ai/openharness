/** Test-only: the recorded replies of the Swarm read API (design 2026-10-26-swarm-state-parts section 4), kept as JSON so
 *  the integration group can replay them. Each call returns a fresh copy, so a test may change what it gets. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ReadFixture = 'parts-lead' | 'parts-builder' | 'changes-lead' | 'changes-reload' | 'legacy-tab-lead' | 'legacy-tab-builder'
  | 'host-full' | 'host-changes' | 'host-quiet' | 'list' | 'messages' | 'update-required'

const DIR = join(import.meta.dirname, '.')
export function readFixture<T = Record<string, unknown>>(name: ReadFixture): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as T
}
/** The fixture's tab, people, agents and machine, by role. */
export const FIXTURE = {
  tabId: 'f1a5c0de0000000000000001', removedTabId: 'f1a5c0de0000000000000009', machineId: 'd00000000000000000000001',
  ownerId: '6a0000000000000000000001', collaboratorId: '6a0000000000000000000002',
  leadId: 'a00000000000000000000001', builderId: 'a00000000000000000000002',
  leadHarness: 'b00000000000000000000001', builderHarness: 'b00000000000000000000002',
  leadsGroup: 'c00000000000000000000000', leadGroup: 'c00000000000000000000001', workGroup: 'c00000000000000000000002', doneGroup: 'c00000000000000000000003',
  startId: 'e00000000000000000000002', projectId: '5000000000000000000000aa',
} as const
