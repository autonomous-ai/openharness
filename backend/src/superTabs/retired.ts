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
export const RETIRED_COMMANDS = ['process.confirm', 'project.digest', 'machine.projects', 'machine.ownAccountWork', 'machine.access'] as const
export type RetiredCommand = (typeof RETIRED_COMMANDS)[number]

const retired: ReadonlySet<unknown> = new Set(RETIRED_COMMANDS)
export const isRetiredCommand = (type: unknown): type is RetiredCommand => retired.has(type)

/** One schema per type, as every command has. The parse drops whatever else the old client sent: nothing of it is kept or
 *  logged, and the route's body limit bounds it as it does every command. */
export const retiredCommandSchemas = RETIRED_COMMANDS.map(type => z.object({ type: z.literal(type) }))

/** What a retired command's result says, where an agent or an older app prints a command's answer. */
export const RETIRED_NOTE = 'Swarm no longer has this. Nothing was done.'

/** A retired command's whole answer: it says it was ignored and changed no part. */
export const retiredAnswer = (): { result: Record<string, unknown>; parts: never[] } => ({ result: { ignored: true, note: RETIRED_NOTE }, parts: [] })
