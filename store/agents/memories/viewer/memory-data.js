/**
 * What Sense of Self reads, over this viewer's own routes: the interface the prototypes in
 * docs/research/2026-10-10-memory-brain/memory-data.js were built on, with the same names.
 *
 *   data.load()              → Promise<{ snapshot, asks, asksError, real: true }>
 *   data.search(q)           → Promise<hits>   hit: { at, engine, title, cwd, sessionId, turn, snippet }
 *                              snippet marks matches with \u0002 … \u0003
 *   data.conversation(sessionId, turn) → Promise<{ title, cwd, turns: [{ turn, at, ask, answer }] }>
 *   data.related(memoryId)   → Promise<hits>: conversations about the same thing as a memory
 *   data.refs(line, snapshot) → the memory rows an About You line cites
 *   data.agent(id, snapshot)  → { id, name, color }
 *
 * The snapshot is the one the pane already receives on /events (app.js hands it over with receive());
 * only when none has come yet is /api/state asked. Your messages come from /api/asks, read once and
 * again only after the snapshot counts new ones. Search is /api/search (the daemon's session search,
 * as Cmd-P's); the same question within a snapshot is asked once.
 *
 * Everything in here is untrusted text written by models and people: render it with textContent only.
 */

export const DAY = 86_400_000
const FALLBACK = { amp: '#c9a227', kilo: '#5fb3b3', devin: '#6aa6f8', muse: '#c77dff', agy: '#8bd3a0', commandcode: '#d4a5a5' }
const SEARCHES_KEPT = 8
const count = (snap) => snap?.sessions?.asks ?? 0

/** The memory rows an About You line cites: `claude:short-answers.md` → that note, by file or title. */
export function refs(line, snapshot) {
  const found = []
  for (const ref of line?.refs ?? []) {
    const at = String(ref).indexOf(':')
    if (at < 1) continue
    const who = ref.slice(0, at), file = ref.slice(at + 1).trim()
    if (!file || who === 'asks' || who === 'session') continue
    const base = file.replace(/\.md$/i, '').toLowerCase()
    for (const row of snapshot?.memories ?? []) {
      if (row.agent !== who) continue
      const name = String(row.path ?? '').split('/').pop().replace(/\.md$/i, '').toLowerCase()
      const titled = String(row.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      if (String(row.path ?? '').endsWith('/' + file) || String(row.id).endsWith(file) || name === base || titled === base) found.push(row)
    }
  }
  return [...new Set(found)]
}

/** An agent's name and color; an agent the snapshot does not list still gets a stable color. */
export function agent(id, snapshot) {
  const row = snapshot?.agents?.find((entry) => entry.id === id)
  if (row) return { id, name: row.name, color: row.color }
  return { id, name: id ? id[0].toUpperCase() + id.slice(1) : 'Unknown', color: FALLBACK[id] ?? '#8a8f98' }
}

/**
 * `fallback` is how a snapshot is fetched when /events has not delivered one within `graceMs`; app.js
 * passes its own, so a snapshot read that way still goes through its instance check.
 */
export function createMemoryData({ fetch: get = (...args) => globalThis.fetch(...args), fallback = null, graceMs = 1500 } = {}) {
  let snapshot = null
  let waiting = []
  let asked = null // { count, promise } for the asks read at that many messages
  const searches = new Map() // q → Promise<{ q, hits, error }>, newest last
  const listeners = new Set()
  const read = async (path) => {
    const response = await get(path)
    if (!response.ok) throw new Error(`${path} answered ${response.status}`)
    return response.json()
  }

  /** A snapshot from /events (or /api/state). Views that subscribed hear about it. */
  function receive(next) {
    if (!next || typeof next !== 'object') return
    const before = snapshot
    snapshot = next
    // New messages since the last read: the asks and every remembered search are out of date.
    if (asked && count(next) !== asked.count) asked = null
    if (before && count(before) !== count(next)) searches.clear()
    for (const done of waiting) done(next)
    waiting = []
    if (before) for (const listener of listeners) { try { listener(next) } catch { /* one view's mistake is not the others' */ } }
  }

  // Every load() before the first snapshot shares one wait, and at most one fallback read.
  let pending = null
  function snapshotNow() {
    if (snapshot) return Promise.resolve(snapshot)
    if (pending) return pending
    pending = new Promise((resolve, reject) => {
      waiting.push(resolve)
      setTimeout(() => {
        if (snapshot) return
        const ask = fallback ?? (() => read('/api/state'))
        Promise.resolve().then(ask).then((snap) => { if (!snapshot) receive(snap) }).catch((error) => {
          if (snapshot) return
          waiting = waiting.filter((entry) => entry !== resolve)
          reject(error)
        })
      }, graceMs)
    })
    pending.then(() => { pending = null }, () => { pending = null })
    return pending
  }

  async function asksFor(snap) {
    if (!asked) {
      const promise = read('/api/asks').then((answer) => ({ asks: Array.isArray(answer.asks) ? answer.asks : [], error: answer.error ?? null }))
      asked = { count: count(snap), promise }
      promise.catch(() => { if (asked?.promise === promise) asked = null })
    }
    try { return await asked.promise } catch (error) { return { asks: [], error: error instanceof Error ? error.message : String(error) } }
  }

  async function load() {
    const snap = await snapshotNow()
    const { asks, error } = await asksFor(snap)
    return { snapshot: snap, asks, asksError: error, real: true }
  }

  /** The list's search and the views': one answer per question, `{ q, hits, error }`. */
  function searchAnswer(q) {
    const text = String(q ?? '').trim().slice(0, 200)
    if (!text) return Promise.resolve({ q: text, hits: [], error: null })
    if (searches.has(text)) {
      const kept = searches.get(text)
      searches.delete(text); searches.set(text, kept)
      return kept
    }
    const promise = read(`/api/search?q=${encodeURIComponent(text)}`)
      .then((answer) => ({ q: text, hits: Array.isArray(answer.hits) ? answer.hits : [], error: answer.error ?? null }))
      .catch(() => { searches.delete(text); return { q: text, hits: [], error: 'Search is not available right now.' } })
    searches.set(text, promise)
    while (searches.size > SEARCHES_KEPT) searches.delete(searches.keys().next().value)
    return promise
  }

  /** What was said around where a search found a conversation: { title, cwd, turns: [{ turn, at, ask, answer }] }. */
  async function conversation(sessionId, turn) {
    const params = new URLSearchParams({ sessionId: String(sessionId ?? '') })
    if (Number.isInteger(turn) && turn >= 0) params.set('turn', String(turn))
    try {
      const answer = await read(`/api/conversation?${params}`)
      return { title: answer.title ?? '', cwd: answer.cwd ?? '', turns: Array.isArray(answer.turns) ? answer.turns : [], error: answer.error ?? null }
    } catch (error) { return { title: '', cwd: '', turns: [], error: error instanceof Error ? error.message : String(error) } }
  }

  /** Conversations that talk about the same thing as a memory: its title and description, any word. */
  async function related(id) {
    try { const answer = await read(`/api/related?id=${encodeURIComponent(String(id ?? ''))}`); return Array.isArray(answer.hits) ? answer.hits : [] } catch { return [] }
  }

  return {
    real: true,
    DAY,
    load,
    search: async (q) => (await searchAnswer(q)).hits,
    searchAnswer,
    conversation,
    related,
    refs: (line, snap = snapshot) => refs(line, snap),
    agent: (id, snap = snapshot) => agent(id, snap),
    receive,
    snapshot: () => snapshot,
    /** Called with every snapshot after the first; returns the way to stop listening. */
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

