/**
 * Waiting for a paste to reach an engine that takes it as keys, before pressing its Enter (core/input.ts `messageWriter`).
 *
 * Codex on Windows has no paste event: a paste is a stream of key presses, and its burst detector turns an Enter within 120 ms of
 * the last of them into a newline in the paste (codex-rs tui `paste_burst.rs`, on "terminals without bracketed paste"). The stream
 * crosses the pseudo console in its own time, so no fixed wait is right: 2,249 characters given the settle of submitTiming.ts
 * stayed in the composer as "[Pasted Content 2250 chars]", its Enter among them (DESKTOP-0TFH0OJ, 2026-11-05), and every later
 * message waited behind that "draft", for good. What the pane shows is the one thing that knows: the burst shows nothing until it
 * ends, so it has landed once the composer holds something new that two reads in a row agree on.
 */
import type { AgentEngine } from '../engines/types.js'

export const PASTE_POLL_MS = 200
/** The most it waits. Past this the Enter is pressed anyway, as it would have been: a pane that never shows the paste holds nothing. */
export const PASTE_LAND_LIMIT_MS = 8_000

export function pasteComesAsKeys(engine: AgentEngine, platform: NodeJS.Platform = process.platform): boolean {
  return engine === 'codex' && platform === 'win32'
}

/** Whether the paste was seen to land. [before]: the pane as read before the paste: a draft already there is not the paste. */
export async function pasteOnScreen(
  read: () => Promise<{ draft: boolean; screen: string | null }>,
  before: string | null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<boolean> {
  let last: string | null = null
  for (let waited = 0; waited < PASTE_LAND_LIMIT_MS; waited += PASTE_POLL_MS) {
    const now = await read().catch(() => null)
    if (now?.draft && now.screen !== null && now.screen !== before && now.screen === last) return true
    last = now?.screen ?? null
    await sleep(PASTE_POLL_MS)
  }
  return false
}
