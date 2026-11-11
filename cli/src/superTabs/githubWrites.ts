import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'

/**
 * Every write Harness makes to GitHub passes here. Harness writes in its person's name (this computer's gh login), so a loop that
 * repeats itself is a flood under their account, which GitHub can flag and ban (#4055: a reader asked three times in an hour; anh
 * Dee, 2026-11-11: "never spam github as user accounts could be banned"). Each loop says a thing once on its own; this is the
 * backstop for the loop that does not:
 * - a line of Harness's the same as one this computer wrote on the same issue or pull request in the last day is not written again
 *   (its clock left out), and is answered as written: it is there;
 * - at most [TEXTS_PER_MINUTE] texts a minute and [TEXTS_PER_HOUR] an hour go out, under GitHub's own limits on writing (80 a
 *   minute, 500 an hour) with room for an agent cutting thirty pieces off a task at once (githubSplit.ts, two texts each); the
 *   rest wait, answered as GitHub answers a limit, with when to try again.
 * A text is a comment, a review, an issue or a pull request. Labels, merges, branches and statuses write none, and pass: the work
 * needs them, and they flood nobody's notifications.
 */
export const TEXTS_PER_MINUTE = 75
export const TEXTS_PER_HOUR = 200
export const SAME_TEXT_MS = 24 * 60 * 60_000
const MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS
/** Harness's own lines, as every loop signs them (githubAssign.ts, githubMerge.ts, githubTrain.ts). An agent's own words made by
 *  command (a take, a cut) are its own, recorded as made: those its command says once. */
const HARNESS_LINE = /^Harness, \d\d:\d\d\b/

interface Kept { lines: Array<[string, number]>; texts: number[] }

export function gatedWrites(github: { get: GitHubGet; send: GitHubSend }, deps: { file: string; now?: () => number; log?: (line: string) => void }): { get: GitHubGet; send: GitHubSend } {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (line => console.warn(line))
  const said = new Set<string>()
  const once = (line: string) => { if (!said.has(line)) { said.add(line); log(line) } }
  let kept: Kept | null = null
  const load = (): Kept => {
    try {
      const file = JSON.parse(readFileSync(deps.file, 'utf8')) as Partial<Kept>
      return { lines: Array.isArray(file.lines) ? file.lines : [], texts: Array.isArray(file.texts) ? file.texts : [] }
    } catch {
      return { lines: [], texts: [] }
    }
  }
  const save = (state: Kept) => {
    try {
      mkdirSync(dirname(deps.file), { recursive: true })
      writeFileSync(`${deps.file}.tmp`, JSON.stringify(state))
      renameSync(`${deps.file}.tmp`, deps.file)
    } catch (error) {
      // Kept in memory still: only a restart forgets what was written.
      once(`[super-tab] GitHub writes: NOT_SAVED ${String((error as NodeJS.ErrnoException).code)}`)
    }
  }
  const send: GitHubSend = async (method, path, body) => {
    const text = textOf(method, path, body)
    if (text === null) return github.send(method, path, body)
    const state = kept ??= load()
    const at = now()
    state.lines = state.lines.filter(([, when]) => at - when < SAME_TEXT_MS)
    state.texts = state.texts.filter(when => at - when < HOUR_MS)
    const line = HARNESS_LINE.test(text) ? createHash('sha256').update(`${path}\n${text.replace(/\b\d\d:\d\d\b/g, '')}`).digest('hex').slice(0, 32) : null
    if (line && state.lines.some(([key]) => key === line)) {
      once(`[super-tab] GitHub writes: SAME_TEXT ${path}: Harness wrote it there in the last day`)
      return { status: 201, etag: null, body: {}, resetAt: null }
    }
    const minute = state.texts.filter(when => at - when < MINUTE_MS)
    const perMinute = minute.length >= TEXTS_PER_MINUTE
    if (perMinute || state.texts.length >= TEXTS_PER_HOUR) {
      const resetAt = perMinute ? minute[0]! + MINUTE_MS : state.texts[0]! + HOUR_MS
      once(`[super-tab] GitHub writes: LIMIT ${perMinute ? `${TEXTS_PER_MINUTE} a minute` : `${TEXTS_PER_HOUR} an hour`} reached; the rest wait until `
        + `${new Date(resetAt).toISOString().slice(11, 16)} UTC`)
      return limited(resetAt)
    }
    const reply = await github.send(method, path, body)
    if (reply.status < 300) {
      state.texts.push(at)
      // A day's lines at most, as the hourly limit bounds them.
      if (line) state.lines.push([line, at])
      save(state)
    }
    return reply
  }
  return { get: github.get, send }
}

/** What GitHub answers a write past its limits: the callers wait until [resetAt] as they do for GitHub's own (githubRest.ts). */
function limited(resetAt: number): GitHubReply {
  return { status: 429, etag: null, body: { message: 'Harness holds back its writes to GitHub: too many in the last minute or hour.' }, resetAt }
}

/** The text a write puts on GitHub, or null for one that puts none (a label, a merge, a branch, a status, an edit). */
function textOf(method: string, path: string, body: unknown): string | null {
  if (method !== 'POST' || !/\/(comments|reviews)$|\/repos\/[^/]+\/[^/]+\/(issues|pulls)$/.test(path)) return null
  const fields = Object(body) as Record<string, unknown>
  return [fields.title, fields.body].filter((field): field is string => typeof field === 'string').join('\n')
}
