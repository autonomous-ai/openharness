import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'

/**
 * The phones a person signed in on, by their push tokens (task #2905): where a thread reply or a tag goes while the app is
 * closed (push/send.ts). A token is the person's who registered it last, so a phone signed in as someone else stops hearing
 * the first person's notices; a sign-out drops it, and a token Apple or Google call dead is forgotten.
 */
export type PushPlatform = 'ios' | 'android'
export interface PushDevice { id: string; userId: string; platform: PushPlatform; token: string; sandbox: boolean }

/** Phones kept per person: the ones registered last. A person has a phone or two; ten leaves room for old ones. */
export const PUSH_DEVICES_PER_PERSON = 10
/** A phone that has not opened the app signed in for this long is forgotten (push_device_expiry). */
export const PUSH_DEVICE_EXPIRY_MS = 90 * 24 * 60 * 60_000

/** Made before the schema push (lib/db/schemaRelease.ts), so the push finds it with its expiry and keeps it. */
export async function ensurePushDeviceExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'push_devices', { key: { seenAt: 1 }, name: 'push_device_expiry', expireAfterSeconds: PUSH_DEVICE_EXPIRY_MS / 1000 })
}

/** One row per token, whoever holds it: the token itself is never the key. */
const deviceId = (platform: PushPlatform, token: string) => createHash('sha256').update(`${platform}\n${token}`).digest('hex')

type Row = { _id: string; userId: string; platform: PushPlatform; token: string; sandbox?: boolean; seenAt?: { $date: string } }

/** By the userId index, as a plain $match: Prisma sends `in` as $expr, which no index bounds (backend/AGENTS.md rule 3). */
async function rowsOf(db: PrismaClient, userIds: string[]): Promise<Row[]> {
  return await db.pushDevice.aggregateRaw({ pipeline: [{ $match: { userId: { $in: userIds } } }] }) as unknown as Row[]
}

/** Keeps `device` for `userId`, taking it from whoever had it, and lets go of the person's phones past the newest ten. */
export async function registerPushDevice(db: PrismaClient, userId: string, device: { platform: PushPlatform; token: string }, now: number): Promise<void> {
  const id = deviceId(device.platform, device.token)
  await db.pushDevice.upsert({ where: { id }, create: { id, userId, platform: device.platform, token: device.token, seenAt: new Date(now) },
    update: { userId, seenAt: new Date(now) } })
  const rows = await rowsOf(db, [userId])
  if (rows.length <= PUSH_DEVICES_PER_PERSON) return
  const seen = (row: Row) => Date.parse(row.seenAt?.$date ?? '') || 0
  const old = rows.sort((a, b) => seen(b) - seen(a)).slice(PUSH_DEVICES_PER_PERSON).map(row => row._id)
  // A plain $in by _id: Prisma's `in` goes as $expr, which no index bounds (backend/AGENTS.md rule 3).
  await db.$runCommandRaw({ delete: 'push_devices', deletes: [{ q: { _id: { $in: old }, userId }, limit: 0 }] })
}

/** Removes `device` if it is `userId`'s: false when it is not (another person's phone, or already gone). */
export async function dropPushDevice(db: PrismaClient, userId: string, device: { platform: PushPlatform; token: string }): Promise<boolean> {
  const { count } = await db.pushDevice.deleteMany({ where: { id: deviceId(device.platform, device.token), userId } })
  return count > 0
}

/** The phones of `userIds`, in one read. */
export async function devicesOf(db: PrismaClient, userIds: string[]): Promise<PushDevice[]> {
  if (!userIds.length) return []
  return (await rowsOf(db, userIds)).map(row => ({ id: row._id, userId: row.userId, platform: row.platform, token: row.token, sandbox: row.sandbox === true }))
}

/** A token Apple or Google answered is dead: never sent to again. */
export async function forgetPushDevice(db: PrismaClient, id: string): Promise<void> {
  await db.pushDevice.deleteMany({ where: { id } })
}

/** An iOS token only Apple's sandbox host accepts (push/apns.ts): sent there from now on. */
export async function markSandbox(db: PrismaClient, id: string): Promise<void> {
  await db.pushDevice.updateMany({ where: { id }, data: { sandbox: true } })
}
