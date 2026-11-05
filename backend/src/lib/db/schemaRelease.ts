import type { PrismaClient } from '@prisma/client'
import { prisma } from '../prisma.js'
import { ensureProductUsageExpiry } from '../productUsage.js'
import { ensureHarnessSessionExpiry } from '../ssoSession.js'
import { ensureTerminalExpiry } from '../../superTabs/terminal.js'
import { ensureMentionExpiry } from '../../superTabs/mentions.js'
import { ensureReadMarkExpiry } from '../../superTabs/readMarks.js'
import { ensurePartExpiry } from '../../superTabs/sweeps.js'
import { ensureOperationExpiry } from '../../superTabs/operations.js'
import { ensurePushDeviceExpiry } from '../../push/devices.js'
import { ensureSchema, type SchemaTarget } from './migrate.js'

/** What a release's index work left for the worker to do: remove old read marks itself where their expiry was refused. */
export interface SchemaRelease { readMarkExpirySet: boolean }

/** The index work of a release, run by the singleton worker at startup once the legacy unique indexes are gone: the
 *  Prisma schema, then the indexes Prisma cannot describe (expiry, and the keys that must hold before the push). */
export async function releaseSchema(db: PrismaClient = prisma, target: SchemaTarget = {}): Promise<SchemaRelease> {
  // Before the push: an expiry index new to a collection that already exists. Built here, by createIndexes, it has its expiry
  // at once and the push keeps it; built by the push, it would need collMod for its expiry, which production's app user may
  // not run (10-29). The indexes below were made before they were declared, so the push has always found them.
  await ensureOperationExpiry(db)
  await ensurePushDeviceExpiry(db)
  await ensureSchema(target)
  await ensureProductUsageExpiry(db)
  await ensureHarnessSessionExpiry(db)
  await ensureTerminalExpiry(db)
  await ensureMentionExpiry(db)
  const readMarkExpirySet = await ensureReadMarkExpiry(db)
  await ensurePartExpiry(db)
  return { readMarkExpirySet }
}
