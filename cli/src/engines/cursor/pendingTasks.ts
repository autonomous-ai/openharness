import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteJson, jsonArray, readState } from '../../lib/secureState.js'
import { PENDING_TASKS_FILE } from './contract.js'

export interface PendingCursorTask {
  sessionId: string
  toolUseId: string
  input: unknown
  createdAt: number
}

const FILE_NAME = PENDING_TASKS_FILE
const MAX_AGE_MS = 10 * 60_000
const LOCK_RETRIES = 20
const LOCK_RETRY_MS = 25
const LOCK_STALE_MS = 5_000

function valid(raw: unknown): raw is PendingCursorTask {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return typeof value.sessionId === 'string'
    && !!value.sessionId
    && typeof value.toolUseId === 'string'
    && !!value.toolUseId
    && typeof value.createdAt === 'number'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withLock<T>(file: string, operation: () => Promise<T>): Promise<T | null> {
  const lock = `${file}.lock`
  await mkdir(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lock)
      try { return await operation() } finally { await rm(lock, { recursive: true, force: true }) }
    } catch {
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true })
        }
      } catch {
        // lock disappeared
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  return null
}

function read(file: string): PendingCursorTask[] {
  const found = readState(file, 'cache', jsonArray)
  if (found.state !== 'ok') return []
  const now = Date.now()
  return found.value.filter((item): item is PendingCursorTask => valid(item) && now - item.createdAt <= MAX_AGE_MS)
}

export async function loadCursorPendingTasks(dataDir: string): Promise<PendingCursorTask[]> {
  const file = join(dataDir, FILE_NAME)
  return (await withLock(file, async () => {
    const tasks = read(file)
    if (tasks.length) atomicWriteJson(file, tasks, 'cache')
    else await rm(file, { force: true })
    return tasks
  })) ?? []
}

export async function removeCursorPendingTasks(dataDir: string, sessionId: string): Promise<void> {
  const file = join(dataDir, FILE_NAME)
  await withLock(file, async () => {
    const tasks = read(file).filter((task) => task.sessionId !== sessionId)
    if (tasks.length) atomicWriteJson(file, tasks, 'cache')
    else await rm(file, { force: true })
  })
}
