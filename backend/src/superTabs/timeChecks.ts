import type { PrismaClient } from '@prisma/client'
import type { SuperTabStore } from './store.js'

export async function timeCheckSwarms(_db: PrismaClient, _now: number): Promise<string[]> { return [] }
export async function runTimeCheckPass(_db: PrismaClient, _store: Pick<SuperTabStore, 'runTimeChecks'>, _now: number) { return { swarms: 0, written: 0, failed: 0 } }
