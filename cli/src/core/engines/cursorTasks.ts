/**
 * Cursor's Task hooks. Cursor's preToolUse hook can beat its transcript, so a Task's start is queued
 * behind a transcript drain, and the sub-agent it starts is registered to be followed.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 12: docs/design/2026-10-03-harnessd.md).
 */
import { cursorConfigDir, cursorDataDir } from '../../engines/cursor/home.js'
import { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import { CursorTaskHookQueue } from '../../engines/cursor/taskHookQueue.js'
import type { LiveEvent } from '../../lib/normalize.js'
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
  const cursorSubagents = new CursorSubagentManager(cursorConfigDir(), emitSessionEvents, cursorDataDir())
  const cursorTaskHooks = new CursorTaskHookQueue({
    drainTranscript: (sessionId) => watcher.pollSession(sessionId),
    emit: emitSessionEvents,
    register: (sessionId, hook, normalizer) => cursorSubagents.register(sessionId, hook, normalizer),
    isActive: (sessionId) => registry.bySession(sessionId)?.engine === 'cursor',
    onError: (sessionId, error) => {
      console.error(`[cursor] Task hook queue failed (${sessionId}):`, error instanceof Error ? error.message : error)
    },
  })
  const onCursorTaskStart = (sessionId: string, toolUseId: string, toolInput: unknown): void => {
    const session = registry.resolve(sessionId)
    if (!session || session.engine !== 'cursor') return
    let normalizer = cursorNormalizers.get(sessionId)
    if (!normalizer) {
      normalizer = new CursorNormalizer('live', sessionId)
      cursorNormalizers.set(sessionId, normalizer)
    }
    cursorTaskHooks.enqueue(sessionId, { toolUseId, input: toolInput }, normalizer)
  }
  return { cursorSubagents, cursorTaskHooks, onCursorTaskStart }
}
