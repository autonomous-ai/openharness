/*
 * Tesseract: your months unrolled as a corridor of days you float through (Interstellar, 2014).
 *
 * Each day is a frame in depth. Its height is how much happened that day, so the corridor's skyline is the
 * rhythm of your weeks. Your messages hang from the frame as strands: colour is the agent, x is the project
 * lane plus the time of day, length is how much you wrote. Memories an agent wrote that day stand on its floor
 * as books. Projects run along the floor as lanes through every day. Month gates and Monday ribs are the
 * architecture; quiet stretches are empty halls.
 *
 * Pull a string (Space) on a memory or a message and a thread runs through every day it came up, vibrating
 * as it lights them. Type, and recall pulses down the corridor. About You is the window at the corridor's
 * mouth, looking back at you, with a thread from each line to the memories it cites.
 *
 * Reads only MemoryData. All memory text is untrusted (written by models): textContent and fillText only.
 */
(function () {
  'use strict'

  // ── constants ────────────────────────────────────────────────────────────────────────────────────

  const DAY = 86_400_000
  const S = 0.34               // depth between two days
  const D = 1.25               // the camera stands this far in front of the day it looks at
  const HW = 0.8               // half the width of a day frame
  const FLOOR = -0.5
  const FOG = 30               // days of depth for the fog
  const NEAR = 0.045
  const ABOUT_Z = D + 0.42     // the About You window: just behind the camera while it looks at today
  const ABOUT_D = 1.12
  const STATION = -(ABOUT_Z + ABOUT_D - D) / S   // the camera's day position in front of the window
  const AHW = 1.0, AH = 1.24   // window half width and height
  const BOOK_H = 0.118, BOOK_W = 0.017
  const WAVE = 55              // days per second a pulled string's wave travels
  const PULSE = 75             // days per second a recall pulse travels
  const MONO = 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace'
  const WARM = '233,221,199', GOLD = '244,197,108', COOL = '150,212,255', WHITE = '255,251,242'
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const NONE = 'no project'

  const $ = (id) => document.getElementById(id)
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v)
  const lerp = (a, b, t) => a + (b - a) * t
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)
  const nowS = () => performance.now() / 1000
  const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0) / 4294967296 }
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  // ── words: for strings (what came up when) and recall ─────────────────────────────────────────────

  const STOP = new Set((
    'the and for are but not you your yours with this that these those from have has had was were will would should could ' +
    'can cant just like into onto over under about after before then than them they their there here what when where which ' +
    'while who whom why how all any each every some such only own same very too also its itself our ours out off one two ' +
    'new now get got use used using make made let lets need needs want wants see look looks way more most less much many few ' +
    'lot lots thing things okay yes yeah please thanks thank sure does did done doing being been because via per etc dont ' +
    'didnt isnt thats theres whats ive youre well still even back again going gonna know think right good really other ' +
    'another him her his she ask asked tell said say says try work works working first last next time times day days week ' +
    'keep kept show shows run runs ran put take takes give gives come comes call called'
  ).split(/\s+/).filter(Boolean))
  function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y'
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
    if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
    return w
  }
  const WORD = /[\p{L}\p{N}_]{3,}/gu
  function stems(text) {
    const out = new Set()
    const found = String(text ?? '').slice(0, 5000).toLowerCase().replace(/[’']/g, '').match(WORD)
    if (found) for (const w of found) {
      if (STOP.has(w) || /^\d+$/.test(w) || w.length > 28) continue
      const s = stem(w)
      if (s.length >= 3 && !STOP.has(s)) out.add(s)
    }
    return out
  }
  const queryTerms = (q) => String(q).toLowerCase().match(/[\p{L}\p{N}_.\-/]{2,}/gu) ?? []

  // ── the model: days, lanes, items ─────────────────────────────────────────────────────────────────

  let M = null

  function build(loaded) {
    const { snapshot, asks } = loaded
    const memories = snapshot.memories ?? []
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const today0 = start.getTime()
    const kOf = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return Math.round((today0 - d.getTime()) / DAY) }
    const kOfDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return Math.round((today0 - new Date(y, m - 1, d).getTime()) / DAY) }
    const agents = new Map()
    const agentOf = (id) => { if (!agents.has(id)) agents.set(id, MemoryData.agent(id, snapshot)); return agents.get(id) }
    const activity = snapshot.sessions?.activity ?? []

    let maxK = 27
    for (const a of asks) maxK = Math.max(maxK, kOf(a.at))
    for (const m of memories) if (m.modified) maxK = Math.max(maxK, kOf(m.modified))
    for (const r of activity) maxK = Math.max(maxK, kOfDay(r.day))
    maxK = Math.min(370, maxK)

    const days = []
    for (let k = 0; k <= maxK; k++) {
      const d = new Date(today0); d.setDate(d.getDate() - k)
      days.push({ k, t: d.getTime(), date: d, dow: d.getDay(), dom: d.getDate(), month: d.getMonth(), year: d.getFullYear(),
        items: [], askItems: [], memItems: [], groups: [], by: {}, act: {}, ghostBy: {}, ghostN: 0, asks: 0, mems: 0, h: 0.13, quiet: true, bright: 0 })
    }

    // Lanes: a project is the folder a conversation ran in. A conversation keeps the lane of any message that has one.
    const projects = (snapshot.projects ?? []).filter((p) => p.name)
    const names = [...new Set([...projects.map((p) => p.name), ...memories.map((m) => m.project?.name).filter(Boolean)])].sort((a, b) => b.length - a.length)
    const laneOfCwd = (cwd) => {
      if (!cwd) return null
      const parts = String(cwd).split('/')
      for (const n of names) if (parts.includes(n)) return n
      return null
    }
    const sessionLane = new Map()
    for (const a of asks) if (!sessionLane.has(a.sessionId)) { const n = laneOfCwd(a.cwd); if (n) sessionLane.set(a.sessionId, n) }
    const laneNameOfAsk = (a) => sessionLane.get(a.sessionId) ?? laneOfCwd(a.cwd) ?? NONE
    const weight = new Map()
    for (const a of asks) { const n = laneNameOfAsk(a); weight.set(n, (weight.get(n) ?? 0) + 1) }
    for (const m of memories) { const n = m.project?.name || NONE; weight.set(n, (weight.get(n) ?? 0) + 4) }
    let order = [...weight.keys()].filter((n) => n !== NONE).sort((a, b) => weight.get(b) - weight.get(a) || a.localeCompare(b))
    const merged = new Map()
    if (order.length > 12) {
      let w = 0
      for (const n of order.slice(12)) { merged.set(n, 'other projects'); w += weight.get(n) }
      order = order.slice(0, 12); order.push('other projects'); weight.set('other projects', w)
    }
    if (weight.has(NONE)) order.push(NONE)
    if (!order.length) order.push(NONE)
    const raw = order.map((n) => Math.sqrt(weight.get(n) ?? 1))
    let share = raw.map((r) => r / raw.reduce((s, x) => s + x, 0))
    share = share.map((s) => Math.max(s, 0.036))
    const total = share.reduce((s, x) => s + x, 0)
    let u = 0
    const lanes = order.map((name, i) => {
      const w = share[i] / total
      const lane = { i, name, u0: u, u1: u + w, weight: weight.get(name) ?? 0 }
      u += w
      return lane
    })
    const laneIdx = new Map(lanes.map((l) => [l.name, l.i]))
    const laneFor = (name) => laneIdx.get(merged.get(name) ?? name) ?? laneIdx.get(NONE) ?? lanes.length - 1
    const uOf = (lane, tod) => {
      const l = lanes[lane], pad = Math.min(0.006, (l.u1 - l.u0) * 0.1)
      return l.u0 + pad + (l.u1 - l.u0 - 2 * pad) * tod
    }

    const askItems = [], memItems = [], bySession = new Map(), byAskKey = new Map()
    asks.forEach((a, n) => {
      const k = kOf(a.at)
      if (k < 0 || k > maxK) return
      const day = days[k]
      const lane = laneFor(laneNameOfAsk(a))
      const len = Math.max(a.length || 0, String(a.text ?? '').length)
      const tod = clamp((a.at - day.t) / DAY, 0, 0.9999)
      const item = { type: 'ask', a, k, lane, tod, len, engine: a.engine, color: agentOf(a.engine).color, n,
        hang: 0.16 + 0.62 * clamp(Math.log(Math.max(1, len) / 10) / Math.log(160)), lower: String(a.text ?? '').toLowerCase(), stems: null }
      item.u = uOf(lane, tod); item.x = -HW + 2 * HW * item.u
      day.askItems.push(item); day.asks++; day.by[a.engine] = (day.by[a.engine] ?? 0) + 1
      askItems.push(item)
      if (!bySession.has(a.sessionId)) bySession.set(a.sessionId, [])
      bySession.get(a.sessionId).push(item)
      byAskKey.set(`${a.sessionId}@${a.at}`, item)
    })
    const memById = new Map()
    memories.forEach((m, n) => {
      if (!m.modified) return
      const k = kOf(m.modified)
      if (k < 0 || k > maxK) return
      const day = days[k]
      const lane = laneFor(m.project?.name || NONE)
      const tod = clamp((m.modified - day.t) / DAY, 0, 0.9999)
      const item = { type: 'mem', m, k, lane, tod, color: agentOf(m.agent).color, n, stems: null,
        lower: `${m.title ?? ''}\n${m.description ?? ''}\n${m.body ?? ''}`.toLowerCase() }
      item.u = uOf(lane, tod); item.x = -HW + 2 * HW * item.u
      day.memItems.push(item); day.mems++
      memItems.push(item); memById.set(m.id, item)
    })
    for (const r of activity) {
      const k = kOfDay(r.day)
      if (k < 0 || k > maxK) continue
      days[k].act[r.engine] = (days[k].act[r.engine] ?? 0) + (r.asks || 0)
    }

    // Day shape: height from activity (messages, including older ones only counted), quiet days stay low.
    for (const day of days) {
      for (const [engine, n] of Object.entries(day.act)) {
        const g = Math.max(0, n - (day.by[engine] ?? 0))
        if (g) { day.ghostBy[engine] = g; day.ghostN += g }
      }
      day.items = [...day.askItems, ...day.memItems].sort((a, b) => a.lane - b.lane || a.tod - b.tod)
      const groups = new Map()
      for (const it of day.askItems.sort((a, b) => a.lane - b.lane || a.tod - b.tod)) {
        if (!groups.has(it.color)) groups.set(it.color, [])
        groups.get(it.color).push(it)
      }
      day.groups = [...groups].map(([color, items]) => ({ color, items }))
      if (day.ghostN) {
        const random = rng(day.k * 7919 + 17)
        const cap = Math.min(day.ghostN, 320)
        const ghosts = new Map()
        for (const [engine, n] of Object.entries(day.ghostBy)) {
          const color = agentOf(engine).color
          const share = Math.max(1, Math.round(cap * n / day.ghostN))
          const xs = new Float32Array(share), hs = new Float32Array(share)
          for (let i = 0; i < share; i++) { xs[i] = -HW + 2 * HW * (0.015 + 0.97 * random()); hs[i] = 0.12 + 0.3 * random() }
          ghosts.set(color, { color, xs, hs })
        }
        day.ghosts = [...ghosts.values()]
      }
    }
    const volume = days.map((d) => d.asks + d.ghostN + 3 * d.mems).filter((v) => v > 0).sort((a, b) => a - b)
    const p92 = volume.length ? Math.max(4, volume[Math.floor(volume.length * 0.92)]) : 1
    for (const day of days) {
      const v = day.asks + day.ghostN + 3 * day.mems
      day.quiet = !v
      day.bright = Math.sqrt(Math.min(1, v / p92))
      day.h = v ? 0.3 + 0.82 * day.bright : 0.13
    }

    // Quiet stretches: four or more days in a row without a message or a memory.
    const stretches = []
    for (let k = 0; k <= maxK;) {
      if (!days[k].quiet) { k++; continue }
      let j = k
      while (j + 1 <= maxK && days[j + 1].quiet) j++
      if (j - k + 1 >= 4) stretches.push({ from: k, to: j, n: j - k + 1, mid: (k + j) / 2 })
      k = j + 1
    }

    // Text index: which words came up, how often.
    const DF = new Map()
    for (const it of askItems) { it.stems = stems(it.a.text); for (const s of it.stems) DF.set(s, (DF.get(s) ?? 0) + 1) }
    for (const it of memItems) it.stems = stems(`${it.m.title ?? ''} ${it.m.description ?? ''} ${String(it.m.body ?? '').slice(0, 1500)}`)

    // About You: each line and the memories it cites.
    const about = snapshot.about ?? null
    const aboutLines = (about?.lines ?? []).map((line, i) => {
      const cited = MemoryData.refs(line, snapshot).map((row) => memById.get(row.id)).filter(Boolean)
      const asksRef = (line.refs ?? []).map((r) => /^asks:(\d+)/.exec(r)).filter(Boolean).reduce((s, m) => s + Number(m[1]), 0)
      return { i, line, cited, asksRef, sessionRef: (line.refs ?? []).some((r) => r.startsWith('session:')) }
    })

    return { snapshot, real: loaded.real, days, maxK, lanes, askItems, memItems, bySession, byAskKey, memById, DF, N: askItems.length,
      stretches, about, aboutLines, agentOf, laneOfCwd, laneFor, uOf, kOf, today0, loadedFrom: askItems.length ? askItems[askItems.length - 1].k : -1 }
  }

  // ── strings: everything a memory, a message or a belief is tied to ────────────────────────────────

  function keyTerms(parts, limit, minDf = 1) {
    const N = M.N || 1
    const score = new Map()
    for (const [text, w] of parts) for (const s of stems(text)) {
      const df = M.DF.get(s) || 0
      if (df < minDf || df > Math.max(6, N * 0.05)) continue
      const v = w * Math.log(1 + N / df)
      score.set(s, Math.max(score.get(s) ?? 0, v))
    }
    return [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([s]) => s)
  }
  // Two of a memory's key words together, or its single strongest word when that word is rare.
  function matches(itemStems, terms) {
    if (!terms.length || !itemStems) return false
    let hit = 0
    for (const t of terms) if (itemStems.has(t)) hit++
    if (hit >= Math.min(2, terms.length)) return true
    return itemStems.has(terms[0]) && (M.DF.get(terms[0]) || 0) <= Math.max(3, M.N * 0.006)
  }

  function buildString(source) {
    const lit = new Map()
    const add = (it) => {
      if (!it || it.k == null) return
      if (!lit.has(it.k)) lit.set(it.k, [])
      const list = lit.get(it.k)
      if (!list.includes(it)) list.push(it)
    }
    let label = '', terms = [], origin = 0, from = null, kind = source.type
    const tieMemory = (mem) => {
      const t = keyTerms([[mem.m.title, 3], [mem.m.description, 1.6], [String(mem.m.body ?? '').slice(0, 700), 0.6]], 3)
      add(mem)
      for (const it of M.askItems) if (matches(it.stems, t)) add(it)
      return t
    }
    if (source.type === 'mem') {
      terms = tieMemory(source)
      origin = source.k; label = source.m.title || 'a memory'
    } else if (source.type === 'ask' || source.type === 'hit') {
      add(source); origin = source.k
      const sid = source.type === 'ask' ? source.a.sessionId : source.h.sessionId
      for (const it of M.bySession.get(sid) ?? []) add(it)
      const text = source.type === 'ask' ? source.a.text : String(source.h.snippet ?? '').replace(/[\u0002\u0003…]/g, '')
      terms = keyTerms([[text, 1]], 2, 2)
      if (terms.length) {
        for (const it of M.askItems) if (it !== source && matches(it.stems, terms)) add(it)
        for (const it of M.memItems) if (matches(it.stems, terms)) add(it)
      }
      label = oneLine(text).slice(0, 60) || 'a message'
    } else if (source.type === 'about') {
      const row = source.row
      for (const mem of row.cited) tieMemory(mem)
      terms = keyTerms([[row.line.text, 1]], 3, 2)
      if (terms.length) for (const it of M.askItems) if (matches(it.stems, terms)) add(it)
      origin = STATION + 1; label = row.line.text
      from = aboutFrom(row.i)
    }
    const order = [...lit.keys()].sort((a, b) => a - b)
    const anchors = new Map()
    for (const k of order) {
      const list = lit.get(k)
      anchors.set(k, list.includes(source) ? source : list.find((it) => it.type === 'mem') ?? list[Math.floor(list.length / 2)])
    }
    const set = new Set()
    for (const list of lit.values()) for (const it of list) set.add(it)
    const path = []
    if (from) path.push({ ...from, k: STATION + 1 })
    for (const k of order) { const p = anchorPoint(anchors.get(k)); path.push({ ...p, k }) }
    return { source, kind, label, terms, lit, order, anchors, set, origin, path, t0: nowS() }
  }

  function anchorPoint(it) {
    const day = M.days[it.k]
    if (it.type === 'mem') return { x: it.x, y: FLOOR + BOOK_H + 0.012, z: -it.k * S }
    const top = FLOOR + day.h
    return { x: it.x, y: top - (it.hang ?? 0.3) * day.h * 0.86, z: -it.k * S }
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────

  const canvas = $('scene'), ctx = canvas.getContext('2d')
  const ui = { day: $('day'), date: $('date'), ago: $('ago'), counts: $('counts'), chips: $('chips'), daynote: $('daynote'),
    source: $('source'), lane: $('lane'), ticker: $('ticker'), status: $('status'), hint: $('hint'), card: $('card'), about: $('about'), load: $('load') }
  let vw = 0, vh = 0, dpr = 1, F0 = 500, F = 500, OX = 0, OY = 0
  const cam = { k: -1.6, x: 1, y: 0.38, yaw: -0.46, pitch: -0.11 }
  let camZ = 0, cY = 1, sY = 0, cP = 1, sP = 0
  const fly = { from: 0, to: 0, t0: 0, dur: 0, ease: easeOut, active: false }
  let mode = 'corridor'          // 'corridor' | 'about'
  const focus = { k: 0, item: null, lane: 0, u: 0.5 }
  let aboutSel = 0
  let pulled = null
  const recall = { open: false, q: '', terms: [], hits: [], set: new Set(), byDay: new Map(), t0: -99, origin: 0, extras: [], seq: 0, timer: 0, mems: 0 }
  let reading = null             // the item (or About line) open in the card
  let arrival = null
  const mouse = { x: 0, y: 0 }
  let raf = 0, lastT = 0, speed = 0, prevK = 0, wheelAcc = 0
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  let reduced = motion.matches
  motion.addEventListener?.('change', (e) => { reduced = e.matches; kick() })
  const perf = { frames: 0, ms: 0, worst: 0 }
  let aboutRects = null, aboutBars = null, aboutOpacity = 0, aboutBox = ''

  // ── projection ────────────────────────────────────────────────────────────────────────────────────

  const V = { x: 0, y: 0, d: 0 }
  function view(x, y, z) {
    const dx = x - cam.x, dy = y - cam.y, dz = z - camZ
    const d0 = dx * sY - dz * cY
    V.x = dx * cY + dz * sY
    V.d = d0 * cP + dy * sP
    V.y = dy * cP - d0 * sP
    return V
  }
  // A frame is a plane at one depth; points on it project through a fixed linear map (an exact homography).
  const P = { ox: 0, oy: 0, od: 0, xx: 0, xy: 0, xd: 0, yx: 0, yy: 0, yd: 0 }
  function plane(z) {
    view(0, 0, z); const ox = V.x, oy = V.y, od = V.d
    view(1, 0, z); P.xx = V.x - ox; P.xy = V.y - oy; P.xd = V.d - od
    view(0, 1, z); P.yx = V.x - ox; P.yy = V.y - oy; P.yd = V.d - od
    P.ox = ox; P.oy = oy; P.od = od
    return od
  }
  let PX = 0, PY = 0, PD = 0
  function ps(x, y) {
    const d = P.od + x * P.xd + y * P.yd
    PD = d
    const inv = F / (d > NEAR ? d : NEAR)
    PX = OX + (P.ox + x * P.xx + y * P.yx) * inv
    PY = OY - (P.oy + x * P.xy + y * P.yy) * inv
    return d > NEAR
  }
  function p3(x, y, z) {
    view(x, y, z)
    PD = V.d
    const inv = F / (V.d > NEAR ? V.d : NEAR)
    PX = OX + V.x * inv; PY = OY - V.y * inv
    return V.d > NEAR
  }

  // During the arrival the corridor unfolds: every day starts at today and flies back to its place.
  function unfold(k, T) {
    if (!arrival) return 1
    return easeOut(clamp((T - arrival.t0 - 0.35 - k * arrival.stagger) / 1.15))
  }
  function unfoldAlpha(k, T) {
    if (!arrival) return 1
    return clamp((T - arrival.t0 - 0.25 - k * arrival.stagger) / 0.3)
  }
  const zOf = (k, T) => -k * S * unfold(k, T)

  // ── glow from strings and recall ─────────────────────────────────────────────────────────────────

  function litGlow(k, T) {
    if (!pulled || !pulled.lit.has(k)) return 0
    if (reduced) return 0.85
    const at = pulled.t0 + Math.abs(k - pulled.origin) / WAVE
    if (T < at) return 0
    return 0.6 + 0.4 * Math.exp(-(T - at) / 0.6)
  }
  function hitGlow(k, T) {
    const n = recall.byDay.get(k)
    if (!n) return 0
    const strength = 0.5 + 0.5 * Math.min(1, n / 4)
    if (reduced) return strength
    const at = recall.t0 + Math.abs(k - recall.origin) / PULSE
    if (T < at) return 0
    return strength * (0.75 + 0.5 * Math.exp(-(T - at) / 0.45))
  }
  const recallOn = () => recall.q.trim().length >= 2

  // ── drawing ───────────────────────────────────────────────────────────────────────────────────────

  function render(T) {
    const t0 = performance.now()
    const trails = !reduced && (speed > 14 || (arrival && T - arrival.t0 > 0.4))
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    if (trails) { ctx.fillStyle = `rgba(6,6,8,${speed > 40 ? 0.36 : 0.5})`; ctx.fillRect(0, 0, vw, vh) }
    else { ctx.fillStyle = '#060608'; ctx.fillRect(0, 0, vw, vh) }
    if (!M) return

    // Light at the far end, where the past goes.
    if (p3(0, FLOOR + 0.45, -(cam.k + 140) * S)) {
      const g = ctx.createRadialGradient(PX, PY, 0, PX, PY, Math.max(vw, vh) * 0.42)
      g.addColorStop(0, 'rgba(244,197,108,0.075)'); g.addColorStop(0.4, 'rgba(244,197,108,0.02)'); g.addColorStop(1, 'rgba(244,197,108,0)')
      ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh)
    }

    const kNear = Math.max(0, Math.floor(cam.k) - 1)
    const kFar = Math.min(M.maxK, Math.ceil(Math.max(cam.k, 0) + 118))
    drawFloor(kNear, kFar, T)
    labelQueue.length = 0
    for (let k = kFar; k >= kNear; k--) drawDay(M.days[k], T)
    drawLabels()
    drawDust(T)
    drawPulse(T)
    drawPulled(T)
    drawFocus(T)
    drawAbout(T)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    const ms = performance.now() - t0
    perf.frames++; perf.ms += ms; perf.worst = Math.max(perf.worst, ms)
  }

  // Dust hanging in the corridor: still when you stand, streaks when you fly.
  const DUST_SPAN = 26
  const dust = (() => {
    const random = rng(4242)
    return Array.from({ length: 260 }, () => ({ x: (random() * 2 - 1) * 1.05, y: FLOOR + 0.02 + random() * 1.3, k: random() * DUST_SPAN, r: 0.4 + random() * 0.9 }))
  })()
  function drawDust(T) {
    const base = cam.k - 1.2
    const dir = fly.active ? Math.sign(fly.to - fly.from) : 0
    const streak = reduced ? 0 : Math.min(2.2, speed * 0.035) * dir
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = `rgb(${WARM})`; ctx.strokeStyle = `rgb(${WARM})`
    ctx.lineWidth = 1
    for (const m of dust) {
      const kk = base + ((((m.k - base) % DUST_SPAN) + DUST_SPAN) % DUST_SPAN)
      const rel = kk - cam.k
      const a = clamp((rel + 1.0) / 1.0) * Math.exp(-Math.max(0, rel) / 9) * (arrival ? unfoldAlpha(0, T) : 1)
      if (a < 0.02 || !p3(m.x, m.y, -kk * S)) continue
      const x = PX, y = PY, size = clamp(F / PD * 0.0022 * m.r, 0.4, 2.2)
      if (Math.abs(streak) > 0.05) {
        if (!p3(m.x, m.y, -(kk + streak) * S)) continue
        ctx.globalAlpha = a * 0.35
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(PX, PY); ctx.stroke()
      } else {
        ctx.globalAlpha = a * 0.3
        ctx.fillRect(x - size / 2, y - size / 2, size, size)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function dayAlpha(k, T) {
    const rel = k - cam.k
    const near = clamp((rel + 0.8) / 0.8)
    return near * Math.exp(-Math.max(0, rel) / FOG) * unfoldAlpha(k, T)
  }

  function drawFloor(kNear, kFar, T) {
    // Rails start just in front of the day you look at: days nearer than that are behind you.
    const kStart = Math.max(kNear, Math.ceil(cam.k - 0.25))
    const zn = -Math.max(0, cam.k - 0.25) * S + S * 0.3, zf = zOf(kFar, T)
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineWidth = 1
    // Floor edges and the skyline (each side's top edge through every day: the rhythm of your weeks).
    for (const side of [-1, 1]) {
      if (p3(side * HW, FLOOR, zn)) {
        const ax = PX, ay = PY
        p3(side * HW, FLOOR, zf)
        const g = ctx.createLinearGradient(ax, ay, PX, PY)
        g.addColorStop(0, `rgba(${WARM},0.30)`); g.addColorStop(1, `rgba(${WARM},0)`)
        ctx.strokeStyle = g; ctx.globalAlpha = 1
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(PX, PY); ctx.stroke()
      }
      ctx.strokeStyle = `rgb(${WARM})`
      for (let k0 = kStart; k0 < kFar; k0 += 8) {
        const k1 = Math.min(kFar, k0 + 8)
        ctx.globalAlpha = 0.22 * dayAlpha(k0 + 4, T)
        if (ctx.globalAlpha < 0.004) continue
        ctx.beginPath()
        let started = false
        for (let k = k0; k <= k1; k++) {
          const day = M.days[k], z = zOf(k, T)
          if (!p3(side * HW, FLOOR + day.h, z)) { started = false; continue }
          if (!started) { ctx.moveTo(PX, PY); started = true } else ctx.lineTo(PX, PY)
        }
        ctx.stroke()
      }
    }
    // Project lanes along the floor: faint the whole way, bright on the days the project was busy.
    const levels = [0.05, 0.12, 0.22, 0.36, 0.55]
    const paths = levels.map(() => new Path2D())
    const focusLane = focus.item ? focus.item.lane : focus.lane
    for (const lane of M.lanes) {
      const x = -HW + 2 * HW * (lane.u0 + lane.u1) / 2
      if (p3(x, FLOOR, zn)) {
        const ax = PX, ay = PY
        p3(x, FLOOR, zf)
        const g = ctx.createLinearGradient(ax, ay, PX, PY)
        const base = lane.i === focusLane && mode === 'corridor' ? `rgba(${GOLD},0.34)` : `rgba(${WARM},0.075)`
        g.addColorStop(0, base); g.addColorStop(1, `rgba(${WARM},0)`)
        ctx.strokeStyle = g; ctx.globalAlpha = 1
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(PX, PY); ctx.stroke()
      }
    }
    for (let k = kStart; k <= Math.min(kFar, Math.floor(cam.k) + 70); k++) {
      const day = M.days[k]
      if (!day.askItems.length && !day.memItems.length) continue
      const a = dayAlpha(k, T)
      if (a < 0.02) continue
      const counts = new Map()
      for (const it of day.items) counts.set(it.lane, (counts.get(it.lane) ?? 0) + (it.type === 'mem' ? 3 : 1))
      const z = zOf(k, T)
      for (const [li, n] of counts) {
        const lane = M.lanes[li]
        const x = -HW + 2 * HW * (lane.u0 + lane.u1) / 2
        const v = a * (0.25 + 0.75 * Math.min(1, Math.sqrt(n / 12)))
        let lvl = 0
        while (lvl < levels.length - 1 && levels[lvl + 1] <= v) lvl++
        if (v < levels[0] * 0.6) continue
        if (!p3(x, FLOOR, z + S * 0.45)) continue
        const ax = PX, ay = PY
        if (!p3(x, FLOOR, z - S * 0.45)) continue
        paths[lvl].moveTo(ax, ay); paths[lvl].lineTo(PX, PY)
      }
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = `rgb(${WARM})`
    ctx.lineWidth = 1.4
    levels.forEach((lvl, i) => { ctx.globalAlpha = lvl; ctx.stroke(paths[i]) })
    ctx.globalCompositeOperation = 'source-over'
    // The end of the corridor: the first day anything was said or written down.
    if (kFar === M.maxK && !arrival) {
      const k = M.maxK + 1.4
      const a = dayAlpha(k, T)
      if (a > 0.04 && p3(0, FLOOR + 0.02, -k * S)) {
        const size = clamp(F / PD * 0.045, 0, 13)
        if (size >= 6.5) {
          ctx.font = `${size.toFixed(1)}px ${MONO}`
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
          ctx.fillStyle = `rgb(${GOLD})`; ctx.globalAlpha = 0.55 * a
          const first = M.days[M.maxK]
          ctx.fillText(`WHERE YOUR MEMORY BEGINS · ${fmtDate(first.t).toUpperCase()}`, PX, PY)
        }
      }
    }
    // Quiet stretches are written on the floor.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (const st of M.stretches) {
      if (st.to < Math.max(kNear, cam.k + 1) || st.from > kFar) continue
      const k = clamp(st.mid, Math.max(kNear, cam.k + 1.5), kFar)
      const a = dayAlpha(k, T)
      if (a < 0.05 || !p3(0, FLOOR, zOf(k, T))) continue
      const size = clamp(F / PD * 0.05, 0, 14)
      if (size < 7) continue
      ctx.font = `${size.toFixed(1)}px ${MONO}`
      ctx.fillStyle = `rgba(${WARM},${(0.5 * a).toFixed(3)})`
      ctx.fillText(`${st.n} quiet days`.toUpperCase().split('').join(' '), PX, PY - size * 0.9)
    }
  }

  function drawDay(day, T) {
    const k = day.k
    const a = dayAlpha(k, T)
    if (a < 0.006) return
    const z = zOf(k, T)
    const od = plane(z)
    if (od < NEAR * 2) return
    const sc = F / od                 // pixels per world unit on this frame
    const h = arrival ? lerp(0.13, day.h, unfold(k, T)) : day.h
    const top = FLOOR + h
    const lit = litGlow(k, T), hit = hitGlow(k, T)
    const isFocus = k === focus.k && mode === 'corridor' && !arrival
    const strong = Math.max(lit, hit)
    const tint = lit >= hit && lit > 0 ? GOLD : hit > 0 ? COOL : WARM
    const lw = clamp(sc * 0.0019, 0.5, 1.6) * (day.dow === 1 ? 1.9 : 1)

    // Month gate, between the first of a month and the month before it.
    if (day.dom === 1 && k < M.maxK) drawGate(day, T, a)

    ctx.globalCompositeOperation = 'source-over'
    // The frame, a doorway with no sill: sides and lintel.
    ps(-HW, FLOOR); const blx = PX, bly = PY
    ps(-HW, top); const tlx = PX, tly = PY
    ps(HW, top); const trx = PX, try_ = PY
    ps(HW, FLOOR); const brx = PX, bry = PY
    if (strong > 0) {
      ctx.globalAlpha = a * 0.028 * strong
      ctx.fillStyle = `rgb(${tint})`
      ctx.beginPath(); ctx.moveTo(blx, bly); ctx.lineTo(tlx, tly); ctx.lineTo(trx, try_); ctx.lineTo(brx, bry); ctx.closePath(); ctx.fill()
    }
    ctx.globalAlpha = clamp(a * ((day.quiet ? 0.2 : 0.2 + 0.42 * day.bright) + 0.62 * strong + (isFocus ? 0.3 : 0)))
    ctx.strokeStyle = `rgb(${strong > 0 ? tint : isFocus ? WHITE : WARM})`
    ctx.lineWidth = lw * (strong > 0 ? 1.5 : 1)
    if (day.quiet) ctx.setLineDash([2, 5])
    ctx.beginPath(); ctx.moveTo(blx, bly); ctx.lineTo(tlx, tly); ctx.lineTo(trx, try_); ctx.lineTo(brx, bry); ctx.stroke()
    if (day.quiet) ctx.setLineDash([])
    if (strong > 0) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = a * 0.22 * strong
      ctx.lineWidth = lw * 7
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineWidth = lw
    }
    // The floor line of the frame: the shelf the books stand on.
    ctx.globalAlpha = a * (0.1 + 0.2 * day.bright)
    ctx.beginPath(); ctx.moveTo(blx, bly); ctx.lineTo(brx, bry); ctx.stroke()

    const hpx = sc * h
    const dim = (pulled || recallOn()) ? 0.28 : 1
    ctx.globalCompositeOperation = 'lighter'
    // Older messages that are counted but not loaded here: a faint haze of their colours.
    if (day.ghosts && hpx > 3) {
      const wpx = sc * 2 * HW
      const stride = Math.max(1, Math.ceil(day.ghostN / Math.max(8, wpx / 2.4)))
      ctx.lineWidth = clamp(sc * 0.0016, 0.5, 1.2)
      for (const g of day.ghosts) {
        ctx.strokeStyle = g.color
        ctx.globalAlpha = a * 0.2 * dim
        ctx.beginPath()
        for (let i = 0; i < g.xs.length; i += stride) {
          ps(g.xs[i], top); ctx.moveTo(PX, PY)
          ps(g.xs[i], top - g.hs[i] * h); ctx.lineTo(PX, PY)
        }
        ctx.stroke()
      }
    }
    // Your messages, hanging from the lintel.
    if (day.groups.length && hpx > 2.5) {
      const wpx = sc * 2 * HW
      const stride = Math.max(1, Math.ceil(day.asks / Math.max(14, wpx / 1.25)))
      const slw = clamp(sc * 0.0021, 0.55, 1.8)
      const glow = sc > 230
      const crowd = clamp(1.7 / Math.sqrt(Math.max(1, day.asks) / 18), 0.32, 1)
      const sa = a * (0.5 + 0.4 * clamp(sc / 500)) * dim * crowd
      for (const g of day.groups) {
        ctx.strokeStyle = g.color
        ctx.beginPath()
        for (let i = 0; i < g.items.length; i += stride) {
          const it = g.items[i]
          ps(it.x, top); ctx.moveTo(PX, PY)
          ps(it.x, top - it.hang * h * 0.86); ctx.lineTo(PX, PY)
        }
        if (glow) { ctx.globalAlpha = sa * 0.17; ctx.lineWidth = slw * 3.6; ctx.stroke() }
        ctx.globalAlpha = sa; ctx.lineWidth = slw; ctx.stroke()
      }
      // A bead of light at each tip, close up.
      if (sc > 330) {
        for (const g of day.groups) {
          ctx.fillStyle = g.color; ctx.globalAlpha = sa * 0.9
          for (let i = 0; i < g.items.length; i += stride) {
            const it = g.items[i]
            ps(it.x, top - it.hang * h * 0.86)
            ctx.fillRect(PX - slw, PY - slw * 0.5, slw * 2, slw * 2)
          }
        }
      }
    }
    // Strands a pulled string or a recall touches.
    const marked = []
    if (pulled && lit > 0) for (const it of pulled.lit.get(k) ?? []) marked.push([it, GOLD, lit])
    if (hit > 0) for (const it of day.items) if (recall.set.has(it)) marked.push([it, COOL, hit])
    if (marked.length) {
      const slw = clamp(sc * 0.0026, 0.8, 2.4)
      for (const [it, color, g] of marked) {
        if (it.type === 'mem') continue
        const tipY = top - (it.hang ?? 0.3) * h * 0.86
        ps(it.x, top); const x0 = PX, y0 = PY
        ps(it.x, tipY)
        ctx.strokeStyle = `rgb(${color})`
        ctx.globalAlpha = a * 0.22 * g; ctx.lineWidth = slw * 4
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(PX, PY); ctx.stroke()
        ctx.globalAlpha = a * 0.95 * g; ctx.lineWidth = slw
        ctx.stroke()
      }
    }
    ctx.globalCompositeOperation = 'source-over'

    // Memories written that day: books on the floor.
    if (day.memItems.length && sc * BOOK_H > 1.2) {
      for (const it of day.memItems) {
        const pop = it === focus.item && mode === 'corridor' ? 1 : 0
        if (pop) continue // drawn by drawFocus, pulled out of the shelf
        const touched = (pulled && pulled.set.has(it) && lit > 0) || (recall.set.has(it) && hit > 0)
        drawBook(it, a, sc, touched ? (pulled && pulled.set.has(it) ? GOLD : COOL) : null, z)
      }
    }

    // Labels: the date over the lintel, close up; Mondays carry their week far away.
    const rel = k - cam.k
    if (!arrival || unfoldAlpha(k, T) > 0.9) {
      const size = clamp(sc * 0.042, 0, 14)
      const weekday = day.dow === 1
      if (size >= 6.5 && (rel < 10 || weekday || k === 0)) {
        const label = k === 0 ? 'TODAY' : rel < 10 ? `${WD[day.dow]} ${day.dom}`.toUpperCase() : `W${isoWeek(day.date)}`
        ps(-HW, top)
        labelQueue.push({ rel, size, label, x: PX + 1, y: PY - size * 0.45, alpha: clamp(a * (isFocus ? 1 : 0.55 + 0.4 * strong)),
          color: isFocus ? WHITE : strong > 0 ? tint : WARM, week: weekday && rel < 10 && size >= 9 ? `W${isoWeek(day.date)}` : null })
      }
    }
  }

  const labelQueue = []
  function drawLabels() {
    labelQueue.sort((a, b) => a.rel - b.rel)
    const placed = []
    ctx.globalCompositeOperation = 'source-over'
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
    for (const l of labelQueue) {
      ctx.font = `${l.size.toFixed(1)}px ${MONO}`
      const w = ctx.measureText(l.label).width
      const box = [l.x - 2, l.y - l.size * (l.week ? 2.3 : 1.15), l.x + w + 4, l.y + 2]
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue
      placed.push(box)
      ctx.globalAlpha = l.alpha
      ctx.fillStyle = `rgb(${l.color})`
      ctx.fillText(l.label, l.x, l.y)
      if (l.week) { ctx.globalAlpha = l.alpha * 0.6; ctx.fillText(l.week, l.x, l.y - l.size * 1.15) }
    }
  }

  function drawBook(it, a, sc, touched, z) {
    const x0 = it.x - BOOK_W / 2, x1 = it.x + BOOK_W / 2
    ps(x0, FLOOR); const ax = PX, ay = PY
    ps(x1, FLOOR + BOOK_H); const bx = PX, by = PY
    const w = Math.max(1, bx - ax), hgt = ay - by
    ctx.globalAlpha = a * 0.92
    ctx.fillStyle = touched ? `rgb(${touched})` : '#efe3c8'
    ctx.fillRect(ax, by, w, hgt)
    ctx.fillStyle = it.color
    ctx.fillRect(ax, by, w, Math.max(1, hgt * 0.16))
    if (touched) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = a * 0.28
      ctx.fillStyle = `rgb(${touched})`
      ctx.fillRect(ax - w, by - w, w * 3, hgt + w * 2)
      ctx.globalCompositeOperation = 'source-over'
    }
    if (hgt > 54 && w > 7) {
      ctx.save()
      ctx.translate(ax + w / 2, ay - hgt * 0.22)
      ctx.rotate(-Math.PI / 2)
      ctx.font = `${clamp(w * 0.62, 7, 11).toFixed(1)}px ${MONO}`
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillStyle = '#2a241b'; ctx.globalAlpha = a
      ctx.beginPath(); ctx.rect(0, -w / 2, hgt * 0.62, w); ctx.clip()
      ctx.fillText(String(it.m.title ?? ''), 0, 0.5)
      ctx.restore()
    }
  }

  function drawGate(day, T, a) {
    const z = zOf(day.k, T) - S * 0.5
    const od = plane(z)
    if (od < NEAR * 2) return
    const sc = F / od
    const gh = 1.36, gw = HW + 0.07, pw = 0.028
    const alpha = clamp(a * 1.25)
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = `rgb(${WARM})`
    ctx.fillStyle = `rgb(${WARM})`
    ctx.lineWidth = clamp(sc * 0.002, 0.5, 1.4)
    for (const side of [-1, 1]) {
      const x0 = side * gw, x1 = side * (gw + pw)
      ps(Math.min(x0, x1), FLOOR); const ax = PX, ay = PY
      ps(Math.max(x0, x1), FLOOR + gh); const bx = PX, by = PY
      ctx.globalAlpha = alpha * 0.13; ctx.fillRect(ax, by, bx - ax, ay - by)
      ctx.globalAlpha = alpha * 0.62; ctx.strokeRect(ax, by, bx - ax, ay - by)
    }
    ps(-(gw + pw * 2.2), FLOOR + gh); const lx = PX, ly = PY
    ps(gw + pw * 2.2, FLOOR + gh + 0.036); const rx = PX, ry = PY
    ctx.globalAlpha = alpha * 0.14; ctx.fillRect(lx, ry, rx - lx, ly - ry)
    ctx.globalAlpha = alpha * 0.6; ctx.strokeRect(lx, ry, rx - lx, ly - ry)
    const size = clamp(sc * 0.08, 0, 26)
    if (size >= 6) {
      const older = M.days[day.k + 1]
      ctx.font = `${size.toFixed(1)}px ${MONO}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.globalAlpha = alpha * 0.85
      ctx.fillStyle = `rgb(${GOLD})`
      ps(0, FLOOR + gh + 0.05)
      const name = MONTHS[older.month].toUpperCase().split('').join(size > 12 ? '  ' : ' ')
      ctx.fillText(name, PX, PY)
      if (size >= 10) {
        ctx.font = `${(size * 0.5).toFixed(1)}px ${MONO}`
        ctx.globalAlpha = alpha * 0.5
        ctx.fillStyle = `rgb(${WARM})`
        ctx.fillText(String(older.year), PX, PY - size * 1.15)
      }
    }
  }

  function drawPulse(T) {
    if (!recallOn() || reduced) return
    const t = T - recall.t0
    if (t > 2.6) return
    const fade = 1 - t / 2.6
    for (const dir of [1, -1]) {
      const k = recall.origin + dir * t * PULSE
      if (k < 0 || k > M.maxK || k < cam.k - 0.5) continue
      const od = plane(-k * S)
      if (od < NEAR * 2) continue
      const h = 1.2
      ps(-HW - 0.03, FLOOR); const ax = PX, ay = PY
      ps(HW + 0.03, FLOOR + h)
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = `rgb(${COOL})`
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.5 * fade * Math.exp(-Math.max(0, k - cam.k) / (FOG * 1.4))
      ctx.strokeRect(ax, PY, PX - ax, ay - PY)
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawPulled(T) {
    if (!pulled || !pulled.path.length) return
    const pts = pulled.path
    const levels = [0.08, 0.2, 0.4, 0.65, 0.95]
    const glowPaths = levels.map(() => new Path2D()), corePaths = levels.map(() => new Path2D()), sidePaths = levels.map(() => new Path2D())
    const t = T
    // Three threads braided between the knots, each with its own phase, like the film's golden strings.
    const BRAID = [[0, 0, 1], [0.009, 2.1, 0.85], [-0.009, 4.2, 0.85]]
    const segPoint = (A, B, s, b, out) => {
      const kk = lerp(A.k, B.k, s)
      const span = Math.abs(B.k - A.k)
      const [off, phase, ampK] = BRAID[b]
      const open = Math.sin(Math.PI * s) * Math.min(1, span / 3)
      let y = lerp(A.y, B.y, s) - Math.sin(Math.PI * s) * Math.min(0.09, 0.012 * span) + off * open * Math.cos(kk * 3.1 + phase)
      let x = lerp(A.x, B.x, s) + off * open * Math.sin(kk * 3.1 + phase)
      const at = pulled.t0 + Math.abs(kk - pulled.origin) / WAVE
      const on = reduced || t >= at
      if (on && !reduced) {
        const amp = (0.05 * Math.exp(-(t - at) / 0.7) + 0.0035) * ampK
        y += amp * Math.sin(kk * 1.9 - t * 15 + phase)
        x += amp * 0.35 * Math.cos(kk * 1.3 - t * 11 + phase)
      }
      out.on = on; out.k = kk
      const ok = p3(x, y, lerp(A.z, B.z, s))
      out.x = PX; out.y = PY; out.ok = ok
      return out
    }
    const q0 = {}, q1 = {}
    const single = pts.length === 1
    const list = single ? [pts[0], { ...pts[0], y: pts[0].y + 0.001 }] : pts
    for (let b = 0; b < BRAID.length; b++) {
      for (let i = 0; i + 1 < list.length; i++) {
        const A = list[i], B = list[i + 1]
        const n = Math.round(clamp(Math.abs(B.k - A.k) * 1.6, 6, 52))
        segPoint(A, B, 0, b, q0)
        for (let j = 1; j <= n; j++) {
          segPoint(A, B, j / n, b, q1)
          if (q0.ok && q1.ok) {
            const fog = Math.exp(-Math.max(0, q1.k - cam.k) / FOG) * clamp((q1.k - cam.k + 0.55) / 0.6)
            const v = PD > 0.32 ? (q1.on ? 0.95 : 0.12) * fog : 0
            let lvl = 0
            while (lvl < levels.length - 1 && levels[lvl + 1] <= v) lvl++
            if (v > 0.03) {
              if (b === 0) {
                glowPaths[lvl].moveTo(q0.x, q0.y); glowPaths[lvl].lineTo(q1.x, q1.y)
                corePaths[lvl].moveTo(q0.x, q0.y); corePaths[lvl].lineTo(q1.x, q1.y)
              } else { sidePaths[lvl].moveTo(q0.x, q0.y); sidePaths[lvl].lineTo(q1.x, q1.y) }
            }
          }
          q0.x = q1.x; q0.y = q1.y; q0.ok = q1.ok; q0.k = q1.k; q0.on = q1.on
        }
      }
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = `rgb(${GOLD})`
    levels.forEach((lvl, i) => {
      ctx.globalAlpha = lvl * 0.2; ctx.lineWidth = 6; ctx.stroke(glowPaths[i])
      ctx.globalAlpha = lvl * 0.5; ctx.lineWidth = 0.8; ctx.stroke(sidePaths[i])
      ctx.globalAlpha = lvl; ctx.lineWidth = 1.3; ctx.stroke(corePaths[i])
    })
    // Knots where the string touches a day.
    ctx.fillStyle = `rgb(${GOLD})`
    for (const p of pts) {
      const at = reduced ? -Infinity : pulled.t0 + Math.abs(p.k - pulled.origin) / WAVE
      if (T < at || !p3(p.x, p.y, p.z)) continue
      const r = clamp(F / PD * 0.006, 1, 4)
      const fog = Math.exp(-Math.max(0, p.k - cam.k) / FOG) * clamp((p.k - cam.k + 0.55) / 0.6)
      if (PD < 0.32 || fog < 0.01) continue
      ctx.globalAlpha = 0.9 * fog
      ctx.beginPath(); ctx.arc(PX, PY, r, 0, Math.PI * 2); ctx.fill()
      if (!reduced) {
        const flare = Math.exp(-(T - at) / 0.5)
        if (flare > 0.02) { ctx.globalAlpha = 0.5 * flare * fog; ctx.beginPath(); ctx.arc(PX, PY, r * 5, 0, Math.PI * 2); ctx.fill() }
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawFocus(T) {
    if (mode !== 'corridor' || arrival || !M) return
    const day = M.days[focus.k]
    const a = dayAlpha(focus.k, T)
    if (a < 0.05) return
    const z = zOf(focus.k, T)
    const od = plane(z)
    if (od < NEAR * 2) return
    const sc = F / od
    const top = FLOOR + day.h
    // The lane you stand in, as a faint band of light through this day.
    const laneI = focus.item ? focus.item.lane : focus.lane
    const lane = M.lanes[laneI]
    if (lane) {
      const x0 = -HW + 2 * HW * lane.u0, x1 = -HW + 2 * HW * lane.u1
      ps(x0, FLOOR); const ax = PX, ay = PY
      ps(x1, top); const bx = PX, by = PY
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.045 * a
      ctx.fillStyle = `rgb(${GOLD})`
      ctx.fillRect(ax, by, bx - ax, ay - by)
      ctx.globalCompositeOperation = 'source-over'
      // Lane names on the floor, and the hours of the day under the lane you are in.
      ctx.textBaseline = 'top'; ctx.textAlign = 'center'
      ctx.font = `10px ${MONO}`
      const labels = []
      for (const l of M.lanes) {
        ps(-HW + 2 * HW * l.u0, FLOOR); const lx0 = PX
        ps(-HW + 2 * HW * l.u1, FLOOR); const lx1 = PX
        const mine = l.i === laneI
        let name = l.name
        const room = lx1 - lx0 - 6
        let w = ctx.measureText(name).width
        if (!mine && w > room) {
          if (room < 30) continue
          while (name.length > 3 && ctx.measureText(name + '…').width > room) name = name.slice(0, -1)
          name += '…'; w = ctx.measureText(name).width
        }
        labels.push({ name, cx: clamp((lx0 + lx1) / 2, w / 2 + 4, vw - w / 2 - 4), w, mine })
      }
      const taken = []
      const ly = PY + 8
      for (const lb of [...labels.filter((l) => l.mine), ...labels.filter((l) => !l.mine)]) {
        const x0 = lb.cx - lb.w / 2 - 7, x1 = lb.cx + lb.w / 2 + 7
        if (!lb.mine && taken.some(([a, b]) => x0 < b && x1 > a)) continue
        taken.push([x0, x1])
        ctx.globalAlpha = lb.mine ? 0.95 * a : 0.4 * a
        ctx.fillStyle = lb.mine ? `rgb(${GOLD})` : `rgb(${WARM})`
        ctx.fillText(lb.name, lb.cx, ly)
      }
      ps(x0, FLOOR); const hx0 = PX, hy = PY
      ps(x1, FLOOR); const hx1 = PX
      const pad = Math.min(0.006, (lane.u1 - lane.u0) * 0.1) * 2 * HW * sc
      ctx.strokeStyle = `rgb(${GOLD})`; ctx.lineWidth = 1
      ctx.font = `9px ${MONO}`; ctx.textBaseline = 'bottom'
      for (let hr = 0; hr <= 24; hr += 6) {
        const x = hx0 + pad + (hx1 - hx0 - 2 * pad) * hr / 24
        ctx.globalAlpha = 0.5 * a
        ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + 4); ctx.stroke()
        if (hx1 - hx0 > 150 && hr > 0 && hr < 24) { ctx.globalAlpha = 0.45 * a; ctx.fillStyle = `rgb(${GOLD})`; ctx.fillText(String(hr).padStart(2, '0'), x, hy - 2) }
      }
    }
    const it = focus.item
    if (!it) return
    ctx.globalCompositeOperation = 'lighter'
    if (it.type === 'mem') {
      // The focused book slides out of the shelf toward you.
      plane(z + 0.07)
      const x0 = it.x - BOOK_W * 0.6, x1 = it.x + BOOK_W * 0.6
      ctx.globalCompositeOperation = 'source-over'
      plane(z); ps(x0, FLOOR); const bax = PX, bay = PY; ps(x1, FLOOR + BOOK_H * 1.05); const bbx = PX, bby = PY
      plane(z + 0.07); ps(x0, FLOOR); const fax = PX, fay = PY; ps(x1, FLOOR + BOOK_H * 1.05); const fbx = PX, fby = PY
      ctx.globalAlpha = a
      ctx.fillStyle = '#8c7d63'
      ctx.beginPath(); ctx.moveTo(bax, bby); ctx.lineTo(bbx, bby); ctx.lineTo(fbx, fby); ctx.lineTo(fax, fby); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#b9a988'
      ctx.beginPath(); ctx.moveTo(bbx, bby); ctx.lineTo(bbx, bay); ctx.lineTo(fbx, fay); ctx.lineTo(fbx, fby); ctx.closePath(); ctx.fill()
      const fake = { ...it, x: it.x }
      plane(z + 0.07)
      const scF = F / P.od
      ctx.save()
      drawBookAt(fake, a, scF, x0, x1, BOOK_H * 1.05)
      ctx.restore()
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = `rgb(${WHITE})`; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9 * a
      ctx.strokeRect(fax - 2, fby - 2, fbx - fax + 4, fay - fby + 4)
      ctx.fillStyle = `rgb(${WHITE})`
      caret(fax + (fbx - fax) / 2, fby - 8, a)
    } else {
      plane(z)
      const tipY = top - (it.hang ?? 0.3) * day.h * 0.86
      ps(it.x, top); const x0 = PX, y0 = PY
      ps(it.x, tipY)
      const w = clamp(sc * 0.004, 1.2, 3)
      ctx.strokeStyle = `rgb(${WHITE})`
      ctx.globalAlpha = 0.25 * a; ctx.lineWidth = w * 5
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(PX, PY); ctx.stroke()
      ctx.globalAlpha = a; ctx.lineWidth = w
      ctx.stroke()
      ctx.fillStyle = `rgb(${WHITE})`
      ctx.beginPath(); ctx.arc(PX, PY, w * 1.8, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 0.35 * a
      ctx.beginPath(); ctx.arc(PX, PY, w * 5, 0, Math.PI * 2); ctx.fill()
      caret(x0, y0 - 6, a)
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawBookAt(it, a, sc, x0, x1, bh) {
    ps(x0, FLOOR); const ax = PX, ay = PY
    ps(x1, FLOOR + bh); const bx = PX, by = PY
    const w = Math.max(1, bx - ax), hgt = ay - by
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = a
    ctx.fillStyle = '#fff4dc'
    ctx.fillRect(ax, by, w, hgt)
    ctx.fillStyle = it.color
    ctx.fillRect(ax, by, w, Math.max(1, hgt * 0.16))
    if (hgt > 40 && w > 6) {
      ctx.translate(ax + w / 2, ay - hgt * 0.2)
      ctx.rotate(-Math.PI / 2)
      ctx.font = `${clamp(w * 0.6, 7, 11).toFixed(1)}px ${MONO}`
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillStyle = '#2a241b'
      ctx.beginPath(); ctx.rect(0, -w / 2, hgt * 0.64, w); ctx.clip()
      ctx.fillText(String(it.m.title ?? ''), 0, 0.5)
    }
  }

  function caret(x, y, a) {
    ctx.globalAlpha = 0.9 * a
    ctx.beginPath(); ctx.moveTo(x - 4, y - 5); ctx.lineTo(x + 4, y - 5); ctx.lineTo(x, y); ctx.closePath(); ctx.fill()
  }

  // ── About You: the window at the mouth of the corridor ───────────────────────────────────────────

  function layoutAboutBars() {
    // A model of the window's text for the canvas (bars) and for string anchors: two columns of lines.
    const rows = M.aboutLines
    const bars = [], ends = []
    if (!rows.length) { aboutBars = { bars, ends }; return }
    const colW = 0.44, x0s = [0.04, 0.53]
    const heights = rows.map((r) => Math.ceil(r.line.text.length / 62))
    const sections = []
    rows.forEach((r, i) => { if (!sections.length || sections[sections.length - 1].name !== r.line.section) sections.push({ name: r.line.section, rows: [] }); sections[sections.length - 1].rows.push(i) })
    const totalRows = heights.reduce((s, h) => s + h, 0) + sections.length * 1.6
    const rowH = Math.min(0.034, 0.8 / (totalRows / 2))
    let col = 0, v = 0.14
    for (const sec of sections) {
      const need = sec.rows.reduce((s, i) => s + heights[i], 0) * rowH + rowH * 1.6
      if (v + need > 0.95 && col === 0) { col = 1; v = 0.14 }
      bars.push({ u0: x0s[col], u1: x0s[col] + 0.12, v, head: true })
      v += rowH * 1.4
      for (const i of sec.rows) {
        const len = rows[i].line.text.length
        for (let r = 0; r < heights[i]; r++) {
          const frac = r < heights[i] - 1 ? 1 : ((len % 62) || 62) / 62
          bars.push({ u0: x0s[col], u1: x0s[col] + colW * frac, v, line: i })
          if (r === heights[i] - 1) ends[i] = { u: x0s[col] + colW * frac + 0.01, v }
          v += rowH
        }
      }
      v += rowH * 0.6
    }
    aboutBars = { bars, ends }
  }
  function aboutFrom(i) {
    // Where the line sits on the glass, from the panel's own layout when you stand at the window.
    const r = aboutRects?.[i]
    if (r && aboutOpacity > 0.5 && !arrival) {
      const d = camZ - ABOUT_Z
      return { x: cam.x + (r.x - OX) * d / F, y: cam.y - (r.y - OY) * d / F, z: ABOUT_Z }
    }
    return aboutPoint(i)
  }
  function aboutPoint(i) {
    const e = aboutBars?.ends[i] ?? { u: 0.5, v: 0.5 }
    return { x: -AHW + 2 * AHW * e.u, y: FLOOR + AH * (1 - e.v), z: ABOUT_Z }
  }

  function drawAbout(T) {
    const od = plane(ABOUT_Z)
    const a = arrival ? 0 : clamp((od - 0.28) / 0.45)
    const want = mode === 'about' && !arrival ? clamp(1 - Math.abs(cam.k - STATION) / 0.9) : 0
    setAboutOpacity(want)
    if (a < 0.01) return
    const sc = F / od
    ps(-AHW, FLOOR); const ax = PX, ay = PY
    ps(AHW, FLOOR + AH); const bx = PX, by = PY
    ctx.globalCompositeOperation = 'source-over'
    // Glass: a little darker than the corridor behind it.
    ctx.globalAlpha = a * 0.35
    ctx.fillStyle = '#050506'
    ctx.fillRect(ax, by, bx - ax, ay - by)
    ctx.strokeStyle = `rgb(${GOLD})`
    ctx.lineWidth = clamp(sc * 0.0025, 0.6, 2)
    ctx.globalAlpha = a * 0.55
    ctx.strokeRect(ax, by, bx - ax, ay - by)
    const inset = 0.028 * sc
    ctx.globalAlpha = a * 0.22
    ctx.strokeRect(ax + inset, by + inset, bx - ax - inset * 2, ay - by - inset * 2)
    // Corner joints.
    ctx.globalAlpha = a * 0.8
    const cl = 0.07 * sc
    ctx.beginPath()
    for (const [x, y, dx, dy] of [[ax, by, 1, 1], [bx, by, -1, 1], [ax, ay, 1, -1], [bx, ay, -1, -1]]) {
      ctx.moveTo(x + dx * cl, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * cl)
    }
    ctx.stroke()
    // Writing on the glass, seen from afar (the readable text is the DOM panel when you stand here).
    const textA = a * (1 - aboutOpacity)
    if (textA > 0.02 && aboutBars) {
      ctx.globalAlpha = textA * 0.5
      ctx.lineWidth = clamp(sc * 0.006, 0.6, 3)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.strokeStyle = `rgb(${WARM})`
      for (const b of aboutBars.bars) {
        if (b.head) continue
        ps(-AHW + 2 * AHW * b.u0, FLOOR + AH * (1 - b.v)); ctx.moveTo(PX, PY)
        ps(-AHW + 2 * AHW * b.u1, FLOOR + AH * (1 - b.v)); ctx.lineTo(PX, PY)
      }
      ctx.stroke()
      ctx.strokeStyle = `rgb(${GOLD})`
      ctx.globalAlpha = textA * 0.7
      ctx.beginPath()
      for (const b of aboutBars.bars) {
        if (!b.head) continue
        ps(-AHW + 2 * AHW * b.u0, FLOOR + AH * (1 - b.v)); ctx.moveTo(PX, PY)
        ps(-AHW + 2 * AHW * b.u1, FLOOR + AH * (1 - b.v)); ctx.lineTo(PX, PY)
      }
      ctx.stroke()
      ctx.lineCap = 'butt'
      const size = clamp(sc * 0.05, 0, 18)
      if (size > 6) {
        ctx.font = `${size.toFixed(1)}px ${MONO}`
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
        ctx.fillStyle = `rgb(${GOLD})`; ctx.globalAlpha = textA * 0.9
        ps(-AHW + 2 * AHW * 0.04, FLOOR + AH * (1 - 0.075))
        ctx.fillText('A B O U T   Y O U', PX, PY)
      }
    }
    // Along the sill: every day of the corridor as one horizon, the rhythm About You was built from.
    drawHorizon(a)
    // Threads from each belief back into the corridor, to the memories it stands on.
    drawBeliefThreads(T, a)
  }

  function drawHorizon(a) {
    const n = M.maxK
    if (n < 2) return
    const u0 = 0.035, u1 = 0.965, base = 0.955, amp = 0.085
    const at = (k, lift) => ps(-AHW + 2 * AHW * (u0 + (u1 - u0) * (1 - k / n)), FLOOR + AH * (1 - base) + AH * amp * lift)
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    at(n, 0); ctx.moveTo(PX, PY)
    for (let k = n; k >= 0; k--) { at(k, M.days[k].quiet ? 0 : 0.08 + 0.92 * M.days[k].bright); ctx.lineTo(PX, PY) }
    at(0, 0); ctx.lineTo(PX, PY); ctx.closePath()
    ctx.fillStyle = `rgb(${GOLD})`; ctx.globalAlpha = a * 0.07; ctx.fill()
    ctx.strokeStyle = `rgb(${GOLD})`; ctx.globalAlpha = a * 0.45; ctx.lineWidth = 1; ctx.stroke()
    // Months under the horizon, and a mark where you stand.
    ctx.globalCompositeOperation = 'source-over'
    at(0, 0); const size = clamp((F / PD) * 0.022, 0, 10)
    if (size >= 7) {
      ctx.font = `${size.toFixed(1)}px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.fillStyle = `rgb(${WARM})`; ctx.globalAlpha = a * 0.45
      for (const day of M.days) {
        if (day.dom !== 1 || day.k < n * 0.06) continue
        at(day.k, 0); ctx.fillRect(PX, PY, 1, 4); ctx.fillText(MON[day.month].toUpperCase(), PX + 3, PY + 2)
      }
      at(0, 0); ctx.textAlign = 'right'; ctx.fillStyle = `rgb(${GOLD})`; ctx.globalAlpha = a * 0.7
      ctx.fillText('TODAY', PX, PY + 2)
    }
  }

  function drawBeliefThreads(T, a) {
    if (!aboutBars || !M.aboutLines.length) return
    ctx.globalCompositeOperation = 'lighter'
    const useDom = aboutOpacity > 0.5 && aboutRects
    for (const row of M.aboutLines) {
      if (!row.cited.length) continue
      const sel = mode === 'about' && row.i === aboutSel
      let sx, sy
      if (useDom) { const r = aboutRects[row.i]; if (!r) continue; sx = r.x; sy = r.y } else {
        const p = aboutPoint(row.i)
        if (!p3(p.x, p.y, p.z)) continue
        sx = PX; sy = PY
      }
      for (const mem of row.cited) {
        const pt = anchorPoint(mem)
        if (!p3(pt.x, pt.y, zOf(mem.k, T))) continue
        const fog = Math.exp(-Math.max(0, mem.k - cam.k) / FOG)
        ctx.strokeStyle = sel ? `rgb(${GOLD})` : `rgb(${WARM})`
        ctx.globalAlpha = a * (sel ? 0.75 : mode === 'about' ? 0.09 : 0.05) * (0.4 + 0.6 * fog)
        ctx.lineWidth = sel ? 1.3 : 0.8
        const cx = lerp(sx, OX, 0.55), cy = lerp(sy, OY, 0.2)
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, PX, PY); ctx.stroke()
        if (sel) { ctx.globalAlpha = a * 0.9; ctx.fillStyle = `rgb(${GOLD})`; ctx.beginPath(); ctx.arc(PX, PY, 2.2, 0, Math.PI * 2); ctx.fill() }
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function buildAboutPanel() {
    const box = ui.about
    box.replaceChildren()
    const head = el('div', 'ah')
    head.append(el('h1', null, 'About you'))
    const intro = M.about?.intro || (M.about ? '' : 'About You has not been built yet.')
    if (intro) head.append(el('span', 'intro', intro))
    box.append(head)
    const scroll = el('div', 'scroll')
    const cols = el('div', 'cols')
    let sec = null, name = null
    for (const row of M.aboutLines) {
      if (row.line.section !== name) {
        name = row.line.section
        sec = el('div', 'sec')
        sec.append(el('h3', null, name || ''))
        cols.append(sec)
      }
      const line = el('div', 'line')
      line.dataset.i = String(row.i)
      line.append(el('span', 't', row.line.text))
      const cites = el('span', 'c')
      for (const mem of row.cited.slice(0, 6)) { const d = el('span', 'dot'); d.style.background = mem.color; cites.append(d) }
      if (row.asksRef) cites.append(el('span', null, ` ${row.asksRef >= 1000 ? (row.asksRef / 1000).toFixed(1) + 'k' : row.asksRef}`))
      line.append(cites)
      line.addEventListener('click', () => { aboutSel = row.i; markAboutSel(); kick() })
      line.addEventListener('dblclick', () => { aboutSel = row.i; openCard({ type: 'about', row }) })
      sec.append(line)
    }
    scroll.append(cols)
    scroll.addEventListener('scroll', () => { aboutRects = null; aboutBox = ''; kick() })
    box.append(scroll)
  }
  function markAboutSel() {
    for (const node of ui.about.querySelectorAll('.line')) node.classList.toggle('sel', Number(node.dataset.i) === aboutSel)
    const sel = ui.about.querySelector('.line.sel')
    if (sel) sel.scrollIntoView({ block: 'nearest' })
    aboutRects = null
    updateHud()
  }
  function setAboutOpacity(v) {
    if (Math.abs(v - aboutOpacity) < 0.01 && (v === 0 || aboutBox)) { if (v > 0) placeAbout(); return }
    aboutOpacity = v
    if (v <= 0.01) { if (!ui.about.hidden) { ui.about.hidden = true; aboutBox = '' } return }
    if (ui.about.hidden) { ui.about.hidden = false; markAboutSel() }
    ui.about.style.opacity = String(v)
    placeAbout()
  }
  function placeAbout() {
    plane(ABOUT_Z)
    ps(-AHW, FLOOR); const ax = PX, ay = PY
    ps(AHW, FLOOR + AH); const bx = PX, by = PY
    const box = `${Math.round(ax)},${Math.round(by)},${Math.round(bx - ax)},${Math.round(ay - by)}`
    if (box === aboutBox && aboutRects) return
    aboutBox = box
    const s = ui.about.style
    // The glass text stops above the sill, where the horizon of your days runs.
    s.left = `${Math.round(ax)}px`; s.top = `${Math.round(by)}px`; s.width = `${Math.round(bx - ax)}px`; s.height = `${Math.round((ay - by) * 0.855)}px`
    ui.about.classList.toggle('small', bx - ax < 900)
    ui.about.classList.toggle('narrow', bx - ax < 560)
    aboutRects = []
    const view = (ui.about.querySelector('.scroll') ?? ui.about).getBoundingClientRect()
    for (const node of ui.about.querySelectorAll('.line')) {
      const r = node.getBoundingClientRect()
      const t = node.querySelector('.c') ?? node
      const rc = t.getBoundingClientRect()
      const visible = r.bottom > view.top + 4 && r.top < view.bottom - 4
      aboutRects[Number(node.dataset.i)] = visible ? { x: rc.right + 3, y: rc.top + rc.height / 2 } : null
    }
  }

  // ── camera and the loop ───────────────────────────────────────────────────────────────────────────

  function flyTo(k) {
    const dist = Math.abs(k - cam.k)
    const chained = fly.active
    fly.from = cam.k; fly.to = k; fly.t0 = nowS(); fly.active = dist > 0.0005
    fly.dur = reduced ? 0 : clamp(0.24 + 0.2 * Math.log2(1 + dist), 0.24, 1.35)
    fly.ease = dist > 4 && !chained ? easeInOut : easeOut
    kick()
  }

  function step(T, dt) {
    let busy = false
    if (arrival) {
      const t = T - arrival.t0
      const p = easeInOut(clamp((t - 1.55) / 2.6))
      cam.k = lerp(-1.6, 0, p)
      const side = 1 - p
      cam.x = 1.0 * side; cam.y = 0.38 * side; cam.yaw = -0.46 * side; cam.pitch = -0.11 * side
      if (t >= arrival.dur) endArrival()
      busy = true
    } else {
      if (fly.active) {
        const p = fly.dur ? clamp((T - fly.t0) / fly.dur) : 1
        cam.k = lerp(fly.from, fly.to, fly.ease(p))
        if (p >= 1) fly.active = false
        busy = true
      }
      const tx = reduced ? 0 : mouse.x * 0.05, ty = reduced ? 0 : -mouse.y * 0.035
      const ex = tx - cam.x, ey = ty - cam.y
      if (Math.abs(ex) + Math.abs(ey) > 0.0003) { const f = 1 - Math.exp(-dt * 5); cam.x += ex * f; cam.y += ey * f; busy = true }
      cam.yaw = 0; cam.pitch = 0
    }
    speed = dt > 0 ? Math.abs(cam.k - prevK) / dt : 0
    prevK = cam.k
    camZ = -cam.k * S + D
    cY = Math.cos(cam.yaw); sY = Math.sin(cam.yaw); cP = Math.cos(cam.pitch); sP = Math.sin(cam.pitch)
    F = F0 * (reduced ? 1 : 1 - Math.min(0.13, speed / 900))
    if (speed > 0.01) busy = true
    if (pulled && !reduced) busy = true                         // the string keeps a faint shimmer
    if (pulled && !reduced && T - pulled.t0 < 0.4 + (M.maxK + 8) / WAVE) busy = true
    if (recallOn() && !reduced && T - recall.t0 < 3) busy = true
    return busy
  }

  function kick() { if (!raf && !document.hidden) raf = requestAnimationFrame(tick) }
  function tick(ts) {
    raf = 0
    const T = ts / 1000
    const dt = lastT ? Math.min(0.05, T - lastT) : 1 / 60
    lastT = T
    const busy = step(T, dt)
    render(T)
    if (busy) kick(); else lastT = 0
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastT = 0; kick() } })

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    vw = window.innerWidth; vh = window.innerHeight
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    OX = vw / 2; OY = vh * 0.47
    F0 = Math.min(0.6 * vw / (2 * HW), 0.54 * vh / 1.12) * D
    F = F0
    aboutBox = ''; aboutRects = null
    updateHint()
    kick()
  }
  window.addEventListener('resize', resize)

  // ── arrival ───────────────────────────────────────────────────────────────────────────────────────

  function startArrival() {
    if (reduced) { endArrival(); return }
    arrival = { t0: nowS(), dur: 4.4, stagger: Math.min(0.011, 1.5 / Math.max(1, M.maxK)) }
    document.body.classList.add('arriving')
    updateHint()
    kick()
  }
  function endArrival() {
    arrival = null
    cam.k = 0; cam.x = 0; cam.y = 0; cam.yaw = 0; cam.pitch = 0
    fly.active = false
    document.body.classList.remove('arriving')
    goDay(0, { instant: true })
    updateHint()
    kick()
  }

  // ── focus and travel ──────────────────────────────────────────────────────────────────────────────

  function pickItem(day) {
    let best = null, bd = Infinity
    for (const it of day.items) {
      const d = Math.abs(it.u - focus.u) + (it.lane === focus.lane ? 0 : 0.35)
      if (d < bd) { bd = d; best = it }
    }
    return best
  }
  function goDay(k, opts = {}) {
    if (!M) return
    k = clamp(Math.round(k), 0, M.maxK)
    if (mode !== 'corridor') mode = 'corridor'
    focus.k = k
    focus.item = opts.item !== undefined ? opts.item : pickItem(M.days[k])
    if (opts.item && opts.item.u != null) { focus.lane = opts.item.lane; focus.u = opts.item.u }
    if (opts.instant) { cam.k = k; fly.active = false } else flyTo(k)
    updateHud()
    kick()
  }
  function setFocus(it) {
    focus.item = it
    if (it) { focus.lane = it.lane; focus.u = it.u }
    updateHud(); kick()
  }
  function stepItem(dir) {
    const items = M.days[focus.k].items
    if (!items.length) return
    let i = focus.item ? items.indexOf(focus.item) : -1
    if (i < 0) {
      i = dir > 0 ? items.findIndex((it) => it.u >= focus.u) : findLast(items, (it) => it.u <= focus.u)
      if (i < 0) i = dir > 0 ? items.length - 1 : 0
    } else i = clamp(i + dir, 0, items.length - 1)
    setFocus(items[i])
  }
  function stepLane(dir) {
    const from = focus.item ? focus.item.lane : focus.lane
    const to = clamp(from + dir, 0, M.lanes.length - 1)
    const a = M.lanes[from], b = M.lanes[to]
    const rel = clamp((focus.u - a.u0) / Math.max(1e-6, a.u1 - a.u0))
    focus.lane = to
    focus.u = b.u0 + (b.u1 - b.u0) * rel
    const mine = M.days[focus.k].items.filter((it) => it.lane === to)
    let best = null, bd = Infinity
    for (const it of mine) { const d = Math.abs(it.u - focus.u); if (d < bd) { bd = d; best = it } }
    focus.item = best
    updateHud(); kick()
  }
  function findLast(list, fn) { for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return i; return -1 }

  function enterAbout() {
    if (!M) return
    mode = 'about'
    flyTo(STATION)
    updateHud(); kick()
  }

  function tabNext(dir) {
    if (recallOn() && recall.hits.length) return jumpHit(dir)
    if (pulled && pulled.order.length) return jumpLit(dir)
    if (mode === 'corridor') stepItem(dir)
  }
  function jumpLit(dir) {
    const order = pulled.order
    const here = mode === 'about' ? -1 : focus.k
    let k = dir > 0 ? order.find((x) => x > here) : findLastVal(order, (x) => x < here)
    if (k == null) k = dir > 0 ? order[0] : order[order.length - 1]
    goDay(k, { item: pulled.anchors.get(k) ?? null })
  }
  function findLastVal(list, fn) { for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return list[i]; return undefined }
  function jumpHit(dir) {
    const hits = recall.hits
    let i = hits.indexOf(focus.item)
    if (i < 0 || mode === 'about') {
      const here = mode === 'about' ? -1 : focus.k
      const tod = focus.item ? focus.item.tod : 1
      i = dir > 0 ? hits.findIndex((h) => h.k > here || (h.k === here && h.tod < tod)) : findLast(hits, (h) => h.k < here || (h.k === here && h.tod > tod))
      if (i < 0) i = dir > 0 ? 0 : hits.length - 1
    } else i = (i + dir + hits.length) % hits.length
    const h = hits[i]
    if (h.k !== focus.k || mode !== 'corridor') goDay(h.k, { item: h }); else setFocus(h)
  }

  function pull(source) {
    if (!source) return
    pulled = buildString(source)
    updateHud(); kick()
  }
  function release() { pulled = null; updateHud(); kick() }

  // ── recall ────────────────────────────────────────────────────────────────────────────────────────

  function setQuery(q) {
    recall.q = q
    recall.terms = queryTerms(q)
    recall.t0 = nowS()
    recall.origin = mode === 'about' ? 0 : focus.k
    clearExtras()
    recall.hits = []; recall.set = new Set(); recall.byDay = new Map(); recall.mems = 0
    if (recallOn() && recall.terms.length) {
      const terms = recall.terms
      for (const it of M.askItems) if (terms.every((t) => it.lower.includes(t))) recall.hits.push(it)
      for (const it of M.memItems) if (terms.every((t) => it.lower.includes(t))) { recall.hits.push(it); recall.mems++ }
      finishHits()
      clearTimeout(recall.timer)
      const seq = ++recall.seq
      recall.timer = setTimeout(() => remoteSearch(q, seq), 160)
    }
    updateHud(); kick()
  }
  function finishHits() {
    recall.hits.sort((a, b) => a.k - b.k || b.tod - a.tod)
    recall.set = new Set(recall.hits)
    recall.byDay = new Map()
    for (const it of recall.hits) recall.byDay.set(it.k, (recall.byDay.get(it.k) ?? 0) + 1)
  }
  async function remoteSearch(q, seq) {
    let hits = []
    try { hits = await MemoryData.search(q) } catch { return }
    if (seq !== recall.seq || q !== recall.q) return
    let added = 0
    for (const h of hits ?? []) {
      if (!h || !h.at) continue
      const known = M.byAskKey.get(`${h.sessionId}@${h.at}`)
      if (known) { if (!recall.set.has(known)) { recall.hits.push(known); added++ } continue }
      const k = M.kOf(h.at)
      if (k < 0 || k > M.maxK) continue
      const day = M.days[k]
      const lane = M.laneFor(M.laneOfCwd(h.cwd) ?? NONE)
      const tod = clamp((h.at - day.t) / DAY, 0, 0.9999)
      const item = { type: 'hit', h, k, lane, tod, color: M.agentOf(h.engine).color, hang: 0.55, extra: true }
      item.u = M.uOf(lane, tod); item.x = -HW + 2 * HW * item.u
      day.items.push(item); day.items.sort((a, b) => a.lane - b.lane || a.tod - b.tod)
      recall.extras.push(item); recall.hits.push(item); added++
    }
    if (added) { finishHits(); updateHud(); kick() }
  }
  function clearExtras() {
    if (!recall.extras.length) return
    const gone = new Set(recall.extras)
    const touched = new Set(recall.extras.map((it) => it.k))
    for (const k of touched) M.days[k].items = M.days[k].items.filter((it) => !gone.has(it))
    if (gone.has(focus.item)) focus.item = pickItem(M.days[focus.k])
    recall.extras = []
  }
  function closeRecall() {
    clearTimeout(recall.timer)
    recall.seq++
    recall.open = false
    setQuery('')
  }

  // ── the HUD ───────────────────────────────────────────────────────────────────────────────────────

  function fmtTime(t) { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  function fmtDate(t) { const d = new Date(t); return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}` }
  function ago(k) {
    if (k <= 0) return 'today'
    if (k === 1) return 'yesterday'
    if (k < 14) return `${k} days ago`
    if (k < 60) return `${Math.round(k / 7)} weeks ago`
    return `${Math.round(k / 30.4)} months ago`
  }
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    const wd = t.getUTCDay() || 7
    t.setUTCDate(t.getUTCDate() + 4 - wd)
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
    return Math.ceil(((t - y0) / DAY + 1) / 7)
  }
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  function itemTime(it) { return it.type === 'ask' ? it.a.at : it.type === 'mem' ? it.m.modified : it.h.at }
  function itemEngine(it) { return it.type === 'ask' ? it.a.engine : it.type === 'mem' ? it.m.agent : it.h.engine }
  function itemText(it) {
    if (it.type === 'ask') return oneLine(it.a.text)
    if (it.type === 'mem') return oneLine(`${it.m.title ?? ''}${it.m.description ? ' — ' + it.m.description : ''}`)
    return oneLine(String(it.h.snippet ?? ''))
  }

  // Text with recall terms underlined: plain text nodes and <mark> elements only.
  function appendMarked(node, text, terms) {
    if (!terms?.length) { node.append(document.createTextNode(text)); return }
    const lower = text.toLowerCase()
    let i = 0
    while (i < text.length) {
      let best = -1, len = 0
      for (const t of terms) { const j = lower.indexOf(t, i); if (j >= 0 && (best < 0 || j < best)) { best = j; len = t.length } }
      if (best < 0) { node.append(document.createTextNode(text.slice(i))); break }
      if (best > i) node.append(document.createTextNode(text.slice(i, best)))
      node.append(el('mark', null, text.slice(best, best + len)))
      i = best + len
    }
  }
  function appendSnippet(node, snippet) {
    const parts = String(snippet ?? '').replace(/\s+/g, ' ').split(/(\u0002[^\u0003]*\u0003)/)
    for (const p of parts) {
      if (p.startsWith('\u0002')) node.append(el('mark', null, p.slice(1, -1)))
      else if (p) node.append(document.createTextNode(p))
    }
  }

  function updateHud() {
    if (!M) return
    document.body.classList.toggle('reading', !!reading)
    ui.source.textContent = M.real ? 'your memories · this computer' : 'an invented person'
    if (mode === 'about') {
      ui.day.style.visibility = 'hidden'; ui.ticker.style.visibility = 'hidden'
      const row = M.aboutLines[aboutSel]
      ui.lane.replaceChildren()
      if (row) ui.lane.append(document.createTextNode(row.cited.length ? `cites ${plural(row.cited.length, 'memory', 'memories')}` : row.asksRef ? `from ${plural(row.asksRef, 'message')}` : ''))
      updateStatus(); updateHint()
      return
    }
    ui.day.style.visibility = ''; ui.ticker.style.visibility = ''
    const day = M.days[focus.k]
    ui.date.textContent = fmtDate(day.t)
    ui.ago.textContent = `${ago(day.k)} · week ${isoWeek(day.date)}`
    const parts = []
    const msgs = day.asks + day.ghostN
    parts.push(msgs ? plural(msgs, 'message') : 'no messages')
    if (day.mems) parts.push(`${plural(day.mems, 'memory', 'memories')} written`)
    ui.counts.textContent = parts.join(' · ')
    ui.chips.replaceChildren()
    const engines = {}
    for (const [e, n] of Object.entries(day.by)) engines[e] = (engines[e] ?? 0) + n
    for (const [e, n] of Object.entries(day.ghostBy)) engines[e] = (engines[e] ?? 0) + n
    for (const [e, n] of Object.entries(engines).sort((a, b) => b[1] - a[1])) {
      const ag = M.agentOf(e)
      const chip = el('span')
      const dot = el('span', 'dot'); dot.style.background = ag.color
      chip.append(dot, document.createTextNode(`${ag.name} ${n}`))
      ui.chips.append(chip)
    }
    let note = ''
    if (day.quiet) {
      const st = M.stretches.find((s) => day.k >= s.from && day.k <= s.to)
      note = st ? `a quiet stretch: ${st.n} days without a message` : day.dow === 0 || day.dow === 6 ? 'a quiet weekend day' : 'a quiet day'
    } else if (day.ghostN && !day.asks) note = `older than the messages loaded here; type to recall them`
    else if (day.ghostN) note = `${plural(day.ghostN, 'more message')} older than the loaded window`
    ui.daynote.textContent = note
    // Lane, top right.
    const laneI = focus.item ? focus.item.lane : focus.lane
    ui.lane.replaceChildren()
    const lane = M.lanes[laneI]
    if (lane) {
      ui.lane.append(document.createTextNode('lane '))
      ui.lane.append(el('b', null, lane.name))
      ui.lane.append(document.createTextNode(`  ${laneI + 1}/${M.lanes.length}`))
    }
    updateTicker(day)
    updateStatus()
    updateHint()
  }

  function updateTicker(day) {
    const box = ui.ticker
    box.replaceChildren()
    const items = day.items
    const terms = recallOn() ? recall.terms : null
    if (!items.length) {
      box.append(el('div', 'row quiet', day.ghostN ? `${plural(day.ghostN, 'message')} this day, older than the loaded window`
        : day.k === 0 ? 'nothing yet today' : day.quiet ? 'nothing was said this day' : ''))
      return
    }
    let i = focus.item ? items.indexOf(focus.item) : -1
    const center = i >= 0 ? i : Math.max(0, items.findIndex((it) => it.u >= focus.u))
    const rows = 5
    let from = Math.max(0, center - 2)
    from = Math.max(0, Math.min(from, items.length - rows))
    for (let j = from; j < Math.min(items.length, from + rows); j++) {
      const it = items[j]
      const row = el('div', `row${it.type === 'mem' ? ' mem' : ''}${j === i ? ' sel' : ''}${pulled && pulled.set.has(it) ? ' lit' : ''}`)
      row.append(el('span', 'time', fmtTime(itemTime(it))))
      const ag = M.agentOf(itemEngine(it))
      const who = el('span', 'who')
      const dot = el('span', 'dot'); dot.style.background = ag.color
      who.append(dot, document.createTextNode(ag.name))
      row.append(who)
      row.append(el('span', 'where', M.lanes[it.lane]?.name ?? ''))
      const text = el('span', 'text')
      if (it.type === 'hit') appendSnippet(text, it.h.snippet)
      else appendMarked(text, itemText(it), terms)
      row.append(text)
      row.addEventListener('click', () => setFocus(it))
      row.addEventListener('dblclick', () => openCard(it))
      box.append(row)
    }
  }

  function updateStatus() {
    const box = ui.status
    box.replaceChildren()
    if (recall.open || recall.q) {
      box.append(el('span', 'k', '› '))
      box.append(el('span', 'q', recall.q))
      if (recallOn()) {
        const days = recall.byDay.size
        const msgs = recall.hits.length - recall.mems
        const bits = []
        if (msgs) bits.push(plural(msgs, 'message'))
        if (recall.mems) bits.push(plural(recall.mems, 'memory', 'memories'))
        box.append(document.createTextNode(recall.hits.length ? `   ${bits.join(' · ')} on ${plural(days, 'day')}` : '   nothing comes back'))
        if (recall.hits.length) box.append(el('span', 'k', '   ⇥ next  ⇧⇥ back  esc clear'))
      } else box.append(el('span', 'k', '   keep typing'))
      return
    }
    if (pulled) {
      box.append(el('span', 'pulled', '◆ '))
      box.append(el('span', 'pulled', `“${pulled.label.length > 64 ? pulled.label.slice(0, 63) + '…' : pulled.label}”`))
      const n = pulled.order.length
      box.append(document.createTextNode(n > 1 ? `  came up on ${plural(n, 'day')}` : '  came up on no other day'))
      box.append(el('span', 'k', n > 1 ? '   ⇥ follow  ⇧⇥ back  esc let go' : '   esc let go'))
    }
  }

  function updateHint() {
    const box = ui.hint
    box.replaceChildren()
    const wide = vw >= 1180
    let keys
    if (arrival) keys = [['any key', 'skips']]
    else if (reading) keys = [['esc', 'back'], ['←→', 'neighbours'], ['↑↓', 'scroll'], ['␣', 'pull its string']]
    else if (mode === 'about') keys = [['↑↓', 'lines'], ['⏎', 'sources'], ['␣', 'pull string'], ['⇥', 'follow into time'], ['G', 'today']]
    else if (recall.open || recall.q) keys = [['type', 'recall'], ['⇥', 'next hit'], ['⏎', 'read'], ['↑↓', 'days'], ['esc', 'clear']]
    else if (wide) keys = [['↑↓', 'days'], ['⇧↑↓', 'weeks'], ['←→', 'messages'], ['⇧←→', 'lanes'], ['g G', 'start · today'], ['⏎', 'read'], ['␣', 'pull string'], ['⇥', 'next'], ['type', 'recall'], ['~', 'about you']]
    else keys = [['↑↓', 'days'], ['⇧', 'weeks'], ['←→ ⇧←→', 'msgs · lanes'], ['g G', ''], ['⏎', 'read'], ['␣', 'pull'], ['⇥', 'next'], ['type', 'recall'], ['~', 'you']]
    keys.forEach(([k, what], i) => {
      if (i) box.append(document.createTextNode('   '))
      box.append(el('b', null, k))
      if (what) box.append(document.createTextNode(` ${what}`))
    })
  }

  // ── the reading card ──────────────────────────────────────────────────────────────────────────────

  function openCard(it) {
    if (!it) return
    reading = it
    const box = ui.card
    box.replaceChildren()
    const kick_ = el('div', 'kick')
    const addAgent = (id) => {
      const ag = M.agentOf(id)
      const s = el('span'); const d = el('span', 'dot'); d.style.background = ag.color
      s.append(d, document.createTextNode(ag.name)); kick_.append(s)
    }
    if (it.type === 'about') {
      const row = it.row
      kick_.append(el('span', 'tag', 'About you'), el('span', null, row.line.section || ''))
      box.append(kick_)
      box.append(el('h2', null, row.line.text))
      const ul = el('ul')
      for (const mem of row.cited) {
        const li = el('li')
        const d = el('span', 'dot'); d.style.background = mem.color
        li.append(d, el('span', null, mem.m.title || mem.m.description || 'a memory'), el('span', 'when', `${M.agentOf(mem.m.agent).name} · ${ago(mem.k)}`))
        ul.append(li)
      }
      if (row.cited.length) { box.append(el('div', 'desc', `Held up by ${plural(row.cited.length, 'memory', 'memories')}:`)); box.append(ul) }
      if (row.asksRef) box.append(el('div', 'meta', `Drawn from ${row.asksRef.toLocaleString('en-US')} of your messages.`))
      if (row.sessionRef) box.append(el('div', 'meta', 'Drawn from a conversation.'))
      const foot = el('div', 'foot'); foot.append(el('b', null, '␣'), document.createTextNode(' pull its string through time   esc back'))
      box.append(foot)
    } else if (it.type === 'mem') {
      const m = it.m
      addAgent(m.agent)
      if (m.project?.name) kick_.append(el('span', null, m.project.name))
      kick_.append(el('span', null, m.type || m.kind || ''))
      kick_.append(el('span', null, `written ${fmtDate(m.modified)}, ${fmtTime(m.modified)} · ${ago(it.k)}`))
      box.append(kick_)
      box.append(el('h2', null, m.title || 'Untitled memory'))
      if (m.description && m.description !== m.title) box.append(el('div', 'desc', m.description))
      box.append(el('pre', 'body', String(m.body ?? '')))
      if (m.path) box.append(el('div', 'meta', m.path))
      const s = buildString(it)
      const foot = el('div', 'foot')
      foot.append(document.createTextNode(s.order.length > 1 ? `came up on ${plural(s.order.length, 'day')} · ` : ''), el('b', null, '␣'), document.createTextNode(' pull its string   ←→ neighbours   esc back'))
      box.append(foot)
    } else {
      const isAsk = it.type === 'ask'
      const src = isAsk ? it.a : it.h
      addAgent(src.engine)
      kick_.append(el('span', null, M.lanes[it.lane]?.name ?? ''))
      kick_.append(el('span', null, `${fmtDate(src.at)}, ${fmtTime(src.at)} · ${ago(it.k)}`))
      box.append(kick_)
      box.append(el('h2', null, src.title ? src.title : 'Untitled conversation'))
      const body = el('pre', 'body')
      if (isAsk) appendMarked(body, String(src.text ?? ''), recallOn() ? recall.terms : null)
      else appendSnippet(body, src.snippet)
      box.append(body)
      const meta = []
      if (isAsk && src.turn >= 0) meta.push(`message ${src.turn + 1} in this conversation`)
      if (isAsk && it.len > String(src.text ?? '').length) meta.push(`first ${String(src.text).length} of ${it.len.toLocaleString('en-US')} characters`)
      if (!isAsk) meta.push('found by recall; older than the messages loaded here')
      if (src.cwd) meta.push(src.cwd)
      if (meta.length) box.append(el('div', 'meta', meta.join(' · ')))
      const foot = el('div', 'foot')
      foot.append(el('b', null, '␣'), document.createTextNode(' pull its string   ←→ neighbours   esc back'))
      box.append(foot)
    }
    box.hidden = false
    box.scrollTop = 0
    updateHud(); kick()
  }
  function closeCard() { reading = null; ui.card.hidden = true; updateHud(); kick() }

  // ── keys ──────────────────────────────────────────────────────────────────────────────────────────

  function onKey(e) {
    if (!M) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key
    if (arrival) { e.preventDefault(); endArrival(); return }

    if (reading) {
      if (key === 'Escape' || key === 'Enter' || key === 'Backspace') { e.preventDefault(); closeCard(); return }
      if (key === ' ') { e.preventDefault(); const it = reading; closeCard(); pull(it); return }
      if (key === 'ArrowDown' || key === 'j') { e.preventDefault(); ui.card.scrollBy(0, 60); return }
      if (key === 'ArrowUp' || key === 'k') { e.preventDefault(); ui.card.scrollBy(0, -60); return }
      if ((key === 'ArrowLeft' || key === 'ArrowRight') && reading.type !== 'about') {
        e.preventDefault()
        stepItem(key === 'ArrowLeft' ? -1 : 1)
        if (focus.item) openCard(focus.item)
        return
      }
      if (key === 'Tab') { e.preventDefault(); return }
      return
    }

    const typing = recall.open || recall.q.length > 0
    if (key === 'Escape') {
      e.preventDefault()
      if (typing) closeRecall()
      else if (pulled) release()
      else if (mode === 'about') goDay(0)
      return
    }
    if (key === 'Tab') { e.preventDefault(); tabNext(e.shiftKey ? -1 : 1); return }

    if (mode === 'about' && !typing) {
      const n = M.aboutLines.length
      if (key === 'ArrowDown' || key === 'j') { e.preventDefault(); if (n) { aboutSel = Math.min(n - 1, aboutSel + 1); markAboutSel(); kick() } return }
      if (key === 'ArrowUp' || key === 'k') {
        e.preventDefault()
        if (aboutSel <= 0 || !n) goDay(0); else { aboutSel--; markAboutSel(); kick() }
        return
      }
      if (key === 'Enter') { e.preventDefault(); const row = M.aboutLines[aboutSel]; if (row) openCard({ type: 'about', row }); return }
      if (key === ' ') { e.preventDefault(); const row = M.aboutLines[aboutSel]; if (row) pull({ type: 'about', row }); return }
      if (key === 'G' || key === 'g' || key === '~') { e.preventDefault(); goDay(key === 'g' ? M.maxK : 0); return }
    }

    // Travel works while typing too.
    const big = e.shiftKey ? 7 : 1
    if (key === 'ArrowUp' || (!typing && (key === 'k' || key === 'K'))) {
      e.preventDefault()
      if (mode === 'about') { goDay(0); return }
      goDay(focus.k + (key === 'K' ? 7 : big)); return
    }
    if (key === 'ArrowDown' || (!typing && (key === 'j' || key === 'J'))) {
      e.preventDefault()
      if (mode === 'about') return
      if (focus.k === 0 && big === 1) { enterAbout(); return }
      goDay(focus.k - (key === 'J' ? 7 : big)); return
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault()
      if (mode === 'about') return
      const dir = key === 'ArrowLeft' ? -1 : 1
      if (e.shiftKey) stepLane(dir); else stepItem(dir)
      return
    }
    if (key === 'PageUp' || key === 'PageDown') { e.preventDefault(); goDay(focus.k + (key === 'PageUp' ? 7 : -7)); return }
    if (key === 'Home') { e.preventDefault(); goDay(M.maxK); return }
    if (key === 'End') { e.preventDefault(); goDay(0); return }
    if (key === 'Enter') { e.preventDefault(); if (mode === 'corridor' && focus.item) openCard(focus.item); return }

    if (!typing) {
      if (key === 'g') { e.preventDefault(); goDay(M.maxK); return }
      if (key === 'G') { e.preventDefault(); goDay(0); return }
      if (key === '~') { e.preventDefault(); enterAbout(); return }
      if (key === ' ') { e.preventDefault(); if (mode === 'corridor' && focus.item) pull(focus.item); return }
      if (key === '/') { e.preventDefault(); recall.open = true; setQuery(''); return }
    }
    if (key === 'Backspace') {
      e.preventDefault()
      if (!recall.q) { closeRecall(); return }
      setQuery(recall.q.slice(0, -1))
      return
    }
    if (key.length === 1 && key !== '\u0000') {
      if (!typing && key === ' ') return
      e.preventDefault()
      recall.open = true
      if (recall.q.length < 80) setQuery(recall.q + key)
    }
  }
  window.addEventListener('keydown', onKey)

  // ── pointer: optional, for the curious ───────────────────────────────────────────────────────────

  window.addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / Math.max(1, vw)) * 2 - 1
    mouse.y = (e.clientY / Math.max(1, vh)) * 2 - 1
    kick()
  })
  window.addEventListener('wheel', (e) => {
    if (!M || arrival || reading) return
    if (e.target.closest && (e.target.closest('#about') || e.target.closest('#card'))) return
    e.preventDefault()
    wheelAcc += e.deltaY
    const steps = Math.trunc(wheelAcc / 60)
    if (!steps) return
    wheelAcc -= steps * 60
    if (mode === 'about') { if (steps > 0) goDay(0); return }
    if (focus.k + steps < 0) { enterAbout(); return }
    goDay(focus.k + steps)
  }, { passive: false })
  canvas.addEventListener('click', (e) => {
    if (!M || arrival || reading || mode !== 'corridor') return
    const it = pickAt(e.clientX, e.clientY)
    if (it) { if (it.k !== focus.k) goDay(it.k, { item: it }); else setFocus(it) }
  })
  canvas.addEventListener('dblclick', (e) => {
    if (!M || arrival || reading || mode !== 'corridor') return
    const it = pickAt(e.clientX, e.clientY)
    if (it) openCard(it)
  })
  function pickAt(x, y) {
    const T = nowS()
    let best = null, bd = 9
    for (let k = focus.k; k <= Math.min(M.maxK, focus.k + 3); k++) {
      const day = M.days[k]
      if (plane(zOf(k, T)) < NEAR * 2) continue
      const top = FLOOR + day.h
      for (const it of day.items) {
        if (it.type === 'mem') {
          ps(it.x, FLOOR + BOOK_H / 2)
          const d = Math.hypot(PX - x, (PY - y) * 0.4)
          if (d < bd) { bd = d; best = it }
          continue
        }
        ps(it.x, top); const y0 = PY, x0 = PX
        ps(it.x, top - (it.hang ?? 0.3) * day.h * 0.86)
        if (y < y0 - 3 || y > PY + 3) continue
        const d = Math.abs(x0 - x)
        if (d < bd) { bd = d; best = it }
      }
      if (best) break
    }
    return best
  }

  // ── start ─────────────────────────────────────────────────────────────────────────────────────────

  window.__tesseract = {
    state: () => ({ mode, k: focus.k, item: focus.item ? focus.item.type : null, lane: focus.item ? M.lanes[focus.item.lane].name : M?.lanes[focus.lane]?.name,
      pulled: pulled ? { label: pulled.label, days: pulled.order.length } : null, hits: recall.hits.length, hitDays: recall.byDay.size, q: recall.q,
      reading: reading ? reading.type : null, arrival: !!arrival, maxK: M?.maxK, lanes: M?.lanes.length, camK: cam.k }),
    perf: () => ({ frames: perf.frames, avg: perf.frames ? perf.ms / perf.frames : 0, worst: perf.worst }),
    resetPerf: () => { perf.frames = 0; perf.ms = 0; perf.worst = 0 },
  }

  resize()
  MemoryData.load().then((loaded) => {
    M = build(loaded)
    focus.lane = Math.max(0, M.lanes.findIndex((l) => l.name !== NONE))
    layoutAboutBars()
    buildAboutPanel()
    ui.load.remove()
    updateHud()
    startArrival()
    canvas.focus({ preventScroll: true })
  }).catch((error) => {
    ui.load.textContent = `Could not read memories: ${String(error?.message ?? error)}`
  })
})()
