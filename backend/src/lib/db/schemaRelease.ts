import type { PrismaClient } from '@prisma/client'
import { prisma } from '../prisma.js'
import { ensureProductUsageExpiry } from '../productUsage.js'
import { ensureHarnessSessionExpiry } from '../ssoSession.js'
import { ensurePushDeviceExpiry } from '../../push/devices.js'
import { ensureSchema, type SchemaTarget } from './migrate.js'

/** The index work of a release, run by the singleton worker at startup once the legacy unique indexes are gone: the
 *  Prisma schema, then the indexes Prisma cannot describe (expiry, and the keys that must hold before the push). */
export async function releaseSchema(db: PrismaClient = prisma, target: SchemaTarget = {}): Promise<void> {
  // Before the push: an expiry index new to a collection that already exists. Built here, by createIndexes, it has its expiry
  // at once and the push keeps it; built by the push, it would need collMod for its expiry, which production's app user may
  // not run (10-29). The index below was made before it was declared, so the push has always found it.
  await ensurePushDeviceExpiry(db)
  await ensureSchema(target)
  await ensureProductUsageExpiry(db)
  await ensureHarnessSessionExpiry(db)
}
