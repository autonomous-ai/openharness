/**
 * Cursor's Task hooks. Cursor's preToolUse hook can beat its transcript, so a Task's start is queued
 * behind a transcript drain, and the sub-agent it starts is registered to be followed.
 *
 * Built on Cursor's first Task hook, from Cursor's own code (engines/inProcess.ts), loaded since the attach of
 * the session the hook belongs to: no other engine's daemon ever builds it. Until then nothing is followed, so
 * there is nothing to wait for, close or stop. Without Cursor's code a Task is not followed.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 12: docs/design/2026-10-03-harnessd.md).
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { PENDING_TASKS_FILE } from '../../engines/cursor/contract.js'
import type { PendingCursorTask } from '../../engines/cursor/pendingTasks.js'
import type { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import type { CursorTaskHookQueue } from '../../engines/cursor/taskHookQueue.js'
import type { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import { engineNow, loadEngine } from '../../engines/inProcess.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { registry } from '../../lib/registry.js'
import type { Watcher } from '../../watcher/watcher.js'

export interface CursorTaskDeps {
  emitSessionEvents: (sessionId: string, events: LiveEvent[]) => void
  watcher: Pick<Watcher, 'pollSession'>
  registry: Pick<typeof registry, 'bySession' | 'resolve'>
  /** The live Cursor normalizers, by session (the normalizer table's). */
  cursorNormalizers: Map<string, CursorNormalizer>
}

export function createCursorTaskHooks({ emitSessionEvents, watcher, registry, cursorNormalizers }: CursorTaskDeps) {
  let built: { cursor: NonNullable<ReturnType<typeof engineNow<'cursor'>>>; subagents: CursorSubagentManager; queue: CursorTaskHookQueue } | null = null
  const build = (): typeof built => {
    if (built) return built
    const cursor = engineNow('cursor', 'a Task hook came')
    if (!cursor) return null
    const subagents = new cursor.CursorSubagentManager(cursor.cursorConfigDir(), emitSessionEvents, cursor.cursorDataDir())
    const queue = new cursor.CursorTaskHookQueue({
      drainTranscript: (sessionId) => watcher.pollSession(sessionId),
      emit: emitSessionEvents,
      register: (sessionId, hook, normalizer) => subagents.register(sessionId, hook, normalizer),
      isActive: (sessionId) => registry.bySession(sessionId)?.engine === 'cursor',
      onError: (sessionId, error) => {
        console.error(`[cursor] Task hook queue failed (${sessionId}):`, error instanceof Error ? error.message : error)
      },
    })
    built = { cursor, subagents, queue }
    return built
  }
  /** What the rest of the core holds of the sub-agents and the queue, before and after they are built. */
  const cursorSubagents: Pick<CursorSubagentManager, 'closeParent' | 'forget' | 'stop'> = {
    closeParent: (parentId, isError) => built?.subagents.closeParent(parentId, isError),
    forget: (parentId) => built?.subagents.forget(parentId),
    stop: () => built?.subagents.stop(),
  }
  const cursorTaskHooks: Pick<CursorTaskHookQueue, 'wait'> = {
    wait: async (sessionId) => built?.queue.wait(sessionId),
  }
  const onCursorTaskStart = (sessionId: string, toolUseId: string, toolInput: unknown): void => {
    const session = registry.resolve(sessionId)
    if (!session || session.engine !== 'cursor') return
    const tasks = build()
    if (!tasks) return
    let normalizer = cursorNormalizers.get(sessionId)
    if (!normalizer) {
      normalizer = new tasks.cursor.CursorNormalizer('live', sessionId)
      cursorNormalizers.set(sessionId, normalizer)
    }
    tasks.queue.enqueue(sessionId, { toolUseId, input: toolInput }, normalizer)
  }
  return { cursorSubagents, cursorTaskHooks, onCursorTaskStart }
}

/**
 * Whether Cursor's hook queued Tasks while no daemon ran, or is queueing one now: the lock it takes to write the
 * queue, or the queue (engines/cursor/contract.ts). Neither is there on a machine whose Cursor never did, and
 * Cursor's code is loaded only when one is: its own read and write of the queue then run as they always did. The
 * lock is looked for first: a hook that takes it, writes the queue and lets go between the two looks leaves the
 * queue for the second.
 */
async function queued(dataDir: string): Promise<boolean> {
  const file = join(dataDir, PENDING_TASKS_FILE)
  for (const path of [`${file}.lock`, file]) {
    try { await access(path); return true } catch { /* not this one */ }
  }
  return false
}

/** The Tasks Cursor's hook queued while no daemon ran, taken at the start. None without Cursor's code. */
export async function loadPendingCursorTasks(dataDir: string): Promise<PendingCursorTask[]> {
  if (!await queued(dataDir)) return []
  const cursor = await loadEngine('cursor')
  return cursor ? cursor.loadCursorPendingTasks(dataDir) : []
}

/** A session's queued Tasks, dropped on its Stop and when it is forgotten. */
export async function removePendingCursorTasks(dataDir: string, sessionId: string): Promise<void> {
  if (!await queued(dataDir)) return
  await (await loadEngine('cursor'))?.removeCursorPendingTasks(dataDir, sessionId)
}
