import { createHash } from 'node:crypto'
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'

/**
 * Every write Harness makes to GitHub passes here. Harness writes in its person's name (this computer's gh login), so a loop that
 * repeats itself is a flood under their account, which GitHub can flag and ban (#4055: a reader asked three times in an hour; anh
 * Dee, 2026-11-11: "never spam github as user accounts could be banned"). Each loop says a thing once on its own; this is the
 * backstop for the loop that does not:
 * - the same line of Harness's on the same issue or pull request goes out [SAME_TEXT_TIMES] times in a day at most (its clock
 *   left out): a task given back to the same builder twice in a day is said twice, and a loop saying it each pass is held;
 * - at most [TEXTS_PER_MINUTE] texts a minute and [TEXTS_PER_HOUR] an hour go out, under GitHub's own limits on writing (80 a
 *   minute, 500 an hour) with room for an agent cutting thirty pieces off a task at once (githubSplit.ts, two texts each).
 * What is held is answered as GitHub answers a limit, with when to try again, which every caller waits on as it does for
 * GitHub's own. A text is a comment, a review, an issue or a pull request. Labels, merges, branches and statuses write none, and
 * pass: the work needs them, and they flood nobody's notifications. What it counts lives as long as the daemon: each loop's own
 * once, read back from GitHub, holds across a restart.
 */
export const TEXTS_PER_MINUTE = 75
export const TEXTS_PER_HOUR = 200
export const SAME_TEXT_TIMES = 2
const MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS, DAY_MS = 24 * HOUR_MS
/** Harness's own lines, as every loop signs them (githubAssign.ts, githubMerge.ts, githubTrain.ts), and the clock they carry.
 *  An agent's own words made by command (a take, a cut) are its own, recorded as made: those its command says once. */
const HARNESS_LINE = /^Harness, \d\d:\d\d\b/

export function gatedWrites(github: { get: GitHubGet; send: GitHubSend }, deps: { now?: () => number; log?: (line: string) => void } = {}): { get: GitHubGet; send: GitHubSend } {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (line => console.warn(line))
  /** When each text went out (or is going), the oldest first; and each line of Harness's, by its key, with when. */
  let texts: Array<{ at: number }> = []
  let lines: Array<{ key: string; at: number }> = []
  /** The holds said in the log, each once: by line, and by the window a limit holds. Cleared with the day's lines. */
  const said = new Set<string>()
  const once = (line: string) => { if (!said.has(line)) { said.add(line); log(line) } }
  const send: GitHubSend = async (method, path, body) => {
    const text = textOf(method, path, body)
    if (text === null) return github.send(method, path, body)
    const at = now()
    texts = texts.filter(text => at - text.at < HOUR_MS)
    if (lines.length && at - lines[0]!.at >= DAY_MS) {
      lines = lines.filter(line => at - line.at < DAY_MS)
      said.clear()
    }
    const key = HARNESS_LINE.test(text) ? createHash('sha256').update(`${path}\n${text.replace(HARNESS_LINE, 'Harness')}`).digest('hex').slice(0, 32) : null
    const same = key ? lines.filter(line => line.key === key) : []
    if (same.length >= SAME_TEXT_TIMES) {
      once(`[super-tab] GitHub writes: SAME_TEXT ${path} ${key}: Harness wrote it there ${SAME_TEXT_TIMES} times in the last day`)
      return limited(same[0]!.at + DAY_MS)
    }
    const minute = texts.filter(text => at - text.at < MINUTE_MS)
    const perMinute = minute.length >= TEXTS_PER_MINUTE
    if (perMinute || texts.length >= TEXTS_PER_HOUR) {
      const resetAt = perMinute ? minute[0]!.at + MINUTE_MS : texts[0]!.at + HOUR_MS
      once(`[super-tab] GitHub writes: LIMIT ${perMinute ? `${TEXTS_PER_MINUTE} a minute` : `${TEXTS_PER_HOUR} an hour`} reached; the rest wait until `
        + `${new Date(resetAt).toISOString().slice(11, 16)} UTC`)
      return limited(resetAt)
    }
    // Counted before it goes, so writes running at once are each counted against the limits; given back if GitHub did not take it.
    const slot = { at }, sent = { key: key ?? '', at }
    texts.push(slot)
    if (key) lines.push(sent)
    const giveBack = () => {
      texts = texts.filter(other => other !== slot)
      lines = lines.filter(line => line !== sent)
    }
    try {
      const reply = await github.send(method, path, body)
      if (reply.status >= 300) giveBack()
      return reply
    } catch (error) {
      giveBack()
      throw error
    }
  }
  return { get: github.get, send }
}

/** What GitHub answers a write past its limits: the callers wait until [resetAt] as they do for GitHub's own (githubRest.ts). */
function limited(resetAt: number): GitHubReply {
  return { status: 429, etag: null, body: { message: 'Harness holds back this write to GitHub: it said this here twice today, or wrote too much in the last minute or hour.' }, resetAt }
}

/** The text a write puts on GitHub, or null for one that puts none (a label, a merge, a branch, a status, an edit). */
function textOf(method: string, path: string, body: unknown): string | null {
  if (method !== 'POST' || !/\/(comments|reviews)$|\/repos\/[^/]+\/[^/]+\/(issues|pulls)$/.test(path)) return null
  const fields = Object(body) as Record<string, unknown>
  return [fields.title, fields.body].filter((field): field is string => typeof field === 'string').join('\n')
}
