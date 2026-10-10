/*
 * Mind Palace: the method of loci, walked in first person and drawn as glowing vector lines.
 *
 * About You is carved into a circle of standing stones at the centre (you stand inside it). Corridors lead
 * out to wings, one per project, brighter where you work most and longer the longer you have been away.
 * Rooms hold the memories as plaques coloured by agent; old ones gather dust and lose letters at the edges.
 * Type, and your words float up around you while matching memories fly out of their rooms toward you.
 *
 * Data comes only from MemoryData (memory-data.js). Memory text is untrusted: it is drawn as glyph quads
 * from an atlas made with fillText, or set with textContent. Nothing is written anywhere.
 */
(function () {
  'use strict'

  // ── small things ─────────────────────────────────────────────────────────────────────────────────

  const TAU = Math.PI * 2, DEG = Math.PI / 180, DAY = 86_400_000
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (id) => document.getElementById(id)
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
  const lerp = (a, b, t) => a + (b - a) * t
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
  const smoother = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10) }
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3)
  const angWrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
  const angLerp = (a, b, t) => a + angWrap(b - a) * t
  function hash3(a, b, c) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul((b | 0) + 7, 668265263) ^ Math.imul((c | 0) + 13, 1440662683)
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
  function rng(seed) {
    let s = seed >>> 0
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  }
  function strSeed(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

  function hexRGB(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? '').trim())
    if (!m) return [0.62, 0.66, 0.72]
    const n = parseInt(m[1], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  function lift(c, min = 0.66) { const mx = Math.max(c[0], c[1], c[2], 0.01); const k = mx < min ? min / mx : 1; return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)] }
  const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
  const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`
  const COL = {
    struct: [0.32, 0.78, 1.0], self: [1.0, 0.75, 0.44], words: [0.74, 0.66, 1.0], label: [0.84, 0.95, 1.0],
    path: [1.0, 0.3, 0.68], type: [0.9, 0.97, 1.0], dust: [0.62, 0.66, 0.72], white: [1, 1, 1], ink: [0.86, 0.92, 0.95],
  }

  const fmt = (n) => Number(n || 0).toLocaleString('en-US')
  function ago(at, now = Date.now()) {
    if (!at) return 'never'
    const s = Math.max(0, now - at) / 1000
    if (s < 90) return 'just now'
    const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`
    const h = m / 60; if (h < 24) return `${Math.round(h)} h ago`
    const d = h / 24; if (d < 1.8) return 'yesterday'
    if (d < 14) return `${Math.round(d)} days ago`
    if (d < 60) return `${Math.round(d / 7)} weeks ago`
    if (d < 365) return `${Math.round(d / 30.4)} months ago`
    return `${(d / 365).toFixed(1)} years ago`
  }
  const dateOf = (at) => (at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '')
  const shortDate = (at) => (at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '')
  const timeOf = (at) => (at ? new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')
  function middle(s, n) { s = String(s); if (s.length <= n) return s; const a = Math.ceil((n - 1) * 0.55); return s.slice(0, a) + '…' + s.slice(s.length - (n - 1 - a)) }
  function tail(p, n = 46) { p = String(p || ''); return p.length <= n ? p : '…' + p.slice(p.length - n + 1) }

  // ── text ─────────────────────────────────────────────────────────────────────────────────────────

  const CTRL = /[\u0000\u0001\u0004-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g
  const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(CTRL, '')
  const oneLine = (s) => clean(s).replace(/[\u0002\u0003]/g, '').replace(/\s+/g, ' ').trim()
  function plain(md) {
    let s = clean(md).replace(/[\u0002\u0003]/g, '')
    s = s.replace(/^```.*$/gm, '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    s = s.replace(/`([^`\n]+)`/g, '$1').replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1').replace(/^\s*[-*+]\s+/gm, '· ').replace(/^\s*>\s?/gm, '')
    s = s.replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    return s.trim()
  }
  const toChars = (s, col, a) => Array.from(String(s), (ch) => ({ ch, col, a }))
  function marked(s, col, hiCol, a = 1, hiA = 1) {
    const out = []; let hi = false
    for (const ch of Array.from(clean(s).replace(/\s+/g, ' '))) {
      if (ch === '\u0002') { hi = true; continue }
      if (ch === '\u0003') { hi = false; continue }
      out.push(hi ? { ch, col: hiCol, a: hiA, hi: true } : { ch, col, a })
    }
    return out
  }
  /** Word wrap an array of {ch} into rows of at most `cols`; the last row ends in … when cut. */
  function wrapChars(cs, cols, maxRows = 99) {
    const rows = []; let row = []
    const push = () => { while (row.length && row[row.length - 1].ch === ' ') row.pop(); rows.push(row); row = [] }
    let i = 0, cut = false
    while (i < cs.length) {
      if (rows.length > maxRows) { cut = true; break }
      if (cs[i].ch === '\n') { push(); i++; continue }
      let j = i; while (j < cs.length && cs[j].ch !== ' ' && cs[j].ch !== '\n') j++
      let word = cs.slice(i, j)
      if (word.length) {
        if (row.length && row.length + word.length > cols) push()
        while (word.length > cols) { if (row.length) push(); rows.push(word.slice(0, cols)); word = word.slice(cols) }
        row.push(...word)
      }
      while (j < cs.length && cs[j].ch === ' ') { if (row.length && row.length < cols) row.push(cs[j]); j++ }
      i = j
    }
    if (row.length) push()
    while (rows.length && !rows[rows.length - 1].length) rows.pop()
    // collapse runs of blank rows
    const out = []
    for (const r of rows) if (r.length || (out.length && out[out.length - 1].length)) out.push(r)
    if (out.length > maxRows || cut) {
      out.length = Math.min(out.length, maxRows)
      const last = out[out.length - 1] || []
      while (last.length > cols - 1) last.pop()
      while (last.length && last[last.length - 1].ch === ' ') last.pop()
      const ref = last[last.length - 1] || cs.find((x) => x.col) || {}
      last.push({ ch: '…', col: ref.col, a: ref.a })
      out[out.length - 1] = last
    }
    return out
  }
  const words = (q) => String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

  // ── glyph atlas: every character is drawn once with fillText, then used as a textured quad ───────

  const Atlas = (() => {
    const SIZE = 2048, EM = 58, PAD = 7
    const FONT = `500 ${EM}px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace`
    const cv = document.createElement('canvas'); cv.width = cv.height = SIZE
    const ctx = cv.getContext('2d')
    ctx.font = FONT
    const adv = ctx.measureText('M').width
    const m = ctx.measureText('Mgjy|')
    const asc = m.fontBoundingBoxAscent || EM * 0.95, desc = m.fontBoundingBoxDescent || EM * 0.26
    const cellW = Math.ceil(adv) + PAD * 2, cellH = Math.ceil(asc + desc) + PAD * 2
    const cols = Math.floor(SIZE / cellW), rows = Math.floor(SIZE / cellH)
    const map = new Map()
    let cx = 0, cy = 0
    const alloc = (span) => { if (cx + span > cols) { cx = 0; cy++ } if (cy >= rows) return null; const at = [cx, cy]; cx += span; return at }
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic'
    const s0 = alloc(1)
    ctx.fillRect(s0[0] * cellW + 2, s0[1] * cellH + 2, cellW - 4, cellH - 4)
    const solid = { u0: (s0[0] * cellW + PAD) / SIZE, v0: (s0[1] * cellH + PAD) / SIZE, u1: (s0[0] * cellW + cellW - PAD) / SIZE, v1: (s0[1] * cellH + cellH - PAD) / SIZE }
    const A = { canvas: cv, solid, dirty: true, advEm: adv / EM, padEm: PAD / EM, hEm: cellH / EM, cellEm: cellW / EM }
    A.get = function (ch) {
      let g = map.get(ch)
      if (g) return g
      ctx.font = FONT
      const w = ctx.measureText(ch).width
      const span = w > adv * 1.45 ? 2 : 1
      const at = alloc(span)
      if (!at) { g = map.get('?') || A.get('?'); map.set(ch, g); return g }
      const x = at[0] * cellW, y = at[1] * cellH
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, cellW * span, cellH); ctx.clip()
      ctx.fillText(ch, x + PAD + Math.max(0, (adv * span - w) / 2), y + PAD + asc)
      ctx.restore()
      g = { u0: x / SIZE, v0: y / SIZE, u1: (x + cellW * span) / SIZE, v1: (y + cellH) / SIZE, span, wEm: (cellW * span) / EM }
      map.set(ch, g)
      A.dirty = true
      return g
    }
    for (let c = 32; c < 127; c++) A.get(String.fromCharCode(c))
    for (const ch of '·…—–’‘“”•◆◇▸›‹→←↑↓↵⌫§¶°×±') A.get(ch)
    return A
  })()

  // ── matrices ─────────────────────────────────────────────────────────────────────────────────────

  function perspective(o, fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f)
    o.fill(0); o[0] = t / asp; o[5] = t; o[10] = (f + n) * nf; o[11] = -1; o[14] = 2 * f * n * nf
    return o
  }
  function lookAt(o, e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0
    o[12] = -(xx * e[0] + xy * e[1] + xz * e[2]); o[13] = -(yx * e[0] + yy * e[1] + yz * e[2]); o[14] = -(zx * e[0] + zy * e[1] + zz * e[2]); o[15] = 1
    return o
  }
  function mul(o, a, b) {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s }
    return o
  }

  // ── geometry: lines, glyph quads and black fills, kept as flat float arrays ──────────────────────

  const EYE = 1.6
  const CWH = 1.6, CH = 4.0, OPEN_H = 3.3          // corridor half width and height; door opening height
  const OCT_A = 4.2, OCT_R = OCT_A / Math.cos(Math.PI / 8), RD = 2 * OCT_A, RH = 4.8   // octagonal chambers: apothem, corner radius, length, height
  const OCT_HALF = OCT_A * Math.tan(Math.PI / 8)    // half a side
  const PLAQUE_SIDES = [7, 1, 6, 2, 5, 3]           // front diagonals first: what you see as you come in
  const FH = 2.7                                    // half width of a door's facade on the atrium wall
  const R_STONE = 5.4, H_ATRIUM = 6.6
  const PW = 2.7, PH = 2.7                          // a plaque
  const SLOTS = PLAQUE_SIDES
  /** Old memories decay: nothing for ten days, then slowly over five months. */
  const decayOf = (at, now) => (at ? Math.pow(clamp((Math.max(0, now - at) / DAY - 10) / 150, 0, 1), 0.85) : 0.8)
  const LINE_F = 16, GLYPH_F = 13, FILL_F = 8

  let LN = [], GLY = [], FL = [], WALLS = [], MAPSEG = [], INTER = []

  const birthAt = (x, z) => 0.4 + Math.min(4.0, Math.pow(Math.hypot(x, z), 0.86) * 0.1)

  function seg(a, b, col, alpha, w = 1.3, birth = null, obj = 0, fx = 0, out = LN) {
    if (out === LN && Math.hypot(a[0], a[2]) > Math.hypot(b[0], b[2])) { const t = a; a = b; b = t }
    if (birth == null) birth = birthAt(a[0], a[2])
    for (let k = 0; k < 4; k++) out.push(a[0], a[1], a[2], b[0], b[1], b[2], k & 1 ? 1 : -1, k >> 1, col[0], col[1], col[2], alpha, w, birth, obj, fx)
  }
  function segs(a, b, col, alpha, w, birth, obj, fx, max = 3) {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / max))
    for (let i = 0; i < n; i++) seg(lerp3(a, b, i / n), lerp3(a, b, (i + 1) / n), col, alpha, w, birth == null ? null : birth + i * 0.02, obj, fx)
  }
  function poly(pts, closed, col, alpha, w, birth, obj, fx) {
    const n = pts.length - (closed ? 0 : 1)
    for (let i = 0; i < n; i++) seg(pts[i], pts[(i + 1) % pts.length], col, alpha, w, birth == null ? null : birth + i * 0.01, obj, fx)
  }
  function fill(tl, tr, bl, br, top, bot = top, birth = null) {
    if (birth == null) birth = birthAt((tl[0] + br[0]) / 2, (tl[2] + br[2]) / 2)
    for (const [p, c] of [[tl, top], [tr, top], [bl, bot], [br, bot]]) FL.push(p[0], p[1], p[2], c[0], c[1], c[2], 1, birth)
  }
  function wall(ax, az, bx, bz, kind = 'wall', wing = -1) { WALLS.push([ax, az, bx, bz]); MAPSEG.push([ax, az, bx, bz, kind, wing]) }

  /** One glyph quad. x, y are in em units inside a text block whose top left is o; r, u span the plane. */
  function glyph(out, ch, o, r, u, x, y, e, col, a, birth, obj, fx, occ) {
    const g = Atlas.get(ch)
    const x0 = (x - Atlas.padEm) * e, y0 = (y - Atlas.padEm) * e, w = g.wEm * e, h = Atlas.hEm * e
    for (let k = 0; k < 4; k++) {
      const dx = x0 + (k & 1 ? w : 0), dy = y0 + (k >> 1 ? h : 0)
      out.push(o[0] + r[0] * dx - u[0] * dy, o[1] + r[1] * dx - u[1] * dy, o[2] + r[2] * dx - u[2] * dy,
        k & 1 ? g.u1 : g.u0, k >> 1 ? g.v1 : g.v0, col[0], col[1], col[2], a, birth, obj, fx, occ)
    }
  }
  function solidQuad(out, tl, tr, bl, br, col, a, occ = 1) {
    const s = Atlas.solid
    const P = [tl, tr, bl, br]
    for (let k = 0; k < 4; k++) { const p = P[k]; out.push(p[0], p[1], p[2], k & 1 ? s.u1 : s.u0, k >> 1 ? s.v1 : s.v0, col[0], col[1], col[2], a, -1, 0, 0, occ) }
  }
  /**
   * Rows of {ch, col, a} from the top-left o. Old text (decay > 0) loses letters toward the edges of the
   * block, and the ones about to go sag a little: Eternal Sunshine, one plaque at a time.
   */
  function emit(out, rows, o, r, u, opt) {
    const e = opt.em, lh = opt.lh ?? 1.3, adv = Atlas.advEm
    const cols = opt.cols ?? Math.max(1, ...rows.map((row) => row.length))
    const decay = opt.decay ?? 0, seed = opt.seed ?? 1, nRows = opt.rowsTotal ?? rows.length, row0 = opt.row0 ?? 0
    const spread = opt.spread ?? 1.2
    let n = 0
    for (let ri = 0; ri < rows.length; ri++) {
      let c = 0
      for (const g of rows[ri]) {
        const ch = g.ch
        const span = ch.charCodeAt(0) < 128 ? 1 : Atlas.get(ch).span
        if (ch !== ' ') {
          let alpha = (g.a ?? opt.alpha ?? 1), dy = 0
          if (decay > 0.03) {
            const uu = cols > 1 ? c / (cols - 1) : 0.5
            const vv = nRows > 1 ? (ri + row0) / (nRows - 1) : 0.5
            const edge = Math.max(Math.abs(uu * 2 - 1), Math.abs(vv * 2 - 1) * 0.5)
            const rnd = hash3(seed, ri + row0, c)
            const lose = decay < 0.15 ? 0 : Math.pow(decay, 1.7) * (sstep(0.55, 1.0, edge) * 1.3 + 0.02)
            if (rnd < lose) { c += span; continue }
            if (rnd < lose * 1.7) dy = ((lose * 1.7 - rnd) / (lose * 0.7 + 1e-4)) * 0.22 * decay
            alpha *= (1 - 0.45 * decay) * (1 - 0.45 * edge * decay)
          }
          const birth = (opt.birth ?? 0) + Math.min(spread, n * (opt.step ?? 0))
          glyph(out, ch, o, r, u, c * adv, ri * lh + dy, e, g.col ?? opt.color ?? COL.ink, alpha, birth, opt.obj ?? 0, opt.fx ?? 0, opt.occ ?? 0)
          n++
        }
        c += span
      }
    }
    return rows.length * lh * e
  }
  const at3 = (o, r, u, x, y) => [o[0] + r[0] * x + u[0] * y, o[1] + r[1] * x + u[1] * y, o[2] + r[2] * x + u[2] * y]
  const colsFor = (width, em) => Math.max(4, Math.floor(width / (em * Atlas.advEm)))

  // ── the palace, built from the snapshot ──────────────────────────────────────────────────────────

  const KIND_ORDER = ['you', 'project', 'reference', 'note', 'summary', 'instructions']
  const KIND_TITLE = { you: 'how you want it', project: 'the work', reference: 'where things are', note: 'notes', summary: 'what they keep', instructions: 'what you told it' }

  function cleanAsk(t) {
    let s = oneLine(t)
    s = s.replace(/^(\[(Image|Pasted text|File)[^\]]*\]\s*)+/i, '').replace(/^\/goal\s+/i, '').trim()
    return s
  }
  const usefulAsk = (s) => s.length >= 14 && !/^[<{[]/.test(s) && !/^(continue|continuing|ok|okay|yes|no|thanks|thank you|hi|hello)\b.{0,12}$/i.test(s)

  let WORLD = null

  function buildWorld(data) {
    LN = []; GLY = []; FL = []; WALLS = []; MAPSEG = []; INTER = []
    const NOW = Date.now()
    const snap = data.snapshot || {}
    const memories = (Array.isArray(snap.memories) ? snap.memories : []).filter((m) => m && m.id)
    const agentOf = (id) => MemoryData.agent(id, snap)
    const W = { NOW, snap, data, agentOf, memInter: new Map(), stones: [], inscriptions: new Map(), reverse: new Map() }

    // About You: one standing stone per section
    const sections = []
    for (const line of snap.about?.lines ?? []) {
      if (!line || !line.text) continue
      let s = sections.find((x) => x.name === (line.section || 'About you'))
      if (!s) sections.push((s = { name: line.section || 'About you', lines: [] }))
      s.lines.push({ ...line, mems: MemoryData.refs(line, snap) })
    }
    if (!sections.length) sections.push({ name: 'About you', empty: true, lines: [{ text: 'Nothing here yet. About You writes itself from your messages as you work.', refs: [], mems: [] }] })
    sections.forEach((sec, k) => sec.lines.forEach((line, li) => line.mems.forEach((m) => {
      if (!W.reverse.has(m.id)) W.reverse.set(m.id, [])
      W.reverse.get(m.id).push({ k, li, text: line.text, section: sec.name })
    })))
    W.sections = sections

    // wings: projects by activity, then the halls
    const byId = new Map(memories.map((m) => [m.id, m]))
    const placed = new Set()
    const projects = []
    for (const p of snap.projects ?? []) {
      const mems = (p.memories ?? []).map((id) => byId.get(id)).filter((m) => m && !placed.has(m.id))
      mems.forEach((m) => placed.add(m.id))
      projects.push({ kind: 'project', key: 'p:' + (p.key || p.name), name: p.name || 'project', path: p.path || '', mems, asks: [], sessions: p.sessions || 0, askCount: p.asks || 0, lastAt: p.lastAt || 0 })
    }
    for (const m of memories) {
      if (placed.has(m.id) || !m.project) continue
      let w = projects.find((x) => x.name === m.project.name)
      if (!w) projects.push((w = { kind: 'project', key: 'p:' + m.project.name, name: m.project.name || 'project', path: m.project.path || '', mems: [], asks: [], sessions: 0, askCount: 0, lastAt: 0 }))
      w.mems.push(m); placed.add(m.id)
    }
    const asks = (data.asks ?? []).filter((a) => a && a.text)
    const loose = []
    for (const a of asks) {
      const cwd = String(a.cwd || '')
      const w = cwd && projects.find((p) => (p.path && (cwd === p.path || cwd.startsWith(p.path + '/'))) ||
        (p.name.length >= 4 && (cwd.endsWith('/' + p.name) || cwd.includes('/' + p.name + '/'))))
      if (w) w.asks.push(a); else loose.push(a)
    }
    const newest = (w) => Math.max(w.lastAt || 0, ...w.mems.map((m) => m.modified || 0), ...w.asks.slice(0, 1).map((a) => a.at || 0))
    const score = (w) => w.askCount + w.sessions * 6 + w.asks.length
    projects.sort((a, b) => score(b) - score(a) || b.mems.length - a.mems.length || newest(b) - newest(a))
    if (projects.length > 16) {
      const rest = projects.splice(15)
      projects.push({ kind: 'project', groupBy: 'project', key: 'p:elsewhere', name: `${rest.length} more projects`, path: '', mems: rest.flatMap((w) => w.mems), asks: rest.flatMap((w) => w.asks), sessions: rest.reduce((s, w) => s + w.sessions, 0), askCount: rest.reduce((s, w) => s + w.askCount, 0), lastAt: Math.max(0, ...rest.map((w) => w.lastAt)) })
    }
    const globalNotes = memories.filter((m) => !placed.has(m.id) && m.kind !== 'instructions')
    const told = memories.filter((m) => !placed.has(m.id) && m.kind === 'instructions')
    const halls = []
    if (globalNotes.length) halls.push({ kind: 'notes', key: 'h:notes', name: "agents' notes", mems: globalNotes, asks: [], sessions: 0, askCount: 0, lastAt: 0 })
    const said = pickWords(loose.length >= 12 ? loose : asks, NOW)
    if (said.length) halls.push({ kind: 'words', key: 'h:words', name: 'your words', mems: [], asks: [], wordRooms: said, sessions: 0, askCount: 0, lastAt: (loose[0] || asks[0])?.at || 0 })
    if (told.length) halls.push({ kind: 'told', key: 'h:told', name: 'what you told them', mems: told, asks: [], sessions: 0, askCount: 0, lastAt: 0 })
    const wings = [...projects, ...halls]

    const maxScore = Math.max(1, ...projects.map(score))
    for (const w of wings) {
      w.label = middle(w.name, 28)
      w.rooms = roomsFor(w, agentOf)
      const last = newest(w) || Math.max(0, ...(w.wordRooms ?? []).flatMap((r) => r.items.map((it) => it.a.at || 0)))
      w.last = last
      const days = last ? Math.max(0, NOW - last) / DAY : 365
      w.staleF = clamp(Math.log1p(days) / Math.log1p(120), 0, 1)
      w.act = w.kind === 'project'
        ? (score(w) > 0 ? 0.18 + 0.82 * Math.log1p(score(w)) / Math.log1p(maxScore) : 0.12 + 0.2 * Math.min(1, w.mems.length / 10))
        : 0.45 + 0.35 * (1 - w.staleF)
    }

    // the plan: n spokes around a round atrium
    const K = sections.length, n = wings.length
    const R = n ? Math.max(13.5, FH / Math.sin((Math.PI / Math.max(n, 3)) * 0.82)) : 13.5
    const sMin = n >= 3 ? OCT_R / Math.tan(Math.PI / n) + 1.8 : 18
    W.R = R; W.K = K; W.wings = wings
    wings.forEach((w, i) => {
      w.i = i
      w.theta = Math.PI / Math.max(K, 1) + (i * TAU) / Math.max(n, 1)
      w.d = [Math.sin(w.theta), -Math.cos(w.theta)]
      w.r = [Math.cos(w.theta), Math.sin(w.theta)]
      w.alpha = Math.asin(FH / R)
      w.s0 = R * Math.cos(w.alpha)
      w.s1 = Math.max(w.s0 + 7 + 21 * w.staleF, sMin)
      w.sEnd = w.s1 + RD * w.rooms.length
    })
    W.alpha = Math.asin(FH / R)
    WORLD = W

    buildAtrium(W)
    for (const w of wings) buildWing(W, w)
    let maxR = R
    for (const w of wings) maxR = Math.max(maxR, w.sEnd + 2)
    W.extent = maxR
    const xs = MAPSEG.flatMap((m) => [m[0], m[2]]), zs = MAPSEG.flatMap((m) => [m[1], m[3]])
    W.bounds = { x0: Math.min(...xs, -R) - 3, x1: Math.max(...xs, R) + 3, z0: Math.min(...zs, -R) - 3, z1: Math.max(...zs, R) + 3 }
    return W
  }

  function roomsFor(w, agentOf) {
    if (w.kind === 'words') return w.wordRooms
    const groups = new Map()
    const keyOf = w.kind === 'notes' ? (m) => m.agent : w.groupBy === 'project' ? (m) => m.project?.name || 'elsewhere' : (m) => (KIND_ORDER.includes(m.kind) ? m.kind : m.kind || 'note')
    for (const m of w.mems) { const k = keyOf(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m) }
    let keys = [...groups.keys()]
    if (w.kind === 'project' && w.groupBy !== 'project') keys.sort((a, b) => (KIND_ORDER.indexOf(a) + 99 * (KIND_ORDER.indexOf(a) < 0)) - (KIND_ORDER.indexOf(b) + 99 * (KIND_ORDER.indexOf(b) < 0)))
    else keys.sort((a, b) => groups.get(b).length - groups.get(a).length)
    const rooms = []
    for (const k of keys) {
      const list = groups.get(k).sort((a, b) => (b.modified || 0) - (a.modified || 0))
      const title = w.kind === 'notes' ? agentOf(k).name : w.kind === 'told' ? 'the rules' : w.groupBy === 'project' ? middle(k, 22) : (KIND_TITLE[k] || k)
      const parts = Math.ceil(list.length / SLOTS.length)
      for (let p = 0; p < parts; p++) rooms.push({ title, part: p + 1, parts, items: list.slice(p * SLOTS.length, (p + 1) * SLOTS.length).map((m) => ({ type: 'memory', m })) })
    }
    if (!rooms.length) rooms.push({ title: 'empty', part: 1, parts: 1, items: [] })
    return rooms
  }

  /** Your own words, by time: today, yesterday, this week… each room a stretch of time. */
  function pickWords(list, now) {
    const seen = new Set(), picked = []
    for (const a of list) {
      const text = cleanAsk(a.text)
      if (!usefulAsk(text)) continue
      const key = text.toLowerCase().slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key); picked.push({ a, text })
    }
    picked.sort((x, y) => (y.a.at || 0) - (x.a.at || 0))
    const startOf = (at) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime() }
    const today0 = startOf(now)
    const bucketOf = (at) => {
      const back = Math.round((today0 - startOf(at)) / DAY)
      if (back <= 0) return 'today'
      if (back === 1) return 'yesterday'
      if (back < 7) return 'this week'
      if (back < 14) return 'last week'
      if (back < 31) return 'this month'
      return new Date(at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toLowerCase()
    }
    const buckets = new Map()
    for (const it of picked) { const b = bucketOf(it.a.at || now); if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(it) }
    const rooms = []
    for (const [title, items] of buckets) {
      const pick = []
      const step = items.length / SLOTS.length
      for (let i = 0; i < Math.min(SLOTS.length, items.length); i++) pick.push(items[Math.floor(i * Math.max(1, step))])
      rooms.push({ title, part: 1, parts: 1, said: items.length, items: pick.map((it) => ({ type: 'ask', a: it.a, text: it.text })) })
      if (rooms.length >= 8) break
    }
    return rooms
  }

  const polar = (r, a, y = 0) => [r * Math.sin(a), y, -r * Math.cos(a)]
  const WP = (w, s, t, y) => [s * w.d[0] + t * w.r[0], y, s * w.d[1] + t * w.r[1]]

  const FILL = {
    wallTop: [0.004, 0.011, 0.017], wallBot: [0.016, 0.036, 0.05], floor: [0.006, 0.016, 0.024], ceil: [0.002, 0.005, 0.008],
    stone: [0.03, 0.022, 0.013], stoneTop: [0.012, 0.009, 0.006],
  }

  function buildAtrium(W) {
    const { R, K, wings } = W
    const rand = rng(7)
    // floor
    const steps = 96
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * TAU, a1 = ((i + 1) / steps) * TAU
      for (const [r0, r1] of [[0, R * 0.5], [R * 0.5, R + 0.4]]) fill(polar(r1, a0), polar(r1, a1), polar(r0, a0), polar(r0, a1), FILL.floor, FILL.floor, 0.2)
    }
    // Westworld's maze in the floor, with you at its centre
    const self = COL.self
    const rings = [0.85, 1.5, 2.15, 2.8, 3.45, 4.1]
    rings.forEach((r, ri) => {
      const gaps = [rand() * TAU, rand() * TAU]
      const gw = 0.42 / r
      const nSeg = Math.ceil(r * 14)
      for (let s = 0; s < nSeg; s++) {
        const a0 = (s / nSeg) * TAU, a1 = ((s + 1) / nSeg) * TAU, am = (a0 + a1) / 2
        if (gaps.some((g) => Math.abs(angWrap(am - g)) < gw)) continue
        seg(polar(r, a0, 0.012), polar(r, a1, 0.012), self, 0.42 - ri * 0.035, 1.2, 0.15 + r * 0.16)
      }
      if (ri < rings.length - 1) for (let j = 0; j < 2; j++) { const a = rand() * TAU; seg(polar(r, a, 0.012), polar(rings[ri + 1], a, 0.012), self, 0.34, 1.2, 0.2 + r * 0.16) }
    })
    poly(Array.from({ length: 24 }, (_, i) => polar(0.32, (i / 24) * TAU, 0.012)), true, self, 0.8, 1.6, 0.1)
    const you = toChars('you', self, 0.85)
    emit(GLY, [you], [-(3 * Atlas.advEm * 0.11) / 2, 0.015, -0.6], [1, 0, 0], [0, 0, -1], { em: 0.11, birth: 0.3 })
    // the light at the centre, up through the oculus
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU
      seg(polar(0.2, a, 0.0), polar(0.2, a, 4.5), self, 0.3, 1.0, 0.5)
      seg(polar(0.2, a, 4.5), polar(0.14, a, H_ATRIUM + 7.5), self, 0.18, 1.0, 0.9)
    }
    // floor rings and a lit path from the stones to every door
    for (const r of [R_STONE + 0.95, R - 0.7]) poly(Array.from({ length: 96 }, (_, i) => polar(r, (i / 96) * TAU, 0.01)), true, COL.struct, 0.16, 1.1, null)
    for (const w of wings) {
      segs(polar(R_STONE + 0.95, w.theta, 0.012), polar(w.s0 - 0.05, w.theta, 0.012), COL.struct, 0.12 + 0.35 * w.act, 1.3, null, 0, 0, 2)
      for (const off of [-0.5, 0.5]) segs(WP(w, R - 0.7, off, 0.012), WP(w, w.s0, off, 0.012), COL.struct, 0.1 + 0.25 * w.act, 1.0, null, 0, 0, 2)
    }

    // the wall: arcs between the doors, a flat facade for each door
    const H = H_ATRIUM
    const arc = (a0, a1) => {
      const m = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (5 * DEG)))
      const pts = []
      for (let i = 0; i <= m; i++) pts.push(lerp(a0, a1, i / m))
      for (let i = 0; i < m; i++) {
        const p = polar(R, pts[i]), q = polar(R, pts[i + 1])
        fill([p[0], H, p[2]], [q[0], H, q[2]], [p[0], 0, p[2]], [q[0], 0, q[2]], FILL.wallTop, FILL.wallBot)
        wall(p[0], p[2], q[0], q[2], 'wall')
        for (const [y, a] of [[0.02, 0.55], [H, 0.5], [0.95, 0.16], [H - 0.5, 0.2]]) seg(polar(R, pts[i], y), polar(R, pts[i + 1], y), COL.struct, a, 1.2)
      }
      for (let i = 0; i <= m; i += 2) segs(polar(R, pts[i], 0), polar(R, pts[i], H), COL.struct, i === 0 || i === m ? 0.5 : 0.22, 1.1, null, 0, 0, 1.5)
    }
    if (!wings.length) arc(0, TAU)
    wings.forEach((w, i) => {
      const next = wings[(i + 1) % wings.length]
      let a1 = next.theta - next.alpha
      if (i === wings.length - 1) a1 += TAU
      if (a1 > w.theta + w.alpha + 0.001) arc(w.theta + w.alpha, a1)
      buildFacade(W, w)
    })

    // the dome
    const mer = 32
    for (let i = 0; i < mer; i++) {
      const a = (i / mer) * TAU
      const pts = []
      for (let j = 0; j <= 12; j++) { const u = (j / 12) * 0.9; pts.push(polar(R * Math.cos((u * Math.PI) / 2) + 0.01, a, H + (R - 3) * 0.62 * Math.sin((u * Math.PI) / 2))) }
      for (let j = 0; j < 12; j++) seg(pts[j], pts[j + 1], COL.struct, 0.2 - j * 0.008, 1.0, 1.2 + j * 0.09)
    }
    for (const u of [0.3, 0.6, 0.9]) {
      const r = R * Math.cos((u * Math.PI) / 2) + 0.01, y = H + (R - 3) * 0.62 * Math.sin((u * Math.PI) / 2)
      poly(Array.from({ length: 64 }, (_, i) => polar(r, (i / 64) * TAU, y)), true, COL.struct, u === 0.9 ? 0.42 : 0.14, 1.0, 1.3 + u * 1.2)
    }

    buildStones(W)
  }

  function buildFacade(W, w) {
    const H = H_ATRIUM, s = w.s0
    const top = FILL.wallTop, bot = FILL.wallBot
    const P = (t, y) => WP(w, s, t, y)
    fill(P(-FH, H), P(-CWH, H), P(-FH, 0), P(-CWH, 0), top, bot)
    fill(P(CWH, H), P(FH, H), P(CWH, 0), P(FH, 0), top, bot)
    fill(P(-CWH, H), P(CWH, H), P(-CWH, OPEN_H), P(CWH, OPEN_H), top, top)
    const a = P(-FH, 0), b = P(-CWH, 0), c = P(CWH, 0), d = P(FH, 0)
    wall(a[0], a[2], b[0], b[2], 'wall', w.i); wall(c[0], c[2], d[0], d[2], 'wall', w.i)
    const k = 0.25 + 0.75 * w.act
    const obj = INTER.length + 1
    // edges, the opening, a frame around it and a sign board above it
    for (const y of [0.02, H]) seg(P(-FH, y), P(FH, y), COL.struct, 0.5, 1.2)
    for (const y of [0.95, H - 0.5]) { seg(P(-FH, y), P(-CWH - 0.25, y), COL.struct, 0.18, 1.1); seg(P(CWH + 0.25, y), P(FH, y), COL.struct, 0.18, 1.1) }
    for (const t of [-FH, FH]) seg(P(t, 0), P(t, H), COL.struct, 0.5, 1.2)
    poly([P(-CWH, 0), P(-CWH, OPEN_H), P(CWH, OPEN_H), P(CWH, 0)], false, COL.struct, 0.35 + 0.6 * k, 1.6, null, obj)
    poly([P(-CWH - 0.25, 0), P(-CWH - 0.25, OPEN_H + 0.25), P(CWH + 0.25, OPEN_H + 0.25), P(CWH + 0.25, 0)], false, COL.struct, 0.15 + 0.35 * k, 1.1, null, obj)
    const by0 = OPEN_H + 0.4, by1 = OPEN_H + 2.05
    poly([P(-FH + 0.25, by0), P(FH - 0.25, by0), P(FH - 0.25, by1), P(-FH + 0.25, by1)], true, COL.struct, 0.12 + 0.4 * k, 1.1, null, obj)
    // the sign: name, then how much you work there
    const n = [-w.d[0], 0, -w.d[1]], r = [w.r[0], 0, w.r[1]], u = [0, 1, 0]
    const name = w.label
    const em = Math.min(0.46, (2 * FH - 0.9) / (Array.from(name).length * Atlas.advEm))
    const nameW = Array.from(name).length * Atlas.advEm * em
    const ink = mixc(COL.label, COL.struct, 0.25)
    const birth = birthAt(P(0, 0)[0], P(0, 0)[2]) + 0.4
    const o1 = at3(P(0, by1 - 0.22), r, u, -nameW / 2, 0); o1[0] += n[0] * 0.03; o1[2] += n[2] * 0.03
    emit(GLY, [toChars(name, ink, 0.45 + 0.55 * k)], o1, r, u, { em, birth, step: 0.02, obj })
    const stats = w.kind === 'words'
      ? [`${fmt(w.rooms.reduce((s, x) => s + (x.said || x.items.length), 0))} things you said`, `newest ${ago(w.last, WORLD.NOW)}`]
      : [`${fmt(w.mems.length)} memories` + (w.kind === 'project' ? ` · ${fmt(w.sessions)} sessions · ${fmt(w.askCount)} asks` : ''),
        w.kind === 'project' ? (w.lastAt ? `last here ${ago(w.lastAt, WORLD.NOW)}` : 'no sessions here') : `newest ${ago(w.last, WORLD.NOW)}`]
    stats.forEach((line, li) => {
      const e2 = Math.min(0.13, (2 * FH - 0.9) / (line.length * Atlas.advEm))
      const lw = line.length * Atlas.advEm * e2
      const o2 = at3(P(0, by1 - 0.34 - em * 1.3 - li * 0.21), r, u, -lw / 2, 0); o2[0] += n[0] * 0.03; o2[2] += n[2] * 0.03
      emit(GLY, [toChars(line, COL.label, 0.3 + 0.35 * k)], o2, r, u, { em: e2, birth: birth + 0.3, step: 0.01, obj })
    })
    INTER.push({ id: obj, kind: 'door', wing: w, at: 'facade', c: P(0, 1.65), n, rt: r, hw: CWH, hh: 1.65, twoSided: true, reach: 46, color: COL.struct, label: w.label })
  }

  function buildStones(W) {
    const { K, sections } = W
    const ws = Math.min(3.6, ((TAU * R_STONE) / K) * 0.6)
    const adv = Atlas.advEm
    sections.forEach((sec, k) => {
      const phi = (k * TAU) / K
      const dir = [Math.sin(phi), -Math.cos(phi)]
      const n = [-dir[0], 0, -dir[1]], rt = [n[2], 0, -n[0]], up = [0, 1, 0]
      const cx = dir[0] * R_STONE, cz = dir[1] * R_STONE
      const obj = INTER.length + 1
      // lay the text out first; the stone is as tall as what it says
      const uw = ws - 0.42
      let em = 0.128, layout
      for (let tries = 0; tries < 8; tries++) {
        const cols = colsFor(uw, em)
        const blocks = sec.lines.map((line) => {
          const cites = (line.refs ?? []).length
          const body = wrapChars(toChars(oneLine(line.text), COL.self, 0.92), cols - 2, 6)
          const rows = body.map((row, ri) => [...toChars(ri === 0 ? '· ' : '  ', COL.self, 0.5), ...row])
          if (cites) {
            const mark = toChars(` [${cites}]`, mixc(COL.self, COL.dust, 0.4), 0.45)
            const last = rows[rows.length - 1]
            if (last.length + mark.length <= cols) last.push(...mark); else rows.push([...toChars('  ', COL.self, 0), ...mark.slice(1)])
          }
          return rows
        })
        const rowsN = blocks.reduce((s, b) => s + b.length, 0)
        const h = 0.3 + 0.075 * 1.4 + 0.1 + 0.165 * 1.35 + 0.16 + rowsN * em * 1.3 + (blocks.length - 1) * em * 0.55 + 0.42 + (k === 0 ? 0.22 : 0)
        layout = { cols, blocks, h }
        if (h <= 4.15) break
        em *= 0.92
      }
      const hs = Math.max(3.1, layout.h + 0.25)
      const front = (t, y) => [cx + rt[0] * t, y, cz + rt[2] * t]
      const back = (t, y) => [cx + rt[0] * t + dir[0] * 0.5, y, cz + rt[2] * t + dir[1] * 0.5]
      const hw = ws / 2
      const bt = 0.75 + k * 0.12
      fill(front(-hw, hs), front(hw, hs), front(-hw, 0), front(hw, 0), FILL.stone, mixc(FILL.stone, [0.05, 0.035, 0.02], 0.6), bt)
      fill(back(hw, hs), back(-hw, hs), back(hw, 0), back(-hw, 0), FILL.stoneTop, FILL.stone, bt)
      fill(front(-hw, hs), back(-hw, hs), front(-hw, 0), back(-hw, 0), FILL.stoneTop, FILL.stone, bt)
      fill(front(hw, hs), back(hw, hs), front(hw, 0), back(hw, 0), FILL.stoneTop, FILL.stone, bt)
      fill(back(-hw, hs), back(hw, hs), front(-hw, hs), front(hw, hs), FILL.stoneTop, FILL.stoneTop, bt)
      const fp = [front(-hw, 0), front(hw, 0), back(hw, 0), back(-hw, 0)]
      for (let i = 0; i < 4; i++) wall(fp[i][0], fp[i][2], fp[(i + 1) % 4][0], fp[(i + 1) % 4][2], 'stone')
      const b0 = 0.55 + k * 0.12
      poly([front(-hw, 0.01), front(-hw, hs), front(hw, hs), front(hw, 0.01)], false, COL.self, 0.75, 1.5, b0, obj)
      poly([back(-hw, hs), back(hw, hs)], false, COL.self, 0.3, 1.1, b0 + 0.2, obj)
      seg(front(-hw, hs), back(-hw, hs), COL.self, 0.35, 1.1, b0 + 0.2, obj); seg(front(hw, hs), back(hw, hs), COL.self, 0.35, 1.1, b0 + 0.2, obj)
      seg(back(-hw, 0), back(-hw, hs), COL.self, 0.12, 1.0, b0 + 0.3, obj); seg(back(hw, 0), back(hw, hs), COL.self, 0.12, 1.0, b0 + 0.3, obj)
      poly([front(-hw + 0.1, 0.3), front(-hw + 0.1, hs - 0.1), front(hw - 0.1, hs - 0.1), front(hw - 0.1, 0.3)], true, COL.self, 0.22, 1.0, b0 + 0.3, obj)
      seg(front(-hw, 0.3), front(hw, 0.3), COL.self, 0.3, 1.0, b0 + 0.3, obj)
      // the carving
      const o = [cx + rt[0] * (-hw + 0.21) + n[0] * 0.012, hs - 0.3, cz + rt[2] * (-hw + 0.21) + n[2] * 0.012]
      let y = 0
      const tb = 1.0 + k * 0.16
      const step = Math.min(0.0016, 1.5 / Math.max(1, layout.blocks.flat().flat().length))
      y += emit(GLY, [toChars('about you', COL.self, 0.42)], o, rt, up, { em: 0.075, birth: tb, obj }) + 0.1 * 1
      y += emit(GLY, [toChars(sec.name.toUpperCase(), mixc(COL.self, COL.white, 0.35), 1)], at3(o, rt, up, 0, -y), rt, up, { em: 0.165, birth: tb + 0.05, step: 0.02, obj }) + 0.16
      let gi = 0
      for (const rows of layout.blocks) {
        y += emit(GLY, rows, at3(o, rt, up, 0, -y), rt, up, { em, birth: tb + 0.25 + gi * step, step, spread: 1.6, obj }) + em * 0.55
        gi += rows.flat().length
      }
      if (k === 0 && W.snap.about?.intro) {
        const intro = oneLine(W.snap.about.intro)
        const e3 = 0.07
        emit(GLY, wrapChars(toChars(intro, COL.self, 0.38), colsFor(uw, e3), 2), [o[0], 0.62, o[2]], rt, up, { em: e3, birth: tb + 1.2, obj })
      }
      const it = { id: obj, kind: 'stone', k, sec, c: [cx, hs / 2, cz], n, rt, hw, hh: hs / 2, reach: 14, color: COL.self, label: sec.name,
        view: { x: dir[0] * (R_STONE - 4.0), z: dir[1] * (R_STONE - 4.0), yaw: phi, wing: null } }
      INTER.push(it); W.stones.push(it)
    })
  }

  function buildWing(W, w) {
    const k = 0.25 + 0.75 * w.act
    const sc = COL.struct
    const P = (s, t, y) => WP(w, s, t, y)
    const wq = (s0, t0, s1, t1, y0, y1, top = FILL.wallTop, bot = FILL.wallBot, collide = true) => {
      fill(P(s0, t0, y1), P(s1, t1, y1), P(s0, t0, y0), P(s1, t1, y0), top, bot)
      if (collide && y0 === 0) { const a = P(s0, t0, 0), b = P(s1, t1, 0); wall(a[0], a[2], b[0], b[2], 'wall', w.i) }
    }
    // corridor
    const s0 = w.s0, s1 = w.s1
    wq(s0, -CWH, s1, -CWH, 0, CH); wq(s0, CWH, s1, CWH, 0, CH)
    fill(P(s0, -CWH, CH), P(s1, -CWH, CH), P(s0, CWH, CH), P(s1, CWH, CH), FILL.ceil)
    fill(P(s0, -CWH, 0), P(s1, -CWH, 0), P(s0, CWH, 0), P(s1, CWH, 0), FILL.floor)
    for (const t of [-CWH, CWH]) { segs(P(s0, t, 0.02), P(s1, t, 0.02), sc, 0.35 + 0.35 * k, 1.2); segs(P(s0, t, CH), P(s1, t, CH), sc, 0.25 + 0.35 * k, 1.2) }
    for (const t of [-0.55, 0.55]) segs(P(s0, t, 0.012), P(s1, t, 0.012), sc, 0.06 + 0.22 * k, 1.1)
    for (let s = s0 + 1.2; s < s1 - 0.5; s += 2.4) {
      const ri = 0.12 + 0.55 * k
      seg(P(s, -CWH, 0), P(s, -CWH, CH), sc, ri, 1.2); seg(P(s, CWH, 0), P(s, CWH, CH), sc, ri, 1.2)
      seg(P(s, -CWH, CH), P(s, CWH, CH), sc, ri * 0.8, 1.2); seg(P(s, -CWH, 0.012), P(s, CWH, 0.012), sc, ri * 0.35, 1.0)
    }
    // your words along the corridor walls, faint
    const said = []
    const seen = new Set()
    for (const a of w.asks) { const text = cleanAsk(a.text); if (!usefulAsk(text)) continue; const key = text.toLowerCase().slice(0, 60); if (seen.has(key)) continue; seen.add(key); said.push({ a, text, n: 1 }) }
    const nSlots = Math.max(0, Math.floor((s1 - s0 - 3.2) / 3.5)) * 2
    said.slice(0, nSlots).forEach((it, j) => {
      const side = j % 2 === 0 ? -1 : 1
      const s = s0 + 2.6 + Math.floor(j / 2) * 3.5
      const t = side * (CWH - 0.02)
      const n = [-side * w.r[0], 0, -side * w.r[1]]
      const rt = [n[2], 0, -n[0]], up = [0, 1, 0]
      const c = P(s, t, 2.05)
      const obj = INTER.length + 1
      const decay = decayOf(it.a.at, W.NOW)
      const em = 0.105, pw = 2.5
      const rows = wrapChars(toChars(it.text, COL.words, 0.62 * (1 - decay * 0.4)), colsFor(pw, em), 4)
      const o = at3(c, rt, up, -pw / 2, 0.45)
      const hgt = emit(GLY, rows, o, rt, up, { em, decay, seed: obj * 31, obj, birth: birthAt(c[0], c[2]) + 0.4, step: 0.004 })
      emit(GLY, [toChars(`you said · ${shortDate(it.a.at)}`, COL.words, 0.35)], at3(o, rt, up, 0, -hgt - 0.08), rt, up, { em: 0.065, obj, birth: birthAt(c[0], c[2]) + 0.6 })
      const v = P(s, -side * 0.5, 0)
      const item = { id: obj, kind: 'ask', a: it.a, text: it.text, wing: w, c, n, rt, hw: pw / 2, hh: 0.55, reach: 6, color: COL.words, label: it.text.slice(0, 40),
        view: { x: v[0], z: v[2], yaw: Math.atan2(-n[0], n[2]), wing: w, s } }
      INTER.push(item)
      W.inscriptions.set(`${it.a.engine}|${it.a.at}`, item)
    })

    // chambers: octagons one after another down the spoke, each sharing a door with the next
    const nR = w.rooms.length
    const ra = 0.3 + 0.3 * k
    for (let ri = 0; ri <= nR; ri++) {
      const s = s1 + ri * RD
      const solid = ri === nR
      const up = [0, 1, 0]
      if (solid) wq(s, -OCT_HALF, s, OCT_HALF, 0, RH)
      else {
        wq(s, -OCT_HALF, s, -CWH, 0, RH); wq(s, CWH, s, OCT_HALF, 0, RH)
        fill(P(s, -CWH, RH), P(s, CWH, RH), P(s, -CWH, OPEN_H), P(s, CWH, OPEN_H), FILL.wallTop, FILL.wallTop)
        const obj = INTER.length + 1
        poly([P(s, -CWH, 0), P(s, -CWH, OPEN_H), P(s, CWH, OPEN_H), P(s, CWH, 0)], false, sc, 0.45 + 0.4 * k, 1.5, null, obj)
        const room = w.rooms[ri]
        INTER.push({ id: obj, kind: 'door', wing: w, at: 'room', room: ri, c: P(s, 0, 1.65), n: [-w.d[0], 0, -w.d[1]], rt: [w.r[0], 0, w.r[1]], hw: CWH, hh: 1.65, twoSided: true, reach: 34, color: sc,
          label: `${room.title}${room.parts > 1 ? ` ${room.part}/${room.parts}` : ''}` })
        // the chamber's name above its door, seen as you come
        const title = `${room.title}${room.parts > 1 ? `  ${room.part}/${room.parts}` : ''}`
        const em = Math.min(0.2, (2 * CWH - 0.3) / (Array.from(title).length * Atlas.advEm))
        const tw = Array.from(title).length * Atlas.advEm * em
        const r = [w.r[0], 0, w.r[1]]
        const o = at3(P(s - 0.03, 0, OPEN_H + 0.12 + em * 1.25), r, up, -tw / 2, 0)
        emit(GLY, [toChars(title, COL.label, 0.75)], o, r, up, { em, obj, birth: birthAt(o[0], o[2]) + 0.3, step: 0.02 })
        // and on the way back, where it leads
        const back = ri === 0 ? '‹ atrium' : `‹ ${w.rooms[ri - 1].title}`
        const e2 = 0.1, bw = Array.from(back).length * Atlas.advEm * e2
        const rb = [-w.r[0], 0, -w.r[1]]
        emit(GLY, [toChars(back, COL.label, 0.4)], at3(P(s + 0.03, 0, OPEN_H + 0.3), rb, up, -bw / 2, 0), rb, up, { em: e2, birth: birthAt(o[0], o[2]) + 0.4 })
      }
      if (solid) continue
      const scn = s + OCT_A
      const corner = (q, y) => { const ph = (q * Math.PI) / 4 - Math.PI / 8; return P(scn + OCT_R * Math.cos(ph), OCT_R * Math.sin(ph), y) }
      const apex = P(scn, 0, RH + 1.4), mid = P(scn, 0, 0)
      for (let q = 0; q < 8; q++) {
        const a = corner(q, 0), b = corner(q + 1, 0), at = corner(q, RH), bt = corner(q + 1, RH)
        if (q !== 0 && q !== 4) { fill(at, bt, a, b, FILL.wallTop, FILL.wallBot); wall(a[0], a[2], b[0], b[2], 'wall', w.i) }
        fill(a, b, mid, mid, FILL.floor)
        fill(at, bt, apex, apex, FILL.ceil)
        seg(corner(q, 0.02), corner(q + 1, 0.02), sc, ra + 0.1, 1.2)
        seg(at, bt, sc, ra * 0.85, 1.2)
        segs(corner(q, 0), corner(q, RH), sc, ra, 1.2, null, 0, 0, 1.6)
        segs(at, apex, sc, ra * 0.45, 1.1, null, 0, 0, 1.2)
        segs(P(scn, 0, 0.01), corner(q, 0.01), sc, 0.05 + 0.06 * k, 1.0, null, 0, 0, 1.5)
      }
      for (const f of [0.35, 0.7]) poly(Array.from({ length: 8 }, (_, q) => { const ph = (q * Math.PI) / 4 - Math.PI / 8; return P(scn + OCT_R * f * Math.cos(ph), OCT_R * f * Math.sin(ph), 0.01) }), true, sc, 0.05 + 0.06 * k, 1.0, null)
      poly(Array.from({ length: 8 }, (_, q) => { const ph = (q * Math.PI) / 4 - Math.PI / 8; return P(scn + 0.5 * Math.cos(ph), 0.5 * Math.sin(ph), RH + 1.25) }), true, sc, ra * 0.6, 1.1, null)
      buildRoomItems(W, w, ri, scn)
      if (ri === nR - 1) buildColophon(W, w, s + RD)
    }
  }

  function buildColophon(W, w, s) {
    const r = [w.r[0], 0, w.r[1]], up = [0, 1, 0]
    const c = WP(w, s - 0.03, 0, 2.3)
    const name = w.label
    const em = Math.min(0.34, (2 * OCT_HALF - 0.5) / (Array.from(name).length * Atlas.advEm))
    const nw = Array.from(name).length * Atlas.advEm * em
    const b = birthAt(c[0], c[2]) + 0.4
    emit(GLY, [toChars(name, COL.label, 0.55)], at3(c, r, up, -nw / 2, 0.8), r, up, { em, birth: b, step: 0.02 })
    const e2 = 0.07
    const line = middle(w.kind === 'words' ? 'older words are further back than this' : w.kind === 'project' ? (w.path ? tail(w.path, 60) : 'no folder on this computer') : 'the end of the hall', colsFor(2 * OCT_HALF - 0.4, e2))
    const lw = Array.from(line).length * Atlas.advEm * e2
    emit(GLY, [toChars(line, COL.label, 0.3)], at3(c, r, up, -lw / 2, 0.8 - em * 1.5), r, up, { em: e2, birth: b + 0.2 })
    poly([at3(c, r, up, -nw / 2 - 0.2, 0.95), at3(c, r, up, nw / 2 + 0.2, 0.95)], false, COL.struct, 0.25, 1.0, b)
  }

  function buildRoomItems(W, w, ri, scn) {
    const room = w.rooms[ri]
    room.items.forEach((item, j) => {
      const ph = (PLAQUE_SIDES[j] * Math.PI) / 4
      const ds = Math.cos(ph), dt = Math.sin(ph)
      const n = [-(ds * w.d[0] + dt * w.r[0]), 0, -(ds * w.d[1] + dt * w.r[1])]
      const rt = [n[2], 0, -n[0]]
      const c = WP(w, scn + ds * (OCT_A - 0.03), dt * (OCT_A - 0.03), 1.95)
      const obj = INTER.length + 1
      const vs = scn + ds * 0.45, v = WP(w, vs, dt * 0.45, 0)
      const view = { x: v[0], z: v[2], yaw: Math.atan2(-n[0], n[2]), wing: w, s: vs }
      if (item.type === 'memory') {
        const m = item.m
        const ag = W.agentOf(m.agent)
        const col = lift(hexRGB(ag.color))
        const decay = decayOf(m.modified, W.NOW)
        plaque(W, m, ag, col, c, n, rt, obj, decay)
        const it = { id: obj, kind: 'memory', m, wing: w, room: ri, c, n, rt, hw: PW / 2, hh: PH / 2, reach: 11, color: col, label: oneLine(m.title), decay, view }
        INTER.push(it); W.memInter.set(m.id, it)
      } else {
        const decay = decayOf(item.a.at, W.NOW)
        inscription(W, item, c, n, rt, obj, decay)
        const it = { id: obj, kind: 'ask', a: item.a, text: item.text, wing: w, room: ri, c, n, rt, hw: PW / 2, hh: PH / 2, reach: 11, color: COL.words, label: item.text.slice(0, 48), decay, view }
        INTER.push(it); W.inscriptions.set(`${item.a.engine}|${item.a.at}`, it)
      }
    })
  }

  function plaque(W, m, ag, col, c, n, rt, obj, decay) {
    const up = [0, 1, 0]
    const hw = PW / 2, hh = PH / 2
    const front = 0.006
    const P = (x, y, z = front) => [c[0] + rt[0] * x + n[0] * z, c[1] + y, c[2] + rt[2] * x + n[2] * z]
    const rand = rng(strSeed(m.id))
    const fresh = Math.max(0, W.NOW - (m.modified || 0)) < 3 * DAY
    const fx = fresh ? 1 : decay > 0.55 ? -decay : 0
    const b = birthAt(c[0], c[2])
    const fa = 0.85 * (1 - decay * 0.55)
    const fcol = mixc(col, COL.dust, decay * 0.55)
    // the frame, broken in places when old
    const edge = (a, bb) => {
      const len = Math.hypot(bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]), pieces = Math.max(1, Math.round(len / 0.3))
      for (let i = 0; i < pieces; i++) { if (decay > 0.25 && rand() < (decay - 0.2) * 0.55) continue; seg(lerp3(a, bb, i / pieces), lerp3(a, bb, (i + 1) / pieces), fcol, fa, 1.4, b + 0.1, obj, fx) }
    }
    const tl = P(-hw, hh), tr = P(hw, hh), bl = P(-hw, -hh), br = P(hw, -hh)
    edge(tl, tr); edge(tr, br); edge(br, bl); edge(bl, tl)
    poly([P(-hw + 0.07, hh - 0.07), P(hw - 0.07, hh - 0.07), P(hw - 0.07, -hh + 0.07), P(-hw + 0.07, -hh + 0.07)], true, fcol, fa * 0.28, 1.0, b + 0.2, obj, fx)
    if (!decay || decay < 0.3) for (const [x, y] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      const cx = x * (hw + 0.08), cy = y * (hh + 0.08)
      seg(P(cx, cy), P(cx - x * 0.28, cy), col, 0.9, 1.5, b + 0.3, obj, fx); seg(P(cx, cy), P(cx, cy - y * 0.28), col, 0.9, 1.5, b + 0.3, obj, fx)
    }
    // text
    const ink = mixc(mixc(COL.white, col, 0.22), COL.dust, decay * 0.5)
    const o = P(-hw + 0.17, hh - 0.18, front + 0.006)
    const uw = PW - 0.34
    const kick = `${String(m.type || m.kind || 'memory').toUpperCase()} · ${ag.name}`
    let y = 0
    const step = 0.0025
    const bt = b + 0.35
    y += emit(GLY, [toChars(middle(kick, colsFor(uw, 0.078)), col, 0.85)], o, rt, up, { em: 0.078, decay: decay * 0.6, seed: obj * 7, obj, birth: bt, fx, cols: colsFor(uw, 0.078) }) + 0.07
    const tEm = 0.18
    const title = wrapChars(toChars(oneLine(m.title || m.description || 'untitled'), ink, 1), colsFor(uw, tEm), 2)
    y += emit(GLY, title, at3(o, rt, up, 0, -y), rt, up, { em: tEm, lh: 1.22, decay: decay * 0.75, seed: obj * 11, obj, birth: bt + 0.05, step, fx, cols: colsFor(uw, tEm) }) + 0.08
    const desc = oneLine(m.description || '')
    const bodyText = plain(m.body || '')
    const bEm = 0.104, bCols = colsFor(uw, bEm)
    if (desc && desc.toLowerCase() !== oneLine(m.title).toLowerCase() && !bodyText.toLowerCase().startsWith(desc.toLowerCase().slice(0, 30)) && desc.length > 12) {
      const dr = wrapChars(toChars(desc, ink, 0.5), colsFor(uw, 0.09), 2)
      y += emit(GLY, dr, at3(o, rt, up, 0, -y), rt, up, { em: 0.09, decay, seed: obj * 13, obj, birth: bt + 0.1, step, fx, cols: colsFor(uw, 0.09) }) + 0.07
    }
    const avail = PH - 0.36 - y - 0.2
    const maxRows = Math.max(1, Math.floor(avail / (bEm * 1.3)))
    const body = wrapChars(toChars(bodyText.slice(0, bCols * maxRows * 2 + 40), ink, 0.72), bCols, maxRows)
    emit(GLY, body, at3(o, rt, up, 0, -y), rt, up, { em: bEm, decay, seed: obj * 17, obj, birth: bt + 0.15, step, fx, cols: bCols })
    const foot = `${ago(m.modified, W.NOW)} · ${dateOf(m.modified)}`
    emit(GLY, [toChars(foot, col, 0.55)], P(-hw + 0.17, -hh + 0.24, front + 0.006), rt, up, { em: 0.072, decay: decay * 0.5, seed: obj * 19, obj, birth: bt + 0.3, fx, cols: colsFor(uw, 0.072) })
    if (fresh) emit(GLY, [toChars('new', col, 0.95)], P(hw - 0.17 - 3 * Atlas.advEm * 0.072, -hh + 0.24, front + 0.006), rt, up, { em: 0.072, obj, birth: bt + 0.3, fx })
    // dust on the plaque and the floor below; cobwebs in the corners of the oldest
    if (decay > 0.12) {
      const nD = Math.round(decay * 40)
      for (let i = 0; i < nD; i++) {
        const x = (rand() * 2 - 1) * hw, yy = (rand() * 2 - 1) * hh, a = rand() * Math.PI, l = 0.012 + rand() * 0.02
        seg(P(x, yy, front + 0.008), P(x + Math.cos(a) * l, yy + Math.sin(a) * l, front + 0.008), COL.dust, 0.35 * decay, 1.2, b + 0.6)
      }
      for (let i = 0; i < nD; i++) {
        const x = (rand() * 2 - 1) * (hw + 0.3), z = 0.05 + rand() * rand() * 1.1, a = rand() * TAU, l = 0.025 + rand() * 0.05
        const p = [c[0] + rt[0] * x + n[0] * z, 0.012, c[2] + rt[2] * x + n[2] * z]
        seg(p, [p[0] + Math.cos(a) * l, 0.012, p[2] + Math.sin(a) * l], COL.dust, 0.22 * decay, 1.1, b + 0.6)
      }
    }
    if (decay > 0.5) {
      for (const sx of [-1, 1]) {
        const cx = sx * hw, cy = hh
        const spokes = [0, 0.3, 0.62, 1].map((f) => { const a = Math.PI / 2 * f; const L = 0.42 + rand() * 0.25; return [-sx * Math.cos(a) * L, -Math.sin(a) * L] })
        const wa = 0.28 * decay
        for (const [dx, dy] of spokes) seg(P(cx, cy, front + 0.01), P(cx + dx, cy + dy, front + 0.01), COL.dust, wa, 1.0, b + 0.8)
        for (const f of [0.35, 0.62, 0.88]) {
          const pts = spokes.map(([dx, dy]) => P(cx + dx * f, cy + dy * f - 0.015 * f, front + 0.01))
          poly(pts, false, COL.dust, wa * 0.8, 1.0, b + 0.9)
        }
      }
    }
  }

  function inscription(W, item, c, n, rt, obj, decay) {
    const up = [0, 1, 0]
    const hw = PW / 2, hh = PH / 2
    const P = (x, y, z = 0.012) => [c[0] + rt[0] * x + n[0] * z, c[1] + y, c[2] + rt[2] * x + n[2] * z]
    const b = birthAt(c[0], c[2])
    const col = mixc(COL.words, COL.dust, decay * 0.5)
    emit(GLY, [toChars('“', col, 0.22)], P(-hw + 0.05, hh + 0.12), rt, up, { em: 0.7, obj, birth: b + 0.2 })
    const em = 0.142, cols = colsFor(PW - 0.3, em)
    const rows = wrapChars(toChars(item.text, col, 0.85 * (1 - decay * 0.45)), cols, 8)
    const hgt = emit(GLY, rows, P(-hw + 0.15, hh - 0.42), rt, up, { em, decay, seed: obj * 23, obj, birth: b + 0.35, step: 0.003, cols })
    const eng = WORLD.agentOf(item.a.engine).name
    emit(GLY, [toChars(`— you, to ${eng} · ${shortDate(item.a.at)} ${timeOf(item.a.at)}`, col, 0.45)], P(-hw + 0.15, hh - 0.42 - hgt - 0.12), rt, up, { em: 0.07, obj, birth: b + 0.6 })
    seg(P(-hw + 0.15, -hh + 0.12), P(-hw + 0.9, -hh + 0.12), col, 0.25, 1.0, b + 0.5, obj)
  }

  // ── WebGL ────────────────────────────────────────────────────────────────────────────────────────

  const canvas = $('gl'), hud = $('hud'), hctx = hud.getContext('2d')
  let gl = null, isGL2 = false
  const prog = {}
  let quadIdx = null, triBuf = null, atlasTex = null
  let chunks = { lines: [], glyphs: [], fills: [] }
  const dynBufs = []
  let targets = null
  let cssW = 0, cssH = 0, dpr = 1, pxW = 0, pxH = 0
  const P_ = new Float32Array(16), V_ = new Float32Array(16), VP = new Float32Array(16)

  const LINE_VS = `
precision highp float;
attribute vec3 aA; attribute vec3 aB; attribute vec2 aC; attribute vec4 aCol; attribute vec4 aM;
uniform mat4 uVP; uniform vec2 uRes; uniform float uPx, uT, uHi, uHi2, uFog, uFlick, uDraw, uWorld;
varying vec4 vCol; varying float vE; varying float vH;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float born = uT - aM.y;
  float p = clamp(born / 0.55, 0.0, 1.0);
  if (uDraw > 0.5) p = 1.0;
  vec3 B = mix(aA, aB, p);
  vec4 ca = uVP * vec4(aA, 1.0);
  vec4 cb = uVP * vec4(B, 1.0);
  float nw = 0.06;
  if ((ca.w < nw && cb.w < nw) || (born < 0.0 && uDraw < 0.5)) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vCol = vec4(0.0); vE = 0.0; vH = 1.0; return; }
  if (ca.w < nw) ca = mix(ca, cb, (nw - ca.w) / (cb.w - ca.w));
  if (cb.w < nw) cb = mix(cb, ca, (nw - cb.w) / (ca.w - cb.w));
  vec2 sa = ca.xy / ca.w * uRes * 0.5;
  vec2 sb = cb.xy / cb.w * uRes * 0.5;
  vec2 dir = sb - sa; float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = aM.x * uPx * 0.5;
  float ext = hw + uPx * 1.2;
  vec4 c = aC.y < 0.5 ? ca : cb;
  vec2 off = nrm * aC.x * ext + dir * (aC.y < 0.5 ? -0.5 : 0.5) * uPx;
  c.xy += off / (uRes * 0.5) * c.w;
  c.z -= 0.00003 * c.w;
  gl_Position = c;
  vE = aC.x * ext; vH = hw;
  float depth = c.w;
  float fog = exp(-pow(depth / uFog, 2.0) * 1.4);
  float nearFade = smoothstep(0.2, 1.0, depth);
  float hi = (aM.z > 0.5 && abs(aM.z - uHi) < 0.5) ? 1.0 : 0.0;
  float hi2 = (aM.z > 0.5 && abs(aM.z - uHi2) < 0.5) ? 1.0 : 0.0;
  float flash = uDraw > 0.5 ? 0.0 : 1.0 - smoothstep(0.0, 1.1, born);
  float k = 1.0;
  if (aM.w > 0.0) k *= 1.0 + 0.25 * aM.w * sin(uT * 2.3 + aM.z);
  if (aM.w < 0.0) { float n = h1(floor(uT * 9.0) + aM.z * 7.31); k *= mix(1.0, 0.3, step(1.0 + aM.w * 0.1 * uFlick, n)); }
  vec3 col = mix(aCol.rgb, vec3(1.0), clamp(flash * 0.7 + hi * 0.3 + hi2 * 0.35, 0.0, 1.0));
  vCol = vec4(col, aCol.a * k * (1.0 + flash * 1.6 + hi * 0.9 + hi2 * 1.2) * fog * nearFade * uWorld);
}`
  const LINE_FS = `
precision highp float;
uniform float uPx;
varying vec4 vCol; varying float vE; varying float vH;
void main() {
  float d = abs(vE);
  float cov = clamp((vH + 0.6 * uPx - d) / (1.2 * uPx), 0.0, 1.0);
  float halo = exp(-d * d / (vH * vH * 5.0 + uPx * uPx * 1.5)) * 0.4;
  gl_FragColor = vec4(vCol.rgb * vCol.a * max(cov, halo), 0.0);
}`
  const GLYPH_VS = `
precision highp float;
attribute vec3 aP; attribute vec2 aUV; attribute vec4 aCol; attribute vec4 aM;
uniform mat4 uVP; uniform float uT, uHi, uHi2, uFog, uFlick, uWorld;
varying vec2 vUV; varying vec4 vCol; varying float vOcc;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec4 c = uVP * vec4(aP, 1.0);
  gl_Position = c - vec4(0.0, 0.0, 0.00003 * c.w, 0.0);
  float born = uT - aM.x;
  float vis = aM.x < -0.5 ? 1.0 : step(0.0, born);
  float flash = aM.x < -0.5 ? 0.0 : vis * (1.0 - smoothstep(0.0, 0.6, born));
  float fog = exp(-pow(c.w / uFog, 2.0) * 1.4);
  float nearFade = smoothstep(0.15, 0.7, c.w);
  float hi = (aM.y > 0.5 && abs(aM.y - uHi) < 0.5) ? 1.0 : 0.0;
  float hi2 = (aM.y > 0.5 && abs(aM.y - uHi2) < 0.5) ? 1.0 : 0.0;
  float k = 1.0;
  if (aM.z > 0.0) k *= 1.0 + 0.18 * aM.z * sin(uT * 2.3 + aM.y);
  if (aM.z < 0.0) { float n = h1(floor(uT * 9.0) + aM.y * 7.31); k *= mix(1.0, 0.35, step(1.0 + aM.z * 0.1 * uFlick, n)); }
  vec3 col = mix(aCol.rgb, vec3(1.0), clamp(flash * 0.8 + hi * 0.25 + hi2 * 0.3, 0.0, 1.0));
  vCol = vec4(col, aCol.a * vis * k * (1.0 + flash * 2.0 + hi * 0.45 + hi2 * 0.6) * (aM.w > 0.5 ? 1.0 : fog * nearFade * uWorld));
  vOcc = aM.w; vUV = aUV;
}`
  const GLYPH_FS = `
precision highp float;
uniform sampler2D uAtlas;
varying vec2 vUV; varying vec4 vCol; varying float vOcc;
void main() {
  float cov = texture2D(uAtlas, vUV).a;
  cov = pow(cov, 0.8);
  gl_FragColor = vec4(vCol.rgb * vCol.a * cov * (1.0 - vOcc), cov * vCol.a * vOcc);
}`
  const FILL_VS = `
precision highp float;
attribute vec3 aP; attribute vec4 aCol; attribute float aB;
uniform mat4 uVP; uniform float uT, uFog, uWorld;
varying vec4 vCol;
void main() {
  vec4 c = uVP * vec4(aP, 1.0);
  gl_Position = c;
  float fog = exp(-pow(c.w / uFog, 2.0) * 1.4);
  vCol = vec4(aCol.rgb * fog * uWorld, step(aB, uT));
}`
  const FILL_FS = `
precision highp float;
varying vec4 vCol;
void main() { if (vCol.a < 0.5) discard; gl_FragColor = vec4(vCol.rgb, 1.0); }`
  const POST_VS = `
attribute vec2 aP; varying vec2 vUV;
void main() { vUV = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`
  const DOWN_FS = `
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uGain, uKnee;
varying vec2 vUV;
vec3 tap(vec2 o) { vec3 c = texture2D(uSrc, vUV + uTexel * o).rgb; float m = max(c.r, max(c.g, c.b)); return c * smoothstep(uKnee, uKnee * 4.0 + 0.001, m); }
void main() {
  vec3 c = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(c * 0.25 * uGain, 1.0);
}`
  const BLUR_FS = `
precision highp float;
uniform sampler2D uSrc; uniform vec2 uDir;
varying vec2 vUV;
void main() {
  vec3 c = texture2D(uSrc, vUV).rgb * 0.227027;
  c += texture2D(uSrc, vUV + uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(uSrc, vUV - uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(uSrc, vUV + uDir * 3.2307692).rgb * 0.0702703;
  c += texture2D(uSrc, vUV - uDir * 3.2307692).rgb * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`
  const COMP_FS = `
precision highp float;
uniform sampler2D uScene, uB1, uB2, uB3, uB4; uniform vec2 uRes; uniform float uDim, uT, uPx, uScan, uFade;
varying vec2 vUV;
void main() {
  vec3 s = texture2D(uScene, vUV).rgb;
  vec3 b = texture2D(uB1, vUV).rgb * 0.35 + texture2D(uB2, vUV).rgb * 0.6 + texture2D(uB3, vUV).rgb * 0.8 + texture2D(uB4, vUV).rgb * 1.0;
  vec3 col = s + b * 0.75;
  col += vec3(0.0, 0.006, 0.012) * (1.0 - vUV.y);
  float vig = smoothstep(1.3, 0.3, length((vUV - 0.5) * vec2(uRes.x / uRes.y, 1.0)));
  col *= mix(0.5, 1.0, vig);
  float scan = 0.93 + 0.07 * sin(gl_FragCoord.y * 3.14159 / (1.5 * uPx));
  col *= mix(1.0, scan, uScan);
  col *= (1.0 - uDim * 0.72) * (1.0 - uFade);
  col += (fract(sin(dot(gl_FragCoord.xy + fract(uT) * 37.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 200.0;
  gl_FragColor = vec4(col, 1.0);
}`
  const LINE_L = [3, 3, 2, 4, 4], GLYPH_L = [3, 2, 4, 4], FILL_L = [3, 4, 1], POST_L = [2]

  function initGL() {
    const opts = { antialias: false, alpha: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }
    gl = canvas.getContext('webgl2', opts)
    isGL2 = !!gl
    if (!gl) gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts)
    if (!gl) return false
    const compile = (vs, fs, attribs) => {
      const p = gl.createProgram()
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
        gl.attachShader(p, s)
      }
      attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name))
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
      const u = {}
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name) }
      return { p, u }
    }
    prog.line = compile(LINE_VS, LINE_FS, ['aA', 'aB', 'aC', 'aCol', 'aM'])
    prog.glyph = compile(GLYPH_VS, GLYPH_FS, ['aP', 'aUV', 'aCol', 'aM'])
    prog.fill = compile(FILL_VS, FILL_FS, ['aP', 'aCol', 'aB'])
    prog.down = compile(POST_VS, DOWN_FS, ['aP'])
    prog.blur = compile(POST_VS, BLUR_FS, ['aP'])
    prog.comp = compile(POST_VS, COMP_FS, ['aP'])
    const idx = new Uint16Array(16384 * 6)
    for (let q = 0; q < 16384; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6)
    quadIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
    triBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, triBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    atlasTex = gl.createTexture()
    return true
  }

  function uploadAtlas() {
    gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, Atlas.canvas)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const an = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)))
    Atlas.dirty = false
  }

  function makeChunks(arr, stride) {
    const all = new Float32Array(arr), perQuad = stride * 4, quads = all.length / perQuad, out = []
    for (let q = 0; q < quads; q += 16384) {
      const n = Math.min(16384, quads - q)
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, all.subarray(q * perQuad, (q + n) * perQuad), gl.STATIC_DRAW)
      out.push({ buf, quads: n })
    }
    return out
  }
  function layout(sizes) {
    const stride = sizes.reduce((a, b) => a + b, 0)
    let off = 0
    for (let i = 0; i < 6; i++) {
      if (i < sizes.length) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, sizes[i], gl.FLOAT, false, stride * 4, off * 4); off += sizes[i] }
      else gl.disableVertexAttribArray(i)
    }
  }
  function drawChunks(list, sizes) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx)
    for (const c of list) { gl.bindBuffer(gl.ARRAY_BUFFER, c.buf); layout(sizes); gl.drawElements(gl.TRIANGLES, c.quads * 6, gl.UNSIGNED_SHORT, 0) }
  }
  let dynSlot = 0
  function drawDyn(arr, sizes) {
    if (!arr.length) return
    const stride = sizes.reduce((a, b) => a + b, 0), perQuad = stride * 4
    const all = new Float32Array(arr), quads = all.length / perQuad
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx)
    for (let q = 0; q < quads; q += 16384) {
      const n = Math.min(16384, quads - q)
      if (!dynBufs[dynSlot]) dynBufs[dynSlot] = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, dynBufs[dynSlot++])
      gl.bufferData(gl.ARRAY_BUFFER, all.subarray(q * perQuad, (q + n) * perQuad), gl.DYNAMIC_DRAW)
      layout(sizes); gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0)
    }
  }

  function makeTarget(w, h, depth) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    let rb = null
    if (depth) {
      rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
      gl.renderbufferStorage(gl.RENDERBUFFER, isGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16, w, h)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb)
    }
    return { tex, fb, rb, w, h }
  }
  function freeTarget(t) { if (!t) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); if (t.rb) gl.deleteRenderbuffer(t.rb) }

  function resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight)
    const d = Math.min(2, window.devicePixelRatio || 1)
    if (w === cssW && h === cssH && d === dpr && targets) return
    cssW = w; cssH = h; dpr = d
    pxW = Math.round(w * d); pxH = Math.round(h * d)
    canvas.width = pxW; canvas.height = pxH
    hud.width = pxW; hud.height = pxH
    if (targets) Object.values(targets).forEach(freeTarget)
    const q = (k) => [Math.max(1, Math.round(pxW / k)), Math.max(1, Math.round(pxH / k))]
    targets = { scene: makeTarget(pxW, pxH, true), b1: makeTarget(...q(2)), b2: makeTarget(...q(4)), t2: makeTarget(...q(4)), b3: makeTarget(...q(8)), t3: makeTarget(...q(8)), b4: makeTarget(...q(16)), t4: makeTarget(...q(16)) }
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────────

  const cam = { x: 0, z: 0, y: EYE, yaw: 0, pitch: 0, v: 0, sv: 0, w: 0, bob: 0, fov: 62 }
  const keys = {}
  let clock = 0, arrival = true, ready = false
  let target = null, hiPulse = { id: 0, until: 0 }
  let travel = null
  let fade = 0
  let dim = 0, recallDim = 0
  const ARRIVE = 4.9
  const recall = { q: '', chars: [], cards: [], sel: 0, gone: [], goneWords: [], msgs: [], msgQ: '', timer: 0 }
  const reader = { open: false, item: null, links: [], sel: -1, restore: null }
  const mapUI = { open: false, sel: 0 }

  // ── walking, collision, looking ──────────────────────────────────────────────────────────────────

  function collide(x, z, r = 0.38) {
    for (let it = 0; it < 3; it++) {
      for (const s of WALLS) {
        const dx = s[2] - s[0], dz = s[3] - s[1]
        const l2 = dx * dx + dz * dz || 1e-6
        const t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1)
        const px = s[0] + dx * t, pz = s[1] + dz * t
        const ex = x - px, ez = z - pz, d = Math.hypot(ex, ez)
        if (d < r && d > 1e-6) { x = px + (ex / d) * r; z = pz + (ez / d) * r }
      }
    }
    return [x, z]
  }
  function rayWalls(px, pz, fx, fz, max) {
    let best = max
    for (const s of WALLS) {
      const ex = s[2] - s[0], ez = s[3] - s[1]
      const den = fx * ez - fz * ex
      if (Math.abs(den) < 1e-9) continue
      const ax = s[0] - px, az = s[1] - pz
      const t = (ax * ez - az * ex) / den, u = (ax * fz - az * fx) / den
      if (t > 0 && t < best && u >= 0 && u <= 1) best = t
    }
    return best
  }
  function pick() {
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw)
    const wallT = rayWalls(cam.x, cam.z, fx, fz, 80)
    let best = null, bestT = Infinity
    for (const it of INTER) {
      const den = fx * it.n[0] + fz * it.n[2]
      if (it.twoSided ? Math.abs(den) < 0.25 : den > -0.25) continue
      const t = ((it.c[0] - cam.x) * it.n[0] + (it.c[2] - cam.z) * it.n[2]) / den
      if (t < 0.3 || t > it.reach || t > wallT + 0.15 || t >= bestT) continue
      const hx = cam.x + fx * t - it.c[0], hz = cam.z + fz * t - it.c[2]
      if (Math.abs(hx * it.rt[0] + hz * it.rt[2]) > it.hw * 1.06) continue
      best = it; bestT = t
    }
    if (best) return best
    // nothing straight ahead: a door a little to one side, if you can see it
    let bestA = 9 * DEG
    for (const it of INTER) {
      if (it.kind !== 'door') continue
      const dx = it.c[0] - cam.x, dz = it.c[2] - cam.z, d = Math.hypot(dx, dz)
      if (d < 1 || d > it.reach) continue
      const a = Math.abs(angWrap(Math.atan2(dx, -dz) - cam.yaw))
      if (a >= bestA) continue
      if (rayWalls(cam.x, cam.z, dx / d, dz / d, d) < d - 0.2) continue
      best = it; bestA = a
    }
    return best
  }

  function locate(x, z) {
    for (const w of WORLD.wings) {
      const s = x * w.d[0] + z * w.d[1], t = x * w.r[0] + z * w.r[1]
      if (s < w.s0 - 0.3 || s > w.sEnd + 0.3) continue
      if (s < w.s1) { if (Math.abs(t) < CWH + 0.4) return { wing: w, s, t, room: -1 } }
      else if (Math.abs(t) < OCT_R + 0.3) return { wing: w, s, t, room: clamp(Math.floor((s - w.s1) / RD), 0, w.rooms.length - 1) }
    }
    return { wing: null, r: Math.hypot(x, z) }
  }

  // ── travel: a path through the palace, then a glide along it ─────────────────────────────────────

  function nearestGap(a) {
    const K = WORLD.K
    let best = 0, bd = Infinity
    for (let k = 0; k < K; k++) { const g = (k * TAU) / K + Math.PI / K; const d = Math.abs(angWrap(g - a)); if (d < bd) { bd = d; best = g } }
    return best
  }
  function route(dest) {
    const pts = [[cam.x, cam.z]]
    const here = locate(cam.x, cam.z)
    const ringR = (R_STONE + 1.0 + WORLD.R * Math.cos(WORLD.alpha)) / 2
    const pol = (r, a) => [r * Math.sin(a), -r * Math.cos(a)]
    const axis = (w, s) => [s * w.d[0], s * w.d[1]]
    let ang, rad
    if (here.wing) {
      if (dest.wing === here.wing) { pts.push(axis(here.wing, here.s), axis(dest.wing, dest.s), [dest.x, dest.z]); return pts }
      pts.push(axis(here.wing, here.s), axis(here.wing, here.wing.s0 - 1.0))
      ang = here.wing.theta; rad = here.wing.s0 - 1.0
    } else { rad = Math.hypot(cam.x, cam.z); ang = Math.atan2(cam.x, -cam.z) }
    const dr = Math.hypot(dest.x, dest.z)
    const destIn = !dest.wing && dr < R_STONE
    const destAng = dest.wing ? dest.wing.theta : dr < 0.5 ? ang : Math.atan2(dest.x, -dest.z)
    if (rad < R_STONE + 0.6) {
      if (destIn) { pts.push([dest.x, dest.z]); return pts }
      const g = nearestGap(destAng)
      pts.push(pol(R_STONE - 1.5, g), pol(R_STONE + 1.5, g))
      ang = g; rad = R_STONE + 1.5
    }
    const goal = destIn ? nearestGap(destAng) : destAng
    pts.push(pol(ringR, ang))
    const d = angWrap(goal - ang), steps = Math.ceil(Math.abs(d) / (14 * DEG))
    for (let i = 1; i <= steps; i++) pts.push(pol(ringR, ang + (d * i) / steps))
    if (destIn) { pts.push(pol(R_STONE + 1.5, goal), pol(R_STONE - 1.5, goal), [dest.x, dest.z]); return pts }
    if (dest.wing) pts.push(axis(dest.wing, dest.wing.s0 - 1.0), axis(dest.wing, dest.s))
    pts.push([dest.x, dest.z])
    return pts
  }
  function cr(p0, p1, p2, p3, t) {
    const dd = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4
    const t0 = 0, t1 = t0 + dd(p0, p1), t2 = t1 + dd(p1, p2), t3 = t2 + dd(p2, p3)
    const u = lerp(t1, t2, t)
    const L = (a, b, ta, tb) => { const k = (u - ta) / (tb - ta || 1e-4); return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] }
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3)
    return L(L(A1, A2, t0, t2), L(A2, A3, t1, t3), t1, t2)
  }
  function spline(pts) {
    const P = []
    for (const p of pts) if (!P.length || Math.hypot(p[0] - P[P.length - 1][0], p[1] - P[P.length - 1][1]) > 0.35) P.push(p)
    if (P.length < 2) P.push([P[0][0] + 0.01, P[0][1]])
    const out = []
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = i > 0 ? P[i - 1] : [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]]
      const p3 = i + 2 < P.length ? P[i + 2] : [2 * P[i + 1][0] - P[i][0], 2 * P[i + 1][1] - P[i][1]]
      const n = Math.max(2, Math.ceil(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) / 0.35))
      for (let j = 0; j < n; j++) out.push(cr(p0, P[i], P[i + 1], p3, j / n))
    }
    out.push(P[P.length - 1])
    const cum = [0]
    for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]))
    return { pts: out, cum, len: cum[cum.length - 1] }
  }
  function sampleAt(path, d) {
    const { pts, cum } = path
    if (d <= 0) return pts[0]
    if (d >= path.len) return pts[pts.length - 1]
    let lo = 0, hi = cum.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid; else hi = mid }
    const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1)
    return [lerp(pts[lo][0], pts[hi][0], t), lerp(pts[lo][1], pts[hi][1], t)]
  }

  function travelTo(dest) {
    if (!dest) return
    closeMap()
    const path = spline(route(dest))
    if (reduced || path.len < 0.05) {
      fadeCut(() => { cam.x = dest.x; cam.z = dest.z; cam.yaw = dest.yaw; cam.v = cam.w = cam.sv = 0; if (dest.hi) hiPulse = { id: dest.hi, until: clock + 2.5 } })
      return
    }
    travel = { path, t: 0, show: 0, T: clamp(0.9 + path.len / 24, 1.1, 5.2), dest, settle: 0, phase: 'show' }
    cam.v = cam.w = cam.sv = 0
  }
  function fadeCut(fn) { fade = 1; setTimeout(() => { fn(); setTimeout(() => { fade = 0 }, 30) }, 130) }
  function stopTravel() { travel = null }

  function homeDest() { return { x: 0, z: 0, yaw: 0, wing: null } }
  function doorDest(it) {
    const w = it.wing
    const here = locate(cam.x, cam.z)
    if (it.at === 'facade') {
      if (here.wing === w) return { x: 0, z: 0, yaw: w.theta, wing: null }
      return { x: WP(w, w.s1 + 2.4, 0, 0)[0], z: WP(w, w.s1 + 2.4, 0, 0)[2], yaw: w.theta, wing: w, s: w.s1 + 2.4 }
    }
    const sOpen = w.s1 + it.room * RD
    const camS = cam.x * w.d[0] + cam.z * w.d[1]
    if (camS < sOpen) { const s = sOpen + 2.4; const p = WP(w, s, 0, 0); return { x: p[0], z: p[2], yaw: w.theta, wing: w, s } }
    if (it.room === 0) { const s = w.s0 + (w.s1 - w.s0) * 0.5; const p = WP(w, s, 0, 0); return { x: p[0], z: p[2], yaw: w.theta + Math.PI, wing: w, s } }
    const s = w.s1 + (it.room - 1) * RD + RD / 2; const p = WP(w, s, 0, 0)
    return { x: p[0], z: p[2], yaw: w.theta + Math.PI, wing: w, s }
  }
  /** Seen from the far side, a door leads back: name where it goes. */
  function doorBack(it) {
    if (it.kind !== 'door') return ''
    const w = it.wing, camS = cam.x * w.d[0] + cam.z * w.d[1]
    if (it.at === 'facade') return camS > w.s0 ? 'the atrium' : ''
    if (camS <= w.s1 + it.room * RD) return ''
    return it.room === 0 ? 'the corridor' : w.rooms[it.room - 1].title
  }
  function stepBack() {
    const here = locate(cam.x, cam.z)
    if (here.wing) {
      const w = here.wing
      if (here.room > 0) { const s = w.s1 + (here.room - 1) * RD + RD / 2; const p = WP(w, s, 0, 0); travelTo({ x: p[0], z: p[2], yaw: w.theta, wing: w, s }); return }
      const p = WP(w, w.s0 - 3.2, 0, 0)
      travelTo({ x: p[0], z: p[2], yaw: w.theta, wing: null })
      return
    }
    if (Math.hypot(cam.x, cam.z) > 0.6) travelTo(homeDest())
  }
  function interDest(it) {
    if (!it) return null
    if (it.kind === 'door') return doorDest(it)
    return { ...it.view, hi: it.id }
  }

  // ── Sherlock recall: type, and memories fly to you ───────────────────────────────────────────────

  function matchLocal(q) {
    const terms = words(q).filter((t) => t.length >= 2)
    if (!terms.length) return []
    const out = []
    for (const it of INTER) {
      if (it.kind !== 'memory') continue
      const m = it.m
      const title = oneLine(m.title).toLowerCase(), desc = oneLine(m.description).toLowerCase(), body = String(m.body || '').toLowerCase()
      const meta = `${m.project?.name || ''} ${WORLD.agentOf(m.agent).name} ${m.type || ''} ${m.kind || ''}`.toLowerCase()
      let score = 0, ok = true
      for (const t of terms) {
        let s = 0
        const ti = title.indexOf(t)
        if (ti >= 0) s += 8 + (ti === 0 || /\W/.test(title[ti - 1]) ? 3 : 0)
        if (desc.includes(t)) s += 4
        if (meta.includes(t)) s += 2.5
        let c = 0, i = body.indexOf(t)
        while (i >= 0 && c < 6) { c++; i = body.indexOf(t, i + t.length) }
        s += c
        if (!s) { ok = false; break }
        score += s
      }
      if (!ok) continue
      score += 2.5 * (1 - (it.decay || 0))
      out.push({ key: 'm:' + m.id, kind: 'memory', it, score, terms })
    }
    for (const st of WORLD.stones) st.sec.lines.forEach((line, li) => {
      const text = oneLine(line.text).toLowerCase()
      if (terms.every((t) => text.includes(t) || st.sec.name.toLowerCase().includes(t))) out.push({ key: `a:${st.k}:${li}`, kind: 'about', it: st, line, score: 9 + terms.length, terms })
    })
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, 9)
  }

  function snippet(text, terms, len = 200) {
    const s = oneLine(text)
    const low = s.toLowerCase()
    let at = -1
    for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i }
    let a = at < 0 ? 0 : Math.max(0, at - 48)
    if (a > 0) { const sp = s.lastIndexOf(' ', a + 8); if (sp > a - 12 && sp >= 0) a = sp + 1 }
    let out = (a > 0 ? '…' : '') + s.slice(a, a + len)
    for (const t of terms) out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `\u0002${x}\u0003`)
    return out
  }

  /** A card's text, laid out once in card space (metres from its top left). */
  function cardLayout(r) {
    const W0 = 1.56, pad = 0.09, uw = W0 - pad * 2
    const g = []
    let y = pad
    const add = (rows, em, lh = 1.28) => { rows.forEach((row, ri) => { let c = 0; for (const ch of row) { if (ch.ch !== ' ') g.push({ ch: ch.ch, x: pad + c * Atlas.advEm * em, y: y + ri * lh * em, e: em, col: ch.col, a: ch.a ?? 1, hi: ch.hi }); c += 1 } }); y += rows.length * lh * em }
    let color, origin, kick
    const dimInk = [0.72, 0.82, 0.88]
    if (r.kind === 'memory') {
      const m = r.it.m, ag = WORLD.agentOf(m.agent)
      color = r.it.color; origin = r.it.c
      kick = `${String(m.type || m.kind).toUpperCase()} · ${ag.name}${m.project ? ' · ' + m.project.name : ''}`
      add([toChars(middle(kick, colsFor(uw, 0.05)), color, 0.9)], 0.05); y += 0.035
      add(wrapChars(toChars(oneLine(m.title || 'untitled'), mixc(COL.white, color, 0.15), 1), colsFor(uw, 0.092), 2), 0.092, 1.2); y += 0.035
      add(wrapChars(marked(snippet(plain(m.body || m.description || ''), r.terms, 240), dimInk, [1, 1, 1], 0.78, 1), colsFor(uw, 0.06), 5), 0.06, 1.32)
      y += 0.03
      add([toChars(`${ago(m.modified, WORLD.NOW)}`, color, 0.6)], 0.046)
    } else if (r.kind === 'about') {
      color = COL.self; origin = [r.it.c[0], r.it.c[1] + 0.6, r.it.c[2]]
      add([toChars(`ABOUT YOU · ${r.it.sec.name}`, color, 0.9)], 0.05); y += 0.04
      add(wrapChars(marked(snippet(r.line.text, r.terms, 300), mixc(COL.self, COL.white, 0.5), [1, 1, 1], 0.88, 1), colsFor(uw, 0.078), 4), 0.078, 1.28); y += 0.03
      const cites = (r.line.refs ?? []).length
      add([toChars(cites ? `held up by ${cites} source${cites === 1 ? '' : 's'}` : 'about you', color, 0.55)], 0.046)
    } else {
      const h = r.hit, ag = WORLD.agentOf(h.engine)
      color = COL.words
      const ins = WORLD.inscriptions.get(`${h.engine}|${h.at}`)
      r.ins = ins
      const hall = WORLD.wings.find((w) => w.kind === 'words')
      origin = ins ? ins.c : hall ? WP(hall, hall.s1 + 4, 0, 2) : polar(60, cam.yaw + Math.PI, 3)
      add([toChars(`YOU SAID · to ${ag.name} · ${shortDate(h.at)}`, color, 0.9)], 0.05); y += 0.04
      add(wrapChars(marked(h.snippet || '', dimInk, [1, 1, 1], 0.82, 1), colsFor(uw, 0.066), 6), 0.066, 1.32); y += 0.03
      add([toChars(h.title ? middle(oneLine(h.title), 40) : ago(h.at, WORLD.NOW), color, 0.55)], 0.046)
    }
    return { w: W0, h: y + pad, g, color, origin }
  }

  function setCards(list) {
    const old = new Map(recall.cards.map((c) => [c.key, c]))
    const selKey = recall.cards[recall.sel]?.key
    const next = []
    list.forEach((r, i) => {
      let c = old.get(r.key)
      if (c) { old.delete(r.key); c.r = r; const L = cardLayout(r); L.origin = c.L.origin; c.L = L }
      else {
        const L = cardLayout(r)
        c = { key: r.key, r, L, born: clock + i * 0.06, pos: L.origin.slice(), start: L.origin.slice(), live: 0 }
      }
      next.push(c)
    })
    for (const c of old.values()) recall.gone.push({ c, at: clock, mode: 'fade' })
    recall.cards = next
    const keep = next.findIndex((c) => c.key === selKey)
    recall.sel = keep >= 0 ? keep : 0
  }

  function refreshRecall() {
    const q = recall.q
    const local = matchLocal(q)
    const msgs = recall.msgQ === q ? recall.msgs : recall.cards.filter((c) => c.r.kind === 'ask').map((c) => c.r)
    setCards([...local, ...msgs].slice(0, 12))
    clearTimeout(recall.timer)
    if (words(q).some((t) => t.length >= 2)) {
      recall.timer = setTimeout(() => {
        MemoryData.search(q).then((hits) => {
          if (recall.q !== q) return
          const terms = words(q)
          recall.msgs = (hits || []).slice(0, 4).map((hit) => ({ key: `s:${hit.sessionId}:${hit.turn}:${hit.at}`, kind: 'ask', hit, terms }))
          recall.msgQ = q
          setCards([...matchLocal(q), ...recall.msgs].slice(0, 12))
        }).catch(() => {})
      }, 170)
    } else { recall.msgs = []; recall.msgQ = q }
  }
  function typeChar(ch) {
    if (travel) stopTravel()
    if (!recall.q && ch === ' ') return
    recall.q += ch
    recall.chars.push({ ch, born: clock })
    refreshRecall()
  }
  function backspace() {
    if (!recall.chars.length) return
    recall.chars.pop()
    recall.q = recall.chars.map((c) => c.ch).join('')
    if (!recall.q.trim()) { dismissRecall(false); return }
    refreshRecall()
  }
  function dismissRecall(sweep = true, keepKey = null) {
    const lx = -Math.cos(cam.yaw), lz = -Math.sin(cam.yaw)
    for (const c of recall.cards) if (c.key !== keepKey) recall.gone.push({ c, at: clock, mode: sweep ? 'sweep' : 'fade', vx: lx * 9, vz: lz * 9 })
    if (recall.chars.length) recall.goneWords.push({ frames: wordFrames(), at: clock, vx: lx * 8, vz: lz * 8 })
    recall.cards = []; recall.chars = []; recall.q = ''; recall.sel = 0; recall.msgs = []; recall.msgQ = ''
    clearTimeout(recall.timer)
  }
  function chooseCard() {
    const c = recall.cards[recall.sel]
    if (!c) return
    const r = c.r
    dismissRecall(true)
    if (r.kind === 'memory') travelTo(interDest(r.it))
    else if (r.kind === 'about') travelTo(interDest(r.it))
    else if (r.ins) travelTo(interDest(r.ins))
    else openRead({ kind: 'hit', hit: r.hit }, null)
  }

  /** Where the floating words of the query hang right now: one billboard frame per word. */
  function wordFrames() {
    const groups = []
    let cur = null
    recall.chars.forEach((c) => {
      if (c.ch === ' ') { cur = null; return }
      if (!cur) groups.push((cur = []))
      cur.push(c)
    })
    const n = groups.length
    const em = 0.27
    return groups.map((g, wi) => {
      const a = cam.yaw + (wi - (n - 1) / 2) * 17 * DEG + Math.sin(wi * 2.1) * 2 * DEG
      const dist = 3.5 + (wi % 2) * 0.4
      const px = cam.x + Math.sin(a) * dist, pz = cam.z - Math.cos(a) * dist
      const nrm = [-Math.sin(a), 0, Math.cos(a)]
      const rt = [nrm[2], 0, -nrm[0]]
      const bobT = reduced ? 0 : clock
      const y = EYE + 1.22 + (wi % 2 ? 0.2 : 0) + Math.sin(bobT * 1.1 + wi * 1.9) * 0.045
      const width = g.length * Atlas.advEm * em
      const o = [px - rt[0] * width / 2, y, pz - rt[2] * width / 2]
      return { o, rt, em, chars: g }
    })
  }

  // ── reading a memory up close ────────────────────────────────────────────────────────────────────

  const R_ = { read: $('read'), sheet: $('sheet'), kicker: $('r-kicker'), title: $('r-title'), meta: $('r-meta'), links: $('r-links'), body: $('r-body'), foot: $('r-foot') }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

  function openRead(item, it) {
    reader.open = true; reader.item = item; reader.links = []; reader.sel = -1; reader.restore = null
    const { sheet } = R_
    R_.kicker.textContent = ''; R_.title.textContent = ''; R_.meta.textContent = ''; R_.links.textContent = ''; R_.body.textContent = ''; R_.foot.textContent = ''
    let accent = COL.struct
    const meta = (...parts) => parts.filter(Boolean).forEach((p) => R_.meta.appendChild(el('span', null, p)))
    if (item.kind === 'memory') {
      const m = item.m, ag = WORLD.agentOf(m.agent)
      accent = lift(hexRGB(ag.color))
      R_.kicker.textContent = `${m.type || m.kind || 'memory'} · ${ag.name}${m.project ? ' · ' + m.project.name : ' · every project'}`
      R_.title.textContent = oneLine(m.title || 'untitled')
      meta(ago(m.modified, WORLD.NOW), dateOf(m.modified), m.kind ? `kind: ${m.kind}` : '', m.size ? `${fmt(m.size)} bytes` : '')
      const cited = WORLD.reverse.get(m.id) || []
      if (cited.length) {
        R_.links.appendChild(el('div', 'head', 'About You stands on this'))
        for (const c of cited) addLink(`${c.text}`, c.section, COL.self, () => travelTo(interDest(WORLD.stones[c.k])))
      }
      const body = clean(m.body || '')
      const desc = oneLine(m.description || '')
      R_.body.textContent = (desc && !body.toLowerCase().includes(desc.toLowerCase().slice(0, 40)) ? desc + '\n\n' : '') + body
      R_.foot.textContent = m.path || ''
      const d = it?.decay ?? 0
      if (d > 0.12 && !reduced) startRestore(R_.body.textContent, d)
    } else if (item.kind === 'stone') {
      const sec = item.sec
      accent = COL.self
      R_.kicker.textContent = 'about you'
      R_.title.textContent = sec.name
      const ab = WORLD.snap.about || {}
      meta(ab.intro ? oneLine(ab.intro) : '', ab.modified ? `written ${ago(ab.modified, WORLD.NOW)}` : '')
      for (const line of sec.lines) {
        R_.links.appendChild(el('div', 'line', oneLine(line.text)))
        const asksRef = (line.refs ?? []).filter((r) => String(r).startsWith('asks:'))
        for (const m of line.mems) {
          const ag = WORLD.agentOf(m.agent)
          addLink(oneLine(m.title), `${ag.name}${m.project ? ' · ' + m.project.name : ''} · ${ago(m.modified, WORLD.NOW)}`, lift(hexRGB(ag.color)), () => travelTo(interDest(WORLD.memInter.get(m.id))))
        }
        for (const r of asksRef) { const n = Number(String(r).split(':')[1]) || 0; R_.links.appendChild(el('div', 'link', `from ${fmt(n)} of your messages`)).classList.add('static') }
      }
      R_.foot.textContent = WORLD.snap.aboutPath || ''
    } else {
      const a = item.kind === 'hit' ? item.hit : item.a
      const ag = WORLD.agentOf(a.engine)
      accent = COL.words
      R_.kicker.textContent = `you said · to ${ag.name}`
      R_.title.textContent = `${dateOf(a.at)}  ${timeOf(a.at)}`
      meta(ago(a.at, WORLD.NOW), a.title ? oneLine(a.title) : '', a.cwd ? tail(a.cwd, 48) : '', a.turn != null ? `turn ${a.turn + 1}` : '')
      if (item.kind === 'hit') {
        let hi = false
        for (const part of clean(a.snippet || '').split(/([\u0002\u0003])/)) {
          if (part === '\u0002') { hi = true; continue }
          if (part === '\u0003') { hi = false; continue }
          if (!part) continue
          const span = el('span', null, part)
          if (hi) { span.style.color = '#fff'; span.style.textShadow = '0 0 10px rgba(190,170,255,0.9)' }
          R_.body.appendChild(span)
        }
      } else R_.body.textContent = clean(a.text || item.text || '')
      R_.foot.textContent = a.sessionId ? `session ${a.sessionId}` : ''
    }
    sheet.style.setProperty('--accent', css(accent))
    R_.read.hidden = false
    sheet.scrollTop = 0
    // the memory comes to you: from where it hangs on the wall to the middle of the screen
    sheet.classList.remove('fly')
    const rect = it ? screenRect(it) : null
    if (rect && !reduced) {
      const f = sheet.getBoundingClientRect()
      sheet.style.transform = `translate(${rect.x - f.left}px, ${rect.y - f.top}px) scale(${Math.max(0.05, rect.w / f.width)}, ${Math.max(0.05, rect.h / f.height)})`
      sheet.style.opacity = '0.2'
      void sheet.offsetWidth
      sheet.classList.add('fly')
    }
    sheet.style.transform = 'none'; sheet.style.opacity = '1'
    updateKeys()
  }
  function addLink(text, sub, col, go) {
    const d = el('div', 'link')
    const dot = el('span', 'dot'); dot.style.background = css(col); dot.style.boxShadow = `0 0 8px ${css(col, 0.8)}`
    d.appendChild(dot); d.appendChild(el('span', null, text))
    if (sub) { d.appendChild(el('span', 'sub', '  ' + sub)) }
    R_.links.appendChild(d)
    reader.links.push({ node: d, go })
  }
  function selectLink(i) {
    if (!reader.links.length) return
    reader.sel = ((i % reader.links.length) + reader.links.length) % reader.links.length
    reader.links.forEach((l, j) => l.node.classList.toggle('on', j === reader.sel))
    reader.links[reader.sel].node.scrollIntoView({ block: 'nearest' })
  }
  function closeRead(then) {
    if (!reader.open) return
    reader.open = false; reader.restore = null
    R_.read.hidden = true
    R_.sheet.classList.remove('fly')
    updateKeys()
    if (then) then()
  }
  /** Old memories come back whole as you look at them: the lost letters at the edges fill in. */
  function startRestore(text, decay) {
    const lines = text.split('\n').slice(0, 160)
    const rest = text.split('\n').slice(160).join('\n')
    const masks = lines.map((line, li) => Array.from(line).map((ch, i, arr) => {
      const u = arr.length > 1 ? i / (arr.length - 1) : 0.5
      const edge = Math.abs(u * 2 - 1)
      const lose = Math.pow(decay, 1.7) * (sstep(0.55, 1, edge) * 1.3 + 0.02)
      const r = hash3(li, i, 99)
      return r < lose ? r / Math.max(lose, 1e-3) : -1
    }))
    reader.restore = { lines, rest, masks, t0: performance.now(), dur: 1100 }
    stepRestore(0)
  }
  function stepRestore(f) {
    const r = reader.restore
    if (!r) return
    const out = r.lines.map((line, li) => Array.from(line).map((ch, i) => (r.masks[li][i] > f ? ' ' : ch)).join(''))
    R_.body.textContent = out.join('\n') + (r.rest ? '\n' + r.rest : '')
    if (f >= 1) reader.restore = null
  }
  function screenRect(it) {
    const corners = []
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [it.c[0] + it.rt[0] * it.hw * sx, it.c[1] + it.hh * sy, it.c[2] + it.rt[2] * it.hw * sx]
      const s = project(p)
      if (!s) return null
      corners.push(s)
    }
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
    const x = Math.min(...xs), y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  function project(p) {
    const m = VP
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
    if (w < 0.08) return null
    return [(x / w * 0.5 + 0.5) * cssW, (1 - (y / w * 0.5 + 0.5)) * cssH, w]
  }

  function activate() {
    const it = target
    if (!it) { return }
    if (it.kind === 'door') { travelTo(doorDest(it)); return }
    if (it.kind === 'memory') openRead({ kind: 'memory', m: it.m }, it)
    else if (it.kind === 'stone') openRead({ kind: 'stone', sec: it.sec }, it)
    else if (it.kind === 'ask') openRead({ kind: 'ask', a: it.a, text: it.text }, it)
  }

  // ── the map ──────────────────────────────────────────────────────────────────────────────────────

  function openMap() {
    mapUI.open = true
    const here = locate(cam.x, cam.z)
    mapUI.sel = here.wing ? here.wing.i : 0
    updateKeys()
  }
  function closeMap() { if (mapUI.open) { mapUI.open = false; updateKeys() } }

  function drawMap(ctx, x0, y0, w, h, cx, cz, scale, big) {
    ctx.save()
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip()
    ctx.fillStyle = big ? 'rgba(0, 4, 8, 0.86)' : 'rgba(0, 6, 10, 0.62)'
    ctx.fillRect(x0, y0, w, h)
    const ox = x0 + w / 2, oy = y0 + h / 2
    const X = (x) => ox + (x - cx) * scale, Y = (z) => oy + (z - cz) * scale
    const selW = big ? WORLD.wings[mapUI.sel] : null
    ctx.lineCap = 'round'
    for (const pass of [0, 1]) {
      ctx.beginPath()
      for (const s of MAPSEG) {
        const isSel = selW && s[5] === selW.i
        if ((pass === 1) !== !!isSel) continue
        if (s[4] === 'stone') continue
        ctx.moveTo(X(s[0]), Y(s[1])); ctx.lineTo(X(s[2]), Y(s[3]))
      }
      ctx.strokeStyle = pass ? 'rgba(160, 235, 255, 0.95)' : 'rgba(90, 215, 255, 0.42)'
      ctx.lineWidth = (pass ? 1.6 : 1) * dpr
      ctx.shadowColor = 'rgba(90, 215, 255, 0.8)'; ctx.shadowBlur = pass ? 8 * dpr : 0
      ctx.stroke()
    }
    ctx.shadowBlur = 0
    ctx.beginPath()
    for (const s of MAPSEG) if (s[4] === 'stone') { ctx.moveTo(X(s[0]), Y(s[1])); ctx.lineTo(X(s[2]), Y(s[3])) }
    ctx.strokeStyle = 'rgba(255, 196, 120, 0.85)'; ctx.lineWidth = 1.2 * dpr; ctx.stroke()
    // memories as dots, dimmer when old
    for (const it of INTER) {
      if (it.kind !== 'memory' && it.kind !== 'ask') continue
      ctx.fillStyle = css(it.color, 0.85 * (1 - (it.decay || 0) * 0.65))
      const r = (big ? 1.7 : 1.2) * dpr
      ctx.fillRect(X(it.c[0]) - r, Y(it.c[2]) - r, r * 2, r * 2)
    }
    if (big) {
      ctx.font = `${11 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`
      ctx.textBaseline = 'middle'
      for (const w2 of WORLD.wings) {
        const p = WP(w2, w2.sEnd + 2.5, 0, 0)
        const on = selW === w2
        const sx = X(p[0]), sy = Y(p[2])
        ctx.textAlign = Math.abs(w2.d[0]) < 0.25 ? 'center' : w2.d[0] > 0 ? 'left' : 'right'
        ctx.fillStyle = on ? '#ffffff' : css(COL.label, 0.4 + 0.5 * w2.act)
        ctx.shadowColor = 'rgba(90, 215, 255, 0.9)'; ctx.shadowBlur = on ? 10 * dpr : 0
        ctx.fillText(w2.label, sx, sy + (Math.abs(w2.d[0]) < 0.25 ? Math.sign(w2.d[1]) * 4 * dpr : 0))
      }
      ctx.textAlign = 'center'
      ctx.shadowBlur = 0
      ctx.fillStyle = css(COL.self, 0.9); ctx.fillText('you', X(0), Y(0) + 14 * dpr)
    }
    // the path being travelled
    if (travel) {
      ctx.beginPath()
      travel.path.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
      ctx.strokeStyle = css(COL.path, 0.95); ctx.lineWidth = 1.6 * dpr; ctx.shadowColor = css(COL.path); ctx.shadowBlur = 8 * dpr; ctx.stroke(); ctx.shadowBlur = 0
    }
    // where the chosen recall lives
    const chosen = recall.cards[recall.sel]
    if (chosen) {
      const o = chosen.L.origin, pulse2 = (clock * 1.2) % 1
      ctx.beginPath(); ctx.arc(X(o[0]), Y(o[2]), (2.5 + pulse2 * 7) * dpr, 0, TAU)
      ctx.strokeStyle = css(chosen.L.color, 0.9 * (1 - pulse2)); ctx.lineWidth = 1.3 * dpr; ctx.stroke()
      ctx.fillStyle = css(chosen.L.color, 1); ctx.fillRect(X(o[0]) - 2 * dpr, Y(o[2]) - 2 * dpr, 4 * dpr, 4 * dpr)
    }
    // you are here
    const px = X(cam.x), py = Y(cam.z), fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw)
    const s = (big ? 9 : 7) * dpr
    ctx.beginPath()
    ctx.moveTo(px + fx * s, py + fz * s)
    ctx.lineTo(px - fx * s * 0.6 - fz * s * 0.55, py - fz * s * 0.6 + fx * s * 0.55)
    ctx.lineTo(px - fx * s * 0.25, py - fz * s * 0.25)
    ctx.lineTo(px - fx * s * 0.6 + fz * s * 0.55, py - fz * s * 0.6 - fx * s * 0.55)
    ctx.closePath()
    ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 10 * dpr; ctx.fill(); ctx.shadowBlur = 0
    const pulse = (clock * 0.8) % 1
    ctx.beginPath(); ctx.arc(px, py, s * (1 + pulse * 2.2), 0, TAU); ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - pulse)})`; ctx.lineWidth = dpr; ctx.stroke()
    ctx.restore()
    ctx.strokeStyle = big ? 'rgba(90, 215, 255, 0.35)' : 'rgba(90, 215, 255, 0.22)'
    ctx.lineWidth = dpr
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1)
  }

  // ── the HUD: brackets on what you face, the map, the prompt, the key line ────────────────────────

  function drawHud() {
    const ctx = hctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, pxW, pxH)
    if (!ready) return
    const showTarget = target && !travel && !reader.open && !mapUI.open && !recall.cards.length && !arrival
    if (showTarget) {
      const r = screenRect(target)
      if (r) {
        const x = clamp(r.x, 8, cssW - 8) * dpr, y = clamp(r.y, 8, cssH - 8) * dpr
        const x2 = clamp(r.x + r.w, 8, cssW - 8) * dpr, y2 = clamp(r.y + r.h, 8, cssH - 8) * dpr
        const pulse = reduced ? 0 : (Math.sin(clock * 3) * 0.5 + 0.5) * 4 * dpr
        const L = Math.min(22 * dpr, (x2 - x) / 4, (y2 - y) / 4)
        const c = target.color
        ctx.strokeStyle = css(mixc(c, COL.white, 0.35), 0.95)
        ctx.lineWidth = 1.4 * dpr
        ctx.shadowColor = css(c, 0.9); ctx.shadowBlur = 10 * dpr
        ctx.beginPath()
        for (const [cx, cy, sx, sy] of [[x - pulse, y - pulse, 1, 1], [x2 + pulse, y - pulse, -1, 1], [x2 + pulse, y2 + pulse, -1, -1], [x - pulse, y2 + pulse, 1, -1]]) {
          ctx.moveTo(cx + sx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * L)
        }
        ctx.stroke()
        ctx.shadowBlur = 0
        const verb = target.kind === 'door' ? (doorBack(target) ? 'back to' : 'enter') : 'read'
        const label = `↵ ${verb}  ${middle(oneLine(doorBack(target) || target.label || ''), 54)}`
        ctx.font = `${12 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const ly = Math.min(y2 + 10 * dpr + pulse, (cssH - 74) * dpr)
        const tw = ctx.measureText(label).width
        const lx = clamp((x + x2) / 2, tw / 2 + 12 * dpr, pxW - tw / 2 - 12 * dpr)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(lx - tw / 2 - 8 * dpr, ly - 4 * dpr, tw + 16 * dpr, 20 * dpr)
        ctx.fillStyle = css(mixc(c, COL.white, 0.5), 0.95)
        ctx.fillText(label, lx, ly)
      }
    }
    // tiny map, always; the big one on tab
    const mm = Math.round(Math.min(150, cssW * 0.16)) * dpr
    if (!reader.open) drawMap(ctx, pxW - mm - 14 * dpr, 14 * dpr, mm, mm, cam.x, cam.z, (mm / 72), false)
    if (mapUI.open) {
      const pad = 40 * dpr
      const w = pxW - pad * 2, h = pxH - pad * 2 - 30 * dpr
      const b = WORLD.bounds
      const scale = Math.min(w / (b.x1 - b.x0 + 70), h / (b.z1 - b.z0 + 16))
      drawMap(ctx, pad, pad, w, h, (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, scale, true)
    }
  }

  const where = $('where'), mode = $('mode'), promptEl = $('prompt'), keysEl = $('keys')
  let lastWhere = ''
  function updateWhere() {
    const here = locate(cam.x, cam.z)
    let parts
    if (!here.wing) parts = ['you', here.r < R_STONE ? 'among the stones' : 'the atrium']
    else {
      const w = here.wing
      parts = ['you', w.label]
      if (here.room < 0) parts.push('corridor')
      else { const room = w.rooms[here.room]; parts.push(`${room.title}${room.parts > 1 ? ` ${room.part}/${room.parts}` : ''}  ·  room ${here.room + 1} of ${w.rooms.length}`) }
    }
    const text = parts.join('  ›  ')
    if (text === lastWhere) return
    lastWhere = text
    where.textContent = ''
    parts.forEach((p, i) => { if (i) where.appendChild(document.createTextNode('  ›  ')); where.appendChild(i === parts.length - 1 ? el('b', null, p) : document.createTextNode(p)) })
  }
  let lastKeys = ''
  function updateKeys() {
    let k
    if (!ready) k = []
    else if (arrival) k = [['any key', 'skip']]
    else if (reader.open) k = reader.links.length ? [['↑↓', 'scroll'], ['tab', 'choose'], ['↵', 'go there'], ['esc', 'back']] : [['↑↓', 'scroll'], ['space', 'page'], ['esc', 'back']]
    else if (mapUI.open) k = [['←→', 'wing'], ['↵', 'go'], ['esc', 'close']]
    else if (recall.chars.length) k = [['tab ←→', 'choose'], ['↵', 'go there'], ['⌫', 'edit'], ['esc', 'sweep away']]
    else if (travel) k = [['esc', 'stop']]
    else k = [['↑↓', 'walk'], ['←→', 'turn'], ['⇧←→', 'step aside'], ['↵', 'enter / read'], ['type', 'recall'], ['tab', 'map'], ['~', 'home'], ['esc', 'back']]
    const sig = JSON.stringify(k)
    if (sig === lastKeys) return
    lastKeys = sig
    keysEl.textContent = ''
    k.forEach(([a, b], i) => { if (i) keysEl.appendChild(document.createTextNode('   ')); keysEl.appendChild(el('kbd', null, a)); keysEl.appendChild(document.createTextNode(' ' + b)) })
  }
  let lastPrompt = ''
  function updatePrompt() {
    const q = recall.q
    const nm = recall.cards.filter((c) => c.r.kind !== 'ask').length, na = recall.cards.filter((c) => c.r.kind === 'ask').length
    const sig = q + '|' + nm + '|' + na + '|' + recall.sel
    if (sig === lastPrompt) return
    lastPrompt = sig
    promptEl.textContent = ''
    if (!recall.chars.length) return
    promptEl.appendChild(document.createTextNode('› ' + q))
    promptEl.appendChild(el('span', 'caret'))
    const words2 = words(q).filter((t) => t.length >= 2).length
    const count = !words2 ? 'keep typing' : (nm || na) ? `${nm} ${nm === 1 ? 'memory' : 'memories'}${na ? ` · ${na} ${na === 1 ? 'message' : 'messages'}` : ''}  ·  ${recall.sel + 1}/${recall.cards.length}` : 'nothing remembered'
    promptEl.appendChild(el('span', 'count', count))
  }

  // ── input ────────────────────────────────────────────────────────────────────────────────────────

  function skipArrival() { arrival = false; clock = Math.max(clock, ARRIVE + 0.5); cam.y = EYE; cam.pitch = 0; cam.yaw = 0; updateKeys() }

  window.addEventListener('keydown', (e) => {
    if (!ready) return
    if (e.metaKey || e.ctrlKey) return
    const k = e.key
    const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', ' ', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Escape', 'Backspace']
    if (nav.includes(k)) e.preventDefault()
    if (arrival) { skipArrival(); return }
    if (reader.open) {
      const sh = R_.sheet
      if (k === 'Escape') closeRead()
      else if (k === 'ArrowDown' || k === 'j') sh.scrollTop += 48
      else if (k === 'ArrowUp' || k === 'k') sh.scrollTop -= 48
      else if (k === ' ' || k === 'PageDown') sh.scrollTop += sh.clientHeight * 0.85
      else if (k === 'PageUp') sh.scrollTop -= sh.clientHeight * 0.85
      else if (k === 'Home' || k === 'g') sh.scrollTop = 0
      else if (k === 'End' || k === 'G') sh.scrollTop = sh.scrollHeight
      else if (k === 'Tab') selectLink(reader.sel + (e.shiftKey ? -1 : 1))
      else if (k === 'Enter' && reader.links.length) { const l = reader.links[Math.max(0, reader.sel)]; closeRead(l.go) }
      return
    }
    if (mapUI.open) {
      const n = WORLD.wings.length
      if (k === 'Escape' || k === 'Tab') closeMap()
      else if ((k === 'ArrowRight' || k === 'ArrowDown') && n) mapUI.sel = (mapUI.sel + 1) % n
      else if ((k === 'ArrowLeft' || k === 'ArrowUp') && n) mapUI.sel = (mapUI.sel + n - 1) % n
      else if (k === 'Enter' && n) { const w = WORLD.wings[mapUI.sel]; const s = w.s1 + 2.4; const p = WP(w, s, 0, 0); closeMap(); travelTo({ x: p[0], z: p[2], yaw: w.theta, wing: w, s }) }
      else if (k.length === 1 && k !== ' ') { closeMap(); typeChar(k) }
      return
    }
    if (recall.chars.length) {
      const n = recall.cards.length
      if (k === 'Escape') dismissRecall(true)
      else if (k === 'Backspace') backspace()
      else if (k === 'Enter') chooseCard()
      else if ((k === 'Tab' && !e.shiftKey) || k === 'ArrowRight' || k === 'ArrowDown') { if (n) recall.sel = (recall.sel + 1) % n }
      else if ((k === 'Tab' && e.shiftKey) || k === 'ArrowLeft' || k === 'ArrowUp') { if (n) recall.sel = (recall.sel + n - 1) % n }
      else if (k.length === 1 && !e.altKey) typeChar(k)
      updateKeys()
      return
    }
    if (k === 'Escape') { if (travel) stopTravel(); else stepBack() }
    else if (k === 'Enter') { if (!travel) activate() }
    else if (k === 'Tab') openMap()
    else if (k === '~' || k === '`' || k === 'Home') travelTo(homeDest())
    else if (k.startsWith('Arrow')) { if (travel) stopTravel(); keys[k] = true; keys.shift = e.shiftKey }
    else if (k === 'Shift') keys.shift = true
    else if (k.length === 1 && k !== ' ' && !e.altKey) typeChar(k)
    updateKeys()
  })
  window.addEventListener('keyup', (e) => { keys[e.key] = false; if (e.key === 'Shift') keys.shift = false; else keys.shift = e.shiftKey })
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false })
  canvas.addEventListener('pointerdown', () => canvas.focus())

  // ── the frame ────────────────────────────────────────────────────────────────────────────────────

  function update(dt) {
    if (arrival) {
      const t = smoother(clock / 4.4)
      cam.y = EYE + 1.5 * (1 - t); cam.pitch = -0.34 * (1 - t); cam.yaw = -0.5 * (1 - t)
      if (clock >= ARRIVE) { arrival = false; updateKeys() }
    }
    let fovBoost = 0
    if (travel) {
      const tr = travel
      if (tr.phase === 'show') { tr.show += dt; if (tr.show > 0.45) tr.phase = 'move' }
      else if (tr.phase === 'move') {
        const prev = smoother(tr.t / tr.T) * tr.path.len
        tr.t = Math.min(tr.T, tr.t + dt)
        const d = smoother(tr.t / tr.T) * tr.path.len
        const p = sampleAt(tr.path, d), q = sampleAt(tr.path, Math.min(tr.path.len, d + 2.2))
        cam.x = p[0]; cam.z = p[1]
        const speed = (d - prev) / Math.max(dt, 1e-3)
        fovBoost = clamp(speed / 22, 0, 1) * 9
        let want = Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.2 ? Math.atan2(q[0] - p[0], -(q[1] - p[1])) : cam.yaw
        const u = d / Math.max(tr.path.len, 1e-3)
        want = angLerp(want, tr.dest.yaw, sstep(0.62, 1.0, u))
        cam.yaw = angLerp(cam.yaw, want, 1 - Math.exp(-dt * 7))
        if (tr.t >= tr.T) { tr.phase = 'settle'; tr.settle = 0 }
      } else {
        tr.settle += dt
        cam.yaw = angLerp(cam.yaw, tr.dest.yaw, 1 - Math.exp(-dt * 9))
        if (tr.settle > 0.5 || Math.abs(angWrap(cam.yaw - tr.dest.yaw)) < 0.002) {
          cam.yaw = tr.dest.yaw
          if (tr.dest.hi) hiPulse = { id: tr.dest.hi, until: clock + 2.4 }
          travel = null; updateKeys()
        }
      }
    } else if (!arrival && !reader.open && !mapUI.open && !recall.chars.length) {
      const fwd = (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0)
      const side = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0)
      const strafe = keys.shift ? side : 0, turn = keys.shift ? 0 : side
      cam.v += (fwd * 4.4 - cam.v) * (1 - Math.exp(-dt * 5.5))
      cam.sv += (strafe * 3.0 - cam.sv) * (1 - Math.exp(-dt * 6))
      cam.w += (turn * 1.9 - cam.w) * (1 - Math.exp(-dt * 8))
      cam.yaw += cam.w * dt
      const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw)
      const nx = cam.x + (fx * cam.v + Math.cos(cam.yaw) * cam.sv) * dt, nz = cam.z + (fz * cam.v + Math.sin(cam.yaw) * cam.sv) * dt
      const [cx, cz] = collide(nx, nz)
      cam.x = cx; cam.z = cz
      const moving = Math.hypot(cam.v, cam.sv)
      if (!reduced) cam.bob += dt * moving * 2.2
    } else { cam.v = cam.w = cam.sv = 0 }
    cam.fov = lerp(cam.fov, 62 + fovBoost, 1 - Math.exp(-dt * 6))
    dim = lerp(dim, reader.open ? 1 : mapUI.open ? 0.55 : 0, 1 - Math.exp(-dt * 10))
    recallDim = lerp(recallDim, recall.chars.length ? 1 : 0, 1 - Math.exp(-dt * (recall.chars.length ? 5 : 8)))
    if (reader.restore) { const f = (performance.now() - reader.restore.t0) / reader.restore.dur; stepRestore(clamp(f, 0, 1)) }
    target = (!travel && !arrival && !reader.open) ? pick() : null
  }

  function render() {
    resize()
    if (Atlas.dirty) uploadAtlas()
    const aspect = pxW / pxH
    perspective(P_, cam.fov * DEG, aspect, 0.1, 300)
    const bob = reduced ? 0 : Math.sin(cam.bob * 2) * 0.022 * Math.min(1, Math.abs(cam.v) / 3)
    const eye = [cam.x, cam.y + bob, cam.z]
    const cp = Math.cos(cam.pitch)
    lookAt(V_, eye, [eye[0] + Math.sin(cam.yaw) * cp, eye[1] + Math.sin(cam.pitch), eye[2] - Math.cos(cam.yaw) * cp], [0, 1, 0])
    mul(VP, P_, V_)
    const T = targets
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb)
    gl.viewport(0, 0, pxW, pxH)
    gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.depthMask(true)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    const fog = 44
    const hi = target ? target.id : 0
    const hi2 = hiPulse.until > clock ? hiPulse.id : 0
    const common = (p) => {
      gl.useProgram(p.p)
      gl.uniformMatrix4fv(p.u.uVP, false, VP)
      if (p.u.uT) gl.uniform1f(p.u.uT, clock)
      if (p.u.uFog) gl.uniform1f(p.u.uFog, fog)
      if (p.u.uHi) gl.uniform1f(p.u.uHi, hi)
      if (p.u.uHi2) gl.uniform1f(p.u.uHi2, hi2)
      if (p.u.uFlick) gl.uniform1f(p.u.uFlick, reduced ? 0 : 1)
      if (p.u.uRes) gl.uniform2f(p.u.uRes, pxW, pxH)
      if (p.u.uPx) gl.uniform1f(p.u.uPx, dpr)
      if (p.u.uDraw) gl.uniform1f(p.u.uDraw, 0)
      if (p.u.uWorld) gl.uniform1f(p.u.uWorld, 1 - 0.74 * recallDim)
    }
    // black walls first, so lines behind them are hidden
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true)
    gl.disable(gl.BLEND)
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 2)
    common(prog.fill); drawChunks(chunks.fills, FILL_L)
    gl.disable(gl.POLYGON_OFFSET_FILL)
    gl.depthMask(false)
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    dynSlot = 0
    const dyn = buildDynamic()
    common(prog.line); drawChunks(chunks.lines, LINE_L)
    gl.uniform1f(prog.line.u.uDraw, 1); drawDyn(dyn.linesDepth, LINE_L)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    common(prog.glyph); gl.uniform1i(prog.glyph.u.uAtlas, 0); drawChunks(chunks.glyphs, GLYPH_L)
    // what floats in the air: over everything
    gl.disable(gl.DEPTH_TEST)
    gl.uniform1f(prog.glyph.u.uHi, 0); gl.uniform1f(prog.glyph.u.uHi2, 0); gl.uniform1f(prog.glyph.u.uWorld, 1)
    drawDyn(dyn.back, GLYPH_L)
    common(prog.line); gl.uniform1f(prog.line.u.uDraw, 1); gl.uniform1f(prog.line.u.uHi, 0); gl.uniform1f(prog.line.u.uHi2, 0); gl.uniform1f(prog.line.u.uWorld, 1); drawDyn(dyn.linesTop, LINE_L)
    common(prog.glyph); gl.uniform1i(prog.glyph.u.uAtlas, 0); gl.uniform1f(prog.glyph.u.uHi, 0); gl.uniform1f(prog.glyph.u.uHi2, 0); gl.uniform1f(prog.glyph.u.uWorld, 1); drawDyn(dyn.glyphs, GLYPH_L)
    gl.disable(gl.BLEND)
    // bloom
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf); layout(POST_L)
    const pass = (p, dst, setup) => { gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null); gl.viewport(0, 0, dst ? dst.w : pxW, dst ? dst.h : pxH); gl.useProgram(p.p); setup(p.u); gl.drawArrays(gl.TRIANGLES, 0, 3) }
    const tex = (unit, t, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.uniform1i(loc, unit) }
    const down = (src, dst, gain, knee = 0) => pass(prog.down, dst, (u) => { tex(0, src, u.uSrc); gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h); gl.uniform1f(u.uGain, gain); gl.uniform1f(u.uKnee, knee) })
    const blur = (src, tmp) => {
      pass(prog.blur, tmp, (u) => { tex(0, src, u.uSrc); gl.uniform2f(u.uDir, 1 / src.w, 0) })
      pass(prog.blur, src, (u) => { tex(0, tmp, u.uSrc); gl.uniform2f(u.uDir, 0, 1 / tmp.h) })
    }
    down(T.scene, T.b1, 1.2, 0.07)
    down(T.b1, T.b2, 1.15); blur(T.b2, T.t2)
    down(T.b2, T.b3, 1.1); blur(T.b3, T.t3)
    down(T.b3, T.b4, 1.1); blur(T.b4, T.t4)
    pass(prog.comp, null, (u) => {
      tex(0, T.scene, u.uScene); tex(1, T.b1, u.uB1); tex(2, T.b2, u.uB2); tex(3, T.b3, u.uB3); tex(4, T.b4, u.uB4)
      gl.uniform2f(u.uRes, pxW, pxH); gl.uniform1f(u.uDim, dim); gl.uniform1f(u.uT, clock); gl.uniform1f(u.uPx, dpr); gl.uniform1f(u.uScan, 1); gl.uniform1f(u.uFade, fade)
    })
  }

  /** Per-frame geometry: the travel path, belief strings, recall words and cards. */
  function buildDynamic() {
    const linesDepth = [], linesTop = [], back = [], glyphs = []
    const up = [0, 1, 0]
    // the path, drawn ahead of you on the floor, dashes running toward the goal
    if (travel) {
      const tr = travel, path = tr.path
      const from = tr.phase === 'show' ? 0 : smoother(tr.t / tr.T) * path.len
      const to = tr.phase === 'show' ? path.len * easeOut(tr.show / 0.45) : path.len
      const step = 0.5
      for (let d = from; d < to - 0.01; d += step) {
        const a = sampleAt(path, d), b = sampleAt(path, Math.min(to, d + step))
        const dash = ((d / 1.4 - clock * 3) % 1 + 1) % 1
        const al = (dash < 0.5 ? 1 : 0.35) * (0.5 + 0.5 * sstep(0, 6, d - from))
        seg([a[0], 0.05, a[1]], [b[0], 0.05, b[1]], COL.path, al, 2.2, 0, 0, 0, linesDepth)
      }
      const e = path.pts[path.pts.length - 1]
      for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU + clock; seg([e[0] + Math.cos(a) * 0.3, 0.02, e[1] + Math.sin(a) * 0.3], [e[0] + Math.cos(a) * 0.12, 3.2, e[1] + Math.sin(a) * 0.12], COL.path, 0.5, 1.4, 0, 0, 0, linesDepth) }
    }
    // motes of light drifting up around you in the atrium
    if (Math.hypot(cam.x, cam.z) < WORLD.R + 30) {
      const tm = reduced ? 0 : clock
      for (let i = 0; i < 90; i++) {
        const r = 0.35 + Math.pow(hash3(i, 2, 7), 0.7) * (WORLD.R - 1.5)
        const sp = 0.12 + hash3(i, 3, 7) * 0.3
        const y = (hash3(i, 4, 7) * 9 + tm * sp) % 9
        const a = hash3(i, 1, 7) * TAU + tm * 0.04 * (0.5 + hash3(i, 5, 7)) * (r < 3 ? 2 : 1)
        const p = [Math.sin(a) * r, y, -Math.cos(a) * r]
        const al = 0.55 * Math.sin((Math.PI * y) / 9) * (0.35 + 0.65 * (1 - r / WORLD.R))
        seg(p, [p[0], p[1] + 0.04, p[2]], r < 3 ? COL.self : mixc(COL.self, COL.struct, 0.5), al, 2.0, 0, 0, 0, linesDepth)
      }
    }
    // belief strings: from the stone you face to the wings that hold what it cites
    const stone = (target && target.kind === 'stone' && !travel) ? target : null
    if (stone) {
      const seen = new Set()
      stone.sec.lines.forEach((line) => line.mems.forEach((m) => {
        const it = WORLD.memInter.get(m.id)
        if (!it || seen.has(it.wing.i)) return
        seen.add(it.wing.i)
        const a = [stone.c[0], stone.hh * 2 + 0.05, stone.c[2]]
        const b = WP(it.wing, it.wing.s0, 0, OPEN_H + 0.2)
        const n = 28
        let prev = a
        for (let i = 1; i <= n; i++) {
          const t = i / n
          const p = [lerp(a[0], b[0], t), lerp(a[1], b[1], t) + Math.sin(t * Math.PI) * 3.2, lerp(a[2], b[2], t)]
          const flow = (((t * 4 - clock * 0.9) % 1) + 1) % 1
          seg(prev, p, COL.self, 0.08 + 0.32 * (flow < 0.12 ? 1 : 0), 1.1, 0, 0, 0, linesDepth)
          prev = p
        }
      }))
    }
    // recall: the words in the air
    const wordsNow = recall.chars.length ? wordFrames() : []
    const drawWord = (f, alphaK, shift) => {
      f.chars.forEach((c, i) => {
        const age = clock - c.born
        const rise = reduced ? 0 : (1 - easeOut(age / 0.45)) * 0.55
        const a = clamp(age / 0.18, 0, 1) * alphaK
        const wob = reduced ? 0 : Math.sin(clock * 2 + i * 0.7) * 0.01
        const o = [f.o[0] + shift[0], f.o[1] - rise + wob + shift[1], f.o[2] + shift[2]]
        const flash = Math.max(0, 1 - age / 0.35)
        glyph(glyphs, c.ch, o, f.rt, up, i * Atlas.advEm, 0, f.em, mixc(COL.type, COL.white, flash), a * (1 + flash), -1, 0, 0, 0)
      })
    }
    wordsNow.forEach((f) => drawWord(f, 1, [0, 0, 0]))
    if (wordsNow.length && recall.chars.length) {
      const f = wordsNow[wordsNow.length - 1]
      if (recall.chars[recall.chars.length - 1].ch !== ' ' && Math.floor(clock * 2) % 2 === 0) {
        const x = f.chars.length * Atlas.advEm * f.em + 0.03
        seg(at3(f.o, f.rt, up, x, 0.02), at3(f.o, f.rt, up, x, -f.em * 1.05), COL.type, 0.9, 2, 0, 0, 0, linesTop)
      }
    }
    recall.goneWords = recall.goneWords.filter((g) => clock - g.at < 0.6)
    for (const g of recall.goneWords) {
      const t = clock - g.at
      g.frames.forEach((f) => drawWord(f, 1 - t / 0.6, [g.vx * t * (1 + t * 2), t * 0.6, g.vz * t * (1 + t * 2)]))
    }
    // recall: the cards, flying in from where they live
    const n = recall.cards.length
    recall.cards.forEach((c, j) => {
      const k = ((j - recall.sel + Math.floor(n / 2)) % n + n) % n - Math.floor(n / 2)
      const sel = k === 0
      const a = cam.yaw + k * 32 * DEG
      const dist = sel ? 2.35 : 3.15
      const slot = [cam.x + Math.sin(a) * dist, EYE - 0.12 + (sel ? 0.02 : -0.04), cam.z - Math.cos(a) * dist]
      const fly = reduced ? 1 : clamp((clock - c.born) / 1.0, 0, 1)
      if (fly < 1) {
        const f = easeOut(fly)
        const mid = [(c.start[0] + slot[0]) / 2, Math.max(c.start[1], slot[1]) + 2 + Math.hypot(c.start[0] - slot[0], c.start[2] - slot[2]) * 0.06, (c.start[2] + slot[2]) / 2]
        const bz = (t) => [lerp(lerp(c.start[0], mid[0], t), lerp(mid[0], slot[0], t), t), lerp(lerp(c.start[1], mid[1], t), lerp(mid[1], slot[1], t), t), lerp(lerp(c.start[2], mid[2], t), lerp(mid[2], slot[2], t), t)]
        c.pos = bz(f)
        if (fly > 0) for (let i = 0; i < 8; i++) { const t0 = Math.max(0, f - (i + 1) * 0.03), t1 = Math.max(0, f - i * 0.03); seg(bz(t0), bz(t1), c.L.color, 0.9 * (1 - i / 8), 2.2 - i * 0.2, 0, 0, 0, linesTop) }
      } else c.pos = reduced ? slot : lerp3(c.pos, slot, 1 - Math.exp(-1 / 60 * 10))
      const show = fly > 0 ? 1 : 0
      drawCard(c, c.pos, sel ? 1 : 0.82, (sel ? 1 : 0.62) * show * sstep(0, 0.25, fly), sel, back, linesTop, glyphs)
      if (sel && fly >= 1) {
        // where it lives: a thread from the card back to its room, light running toward you
        const a0 = [c.pos[0], c.pos[1] - c.L.h / 2, c.pos[2]], b0 = c.L.origin
        const lift2 = 1.5 + Math.hypot(b0[0] - a0[0], b0[2] - a0[2]) * 0.05
        let prev = a0
        for (let i = 1; i <= 40; i++) {
          const t = i / 40
          const p = [lerp(a0[0], b0[0], t), lerp(a0[1], b0[1], t) - Math.sin(t * Math.PI) * 0.4 + Math.sin(t * Math.PI) * lift2 * t, lerp(a0[2], b0[2], t)]
          const flow = (((t * 6 + clock * 1.6) % 1) + 1) % 1
          seg(prev, p, c.L.color, (0.1 + (flow < 0.2 ? 0.45 : 0)) * (1 - t * 0.5), 1.3, 0, 0, 0, linesTop)
          prev = p
        }
      }
    })
    void n
    recall.gone = recall.gone.filter((g) => clock - g.at < 0.55)
    for (const g of recall.gone) {
      const t = clock - g.at
      const p = g.mode === 'sweep' ? [g.c.pos[0] + g.vx * t * (1 + t * 3), g.c.pos[1] + t * 0.8, g.c.pos[2] + g.vz * t * (1 + t * 3)] : g.c.pos
      drawCard(g.c, p, 0.82 * (g.mode === 'fade' ? 1 - t : 1), 0.6 * (1 - t / 0.55), false, back, linesTop, glyphs)
    }
    return { linesDepth, linesTop, back, glyphs }
  }

  function drawCard(c, pos, scale, alpha, sel, back, lines, glyphs) {
    if (alpha <= 0.01) return
    const dx = cam.x - pos[0], dz = cam.z - pos[2], d = Math.hypot(dx, dz) || 1
    const n = [dx / d, 0, dz / d], rt = [n[2], 0, -n[0]], up = [0, 1, 0]
    const W = c.L.w * scale, H = c.L.h * scale
    const tl = [pos[0] - rt[0] * W / 2, pos[1] + H / 2, pos[2] - rt[2] * W / 2]
    const P = (x, y) => [tl[0] + rt[0] * x, tl[1] - y, tl[2] + rt[2] * x]
    solidQuad(back, P(0, 0), P(W, 0), P(0, H), P(W, H), [0, 0, 0], 0.95 * Math.min(1, alpha * 2.2), 1)
    const col = c.L.color
    poly([P(0, 0), P(W, 0), P(W, H), P(0, H)], true, col, (sel ? 0.95 : 0.5) * alpha, sel ? 1.6 : 1.1, 0, 0, 0)
    for (const [x, y, sx, sy] of [[0, 0, 1, 1], [W, 0, -1, 1], [W, H, -1, -1], [0, H, 1, -1]]) { seg(P(x, y), P(x + sx * 0.12 * scale, y), col, alpha, 2, 0, 0, 0, lines); seg(P(x, y), P(x, y + sy * 0.12 * scale), col, alpha, 2, 0, 0, 0, lines) }
    for (const g of c.L.g) glyph(glyphs, g.ch, P(g.x * scale, g.y * scale), rt, up, 0, 0, g.e * scale, g.col || COL.ink, (g.a ?? 1) * alpha * (sel || g.hi ? 1 : 0.85), -1, 0, 0, 0)
    function poly(pts, closed, cc, a, w) { for (let i = 0; i < pts.length; i++) seg(pts[i], pts[(i + 1) % pts.length], cc, a, w, 0, 0, 0, lines) }
  }

  const DBG = {}
  let running = true, lastTs = 0
  function frame(ts) {
    if (!running) return
    const dt = Math.min(0.1, lastTs ? (ts - lastTs) / 1000 : 0.016)
    lastTs = ts
    clock += dt
    const t0 = performance.now()
    update(dt)
    render()
    drawHud()
    updateWhere(); updatePrompt()
    DBG.cpu = (DBG.cpu || 0) * 0.9 + (performance.now() - t0) * 0.1
    requestAnimationFrame(frame)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false
    else if (!running) { running = true; lastTs = 0; requestAnimationFrame(frame) }
  })

  // ── start ────────────────────────────────────────────────────────────────────────────────────────

  async function start() {
    if (!initGL()) { $('loading').textContent = 'This needs WebGL.'; return }
    let data
    try { data = await MemoryData.load() } catch (err) { $('loading').textContent = 'Could not read memories: ' + String(err?.message || err).slice(0, 120); return }
    const W = buildWorld(data)
    chunks = { lines: makeChunks(LN, LINE_F), glyphs: makeChunks(GLY, GLYPH_F), fills: makeChunks(FL, FILL_F) }
    W.counts = { lines: LN.length / LINE_F / 4, glyphs: GLY.length / GLYPH_F / 4, fills: FL.length / FILL_F / 4, inter: INTER.length }
    window.__palace = { DBG, W, cam, recall, reader, mapUI, get travel() { return travel }, get clock() { return clock }, get target() { return target }, counts: W.counts }
    LN = []; GLY = []; FL = []
    $('loading').remove()
    mode.textContent = data.real ? `your memories · ${fmt(data.snapshot.memories?.length)} notes · ${fmt(data.asks.length)} messages` : 'an invented person · add ?real for yours'
    ready = true
    resize()
    if (reduced) skipArrival()
    updateKeys()
    canvas.focus()
    requestAnimationFrame(frame)
  }
  start()
})()
