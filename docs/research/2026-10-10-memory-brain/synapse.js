/*
 * Synapse: fly into a brain built from what your agents remember about you.
 *
 * Every message you sent is a neuron, placed in the region of its project and tinted by the agent it went to.
 * Memory notes are bright engrams on the cortex; memories kept for every project sit in the hippocampi. About
 * You lines are hubs along the bridge between the hemispheres, with axons to the memories they cite. Older
 * activity whose words are not loaded here lies deep inside as faint dust. The brain fires in the rhythm of
 * your last two weeks. Type to recall (spreading activation), Enter to dive, [ ] to move through time.
 *
 * Reads only MemoryData. Its text is untrusted (written by models and people): it reaches the screen only
 * through canvas fillText and textContent. Nothing here writes anywhere.
 */
(function () {
  'use strict'

  const DAY = 86_400_000
  const HOUR = 3_600_000
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

  // ── numbers ──────────────────────────────────────────────────────────────────────────────────────

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
  const lerp = (a, b, t) => a + (b - a) * t
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3)
  const easeInOut = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2

  // Perlin noise, for the folds of the cortex and the borders between regions.
  const perm = new Uint8Array(512)
  ;(function () { const r = rng(7); const p = Array.from({ length: 256 }, (_, i) => i); for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t } for (let i = 0; i < 512; i++) perm[i] = p[i & 255] })()
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
  function grad(h, x, y, z) { h &= 15; const u = h < 8 ? x : y; const v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v) }
  function noise(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z)
    const X = fx & 255, Y = fy & 255, Z = fz & 255
    x -= fx; y -= fy; z -= fz
    const u = fade(x), v = fade(y), w = fade(z)
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z, B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z
    return lerp(
      lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v), w)
  }

  // ── colour ───────────────────────────────────────────────────────────────────────────────────────

  function hexRGB(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); const n = m ? parseInt(m[1], 16) : 0x8b8f96; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] }
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
  const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`
  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
  }
  const WHITE = [1, 1, 1]
  const GOLD = [1, 0.84, 0.56]
  const BG = [0.008, 0.012, 0.02]

  // ── words and time ───────────────────────────────────────────────────────────────────────────────

  const words = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []
  const STOP = new Set('the and for with that this from into when what where which have has are was were will would should could about after before every never always only than then them they their there here your you our its not but all any each one two also just like make made does done keep more most some such over under very much many same other need needs use used uses using via per why how apply user users memory memories note notes summary saved topic profile observation handbook remembered request rules description file files line lines thing things want wants work works working please can let lets now new get got see look looks into onto been being able way does did doing dont don isn didn wasn won yes okay ok'.split(' '))
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const pad = (n) => String(n).padStart(2, '0')
  const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
  const dayShort = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}` }
  const dayLong = (ms) => { const d = new Date(ms); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
  const num = (n) => Number(n).toLocaleString('en-US')
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many || one + 's'}`
  function ago(ms, now) {
    const d = Math.max(0, now - ms)
    if (d < 90e3) return 'just now'
    if (d < HOUR) return `${Math.round(d / 60e3)} min ago`
    if (d < DAY) return `${Math.round(d / HOUR)} h ago`
    if (d < 45 * DAY) return plural(Math.round(d / DAY), 'day') + ' ago'
    return plural(Math.round(d / (30 * DAY)), 'month') + ' ago'
  }
  const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  /** A folder-derived project name as a person would say it. */
  const pretty = (name) => String(name ?? '').replace(/^Library-Application-Support-/i, '').replace(/-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, '').replace(/-projects$/i, '') || String(name ?? '')
  const short = (s, n) => { s = flat(s); return s.length > n ? s.slice(0, n - 1) + '…' : s }

  // ── the shape of a brain ─────────────────────────────────────────────────────────────────────────
  // x: left/right, y: up, z: front. Each function returns ~1 at the surface, smaller inside, -1 outside.

  const CENTER = { x: 0, y: 0.0, z: -0.06 }

  function cerebrum(x, y, z) {
    const ax = Math.abs(x)
    if (ax < 0.03 && y > -0.26) return -1 // the longitudinal fissure between the hemispheres
    const qx = ax - 0.42, qy = y - 0.04, qz = z
    const front = smooth(0.1, 1.0, qz), back = smooth(0.4, 1.05, -qz)
    const rx = (qx > 0 ? 0.43 : 0.42) * (1 - 0.2 * front)
    const ry = qy > 0 ? 0.6 * (1 - 0.24 * front - 0.32 * back) : 0.34 * (1 - 0.3 * back - 0.42 * smooth(0.25, 0.95, qz))
    const rz = qz > 0 ? 0.98 : 1.04
    const px = Math.abs(qx / rx)
    const e1 = Math.sqrt((qx > 0 ? px * px : Math.pow(px, 6)) + (qy / ry) ** 2 + (qz / rz) ** 2)
    const tx = ax - 0.5, ty = y + 0.25, tz = z - 0.03
    const e2 = Math.sqrt((tx / 0.31) ** 2 + (ty / 0.25) ** 2 + (tz / (tz > 0 ? 0.5 : 0.48)) ** 2)
    const e = Math.min(e1, e2)
    if (e > 1) return -1
    // the lateral fissure: the groove above the temporal lobe
    if (ax > 0.48 && z > -0.42 && z < 0.5 && e > 0.78) {
      const fy = -0.12 + 0.17 * smooth(0.45, -0.4, z)
      if (Math.abs(y - fy) < 0.03) return -1
    }
    return e
  }

  function cerebellum(x, y, z) {
    const qx = Math.abs(x) - 0.22, qy = y + 0.53, qz = z + 0.72
    const e = Math.sqrt((qx / 0.37) ** 2 + (qy / 0.2) ** 2 + (qz / 0.29) ** 2)
    if (e > 1) return -1
    if (e > 0.7) { const r = Math.hypot(qy + 0.03, qz + 0.14); if ((r * 38) % 1 < 0.3) return -1 } // folia
    return e
  }

  function stem(x, y, z) {
    if (y > -0.2 || y < -1.08) return -1
    const t = (-0.2 - y) / 0.88
    const cz = -0.25 - 0.16 * t
    const r = 0.1 - 0.03 * t + 0.05 * Math.exp(-(((t - 0.2) / 0.13) ** 2))
    const d = Math.hypot(x / 1.2, z - cz) / r
    return d <= 1 ? d : -1
  }

  /** Points filling the brain: a dense cortex (the shell), a sparse interior, and the brain stem. */
  function samplePool(nShell, nInner, nStem, seed) {
    const r = rng(seed)
    const shell = [], inner = [], stemPts = []
    let guard = 0
    while ((shell.length < nShell || inner.length < nInner) && guard++ < 3e6) {
      const x = (r() * 2 - 1) * 0.88, y = -0.75 + r() * 1.44, z = -1.06 + r() * 2.06
      let e = cerebrum(x, y, z), part = 0
      if (e < 0) { e = cerebellum(x, y, z); part = 1 }
      if (e < 0) continue
      if (e > 0.8) {
        if (shell.length >= nShell) continue
        let fold = 1
        if (part === 0 && e > 0.84) {
          const n = Math.abs(noise(x * 3.7 + 5.1, y * 3.7 + 1.7, z * 3.7))
          if (n < 0.09) continue // sulci
          fold = smooth(0.09, 0.42, n)
        }
        shell.push({ x, y, z, e, part, fold, region: -1, used: false })
      } else {
        if (inner.length >= nInner || r() > 0.5) continue
        inner.push({ x, y, z, e, part, region: -1, used: false })
      }
    }
    guard = 0
    while (stemPts.length < nStem && guard++ < 4e5) {
      const x = (r() * 2 - 1) * 0.2, y = -1.08 + r() * 0.9, z = -0.62 + r() * 0.55
      const e = stem(x, y, z)
      if (e >= 0 && (e > 0.7 || r() < 0.3)) stemPts.push({ x, y, z, e })
    }
    return { shell, inner, stem: stemPts }
  }

  /** A spatial hash, to grow a conversation as one patch of cortex. */
  function makeGrid(points, cell) {
    const map = new Map()
    const key = (ix, iy, iz) => ix + iy * 128 + iz * 16384
    const cellOf = (v) => Math.floor((v + 1.3) / cell)
    for (const p of points) {
      const k = key(cellOf(p.x), cellOf(p.y), cellOf(p.z))
      let list = map.get(k)
      if (!list) map.set(k, (list = []))
      list.push(p)
    }
    function claim(seed, k, accept) {
      const out = []
      const cx = cellOf(seed.x), cy = cellOf(seed.y), cz = cellOf(seed.z)
      for (let r = 0; r <= 26 && out.length < k; r++) {
        const ring = []
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
          const list = map.get(key(cx + dx, cy + dy, cz + dz))
          if (!list) continue
          for (const p of list) if (!p.used && accept(p)) ring.push(p)
        }
        ring.sort((a, b) => dist2(a, seed) - dist2(b, seed))
        for (const p of ring) { if (out.length >= k) break; p.used = true; out.push(p) }
      }
      return out
    }
    return { claim }
  }

  // Lobes, in the order regions are given them (largest first).
  const ANCHORS = [
    [-0.45, 0.3, 0.45], [0.45, 0.3, 0.45], [-0.45, 0.42, -0.4], [0.45, 0.42, -0.4], [-0.64, -0.3, 0.05], [0.64, -0.3, 0.05],
    [-0.32, 0.08, -0.92], [0.32, 0.08, -0.92], [0, -0.55, -0.74], [-0.4, 0.58, 0.05], [0.4, 0.58, 0.05], [-0.3, -0.02, 0.9],
    [0.3, -0.02, 0.9], [-0.68, 0.04, -0.52], [0.68, 0.04, -0.52], [-0.28, -0.2, 0.58], [0.28, -0.2, 0.58],
  ]

  /** Capacity-constrained Voronoi over the cortex: each region gets a lobe sized to what it holds. */
  function partition(points, targets) {
    const K = targets.length
    const seeds = targets.map((_, i) => {
      const a = ANCHORS[i % ANCHORS.length]
      const j = Math.floor(i / ANCHORS.length)
      return { x: a[0] * (1 - 0.18 * j), y: a[1] - 0.1 * j, z: a[2] * (1 - 0.2 * j) }
    })
    const warped = points.map((p) => ({
      x: p.x + 0.07 * noise(p.x * 2.6 + 11, p.y * 2.6, p.z * 2.6),
      y: p.y + 0.07 * noise(p.x * 2.6, p.y * 2.6 + 23, p.z * 2.6),
      z: p.z + 0.07 * noise(p.x * 2.6, p.y * 2.6, p.z * 2.6 + 37),
    }))
    const w = new Float64Array(K)
    const counts = new Float64Array(K)
    for (let iter = 0; iter < 28; iter++) {
      counts.fill(0)
      for (let i = 0; i < points.length; i++) {
        const q = warped[i]
        let best = 0, bestD = Infinity
        for (let k = 0; k < K; k++) { const d = dist2(q, seeds[k]) - w[k]; if (d < bestD) { bestD = d; best = k } }
        points[i].region = best
        counts[best]++
      }
      for (let k = 0; k < K; k++) w[k] += 0.9 * (targets[k] - counts[k] / points.length)
    }
    return { seeds, warped, w }
  }

  // ── the model: regions, neurons, engrams, hubs, and how they connect ─────────────────────────────

  const NEURON = 1, GHOST = 2, ENGRAM = 3, HUB = 4

  function buildModel(data) {
    const { snapshot } = data
    const asks = (data.asks || []).filter((a) => a && Number.isFinite(a.at))
    const now = snapshot.observedAt || Date.now()
    const R = rng(1010)
    const agentCache = new Map()
    const agentOf = (id) => {
      if (!agentCache.has(id)) { const a = MemoryData.agent(id, snapshot); agentCache.set(id, { id, name: a.name || id, rgb: hexRGB(a.color) }) }
      return agentCache.get(id)
    }

    // Regions: the person's projects, by folder; conversations with no folder recorded are placed by the
    // project names their words mention.
    const projects = (snapshot.projects || []).filter((p) => p && p.name)
    const tilde = (p) => String(p || '').replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/\/+$/, '')
    const projectPaths = projects
      .map((p) => ({ name: p.name, path: tilde(p.path || (p.key && !String(p.key).startsWith('name:') ? p.key : '')) }))
      .filter((p) => p.path && p.path !== '~')
      .sort((a, b) => b.path.length - a.path.length)
    function placeOfCwd(cwd) {
      const c = tilde(cwd)
      if (!c) return null
      for (const p of projectPaths) if (c === p.path || c.startsWith(p.path + '/') || c.startsWith(p.path + '.')) return p.name
      const segments = c.split('/')
      for (const p of projects) if (segments.includes(p.name)) return p.name // a worktree named after its repository
      if (/^\/(private\/)?(tmp|var)(\/|$)/.test(c)) return 'scratch folders'
      if (c === '~') return 'home folder'
      return segments.slice(0, 2).join('/').replace(/^~\//, '') || c
    }
    const GENERIC = new Set(['autonomous', 'code', 'harnesses', 'projects', 'project', 'library', 'application', 'support', 'app', 'page', 'main', 'test', 'tests', 'agent', 'agents', 'claude', 'codex', 'brainstorms', 'chat', 'live', 'first', 'shell', 'home'])
    const tokenDf = new Map()
    const projectTokens = projects.map((p) => {
      const tokens = [...new Set(String(p.name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !/^[0-9a-f]{6,}$/.test(t) && !GENERIC.has(t)))]
      for (const t of tokens) tokenDf.set(t, (tokenDf.get(t) || 0) + 1)
      return { name: p.name, full: String(p.name).toLowerCase(), tokens, prior: Math.log(1 + (p.asks || 0)) }
    })
    function placeOfWords(text) {
      let best = null, bestScore = 0
      for (const p of projectTokens) {
        let hits = 0, score = 0
        const full = text.split(p.full).length - 1
        if (full) { hits += full; score += 4 * Math.log(1 + full) }
        for (const t of p.tokens) {
          const n = text.split(t).length - 1
          if (n) { hits += n; score += Math.log(1 + projects.length / tokenDf.get(t)) * Math.log(1 + n) }
        }
        if (!hits) continue
        score = score / Math.max(1, Math.sqrt(p.tokens.length)) + 0.5 * p.prior
        if (score > bestScore) { bestScore = score; best = p.name }
      }
      return best
    }

    // Conversations
    const sessions = new Map()
    for (const ask of asks) {
      let s = sessions.get(ask.sessionId)
      if (!s) sessions.set(ask.sessionId, (s = { id: ask.sessionId, asks: [], engine: ask.engine, title: '', places: new Map() }))
      s.asks.push(ask)
      if (!s.title && ask.title) s.title = ask.title
      const place = placeOfCwd(ask.cwd)
      if (place) s.places.set(place, (s.places.get(place) || 0) + 1)
    }
    for (const s of sessions.values()) {
      s.asks.sort((a, b) => a.turn - b.turn || a.at - b.at)
      s.start = Math.min(...s.asks.map((a) => a.at))
      s.end = Math.max(...s.asks.map((a) => a.at))
      if (s.places.size) s.place = [...s.places].sort((a, b) => b[1] - a[1])[0][0]
      else {
        const text = (s.title + ' ' + s.asks.map((a) => a.text).join(' ')).toLowerCase().slice(0, 40000)
        s.place = placeOfWords(text) || 'no folder recorded'
        s.inferred = true
      }
    }

    // Region sizes, then merge the crumbs
    const memories = (snapshot.memories || []).filter((m) => m && m.id)
    const size = new Map()
    const bump = (name, n, mem) => { const r = size.get(name) || { name, neurons: 0, memories: 0 }; r.neurons += n; r.memories += mem; size.set(name, r) }
    for (const s of sessions.values()) bump(s.place, s.asks.length, 0)
    for (const m of memories) if (m.project && m.project.name) bump(m.project.name, 0, 1)
    const total = [...size.values()].reduce((sum, r) => sum + r.neurons, 0) || 1
    let list = [...size.values()].sort((a, b) => (b.neurons + b.memories * 6) - (a.neurons + a.memories * 6))
    const keep = new Set()
    for (const r of list) {
      if (keep.size >= 15) break
      if (r.memories || r.neurons >= Math.max(6, total * 0.004)) keep.add(r.name)
    }
    const ELSEWHERE = 'elsewhere'
    const regionName = (name) => (keep.has(name) ? name : ELSEWHERE)
    const merged = new Map()
    for (const r of list) {
      const name = regionName(r.name)
      const m = merged.get(name) || { name, neurons: 0, memories: 0, parts: [] }
      m.neurons += r.neurons; m.memories += r.memories; m.parts.push(r.name)
      merged.set(name, m)
    }
    list = [...merged.values()].sort((a, b) => (b.neurons + b.memories * 6) - (a.neurons + a.memories * 6))
    const regions = list.map((r, id) => ({ id, name: r.name, label: pretty(r.name), parts: r.parts, neuronCount: r.neurons, memoryCount: r.memories, nodes: [], engrams: [], color: null }))
    const regionByName = new Map(regions.map((r) => [r.name, r]))
    const regionOf = (name) => regionByName.get(regionName(name)) || regionByName.get(ELSEWHERE) || regions[0]

    // Older activity: the days the session index counted but whose words are not among the messages loaded here.
    const loadedPerDay = new Map()
    for (const a of asks) { const k = `${dayKey(a.at)} ${a.engine}`; loadedPerDay.set(k, (loadedPerDay.get(k) || 0) + 1) }
    const ghostDays = []
    for (const row of (snapshot.sessions && snapshot.sessions.activity) || []) {
      if (!row || !row.day) continue
      const extra = (row.asks || 0) - (loadedPerDay.get(`${row.day} ${row.engine}`) || 0)
      if (extra > 0) ghostDays.push({ day: row.day, engine: row.engine, count: extra })
    }
    let ghostTotal = ghostDays.reduce((s, d) => s + d.count, 0)
    const ghostScale = ghostTotal > 7000 ? 7000 / ghostTotal : 1
    ghostTotal = 0
    for (const d of ghostDays) { d.count = Math.max(1, Math.round(d.count * ghostScale)); ghostTotal += d.count }

    // ── layout ──
    const nShell = clamp(Math.round(asks.length * 3.4 + memories.length * 4), 21000, 26000)
    const nInner = clamp(Math.round(ghostTotal * 1.45), 2600, 10500)
    const pool = samplePool(nShell, nInner, 900, 31)
    const capacityNeed = regions.map((r) => (r.neuronCount + r.memoryCount + 4) * 1.12 / pool.shell.length)
    let targets = regions.map((r) => Math.max(0.025, Math.pow(Math.max(1, r.neuronCount + r.memoryCount * 8), 0.72)))
    const tSum = targets.reduce((a, b) => a + b, 0)
    targets = targets.map((t, i) => Math.max(t / tSum, capacityNeed[i]))
    const t2 = targets.reduce((a, b) => a + b, 0)
    targets = targets.map((t) => t / t2)
    const parts = regions.length ? partition(pool.shell, targets) : { seeds: [] }
    for (const p of pool.inner) {
      let best = 0, bestD = Infinity
      for (let k = 0; k < parts.seeds.length; k++) { const d = dist2(p, parts.seeds[k]); if (d < bestD) { bestD = d; best = k } }
      p.region = best
    }
    const shellGrid = makeGrid(pool.shell, 0.06)
    const innerGrid = makeGrid(pool.inner, 0.08)

    // Region tints for the scaffold: quiet, cool, distinct.
    const HUES = [212, 168, 262, 32, 196, 300, 140, 232, 12, 186, 280, 54, 224, 152, 336, 248]
    regions.forEach((r, i) => { r.color = hsl(HUES[i % HUES.length], 0.5, 0.64) })
    for (const r of regions) {
      const own = pool.shell.filter((p) => p.region === r.id)
      r.slots = own
      const c = own.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 })
      const n = Math.max(1, own.length)
      r.centroid = { x: c.x / n, y: c.y / n, z: c.z / n }
    }

    const nodes = []
    const add = (node) => { node.index = nodes.length; node.edges = []; nodes.push(node); return node }

    // Engrams first: the outermost cortex of their region, spread apart.
    const memoryNodes = new Map()
    const globalMemories = []
    for (const m of memories) {
      if (!(m.project && m.project.name)) { globalMemories.push(m); continue }
      const region = regionOf(m.project.name)
      region.engrams.push(m)
    }
    for (const region of regions) {
      if (!region.engrams.length) continue
      let candidates = region.slots.filter((p) => p.e > 0.9 && !p.used)
      if (candidates.length < region.engrams.length * 2) candidates = region.slots.filter((p) => !p.used)
      const chosen = []
      if (candidates.length) {
        let first = candidates[0], bd = Infinity
        for (const p of candidates) { const d = dist2(p, region.centroid); if (d < bd) { bd = d; first = p } }
        chosen.push(first); first.used = true
        const minD = candidates.map((p) => dist2(p, first))
        while (chosen.length < region.engrams.length && chosen.length < candidates.length) {
          let bi = -1, best = -1
          for (let i = 0; i < candidates.length; i++) if (!candidates[i].used && minD[i] > best) { best = minD[i]; bi = i }
          if (bi < 0) break
          const p = candidates[bi]; p.used = true; chosen.push(p)
          for (let i = 0; i < candidates.length; i++) { const d = dist2(candidates[i], p); if (d < minD[i]) minD[i] = d }
        }
      }
      region.engrams.sort((a, b) => (a.modified || 0) - (b.modified || 0))
      region.engrams.forEach((m, i) => {
        const p = chosen[i] || region.centroid
        const agent = agentOf(m.agent)
        const node = add({
          k: ENGRAM, x: p.x, y: p.y, z: p.z, rgb: mix(agent.rgb, WHITE, 0.42), glow: 1.5,
          size: 0.017 + 0.006 * clamp(Math.log10(1 + (m.size || (m.body || '').length)) / 4.5, 0, 1),
          birth: m.modified || now, region: region.id, memory: m, agent,
          hay: { title: flat(m.title).toLowerCase(), desc: flat(m.description).toLowerCase(), body: String(m.body || '').toLowerCase() },
        })
        region.nodes.push(node)
        memoryNodes.set(m.id, node)
      })
    }
    // Memories kept for every project live in the hippocampi: memory's own organ.
    const hippocampus = (side, u) => ({ x: side * (0.27 - 0.05 * u), y: -0.24 + 0.2 * u * u, z: 0.2 - 0.62 * u })
    globalMemories.sort((a, b) => String(a.agent).localeCompare(String(b.agent)) || (a.modified || 0) - (b.modified || 0))
    globalMemories.forEach((m, i) => {
      const side = hash(m.agent) % 2 ? 1 : -1
      const u = (i + 0.5) / globalMemories.length
      const p = hippocampus(side, (u * 2) % 1 * 0.9 + 0.05)
      const agent = agentOf(m.agent)
      const node = add({
        k: ENGRAM, x: p.x + (R() - 0.5) * 0.03, y: p.y + (R() - 0.5) * 0.03, z: p.z + (R() - 0.5) * 0.03,
        rgb: mix(agent.rgb, WHITE, 0.42), glow: 1.5,
        size: 0.017 + 0.006 * clamp(Math.log10(1 + (m.size || (m.body || '').length)) / 4.5, 0, 1),
        birth: m.modified || now, region: -1, memory: m, agent,
        hay: { title: flat(m.title).toLowerCase(), desc: flat(m.description).toLowerCase(), body: String(m.body || '').toLowerCase() },
      })
      memoryNodes.set(m.id, node)
    })

    // Neurons: each conversation grows as one patch, older ones nearer the region's root.
    const neuronByTurn = new Map()
    const bySession = new Map()
    for (const region of regions) {
      const own = [...sessions.values()].filter((s) => regionOf(s.place) === region).sort((a, b) => a.start - b.start)
      if (!own.length) continue
      let root = region.slots[0] || region.centroid, rd = Infinity
      for (const p of region.slots) { const d = dist2(p, CENTER); if (d < rd) { rd = d; root = p } }
      const ordered = region.slots.slice().sort((a, b) => dist2(a, root) - dist2(b, root))
      const totalAsks = own.reduce((s, x) => s + x.asks.length, 0)
      let cum = 0
      for (const s of own) {
        const q = (cum + s.asks.length / 2) / totalAsks
        cum += s.asks.length
        const seed = ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(q * (ordered.length - 1)))] : region.centroid
        const spots = shellGrid.claim(seed, s.asks.length, (p) => p.region === region.id)
        const agent = agentOf(s.engine)
        const chain = []
        s.asks.forEach((ask, i) => {
          const p = spots[i] || { x: seed.x + (R() - 0.5) * 0.06, y: seed.y + (R() - 0.5) * 0.06, z: seed.z + (R() - 0.5) * 0.06 }
          const node = add({
            k: NEURON, x: p.x + (R() - 0.5) * 0.008, y: p.y + (R() - 0.5) * 0.008, z: p.z + (R() - 0.5) * 0.008,
            rgb: agentOf(ask.engine).rgb, glow: 1.5,
            size: 0.0068 * (1 + 0.35 * clamp(Math.log10(1 + (ask.length || ask.text.length)) / 3.4, 0, 1)),
            birth: ask.at, region: region.id, ask, agent: agentOf(ask.engine), session: s, lower: String(ask.text || '').toLowerCase(),
          })
          region.nodes.push(node)
          chain.push(node)
          neuronByTurn.set(`${ask.sessionId}:${ask.turn}`, node)
        })
        s.nodes = chain
        s.region = region
        s.agent = agent
        bySession.set(s.id, s)
      }
    }

    // Ghosts: older days, deep inside, oldest nearest the centre.
    const ghostsByDay = new Map()
    if (ghostTotal) {
      const ordered = pool.inner.slice().sort((a, b) => dist2(a, CENTER) - dist2(b, CENTER))
      ghostDays.sort((a, b) => a.day.localeCompare(b.day) || String(a.engine).localeCompare(String(b.engine)))
      let cum = 0
      for (const d of ghostDays) {
        const q = (cum + d.count / 2) / ghostTotal
        cum += d.count
        const seed = ordered[Math.min(ordered.length - 1, Math.floor(q * (ordered.length - 1)))]
        const spots = innerGrid.claim(seed, d.count, () => true)
        const dayStart = new Date(d.day + 'T00:00:00').getTime()
        const agent = agentOf(d.engine)
        const rgb = mix(agent.rgb, [0.55, 0.6, 0.7], 0.45)
        const list = []
        for (let i = 0; i < d.count; i++) {
          const p = spots[i] || { x: seed.x + (R() - 0.5) * 0.08, y: seed.y + (R() - 0.5) * 0.08, z: seed.z + (R() - 0.5) * 0.08 }
          const hour = 8 + 16 * Math.pow(R(), 0.8)
          const node = add({
            k: GHOST, x: p.x, y: p.y, z: p.z, rgb, glow: 0.55, size: 0.0052,
            birth: dayStart + hour * HOUR, region: p.region ?? -1, agent, day: d.day,
          })
          list.push(node)
        }
        const key = `${d.day} ${d.engine}`
        ghostsByDay.set(key, (ghostsByDay.get(key) || []).concat(list))
      }
    }

    // About You: hubs along the bridge between the hemispheres.
    const about = snapshot.about || {}
    const lines = (about.lines || []).filter((l) => l && l.text)
    const aboutBirth = about.gen || about.modified || now
    const hubs = []
    lines.forEach((line, i) => {
      const u = (i + 0.5) / Math.max(1, lines.length)
      const z = 0.46 - 1.0 * u
      const y = 0.1 + 0.13 * Math.sin(Math.PI * clamp(u * 1.05, 0, 1))
      const node = add({ k: HUB, x: (i % 2 ? 1 : -1) * 0.012, y, z, rgb: GOLD, glow: 1.6, size: 0.026, birth: aboutBirth, region: -1, line, lower: line.text.toLowerCase() })
      const askRef = (line.refs || []).map((r) => /^asks:(\d+)$/.exec(r)).find(Boolean)
      node.askCount = askRef ? Number(askRef[1]) : 0
      node.cites = MemoryData.refs(line, snapshot).map((m) => memoryNodes.get(m.id)).filter(Boolean)
      hubs.push(node)
    })

    // ── connections ──
    const lineVerts = []
    const link = (a, b, w) => { a.edges.push([b.index, w]); b.edges.push([a.index, w]) }
    function straight(a, b, alpha, kind) { lineVerts.push({ a, b, t0: 0, t1: 1, p: a, q: b, ca: a.rgb, cb: b.rgb, alpha, kind }) }
    function fiber(a, b, alpha, kind, bulge = 0.16) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2
      let dx = mx - CENTER.x, dy = my - CENTER.y + 0.25, dz = mz - CENTER.z
      const dl = Math.hypot(dx, dy, dz) || 1
      const len = Math.sqrt(dist2(a, b))
      const c = { x: mx + (dx / dl) * bulge * len, y: my + (dy / dl) * bulge * len, z: mz + (dz / dl) * bulge * len }
      const curve = { a, b, c }
      const N = 14
      let prev = a
      for (let i = 1; i <= N; i++) {
        const t = i / N
        const p = bez(a, c, b, t)
        lineVerts.push({ a, b, t0: (i - 1) / N, t1: t, p: prev, q: p, ca: mix(a.rgb, b.rgb, (i - 1) / N), cb: mix(a.rgb, b.rgb, t), alpha, kind })
        prev = p
      }
      return curve
    }
    // conversation chains
    for (const s of bySession.values()) for (let i = 1; i < s.nodes.length; i++) { link(s.nodes[i - 1], s.nodes[i], 0.55); straight(s.nodes[i - 1], s.nodes[i], 0.05, 'chain') }

    // memories ↔ messages that share their rarer words
    const neurons = nodes.filter((n) => n.k === NEURON)
    const postings = new Map()
    neurons.forEach((n) => { for (const w of new Set(words(n.ask.text))) { if (w.length < 4 || STOP.has(w)) continue; let l = postings.get(w); if (!l) postings.set(w, (l = [])); l.push(n) } })
    const engrams = nodes.filter((n) => n.k === ENGRAM)
    for (const e of engrams) {
      const tokens = [...new Set(words(e.memory.title + ' ' + e.memory.description))].filter((w) => w.length >= 4 && !STOP.has(w))
      const score = new Map()
      for (const t of tokens) {
        const l = postings.get(t)
        if (!l || l.length > Math.max(12, neurons.length * 0.06)) continue
        const idf = Math.log(1 + neurons.length / l.length)
        for (const n of l) score.set(n, (score.get(n) || 0) + idf + (n.region === e.region ? 0.6 : 0))
      }
      const top = [...score].filter(([, s]) => s > 2.2).sort((a, b) => b[1] - a[1]).slice(0, 6)
      e.related = top.map(([n]) => n)
      for (const n of e.related) { link(e, n, 0.65); straight(e, n, 0.022, 'assoc'); (n.memories ||= []).push(e) }
    }
    // memories ↔ their nearest neighbours in the same region
    for (const region of regions) {
      const es = region.nodes.filter((n) => n.k === ENGRAM)
      for (const e of es) {
        const near = es.filter((o) => o !== e).sort((a, b) => dist2(a, e) - dist2(b, e)).slice(0, 2)
        for (const o of near) if (!e.edges.some(([j]) => j === o.index)) { link(e, o, 0.35); straight(e, o, 0.05, 'mesh') }
      }
    }
    // global memories along the hippocampus
    const globals = engrams.filter((e) => e.region < 0).sort((a, b) => a.z - b.z)
    for (let i = 1; i < globals.length; i++) if (Math.sign(globals[i].x) === Math.sign(globals[i - 1].x)) { link(globals[i], globals[i - 1], 0.3); straight(globals[i], globals[i - 1], 0.06, 'mesh') }

    // About You axons: to the memories each line cites, and to the regions those memories hold
    const fibers = []
    const anchorOf = (region) => {
      if (region.anchor !== undefined) return region.anchor
      let best = null, bd = Infinity
      for (const n of region.nodes) if (n.k === NEURON) { const d = dist2(n, region.centroid); if (d < bd) { bd = d; best = n } }
      region.anchor = best || region.nodes[0] || null
      return region.anchor
    }
    const biggest = regions.filter((r) => r.nodes.some((n) => n.k === NEURON)).sort((a, b) => b.neuronCount - a.neuronCount)
    for (const h of hubs) {
      for (const e of h.cites) { link(h, e, 0.85); fibers.push(fiber(h, e, 0.13, 'axon')) }
      const touched = new Set(h.cites.filter((e) => e.region >= 0).map((e) => e.region))
      for (const id of touched) { const a = anchorOf(regions[id]); if (a) { link(h, a, 0.35); fibers.push(fiber(h, a, 0.09, 'axon', 0.25)) } }
      if (h.askCount && biggest.length) {
        const fan = clamp(Math.round(Math.log10(1 + h.askCount) * 1.6), 1, 5)
        const r = rng(hash(h.line.text))
        for (let i = 0; i < fan; i++) {
          const region = biggest[Math.min(biggest.length - 1, Math.floor(Math.pow(r(), 2) * biggest.length))]
          const cands = region.nodes.filter((n) => n.k === NEURON)
          const n = cands[Math.floor(r() * cands.length)]
          if (n) { link(h, n, 0.3); fibers.push(fiber(h, n, 0.07, 'axon', 0.3)) }
        }
      }
      if (!h.cites.length && !h.askCount && biggest.length) { const a = anchorOf(biggest[0]); if (a) { link(h, a, 0.3); fibers.push(fiber(h, a, 0.07, 'axon', 0.25)) } }
    }
    for (let i = 1; i < hubs.length; i++) if (hubs[i].line.section === hubs[i - 1].line.section) { link(hubs[i], hubs[i - 1], 0.3); straight(hubs[i], hubs[i - 1], 0.22, 'spine') }
    // reverse citations, for the dive
    for (const h of hubs) for (const e of h.cites) (e.heldBy ||= []).push(h)

    // ── scaffold: the faint tissue that gives the brain its shape ──
    const scaffold = []
    for (const p of pool.shell) if (!p.used) { const r = regions[p.region]; scaffold.push({ x: p.x, y: p.y, z: p.z, rgb: r ? r.color : [0.5, 0.6, 0.8], glow: (0.3 + 0.75 * (p.e - 0.8) * 5) * (0.06 + 0.94 * Math.pow(p.fold ?? 1, 1.6)) * (p.part === 1 ? 1.4 : 1), size: 0.0048 }) }
    for (const p of pool.inner) if (!p.used) { const r = regions[p.region]; scaffold.push({ x: p.x, y: p.y, z: p.z, rgb: mix(r ? r.color : [0.5, 0.6, 0.8], [0.45, 0.5, 0.65], 0.5), glow: 0.16, size: 0.0042 }) }
    for (const p of pool.stem) scaffold.push({ x: p.x, y: p.y, z: p.z, rgb: [0.5, 0.56, 0.72], glow: 0.3 + 0.25 * p.e, size: 0.0044 })
    const hr = rng(77)
    for (let i = 0; i < 520; i++) {
      const side = i % 2 ? 1 : -1
      const p = hippocampus(side, hr())
      scaffold.push({ x: p.x + (hr() - 0.5) * 0.05, y: p.y + (hr() - 0.5) * 0.04, z: p.z + (hr() - 0.5) * 0.04, rgb: [0.72, 0.62, 0.95], glow: 0.55, size: 0.0048 })
    }
    for (let i = 0; i < 260; i++) {
      const u = hr()
      scaffold.push({ x: (hr() - 0.5) * 0.05, y: 0.1 + 0.13 * Math.sin(Math.PI * clamp(u * 1.05, 0, 1)) - 0.03 + hr() * 0.02, z: 0.46 - u, rgb: [0.9, 0.78, 0.55], glow: 0.45, size: 0.0046 })
    }

    // timeline bounds
    const births = nodes.map((n) => n.birth).filter(Number.isFinite)
    const tMin = births.length ? Math.min(...births) - 6 * HOUR : now - DAY
    const tMax = Math.max(now, births.length ? Math.max(...births) : now) + 60_000

    return {
      now, snapshot, real: data.real, regions, nodes, scaffold, lineVerts, fibers, hubs, engrams, neurons, bySession,
      neuronByTurn, ghostsByDay, tMin, tMax, aboutBirth, asksCount: asks.length, ghostTotal,
      totals: { messages: snapshot.sessions?.asks || asks.length, loaded: asks.length, memories: memories.length, lines: lines.length, regions: regions.length, sessions: sessions.size },
      inferred: [...sessions.values()].filter((s) => s.inferred).length,
    }
  }

  function bez(a, c, b, t) {
    const u = 1 - t
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y, z: u * u * a.z + 2 * u * t * c.z + t * t * b.z }
  }

  // ── matrices ─────────────────────────────────────────────────────────────────────────────────────

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0])
  }
  function lookAt(e, t) {
    let zx = e.x - t.x, zy = e.y - t.y, zz = e.z - t.z
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l
    let xx = zz, xy = 0, xz = -zx // up (0,1,0) × z
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e.x + xy * e.y + xz * e.z), -(yx * e.x + yy * e.y + yz * e.z), -(zx * e.x + zy * e.y + zz * e.z), 1])
  }

  // ── renderers ────────────────────────────────────────────────────────────────────────────────────

  function glRenderer(canvas) {
    let gl = null
    try { gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' }) } catch { gl = null }
    if (!gl) return null
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s }
    const program = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p }
    const points = program(`
      attribute vec3 aPos; attribute vec3 aStart; attribute vec3 aColor; attribute float aSize; attribute float aDelay; attribute vec2 aDyn;
      uniform mat4 uView; uniform mat4 uProj; uniform float uPx; uniform float uMaxPx; uniform float uArrive; uniform float uMul;
      varying vec3 vColor; varying float vAlpha; varying float vPx;
      void main() {
        float k = clamp((uArrive - aDelay) / 1.9, 0.0, 1.0);
        float e = 1.0 - pow(1.0 - k, 3.0);
        vec3 p = mix(aStart, aPos, e);
        vec4 v = uView * vec4(p, 1.0);
        float depth = -v.z;
        gl_Position = uProj * v;
        float px = aSize * aDyn.y * uPx / max(depth, 0.001);
        float a = aDyn.x * uMul * smoothstep(0.012, 0.14, depth) * (1.0 - 0.8 * smoothstep(5.0, 18.0, depth));
        a *= mix(2.2, 1.0, k) + 1.4 * k * (1.0 - k); // brighter in flight: a field of stars falling into place
        if (px < 1.6) { a *= px * px / 2.56; px = 1.6; }
        gl_PointSize = min(px, uMaxPx);
        vColor = aColor; vAlpha = a; vPx = px;
        if (a < 0.0015 || depth < 0.004) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`, `
      precision mediump float; varying vec3 vColor; varying float vAlpha; varying float vPx;
      void main() {
        vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d); if (r2 > 1.0) discard;
        // tiny points are soft discs; larger ones get a hot core and a halo
        float big = smoothstep(3.0, 14.0, vPx);
        float core = exp(-r2 * mix(1.4, 9.0, big));
        float halo = 0.34 * exp(-r2 * 2.6) * (1.0 - r2) * big;
        float a = (core + halo) * vAlpha;
        vec3 c = mix(vColor, vec3(1.0), clamp(core * vAlpha - 0.9, 0.0, 0.6));
        gl_FragColor = vec4(c * a, 1.0);
      }`)
    const lines = program(`
      attribute vec3 aPos; attribute vec3 aColor; attribute float aAlpha;
      uniform mat4 uView; uniform mat4 uProj; uniform float uMul;
      varying vec3 vColor; varying float vA;
      void main() { vec4 v = uView * vec4(aPos, 1.0); gl_Position = uProj * v; float depth = -v.z;
        vA = aAlpha * uMul * smoothstep(0.02, 0.2, depth) * (1.0 - 0.7 * smoothstep(5.0, 18.0, depth)); vColor = aColor; }`, `
      precision mediump float; varying vec3 vColor; varying float vA;
      void main() { gl_FragColor = vec4(vColor * vA, 1.0); }`)
    const loc = (p, names) => Object.fromEntries(names.map((n) => [n, n[0] === 'a' ? gl.getAttribLocation(p, n) : gl.getUniformLocation(p, n)]))
    const P = loc(points, ['aPos', 'aStart', 'aColor', 'aSize', 'aDelay', 'aDyn', 'uView', 'uProj', 'uPx', 'uMaxPx', 'uArrive', 'uMul'])
    const L = loc(lines, ['aPos', 'aColor', 'aAlpha', 'uView', 'uProj', 'uMul'])
    const maxPx = Math.min(256, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64)
    const buf = (data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW); return b }
    const bind = (l, b, size) => { if (l < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0) }
    const sets = {}
    let lineSet = null
    return {
      kind: 'webgl',
      maxPx,
      points(name, a) {
        sets[name] = { count: a.count, pos: buf(a.pos, a.dynamicPos ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW), start: a.start === a.pos ? null : buf(a.start), color: buf(a.color, a.dynamicPos ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW), size: buf(a.size, a.dynamicPos ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW), delay: buf(a.delay), dyn: buf(a.dyn, gl.DYNAMIC_DRAW) }
      },
      update(name, field, data, count) {
        const s = sets[name]; if (!s) return
        gl.bindBuffer(gl.ARRAY_BUFFER, s[field]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
        if (count != null) s.count = count
      },
      lines(a) { lineSet = { count: a.count, pos: buf(a.pos), color: buf(a.color), alpha: buf(a.alpha, gl.DYNAMIC_DRAW) } },
      updateLines(alpha) { if (!lineSet) return; gl.bindBuffer(gl.ARRAY_BUFFER, lineSet.alpha); gl.bufferSubData(gl.ARRAY_BUFFER, 0, alpha) },
      resize(w, h) { gl.viewport(0, 0, w, h) },
      draw(f) {
        gl.clearColor(BG[0], BG[1], BG[2], 1); gl.clear(gl.COLOR_BUFFER_BIT)
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST)
        if (lineSet && f.lineMul > 0.001) {
          gl.useProgram(lines)
          gl.uniformMatrix4fv(L.uView, false, f.view); gl.uniformMatrix4fv(L.uProj, false, f.proj); gl.uniform1f(L.uMul, f.lineMul)
          for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i)
          bind(L.aPos, lineSet.pos, 3); bind(L.aColor, lineSet.color, 3); bind(L.aAlpha, lineSet.alpha, 1)
          gl.drawArrays(gl.LINES, 0, lineSet.count)
        }
        gl.useProgram(points)
        gl.uniformMatrix4fv(P.uView, false, f.view); gl.uniformMatrix4fv(P.uProj, false, f.proj)
        gl.uniform1f(P.uPx, f.px); gl.uniform1f(P.uMaxPx, maxPx); gl.uniform1f(P.uArrive, f.arrive)
        for (const name of ['scaffold', 'nodes', 'pulses']) {
          const s = sets[name]; if (!s || !s.count) continue
          for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i)
          gl.uniform1f(P.uMul, f.mul[name] ?? 1)
          bind(P.aPos, s.pos, 3); bind(P.aStart, s.start || s.pos, 3); bind(P.aColor, s.color, 3); bind(P.aSize, s.size, 1); bind(P.aDelay, s.delay, 1); bind(P.aDyn, s.dyn, 2)
          gl.drawArrays(gl.POINTS, 0, s.count)
        }
      },
    }
  }

  /** Without WebGL: the same scene through canvas 2D, lighter on the tissue. */
  function canvasRenderer(canvas) {
    const ctx = canvas.getContext('2d')
    const sprites = new Map()
    const sprite = (rgb) => {
      const key = rgb.map((c) => Math.round(c * 15)).join(',')
      if (sprites.has(key)) return sprites.get(key)
      const s = document.createElement('canvas'); s.width = s.height = 32
      const g = s.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16)
      gr.addColorStop(0, css(mix(rgb, WHITE, 0.3), 1)); gr.addColorStop(0.25, css(rgb, 0.55)); gr.addColorStop(1, css(rgb, 0))
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32); sprites.set(key, s); return s
    }
    const sets = {}
    let lineSet = null
    let W = 1, H = 1
    return {
      kind: 'canvas',
      maxPx: 96,
      points(name, a) { sets[name] = { ...a } },
      update(name, field, data, count) { const s = sets[name]; if (!s) return; s[field] = data; if (count != null) s.count = count },
      lines(a) { lineSet = a },
      updateLines(alpha) { if (lineSet) lineSet.alpha = alpha },
      resize(w, h) { W = w; H = h },
      draw(f) {
        const v = f.view, pr = f.proj
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = css(BG); ctx.fillRect(0, 0, W, H)
        ctx.globalCompositeOperation = 'lighter'
        const proj = (x, y, z) => {
          const vx = v[0] * x + v[4] * y + v[8] * z + v[12], vy = v[1] * x + v[5] * y + v[9] * z + v[13], vz = v[2] * x + v[6] * y + v[10] * z + v[14]
          if (vz > -0.01) return null
          return [(pr[0] * vx / -vz + 1) * 0.5 * W, (1 - pr[5] * vy / -vz) * 0.5 * H, -vz]
        }
        if (lineSet && f.lineMul > 0.001) {
          ctx.lineWidth = 1
          for (let i = 0; i < lineSet.count; i += 2) {
            const a = lineSet.alpha[i] * f.lineMul; if (a < 0.03) continue
            const p = proj(lineSet.pos[i * 3], lineSet.pos[i * 3 + 1], lineSet.pos[i * 3 + 2]); const q = proj(lineSet.pos[i * 3 + 3], lineSet.pos[i * 3 + 4], lineSet.pos[i * 3 + 5])
            if (!p || !q) continue
            ctx.strokeStyle = css([lineSet.color[i * 3], lineSet.color[i * 3 + 1], lineSet.color[i * 3 + 2]], Math.min(1, a))
            ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke()
          }
        }
        for (const name of ['scaffold', 'nodes', 'pulses']) {
          const s = sets[name]; if (!s || !s.count) continue
          const mul = f.mul[name] ?? 1
          const step = name === 'scaffold' ? 3 : 1
          for (let i = 0; i < s.count; i += step) {
            let k = clamp((f.arrive - s.delay[i]) / 1.9, 0, 1); const e = 1 - Math.pow(1 - k, 3)
            const st = s.start || s.pos
            const x = lerp(st[i * 3], s.pos[i * 3], e), y = lerp(st[i * 3 + 1], s.pos[i * 3 + 1], e), z = lerp(st[i * 3 + 2], s.pos[i * 3 + 2], e)
            const p = proj(x, y, z); if (!p) continue
            let a = s.dyn[i * 2] * mul * (lerp(2.2, 1, k) + 1.4 * k * (1 - k)) * smooth(0.012, 0.14, p[2]) * step
            let px = s.size[i] * s.dyn[i * 2 + 1] * f.px / p[2] * 2.2
            if (px < 1.6) { a *= px * px / 2.56; px = 1.6 }
            if (a < 0.01) continue
            px = Math.min(px, 96)
            ctx.globalAlpha = Math.min(1, a)
            ctx.drawImage(sprite([s.color[i * 3], s.color[i * 3 + 1], s.color[i * 3 + 2]]), p[0] - px / 2, p[1] - px / 2, px, px)
          }
        }
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      },
    }
  }

  // ── the page ─────────────────────────────────────────────────────────────────────────────────────

  const glCanvas = $('gl'), ink = $('ink'), inkCtx = ink.getContext('2d'), strip = $('strip'), stripCtx = strip.getContext('2d')
  let renderer = null
  try { renderer = glRenderer(glCanvas) } catch (error) { console.warn('WebGL unavailable, drawing with canvas 2D:', error.message); renderer = null }
  if (!renderer) {
    const fresh = glCanvas.cloneNode(false); glCanvas.replaceWith(fresh)
    renderer = canvasRenderer(fresh)
  }
  const surface = document.getElementById('gl')

  let M = null // the model
  let W = 1, H = 1, dpr = 1
  const FOV = 50 * Math.PI / 180
  const HOME = { tx: 0, ty: -0.12, tz: -0.04, yaw: -1.12, pitch: 0.28, dist: 2.85 }
  const cam = { ...HOME }
  const want = { ...HOME }
  let camRate = 3
  let view = new Float32Array(16), proj = new Float32Array(16), pxScale = 1
  let eye = { x: 0, y: 0, z: 3 }

  // dynamic state
  let dyn = null, spikeAt = null, spikeAmp = null, bornAt = null, recallLevel = null, recallStart = null
  let lineAlpha = null, lineBase = null, lineA = null, lineB = null, lineT = null
  let order = null, birthsSorted = null
  const MAXPULSE = 900
  const pulseTrail = 3
  let pulsePos, pulseCol, pulseSize, pulseDyn, pulseDelay
  const pulses = []

  const state = {
    mode: 'loading', // loading | arrival | explore | dive
    arrivalStart: 0, arrivalDur: reduceMotion ? 1.0 : 4.8,
    lastInput: performance.now(), mouse: { x: 0, y: 0, at: -1e9, down: false, dragged: false, lx: 0, ly: 0 },
    keys: new Set(),
    aim: -1, aimSince: 0,
  }
  const recall = { q: '', terms: [], items: [], focus: 0, seq: 0, active: false, fade: 0, camAt: 0, camDone: true, before: null, region: -1, hits: new Map() }
  const time = { on: false, u: 1, want: 1, playing: false, rewinding: false, T: Infinity, lastT: Infinity, rate: 0, endHold: 0, table: null }
  const dive = { stack: [], rows: [], sel: -1, before: null, showAt: 0, node: -1, rgb: WHITE }
  const ambient = { window: 14 * DAY, loop: 46, clock: 0, last: 0, label: '' }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    W = Math.max(1, Math.round(innerWidth * dpr)); H = Math.max(1, Math.round(innerHeight * dpr))
    surface.width = W; surface.height = H
    ink.width = W; ink.height = H
    strip.width = Math.round(strip.clientWidth * dpr) || 1; strip.height = Math.round(strip.clientHeight * dpr) || 1
    renderer.resize(W, H)
  }
  addEventListener('resize', resize)

  // ── building the GPU side ──

  function upload() {
    const S = M.scaffold, N = M.nodes
    const r = rng(99)
    const far = () => { const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = 3.5 + 9 * Math.pow(r(), 0.7), s = Math.sqrt(1 - u * u); return [Math.cos(th) * s * rad, u * rad * 0.7, Math.sin(th) * s * rad] }
    {
      const pos = new Float32Array(S.length * 3), start = new Float32Array(S.length * 3), color = new Float32Array(S.length * 3), size = new Float32Array(S.length), delay = new Float32Array(S.length), d = new Float32Array(S.length * 2)
      S.forEach((p, i) => {
        pos.set([p.x, p.y, p.z], i * 3); start.set(reduceMotion ? [p.x, p.y, p.z] : far(), i * 3); color.set(p.rgb, i * 3); size[i] = p.size
        delay[i] = reduceMotion ? 0 : 0.5 + 2.2 * r() * (0.6 + 0.4 * (1 - Math.min(1, Math.hypot(p.x, p.y, p.z))))
        d[i * 2] = p.glow; d[i * 2 + 1] = 1
      })
      renderer.points('scaffold', { count: S.length, pos, start, color, size, delay, dyn: d })
    }
    {
      const pos = new Float32Array(N.length * 3), start = new Float32Array(N.length * 3), color = new Float32Array(N.length * 3), size = new Float32Array(N.length), delay = new Float32Array(N.length)
      dyn = new Float32Array(N.length * 2)
      N.forEach((n, i) => {
        pos.set([n.x, n.y, n.z], i * 3); start.set(reduceMotion ? [n.x, n.y, n.z] : far(), i * 3); color.set(n.rgb, i * 3); size[i] = n.size
        const base = n.k === HUB ? 0.2 : n.k === ENGRAM ? 0.7 : n.k === GHOST ? 1.0 : 1.2
        delay[i] = reduceMotion ? 0 : base + (n.k === HUB ? 0.25 * r() : n.k === ENGRAM ? 0.6 * r() : 1.5 * r())
        dyn[i * 2] = n.glow; dyn[i * 2 + 1] = 1
      })
      renderer.points('nodes', { count: N.length, pos, start, color, size, delay, dyn })
    }
    {
      const cap = MAXPULSE * pulseTrail
      pulsePos = new Float32Array(cap * 3); pulseCol = new Float32Array(cap * 3); pulseSize = new Float32Array(cap); pulseDyn = new Float32Array(cap * 2); pulseDelay = new Float32Array(cap).fill(-100)
      renderer.points('pulses', { count: 0, pos: pulsePos, start: pulsePos, color: pulseCol, size: pulseSize, delay: pulseDelay, dyn: pulseDyn, dynamicPos: true })
    }
    {
      const V = M.lineVerts.length * 2
      const pos = new Float32Array(V * 3), color = new Float32Array(V * 3)
      lineAlpha = new Float32Array(V); lineBase = new Float32Array(V); lineA = new Int32Array(V); lineB = new Int32Array(V); lineT = new Float32Array(V)
      M.lineVerts.forEach((s, i) => {
        const j = i * 2
        pos.set([s.p.x, s.p.y, s.p.z, s.q.x, s.q.y, s.q.z], j * 3)
        color.set([...s.ca, ...s.cb], j * 3)
        lineBase[j] = lineBase[j + 1] = s.alpha
        lineA[j] = lineA[j + 1] = s.a.index; lineB[j] = lineB[j + 1] = s.b.index
        lineT[j] = s.t0; lineT[j + 1] = s.t1
      })
      renderer.lines({ count: V, pos, color, alpha: lineAlpha })
    }
    spikeAt = new Float64Array(N.length).fill(-1e9)
    spikeAmp = new Float32Array(N.length)
    bornAt = new Float64Array(N.length).fill(-1e9)
    recallLevel = new Float32Array(N.length)
    recallStart = new Float64Array(N.length).fill(1e15)
    order = N.map((n) => n.index).sort((a, b) => N[a].birth - N[b].birth)
    birthsSorted = new Float64Array(order.map((i) => N[i].birth))
    buildTimeTable()
  }

  // ── time ──

  function buildTimeTable() {
    const n = 1024, table = new Float64Array(n + 1)
    const span = M.tMax - M.tMin
    // progress u over the timeline: three parts births (busy weeks pass slowly), one part calendar
    const F = (t) => 0.72 * (upperBound(birthsSorted, t) / Math.max(1, birthsSorted.length)) + 0.28 * (t - M.tMin) / span
    const samples = 4096
    const ts = new Float64Array(samples + 1), fs = new Float64Array(samples + 1)
    for (let i = 0; i <= samples; i++) { ts[i] = M.tMin + span * i / samples; fs[i] = F(ts[i]) }
    let j = 0
    for (let i = 0; i <= n; i++) {
      const u = i / n * fs[samples]
      while (j < samples && fs[j + 1] < u) j++
      const f0 = fs[j], f1 = fs[Math.min(samples, j + 1)]
      table[i] = ts[j] + (f1 > f0 ? (u - f0) / (f1 - f0) : 0) * (span / samples)
    }
    time.table = table
    time.F = F
    time.Fmax = fs[samples] || 1
  }
  const tToU = (t) => clamp(time.F(t) / time.Fmax, 0, 1)
  const uToT = (u) => { const t = time.table, x = clamp(u, 0, 1) * (t.length - 1), i = Math.floor(x); return i >= t.length - 1 ? t[t.length - 1] : lerp(t[i], t[i + 1], x - i) }
  function upperBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m } return lo }

  function startTime(u) {
    if (!time.on) {
      time.on = true; time.u = 1; time.lastT = M.tMax; time.T = M.tMax
      clearRecall(true)
    }
    time.want = clamp(u, 0, 1)
  }
  function stopTime() {
    time.on = false; time.playing = false; time.rewinding = false; time.u = time.want = 1; time.T = Infinity
    bornAt.fill(-1e9)
  }
  function stepTime(now, dt) {
    if (!time.on) return
    if (time.rewinding) {
      time.want = 0
      time.u = Math.max(0, time.u - dt / 1.5 * Math.max(0.3, time.u))
      if (time.u <= 0.002) { time.u = 0; time.rewinding = false; time.playing = true; time.want = 0 }
    } else if (time.playing) {
      time.want = Math.min(1, time.want + dt / 19)
      time.u = time.want
      if (time.u >= 1) { time.playing = false; time.endHold = now + 2400 }
    } else {
      const k = 1 - Math.exp(-dt * 7)
      time.u += (time.want - time.u) * k
      if (Math.abs(time.want - time.u) < 1e-4) time.u = time.want
    }
    const T = uToT(time.u)
    const prev = time.lastT
    if (T !== prev) {
      const a = Math.min(T, prev), b = Math.max(T, prev)
      const lo = upperBound(birthsSorted, a), hi = upperBound(birthsSorted, b)
      for (let k = lo; k < hi; k++) bornAt[order[k]] = now
    }
    time.rate = Math.abs(T - prev) / Math.max(dt, 1e-3)
    time.lastT = time.T = T
    if (time.endHold && now > time.endHold && !time.playing && time.u >= 1) { time.endHold = 0; stopTime() }
  }

  // ── ambient life: the brain fires in the rhythm of your last two weeks ──

  function stepAmbient(now, dt) {
    if (!M || !M.nodes.length) return
    const end = M.now, start = end - ambient.window
    const rate = ambient.window / ambient.loop
    const prev = ambient.clock || start
    let clock = prev + dt * rate
    const fire = (a, b) => {
      const lo = upperBound(birthsSorted, a), hi = upperBound(birthsSorted, b)
      for (let k = lo; k < hi && k - lo < 400; k++) spike(order[k], now, 1)
    }
    if (clock > end) { fire(prev, end); clock = start + (clock - end); fire(start, clock) } else fire(prev, clock)
    ambient.clock = clock
    // a little background chatter everywhere
    const n = M.nodes.length
    for (let i = 0; i < (reduceMotion ? 1 : 4); i++) if (Math.random() < dt * 2) spike(Math.floor(Math.random() * n), now, 0.45, true)
    if (Math.random() < dt * 2.2 && M.fibers.length) {
      const f = M.fibers[Math.floor(Math.random() * M.fibers.length)]
      if (isVisible(f.a.index) && isVisible(f.b.index)) addPulse(f.a, f.b, f.c, now, 1400 + 600 * Math.random(), GOLD, f.b.index, 0.9)
    }
    if (now - ambient.last > 250) { ambient.last = now; ambient.label = `${dayLong(clock).replace(/ \d{4}$/, '')} · ${hm(clock)}` }
  }
  function spike(i, now, amp, quiet) {
    if (!isVisible(i)) return
    spikeAt[i] = now; spikeAmp[i] = amp * (reduceMotion ? 0.45 : 1)
    if (quiet) return
    const n = M.nodes[i]
    if (n.k === NEURON && Math.random() < 0.3) {
      const s = n.session
      const at = s ? s.nodes.indexOf(n) : -1
      const next = at >= 0 ? s.nodes[at + 1] : null
      if (next && isVisible(next.index)) addPulse(n, next, null, now, 500, n.rgb, next.index, 0.5)
      else if (n.memories && n.memories.length) { const e = n.memories[0]; addPulse(n, e, null, now, 900, n.rgb, e.index, 0.8) }
    }
  }
  const isVisible = (i) => !time.on || M.nodes[i].birth <= time.T

  function addPulse(a, b, c, now, dur, rgb, target, glow, delay = 0) {
    if (pulses.length >= MAXPULSE) pulses.shift()
    pulses.push({ a, b, c, t0: now + delay, dur, rgb, target, glow, done: false })
  }
  function stepPulses(now) {
    let count = 0
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]
      const t = (now - p.t0) / p.dur
      if (t >= 1) {
        if (!p.done && p.target >= 0) { p.done = true; if (spikeAmp[p.target] < 0.7 || now - spikeAt[p.target] > 300) { spikeAt[p.target] = now; spikeAmp[p.target] = 0.7 * (reduceMotion ? 0.45 : 1) } }
        pulses.splice(i, 1); continue
      }
    }
    for (const p of pulses) {
      const t = (now - p.t0) / p.dur
      if (t < 0) continue
      for (let k = 0; k < pulseTrail; k++) {
        const tt = clamp(easeInOut(t) - k * 0.035, 0, 1)
        const q = p.c ? bez(p.a, p.c, p.b, tt) : { x: lerp(p.a.x, p.b.x, tt), y: lerp(p.a.y, p.b.y, tt), z: lerp(p.a.z, p.b.z, tt) }
        pulsePos[count * 3] = q.x; pulsePos[count * 3 + 1] = q.y; pulsePos[count * 3 + 2] = q.z
        const c = mix(p.rgb, WHITE, 0.5 - k * 0.15)
        pulseCol[count * 3] = c[0]; pulseCol[count * 3 + 1] = c[1]; pulseCol[count * 3 + 2] = c[2]
        pulseSize[count] = 0.011 * (1 - k * 0.25)
        pulseDyn[count * 2] = p.glow * (1 - k * 0.32) * Math.sin(Math.PI * clamp(t * 1.15, 0, 1)) ; pulseDyn[count * 2 + 1] = 1
        count++
      }
    }
    renderer.update('pulses', 'pos', pulsePos, count)
    renderer.update('pulses', 'color', pulseCol)
    renderer.update('pulses', 'size', pulseSize)
    renderer.update('pulses', 'dyn', pulseDyn)
  }

  // ── per-frame glow ──

  function stepGlow(now) {
    const N = M.nodes
    const recalling = recall.fade > 0.001
    const dim = recalling ? lerp(1, 0.22, recall.fade) : 1
    for (let i = 0; i < N.length; i++) {
      const n = N[i]
      let g = 0, s = 1
      const born = !time.on || n.birth <= time.T
      if (born) {
        g = n.glow * dim
        const sp = spikeAmp[i] ? Math.exp(-(now - spikeAt[i]) / 380) * spikeAmp[i] : 0
        if (sp > 0.001) { g += sp * (n.k === NEURON ? 1.5 : n.k === GHOST ? 1.1 : 0.7) * (recalling ? 0.4 : 1); s += sp * 0.7 }
        if (time.on) { const b = Math.exp(-(now - bornAt[i]) / 650); if (b > 0.001) { g += b * (n.k === GHOST ? 1.6 : 2.6); s += b * 1.6 } }
        if (recalling && recallLevel[i] > 0) {
          const t = now - recallStart[i]
          if (t > 0) {
            const lv = recallLevel[i] * recall.fade
            const env = smooth(0, 120, t) * (0.75 + 1.8 * Math.exp(-t / 520))
            g += lv * env * (n.k === NEURON ? 1.8 : n.k === GHOST ? 2.4 : 1.6)
            s += lv * env * (n.k === GHOST ? 1.6 : 0.9)
          }
        }
        if (n.k === HUB) g *= 0.85 + 0.15 * Math.sin(now / 900 + i)
      } else if (time.on) {
        const b = Math.exp(-(now - bornAt[i]) / 260)
        if (b > 0.01) { g = b * 1.6; s = 1 + b }
      }
      dyn[i * 2] = g; dyn[i * 2 + 1] = s
    }
    renderer.update('nodes', 'dyn', dyn)

    // lines follow their ends; fibers grow out from the hub when it is born
    for (let j = 0; j < lineAlpha.length; j++) {
      const a = lineA[j], b = lineB[j]
      let alpha = lineBase[j]
      if (time.on) {
        const na = N[a], nb = N[b]
        if (na.birth > time.T || nb.birth > time.T) { lineAlpha[j] = 0; continue }
        const since = (now - Math.max(bornAt[a], bornAt[b])) / 1400
        if (since < 1.2) { const grow = clamp(since * 1.4 - lineT[j], 0, 1); alpha *= grow * (1 + 2 * Math.exp(-since * 2)) }
      }
      if (recalling) {
        const ra = recallLevel[a] > 0 && now > recallStart[a] ? recallLevel[a] : 0
        const rb = recallLevel[b] > 0 && now > recallStart[b] ? recallLevel[b] : 0
        alpha = alpha * dim + (Math.min(ra, rb) > 0.3 ? Math.min(ra, rb) * recall.fade * 0.32 : 0)
      }
      lineAlpha[j] = alpha
    }
    renderer.updateLines(lineAlpha)
  }

  // ── camera ──

  function updateCamera(dt) {
    const k = 1 - Math.exp(-dt * camRate)
    let dy = want.yaw - cam.yaw
    cam.yaw += dy * k; cam.pitch += (want.pitch - cam.pitch) * k
    cam.dist = Math.exp(lerp(Math.log(cam.dist), Math.log(want.dist), k))
    cam.tx += (want.tx - cam.tx) * k; cam.ty += (want.ty - cam.ty) * k; cam.tz += (want.tz - cam.tz) * k
    const cp = Math.cos(cam.pitch)
    eye = { x: cam.tx + cam.dist * cp * Math.sin(cam.yaw), y: cam.ty + cam.dist * Math.sin(cam.pitch), z: cam.tz + cam.dist * cp * Math.cos(cam.yaw) }
    view = lookAt(eye, { x: cam.tx, y: cam.ty, z: cam.tz })
    proj = perspective(FOV, W / H, 0.005, 60)
    pxScale = H / (2 * Math.tan(FOV / 2))
  }
  function project(x, y, z) {
    const v = view
    const vx = v[0] * x + v[4] * y + v[8] * z + v[12], vy = v[1] * x + v[5] * y + v[9] * z + v[13], vz = v[2] * x + v[6] * y + v[10] * z + v[14]
    if (vz > -0.02) return null
    return { x: (proj[0] * vx / -vz + 1) * 0.5 * W / dpr, y: (1 - proj[5] * vy / -vz) * 0.5 * H / dpr, depth: -vz }
  }
  function nearestYaw(target) { let y = target; while (y - cam.yaw > Math.PI) y -= 2 * Math.PI; while (y - cam.yaw < -Math.PI) y += 2 * Math.PI; return y }
  /** Look at a point from outside the brain, along the line from the centre through it. */
  function lookFromOutside(p, dist, instant) {
    let dx = p.x - CENTER.x, dy = p.y - CENTER.y, dz = p.z - CENTER.z
    const l = Math.hypot(dx, dy, dz)
    if (l < 0.12) { dx = Math.sin(cam.yaw); dz = Math.cos(cam.yaw); dy = 0.3 } else { dx /= l; dy /= l; dz /= l }
    want.yaw = nearestYaw(Math.atan2(dx, dz))
    want.pitch = clamp(Math.asin(clamp(dy, -1, 1)) * 0.85 + 0.12, -0.75, 1.1)
    want.dist = dist
    want.tx = p.x; want.ty = p.y; want.tz = p.z
    if (instant || reduceMotion) Object.assign(cam, want)
  }
  const saveCam = () => ({ ...want })

  function steer(dt) {
    const k = state.keys
    const fast = k.has('Shift') ? 3 : 1
    let moved = false
    if (state.mode !== 'explore') return
    const listMode = recall.active && recall.items.length
    if (k.has('ArrowLeft')) { want.yaw -= 1.25 * fast * dt; moved = true }
    if (k.has('ArrowRight')) { want.yaw += 1.25 * fast * dt; moved = true }
    if (k.has('PageUp') || (k.has('Alt') && k.has('ArrowUp'))) { want.pitch = clamp(want.pitch + 1 * fast * dt, -1.4, 1.4); moved = true }
    if (k.has('PageDown') || (k.has('Alt') && k.has('ArrowDown'))) { want.pitch = clamp(want.pitch - 1 * fast * dt, -1.4, 1.4); moved = true }
    if (!listMode && !k.has('Alt')) {
      if (k.has('ArrowUp')) { fly(1.1 * fast * dt); moved = true }
      if (k.has('ArrowDown')) { fly(-1.1 * fast * dt); moved = true }
    }
    if (moved) { state.lastInput = performance.now(); camRate = 6 }
    else if (!reduceMotion && performance.now() - state.lastInput > 7000 && !recall.active && !time.on) { want.yaw += 0.045 * dt; camRate = 3 }
    else if (time.playing && !reduceMotion) want.yaw += 0.12 * dt
  }
  function fly(amount) {
    // forward: close in on the target, then carry the target forward through the brain
    if (amount > 0 && want.dist > 0.32) want.dist = Math.max(0.32, want.dist * Math.exp(-amount * 0.9))
    else if (amount > 0) {
      const cp = Math.cos(want.pitch)
      const fx = -cp * Math.sin(want.yaw), fy = -Math.sin(want.pitch), fz = -cp * Math.cos(want.yaw)
      want.tx = clamp(want.tx + fx * amount * 0.6, -1.6, 1.6); want.ty = clamp(want.ty + fy * amount * 0.6, -1.6, 1.6); want.tz = clamp(want.tz + fz * amount * 0.6, -1.8, 1.8)
    } else {
      want.dist = Math.min(9, want.dist * Math.exp(-amount * 0.9))
      // drifting back out, the target eases home so the brain stays in view
      const pull = clamp(-amount * 0.4, 0, 0.2) * smooth(1.2, 3, want.dist)
      want.tx = lerp(want.tx, HOME.tx, pull); want.ty = lerp(want.ty, HOME.ty, pull); want.tz = lerp(want.tz, HOME.tz, pull)
    }
  }

  // ── recall: spreading activation ──

  function snippetSegments(text, terms, width) {
    const t = flat(text)
    const lower = t.toLowerCase()
    let first = -1
    for (const term of terms) { const i = lower.indexOf(term); if (i >= 0 && (first < 0 || i < first)) first = i }
    let start = 0
    if (first > width * 0.45) start = first - Math.floor(width * 0.3)
    let s = t.slice(start, start + width)
    const pre = start > 0 ? '…' : '', post = start + width < t.length ? '…' : ''
    s = pre + s + post
    return markTerms(s, terms)
  }
  function markTerms(s, terms) {
    const lower = s.toLowerCase()
    const marks = new Uint8Array(s.length)
    for (const term of terms) { let i = 0; while ((i = lower.indexOf(term, i)) >= 0) { marks.fill(1, i, i + term.length); i += term.length } }
    const segs = []
    let cur = '', hit = marks[0] === 1
    for (let i = 0; i < s.length; i++) {
      const h = marks[i] === 1
      if (h !== hit) { if (cur) segs.push({ t: cur, hit }); cur = ''; hit = h }
      cur += s[i]
    }
    if (cur) segs.push({ t: cur, hit })
    return segs
  }
  function snippetFromHit(snippet) {
    const segs = []
    const parts = String(snippet || '').split(/(\u0002[^\u0003]*\u0003)/)
    for (const part of parts) {
      if (!part) continue
      if (part[0] === '\u0002') segs.push({ t: part.slice(1, -1), hit: true })
      else segs.push({ t: part.replace(/[\u0002\u0003]/g, ''), hit: false })
    }
    for (const s of segs) s.t = s.t.replace(/\s+/g, ' ')
    return segs
  }

  function setQuery(q) {
    const was = recall.q
    recall.q = q
    $('q').textContent = q
    $('prompt').classList.toggle('on', q.length > 0)
    if (!q.trim()) { clearRecall(); return }
    if (!was.trim()) { recall.before = saveCam(); recall.hits = new Map() }
    if (time.on) stopTime()
    runRecall()
    const seq = ++recall.seq
    clearTimeout(recall.timer)
    recall.timer = setTimeout(() => {
      MemoryData.search(q).then((hits) => { if (seq === recall.seq) { recall.hits = new Map((hits || []).map((h, i) => [i, h])); runRecall(true) } }).catch(() => {})
    }, 140)
  }

  function clearRecall(keepCamera) {
    const had = recall.active
    recall.active = false; recall.items = []; recall.terms = []; recall.focus = 0; recall.region = -1
    if (recall.q) { recall.q = ''; $('q').textContent = '' }
    $('prompt').classList.remove('on')
    clearTimeout(recall.timer); recall.seq++
    if (had && recall.before && !keepCamera) { Object.assign(want, recall.before); camRate = 2.4 }
    recall.before = null
    $('count').textContent = ''
  }

  function runRecall(fromSearch) {
    const now = performance.now()
    const terms = [...new Set(words(recall.q))]
    recall.terms = terms
    const N = M.nodes
    const direct = new Map() // node index → score (0..1)
    const items = []
    if (terms.length) {
      // memories
      let maxE = 0
      const es = []
      for (const e of M.engrams) {
        let s = 0, all = true
        for (const t of terms) {
          const inT = e.hay.title.includes(t), inD = e.hay.desc.includes(t), inB = e.hay.body.includes(t)
          if (!inT && !inD && !inB) { all = false; break }
          s += inT ? 3 : inD ? 2 : 1
          if (inB) s += Math.min(5, e.hay.body.split(t).length - 1) * 0.15
        }
        if (all) { es.push([e, s]); maxE = Math.max(maxE, s) }
      }
      for (const [e, s] of es) { const a = 0.6 + 0.4 * s / maxE; direct.set(e.index, a); items.push({ i: e.index, rank: 2.4 + a }) }
      // About You
      for (const h of M.hubs) if (terms.every((t) => h.lower.includes(t))) { direct.set(h.index, 1); items.push({ i: h.index, rank: 3.5 }) }
      // messages (local)
      const ns = []
      for (const n of M.neurons) {
        let s = 0, all = true
        for (const t of terms) { const i = n.lower.indexOf(t); if (i < 0) { all = false; break } s += 1 + (n.lower.indexOf(t, i + t.length) >= 0 ? 0.3 : 0) }
        if (all) ns.push([n, s + 0.3 * (n.birth - M.tMin) / (M.tMax - M.tMin)])
      }
      ns.sort((a, b) => b[1] - a[1])
      const maxN = ns.length ? ns[0][1] : 1
      for (const [n, s] of ns.slice(0, 900)) { const a = 0.5 + 0.4 * s / maxN; direct.set(n.index, a) }
      // search hits: the session index's own ranking; those older than what is loaded come back as ghosts with words
      const seenHit = new Set()
      let rank = 0
      for (const n of recall.hitNodes || []) n.hitSnippet = null
      recall.hitNodes = []
      for (const h of recall.hits.values()) {
        if (!fromSearch) { const plain = String(h.snippet || '').toLowerCase(); if (!terms.every((t) => plain.includes(t))) continue }
        const key = `${h.sessionId}:${h.turn}`
        let n = M.neuronByTurn.get(key)
        if (!n && M.ghostsByDay.size) {
          const list = M.ghostsByDay.get(`${dayKey(h.at)} ${h.engine}`)
          if (list && list.length) { n = list[hash(key) % list.length]; n.hit = h; n.hitKey = key }
        }
        if (!n || seenHit.has(n.index)) continue
        seenHit.add(n.index)
        n.hitSnippet = h.snippet
        recall.hitNodes.push(n)
        direct.set(n.index, Math.max(direct.get(n.index) || 0, 0.95 - rank * 0.01))
        items.push({ i: n.index, rank: 1.9 - rank * 0.02, hit: h })
        rank++
      }
      for (const [n, s] of ns.slice(0, 60)) if (!seenHit.has(n.index)) items.push({ i: n.index, rank: 1 + 0.4 * s / maxN })
      // a region named by the query
      recall.region = -1
      const q = recall.q.trim().toLowerCase()
      if (q.length >= 3) for (const r of M.regions) if (r.label.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) { recall.region = r.id; break }
      if (recall.region >= 0) {
        for (const n of M.regions[recall.region].nodes) if (!direct.has(n.index)) direct.set(n.index, 0.32)
        // a place named: step through the memories that live there
        for (const n of M.regions[recall.region].nodes) if (n.k === ENGRAM) items.push({ i: n.index, rank: 2 + (n.birth - M.tMin) / (M.tMax - M.tMin) })
      }
    }

    // spread: light passes along connections, losing strength each hop
    const act = new Map()
    for (const [i, a] of direct) act.set(i, { a, d: 0, from: -1 })
    let frontier = [...direct.keys()].sort((x, y) => direct.get(y) - direct.get(x)).slice(0, 700)
    for (let hop = 1; hop <= 3 && frontier.length; hop++) {
      const next = []
      for (const i of frontier) {
        const src = act.get(i)
        for (const [j, w] of N[i].edges) {
          const a = src.a * w * 0.78
          if (a < 0.1) continue
          const d = src.d + 160 + 900 * Math.sqrt(dist2(N[i], N[j]))
          const cur = act.get(j)
          if (!cur || (cur.from >= 0 && cur.a < a)) { act.set(j, { a, d: Math.min(d, 1300), from: i }); if (!cur) next.push(j) }
        }
      }
      frontier = next.slice(0, 1500)
    }
    // apply, keeping what was already lit so typing another letter does not re-flash it
    const nextLevel = new Float32Array(N.length)
    let spreadPulses = 0
    for (const [i, v] of act) {
      nextLevel[i] = v.a
      if (recallLevel[i] <= 0 || recallStart[i] > 1e14) {
        recallStart[i] = now + v.d
        if (v.from >= 0 && spreadPulses < 260 && !reduceMotion) {
          const p = act.get(v.from)
          addPulse(N[v.from], N[i], null, now, Math.max(140, v.d - p.d), mix(N[i].rgb, WHITE, 0.3), -1, 1.1, p.d)
          spreadPulses++
        }
      }
    }
    for (let i = 0; i < N.length; i++) if (nextLevel[i] <= 0) recallStart[i] = 1e15
    recallLevel.set(nextLevel)

    items.sort((a, b) => b.rank - a.rank)
    const seen = new Set()
    recall.items = items.filter((it) => (seen.has(it.i) ? false : seen.add(it.i))).slice(0, 80)
    recall.active = true
    if (!fromSearch) recall.focus = 0
    recall.focus = clamp(recall.focus, 0, Math.max(0, recall.items.length - 1))
    recall.camAt = now + (fromSearch ? 60 : 260)
    recall.camDone = false
    recall.direct = direct
    const mem = recall.items.filter((it) => N[it.i].k === ENGRAM).length
    const hubs = recall.items.filter((it) => N[it.i].k === HUB).length
    const msgs = [...direct].filter(([i, a]) => (N[i].k === NEURON || N[i].k === GHOST) && a >= 0.5).length
    const bits = []
    if (msgs) bits.push(plural(msgs, 'message'))
    if (mem) bits.push(plural(mem, 'memory', 'memories'))
    if (hubs) bits.push(hubs + ' About You')
    if (recall.region >= 0) bits.push('the ' + M.regions[recall.region].label + ' region')
    $('count').textContent = terms.length ? (bits.length ? bits.join(' · ') : 'nothing comes back') : ''
  }

  function recallCamera(now) {
    if (!recall.active || recall.camDone || now < recall.camAt) return
    recall.camDone = true
    const N = M.nodes
    const cands = [...(recall.direct || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 320)
    if (!cands.length) return
    if (recall.region >= 0 && cands.every(([i]) => N[i].region === recall.region)) { const r = M.regions[recall.region]; lookFromOutside(r.centroid, 1.9); camRate = 2.2; return }
    // the densest knot of recalled memories
    let best = cands[0][0], bestD = -1
    const s2 = 2 * 0.2 * 0.2
    for (const [i, a] of cands) {
      let d = 0
      for (const [j, b] of cands) d += b * Math.exp(-dist2(N[i], N[j]) / s2) * (N[j].k === ENGRAM || N[j].k === HUB ? 2.5 : 1)
      d *= N[i].k === ENGRAM || N[i].k === HUB ? 1.3 : 1
      if (d > bestD) { bestD = d; best = i }
    }
    const focusNode = recall.items.length ? N[recall.items[0].i] : N[best]
    const p = N[best]
    const target = Math.sqrt(dist2(p, focusNode)) < 0.5 ? { x: (p.x * 2 + focusNode.x) / 3, y: (p.y * 2 + focusNode.y) / 3, z: (p.z * 2 + focusNode.z) / 3 } : p
    lookFromOutside(target, 1.5)
    camRate = 2.2
  }

  function focusItem(delta) {
    if (!recall.items.length) return
    recall.focus = (recall.focus + delta + recall.items.length) % recall.items.length
    const n = M.nodes[recall.items[recall.focus].i]
    lookFromOutside(n, n.k === HUB ? 1.4 : 1.15)
    camRate = 2.6
    recall.camDone = true
    state.lastInput = performance.now()
  }

  // ── dive ──

  function diveable(i) { const n = M.nodes[i]; return n && (n.k !== GHOST || !!n.hit) }

  function enterDive(i, fromRow) {
    if (i < 0 || !diveable(i)) return
    const n = M.nodes[i]
    if (state.mode !== 'dive') { dive.before = saveCam(); dive.stack = [] }
    if (fromRow && dive.node >= 0) dive.stack.push(dive.node)
    dive.node = i
    state.mode = 'dive'
    // fall into it: the camera closes until its light fills the view
    want.tx = n.x; want.ty = n.y; want.tz = n.z
    want.dist = 0.05
    camRate = reduceMotion ? 50 : 2.4
    if (reduceMotion) Object.assign(cam, want)
    dive.rgb = n.rgb
    dive.showAt = performance.now() + (reduceMotion ? 0 : fromRow ? 380 : 650)
    $('dive').classList.remove('on')
    buildDive(n)
    renderKeys()
  }
  function leaveDive() {
    if (dive.stack.length) { const prev = dive.stack.pop(); dive.node = -1; enterDive(prev, false); return }
    state.mode = 'explore'
    dive.node = -1
    $('dive').classList.remove('on')
    if (dive.before) Object.assign(want, dive.before)
    camRate = reduceMotion ? 50 : 2.2
    if (reduceMotion) Object.assign(cam, want)
    renderKeys()
  }

  function bodyInto(container, text) {
    const lines = String(text || '').split('\n')
    lines.forEach((line, i) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(line)
      if (m) container.appendChild(el('span', 'h', m[2]))
      else {
        const b = /^(\s*[-*]?\s*)\*\*([^*]+)\*\*(.*)$/.exec(line)
        if (b) { container.appendChild(document.createTextNode(b[1])); container.appendChild(el('span', 'em', b[2])); container.appendChild(document.createTextNode(b[3])) }
        else container.appendChild(document.createTextNode(line))
      }
      if (i < lines.length - 1) container.appendChild(document.createTextNode('\n'))
    })
  }

  function buildDive(n) {
    const col = document.querySelector('#dive .col')
    col.replaceChildren()
    const kicker = el('div', 'kicker')
    const dot = el('span', 'dot'); dot.style.color = css(n.k === HUB ? GOLD : n.agent ? n.agent.rgb : n.rgb)
    kicker.appendChild(dot)
    const rows = []
    const group = (title, list) => {
      if (!list.length) return
      const g = el('div', 'group'); g.appendChild(el('h2', null, title))
      for (const r of list) {
        const row = el('div', 'row' + (r.self ? ' self' : ''))
        const d = el('span', 'dot'); d.style.background = css(r.rgb); row.appendChild(d)
        row.appendChild(el('span', 'txt', r.label))
        if (r.when) row.appendChild(el('span', 'when', r.when))
        if (!r.self && r.node >= 0) { r.el = row; rows.push(r); row.addEventListener('click', () => { dive.sel = rows.indexOf(r); enterDive(r.node, true) }) }
        g.appendChild(row)
      }
      col.appendChild(g)
    }
    const now = M.now
    const regionName = (id) => (id >= 0 && M.regions[id] ? M.regions[id].label : null)
    const msgRow = (m, self) => ({ label: flat(m.ask ? m.ask.text : m.hit ? snippetFromHit(m.hit.snippet).map((s) => s.t).join('') : ''), when: `${dayShort(m.birth)} ${hm(m.birth)}`, rgb: m.rgb, node: m.index, self })
    const memRow = (e) => ({ label: flat(e.memory.title), when: `${e.agent.name} · ${regionName(e.region) || 'every project'}`, rgb: e.rgb, node: e.index })
    const hubRow = (h) => ({ label: flat(h.line.text), when: h.line.section || '', rgb: GOLD, node: h.index })

    if (n.k === ENGRAM) {
      const m = n.memory
      for (const t of ['memory', n.agent.name, regionName(n.region) || 'every project', ago(m.modified || now, now), m.type]) if (t) kicker.appendChild(el('span', null, t))
      col.appendChild(kicker)
      col.appendChild(el('h1', null, flat(m.title) || 'Untitled memory'))
      if (m.description && flat(m.description) !== flat(m.title) && flat(m.description).length > 12) col.appendChild(el('p', 'desc', flat(m.description)))
      const body = el('div', 'body'); bodyInto(body, m.body); col.appendChild(body)
      col.appendChild(el('div', 'meta', [m.path, m.size ? plural(m.size, 'byte') : ''].filter(Boolean).join(' · ')))
      group('Holds up About You', (n.heldBy || []).map(hubRow))
      group('Said near it', (n.related || []).slice(0, 6).map((x) => msgRow(x)))
      const near = M.engrams.filter((e) => e !== n && e.region === n.region).sort((a, b) => dist2(a, n) - dist2(b, n)).slice(0, 4)
      group('Nearby memories', near.map(memRow))
    } else if (n.k === HUB) {
      const l = n.line
      for (const t of ['About You', l.section]) if (t) kicker.appendChild(el('span', null, t))
      col.appendChild(kicker)
      col.appendChild(el('h1', null, flat(l.text)))
      const bits = []
      if (n.askCount) bits.push(`drawn from ${plural(n.askCount, 'of your messages', 'of your messages').replace(/^(\S+) of/, '$1 of')}`)
      if (n.cites.length) bits.push(`held up by ${plural(n.cites.length, 'memory', 'memories')}`)
      if (bits.length) col.appendChild(el('p', 'desc', bits.join(' · ').replace(/^./, (c) => c.toUpperCase())))
      group('Held up by', n.cites.map(memRow))
      group('Same section', M.hubs.filter((h) => h !== n && h.line.section === l.section).map(hubRow))
      const about = M.snapshot.about || {}
      if (about.intro) col.appendChild(el('div', 'meta', flat(about.intro)))
    } else {
      const text = n.ask ? n.ask.text : n.hit ? snippetFromHit(n.hit.snippet).map((s) => s.t).join('') : ''
      const when = `${dayLong(n.birth)} · ${hm(n.birth)}`
      for (const t of ['message', n.agent.name, when, n.ask ? `turn ${n.ask.turn + 1}` : 'older than this view']) kicker.appendChild(el('span', null, t))
      col.appendChild(kicker)
      const h = el('h1', flat(text).length > 90 ? 'long' : null, flat(text) || '(no words)')
      col.appendChild(h)
      const s = n.session
      const bits = []
      bits.push(s && s.title ? flat(s.title) : 'Untitled conversation')
      const rn = regionName(n.region)
      if (rn && n.k === NEURON) bits.push((s && s.inferred ? 'placed by its words in ' : 'in ') + rn)
      if (s) bits.push(`${plural(s.nodes.length, 'message')}, ${dayShort(s.start)}${dayKey(s.start) !== dayKey(s.end) ? ' – ' + dayShort(s.end) : ''}`)
      col.appendChild(el('p', 'desc', bits.join(' · ')))
      if (n.ask && n.ask.length > String(n.ask.text).length) col.appendChild(el('div', 'meta', `The first ${num(String(n.ask.text).length)} of ${num(n.ask.length)} characters.`))
      if (n.k === GHOST) col.appendChild(el('div', 'meta', 'Older than the messages loaded here: what the search found of it.'))
      if (s) {
        const at = s.nodes.indexOf(n)
        const around = s.nodes.slice(Math.max(0, at - 3), at + 4)
        group('The conversation', around.map((m) => msgRow(m, m === n)))
      }
      group('Memories it touches', (n.memories || []).map(memRow))
    }
    dive.rows = rows
    dive.sel = rows.length ? 0 : -1
    markSel()
    document.querySelector('#dive .scroll').scrollTop = 0
    $('veil').style.background = `radial-gradient(ellipse at 50% 45%, ${css(mix(n.rgb, BG, 0.35), 0.5)} 0%, ${css(mix(n.rgb, BG, 0.82), 0.92)} 45%, rgba(2,3,5,.97) 100%)`
  }
  function markSel() {
    dive.rows.forEach((r, i) => r.el.classList.toggle('sel', i === dive.sel))
    const r = dive.rows[dive.sel]
    if (r) r.el.scrollIntoView({ block: 'nearest' })
  }

  // ── the ink layer: labels and floating type ──

  let charW = {}
  function font(px, weight = 400) { inkCtx.font = `${weight} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`; if (!charW[px]) charW[px] = inkCtx.measureText('MMMMMMMMMM').width / 10; return charW[px] }

  function drawInk(now) {
    const c = inkCtx
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, W, H)
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!M || state.mode === 'loading') return
    const w = W / dpr, h = H / dpr
    const arriving = state.mode === 'arrival'
    const inDive = state.mode === 'dive'
    const k = arriving ? smooth(3.2, 4.6, (now - state.arrivalStart) / 1000) : inDive ? 0 : 1
    if (k <= 0.01) return

    // region labels: names on the lobes, quiet, like an anatomy plate
    const ex = eye.x - CENTER.x, ey = eye.y - CENTER.y, ez = eye.z - CENTER.z, el2 = Math.hypot(ex, ey, ez) || 1
    font(10)
    c.textBaseline = 'middle'
    c.textAlign = 'center'
    if ('letterSpacing' in c) c.letterSpacing = '2px'
    const placed = []
    for (const r of M.regions) {
      if (!r.slots.length) continue
      const p0 = r.centroid
      let dx = p0.x - CENTER.x, dy = p0.y - CENTER.y, dz = p0.z - CENTER.z
      const dl = Math.hypot(dx, dy, dz) || 1
      const facing = (dx * ex + dy * ey + dz * ez) / (dl * el2)
      const p = project(p0.x + dx / dl * 0.12, p0.y + dy / dl * 0.12, p0.z + dz / dl * 0.12)
      if (!p || p.depth < 0.4) continue
      let a = smooth(-0.25, 0.45, facing) * 0.62 * k * smooth(0.4, 1.4, p.depth)
      if (recall.active) a *= recall.region === r.id ? 1.6 : 0.35
      if (time.on) a *= 0.6
      if (a < 0.03) continue
      const name = short(r.label, 26).toUpperCase()
      const tw = name.length * (charW[10] + 2)
      if (placed.some((q) => Math.abs(q.x - p.x) < (q.w + tw) / 2 + 8 && Math.abs(q.y - p.y) < 22)) continue
      placed.push({ x: p.x, y: p.y, w: tw })
      c.fillStyle = css(mix(r.color, WHITE, 0.25), a)
      c.fillText(name, p.x, p.y)
      if (p.depth < 2.3 || recall.region === r.id) {
        font(9)
        c.fillStyle = css([0.6, 0.64, 0.7], a * 0.7 * smooth(2.3, 1.7, p.depth))
        const sub = [r.neuronCount ? plural(r.neuronCount, 'message') : '', r.memoryCount ? plural(r.memoryCount, 'memory', 'memories') : ''].filter(Boolean).join(' · ')
        c.fillText(sub, p.x, p.y + 13)
        font(10)
      }
    }
    if ('letterSpacing' in c) c.letterSpacing = '0px'
    c.textAlign = 'left'

    const boxes = []
    if (recall.active && recall.items.length) {
      const N = M.nodes
      const show = []
      const f = recall.items[recall.focus]
      if (f) show.push({ it: f, focus: true })
      for (const it of recall.items) {
        if (show.length >= 7) break
        if (it === f) continue
        show.push({ it, focus: false })
      }
      for (const s of show) {
        const n = N[s.it.i]
        if (now < recallStart[n.index]) continue
        const p = project(n.x, n.y, n.z)
        if (!p || p.x < -40 || p.x > w + 40 || p.y < -20 || p.y > h + 20) continue
        drawLabel(n, p, s.focus, boxes, now - recallStart[n.index], w, h)
      }
    } else if (state.mode === 'explore' && state.aim >= 0 && !time.playing) {
      const n = M.nodes[state.aim]
      const p = project(n.x, n.y, n.z)
      if (p) drawLabel(n, p, true, boxes, now - state.aimSince, w, h, true)
    } else if (state.mode === 'explore' && !recall.active && cam.dist <= 2.2 && now - state.mouse.at > 2500) {
      // close enough to aim: a quiet crosshair shows where Enter would dive
      c.strokeStyle = 'rgba(200,206,216,0.22)'
      c.beginPath(); c.moveTo(w / 2 - 7, h / 2); c.lineTo(w / 2 - 3, h / 2); c.moveTo(w / 2 + 3, h / 2); c.lineTo(w / 2 + 7, h / 2)
      c.moveTo(w / 2, h / 2 - 7); c.lineTo(w / 2, h / 2 - 3); c.moveTo(w / 2, h / 2 + 3); c.lineTo(w / 2, h / 2 + 7); c.stroke()
    }
  }

  function labelLines(n, terms) {
    const N = 64
    if (n.k === ENGRAM) {
      const m = n.memory
      const sub = [n.agent.name, n.region >= 0 ? short(M.regions[n.region].label, 22) : 'every project', ago(m.modified || M.now, M.now)].join(' · ')
      const lines = [{ segs: markTerms(short(m.title, 52), terms), size: 13, color: [0.96, 0.97, 0.99], weight: 500 }, { segs: [{ t: sub }], size: 10, color: [0.55, 0.59, 0.66] }]
      const hay = terms.length ? [m.description, ...String(m.body || '').split('\n')].find((l) => terms.some((t) => String(l || '').toLowerCase().includes(t))) : m.description
      if (hay && flat(hay) !== flat(m.title)) lines.push({ segs: terms.length ? snippetSegments(hay, terms, N) : [{ t: short(hay, N) }], size: 11, color: [0.72, 0.75, 0.8] })
      return lines
    }
    if (n.k === HUB) {
      return [{ segs: [{ t: 'ABOUT YOU · ' + String(n.line.section || '').toUpperCase() }], size: 9.5, color: GOLD }, { segs: markTerms(short(n.line.text, 60), terms), size: 12.5, color: [0.98, 0.95, 0.88], weight: 500 }]
    }
    const text = n.ask ? n.ask.text : ''
    const segs = n.hitSnippet && terms.length ? snippetFromHit(n.hitSnippet) : text ? (terms.length ? snippetSegments(text, terms, N) : [{ t: short(text, N) }]) : null
    if (segs) {
      let total = 0
      const trimmed = []
      for (const s of segs) { if (total >= N) break; const t = s.t.slice(0, N - total); trimmed.push({ t, hit: s.hit }); total += t.length }
      if (total >= N && trimmed.length) trimmed[trimmed.length - 1].t += '…'
      const title = n.session && n.session.title ? ' · ' + short(n.session.title, 26) : n.region >= 0 && M.regions[n.region] && n.k === NEURON ? ' · ' + short(M.regions[n.region].label, 22) : ''
      return [{ segs: trimmed, size: 12, color: [0.84, 0.86, 0.9], quote: true }, { segs: [{ t: `${n.agent.name} · ${dayShort(n.birth)} ${hm(n.birth)}${title}` }], size: 10, color: [0.5, 0.54, 0.6] }]
    }
    return [{ segs: [{ t: `a message to ${n.agent.name}` }], size: 11.5, color: [0.7, 0.73, 0.78] }, { segs: [{ t: `${dayLong(n.birth)} · its words are older than this view` }], size: 10, color: [0.48, 0.52, 0.58] }]
  }

  function drawLabel(n, p, focus, boxes, age, w, h, aimOnly) {
    const c = inkCtx
    const lines = labelLines(n, recall.terms)
    const reveal = reduceMotion ? 1e9 : Math.max(0, age) / 9 // characters typed out per ms
    let width = 0, height = 0
    for (const l of lines) { const cw = font(l.size, l.weight); const len = l.segs.reduce((s, x) => s + x.t.length, 0) + (l.quote ? 2 : 0); width = Math.max(width, len * cw); height += l.size * 1.45 }
    const pad = 8
    let x = p.x + 22, y = p.y - height / 2
    if (x + width + pad > w - 8) x = p.x - 22 - width
    x = clamp(x, 8, Math.max(8, w - width - 8))
    let ok = false
    for (const dy of [0, height + 10, -(height + 10), 2 * (height + 10), -2 * (height + 10), 3 * (height + 10)]) {
      const yy = clamp(y + dy, 40, h - height - 70)
      const box = { x: x - pad, y: yy - pad / 2, w: width + pad * 2, h: height + pad }
      if (!boxes.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) { y = yy; boxes.push(box); ok = true; break }
    }
    if (!ok && !focus) return
    if (!ok) { y = clamp(y, 40, h - height - 70); boxes.push({ x: x - pad, y, w: width + pad * 2, h: height }) }
    const alpha = focus ? 1 : 0.74
    const rgb = n.k === HUB ? GOLD : n.rgb
    // the leader and a ring on the neuron
    c.strokeStyle = css(rgb, focus ? 0.75 : 0.35)
    c.lineWidth = 1
    c.beginPath(); c.arc(p.x, p.y, focus ? 9 : 6, 0, Math.PI * 2); c.stroke()
    const lx = x > p.x ? x - 6 : x + width + 6
    c.beginPath(); c.moveTo(p.x + (lx > p.x ? 9 : -9), p.y); c.lineTo(lx, y + lines[0].size * 0.72); c.stroke()
    c.fillStyle = focus ? 'rgba(3,5,8,0.78)' : 'rgba(3,5,8,0.55)'
    c.fillRect(x - pad, y - pad / 2, width + pad * 2, height + pad)
    if (focus) { c.fillStyle = css(rgb, 0.9); c.fillRect(x - pad, y - pad / 2, 2, height + pad) }
    let yy = y
    let budget = reveal
    for (const l of lines) {
      const cw = font(l.size, l.weight)
      c.textBaseline = 'top'
      let xx = x
      const segs = l.quote ? [{ t: '“' }, ...l.segs, { t: '”' }] : l.segs
      for (const s of segs) {
        if (budget <= 0) break
        const t = s.t.slice(0, Math.max(0, Math.floor(budget)))
        budget -= s.t.length
        c.fillStyle = s.hit ? css([1, 0.93, 0.74], alpha) : css(l.color, alpha * (s.hit === false && l.quote ? 0.92 : 1))
        if (s.hit) { c.fillStyle = css(mix(rgb, WHITE, 0.55), alpha) }
        c.fillText(t, xx, yy)
        if (s.hit && t) { c.fillRect(xx, yy + l.size * 1.18, t.length * cw, 1) }
        xx += t.length * cw
      }
      yy += l.size * 1.45
    }
    if (focus && !aimOnly && recall.items.length > 1) {
      font(9.5)
      c.fillStyle = css([0.5, 0.54, 0.6], 0.9)
      c.fillText(`${recall.focus + 1}/${recall.items.length}`, x + width - 30, y - pad / 2 - 13)
    }
  }

  // ── aiming: what is under the reticle (or the mouse) ──

  function aim(now) {
    if (state.mode !== 'explore' || recall.active) { state.aim = -1; return }
    const mouse = now - state.mouse.at < 2500
    if (!mouse && cam.dist > 2.2) { state.aim = -1; return }
    const ax = mouse ? state.mouse.x : W / dpr / 2, ay = mouse ? state.mouse.y : H / dpr / 2
    const N = M.nodes
    let best = -1, bestS = 30
    for (let i = 0; i < N.length; i++) {
      const n = N[i]
      if (time.on && n.birth > time.T) continue
      const p = project(n.x, n.y, n.z)
      if (!p || p.depth > 7) continue
      const d = Math.hypot(p.x - ax, p.y - ay)
      if (d > 30) continue
      const s = d + p.depth * 2.5 - (n.k === ENGRAM ? 12 : n.k === HUB ? 14 : 0) + (n.k === GHOST ? 6 : 0) - (i === state.aim ? 6 : 0)
      if (s < bestS) { bestS = s; best = i }
    }
    if (best !== state.aim) { state.aim = best; state.aimSince = now }
  }

  // ── the timeline strip ──

  let stripDays = null
  function buildStrip() {
    const days = new Map()
    for (const n of M.nodes) {
      if (n.k !== NEURON && n.k !== GHOST) continue
      const k = dayKey(n.birth)
      let d = days.get(k)
      if (!d) days.set(k, (d = { at: new Date(k + 'T00:00:00').getTime(), engines: new Map(), total: 0 }))
      const e = d.engines.get(n.agent.id) || { count: 0, rgb: n.agent.rgb }
      e.count++; d.engines.set(n.agent.id, e); d.total++
    }
    stripDays = [...days.values()].sort((a, b) => a.at - b.at)
    stripDays.max = Math.max(1, ...stripDays.map((d) => d.total))
  }
  function drawStrip() {
    const c = stripCtx, w = strip.width, h = strip.height
    c.clearRect(0, 0, w, h)
    if (!time.on || !stripDays) return
    // the strip runs on the replay's own clock: busy weeks get room, quiet months pass in a sliver
    const x = (t) => tToU(t) * w
    const base = h - 14 * dpr
    for (const d of stripDays) {
      const x0 = x(d.at), bw = Math.max(1, x(d.at + DAY) - x0 - (x(d.at + DAY) - x0 > 4 ? 1 : 0))
      const past = d.at <= time.T
      let y = base
      const hh = Math.sqrt(d.total / stripDays.max) * (base - 4 * dpr)
      for (const { count, rgb } of d.engines.values()) {
        const seg = hh * count / d.total
        c.fillStyle = css(rgb, past ? 0.85 : 0.16)
        c.fillRect(x0, y - seg, bw, seg)
        y -= seg
      }
    }
    for (const e of M.engrams) {
      c.fillStyle = css(WHITE, e.birth <= time.T ? 0.8 : 0.15)
      c.fillRect(x(e.birth) - dpr, base + 3 * dpr, 2 * dpr, 2 * dpr)
    }
    c.fillStyle = css(GOLD, M.aboutBirth <= time.T ? 1 : 0.25)
    c.fillRect(x(M.aboutBirth) - dpr, base + 2 * dpr, 2 * dpr, 4 * dpr)
    // months
    c.font = `${9 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`
    c.textBaseline = 'bottom'
    const d0 = new Date(M.tMin); d0.setDate(1); d0.setHours(0, 0, 0, 0)
    let lastLabel = -1e9
    for (let m = new Date(d0); m.getTime() < M.tMax; m.setMonth(m.getMonth() + 1)) {
      const xx = x(m.getTime()); if (xx < 0) continue
      c.fillStyle = 'rgba(120,128,140,.5)'; c.fillRect(xx, base + 1 * dpr, 1, 9 * dpr)
      if (xx - lastLabel > 34 * dpr) { c.fillText(MONTHS[m.getMonth()].toUpperCase(), xx + 4 * dpr, h); lastLabel = xx }
    }
    // weeks, where there is room for them
    const w0 = new Date(M.tMin); w0.setHours(0, 0, 0, 0); w0.setDate(w0.getDate() - ((w0.getDay() + 6) % 7))
    for (let k = new Date(w0); k.getTime() < M.tMax; k.setDate(k.getDate() + 7)) {
      const xx = x(k.getTime()), next = x(k.getTime() + 7 * DAY)
      if (next - xx < 30 * dpr || xx < 0) continue
      c.fillStyle = 'rgba(120,128,140,.22)'; c.fillRect(xx, base + 1 * dpr, 1, 4 * dpr)
    }
    const cx = x(time.T)
    c.fillStyle = css(GOLD, 0.95); c.fillRect(cx - 0.5 * dpr, 0, 1 * dpr, base + 6 * dpr)
    c.beginPath(); c.arc(cx, 2 * dpr, 2.5 * dpr, 0, Math.PI * 2); c.fill()
  }

  // ── HUD ──

  function renderKeys() {
    const k = $('keys')
    k.replaceChildren()
    let list
    if (state.mode === 'dive') list = [['↑↓', 'choose'], ['enter', 'dive deeper'], ['esc', 'back'], ['type', 'recall']]
    else if (time.on) list = [['[ ]', 'scrub'], ['{ }', 'faster'], ['\\', time.playing ? 'pause' : 'play'], ['←→', 'orbit'], ['esc', 'today']]
    else if (recall.active) list = [['tab ↑↓', 'next memory'], ['enter', 'dive'], ['←→', 'orbit'], ['esc', 'let go']]
    else list = [['type', 'to recall'], ['←→', 'orbit'], ['↑↓', 'fly'], ['⇧', 'faster'], ['enter', 'dive'], ['esc', 'back'], ['[ ]', 'time'], ['\\', 'replay']]
    list.forEach(([key, label], i) => {
      if (i) k.appendChild(document.createTextNode('  ·  '))
      k.appendChild(el('kbd', null, key)); k.appendChild(document.createTextNode(' ' + label))
    })
  }
  let keysSig = ''
  function hud(now) {
    const sig = `${state.mode}|${time.on}|${time.playing}|${recall.active}`
    if (sig !== keysSig) { keysSig = sig; renderKeys() }
    // the clock
    const clock = $('clock')
    if (time.on) {
      clock.style.opacity = 1
      const T = Math.min(time.T, M.tMax)
      const d = new Date(T)
      clock.firstChild.textContent = `${d.getDate()} ${MONTHS[d.getMonth()].toUpperCase()} ${d.getFullYear()}`
      const lo = upperBound(birthsSorted, T)
      let msgs = 0, mems = 0
      for (let i = 0; i < lo; i++) { const kk = M.nodes[order[i]].k; if (kk === NEURON || kk === GHOST) msgs++; else if (kk === ENGRAM) mems++ }
      const s = clock.lastChild
      s.replaceChildren()
      s.appendChild(document.createTextNode(`${plural(msgs, 'message')} · ${plural(mems, 'memory', 'memories')}`))
      if (T >= M.aboutBirth) { s.appendChild(document.createTextNode(' · ')); s.appendChild(el('i', null, 'About You')) }
      if (time.rewinding) s.appendChild(document.createTextNode('   ◂◂ rewinding'))
      else if (time.playing) s.appendChild(document.createTextNode('   ▸ growing'))
      strip.style.opacity = 1
    } else { clock.style.opacity = 0; strip.style.opacity = 0 }
    drawStrip()
    const rhythm = $('rhythm')
    const showRhythm = state.mode === 'explore' && !time.on && !recall.active && innerWidth > 980
    rhythm.style.opacity = showRhythm ? 1 : 0
    if (showRhythm) rhythm.textContent = `firing as on ${ambient.label}`
    $('prompt').style.visibility = state.mode === 'dive' ? 'hidden' : ''
    const veil = $('veil')
    if (state.mode === 'dive') {
      const close = smooth(0.6, 0.07, cam.dist)
      veil.style.opacity = String(close)
      if (now >= dive.showAt && cam.dist < 0.3 && !$('dive').classList.contains('on')) $('dive').classList.add('on')
    } else veil.style.opacity = String(Math.max(0, Number(veil.style.opacity || 0) - 0.06))
  }

  // ── arrival ──

  function arrival(now) {
    const t = (now - state.arrivalStart) / 1000
    const title = $('title')
    if (reduceMotion) {
      title.style.opacity = String(smooth(0, 0.3, t) * (1 - smooth(0.7, 1.0, t)))
    } else {
      const e = easeInOut(t / 4.4)
      cam.dist = want.dist = lerp(12, HOME.dist, e)
      cam.yaw = want.yaw = HOME.yaw + 1.5 * (1 - e)
      cam.pitch = want.pitch = lerp(1.05, HOME.pitch, e)
      title.style.opacity = String(smooth(0.3, 1.1, t) * (1 - smooth(3.1, 4.0, t)))
      const line = title.lastChild
      const full = line.dataset.full || ''
      line.textContent = full.slice(0, Math.max(0, Math.floor((t - 1.0) * 46)))
    }
    if (t >= state.arrivalDur) endArrival()
  }
  function endArrival() {
    if (state.mode !== 'arrival') return
    state.mode = 'explore'
    state.arrivalStart = performance.now() - 1e6
    if (!reduceMotion) { Object.assign(want, HOME); cam.dist = Math.min(cam.dist, 5) }
    $('title').style.opacity = 0
    document.body.classList.remove('arriving')
    state.lastInput = performance.now()
    renderKeys()
  }

  // ── input ──

  addEventListener('keydown', (e) => {
    if (!M || e.isComposing) return
    if (e.metaKey || (e.ctrlKey && !['u', 'w'].includes(e.key.toLowerCase()))) return
    const key = e.key
    if (state.mode === 'arrival') endArrival()
    state.lastInput = performance.now()
    if (['Shift', 'Alt', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(key)) state.keys.add(key)

    if (state.mode === 'dive') {
      if (key === 'Escape' || key === 'ArrowLeft' || key === 'Backspace') { e.preventDefault(); leaveDive(); return }
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab') {
        e.preventDefault()
        const d = key === 'ArrowUp' || (key === 'Tab' && e.shiftKey) ? -1 : 1
        if (dive.rows.length) { dive.sel = clamp(dive.sel + d, 0, dive.rows.length - 1); markSel() }
        else document.querySelector('#dive .scroll').scrollBy({ top: d * 80 })
        return
      }
      if (key === 'Enter' || key === 'ArrowRight') { e.preventDefault(); const r = dive.rows[dive.sel]; if (r) enterDive(r.node, true); return }
      if (key === 'PageDown' || key === ' ') { e.preventDefault(); document.querySelector('#dive .scroll').scrollBy({ top: innerHeight * 0.7 }); return }
      if (key === 'PageUp') { e.preventDefault(); document.querySelector('#dive .scroll').scrollBy({ top: -innerHeight * 0.7 }); return }
      if (key.length === 1 && !e.ctrlKey && !e.altKey && !'[]{}\\'.includes(key) && key !== ' ') {
        e.preventDefault()
        dive.stack = []; leaveDive()
        setQuery(key)
      }
      return
    }

    if (key === 'Escape') {
      e.preventDefault()
      if (recall.q) setQuery('')
      else if (time.on) stopTime()
      else { Object.assign(want, HOME); camRate = 2.2 }
      return
    }
    if (key === 'Enter') {
      e.preventDefault()
      const target = recall.active && recall.items.length ? recall.items[recall.focus].i : state.aim
      if (target >= 0) enterDive(target)
      return
    }
    if (key === 'Tab') { e.preventDefault(); if (recall.active) focusItem(e.shiftKey ? -1 : 1); return }
    if ((key === 'ArrowDown' || key === 'ArrowUp') && recall.active && recall.items.length && !e.altKey) { e.preventDefault(); focusItem(key === 'ArrowUp' ? -1 : 1); return }
    if (key.startsWith('Arrow') || key === 'PageUp' || key === 'PageDown') { e.preventDefault(); return }
    if (key === 'Home') { Object.assign(want, HOME); camRate = 2.2; return }

    // time
    if (key === '[' || key === ']' || key === '{' || key === '}') {
      e.preventDefault()
      const step = key === '{' || key === '}' ? 0.12 : 0.03
      const dir = key === '[' || key === '{' ? -1 : 1
      if (!time.on && dir > 0) return
      if (!time.on) startTime(1)
      time.playing = false; time.rewinding = false; time.endHold = 0
      time.want = clamp(time.want + dir * step, 0, 1)
      if (time.want >= 1 && dir > 0) time.endHold = performance.now() + 900
      return
    }
    if (key === '\\') {
      e.preventDefault()
      if (time.on && (time.playing || time.rewinding)) { time.playing = false; time.rewinding = false; time.want = time.u; return }
      if (time.on && time.u < 0.999) { time.playing = true; time.endHold = 0; return }
      startTime(1)
      time.rewinding = !reduceMotion
      if (reduceMotion) { time.u = time.want = 0; time.playing = true }
      return
    }

    // typing is recall
    if (key === 'Backspace') { e.preventDefault(); if (e.altKey || e.ctrlKey) setQuery(recall.q.replace(/\S+\s*$/, '')); else setQuery(recall.q.slice(0, -1)); return }
    if (e.ctrlKey && key.toLowerCase() === 'u') { e.preventDefault(); setQuery(''); return }
    if (e.ctrlKey && key.toLowerCase() === 'w') { e.preventDefault(); setQuery(recall.q.replace(/\S+\s*$/, '')); return }
    if (key.length === 1 && !e.ctrlKey && !e.altKey) {
      if (key === ' ' && !recall.q) { e.preventDefault(); return }
      e.preventDefault()
      setQuery((recall.q + key).slice(0, 120))
    }
  })
  addEventListener('keyup', (e) => { state.keys.delete(e.key); if (e.key === 'Alt' || e.key === 'Shift') return })
  addEventListener('blur', () => state.keys.clear())

  surface.addEventListener('pointerdown', (e) => { state.mouse.down = true; state.mouse.dragged = false; state.mouse.lx = e.clientX; state.mouse.ly = e.clientY; surface.setPointerCapture?.(e.pointerId) })
  addEventListener('pointermove', (e) => {
    state.mouse.x = e.clientX; state.mouse.y = e.clientY; state.mouse.at = performance.now()
    if (state.mouse.down && state.mode === 'explore') {
      const dx = e.clientX - state.mouse.lx, dy = e.clientY - state.mouse.ly
      if (Math.abs(dx) + Math.abs(dy) > 2) state.mouse.dragged = true
      want.yaw -= dx * 0.006; want.pitch = clamp(want.pitch + dy * 0.005, -1.4, 1.4)
      state.mouse.lx = e.clientX; state.mouse.ly = e.clientY
      camRate = 8; state.lastInput = performance.now()
    }
  })
  addEventListener('pointerup', () => {
    if (state.mouse.down && !state.mouse.dragged && state.mode === 'explore') {
      if (recall.active && recall.items.length) {
        // click a recalled memory to dive into it
        let best = -1, bd = 26
        for (const it of recall.items) { const n = M.nodes[it.i]; const p = project(n.x, n.y, n.z); if (!p) continue; const d = Math.hypot(p.x - state.mouse.x, p.y - state.mouse.y); if (d < bd) { bd = d; best = it.i } }
        if (best >= 0) enterDive(best)
      } else if (state.aim >= 0) enterDive(state.aim)
    }
    state.mouse.down = false
  })
  surface.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (state.mode !== 'explore') return
    fly(-e.deltaY * 0.0022)
    camRate = 6; state.lastInput = performance.now()
  }, { passive: false })

  // ── the loop ──

  let running = false, last = 0
  const perf = { ms: 0 }
  function frame(now) {
    if (!running) return
    const t0 = performance.now()
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
    last = now
    if (state.mode === 'arrival') arrival(now)
    steer(dt)
    stepTime(now, dt)
    if (recall.active) { recall.fade = Math.min(1, recall.fade + dt * 3) } else recall.fade = Math.max(0, recall.fade - dt * 1.8)
    if (!recall.active && recall.fade <= 0 && recall.dirty !== false) { recallLevel.fill(0); recallStart.fill(1e15); recall.dirty = false }
    if (recall.active) recall.dirty = true
    recallCamera(now)
    if (!time.on || !time.playing) stepAmbient(now, dt)
    updateCamera(dt)
    aim(now)
    stepPulses(now)
    stepGlow(now)
    const arrive = state.mode === 'arrival' ? (now - state.arrivalStart) / 1000 : 1e4
    const lineIn = state.mode === 'arrival' ? smooth(3.0, 4.6, arrive) : 1
    renderer.draw({
      view, proj, px: pxScale, arrive,
      mul: { scaffold: (recall.fade > 0 ? lerp(1, 0.55, recall.fade) : 1) * (time.on ? 0.85 : 1), nodes: 1, pulses: 1 },
      lineMul: lineIn * (state.mode === 'dive' ? 0.6 : 1),
    })
    drawInk(now)
    hud(now)
    const cost = performance.now() - t0
    perf.ms = perf.ms * 0.95 + cost * 0.05
    requestAnimationFrame(frame)
  }
  function start() { if (running || document.hidden) return; running = true; last = performance.now(); requestAnimationFrame(frame) }
  function stop() { running = false }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()))

  // ── begin ──

  resize()
  MemoryData.load().then((data) => {
    const t0 = performance.now()
    M = buildModel(data)
    upload()
    buildStrip()
    const built = performance.now() - t0
    $('loading').remove()
    if (reduceMotion) document.body.classList.remove('arriving')
    const t = M.totals
    const who = data.real ? 'this computer' : 'an invented person'
    $('stats').textContent = `${who} · ${plural(t.loaded, 'message')}${M.ghostTotal ? ` (+${num(M.ghostTotal)} older)` : ''} · ${plural(t.memories, 'memory', 'memories')} · ${t.lines} About You · ${plural(t.regions, 'region')}`
    $('title').lastChild.dataset.full = `${plural(t.loaded + M.ghostTotal, 'thing you said', 'things you said')} · ${plural(t.memories, 'memory', 'memories')} · ${plural(t.lines, 'line', 'lines')} about you`
    state.mode = 'arrival'
    state.arrivalStart = performance.now()
    if (!reduceMotion) { cam.dist = 12; want.dist = 12 }
    renderKeys()
    window.__synapse = { perf, screenOf: (i) => { const n = M.nodes[i]; return n ? project(n.x, n.y, n.z) : null }, firstOf: (k) => M.nodes.findIndex((n) => n.k === ({ hub: HUB, engram: ENGRAM, neuron: NEURON })[k]), look: (yaw, pitch, dist) => { Object.assign(want, { ...HOME, yaw, pitch, dist: dist || HOME.dist }); Object.assign(cam, want); state.lastInput = performance.now() + 1e5 }, built: Math.round(built), renderer: renderer.kind, nodes: M.nodes.length, scaffold: M.scaffold.length, lines: M.lineVerts.length, regions: M.regions.map((r) => [r.name, r.neuronCount, r.memoryCount]), inferred: M.inferred, state: () => ({ mode: state.mode, recall: recall.items.length, focus: recall.focus, time: time.on ? time.u : 1, aim: state.aim, dive: dive.node }) }
    start()
  }).catch((error) => {
    const l = $('loading')
    if (l) { l.textContent = 'could not read memories: ' + String(error && error.message || error); l.style.letterSpacing = '0' }
    console.error(error)
  })
})()
