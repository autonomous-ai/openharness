/*
 * Sense of Self: About You as a luminous structure, held up by the lake of memories below it.
 *
 * Above the water, every About You line is a belief: one strand of light. The strands braid into a trunk
 * and open into one frond per section. Below the water, every memory note is an orb, colored by the agent
 * that wrote it, brighter and nearer the surface when it is new. Threads rise from each orb to the beliefs
 * it holds up (MemoryData.refs), and the person's own messages hang over the water as mist; "asks:N"
 * refs rise out of that mist.
 *
 * Reads MemoryData only and writes nothing. Memory text is written by models: it is rendered with
 * textContent or canvas fillText, never as HTML.
 */
(function () {
  'use strict'

  const DAY = 86_400_000
  const TAU = Math.PI * 2
  const ARRIVE_END = 4.8
  const NA = 18 // points along the trunk
  const NC = 12 // points from where a strand leaves its frond to its bead
  const MAXP = NA + 30 + NC + 2
  const YOU = [196, 218, 255] // the person's own words
  const GOLD = [255, 226, 170]
  const SECTION_HUES = [192, 266, 334, 36, 150, 222, 300, 82]

  const $ = (id) => document.getElementById(id)
  const canvas = $('scene')
  const ctx = canvas.getContext('2d')
  const refl = document.createElement('canvas')
  const rctx = refl.getContext('2d')
  const bloom = document.createElement('canvas')
  const bctx = bloom.getContext('2d')
  // Bloom needs canvas filters; without them, no bloom rather than a blocky one.
  const bloomOk = (() => { try { bctx.filter = 'blur(2px)'; const ok = bctx.filter === 'blur(2px)'; bctx.filter = 'none'; return ok } catch { return false } })()
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  let reduce = motion.matches
  if (motion.addEventListener) motion.addEventListener('change', (e) => { reduce = e.matches })

  // ── small helpers ───────────────────────────────────────────────────────────────────────────────

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const lerp = (a, b, t) => a + (b - a) * t
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3)
  const easeInOut = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
  const frac = (x) => x - Math.floor(x)
  function hash(str) { let h = 2166136261; str = String(str); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
  const h01 = (str) => hash(str) / 4294967296
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function gauss(r) { const u = Math.max(1e-6, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }
  function rgbOf(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); const n = m ? parseInt(m[1], 16) : 0x8b8f96; return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
  function hslRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
    const f = (t) => { t = frac(t); return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)]
  }
  const mix = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))]
  const css = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
  const hexOf = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')

  const STOP = new Set(('the and for with that this from your you are was were have has had not but all any can our out who when ' +
    'where into onto over under than then them they their there these those its about after before again also just only very ' +
    'more most much many some such each every both other others same own off once here even ever still yet nor too will would could ' +
    'should shall may might must does did doing done being been get gets got make makes made like want wants wanted need needs use ' +
    'uses used using one two three four five six seven eight nine ten per via let lets now right way ways thing things time times work ' +
    'works asks ask says said tell told give gives keep keeps going good well yes okay please mostly nearly about alongside while away ' +
    'end new old say goes put set see seen look find its it’s don’t i’m isn’t through without before between them always never').split(/\s+/))
  const wordsOf = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []
  const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)

  function ago(ms) {
    const d = ms / DAY
    if (d < 1) { const h = Math.round(ms / 3_600_000); return h <= 1 ? 'just now' : `${h}h ago` }
    if (d < 14) return `${Math.round(d)}d ago`
    if (d < 60) return `${Math.round(d / 7)}w ago`
    if (d < 365) return `${Math.round(d / 30)}mo ago`
    return `${(d / 365).toFixed(1)}y ago`
  }
  const short = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }
  const clean = (s) => String(s ?? '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim()
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function dot(rgb, kind) { const d = el('span', 'dot' + (kind ? ' ' + kind : '')); d.style.color = hexOf(rgb); return d }

  // Glow sprites: a soft radial light per color, drawn with additive blending.
  const sprites = new Map()
  function sprite(rgb, hard) {
    const key = rgb.join(',') + (hard ? 'h' : 's')
    let c = sprites.get(key)
    if (c) return c
    const n = 64
    c = document.createElement('canvas'); c.width = c.height = n
    const g = c.getContext('2d')
    const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2)
    const w = mix(rgb, [255, 255, 255], 0.72)
    if (hard) {
      grd.addColorStop(0, css(w, 1)); grd.addColorStop(0.12, css(w, 0.95)); grd.addColorStop(0.24, css(rgb, 0.85))
      grd.addColorStop(0.3, css(rgb, 0.32)); grd.addColorStop(0.55, css(rgb, 0.1)); grd.addColorStop(1, css(rgb, 0))
    } else {
      grd.addColorStop(0, css(w, 1)); grd.addColorStop(0.08, css(w, 0.8)); grd.addColorStop(0.22, css(rgb, 0.4))
      grd.addColorStop(0.5, css(rgb, 0.1)); grd.addColorStop(1, css(rgb, 0))
    }
    g.fillStyle = grd; g.fillRect(0, 0, n, n)
    sprites.set(key, c)
    return c
  }

  // A memory orb: a glassy sphere of the agent's color, lit from above, in its own halo.
  const orbSprites = new Map()
  function orbSprite(rgb) {
    const key = rgb.join(',')
    let c = orbSprites.get(key)
    if (c) return c
    const n = 128, h = n / 2, R = n * 0.17
    c = document.createElement('canvas'); c.width = c.height = n
    const g = c.getContext('2d')
    const halo = g.createRadialGradient(h, h, R * 0.6, h, h, h)
    halo.addColorStop(0, css(rgb, 0.42)); halo.addColorStop(0.35, css(rgb, 0.12)); halo.addColorStop(1, css(rgb, 0))
    g.fillStyle = halo; g.fillRect(0, 0, n, n)
    const body = g.createRadialGradient(h - R * 0.35, h - R * 0.4, R * 0.05, h, h, R)
    body.addColorStop(0, css(mix(rgb, [255, 255, 255], 0.85), 1))
    body.addColorStop(0.35, css(mix(rgb, [255, 255, 255], 0.35), 0.95))
    body.addColorStop(0.8, css(rgb, 0.8))
    body.addColorStop(1, css(mix(rgb, [0, 0, 0], 0.3), 0.7))
    g.fillStyle = body; g.beginPath(); g.arc(h, h, R, 0, TAU); g.fill()
    g.strokeStyle = css(mix(rgb, [255, 255, 255], 0.6), 0.45); g.lineWidth = 1.2
    g.beginPath(); g.arc(h, h, R - 0.6, 0, TAU); g.stroke()
    orbSprites.set(key, c)
    return c
  }
  const ORB_K = 1 / 0.17 // sprite size per unit of sphere radius

  // ── state ───────────────────────────────────────────────────────────────────────────────────────

  const S = {
    ready: false, real: false, snapshot: null, asks: [], now: Date.now(),
    sections: [], beliefs: [], orbs: [], columns: [], motes: null,
    view: 'self', sec: 0, bel: 0, thread: -1, orb: -1,
    panel: null, recall: null, sound: false,
    arrival: { t: 0, done: false },
    cam: { y: 0, from: 0, to: 0, t0: 0, dur: 0.001 },
    pulses: [], ripples: [], flakes: [], extra: [],
    time: 0, capRect: null,
  }
  const G = {}
  let DPR = 1
  const fronds = []
  const tmp = new Float32Array(4)

  // ── data → a mind ───────────────────────────────────────────────────────────────────────────────

  function build(data) {
    const snap = data.snapshot
    S.snapshot = snap; S.asks = data.asks ?? []; S.real = data.real
    S.now = snap.observedAt || Date.now()
    const lines = snap.about?.lines ?? []
    const names = [...new Set(lines.map((l) => l.section || 'About you'))]
    S.sections = names.map((name, k) => {
      const hue = SECTION_HUES[k % SECTION_HUES.length]
      return { name, k, hue, rgb: hslRgb(hue, 0.8, 0.74), deep: hslRgb(hue, 0.7, 0.58), beliefs: [] }
    })

    // Orbs: every memory note.
    S.orbs = (snap.memories ?? []).map((m, i) => {
      const ag = MemoryData.agent(m.agent, snap)
      const age = Math.max(0, S.now - (m.modified || S.now))
      const ageDays = age / DAY
      return {
        i, m, ag, rgb: rgbOf(ag.color), age, ageDays, fresh: Math.exp(-ageDays / 40),
        r: clamp(4.5 + 2.2 * Math.log10(Math.max(60, m.size || (m.body || '').length || 60) / 60), 4.5, 10),
        beliefs: [], col: null, jx: h01(m.id + 'x'), ph: h01(m.id) * TAU,
        bx: 0, by: 0, by0: 0, x: 0, y: 0, lift: 0, glow: 0, appear: 0, delay: 0, match: -1,
        loss: clamp((ageDays - 21) / 200, 0, 0.42),
        lt: String(m.title ?? '').toLowerCase(), ld: String(m.description ?? '').toLowerCase(),
        lb: String(m.body ?? '').toLowerCase(), lp: String(m.project?.name ?? '').toLowerCase(), la: ag.name.toLowerCase(),
      }
    })
    for (const o of S.orbs) o.label = decay(String(o.m.title || o.m.path || 'untitled'), o.loss, o.m.id)
    const byId = new Map(S.orbs.map((o) => [o.m.id, o]))

    // Beliefs: every About You line, with the memories and messages that hold it up.
    S.beliefs = lines.map((line, idx) => {
      const sec = S.sections[names.indexOf(line.section || 'About you')]
      const b = { idx, sec, j: sec.beliefs.length, text: String(line.text ?? ''), mems: [], missing: [], askN: 0, sessions: [], motes: [], quotes: [], threads: [],
        phase: frac(idx * 0.61803398875) * TAU, pts: new Float32Array(MAXP * 2), cum: new Float32Array(MAXP), n: 0, len: 1, fork: NA - 1,
        pluckT: -99, pluckA: 0, flash: 0, roots: [], v: 1 }
      for (const ref of line.refs ?? []) {
        const at = String(ref).indexOf(':')
        const kind = at < 0 ? String(ref) : String(ref).slice(0, at), name = at < 0 ? '' : String(ref).slice(at + 1)
        if (kind === 'asks') { b.askN += Number(name) || 0; continue }
        if (kind === 'session') { b.sessions.push(name); continue }
        const found = MemoryData.refs({ refs: [ref] }, snap)
        if (!found.length) b.missing.push({ agent: MemoryData.agent(kind, snap), name })
        for (const row of found) { const o = byId.get(row.id); if (o && !b.mems.includes(o)) b.mems.push(o) }
      }
      for (const o of b.mems) o.beliefs.push(b)
      sec.beliefs.push(b)
      return b
    })
    for (const sec of S.sections) for (const b of sec.beliefs) {
      const n = sec.beliefs.length
      b.v = n === 1 ? 1 : 1 - b.j * (0.6 / (n - 1))
    }

    buildMotes()
    buildColumns()
    for (const b of S.beliefs) {
      b.weight = b.mems.length + (b.askN || b.sessionAsks ? 1 + Math.log10(1 + (b.askN || b.sessionAsks)) * 0.6 : 0) + b.missing.length * 0.3
      b.threads = [
        ...b.mems.map((o) => ({ kind: 'memory', o })),
        ...(b.askN ? [{ kind: 'asks' }] : []),
        ...b.sessions.map((id) => ({ kind: 'session', id })),
        ...b.missing.map((x) => ({ kind: 'missing', x })),
      ]
    }
  }

  // Eternal Sunshine: old titles lose their letters.
  function decay(text, loss, seed) {
    if (loss <= 0) return short(text, 30)
    const r = rng(hash(seed))
    let out = ''
    for (const ch of short(text, 30)) out += ch !== ' ' && r() < loss ? ' ' : ch
    return out
  }

  function buildMotes() {
    const asks = S.asks, N = asks.length
    const M = { n: N, bx: new Float32Array(N), by: new Float32Array(N), ph: new Float32Array(N), a: new Float32Array(N),
      bucket: new Uint8Array(N), lift: new Float32Array(N), match: new Uint8Array(N), col: new Array(N), lower: new Array(N), key: new Map(), bel: new Map() }
    for (let i = 0; i < N; i++) {
      const ask = asks[i]
      M.lower[i] = String(ask.text ?? '').toLowerCase()
      M.key.set(`${ask.sessionId}#${ask.turn}`, i)
      const ageDays = Math.max(0, S.now - (ask.at || S.now)) / DAY
      const a = 0.12 + 0.5 * Math.exp(-ageDays / 18)
      M.a[i] = a
      M.bucket[i] = a > 0.45 ? 3 : a > 0.32 ? 2 : a > 0.2 ? 1 : 0
      M.ph[i] = h01(ask.sessionId + ':' + ask.turn) * TAU
    }
    S.motes = M

    // Which messages each belief rests on: its "asks:N" sampled by matching the message text, then by count.
    const df = new Map()
    const stemsOf = (text) => [...new Set(wordsOf(text).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))]
    for (const b of S.beliefs) {
      b.stems = stemsOf(b.text)
      for (const s of b.stems) if (!df.has(s)) { let c = 0; for (let i = 0; i < N; i++) if (M.lower[i].includes(s)) c++; df.set(s, c) }
    }
    for (const b of S.beliefs) {
      const chosen = []
      const seen = new Set()
      for (const id of b.sessions) {
        let c = 0
        for (let i = 0; i < N; i++) if (asks[i].sessionId === id) { c++; if (chosen.length < 64) { chosen.push(i); seen.add(i) } }
        b.sessionAsks = (b.sessionAsks || 0) + c
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

  function buildColumns() {
    const cols = new Map()
    const col = (key, name) => { let c = cols.get(key); if (!c) { c = { key, name, orbs: [], asks: 0 }; cols.set(key, c) } return c }
    for (const o of S.orbs) { const name = o.m.project?.name; o.col = name ? col('p:' + name, name) : col('*', 'everywhere'); o.col.orbs.push(o) }
    // Messages gather over the project they were said in, when the folder says so.
    const projects = S.snapshot.projects ?? []
    const keyFor = new Map()
    for (const p of projects) {
      for (const k of [p.key, p.path]) if (k) keyFor.set(String(k), p.name)
    }
    const M = S.motes
    for (let i = 0; i < M.n; i++) {
      const cwd = String(S.asks[i].cwd || '')
      let name = cwd ? keyFor.get(cwd) : null
      if (!name && cwd) {
        const base = cwd.split('/').filter(Boolean).pop()
        if (base && (cols.has('p:' + base) || projects.some((p) => p.name === base))) name = base
      }
      if (name) { const c = col('p:' + name, name); c.asks++; M.col[i] = c } else M.col[i] = null
    }
    S.columns = [...cols.values()]
    for (const c of S.columns) c.weight = Math.max(1.3, Math.pow(c.orbs.length, 0.72)) + (c.asks ? 0.5 + Math.log10(1 + c.asks) * 0.4 : 0)
    // Biggest in the middle, smaller ones outward.
    const sorted = [...S.columns].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    const left = [], right = []
    sorted.forEach((c, i) => (i % 2 ? left : right).push(c))
    S.columns = [...left.reverse(), ...right]
  }

  // ── layout ──────────────────────────────────────────────────────────────────────────────────────

  function layout() {
    const W = Math.max(320, innerWidth), H = Math.max(320, innerHeight)
    DPR = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    G.W = W; G.H = H
    G.gutter = clamp(W * 0.03, 16, 44)
    G.capRight = G.gutter + Math.min(W * 0.3, 420)
    G.hz = Math.round(H * 0.6)
    G.treeX = G.capRight + (W - G.capRight) * 0.5
    G.trunkLen = H * 0.2
    const hw = (W - G.capRight) / 2 - 8
    G.L = Math.max(90, Math.min((hw - 128) / 1.07, (G.hz - G.trunkLen - 40) / 1.15))
    const total = S.beliefs.length || 1
    G.trunkR = 5 + Math.min(10, total * 0.36)
    G.lakeTop = G.hz + 44
    G.depth = H * 0.68
    G.lakeCam = G.hz - H * 0.13
    // From above, the whole lake folds into the band under the surface; diving unfolds it.
    G.sqSelf = clamp((H - 40 - G.hz) / (G.lakeTop + G.depth + 8 - G.hz), 0.3, 1)
    G.sq = G.sqSelf
    G.maxAge = Math.max(30, ...S.orbs.map((o) => o.ageDays))

    const n = S.sections.length
    const spread = n > 1 ? (Math.min(144, 38 * (n - 1)) * Math.PI) / 180 : 0
    fronds.length = 0
    for (let k = 0; k < Math.max(1, n); k++) {
      const a = -Math.PI / 2 + (n > 1 ? (k / (n - 1) - 0.5) * spread : 0)
      fronds.push({ a, dx: Math.cos(a), side: Math.cos(a) >= -1e-6 ? -1 : 1, p0: [0, 0], p1: [0, 0], p2: [0, 0], p3: [0, 0], end: [0, 0], T: [0, -1] })
    }

    // Gradients, cached per size.
    G.sky = ctx.createLinearGradient(0, 0, 0, G.hz)
    G.sky.addColorStop(0, '#030407'); G.sky.addColorStop(0.7, '#05060d'); G.sky.addColorStop(1, '#090b1c')
    G.water = ctx.createLinearGradient(0, G.hz, 0, G.hz + G.depth + H * 0.3)
    G.water.addColorStop(0, '#070a1a'); G.water.addColorStop(0.18, '#04060f'); G.water.addColorStop(1, '#010103')
    G.surf = ctx.createLinearGradient(0, 0, W, 0)
    const tx = G.treeX / W
    G.surf.addColorStop(0, 'rgba(140,170,255,0)'); G.surf.addColorStop(clamp(tx - 0.35, 0.01, 0.98), 'rgba(160,185,255,0.25)')
    G.surf.addColorStop(tx, 'rgba(235,240,255,0.85)'); G.surf.addColorStop(clamp(tx + 0.3, tx + 0.01, 0.995), 'rgba(160,185,255,0.25)'); G.surf.addColorStop(1, 'rgba(140,170,255,0)')
    G.ray = ctx.createLinearGradient(0, G.hz, 0, G.hz + G.depth)
    G.ray.addColorStop(0, 'rgba(120,150,255,0.07)'); G.ray.addColorStop(1, 'rgba(120,150,255,0)')
    const cy = G.hz - G.trunkLen - G.L * 0.5
    G.aura = ctx.createRadialGradient(G.treeX, cy, 0, G.treeX, cy, G.L * 1.35)
    G.aura.addColorStop(0, 'rgba(150,175,255,0.10)'); G.aura.addColorStop(0.5, 'rgba(120,120,255,0.035)'); G.aura.addColorStop(1, 'rgba(80,80,200,0)')

    // Thought dust in the sky.
    const r = rng(7)
    G.dust = Array.from({ length: Math.round((W * H) / 9000) }, () => ({ x: r() * W, y: r() * G.hz, s: 0.6 + r() * 1.1, a: 0.05 + r() * 0.16, v: 2 + r() * 6, ph: r() * TAU }))

    layoutLake()
    measureCaption()
  }

  function layoutLake() {
    const margin = Math.max(28, G.gutter)
    const total = G.W - margin * 2
    const sum = S.columns.reduce((s, c) => s + c.weight, 0) || 1
    let x = margin
    for (const c of S.columns) { c.x0 = x; c.w = (total * c.weight) / sum; c.x1 = x + c.w; c.cx = x + c.w / 2; x = c.x1 }
    G.ages = S.orbs.map((o) => o.ageDays).sort((a, b) => a - b)
    for (const o of S.orbs) {
      const c = o.col, pad = Math.min(16, c.w * 0.22)
      o.depthF = depthOf(o.ageDays)
      o.bx = c.x0 + pad + o.jx * Math.max(1, c.w - pad * 2)
      o.by0 = G.lakeTop + o.depthF * G.depth
      o.by = o.by0
    }
    const orbs = S.orbs
    for (let it = 0; it < 70; it++) {
      for (let i = 0; i < orbs.length; i++) for (let j = i + 1; j < orbs.length; j++) {
        const a = orbs[i], b = orbs[j]
        let dx = b.bx - a.bx, dy = b.by - a.by
        const min = a.r + b.r + 16
        const d2 = dx * dx + dy * dy
        if (d2 >= min * min) continue
        let d = Math.sqrt(d2)
        if (d < 0.01) { dx = h01(a.m.id + b.m.id) - 0.5; dy = 0.3; d = Math.hypot(dx, dy) }
        const push = (min - d) / 2, ux = dx / d, uy = dy / d
        a.bx -= ux * push; a.by -= uy * push * 0.7; b.bx += ux * push; b.by += uy * push * 0.7
      }
      for (const o of orbs) { const c = o.col; o.bx = clamp(o.bx, c.x0 + 5, c.x1 - 5); o.by = clamp(o.by, o.by0 - 30, o.by0 + 30) }
    }
    for (const o of orbs) { o.vivid = 1 - o.depthF; o.x = o.bx; o.y = o.by; const dx = o.bx - G.treeX, dy = o.by - G.hz; o.delay = clamp(Math.hypot(dx, dy) / Math.hypot(G.W, G.depth), 0, 1) * 0.9 }

    // The mist: each message a mote over the water, gathered by project, or by conversation when the folder is unknown.
    const M = S.motes
    const r = rng(11)
    for (let i = 0; i < M.n; i++) {
      const c = M.col[i]
      let cx, sp
      if (c) { cx = c.cx; sp = Math.max(14, c.w * 0.26) } else { cx = margin + h01(S.asks[i].sessionId) * total; sp = 22 + h01(S.asks[i].sessionId + 'w') * 26 }
      M.bx[i] = clamp(cx + gauss(r) * sp, 4, G.W - 4)
      const up = -Math.log(Math.max(1e-4, r())) * 11
      M.by[i] = G.hz - up + (r() < 0.22 ? r() * 12 : 0) - 1
    }
  }

  // Depth is time: newest at the surface. Spread by rank so a burst of recent notes does not pile up,
  // blended with the real scale so a month still looks like a month.
  function depthOf(days) {
    const a = G.ages || [], n = a.length
    let p = 0
    if (n > 1) {
      if (days >= a[n - 1]) p = 1
      else if (days > a[0]) {
        let i = 0
        while (i < n - 2 && a[i + 1] <= days) i++
        p = (i + (days - a[i]) / ((a[i + 1] - a[i]) || 1)) / (n - 1)
      }
    }
    return clamp(0.55 * p + 0.45 * Math.sqrt(clamp(days / G.maxAge, 0, 1)), 0, 1)
  }

  // Greedy label placement: skip a label that would overlap one already placed.
  const placed = []
  function claim(x, y, w, h) {
    for (const r of placed) if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) return false
    placed.push([x, y, w, h])
    return true
  }

  function measureCaption() {
    const t = $('cap-text').getBoundingClientRect()
    S.capRect = t.width ? t : null
  }

  // ── the structure, per frame ────────────────────────────────────────────────────────────────────

  function bez(f, v, out) {
    const u = 1 - v, a = u * u * u, b = 3 * u * u * v, c = 3 * u * v * v, d = v * v * v
    out[0] = a * f.p0[0] + b * f.p1[0] + c * f.p2[0] + d * f.p3[0]
    out[1] = a * f.p0[1] + b * f.p1[1] + c * f.p2[1] + d * f.p3[1]
    const da = -3 * u * u, db = 3 * u * u - 6 * u * v, dc = 6 * u * v - 3 * v * v, dd = 3 * v * v
    const tx = da * f.p0[0] + db * f.p1[0] + dc * f.p2[0] + dd * f.p3[0], ty = da * f.p0[1] + db * f.p1[1] + dc * f.p2[1] + dd * f.p3[1]
    const len = Math.hypot(tx, ty) || 1
    out[2] = tx / len; out[3] = ty / len
  }

  function frondsFrame(t) {
    const breathe = reduce ? 0 : Math.sin(t * 0.55)
    const L = G.L * (1 + 0.014 * breathe)
    const fx = G.treeX + (reduce ? 0 : Math.sin(t * 0.37) * 2.2), fy = G.hz - G.trunkLen * (1 + 0.012 * breathe)
    G.fork = [fx, fy]; G.Lnow = L
    for (let k = 0; k < fronds.length; k++) {
      const f = fronds[k]
      const a = f.a + (reduce ? 0 : Math.sin(t * 0.43 + k * 1.7) * 0.022)
      const dx = Math.cos(a), dy = Math.sin(a)
      f.p0[0] = fx; f.p0[1] = fy
      f.p1[0] = fx + dx * L * 0.1; f.p1[1] = fy - L * 0.36
      f.p2[0] = fx + dx * L * 0.72; f.p2[1] = fy + dy * L * 0.72 - L * 0.14
      f.p3[0] = fx + dx * L; f.p3[1] = fy + dy * L
      bez(f, 1, tmp); f.T[0] = tmp[2]; f.T[1] = tmp[3]
    }
  }

  const TWIST = Math.PI * 3.2, TWIST2 = Math.PI * 2.4
  function strandFrame(b, t) {
    const f = fronds[b.sec.k], pts = b.pts, L = G.Lnow
    let n = 0
    const ph = b.phase, R0 = G.trunkR
    // The trunk: every strand braided together, flared where it meets the water.
    const lean = G.W * 0.004
    for (let i = 0; i < NA; i++) {
      const u = i / (NA - 1)
      const cx = lerp(G.treeX, f.p0[0], u) + Math.sin(u * Math.PI) * lean
      const cy = lerp(G.hz, f.p0[1], u)
      const r = R0 * (0.62 + 0.38 * (1 - u) + 0.9 * Math.pow(1 - u, 4))
      pts[n++] = cx + r * Math.sin(ph + u * TWIST + t * 0.15); pts[n++] = cy
    }
    // Along its frond until it leaves.
    const nb = Math.max(3, Math.round(28 * b.v))
    const rf = R0 * 0.62
    for (let i = 1; i <= nb; i++) {
      const v = (b.v * i) / nb
      bez(f, v, tmp)
      const off = rf * (1 - 0.6 * v) * Math.sin(ph + TWIST + v * TWIST2 + t * 0.15)
      pts[n++] = tmp[0] - tmp[3] * off; pts[n++] = tmp[1] + tmp[2] * off
    }
    // Out to its bead.
    bez(f, b.v, tmp)
    const Tx = tmp[2], Ty = tmp[3]
    const Ux = -Ty * f.side, Uy = Tx * f.side
    const qx = pts[n - 2], qy = pts[n - 1]
    let tipx, tipy, cx, cy
    if (b.j === 0) {
      tipx = tmp[0] + Tx * L * 0.12; tipy = tmp[1] + Ty * L * 0.12
      cx = qx + Tx * L * 0.06; cy = qy + Ty * L * 0.06
    } else {
      const side = b.j % 2 ? 1 : -1
      const reach = L * (0.12 + 0.02 * (b.j % 3))
      tipx = tmp[0] + Ux * side * reach + Tx * L * 0.05; tipy = tmp[1] + Uy * side * reach + Ty * L * 0.05
      cx = qx + Tx * L * 0.07; cy = qy + Ty * L * 0.07
    }
    for (let i = 1; i <= NC; i++) {
      const s = i / NC, u = 1 - s
      pts[n++] = u * u * qx + 2 * u * s * cx + s * s * tipx
      pts[n++] = u * u * qy + 2 * u * s * cy + s * s * tipy
    }
    b.n = n / 2
    b.fork = NA - 1
    // Arc length.
    const cum = b.cum
    cum[0] = 0
    for (let i = 1; i < b.n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1])
    b.len = cum[b.n - 1] || 1
    // A plucked strand rings between the fork and its bead.
    const since = t - b.pluckT
    if (b.pluckA > 0 && since < 4 && !reduce) {
      const A = b.pluckA * Math.exp(-since / 0.95)
      if (A > 0.05) {
        const c0 = cum[b.fork], span = b.len - c0 || 1
        const w = TAU * 6.2 * since
        for (let i = 1; i < b.n - 1; i++) {
          let s, amp
          if (i <= b.fork) { s = cum[i] / (c0 || 1); amp = A * 0.12 * Math.sin(Math.PI * s) }
          else { s = (cum[i] - c0) / span; amp = A * (Math.sin(Math.PI * s) * Math.sin(w) + 0.3 * Math.sin(TAU * s) * Math.sin(2.01 * w + 1)) }
          const dx = pts[2 * i + 2] - pts[2 * i - 2], dy = pts[2 * i + 3] - pts[2 * i - 1]
          const dl = Math.hypot(dx, dy) || 1
          pts[2 * i] += (-dy / dl) * amp; pts[2 * i + 1] += (dx / dl) * amp
        }
      }
    }
    b.tip = [pts[2 * b.n - 2], pts[2 * b.n - 1]]
    b.root = [pts[0], pts[1]]
  }

  function pointAt(pts, cum, n, s, out) {
    const target = clamp(s, 0, 1) * cum[n - 1]
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid; else hi = mid }
    const seg = cum[hi] - cum[lo] || 1, k = (target - cum[lo]) / seg
    out[0] = lerp(pts[2 * lo], pts[2 * hi], k); out[1] = lerp(pts[2 * lo + 1], pts[2 * hi + 1], k)
    return hi
  }

  // A smooth stroke through pts from arc length a to b (0..1 of the strand).
  function tracePath(pts, cum, n, a = 0, z = 1) {
    const total = cum[n - 1]
    const A = a * total, Z = z * total
    ctx.beginPath()
    let started = false, px = 0, py = 0
    for (let i = 0; i < n; i++) {
      const c = cum[i]
      if (c < A) continue
      if (!started) {
        if (i > 0) { const k = (A - cum[i - 1]) / ((c - cum[i - 1]) || 1); px = lerp(pts[2 * i - 2], pts[2 * i], k); py = lerp(pts[2 * i - 1], pts[2 * i + 1], k) } else { px = pts[0]; py = pts[1] }
        ctx.moveTo(px, py); started = true
      }
      if (c > Z) {
        const k = (Z - cum[i - 1]) / ((c - cum[i - 1]) || 1)
        ctx.lineTo(lerp(pts[2 * i - 2], pts[2 * i], k), lerp(pts[2 * i - 1], pts[2 * i + 1], k))
        return
      }
      const x = pts[2 * i], y = pts[2 * i + 1]
      ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2)
      px = x; py = y
    }
    if (started) ctx.lineTo(px, py)
  }

  // Threads from an orb up to where its belief meets the water.
  const ROOTN = 16
  function rootFrame(root, b) {
    const o = root.o, pts = root.pts, R = b.root
    const x0 = o.x, y0 = o.y, x3 = R[0], y3 = R[1]
    const depth = Math.max(10, y0 - G.hz)
    const x1 = x0, y1 = y0 - depth * 0.6
    const x2 = lerp(x3, x0, 0.22), y2 = G.hz + depth * 0.2 + 10
    let n = 0
    for (let i = 0; i < ROOTN; i++) {
      const s = i / (ROOTN - 1), u = 1 - s
      pts[n++] = u * u * u * x0 + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3
      pts[n++] = u * u * u * y0 + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3
    }
    const cum = root.cum
    cum[0] = 0
    for (let i = 1; i < ROOTN; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1])
  }

  // ── focus helpers ───────────────────────────────────────────────────────────────────────────────

  const focusedBelief = () => S.sections[S.sec]?.beliefs[S.bel] ?? null
  const focusedOrb = () => (S.orb >= 0 ? S.orbs[S.orb] : null)

  // ── update ──────────────────────────────────────────────────────────────────────────────────────

  function update(dt) {
    const t = S.time
    const c = S.cam
    const p = clamp((t - c.t0) / c.dur, 0, 1)
    c.y = lerp(c.from, c.to, easeInOut(p))

    const A = S.arrival.done ? 99 : S.arrival.t
    const R = S.recall
    const k = 1 - Math.exp(-dt * 5)
    const sq = lerp(G.sqSelf, 1, clamp(c.y / G.lakeCam, 0, 1))
    G.sq = sq
    for (const o of S.orbs) {
      o.appear = smooth((A - 0.35 - o.delay) / 0.7)
      const ys = G.hz + (o.by - G.hz) * sq
      let target = 0
      if (R && o.match >= 0) target = Math.max(0, ys - (G.hz + 24 + Math.min(o.match, 18) * 11))
      if (S.panel && S.panel.o === o) target = Math.max(target, Math.min(40, ys - G.hz - 20))
      o.lift = lerp(o.lift, target, reduce ? 1 : k * 0.8)
      const bob = reduce ? 0 : Math.sin(t * 0.6 + o.ph) * (1 + 2 * o.fresh) * sq
      o.x = o.bx + (reduce ? 0 : Math.sin(t * 0.21 + o.ph * 2) * 1.5)
      o.y = ys - o.lift + bob
      o.glow = Math.max(0, o.glow - dt * 0.9)
    }
    for (const b of S.beliefs) b.flash = Math.max(0, b.flash - dt * 0.8)

    const M = S.motes
    for (let i = 0; i < M.n; i++) {
      const target = R && M.match[i] ? 26 + (M.ph[i] / TAU) * 34 : 0
      M.lift[i] += (target - M.lift[i]) * (reduce ? 1 : k * 0.6)
    }

    // Flakes: old memories crumble at the edges.
    if (!reduce && S.arrival.done) {
      for (const o of S.orbs) {
        if (o.loss <= 0 || S.flakes.length > 240) continue
        if (Math.random() < o.loss * dt * 2.2) {
          const a = Math.random() * TAU
          S.flakes.push({ x: o.x + Math.cos(a) * o.r * 1.1, y: o.y + Math.sin(a) * o.r * 1.1, vx: Math.cos(a) * (3 + Math.random() * 5), vy: -3 - Math.random() * 7, life: 0, max: 2 + Math.random() * 2.5, rgb: o.rgb, s: 0.8 + Math.random() * 0.9 })
        }
      }
    }
    for (let i = S.flakes.length - 1; i >= 0; i--) {
      const f = S.flakes[i]
      f.life += dt; f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.985
      if (f.life > f.max) S.flakes.splice(i, 1)
    }
    for (let i = S.ripples.length - 1; i >= 0; i--) if (t - S.ripples[i].t0 > 2.2) S.ripples.splice(i, 1)

    // Pulses: light running down a plucked strand to its memories, or up from a memory to its beliefs.
    for (let i = S.pulses.length - 1; i >= 0; i--) {
      const P = S.pulses[i], e = t - P.t0
      if (P.kind === 'down') {
        if (!P.hit && e > 0.75 + 0.55) { P.hit = true; for (const o of P.b.mems) o.glow = 1 }
        if (e > 2.4) S.pulses.splice(i, 1)
      } else {
        // Follow the light: the camera rises with it to the belief it reaches.
        if (!P.rose && e > 0.4) { P.rose = true; if (S.view === 'lake' && S.orb === P.o.i && !S.panel) rise(1.0) }
        if (!P.hit && e > 0.55 + 0.75) {
          P.hit = true
          for (const b of P.o.beliefs) { b.flash = 1; b.pluckT = t; b.pluckA = 6; tone(b) }
        }
        if (e > 2.4) S.pulses.splice(i, 1)
      }
    }
  }

  // ── draw ────────────────────────────────────────────────────────────────────────────────────────

  function draw() {
    const { W, H } = G
    const t = S.time
    const A = S.arrival.done ? 99 : S.arrival.t
    const camY = S.cam.y
    const lk = clamp(camY / G.lakeCam, 0, 1)
    const fb = S.arrival.done ? focusedBelief() : null
    const fo = focusedOrb()
    const R = S.recall
    const breath = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.55)

    frondsFrame(reduce ? 0 : t)
    for (const b of S.beliefs) strandFrame(b, reduce ? 0 : t)

    ctx.setTransform(DPR, 0, 0, DPR, 0, -camY * DPR)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    // Sky.
    ctx.fillStyle = G.sky
    ctx.fillRect(0, camY - 2, W, G.hz - camY + 4)

    ctx.globalCompositeOperation = 'lighter'
    // Thought dust.
    ctx.fillStyle = '#c8d4ff'
    for (const d of G.dust) {
      const y = reduce ? d.y : (d.y - t * d.v + G.hz * 10) % G.hz
      if (y < camY - 4) continue
      ctx.globalAlpha = d.a * (0.6 + 0.4 * Math.sin(t * 0.8 + d.ph)) * smooth(A / 1.5)
      ctx.fillRect(d.x, y, d.s, d.s)
    }
    // Aura behind the crown, breathing.
    const crownIn = smooth((A - 2.4) / 1.6)
    ctx.globalAlpha = (0.55 + 0.45 * breath) * crownIn
    ctx.fillStyle = G.aura
    ctx.fillRect(G.treeX - G.L * 1.4, G.hz - G.trunkLen - G.L * 1.9, G.L * 2.8, G.L * 2.8)

    drawStructure(t, A, fb, R, breath)

    // Copy the band above the water for the reflection, then the water itself.
    const hzS = G.hz - camY
    const RH = Math.min(hzS - 2, H * 0.42)
    let reflOk = false
    if (RH > 20) {
      const sc = 0.5 * DPR
      const rw = Math.max(1, Math.ceil(W * sc)), rh = Math.max(1, Math.ceil(RH * sc))
      if (refl.width !== rw || refl.height !== rh) { refl.width = rw; refl.height = rh }
      rctx.globalCompositeOperation = 'copy'
      rctx.drawImage(canvas, 0, Math.max(0, Math.round((hzS - RH) * DPR)), Math.round(W * DPR), Math.round(RH * DPR), 0, 0, rw, rh)
      reflOk = true
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = G.water
    ctx.fillRect(0, G.hz, W, camY + H - G.hz + 2)
    ctx.globalCompositeOperation = 'lighter'
    if (reflOk) drawReflection(t, lk, hzS, RH, A)
    ctx.setTransform(DPR, 0, 0, DPR, 0, -camY * DPR)

    drawWater(t, A, lk)
    drawRoots(t, A, fb, fo, R)
    drawOrbs(t, A, fb, fo, R, lk)
    drawMist(t, A, fb, R)
    drawPulses(t)
    drawLakeLabels(t, lk, fo, R)
    drawLeader(t, A, fb, lk)

    // Bloom: a blurred, smaller copy of the light, added back.
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    if (bloomOk) {
      const bw = Math.ceil(W / 3), bh = Math.ceil(H / 3)
      if (bloom.width !== bw || bloom.height !== bh) { bloom.width = bw; bloom.height = bh }
      bctx.globalCompositeOperation = 'source-over'
      bctx.filter = 'none'
      bctx.clearRect(0, 0, bw, bh)
      bctx.filter = 'blur(4px)'
      bctx.drawImage(canvas, 0, 0, bw, bh)
      bctx.filter = 'none'
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.75
      ctx.drawImage(bloom, 0, 0, W, H)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    positionOrbLabel()
  }

  function strandColor(b, fb, R) {
    if (fb === b && !R) return mix(b.sec.rgb, GOLD, 0.65)
    if (R && R.beliefs.has(b)) return mix(b.sec.rgb, GOLD, 0.5)
    return b.sec.rgb
  }

  function strandAlpha(b, fb, R, t) {
    let a = 0.2 + 0.06 * Math.min(5, b.weight)
    if (R) {
      if (R.beliefs.has(b)) a = 0.75 + 0.25 * Math.sin(t * 4 + b.idx)
      else a *= 0.35
    } else if (S.view === 'lake' && focusedOrb()) {
      a *= focusedOrb().beliefs.includes(b) ? 2.6 : 0.6
    } else if (fb) {
      if (b === fb) a = 1
      else a *= b.sec === fb.sec ? 0.85 : 0.6
    }
    return clamp(a + b.flash * 0.6, 0, 1)
  }

  function drawStructure(t, A, fb, R, breath) {
    if (!S.beliefs.length) return
    const L = G.Lnow
    // A soft core of light up the trunk.
    const grow0 = smooth((A - 1.7) / 1.4)
    ctx.globalAlpha = 0.05 * grow0 * (0.7 + 0.3 * breath)
    ctx.strokeStyle = '#dfe6ff'
    ctx.lineWidth = G.trunkR * 2 + 18
    ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(G.treeX, G.hz); ctx.quadraticCurveTo(G.treeX + G.W * 0.004, G.hz - G.trunkLen * 0.5, G.fork[0], G.fork[1]); ctx.stroke()

    for (const b of S.beliefs) {
      const grow = S.arrival.done ? 1 : easeOut((A - 1.7 - b.idx * 0.05) / 1.5)
      b.grow = grow
      if (grow <= 0) continue
      const rgb = strandColor(b, fb, R)
      const a = strandAlpha(b, fb, R, t) * (0.85 + 0.15 * breath)
      const lit = b === fb && !R
      tracePath(b.pts, b.cum, b.n, 0, grow)
      ctx.strokeStyle = css(rgb, 1)
      ctx.globalAlpha = a * 0.09; ctx.lineWidth = lit ? 10 : 7; ctx.stroke()
      ctx.globalAlpha = a * 0.26; ctx.lineWidth = lit ? 3.2 : 2.2; ctx.stroke()
      ctx.globalAlpha = Math.min(1, a * (lit ? 1 : 0.85)); ctx.lineWidth = lit ? 1.4 : 0.9; ctx.stroke()
      // While it grows, a needle of light weaves it.
      if (grow < 1) {
        pointAt(b.pts, b.cum, b.n, grow, tmp)
        ctx.globalAlpha = 0.9
        const sp = sprite(mix(rgb, [255, 255, 255], 0.4), false)
        ctx.drawImage(sp, tmp[0] - 9, tmp[1] - 9, 18, 18)
      }
    }

    // Sparks climbing every strand: memories sending up the belief.
    if (S.arrival.done && !reduce) {
      for (const b of S.beliefs) {
        const count = 2 + Math.min(5, Math.round(b.weight))
        const sp = sprite(strandColor(b, fb, R), false)
        const a0 = strandAlpha(b, fb, R, t)
        for (let c = 0; c < count; c++) {
          const s = frac(t * (0.05 + 0.012 * (c % 3)) + c / count + b.phase)
          pointAt(b.pts, b.cum, b.n, s, tmp)
          ctx.globalAlpha = Math.min(1, a0 * 0.9) * Math.sin(Math.PI * s)
          const z = b === fb ? 9 : 6
          ctx.drawImage(sp, tmp[0] - z / 2, tmp[1] - z / 2, z, z)
        }
      }
    }

    // Beads: where each belief is held.
    for (const b of S.beliefs) {
      const start = 1.7 + b.idx * 0.05 + 1.5
      const bloom = S.arrival.done ? 1 : smooth((A - start + 0.25) / 0.4)
      if (bloom <= 0) continue
      const pop = S.arrival.done ? 0 : Math.max(0, Math.sin(Math.PI * clamp((A - start + 0.25) / 0.5, 0, 1))) * 0.8
      const lit = b === fb && !R
      const pulse = R && R.beliefs.has(b) ? 0.5 + 0.5 * Math.sin(t * 4 + b.idx) : 0
      const rgb = strandColor(b, fb, R)
      const base = 7 + Math.min(8, b.weight * 1.9)
      const z = (base * (lit ? 1.7 : 1) + pulse * 6 + b.flash * 14 + pop * 14) * bloom
      ctx.globalAlpha = clamp(strandAlpha(b, fb, R, t) + 0.25, 0, 1)
      ctx.drawImage(sprite(rgb, true), b.tip[0] - z, b.tip[1] - z, z * 2, z * 2)
      if (lit) {
        // A lens flare across the focused bead.
        const fl = 0.35 + 0.15 * Math.sin(t * 2.1)
        const g = ctx.createLinearGradient(b.tip[0] - 90, 0, b.tip[0] + 90, 0)
        g.addColorStop(0, 'rgba(255,230,180,0)'); g.addColorStop(0.5, `rgba(255,236,200,${fl})`); g.addColorStop(1, 'rgba(255,230,180,0)')
        ctx.globalAlpha = 1; ctx.fillStyle = g
        ctx.fillRect(b.tip[0] - 90, b.tip[1] - 0.6, 180, 1.2)
        ctx.strokeStyle = css(GOLD, 0.5); ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(b.tip[0], b.tip[1], 13 + 2 * Math.sin(t * 2.4), 0, TAU); ctx.stroke()
      }
    }

    // Section names, beyond each frond.
    const labelsIn = S.arrival.done ? 1 : smooth((A - 3.4) / 0.7)
    if (labelsIn > 0) {
      ctx.font = '500 10.5px ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px'
      for (const sec of S.sections) {
        const f = fronds[sec.k]
        const b0 = sec.beliefs[0]
        if (!b0 || !b0.tip) continue
        const ax = b0.tip[0] + f.T[0] * 24, ay = b0.tip[1] + f.T[1] * 22
        const isF = fb && fb.sec === sec
        ctx.globalAlpha = labelsIn * (isF ? 0.95 : 0.5)
        ctx.fillStyle = css(isF ? mix(sec.rgb, [255, 255, 255], 0.35) : sec.rgb)
        ctx.textAlign = f.T[0] < -0.35 ? 'right' : f.T[0] > 0.35 ? 'left' : 'center'
        const lines = wrapLabel(sec.name.toUpperCase(), 14)
        const dy = f.T[1] < -0.5 ? -(lines.length - 1) * 13 - 2 : f.T[1] > 0.3 ? 10 : -((lines.length - 1) * 13) / 2 + 4
        const wmax = Math.max(...lines.map((line) => ctx.measureText(line).width))
        const left = ctx.textAlign === 'right' ? ax - wmax : ctx.textAlign === 'center' ? ax - wmax / 2 : ax
        const shift = left < 8 ? 8 - left : left + wmax > G.W - 10 ? G.W - 10 - (left + wmax) : 0
        lines.forEach((line, i) => ctx.fillText(line, ax + shift, ay + dy + i * 13))
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
      ctx.textAlign = 'left'
    }
  }

  function wrapLabel(text, max) {
    if (text.length <= max) return [text]
    const words = text.match(/\([^)]*\)|\S+/g) ?? [text]
    const lines = ['']
    for (const w of words) {
      const cur = lines[lines.length - 1]
      if (cur && (cur + ' ' + w).length > max && lines.length < 3) lines.push(w)
      else lines[lines.length - 1] = cur ? cur + ' ' + w : w
    }
    return lines
  }

  function drawReflection(t, lk, hzS, RH, A) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    const sc = 0.5 * DPR
    const squash = 0.6, total = RH * squash, step = 3
    const rw = refl.width
    const base = 0.3 * (1 - lk * 0.85) * smooth(A / 2)
    for (let y = 0; y < total && hzS + y < G.H; y += step) {
      const srcY = (RH - (y + step) / squash) * sc
      if (srcY < 0) break
      const srcH = Math.max(1, (step / squash) * sc)
      const fade = 1 - y / total
      ctx.globalAlpha = base * fade * fade
      const dx = reduce ? 0 : Math.sin(y * 0.09 + t * 1.3) * (0.6 + y * 0.045) + Math.sin(y * 0.031 - t * 0.7) * 1.4
      ctx.drawImage(refl, 0, srcY, rw, srcH, dx, hzS + y, G.W, step + 0.6)
    }
  }

  function drawWater(t, A, lk) {
    const W = G.W, hz = G.hz
    // Light from above, falling through the water.
    ctx.fillStyle = G.ray
    for (let i = 0; i < 6; i++) {
      const x = W * (0.08 + i * 0.17) + (reduce ? 0 : Math.sin(t * 0.07 + i * 2.1) * 40)
      const w0 = 18 + i * 6, w1 = 120 + i * 18, len = G.depth * 0.95, slant = 70
      const a = (0.55 + 0.45 * Math.sin(t * 0.21 + i * 1.3)) * (0.3 + 0.7 * lk) * smooth(A / 1.2)
      for (const k of [0.45, 0.8, 1.2]) {
        ctx.globalAlpha = a * 0.4
        ctx.beginPath(); ctx.moveTo(x - w0 * k, hz); ctx.lineTo(x + w0 * k, hz); ctx.lineTo(x + w1 * k + slant, hz + len); ctx.lineTo(x - w1 * k + slant, hz + len); ctx.closePath(); ctx.fill()
      }
    }
    // The surface, opening out from where the trunk meets it.
    const open = S.arrival.done ? 1 : easeOut(A / 0.9)
    const x0 = G.treeX - open * W, x1 = G.treeX + open * W
    ctx.fillStyle = G.surf
    ctx.globalAlpha = 0.85; ctx.fillRect(Math.max(0, x0), hz - 0.5, Math.min(W, x1) - Math.max(0, x0), 1)
    ctx.globalAlpha = 0.16; ctx.fillRect(Math.max(0, x0), hz - 3, Math.min(W, x1) - Math.max(0, x0), 6)
    // Glints.
    ctx.fillStyle = '#e8eeff'
    for (let i = 0; i < 26; i++) {
      const x = (i * 97.3 + (reduce ? 0 : t * (6 + (i % 4) * 5))) % W
      if (x < x0 || x > x1) continue
      ctx.globalAlpha = 0.25 * Math.max(0, Math.sin(t * 1.7 + i * 2.3))
      ctx.fillRect(x, hz - 0.5 + (i % 3), 6 + (i % 5) * 3, 0.8)
    }
    // Ripples from a dive.
    for (const r of S.ripples) {
      const e = (t - r.t0) / 2.2
      for (let k = 0; k < 3; k++) {
        const ek = e - k * 0.12
        if (ek <= 0) continue
        ctx.globalAlpha = 0.5 * (1 - ek) * (1 - k * 0.3)
        ctx.strokeStyle = '#dfe8ff'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.ellipse(r.x, hz, 12 + ek * 340, 2 + ek * 30, 0, 0, TAU); ctx.stroke()
      }
    }
  }

  function drawRoots(t, A, fb, fo, R) {
    const rootIn = S.arrival.done ? 1 : easeOut((A - 0.9) / 1.0)
    if (rootIn <= 0) return
    ctx.lineCap = 'round'
    for (const b of S.beliefs) {
      if (b.roots.length !== b.mems.length) b.roots = b.mems.map((o) => ({ o, pts: new Float32Array(ROOTN * 2), cum: new Float32Array(ROOTN) }))
      for (const root of b.roots) {
        rootFrame(root, b)
        const o = root.o
        let a = 0.09 + 0.05 * o.fresh, lit = false
        if (R) { a = R.beliefs.has(b) || o.match >= 0 ? 0.32 + 0.2 * Math.sin(t * 4 + b.idx) : 0.03 }
        else if (S.view === 'lake' && fo) { lit = fo === o; a = lit ? 0.75 : 0.05 }
        else if (fb) { lit = fb === b; a = lit ? 0.7 : 0.06 }
        if (lit) {
          const sel = S.thread >= 0 && fb && fb.threads[S.thread]?.o === o
          if (S.view === 'self' && S.thread >= 0 && !sel) a *= 0.55
        }
        a *= o.appear
        tracePath(root.pts, root.cum, ROOTN, 0, rootIn)
        ctx.strokeStyle = css(mix(o.rgb, [255, 255, 255], lit ? 0.25 : 0.1))
        if (lit) { ctx.globalAlpha = a * 0.18; ctx.lineWidth = 5; ctx.stroke() }
        ctx.globalAlpha = a; ctx.lineWidth = lit ? 1.2 : 0.8; ctx.stroke()
        if (lit && !reduce) {
          // Light climbing the thread.
          const sp = sprite(o.rgb, false)
          for (let c = 0; c < 3; c++) {
            const s = frac(t * 0.35 + c / 3 + o.ph)
            pointAt(root.pts, root.cum, ROOTN, s, tmp)
            ctx.globalAlpha = 0.8 * Math.sin(Math.PI * s)
            ctx.drawImage(sp, tmp[0] - 5, tmp[1] - 5, 10, 10)
          }
        }
      }
    }
  }

  function drawOrbs(t, A, fb, fo, R, lk) {
    const sel = recallSelection()
    for (const o of S.orbs) {
      if (o.appear <= 0) continue
      let a = (0.28 + 0.72 * Math.pow(o.vivid, 1.3)) * o.appear
      let z = o.r * lerp(0.78, 1, lk) * (0.82 + 0.28 * o.vivid)
      const heldByFocus = fb && !R && S.view === 'self' && fb.mems.includes(o)
      if (R) a *= o.match >= 0 ? 1.25 : 0.2
      else if (S.view === 'self' && fb) a *= heldByFocus ? 1.5 : 0.75
      if (heldByFocus) z *= 1.25
      if (fo === o && S.view === 'lake') { z *= 1.45; a = 1 }
      if (sel && sel.o === o) { z *= 1.5; a = 1 }
      z *= 1 + o.glow * 0.8
      a = clamp(a + o.glow * 0.6, 0, 1)
      const d = z * ORB_K
      ctx.globalAlpha = a
      ctx.drawImage(orbSprite(o.rgb), o.x - d / 2, o.y - d / 2, d, d)
      // Core memories, which hold up a belief, wear a faint ring.
      if (o.beliefs.length) {
        ctx.globalAlpha = a * 0.35
        ctx.strokeStyle = css(mix(o.rgb, [255, 255, 255], 0.4))
        ctx.lineWidth = 0.8
        ctx.beginPath(); ctx.arc(o.x, o.y, z * 1.75, 0, TAU); ctx.stroke()
      }
      // Old ones crack at the edge.
      if (o.loss > 0.08) {
        ctx.globalAlpha = a * 0.3
        ctx.strokeStyle = css(o.rgb)
        ctx.lineWidth = 0.7
        ctx.setLineDash([1.5, 3 + o.loss * 8])
        ctx.beginPath(); ctx.arc(o.x, o.y, z * 1.35, o.ph, o.ph + TAU); ctx.stroke()
        ctx.setLineDash([])
      }
      if ((fo === o && S.view === 'lake') || (sel && sel.o === o)) {
        ctx.globalAlpha = 0.7
        ctx.strokeStyle = css(GOLD)
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(o.x, o.y, z * 2.3 + Math.sin(t * 3) * 1.5, 0, TAU); ctx.stroke()
      }
    }
    // Flakes.
    for (const f of S.flakes) {
      ctx.globalAlpha = 0.5 * (1 - f.life / f.max)
      ctx.fillStyle = css(f.rgb)
      ctx.fillRect(f.x, f.y, f.s, f.s)
    }
  }

  function drawMist(t, A, fb, R) {
    const M = S.motes
    if (!M || !M.n) return
    const mistIn = S.arrival.done ? 1 : smooth((A - 0.3) / 1.3)
    if (mistIn <= 0) return
    // Faint banks of fog where a project's messages gather.
    for (const c of S.columns) {
      if (!c.asks) continue
      const w = Math.max(40, c.w * 0.7), h = 14 + Math.log10(1 + c.asks) * 6
      ctx.globalAlpha = 0.05 * mistIn * Math.min(1, 0.4 + Math.log10(1 + c.asks) / 3)
      ctx.drawImage(sprite(YOU, false), c.cx - w, G.hz - h * 1.6, w * 2, h * 2.4)
    }
    const drift = !reduce
    const levels = [0.16, 0.28, 0.4, 0.56]
    ctx.fillStyle = css(YOU)
    for (let lv = 0; lv < 4; lv++) {
      ctx.globalAlpha = levels[lv] * mistIn * (R ? 0.45 : 1)
      ctx.beginPath()
      for (let i = 0; i < M.n; i++) {
        if (M.bucket[i] !== lv || M.lift[i] > 4) continue
        const ph = M.ph[i]
        const x = M.bx[i] + (drift ? Math.sin(t * 0.13 + ph) * 4 : 0)
        const y = M.by[i] + (drift ? Math.sin(t * 0.21 + ph * 1.7) * 2.5 : 0)
        ctx.rect(x, y, 1.3, 1.3)
      }
      ctx.fill()
    }
    // Messages that answer a recall rise out of the mist.
    if (R) {
      const sp = sprite(GOLD, false)
      const selM = recallSelection()
      for (let i = 0; i < M.n; i++) {
        if (M.lift[i] <= 4) continue
        const x = M.bx[i] + (drift ? Math.sin(t * 0.13 + M.ph[i]) * 4 : 0), y = M.by[i] - M.lift[i]
        const big = selM && selM.mote === i
        const z = big ? 22 : 8
        ctx.globalAlpha = big ? 1 : 0.55 + 0.25 * Math.sin(t * 3 + M.ph[i])
        ctx.drawImage(sp, x - z / 2, y - z / 2, z, z)
      }
      for (const e of S.extra) {
        const age = t - e.t0
        const y = e.y - Math.min(1, age / 1.2) * e.rise
        const big = selM && selM.extra === e
        const z = big ? 22 : 8
        ctx.globalAlpha = Math.min(1, age * 2) * (big ? 1 : 0.6)
        ctx.drawImage(sp, e.x - z / 2, y - z / 2, z, z)
      }
    }
    // While the structure is woven, the person's words rise out of the mist into it.
    if (!S.arrival.done && !reduce && A > 1.1 && A < 4.4) {
      const sp = sprite(mix(YOU, GOLD, 0.25), false)
      for (const b of S.beliefs) {
        if (!b.root) continue
        for (let k = 0; k < Math.min(10, b.motes.length); k++) {
          const i = b.motes[k]
          const q = clamp((A - 1.1 - (k * 0.13 + b.idx * 0.04)) / 1.3, 0, 1)
          if (q <= 0 || q >= 1) continue
          const e = easeInOut(q)
          const x = lerp(M.bx[i], b.root[0], e), y = lerp(M.by[i], b.root[1], e) - Math.sin(q * Math.PI) * 22
          ctx.globalAlpha = Math.sin(Math.PI * q) * 0.8
          ctx.drawImage(sp, x - 4, y - 4, 8, 8)
        }
      }
    }
    // The focused belief's own words rise from the mist into it.
    const b = fb && !R && S.view === 'self' && S.arrival.done ? fb : null
    if (b && b.motes.length) {
      const sp = sprite(mix(YOU, GOLD, 0.35), false)
      const rx = b.root[0], ry = b.root[1]
      const lit = S.thread >= 0 && (b.threads[S.thread]?.kind === 'asks' || b.threads[S.thread]?.kind === 'session')
      for (let k = 0; k < b.motes.length; k++) {
        const i = b.motes[k]
        const x0 = M.bx[i], y0 = M.by[i]
        // Where it rests, a little brighter.
        ctx.globalAlpha = lit ? 0.9 : 0.6
        ctx.drawImage(sp, x0 - 3, y0 - 3, 6, 6)
        if (reduce) continue
        const P = 3.6 + (k % 5) * 0.5
        const q = frac((t + (M.ph[i] / TAU) * P) / P)
        const e = easeInOut(q)
        const x = lerp(x0, rx, e) + Math.sin(q * Math.PI) * (x0 - rx) * 0.15
        const y = lerp(y0, ry, e) - Math.sin(q * Math.PI) * 26
        ctx.globalAlpha = Math.sin(Math.PI * q) * (lit ? 1 : 0.7)
        ctx.drawImage(sp, x - 4, y - 4, 8, 8)
      }
    }
  }

  function drawPulses(t) {
    const sp = sprite(GOLD, false)
    for (const P of S.pulses) {
      const e = t - P.t0
      if (P.kind === 'down') {
        const b = P.b
        if (e < 0.75) {
          const s = 1 - easeInOut(e / 0.75)
          pointAt(b.pts, b.cum, b.n, s, tmp)
          ctx.globalAlpha = 1; ctx.drawImage(sp, tmp[0] - 14, tmp[1] - 14, 28, 28)
          tracePath(b.pts, b.cum, b.n, s, Math.min(1, s + 0.14))
          ctx.strokeStyle = css(GOLD); ctx.lineWidth = 2.2; ctx.globalAlpha = 0.8; ctx.stroke()
        } else if (e < 1.3) {
          const s = 1 - easeOut((e - 0.75) / 0.55)
          for (const root of b.roots) {
            pointAt(root.pts, root.cum, ROOTN, s, tmp)
            ctx.globalAlpha = 1; ctx.drawImage(sp, tmp[0] - 11, tmp[1] - 11, 22, 22)
          }
          // And through the mist, to the words.
          const M = S.motes
          for (let k = 0; k < Math.min(24, b.motes.length); k++) {
            const i = b.motes[k]
            const x = lerp(M.bx[i], b.root[0], s), y = lerp(M.by[i], b.root[1], s)
            ctx.globalAlpha = 0.7; ctx.drawImage(sp, x - 5, y - 5, 10, 10)
          }
        } else {
          const k = 1 - (e - 1.3) / 1.1
          for (const o of b.mems) { ctx.globalAlpha = Math.max(0, k); const z = 60 * (1.2 - k); ctx.drawImage(sprite(o.rgb, false), o.x - z / 2, o.y - z / 2, z, z) }
        }
      } else {
        const o = P.o
        if (e < 0.55) {
          const s = easeInOut(e / 0.55)
          for (const b of o.beliefs) {
            const root = b.roots.find((r) => r.o === o)
            if (!root) continue
            pointAt(root.pts, root.cum, ROOTN, s, tmp)
            ctx.globalAlpha = 1; ctx.drawImage(sp, tmp[0] - 12, tmp[1] - 12, 24, 24)
          }
        } else if (e < 1.3) {
          const s = easeInOut((e - 0.55) / 0.75)
          for (const b of o.beliefs) {
            pointAt(b.pts, b.cum, b.n, s, tmp)
            ctx.globalAlpha = 1; ctx.drawImage(sp, tmp[0] - 14, tmp[1] - 14, 28, 28)
          }
        }
      }
    }
  }

  // Text over light needs a dark edge to stay legible.
  function outlined(text, x, y) {
    const op = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = 'rgba(3,4,10,0.85)'; ctx.lineWidth = 3.2; ctx.lineJoin = 'round'
    ctx.strokeText(text, x, y)
    ctx.fillText(text, x, y)
    ctx.globalCompositeOperation = op
  }

  function drawLakeLabels(t, lk, fo, R) {
    const sel = recallSelection()
    ctx.textAlign = 'left'
    placed.length = 0
    const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'
    // In the lake: the names of the memories around you; old ones are missing letters.
    if (lk > 0.02 && !R) {
      ctx.font = '10.5px ' + MONO
      if (fo && G.olRect) placed.push([G.olRect[0] - 8, G.olRect[1] + S.cam.y - 6, G.olRect[2] + 16, G.olRect[3] + 12])
      if (fo) placed.push([fo.x - fo.r * 2.5, fo.y - fo.r * 2.5, fo.r * 5, fo.r * 5])
      const near = S.orbs.filter((o) => o !== fo && o.appear > 0.2).map((o) => [fo ? Math.hypot(o.x - fo.x, (o.y - fo.y) * 1.3) : 0, o]).sort((a, b) => a[0] - b[0])
      let shown = 0
      for (const [d, o] of near) {
        const fall = fo ? clamp(1 - (d - 80) / 170, 0, 1) : 0.6
        if (fall <= 0 || shown >= 7) break
        const x = o.x + o.r * 1.6 + 6, y = o.y + 3.5
        const w = o.label.length * 6.4
        if (!claim(x - 2, y - 10, w + 4, 14)) continue
        ctx.globalAlpha = lk * (0.3 + 0.45 * o.vivid) * fall * o.appear
        ctx.fillStyle = css(mix(o.rgb, [255, 255, 255], 0.55))
        outlined(o.label, x, y)
        shown++
      }
      // Columns and depth: place and time.
      ctx.font = '500 10px ' + MONO
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px'
      ctx.textAlign = 'center'
      const y = G.hz + (G.lakeTop + G.depth + 36 - G.hz) * G.sq
      for (const c of S.columns) {
        if (!c.orbs.length) continue
        ctx.globalAlpha = lk * 0.42
        ctx.fillStyle = '#8f9ab0'
        ctx.fillText(short(c.name, Math.max(4, Math.floor(c.w / 8))).toUpperCase(), c.cx, y)
        ctx.globalAlpha = lk * 0.25
        ctx.fillText(String(c.orbs.length), c.cx, y + 14)
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
      ctx.textAlign = 'right'
      ctx.font = '10px ' + MONO
      for (const [d, label] of [[0, 'today'], [7, '1 week'], [30, '1 month'], [90, '3 months'], [180, '6 months'], [365, '1 year'], [730, '2 years']]) {
        if (d > G.maxAge * 1.02) break
        const yy = G.hz + (G.lakeTop + depthOf(d) * G.depth - G.hz) * G.sq
        ctx.globalAlpha = lk * 0.34
        ctx.fillStyle = '#7d889e'
        ctx.fillText(label, G.W - 12, yy + 3)
        ctx.fillRect(G.W - 8, yy, 5, 0.8)
      }
      ctx.textAlign = 'left'
    }
    // During recall: what rose, by name.
    if (R) {
      ctx.font = '11px ' + MONO
      const risen = S.orbs.filter((o) => o.match >= 0 && o.match < 14).sort((a, b) => (sel && sel.o === a ? -1 : sel && sel.o === b ? 1 : a.match - b.match))
      for (const o of risen) {
        const isSel = sel && sel.o === o
        const text = short(o.m.title, 34)
        const x = o.x + o.r * 2 + 6, y = o.y + 4
        if (!claim(x - 2, y - 11, text.length * 6.7 + 4, 15) && !isSel) continue
        ctx.globalAlpha = isSel ? 1 : 0.75
        ctx.fillStyle = isSel ? css(GOLD) : css(mix(o.rgb, [255, 255, 255], 0.65))
        outlined(text, x, y)
      }
    }
  }

  // A faint line from the words to the bead that holds them.
  function drawLeader(t, A, fb, lk) {
    if (!fb || S.recall || S.view !== 'self' || !S.arrival.done || !S.capRect || !fb.tip) return
    const a = (1 - lk) * 0.3
    if (a <= 0.01) return
    const r = S.capRect
    const x0 = Math.min(r.right + 14, G.capRight + 8), y0 = r.top + Math.min(r.height / 2, 40) + S.cam.y
    const x1 = fb.tip[0], y1 = fb.tip[1]
    const g = ctx.createLinearGradient(x0, y0, x1, y1)
    g.addColorStop(0, 'rgba(255,226,170,0)'); g.addColorStop(0.6, 'rgba(255,226,170,0.5)'); g.addColorStop(1, 'rgba(255,226,170,0.9)')
    ctx.globalAlpha = a
    ctx.strokeStyle = g
    ctx.lineWidth = 0.8
    ctx.setLineDash([2, 5])
    ctx.lineDashOffset = reduce ? 0 : -t * 8
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.bezierCurveTo(lerp(x0, x1, 0.5), y0, lerp(x0, x1, 0.5), y1, x1 - 14, y1); ctx.stroke()
    ctx.setLineDash([])
  }

  // ── DOM: caption, orb label, recall list, panel, hint ───────────────────────────────────────────

  function renderCaption(animate) {
    const b = focusedBelief()
    const cap = $('caption')
    if (!b) {
      $('cap-section').textContent = 'About you'
      $('cap-count').textContent = ''
      $('cap-text').textContent = 'About You has not been written yet. The lake below is everything your agents remember.'
      $('cap-why-label').textContent = ''
      $('cap-why').textContent = ''
      return
    }
    cap.style.setProperty('--sec', hexOf(mix(b.sec.rgb, [255, 255, 255], 0.2)))
    $('cap-section').textContent = b.sec.name
    $('cap-count').textContent = `${b.j + 1} of ${b.sec.beliefs.length}`
    $('cap-text').textContent = b.text
    $('cap-why-label').textContent = b.threads.length ? 'why your agents believe this' : 'nothing cited; a belief with no memory under it'
    const list = $('cap-why')
    list.textContent = ''
    b.threads.forEach((th, i) => {
      const li = el('li')
      if (i === S.thread) li.className = 'sel'
      if (th.kind === 'memory') {
        const o = th.o
        li.append(dot(o.rgb))
        const w = el('span', 'w', o.m.title || o.m.path)
        w.append(el('small', null, o.ag.name + (o.m.project?.name ? ' · ' + o.m.project.name : '')))
        li.append(w, el('span', 'a', ago(o.age)))
      } else if (th.kind === 'asks') {
        li.append(dot(YOU, 'ring'))
        li.append(el('span', 'w', `${b.askN.toLocaleString('en-US')} of your messages`), el('span', 'a', 'you'))
        if (b.quotes.length) li.append(el('span', 'q', b.quotes.map((q) => `“${short(q, 70)}”`).join('  ')))
      } else if (th.kind === 'session') {
        li.append(dot(YOU, 'ring'))
        li.append(el('span', 'w', b.sessionAsks ? `one conversation · ${b.sessionAsks} messages` : 'one conversation'), el('span', 'a', 'you'))
      } else {
        li.className = 'missing' + (i === S.thread ? ' sel' : '')
        li.append(dot(rgbOf(th.x.agent.color), 'ring'))
        li.append(el('span', 'w', `${th.x.name}`), el('span', 'a', 'not on this computer'))
      }
      list.append(li)
    })
    measureCaption()
    if (animate && !reduce && cap.animate) {
      $('cap-text').animate([{ opacity: 0, transform: 'translateY(8px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' })
      list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 60, easing: 'ease-out', fill: 'backwards' })
    }
  }

  function renderOrbLabel() {
    const o = focusedOrb()
    if (!o) return
    $('ol-dot').style.color = hexOf(o.rgb)
    $('ol-meta').textContent = [o.ag.name, o.m.project?.name || 'everywhere', ago(o.age)].join(' · ')
    $('ol-title').textContent = o.m.title || o.m.path
    const h = $('ol-holds')
    h.textContent = ''
    if (o.beliefs.length) {
      h.className = 'h'
      h.append(el('span', null, o.beliefs.length === 1 ? 'holds up a belief' : `holds up ${o.beliefs.length} beliefs`))
      for (const b of o.beliefs.slice(0, 3)) h.append(el('div', null, short(b.text, 90)))
    } else {
      h.className = 'h none'
      h.textContent = 'holds up no belief: a free-floating memory'
    }
  }

  function positionOrbLabel() {
    const lab = $('orb-label')
    const o = focusedOrb()
    const on = S.view === 'lake' && o && !S.panel && !S.recall && S.cam.y > G.lakeCam * 0.6
    lab.classList.toggle('on', !!on)
    if (!on) { G.olRect = null; return }
    const w = lab.offsetWidth, h = lab.offsetHeight
    const sx = o.x, sy = o.y - S.cam.y
    let x = sx + o.r * 3 + 16
    if (x + w > G.W - 12) x = sx - o.r * 3 - 16 - w
    const y = clamp(sy - h / 2, 12, G.H - h - 34)
    G.olRect = [Math.max(8, x), y, w, h]
    lab.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(y)}px)`
  }

  function showCaption() {
    const on = S.arrival.done && S.view === 'self' && !S.recall
    $('caption').classList.toggle('on', on)
    $('recall').classList.toggle('on', !!S.recall)
  }

  function renderHint() {
    const keys = $('keys')
    let text
    if (!S.arrival.done) text = 'any key to skip'
    else if (S.panel) text = '↑↓ scroll  ·  esc back'
    else if (S.recall) text = '↑↓ choose  ·  enter open  ·  esc forget'
    else if (S.view === 'lake') text = '←↑↓→ swim  ·  enter lift out  ·  space follow its light up  ·  esc rise  ·  type to recall'
    else text = `←→ branch  ·  ↑↓ belief  ·  space pluck  ·  tab thread  ·  enter dive  ·  type to recall  ·  m sound ${S.sound ? 'on' : 'off'}`
    keys.textContent = text
    const p = $('prompt')
    p.textContent = ''
    if (S.recall && !S.panel) {
      p.append(el('span', 'p', 'recall ›'), document.createTextNode(S.recall.q), el('span', 'c'))
    }
  }

  function renderStatus() {
    const n = (x) => x.toLocaleString('en-US')
    $('status').textContent = `${S.real ? 'your memories' : 'an invented person'}  ·  ${n(S.beliefs.length)} beliefs  ·  ${n(S.orbs.length)} memories  ·  ${n(S.asks.length)} messages`
  }

  let toastTimer = 0
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('on')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 1400)
  }

  // Simple, safe markdown: headings, bullets, code, bold. Text nodes only.
  function renderBody(root, text) {
    root.textContent = ''
    const lines = String(text ?? '').replace(/\r/g, '').split('\n')
    let para = null, code = null
    for (const raw of lines) {
      if (/^\s*```/.test(raw)) { if (code) code = null; else { code = el('pre'); root.append(code) } para = null; continue }
      if (code) { code.textContent += raw + '\n'; continue }
      const line = raw.trimEnd()
      if (!line.trim()) { para = null; continue }
      let m
      if ((m = /^\s*#{1,6}\s+(.*)$/.exec(line))) { const h = el('h4'); inline(h, m[1]); root.append(h); para = null; continue }
      if ((m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line))) { const li = el('div', 'li'); inline(li, m[1]); root.append(li); para = null; continue }
      if (!para) { para = el('p'); root.append(para) } else para.append(document.createElement('br'))
      inline(para, line)
    }
  }
  function inline(node, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
    let last = 0, m
    while ((m = re.exec(text))) {
      if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)))
      const tok = m[0]
      node.append(el(tok[0] === '`' ? 'code' : 'strong', null, tok[0] === '`' ? tok.slice(1, -1) : tok.slice(2, -2)))
      last = m.index + tok.length
    }
    if (last < text.length) node.append(document.createTextNode(text.slice(last)))
  }
  function marked(node, snippet) {
    // \u0002 … \u0003 mark matches.
    const parts = String(snippet ?? '').split(/([\u0002\u0003])/)
    let on = false
    for (const p of parts) {
      if (p === '\u0002') { on = true; continue }
      if (p === '\u0003') { on = false; continue }
      if (!p) continue
      node.append(on ? el('mark', null, p) : document.createTextNode(p))
    }
  }

  function openPanel(spec, from) {
    S.panel = spec
    const panel = $('panel')
    const meta = $('p-meta'), title = $('p-title'), desc = $('p-desc'), body = $('p-body'), foot = $('p-foot')
    meta.textContent = ''; foot.textContent = ''; desc.textContent = ''
    let glow = GOLD
    if (spec.kind === 'memory') {
      const o = spec.o, m = o.m
      glow = o.rgb
      meta.append(dot(o.rgb), el('span', null, o.ag.name), el('span', null, '·'), el('span', null, m.type || m.kind || 'note'),
        el('span', null, '·'), el('span', null, m.project?.name || 'everywhere'), el('span', null, '·'), el('span', null, ago(o.age)))
      title.textContent = m.title || m.path
      const d = String(m.description ?? '').trim()
      if (d && d.toLowerCase() !== String(m.title ?? '').toLowerCase() && !/^(rules|summary|handbook|topic|saved|profile|notes|observation|conversation summary|remembered on request)$/i.test(d)) desc.textContent = d
      renderBody(body, m.body)
      if (o.beliefs.length) {
        foot.append(el('div', null, o.beliefs.length === 1 ? 'holds up this belief' : `holds up ${o.beliefs.length} beliefs`))
        for (const b of o.beliefs) foot.append(el('div', 'b', b.text))
      } else foot.append(el('div', null, 'holds up no belief yet: a free-floating memory'))
      foot.append(el('div', 'p', m.path || ''))
      o.glow = 1
    } else if (spec.kind === 'messages') {
      const b = spec.b
      meta.append(dot(YOU, 'ring'), el('span', null, 'your own words'), el('span', null, '·'), el('span', null, `${(b.askN || b.sessionAsks || b.motes.length).toLocaleString('en-US')} messages`))
      title.textContent = b.text
      desc.textContent = b.askN > b.motes.length ? `The ${b.motes.length} that rise closest to it, out of ${b.askN.toLocaleString('en-US')}; nearest first.` : ''
      body.textContent = ''
      const rows = b.motes.map((i) => S.asks[i])
      for (const ask of rows) {
        const row = el('div', 'msg')
        row.append(dot(rgbOf(MemoryData.agent(ask.engine, S.snapshot).color)))
        row.append(el('div', 'x', short(clean(ask.text) || '(an image)', 400)))
        row.append(el('div', 'a', `${MemoryData.agent(ask.engine, S.snapshot).name} · ${ago(S.now - ask.at)}${ask.cwd ? ' · ' + ask.cwd.split('/').filter(Boolean).pop() : ''}`))
        body.append(row)
      }
      foot.append(el('div', null, `${b.sec.name}`))
    } else if (spec.kind === 'message') {
      const ask = spec.ask, hit = spec.hit
      const engine = ask?.engine ?? hit?.engine
      const ag = MemoryData.agent(engine, S.snapshot)
      const at = ask?.at ?? hit?.at
      const cwd = ask?.cwd || hit?.cwd || ''
      glow = rgbOf(ag.color)
      meta.append(dot(YOU, 'ring'), el('span', null, 'you said, to ' + ag.name), el('span', null, '·'), el('span', null, at ? ago(S.now - at) : ''))
      if (cwd) meta.append(el('span', null, '·'), el('span', null, cwd.split('/').filter(Boolean).pop()))
      title.textContent = (ask?.title || hit?.title) ? short(ask?.title || hit?.title, 90) : 'Your message'
      body.textContent = ''
      const p = el('p')
      if (ask) {
        const terms = wordsOf(S.recall?.q ?? '')
        let text = String(ask.text ?? '')
        for (const term of terms) text = text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `\u0002${m}\u0003`)
        marked(p, text)
      } else marked(p, hit?.snippet)
      body.append(p)
      const bel = spec.mote != null ? S.motes.bel.get(spec.mote) : null
      if (bel && bel.length) { foot.append(el('div', null, 'part of what holds up')); for (const b of bel) foot.append(el('div', 'b', b.text)) }
      else foot.append(el('div', null, 'a message in the mist'))
    }
    panel.style.setProperty('--glow', css(glow, 0.35))
    panel.classList.add('on')
    $('veil').classList.add('on')
    body.scrollTop = 0
    if (!reduce && panel.animate) {
      const dx = (from ? from[0] : G.W / 2) - G.W / 2, dy = (from ? from[1] : G.H / 2) - G.H / 2
      panel.animate([
        { opacity: 0, transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(.05)`, filter: 'blur(8px)' },
        { opacity: 1, offset: 0.55, filter: 'blur(1px)' },
        { opacity: 1, transform: 'translate(-50%, -50%)', filter: 'blur(0)' },
      ], { duration: 620, easing: 'cubic-bezier(.16,.84,.24,1)' })
    }
    renderHint()
  }

  function closePanel() {
    const spec = S.panel
    S.panel = null
    const panel = $('panel')
    $('veil').classList.remove('on')
    const done = () => panel.classList.remove('on')
    if (!reduce && panel.animate && spec) {
      let from = null
      if (spec.kind === 'memory') from = [spec.o.x, spec.o.y - S.cam.y]
      const dx = (from ? from[0] : G.W / 2) - G.W / 2, dy = (from ? from[1] : G.H / 2) - G.H / 2
      const anim = panel.animate([{ opacity: 1, transform: 'translate(-50%, -50%)' }, { opacity: 0, transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(.08)`, filter: 'blur(6px)' }], { duration: 380, easing: 'cubic-bezier(.5,0,.75,0)' })
      anim.onfinish = done
    } else done()
    renderHint()
  }

  // ── actions ─────────────────────────────────────────────────────────────────────────────────────

  function finishArrival() {
    if (S.arrival.done) return
    S.arrival.done = true
    S.arrival.t = ARRIVE_END
    $('whisper').classList.remove('on')
    renderCaption(true)
    showCaption()
    renderHint()
  }

  function focusBelief(sec, bel, animate = true) {
    const s = S.sections[sec]
    if (!s) return
    S.sec = sec; S.bel = clamp(bel, 0, s.beliefs.length - 1); S.thread = -1
    renderCaption(animate)
  }

  function pluck(b) {
    if (!b) return
    b.pluckT = S.time; b.pluckA = 10; b.flash = 1
    for (const o of b.sec.beliefs) if (o !== b) { o.pluckT = S.time + 0.06; o.pluckA = 2.2 }
    S.pulses.push({ kind: 'down', b, t0: S.time })
    tone(b)
  }

  function descend(o) {
    if (!S.orbs.length) return
    S.view = 'lake'
    if (!o) {
      const b = focusedBelief()
      o = b?.mems[0] ?? S.orbs.reduce((best, x) => (!best || Math.hypot(x.bx - G.treeX, x.by - G.hz) < Math.hypot(best.bx - G.treeX, best.by - G.hz) ? x : best), null)
    }
    S.orb = o.i
    camTo(G.lakeCam, 1.25)
    if (!reduce) S.ripples.push({ x: focusedBelief()?.root?.[0] ?? G.treeX, t0: S.time })
    renderOrbLabel(); showCaption(); renderHint()
  }

  function rise(dur = 1.1) {
    const o = focusedOrb()
    S.view = 'self'
    if (o && o.beliefs.length) { const b = o.beliefs[0]; focusBelief(b.sec.k, b.j, false) }
    camTo(0, dur)
    showCaption(); renderCaption(true); renderHint()
  }

  function camTo(y, dur) { S.cam.from = S.cam.y; S.cam.to = y; S.cam.t0 = S.time; S.cam.dur = reduce ? 0.001 : dur }

  function swim(dx, dy) {
    const o = focusedOrb()
    if (!o) { S.orb = 0; renderOrbLabel(); return true }
    let best = null, bestScore = Infinity
    for (const c of S.orbs) {
      if (c === o) continue
      const vx = c.bx - o.bx, vy = c.by - o.by
      const along = vx * dx + vy * dy
      if (along <= 2) continue
      const perp = Math.abs(vx * dy - vy * dx)
      const score = along + perp * 2.4
      if (score < bestScore) { bestScore = score; best = c }
    }
    if (!best) return false
    S.orb = best.i
    renderOrbLabel()
    return true
  }

  // ── recall ──────────────────────────────────────────────────────────────────────────────────────

  let searchTimer = 0
  function startRecall(q) {
    S.recall = { q: '', sel: 0, beliefs: new Set(), results: [], hits: null, memCount: 0, moteCount: 0 }
    S.thread = -1
    setQuery(q)
    showCaption()
  }

  function closeRecall() {
    S.recall = null
    for (const o of S.orbs) o.match = -1
    S.motes.match.fill(0)
    S.extra = []
    clearTimeout(searchTimer)
    showCaption(); renderCaption(false); renderHint()
  }

  function setQuery(q) {
    const R = S.recall
    R.q = q
    const terms = wordsOf(q)
    const M = S.motes
    // Memories: every term somewhere in the note.
    const mems = []
    for (const o of S.orbs) {
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
    for (const o of S.orbs) o.match = -1
    mems.forEach(([, o], i) => { o.match = i })
    // Your messages, here first; then the full index.
    M.match.fill(0)
    const local = []
    if (terms.length) {
      for (let i = 0; i < M.n; i++) {
        const text = M.lower[i]
        let ok = true
        for (const term of terms) if (!text.includes(term)) { ok = false; break }
        if (ok) { M.match[i] = 1; local.push(i) }
      }
    }
    // Beliefs: by their words, or by what holds them up.
    R.beliefs = new Set()
    for (const b of S.beliefs) { const lt = b.text.toLowerCase(); if (terms.length && terms.every((term) => lt.includes(term))) R.beliefs.add(b) }
    const direct = new Set(R.beliefs)
    for (const [, o] of mems) for (const b of o.beliefs) R.beliefs.add(b)
    for (const i of local) { const list = M.bel.get(i); if (list) for (const b of list) R.beliefs.add(b) }
    R.mems = mems.map(([, o]) => o)
    R.direct = [...direct]
    R.local = local.sort((a, b) => S.asks[b].at - S.asks[a].at)
    R.localSet = new Set(local)
    R.hits = null
    S.extra = []
    R.sel = 0
    buildResults()
    renderHint()
    clearTimeout(searchTimer)
    if (terms.length) {
      const asked = q
      searchTimer = setTimeout(() => {
        MemoryData.search(asked).then((hits) => {
          if (S.recall !== R || R.q !== asked) return
          R.hits = hits || []
          for (const hit of R.hits) {
            const i = M.key.get(`${hit.sessionId}#${hit.turn}`)
            if (i != null) { M.match[i] = 1; hit.mote = i; const list = M.bel.get(i); if (list) for (const b of list) R.beliefs.add(b) }
            else {
              const base = String(hit.cwd || '').split('/').filter(Boolean).pop()
              const c = S.columns.find((col) => col.name === base)
              const x = c ? c.cx + (h01(hit.sessionId + hit.turn) - 0.5) * c.w * 0.6 : 30 + h01(hit.sessionId) * (G.W - 60)
              const e = { x, y: G.hz - 4, rise: 30 + h01(String(hit.turn)) * 40, t0: S.time, hit }
              S.extra.push(e); hit.extra = e
            }
          }
          buildResults()
        }).catch(() => {})
      }, 160)
    }
  }

  function buildResults() {
    const R = S.recall
    const roomy = G.H > 760
    const results = []
    const memMax = R.local.length || R.hits?.length ? (roomy ? 6 : 4) : roomy ? 11 : 8
    if (R.mems.length) {
      results.push({ head: `memories · ${R.mems.length}` })
      for (const o of R.mems.slice(0, memMax)) results.push({ kind: 'memory', o })
    }
    if (R.direct.length) {
      results.push({ head: `beliefs · ${R.direct.length}` })
      for (const b of R.direct.slice(0, 3)) results.push({ kind: 'belief', b })
    }
    const msgMax = roomy ? 6 : 4
    const messages = []
    const terms = wordsOf(R.q)
    const byText = new Map()
    const add = (row, key) => {
      const k = key.toLowerCase().replace(/\s+/g, ' ').trim()
      const seen = byText.get(k)
      if (seen) { seen.times++; return }
      byText.set(k, row)
      if (messages.length < msgMax) messages.push(row)
    }
    for (const i of R.local) {
      const text = clean(S.asks[i].text)
      add({ kind: 'message', ask: S.asks[i], mote: i, snippet: snippetOf(text, terms), times: 1 }, text)
    }
    for (const hit of R.hits ?? []) {
      if (hit.mote != null && M_has(hit.mote)) continue
      const snip = clean(hit.snippet)
      add({ kind: 'message', hit, ask: hit.mote != null ? S.asks[hit.mote] : null, mote: hit.mote ?? null, extra: hit.extra ?? null, snippet: snip, times: 1 }, snip.replace(/[\u0002\u0003]/g, ''))
    }
    const msgCount = Math.max(R.local.length, R.hits?.length ?? 0)
    if (messages.length) { results.push({ head: `your messages · ${msgCount}${R.hits && R.hits.length >= 24 ? '+' : ''}` }); results.push(...messages) }
    R.results = results
    R.pick = results.filter((r) => !r.head)
    R.sel = clamp(R.sel, 0, Math.max(0, R.pick.length - 1))
    renderRecall()
  }

  function renderRecall() {
    const R = S.recall
    if (!R) return
    const sum = $('recall-sum')
    const terms = wordsOf(R.q)
    sum.textContent = !terms.length ? 'recall: keep typing' : R.pick.length ? `recall “${short(R.q, 28)}”  ·  ${R.beliefs.size} belief${R.beliefs.size === 1 ? '' : 's'} stir` : `nothing rises for “${short(R.q, 28)}”`
    const list = $('recall-list')
    list.textContent = ''
    const picked = R.pick[R.sel]
    for (const r of R.results) {
      const li = el('li')
      if (r.head) { li.className = 'head'; li.textContent = r.head; list.append(li); continue }
      if (r === picked) li.className = 'sel'
      if (r.kind === 'memory') {
        const o = r.o
        li.append(dot(o.rgb))
        const w = el('span', 'w'); marked(w, mark(o.m.title || o.m.path, terms)); li.append(w)
        li.append(el('span', 'a', `${short(o.m.project?.name || 'everywhere', 16)} · ${ago(o.age)}${o.beliefs.length ? '' : ' · free'}`))
      } else if (r.kind === 'belief') {
        li.append(dot(r.b.sec.rgb, 'diamond'))
        const w = el('span', 'w serif'); marked(w, mark(r.b.text, terms)); li.append(w)
        li.append(el('span', 'a', short(r.b.sec.name, 16)))
      } else {
        const engine = r.ask?.engine ?? r.hit?.engine
        const ag = MemoryData.agent(engine, S.snapshot)
        li.append(dot(YOU, 'ring'))
        const w = el('span', 'w serif'); marked(w, r.snippet ?? clean(r.hit?.snippet ?? '')); li.append(w)
        const at = r.ask?.at ?? r.hit?.at
        li.append(el('span', 'a', `${r.times > 1 ? '×' + r.times + ' · ' : ''}${ag.name} · ${at ? ago(S.now - at) : ''}`))
      }
      list.append(li)
    }
    // Keep the selection in view when the list is long.
    const sel = list.querySelector('.sel')
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' })
  }

  // Local matches already listed (hits for the same message are not repeated).
  function M_has(i) { return S.recall && S.recall.local && S.recall.localSet && S.recall.localSet.has(i) }

  // A window of the message around its first match, with matches marked.
  function snippetOf(text, terms) {
    const lower = text.toLowerCase()
    let at = -1
    for (const term of terms) { const k = lower.indexOf(term); if (k >= 0 && (at < 0 || k < at)) at = k }
    let out = text
    if (at > 40) { const from = text.lastIndexOf(' ', at - 30); out = '…' + text.slice(from > 0 ? from + 1 : at - 30) }
    return mark(short(out, 150), terms)
  }

  function mark(text, terms) {
    let out = String(text ?? '')
    for (const term of terms) out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `\u0002${m}\u0003`)
    return out
  }

  function recallSelection() {
    const R = S.recall
    if (!R || !R.pick || !R.pick.length) return null
    return R.pick[R.sel] ?? null
  }

  function activateRecall() {
    const r = recallSelection()
    if (!r) return
    if (r.kind === 'memory') {
      const o = r.o
      S.orb = o.i
      openPanel({ kind: 'memory', o }, [o.x, o.y - S.cam.y])
    } else if (r.kind === 'belief') {
      const b = r.b
      closeRecall()
      focusBelief(b.sec.k, b.j)
      if (S.view === 'lake') rise()
      pluck(b)
    } else {
      let from = null
      if (r.mote != null) from = [S.motes.bx[r.mote], S.motes.by[r.mote] - S.motes.lift[r.mote] - S.cam.y]
      else if (r.extra) from = [r.extra.x, r.extra.y - r.extra.rise - S.cam.y]
      openPanel({ kind: 'message', ask: r.ask, hit: r.hit, mote: r.mote }, from)
    }
  }

  // ── sound (off until m) ─────────────────────────────────────────────────────────────────────────

  let audio = null
  function tone(b) {
    if (!S.sound || !b) return
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)()
      if (audio.state === 'suspended') audio.resume()
      const now = audio.currentTime
      const scale = [0, 2, 4, 7, 9]
      const deg = b.sec.k * 2 + (b.sec.beliefs.length - 1 - b.j)
      const semis = scale[deg % 5] + 12 * Math.floor(deg / 5)
      const f = 174.6 * Math.pow(2, semis / 12)
      const out = audio.createGain()
      const lp = audio.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600
      out.connect(lp); lp.connect(audio.destination)
      out.gain.setValueAtTime(0.0001, now)
      out.gain.exponentialRampToValueAtTime(0.13, now + 0.006)
      out.gain.exponentialRampToValueAtTime(0.0001, now + 2.8)
      for (const [mult, g, det] of [[1, 1, 0], [1, 0.5, 4], [2, 0.32, 0], [3, 0.12, -3], [4.01, 0.05, 0]]) {
        const osc = audio.createOscillator(); osc.type = 'sine'; osc.frequency.value = f * mult; osc.detune.value = det
        const og = audio.createGain(); og.gain.value = g
        osc.connect(og); og.connect(out); osc.start(now); osc.stop(now + 2.9)
      }
    } catch { /* no sound here */ }
  }

  // ── keys ────────────────────────────────────────────────────────────────────────────────────────

  addEventListener('keydown', (e) => {
    if (!S.ready) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    if (!S.arrival.done) { e.preventDefault(); finishArrival(); return }

    if (S.panel) {
      const body = $('p-body')
      if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); closePanel() }
      else if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); body.scrollBy({ top: 64 }) }
      else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); body.scrollBy({ top: -64 }) }
      else if (k === ' ' || k === 'PageDown') { e.preventDefault(); body.scrollBy({ top: body.clientHeight * 0.85 * (e.shiftKey ? -1 : 1) }) }
      else if (k === 'PageUp') { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.85 }) }
      else if (k === 'Home') { e.preventDefault(); body.scrollTop = 0 }
      else if (k === 'End') { e.preventDefault(); body.scrollTop = body.scrollHeight }
      return
    }

    if (S.recall) {
      const R = S.recall
      if (k === 'Escape') { e.preventDefault(); closeRecall(); return }
      if (k === 'Backspace') { e.preventDefault(); const q = R.q.slice(0, -1); if (!q) closeRecall(); else setQuery(q); return }
      if (k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); R.sel = Math.min(R.pick.length - 1, R.sel + 1); renderRecall(); return }
      if (k === 'ArrowUp' || (k === 'Tab' && e.shiftKey)) { e.preventDefault(); R.sel = Math.max(0, R.sel - 1); renderRecall(); return }
      if (k === 'Enter') { e.preventDefault(); activateRecall(); return }
      if (k.length === 1) { e.preventDefault(); if (R.q.length < 60) setQuery(R.q + k); return }
      return
    }

    if (k === 'm') { e.preventDefault(); S.sound = !S.sound; toast(S.sound ? 'sound on' : 'sound off'); renderHint(); if (S.sound) tone(focusedBelief()); return }
    if (k === '/') { e.preventDefault(); startRecall(''); return }

    if (S.view === 'self') {
      const b = focusedBelief()
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault()
        const d = k === 'ArrowLeft' ? -1 : 1
        const next = S.sec + d
        if (next >= 0 && next < S.sections.length) focusBelief(next, S.bel)
        return
      }
      if (k === 'ArrowUp') { e.preventDefault(); if (b && S.bel > 0) focusBelief(S.sec, S.bel - 1); return }
      if (k === 'ArrowDown') {
        e.preventDefault()
        if (b && S.bel < b.sec.beliefs.length - 1) focusBelief(S.sec, S.bel + 1)
        else descend(null)
        return
      }
      if (k === ' ') { e.preventDefault(); pluck(b); return }
      if (k === 'Tab') {
        e.preventDefault()
        if (!b || !b.threads.length) return
        const n = b.threads.length
        S.thread = S.thread < 0 ? (e.shiftKey ? n - 1 : 0) : (S.thread + (e.shiftKey ? -1 : 1) + n) % n
        renderCaption(false)
        return
      }
      if (k === 'Enter') {
        e.preventDefault()
        if (!b) { descend(null); return }
        const th = b.threads[S.thread >= 0 ? S.thread : b.threads.findIndex((x) => x.kind === 'memory')] ?? b.threads[0]
        if (th?.kind === 'memory') descend(th.o)
        else if (th && (th.kind === 'asks' || th.kind === 'session') && b.motes.length) openPanel({ kind: 'messages', b }, [b.root[0], b.root[1] - S.cam.y])
        else descend(null)
        return
      }
      if (k === 'Escape') { e.preventDefault(); if (S.thread >= 0) { S.thread = -1; renderCaption(false) } return }
    } else {
      if (k === 'ArrowLeft') { e.preventDefault(); swim(-1, 0); return }
      if (k === 'ArrowRight') { e.preventDefault(); swim(1, 0); return }
      if (k === 'ArrowDown') { e.preventDefault(); swim(0, 1); return }
      if (k === 'ArrowUp') { e.preventDefault(); if (!swim(0, -1)) rise(); return }
      if (k === 'Enter') { e.preventDefault(); const o = focusedOrb(); if (o) openPanel({ kind: 'memory', o }, [o.x, o.y - S.cam.y]); return }
      if (k === 'Escape') { e.preventDefault(); rise(); return }
      if (k === ' ') {
        e.preventDefault()
        const o = focusedOrb()
        if (o && o.beliefs.length) S.pulses.push({ kind: 'up', o, t0: S.time })
        else if (o) { o.glow = 1; toast('this memory holds up no belief') }
        return
      }
    }
    if (k.length === 1 && /[\p{L}\p{N}]/u.test(k)) { e.preventDefault(); startRecall(k) }
  })

  // The mouse works too, quietly: click a bead or an orb; scroll to dive or rise.
  canvas.addEventListener('click', (e) => {
    if (!S.ready || S.panel || S.recall) return
    if (!S.arrival.done) { finishArrival(); return }
    const x = e.clientX, y = e.clientY + S.cam.y
    let best = null, bd = 22
    for (const b of S.beliefs) { if (!b.tip) continue; const d = Math.hypot(b.tip[0] - x, b.tip[1] - y); if (d < bd) { bd = d; best = b } }
    if (best) { if (S.view === 'lake') rise(); focusBelief(best.sec.k, best.j); pluck(best); return }
    let bo = null; bd = 18
    for (const o of S.orbs) { const d = Math.hypot(o.x - x, o.y - y); if (d < bd) { bd = d; bo = o } }
    if (bo) { if (S.view === 'lake' && S.orb === bo.i) openPanel({ kind: 'memory', o: bo }, [bo.x, bo.y - S.cam.y]); else descend(bo) }
  })
  let wheelLock = 0
  addEventListener('wheel', (e) => {
    if (!S.ready || S.panel || !S.arrival.done || S.time < wheelLock) return
    if (e.deltaY > 30 && S.view === 'self') { descend(null); wheelLock = S.time + 1.2 }
    else if (e.deltaY < -30 && S.view === 'lake') { rise(); wheelLock = S.time + 1.2 }
  }, { passive: true })

  // ── loop ────────────────────────────────────────────────────────────────────────────────────────

  let raf = 0, last = 0
  function frame(now) {
    raf = 0
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60)
    last = now
    S.time += dt
    if (!S.arrival.done) {
      S.arrival.t += dt
      if (S.arrival.t > 0.3 && S.arrival.t < 3.3) $('whisper').classList.add('on')
      else $('whisper').classList.remove('on')
      if (S.arrival.t >= ARRIVE_END) finishArrival()
    }
    const t0 = performance.now()
    update(dt)
    draw()
    S.frameMs = S.frameMs ? S.frameMs * 0.95 + (performance.now() - t0) * 0.05 : performance.now() - t0
    if (!document.hidden) raf = requestAnimationFrame(frame)
  }
  function start() { if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame) } }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0 } else if (S.ready) start() })
  let resizeTimer = 0
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!S.ready) return; layout(); if (S.view === 'lake') { S.cam.y = S.cam.to = G.lakeCam } }, 60) })

  async function main() {
    let data
    try { data = await MemoryData.load() } catch (error) {
      const box = $('error'); box.style.display = 'grid'; box.textContent = 'Could not read memories: ' + String(error?.message ?? error)
      return
    }
    build(data)
    layout()
    S.ready = true
    renderStatus()
    renderHint()
    renderCaption(false)
    if (reduce) finishArrival()
    // Measure once fonts settle, for the leader line.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureCaption)
    // A hook for automated checks; read-only.
    window.__self = { S, G, finishArrival }
    start()
  }
  main()
})()
