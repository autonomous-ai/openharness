import type { PrismaClient } from '@prisma/client'
import { prisma } from '../prisma.js'
import { ensureProductUsageExpiry } from '../productUsage.js'
import { ensureHarnessSessionExpiry } from '../ssoSession.js'
import { ensureTerminalExpiry } from '../../superTabs/terminal.js'
import { ensureMentionExpiry } from '../../superTabs/mentions.js'
import { ensurePartExpiry } from '../../superTabs/sweeps.js'
import { ensureSchema, type SchemaTarget } from './migrate.js'

/** The index work of a release, run by the singleton worker at startup once the legacy unique indexes are gone: the
 *  Prisma schema, then the indexes Prisma cannot describe (expiry, and the keys that must hold before the push). */
export async function releaseSchema(db: PrismaClient = prisma, target: SchemaTarget = {}): Promise<void> {
  await ensureSchema(target)
  await ensureProductUsageExpiry(db)
  await ensureHarnessSessionExpiry(db)
  await ensureTerminalExpiry(db)
  await ensureMentionExpiry(db)
  await ensurePartExpiry(db)
}
