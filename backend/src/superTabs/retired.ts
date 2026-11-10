import { z } from 'zod'

/**
 * Commands of Swarm v1-v3 that v4 no longer has (anh Dee, 2026-11-09). An app, a host or an agent from before v4 may still send
 * one, so each is accepted and answered as ignored instead of refused as unknown. Like `updateRequired` in routes/superTabs.ts,
 * the answer is one constant for everyone and names no Swarm, agent or machine: nothing is read, written or checked, so there is
 * nothing to protect. (A command whose schema and checks stay and which only keeps nothing answers through `ignored()` in
 * commands.ts; it moves here once its payload code goes.)
 *
 * A pull request that removes a command's code adds its type here, with an old payload in retired.test.ts. Delete this file, its
 * schemas in commands.ts, its answer in store.ts and its counter in lib/metrics.ts 30 days after the backend release that carries
 * it, and not before 2026-12-09: `swarm_retired_commands_total` says whether an older client still sends one.
 */
export const RETIRED_COMMANDS = [
  'process.confirm', 'project.digest', 'machine.projects', 'machine.ownAccountWork', 'machine.access',
  'member.status', 'member.timeZone', 'member.username', 'member.name',
  // Decisions (2026-11-10): an agent reaches its person in their 1:1 chat.
  'decision.ask', 'decision.answer',
] as const
export type RetiredCommand = (typeof RETIRED_COMMANDS)[number]

const retired: ReadonlySet<unknown> = new Set(RETIRED_COMMANDS)
export const isRetiredCommand = (type: unknown): type is RetiredCommand => retired.has(type)

/** One schema per type, as every command has. The parse drops whatever else the old client sent: nothing of it is kept or
 *  logged, and the route's body limit bounds it as it does every command. */
export const retiredCommandSchemas = RETIRED_COMMANDS.map(type => z.object({ type: z.literal(type) }))

/** Reads of Swarm v1-v3 that an older Desktop, phone or host still makes, each with the empty answer it takes as "nothing here".
 *  As a retired command's, one constant answer for everyone, whatever Swarm and query it names: nothing is read, so nothing is
 *  shown that the caller may not see. Each goes with this file's commands, not before 2026-12-09. */
export const RETIRED_READS: Readonly<Record<string, object>> = {
  // The daily scorecard (2026-11-09): an older Desktop's Scorecard tab.
  '/api/super-tabs/:tabId/scorecard': { days: [] },
  // Decisions (2026-11-10): an older Desktop's and phone's Decisions, and an older host's or Buddy's own asks.
  '/api/super-tabs/:tabId/decisions': { more: false, decisions: [] },
}

/** What a retired command's result says, where an agent or an older app prints a command's answer. */
export const RETIRED_NOTE = 'Swarm no longer has this. Nothing was done.'

/** A retired command's whole answer: it says it was ignored and changed no part. */
export const retiredAnswer = (): { result: Record<string, unknown>; parts: never[] } => ({ result: { ignored: true, note: RETIRED_NOTE }, parts: [] })

/** No picture is set any more (2026-11-09), but an older Desktop or phone still picks one: `member.avatar` or `agent.avatar` with a
 *  picture, and the upload before it (`POST /api/super-tabs/:tabId/avatars`). Each is refused in these words, which both apps
 *  show where the picture was picked, rather than answered as ignored: an app takes an ok answer for a picture set, and reads
 *  the upload's id out of one. Clearing a picture still clears it (profile.ts), so nobody keeps a photo of themselves they want
 *  gone. The refusals go with the two commands' picture shapes, not before 2026-12-09. */
export const PICTURES_RETIRED = { code: 'AVATARS_RETIRED', status: 410, message: 'Pictures can’t be changed any more.' } as const
