/**
 * The rules core applies to a hook as it arrives, from what an engine declares (facets/hooks.ts
 * `HookContract`). Both run synchronously on the hook server's path, with no engine code and no worker: a
 * hook is how a session binds, and session control never waits on an engine's process.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import type { HookChildRule, HookSession } from '../facets/hooks.js'

/** The most of a transcript read for its first record: the bound of Codex's own rollout reader (codex/rollout.ts). */
const FIRST_RECORD_BYTES = 128 * 1024

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null

/**
 * Whether `file` is a delegated session's transcript: its first record is of the rule's type and carries
 * its child field. Anything unreadable, or a record not of that type, is not a child: the session is
 * admitted as before, and the registry's own checks still apply. Reads one bounded block from the start.
 */
export function isChildSession(file: string, rule: HookChildRule): boolean {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(FIRST_RECORD_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n').find((line) => line.trim())
    if (!firstLine) return false
    const record = object(JSON.parse(firstLine))
    if (record?.type !== rule.type) return false
    let at: unknown = record
    for (const step of rule.child) {
      const container = object(at)
      if (!container) return false
      at = container[step]
    }
    return at !== undefined && at !== null
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

/**
 * `claude --resume` from a folder other than the conversation's own: Claude Code announces a transcript
 * under the CURRENT cwd's project dir, then keeps writing the original file (measured: a resume of
 * 73f090ca from `cli/` announced `…-openharness-cli/73f090ca.jsonl`, and every later turn still landed
 * in `…-openharness/73f090ca.jsonl`). The announced file never appears, the hook is dropped, and the
 * resume is never confirmed — "Start failed" over a pane that is working. The row being resumed already
 * knows the real file; take it when it names this very conversation, by the engine's declared naming.
 */
export function knownTranscript(body: HookSession, agent: HookSession | undefined, sessionFile: { suffix: string }): string | undefined {
  const announced = body.transcriptPath ?? undefined
  if (!announced || existsSync(announced)) return announced
  const known = agent?.transcriptPath
  if (!known || !body.sessionId || agent.sessionId !== body.sessionId) return announced
  if (basename(known) !== `${body.sessionId}${sessionFile.suffix}` || !existsSync(known)) return announced
  return known
}
