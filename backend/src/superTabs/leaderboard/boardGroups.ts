/**
 * The quiet conversations the leaderboard sums (read.ts recentDormantGroups), as the read cache holds them (cachePatch.ts
 * boardRule): only the fields the board reads, and when the conversation was last active, which keeps the week it counts in.
 * Every open board reads them about once a minute; at prod's scale that was 86,610 documents in 2 h (Ken's scan, 2026-11-04).
 */
import type { Prisma } from '@prisma/client'
import type { GroupData, Part } from '../parts/index.js'
import { groupsBy, quietSince } from '../parts/indexed.js'
import { ms } from '../parts/light.js'

/** What the board reads of a group (stats.ts, record.ts waitsNow) and its read check (projects.ts canReadGroup); the title
 *  names it in a person's details. */
export const BOARD_FIELDS = ['id', 'kind', 'projectId', 'title', 'leadId', 'audience', 'requesterId', 'reviewOf', 'step', 'archived', 'pullRequestUrls', 'ledger',
  'assignment.id', 'assignment.status'] as const

/** The board's fields; the held entry also keeps the group's last activity (`lastActivityAt`), which it is trimmed by. */
const HELD_FIELDS = BOARD_FIELDS

/** The row's indexed `lastActivityAt` column (parts/write.ts), which the window is matched on, not the data's copy. */
const BOARD_GROUP = { _id: 0, key: 1, version: 1, changedAt: 1, ordinal: 1, dormant: 1, lastActivityAt: 1,
  ...Object.fromEntries(HELD_FIELDS.map(field => [`data.${field}`, 1])) }

/** A group's data as Mongo's `$project` of HELD_FIELDS gives it: a field that is absent stays absent, and `assignment` keeps
 *  only its own named fields, and only when it is a document. */
export function boardData(data: GroupData): GroupData {
  const source = data as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const field of HELD_FIELDS) {
    const [top, sub] = field.split('.') as [string, string | undefined]
    const value = source[top]
    if (value === undefined) continue
    if (!sub) { out[top] = value; continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const inner = (value as Record<string, unknown>)[sub]
    if (inner === undefined) continue
    out[top] = { ...(out[top] as Record<string, unknown> | undefined), [sub]: inner }
  }
  return out as unknown as GroupData
}

/** A changed group part as the entry holds it, with the last activity its row is indexed by: the data's, else the write's
 *  time (parts/write.ts extracted). */
export function boardGroup(part: Part<GroupData>): Part<GroupData> {
  const lastActivityAt = part.data!.lastActivityAt ?? new Date(part.changedAt).toISOString()
  return { kind: 'group', key: part.key, version: part.version, changedAt: part.changedAt, ordinal: part.ordinal,
    ...part.dormant ? { dormant: true as const } : {}, data: { ...boardData(part.data!), lastActivityAt } }
}

/** When a held conversation was last active: the time its row is indexed by (parts/write.ts). */
export const lastActive = (data: GroupData): number => data.lastActivityAt ? Date.parse(data.lastActivityAt) : Number.POSITIVE_INFINITY

/** These projects' quiet conversations last active since `floor`, through the project index (parts/indexed.ts), board fields
 *  only. Planned without the index name, this read could take the dormancy index and read every quiet conversation. */
export async function loadBoardGroups(tx: Prisma.TransactionClient, tabId: string, projectIds: string[], floor: number): Promise<Part<GroupData>[]> {
  const rows = await groupsBy(tx, 'project', [{ $match: quietSince(tabId, projectIds, floor) }, { $project: BOARD_GROUP }])
  return rows.map(row => ({ kind: 'group', key: row.key as string, version: row.version as number, changedAt: ms(row.changedAt),
    ordinal: row.ordinal as number, ...row.dormant ? { dormant: true as const } : {},
    data: { ...(row.data ?? {}) as GroupData, lastActivityAt: new Date(ms(row.lastActivityAt)).toISOString() } }))
}

/** The project index's order (parts/indexed.ts `project`): project (none first), then last activity, then key. */
export function indexOrder(a: Part<GroupData>, b: Part<GroupData>): number {
  const pa = a.data!.projectId ?? null, pb = b.data!.projectId ?? null
  if (pa !== pb) return pa === null ? -1 : pb === null ? 1 : pa < pb ? -1 : 1
  const ta = lastActive(a.data!), tb = lastActive(b.data!)
  if (ta !== tb) return ta - tb
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}
