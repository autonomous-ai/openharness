import { performance } from 'node:perf_hooks'
import type { PrismaClient } from '@prisma/client'
import type { Reader } from './driver.js'

export interface IsolatedPoll {
  reader: string
  responseBytes: number
  /** What MongoDB sent the backend to answer this one poll, with nothing else running. */
  databaseBytesOut: number
  ms: number
}

/** A raw command's number: plain, or Extended JSON's `$numberLong` / `$numberInt` as Prisma returns some of them. */
export function count(value: unknown): number {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') {
    const wrapped = (value as Record<string, unknown>).$numberLong ?? (value as Record<string, unknown>).$numberInt
    if (wrapped !== undefined) return Number(wrapped)
  }
  throw new Error(`Not a number: ${JSON.stringify(value)}`)
}

/** What MongoDB has sent its clients so far (`serverStatus` network bytes out). */
export async function bytesOut(db: PrismaClient): Promise<number> {
  const status = await db.$runCommandRaw({ serverStatus: 1 }) as { network: { bytesOut: unknown } }
  return count(status.network.bytesOut)
}

/**
 * The cost of one poll alone, after the load: a host's roster reply is small, but today's store loads every Swarm document
 * it names to build it, which only the database's own counter shows. Each reader polls once more, as a client that is
 * already up to date. The status call's own reply is measured and taken off.
 */
export async function isolatedPolls(db: PrismaClient, readers: readonly Reader[]): Promise<IsolatedPoll[]> {
  const before = await bytesOut(db)
  const ownReply = await bytesOut(db) - before
  const polls: IsolatedPoll[] = []
  for (const reader of readers) {
    const start = await bytesOut(db), started = performance.now()
    const reply = await reader.poll()
    const ms = performance.now() - started
    if (reply.code) throw new Error(`Isolated poll of ${reader.label} failed: ${reply.code}`)
    polls.push({ reader: reader.label, responseBytes: reply.bytes, databaseBytesOut: Math.max(0, await bytesOut(db) - start - ownReply), ms })
  }
  return polls
}
