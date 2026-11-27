import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'

/**
 * Legacy Swarm push tokens: new registrations are refused, and no sender reads them.
 * Supported older phones can remove their own token; the unchanged TTL expires the rest.
 */
export type PushPlatform = 'ios' | 'android'
/** Kept until every legacy record expires; no schema/index retirement is part of feature removal. */
export const PUSH_DEVICE_EXPIRY_MS = 90 * 24 * 60 * 60_000

/** Made before the schema push (lib/db/schemaRelease.ts), so the push finds it with its expiry and keeps it. */
export async function ensurePushDeviceExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'push_devices', { key: { seenAt: 1 }, name: 'push_device_expiry', expireAfterSeconds: PUSH_DEVICE_EXPIRY_MS / 1000 })
}

/** One row per token, whoever holds it: the token itself is never the key. */
const deviceId = (platform: PushPlatform, token: string) => createHash('sha256').update(`${platform}\n${token}`).digest('hex')

/** Removes `device` if it is `userId`'s: false when it is not (another person's phone, or already gone). */
export async function dropPushDevice(db: PrismaClient, userId: string, device: { platform: PushPlatform; token: string }): Promise<boolean> {
  const { count } = await db.pushDevice.deleteMany({ where: { id: deviceId(device.platform, device.token), userId } })
  return count > 0
}
