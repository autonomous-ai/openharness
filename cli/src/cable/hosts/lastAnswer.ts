import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { lastTurnTextFromRawLines } from '../../engines/claude/normalize.js'
import { lastCodexTurnText } from '../../engines/codex/normalizer.js'
import { tailFileCapped } from '../../lib/transcriptTail.js'

export const LAST_ANSWER_MAX_BYTES = 262_144
export const LAST_ANSWER_DEADLINE_MS = 1000

export interface LastAnswerOptions {
  /** The engine's own folders; the caller resolves them (claudeProjectsRoots, codexHomeRoots + 'sessions'). */
  roots: string[]
  maxBytes: number
  deadlineMs: number
  /** Replaces the file read; tests use it to stall. */
  tail?: (path: string, maxBytes: number) => Promise<{ lines: string[] }>
}

async function inside(path: string, roots: string[]): Promise<string | null> {
  let real: string
  try {
    real = await realpath(path)
  } catch {
    return null
  }
  for (const root of roots) {
    let rootReal: string
    try {
      rootReal = await realpath(root)
    } catch {
      continue
    }
    const rel = relative(rootReal, real)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return real
  }
  return null
}

/** The agent's last message of the last turn. A hook can name any path, so only files inside the engine's folders are read. */
export async function readLastAnswer(engine: 'claude' | 'codex', path: string, opts: LastAnswerOptions): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), opts.deadlineMs)
  })
  const work = (async (): Promise<string | undefined> => {
    const real = await inside(path, opts.roots)
    if (!real) return undefined
    const { lines } = await (opts.tail ?? tailFileCapped)(real, opts.maxBytes)
    const turn = engine === 'claude' ? lastTurnTextFromRawLines(lines) : lastCodexTurnText(lines)
    return turn?.assistantText || undefined
  })().catch(() => undefined)
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
