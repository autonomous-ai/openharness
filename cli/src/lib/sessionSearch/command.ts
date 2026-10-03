/**
 * `harness search <words>` — the session index from a shell: which conversation on this computer
 * said these words, and where. Reads the index the daemon keeps; never contacts it or a machine.
 */

import { join } from 'node:path'

import { MARK_CLOSE, MARK_OPEN, SessionSearchStore } from './store.js'
import { parseSearchWhen } from './when.js'

export const SESSION_SEARCH_FILE = 'session-search.db'

export interface SearchCommandOptions {
  argv: string[]
  dataDir: string
  output: (line: string) => void
  error: (line: string) => void
  /** Bold the matched words (a terminal) or leave them plain (a pipe). */
  color?: boolean
  now?: number
}

const USAGE = 'usage: harness search <words> [last week | yesterday | 3 days ago | on monday …] [--limit N] [--json]'

function age(at: number | null, now: number): string {
  if (at === null) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

function plainSnippet(marked: string): { snippet: string; matches: Array<[number, number]> } {
  let snippet = ''
  const matches: Array<[number, number]> = []
  let open = -1
  for (const char of marked) {
    if (char === MARK_OPEN) open = snippet.length
    else if (char === MARK_CLOSE) {
      if (open >= 0) matches.push([open, snippet.length])
      open = -1
    } else snippet += char
  }
  return { snippet, matches }
}

export function searchCommand(opts: SearchCommandOptions): number {
  const words: string[] = []
  let json = false
  let limit = 10
  for (let index = 0; index < opts.argv.length; index++) {
    const arg = opts.argv[index]
    if (arg === '--json') json = true
    else if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length))
    else if (arg === '--limit') limit = Number(opts.argv[++index])
    else if (arg.startsWith('--')) limit = Number.NaN
    else words.push(arg)
  }
  if (!words.length || !Number.isInteger(limit) || limit < 1) {
    opts.error(USAGE)
    return 2
  }
  // Read-only beside the daemon, which owns the index: this never migrates or deletes it.
  const store = SessionSearchStore.openReader(join(opts.dataDir, SESSION_SEARCH_FILE))
  if (store === 'missing') {
    opts.error('No session index yet. The daemon builds it in the background after `harness start`.')
    return 1
  }
  if (store === 'outdated') {
    opts.error('The session index is from another version of Harness. Restart the daemon (`harness stop`, then `harness start`) to rebuild it.')
    return 1
  }
  if (store === 'busy') {
    opts.error('The session index is busy being written. Try again in a moment.')
    return 1
  }
  if (store === 'unreadable') {
    opts.error('The session index could not be read. The daemon rebuilds it on its next start (`harness stop`, then `harness start`).')
    return 1
  }
  if (!store) {
    opts.error('Session search needs node:sqlite (Node 22.13 or later).')
    return 1
  }
  try {
    const now = opts.now ?? Date.now()
    // "dial last week": the same time phrases Cmd-P reads, as a window.
    const { words: query, when } = parseSearchWhen(words.join(' '), new Date(now))
    const hits = store.search(query, { limit, now, from: when?.from, to: when?.to }).map((hit) => ({
      ...hit,
      name: store.session(hit.sessionId)?.header.split(' · ')[0] ?? hit.sessionId,
    }))
    if (json) {
      // Plain text for scripts, with the matched words as [start, end) ranges rather than the
      // control characters the RPC marks them with.
      opts.output(JSON.stringify({ hits: hits.map(({ snippet, ...hit }) => ({ ...hit, ...plainSnippet(snippet) })) }, null, 2))
      return 0
    }
    if (!hits.length) {
      opts.output(query
        ? `Nothing on this computer mentions ${JSON.stringify(query)}${when ? ` ${when.phrase}` : ''}.`
        : `Nothing on this computer was worked on ${when?.phrase ?? 'then'}.`)
      return 0
    }
    const bold = (text: string) => opts.color
      ? text.replaceAll(MARK_OPEN, '\x1b[1m').replaceAll(MARK_CLOSE, '\x1b[22m')
      : text.replaceAll(MARK_OPEN, '').replaceAll(MARK_CLOSE, '')
    const lead: Record<string, string> = { ask: '> ', tools: '$ ', answer: '  ', name: '  ' }
    for (const hit of hits) {
      opts.output(`${hit.name}  ${[age(hit.at ?? hit.lastAt, now), hit.agentId.slice(0, 8)].filter(Boolean).join(' · ')}`)
      if (hit.field !== 'name') opts.output(`  ${lead[hit.field]}${bold(hit.snippet)}`)
    }
    return 0
  } finally {
    store.close()
  }
}
