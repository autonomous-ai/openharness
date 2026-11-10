import { metrics } from '../lib/metrics.js'
import type { RetiredCommand } from './retired.js'

/** What the last older apps and agents sent for each retired command: the shape its schema had when the command went. A pull
 *  request that retires another command adds its payload here, and the tests of the store and of the route try it. */
export const OLD_PAYLOADS = {
  'process.confirm': { projectId: 'lead', noteId: 'note-3' },
  'project.digest': { projectId: 'lead', time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' },
  'machine.projects': { machineId: 'mac-1', projectIds: ['lead'], askedIn: { conversationId: 'lead', messageId: 'm-1' } },
  'machine.ownAccountWork': { machineId: 'mac-1', allowed: true },
  'machine.access': { machineId: 'mac-1', action: 'add', name: 'Lamp', account: 'own', teammates: true, note: 'connection info in ~/.lamp' },
  'member.status': { status: { text: 'Heads down', emoji: '🎯', until: '2026-11-10T09:00:00.000Z' } },
  'member.timeZone': { timeZone: 'Asia/Ho_Chi_Minh' },
  'member.username': { username: 'minh' },
  'member.name': { name: 'Minh Nguyen' },
} satisfies Record<RetiredCommand, object>

/** How many [type] commands the retired-commands counter holds for [client]. */
export async function counted(type: string, client: string): Promise<number> {
  const line = new RegExp(`^swarm_retired_commands_total\\{type="${type}",client="${client}"\\} (\\d+)$`, 'm').exec(await metrics.registry.metrics())
  return line ? Number(line[1]) : 0
}
