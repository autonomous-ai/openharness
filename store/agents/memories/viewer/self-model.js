/**
 * Sense of Self, without a screen: what the pane draws, worked out from the snapshot and your messages.
 * self.js lays it out and draws it; this file only does the arithmetic, so it runs (and is tested) in
 * Node too. Ported from docs/research/2026-10-10-memory-brain/self.js.
 *
 * Every About You line is a belief, grouped by section. Every memory note is an orb in the lake, in the
 * column of its project, with the beliefs it holds up (memory-data.js refs). Every message you sent is a
 * mote in the mist over the water; an "asks:N" source is sampled from the motes whose words match it.
 *
 * Its text is untrusted (written by models and people); nothing here renders it.
 */

export const DAY = 86_400_000
export const TAU = Math.PI * 2
export const YOU = [196, 218, 255] // the person's own words
export const GOLD = [255, 226, 170]
const SECTION_HUES = [192, 266, 334, 36, 150, 222, 300, 82]

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
export const lerp = (a, b, t) => a + (b - a) * t
export const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3)
export const easeInOut = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
export const frac = (x) => x - Math.floor(x)
export function hash(str) { let h = 2166136261; str = String(str); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
export const h01 = (str) => hash(str) / 4294967296
export function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function gauss(r) { const u = Math.max(1e-6, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }
export function rgbOf(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); const n = m ? parseInt(m[1], 16) : 0x8b8f96; return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
export function hslRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t) => { t = frac(t); return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)]
}
export const mix = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))]
export const css = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
export const hexOf = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')

const STOP = new Set(('the and for with that this from your you are was were have has had not but all any can our out who when ' +
  'where into onto over under than then them they their there these those its about after before again also just only very ' +
  'more most much many some such each every both other others same own off once here even ever still yet nor too will would could ' +
  'should shall may might must does did doing done being been get gets got make makes made like want wants wanted need needs use ' +
  'uses used using one two three four five six seven eight nine ten per via let lets now right way ways thing things time times work ' +
  'works asks ask says said tell told give gives keep keeps going good well yes okay please mostly nearly about alongside while away ' +
  'end new old say goes put set see seen look find its it’s don’t i’m isn’t through without before between them always never').split(/\s+/))
export const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)

export function ago(ms) {
  const d = ms / DAY
  if (d < 1) { const h = Math.round(ms / 3_600_000); return h <= 1 ? 'just now' : `${h}h ago` }
  if (d < 14) return `${Math.round(d)}d ago`
  if (d < 60) return `${Math.round(d / 7)}w ago`
  if (d < 365) return `${Math.round(d / 30)}mo ago`
  return `${(d / 365).toFixed(1)}y ago`
}
export const short = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }
export const clean = (s) => String(s ?? '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim()

/** Eternal Sunshine: old titles lose their letters. */
export function decay(text, loss, seed) {
  if (loss <= 0) return short(text, 30)
  const r = rng(hash(seed))
  let out = ''
  for (const ch of short(text, 30)) out += ch !== ' ' && r() < loss ? ' ' : ch
  return out
}

// ── data → a mind ─────────────────────────────────────────────────────────────────────────────────

/**
 * data: { snapshot, asks } as memory-data.js load() gives them. agent(id, snapshot) → { name, color };
 * refs(line, snapshot) → the memory rows an About You line cites.
 */
export function buildMind(data, { agent, refs }) {
  const snap = data.snapshot || {}
  const mind = { snapshot: snap, asks: (data.asks ?? []).filter((ask) => ask && Number.isFinite(ask.at)), now: snap.observedAt || Date.now(), sections: [], beliefs: [], orbs: [], columns: [], motes: null }
  const lines = (snap.about?.lines ?? []).filter((line) => line && String(line.text ?? '').trim())
  const names = [...new Set(lines.map((l) => l.section || 'About you'))]
  mind.sections = names.map((name, k) => {
    const hue = SECTION_HUES[k % SECTION_HUES.length]
    return { name, k, hue, rgb: hslRgb(hue, 0.8, 0.74), deep: hslRgb(hue, 0.7, 0.58), beliefs: [] }
  })

  // Orbs: every memory note.
  mind.orbs = (snap.memories ?? []).filter((m) => m && m.id).map((m, i) => {
    const ag = agent(m.agent, snap)
    const age = Math.max(0, mind.now - (m.modified || mind.now))
    const ageDays = age / DAY
    return {
      i, m, ag, rgb: rgbOf(ag.color), age, ageDays, fresh: Math.exp(-ageDays / 40),
      r: clamp(4.5 + 2.2 * Math.log10(Math.max(60, m.size || (m.body || '').length || 60) / 60), 4.5, 10),
      beliefs: [], col: null, jx: h01(m.id + 'x'), ph: h01(m.id) * TAU,
      bx: 0, by: 0, by0: 0, x: 0, y: 0, lift: 0, glow: 0, appear: 0, delay: 0, match: -1,
      loss: clamp((ageDays - 21) / 200, 0, 0.42),
      lt: String(m.title ?? '').toLowerCase(), ld: String(m.description ?? '').toLowerCase(),
      lb: String(m.body ?? '').toLowerCase(), lp: String(m.project?.name ?? '').toLowerCase(), la: String(ag.name ?? '').toLowerCase(),
    }
  })
  for (const o of mind.orbs) o.label = decay(String(o.m.title || o.m.path || 'untitled'), o.loss, o.m.id)
  const byId = new Map(mind.orbs.map((o) => [o.m.id, o]))

  // Beliefs: every About You line, with the memories and messages that hold it up.
  mind.beliefs = lines.map((line, idx) => {
    const sec = mind.sections[names.indexOf(line.section || 'About you')]
    const b = { idx, line: (snap.about.lines ?? []).indexOf(line), sec, j: sec.beliefs.length, text: String(line.text ?? ''), mems: [], missing: [], askN: 0, sessions: [], motes: [], quotes: [], threads: [],
      phase: frac(idx * 0.61803398875) * TAU, n: 0, len: 1, pluckT: -99, pluckA: 0, flash: 0, roots: [], v: 1 }
    for (const ref of line.refs ?? []) {
      const at = String(ref).indexOf(':')
      const kind = at < 0 ? String(ref) : String(ref).slice(0, at), name = at < 0 ? '' : String(ref).slice(at + 1)
      if (kind === 'asks') { b.askN += Number(name) || 0; continue }
      if (kind === 'session') { b.sessions.push(name); continue }
      const found = refs({ refs: [ref] }, snap)
      if (!found.length) b.missing.push({ agent: agent(kind, snap), name })
      for (const row of found) { const o = byId.get(row.id); if (o && !b.mems.includes(o)) b.mems.push(o) }
    }
    for (const o of b.mems) o.beliefs.push(b)
    sec.beliefs.push(b)
    return b
  })
  for (const sec of mind.sections) for (const b of sec.beliefs) {
    const n = sec.beliefs.length
    b.v = n === 1 ? 1 : 1 - b.j * (0.6 / (n - 1))
  }

  buildMotes(mind)
  buildColumns(mind)
  for (const b of mind.beliefs) {
    b.weight = b.mems.length + (b.askN || b.sessionAsks ? 1 + Math.log10(1 + (b.askN || b.sessionAsks)) * 0.6 : 0) + b.missing.length * 0.3
    b.threads = [
      ...b.mems.map((o) => ({ kind: 'memory', o })),
      ...(b.askN ? [{ kind: 'asks' }] : []),
      ...b.sessions.map((id) => ({ kind: 'session', id })),
      ...b.missing.map((x) => ({ kind: 'missing', x })),
    ]
  }
  return mind
}

function buildMotes(mind) {
  const asks = mind.asks, N = asks.length
  const M = { n: N, bx: new Float32Array(N), by: new Float32Array(N), ph: new Float32Array(N), a: new Float32Array(N),
    bucket: new Uint8Array(N), lift: new Float32Array(N), match: new Uint8Array(N), col: new Array(N), lower: new Array(N), key: new Map(), bel: new Map(), session: new Map() }
  for (let i = 0; i < N; i++) {
    const ask = asks[i]
    M.lower[i] = String(ask.text ?? '').toLowerCase()
    M.key.set(`${ask.sessionId}#${ask.turn}`, i)
    const list = M.session.get(ask.sessionId)
    if (list) list.push(i); else M.session.set(ask.sessionId, [i])
    const ageDays = Math.max(0, mind.now - (ask.at || mind.now)) / DAY
    const a = 0.12 + 0.5 * Math.exp(-ageDays / 18)
    M.a[i] = a
    M.bucket[i] = a > 0.45 ? 3 : a > 0.32 ? 2 : a > 0.2 ? 1 : 0
    M.ph[i] = h01(ask.sessionId + ':' + ask.turn) * TAU
  }
  for (const list of M.session.values()) list.sort((p, q) => asks[p].turn - asks[q].turn || asks[p].at - asks[q].at)
  mind.motes = M

  // Which messages each belief rests on: its "asks:N" sampled by matching the message text, then by count.
  const df = new Map()
  const stemsOf = (text) => [...new Set(wordsOf(text).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))]
  for (const b of mind.beliefs) {
    b.stems = stemsOf(b.text)
    for (const s of b.stems) if (!df.has(s)) { let c = 0; for (let i = 0; i < N; i++) if (M.lower[i].includes(s)) c++; df.set(s, c) }
  }
  for (const b of mind.beliefs) {
    const chosen = []
    const seen = new Set()
    for (const id of b.sessions) {
      const own = M.session.get(id) ?? []
      b.sessionAsks = (b.sessionAsks || 0) + own.length
      for (const i of own) { if (chosen.length >= 64) break; chosen.push(i); seen.add(i) }
    }
    if (b.askN && N) {
      const idf = b.stems.map((s) => { const c = df.get(s) || 0; return c && c / N < 0.22 ? Math.log(N / (1 + c)) : 0 })
      const scored = []
      for (let i = 0; i < N; i++) {
        let sc = 0
        for (let k = 0; k < b.stems.length; k++) if (idf[k] && M.lower[i].includes(b.stems[k])) sc += idf[k]
        if (sc > 0) scored.push([sc, i])
      }
      scored.sort((p, q) => q[0] - p[0] || asks[q[1]].at - asks[p[1]].at)
      const want = Math.min(b.askN, 56)
      for (const [, i] of scored) { if (chosen.length >= want) break; if (!seen.has(i)) { chosen.push(i); seen.add(i) } }
      // Quotes: the person's own words, short and clearly about this.
      const top = scored.slice(0, 80).map(([sc, i]) => [sc, clean(asks[i].text), i]).filter(([, t]) => t.length >= 6 && t.length <= 120 && !/[{}<>]|```/.test(t))
      top.sort((p, q) => q[0] - p[0] || p[1].length - q[1].length)
      const qs = new Set()
      for (const [, t] of top) { const k = t.toLowerCase(); if (!qs.has(k)) { qs.add(k); b.quotes.push(t) } if (b.quotes.length >= 2) break }
      // Then by count: an even, stable sample of the rest.
      const r = rng(hash(b.text))
      let guard = 0
      while (chosen.length < want && guard++ < want * 30) { const i = Math.floor(r() * N); if (!seen.has(i)) { chosen.push(i); seen.add(i) } }
    }
    b.motes = chosen
    for (const i of chosen) { const list = M.bel.get(i); if (list) list.push(b); else M.bel.set(i, [b]) }
  }
}

/** A folder said the way a project's path is written: `~/code/app`, from `/Users/sam/code/app`. */
const tilde = (path) => String(path ?? '').replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/\/+$/, '')

function buildColumns(mind) {
  const cols = new Map()
  const col = (key, name) => { let c = cols.get(key); if (!c) { c = { key, name, orbs: [], asks: 0 }; cols.set(key, c) } return c }
  for (const o of mind.orbs) { const name = o.m.project?.name; o.col = name ? col('p:' + name, name) : col('*', 'everywhere'); o.col.orbs.push(o) }
  // Messages gather over the project they were said in: its folder, a folder inside it, or one of its
  // worktrees, as the pane's Projects count them; else a folder named like the project.
  const projects = (mind.snapshot.projects ?? []).filter((p) => p && p.name)
  const paths = projects
    .flatMap((p) => [p.key && !String(p.key).startsWith('name:') ? p.key : null, p.path].filter(Boolean).map((path) => ({ name: p.name, path: tilde(path), base: tilde(path).split('/').pop() })))
    .filter((p) => p.path && p.path !== '~')
    .sort((a, b) => b.path.length - a.path.length)
  const placeOf = (cwd) => {
    const c = tilde(cwd)
    if (!c) return null
    for (const p of paths) if (c === p.path || c.startsWith(p.path + '/')) return p.name
    for (const p of paths) if (p.base && c.includes(`/worktrees/${p.base}/`)) return p.name
    const base = c.split('/').filter(Boolean).pop()
    if (base && (cols.has('p:' + base) || projects.some((p) => p.name === base))) return base
    return null
  }
  const M = mind.motes
  const placed = new Map()
  for (let i = 0; i < M.n; i++) {
    const cwd = String(mind.asks[i].cwd || '')
    if (!placed.has(cwd)) placed.set(cwd, placeOf(cwd))
    const name = placed.get(cwd)
    if (name) { const c = col('p:' + name, name); c.asks++; M.col[i] = c } else M.col[i] = null
  }
  mind.columns = [...cols.values()]
  for (const c of mind.columns) c.weight = Math.max(1.3, Math.pow(c.orbs.length, 0.72)) + (c.asks ? 0.5 + Math.log10(1 + c.asks) * 0.4 : 0)
  // Biggest in the middle, smaller ones outward.
  const sorted = [...mind.columns].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
  const left = [], right = []
  sorted.forEach((c, i) => (i % 2 ? left : right).push(c))
  mind.columns = [...left.reverse(), ...right]
}

// ── recall ────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a query stirs: the memories with every word somewhere in them (best first), your messages that
 * say every word (indices into mind.asks), the beliefs whose words match (direct), and every belief
 * they hold up.
 */
export function recallMatch(mind, q) {
  const terms = wordsOf(q)
  const mems = []
  for (const o of mind.orbs) {
    let score = 0, ok = terms.length > 0
    for (const term of terms) {
      let s = 0
      if (o.lt.includes(term)) s += 6
      if (o.ld.includes(term)) s += 3
      if (o.lp.includes(term)) s += 2
      if (o.la.includes(term)) s += 2
      if (o.lb.includes(term)) s += 1
      if (!s) { ok = false; break }
      score += s
    }
    if (ok) mems.push([score + o.fresh, o])
  }
  mems.sort((a, b) => b[0] - a[0])
  const M = mind.motes
  const local = []
  if (terms.length) {
    for (let i = 0; i < M.n; i++) {
      const text = M.lower[i]
      let ok = true
      for (const term of terms) if (!text.includes(term)) { ok = false; break }
      if (ok) local.push(i)
    }
  }
  const beliefs = new Set()
  for (const b of mind.beliefs) { const lt = b.text.toLowerCase(); if (terms.length && terms.every((term) => lt.includes(term))) beliefs.add(b) }
  const direct = [...beliefs]
  for (const [, o] of mems) for (const b of o.beliefs) beliefs.add(b)
  for (const i of local) { const list = M.bel.get(i); if (list) for (const b of list) beliefs.add(b) }
  local.sort((a, b) => mind.asks[b].at - mind.asks[a].at)
  return { terms, mems: mems.map(([, o]) => o), local, beliefs, direct }
}

/** Matches of `terms` in text, marked \u0002 … \u0003 as /api/search marks them. */
export function mark(text, terms) {
  let out = String(text ?? '')
  for (const term of terms) out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `\u0002${m}\u0003`)
  return out
}

/** A window of the message around its first match, with matches marked. */
export function snippetOf(text, terms) {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) { const k = lower.indexOf(term); if (k >= 0 && (at < 0 || k < at)) at = k }
  let out = text
  if (at > 40) { const from = text.lastIndexOf(' ', at - 30); out = '…' + text.slice(from > 0 ? from + 1 : at - 30) }
  return mark(short(out, 150), terms)
}
