import { z } from 'zod'

/**
 * Commands of Swarm v1-v3 that v4 no longer has (anh Dee, 2026-11-09). An app, a host or an agent from before v4 may still send
 * one, so each is accepted and answered as ignored instead of refused as unknown: nothing is read, written or checked, and only
 * its type is kept. A pull request that removes a command's code adds its type here, with an old payload in retired.test.ts.
 * Delete this file, its schemas in commands.ts and its answer in store.ts 30 days after the backend release that carries it, and
 * not before 2026-12-09.
 */
export const RETIRED_COMMANDS = ['process.confirm', 'project.digest'] as const
export type RetiredCommand = (typeof RETIRED_COMMANDS)[number]

const retired: ReadonlySet<unknown> = new Set(RETIRED_COMMANDS)
export const isRetiredCommand = (type: unknown): boolean => retired.has(type)

/** One schema per type, as every command has: whatever else the old client sent is dropped. */
export const retiredCommandSchemas = RETIRED_COMMANDS.map(type => z.object({ type: z.literal(type) }))

/** What a retired command's result says, where an agent or an older app prints a command's answer. */
export const RETIRED_NOTE = 'Swarm no longer has this. Nothing was done.'
