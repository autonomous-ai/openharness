// Approach: the desk as an approach radar. You are the field at the centre; every task you handed off is a
// flight. ⌘B is the departure; working tasks fly their machine's sector; a task that needs you holds at
// its fix near the field, flashing; finished ones line up on final, waiting for you to land them (read
// them); a failed one squawks an emergency. The nearer the centre, the more it needs you.
(function () {
  'use strict'
  const B = window.BossData
  const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace'
  const C = { green: '#6fdc9c', amber: '#ffb547', red: '#ff5a4f', ice: '#bfe8ff', grey: '#5d6b64', white: '#eef7f1', dim: '#2f6b4c', ring: '#14271d', text: '#cfe9da', muted: '#7c9a8a', faint: '#44594d' }
  const KIND = {
    hold: { code: 'HLD', color: C.amber, label: 'HOLDING', note: 'asking you' },
    em: { code: 'EM', color: C.red, label: 'EMERGENCY', note: 'failed or went nowhere' },
    fin: { code: 'FNL', color: C.ice, label: 'ON FINAL', note: 'finished, not read' },
    enr: { code: 'WRK', color: C.green, label: 'EN ROUTE', note: 'working' },
    dep: { code: 'HO', color: C.white, label: 'DEPARTING', note: 'just handed off' },
    cst: { code: 'CST', color: C.grey, label: 'COASTING', note: 'machine out of reach' },
    gnd: { code: 'GND', color: '#4c6357', label: 'ON THE GROUND', note: 'read, stopped or answered' },
  }
  const ORDER = ['hold', 'em', 'fin', 'dep', 'enr', 'cst', 'gnd']
  const FINAL_BEARING = Math.PI * 1.25 // 225°: the runway's final approach course runs out to the south-west
  const SCAN_MS = 4200
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  const canvas = document.getElementById('radar')
  const ctx = canvas.getContext('2d')
  const $ = (id) => document.getElementById(id)
  let desk = null
  let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, R = 100
  let sel = null
  let query = null, typing = false
  let trails = true
  let sweep = 0, lastFrame = performance.now()
  const tracks = new Map() // dispatch id → { shown, trail, lit, seeded }
  const prims = new Map() // harness id → the same, for harnesses ⌘B did not send to
  const landings = new Map() // dispatch id → { from, at }
  let lastLanded = []
  let toastTimer = 0
  let ladder = -Infinity

  // ── what each dispatch is on the scope ──────────────────────────────────────────────────────────────

  function kindOf(d, now) {
    if (d.state === 'routing') return 'dep'
    if (d.state === 'asking') return 'hold'
    if (d.state === 'failed' || d.state === 'undelivered') return 'em'
    if (d.state === 'done') return d.seenAt ? 'gnd' : 'fin'
    if (d.state === 'offline') return 'cst'
    if (d.state === 'working') return d.landedAt && now - d.landedAt < 5000 ? 'dep' : 'enr'
    return 'gnd'
  }
  const callsign = (d) => d.harness ? `${B.engine(B.harness(d.harness)?.engine).call}${d.n}` : `BOSS${d.n}`
  const proj = (d) => { const p = (B.harness(d.harness)?.project ?? 'no route').toUpperCase(); return p.length > 11 ? p.slice(0, 10) + '…' : p }
  function hash(text) { let h = 2166136261; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) } return ((h >>> 0) % 10007) / 10007 }
  const matches = (d) => {
    if (!query) return true
    const h = B.harness(d.harness)
    const hay = `${callsign(d)} ${d.text} ${h?.name ?? ''} ${h?.project ?? ''} ${d.machine ?? ''} ${d.question ?? ''} ${d.summary ?? ''}`.toLowerCase()
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
  }

  // ── geometry ────────────────────────────────────────────────────────────────────────────────────────

  const at = (bearing, r) => ({ x: cx + Math.sin(bearing) * r, y: cy - Math.cos(bearing) * r })
  const bearingOf = (p) => { let b = Math.atan2(p.x - cx, -(p.y - cy)); return b < 0 ? b + Math.PI * 2 : b }

  let sectors = []
  function layoutSectors() {
    const ms = [...desk.machines].sort((a, b) => (b.here - a.here) || (b.online - a.online))
    const weight = ms.map((m) => 2 + desk.dispatches.filter((d) => d.machine === m.id && kindOf(d, desk.now) !== 'gnd').length + 0.5 * desk.harnesses.filter((h) => h.machine === m.id && !h.boss).length)
    const total = weight.reduce((a, b) => a + b, 0)
    let b0 = -0.35
    sectors = ms.map((m, i) => {
      const span = (weight[i] / total) * Math.PI * 2
      const s = { machine: m, b0, b1: b0 + span, mid: b0 + span / 2 }
      b0 += span
      // The holding fix sits mid-sector, but never on the final approach course.
      let fix = s.mid
      const off = Math.atan2(Math.sin(fix - FINAL_BEARING), Math.cos(fix - FINAL_BEARING))
      if (Math.abs(off) < 0.42) fix = FINAL_BEARING + Math.sign(off || 1) * 0.42
      s.fix = fix
      return s
    })
  }
  const sectorOf = (machineId) => sectors.find((s) => s.machine.id === machineId) ?? sectors[0]

  function activity(h, now) {
    if (!h) return 0
    let n = 0
    for (let i = h.turns.length - 1; i >= 0 && now - h.turns[i].at < 12 * B.MIN; i--) n++
    return Math.min(1, n / 10)
  }

  /** Where a flight truly is at time t: what the sweep paints when it passes. */
  function truePos(d, kind, t, rank) {
    const h = B.harness(d.harness)
    const s = sectorOf(d.machine)
    if (kind === 'hold') {
      const fix = at(s.fix, 0.3 * R)
      const u = { x: Math.sin(s.fix), y: -Math.cos(s.fix) }, v = { x: -u.y, y: u.x }
      const L = 0.075 * R, rr = 0.026 * R
      const per = 2 * L + 2 * Math.PI * rr
      const phase = (((t / 26000) + rank.i / Math.max(1, rank.n)) % 1) * per
      let a, b
      if (phase < L) { a = -L / 2 + phase; b = rr }
      else if (phase < L + Math.PI * rr) { const th = (phase - L) / rr; a = L / 2 + Math.sin(th) * rr; b = Math.cos(th) * rr }
      else if (phase < 2 * L + Math.PI * rr) { a = L / 2 - (phase - L - Math.PI * rr); b = -rr }
      else { const th = (phase - 2 * L - Math.PI * rr) / rr; a = -L / 2 - Math.sin(th) * rr; b = -Math.cos(th) * rr }
      return { x: fix.x + u.x * a + v.x * b, y: fix.y + u.y * a + v.y * b }
    }
    if (kind === 'fin') return at(FINAL_BEARING, (0.1 + Math.min(0.05, 0.36 / Math.max(1, rank.n)) * rank.i) * R)
    if (kind === 'em') {
      if (d.state === 'undelivered') return at(Math.PI * 0.25 + 0.18 * rank.i, 0.075 * R)
      const c = at(s.mid + 0.32, 0.19 * R)
      const th = t / 5200 + rank.i * 2
      return { x: c.x + Math.cos(th) * 0.014 * R, y: c.y + Math.sin(th) * 0.014 * R }
    }
    // En route, departing and coasting: a place in the machine's sector, further out the longer it has run.
    const span = s.b1 - s.b0
    const age = Math.max(1, (t - (d.landedAt ?? d.at)) / B.MIN)
    const a = Math.min(1, Math.log10(age + 1) / Math.log10(16 * 60))
    const base = { b: s.b0 + span * (0.14 + 0.72 * hash(d.id + (h?.id ?? ''))), r: (0.5 + 0.42 * a) * R }
    const go = kind === 'cst' ? 0 : 0.25 + activity(h, t)
    const ph = hash(d.id) * 6.28
    const pos = at(base.b + 0.05 * Math.sin(t / 21000 * go + ph) * Math.min(1, span), base.r + 0.03 * R * Math.cos(t / 17000 * go + ph))
    if (kind === 'dep') {
      const k = d.landedAt ? Math.min(1, (t - d.landedAt) / 5000) : 0
      const e = 1 - Math.pow(1 - k, 3)
      return { x: cx + (pos.x - cx) * (0.04 + 0.96 * e), y: cy + (pos.y - cy) * (0.04 + 0.96 * e) }
    }
    return pos
  }

  function primPos(h, t) {
    const s = sectorOf(h.machine)
    const span = s.b1 - s.b0
    const working = h.state === 'working'
    const r = (working ? 0.62 + 0.3 * hash(h.id + 'r') : 0.9 + 0.06 * hash(h.id + 'r')) * R
    return at(s.b0 + span * (0.08 + 0.84 * hash(h.id)) + (working ? 0.04 * Math.sin(t / 19000 + hash(h.id) * 6) : 0), r)
  }

  // ── the flights on the scope now, and the strips in the bay ────────────────────────────────────────

  function flights(now) {
    const out = desk.dispatches.map((d) => ({ d, kind: kindOf(d, now) }))
    const rankIn = (pred, sort) => { const list = out.filter(pred).sort(sort); list.forEach((f, i) => { f.rank = { i, n: list.length } }) }
    for (const s of sectors) rankIn((f) => f.kind === 'hold' && f.d.machine === s.machine.id, (a, b) => a.d.since - b.d.since)
    rankIn((f) => f.kind === 'fin', (a, b) => a.d.since - b.d.since)
    rankIn((f) => f.kind === 'em' && f.d.state === 'undelivered', (a, b) => a.d.at - b.d.at)
    for (const s of sectors) rankIn((f) => f.kind === 'em' && f.d.state === 'failed' && f.d.machine === s.machine.id, (a, b) => a.d.at - b.d.at)
    for (const f of out) f.rank ??= { i: 0, n: 1 }
    return out
  }
  function stripOrder(list) {
    return [...list].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
      || (a.kind === 'fin' ? a.d.since - b.d.since : a.kind === 'hold' ? a.d.since - b.d.since : b.d.at - a.d.at))
  }

  // ── drawing ─────────────────────────────────────────────────────────────────────────────────────────

  function resize() {
    const box = $('scope').getBoundingClientRect()
    DPR = Math.min(2, window.devicePixelRatio || 1)
    W = box.width; H = box.height
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    cx = W / 2; cy = H / 2 + 14
    R = Math.max(80, Math.min(W / 2 - 34, (H - 120) / 2))
    tracks.clear(); prims.clear()
  }

  function scope(now) {
    ctx.save()
    ctx.fillStyle = '#010302'; ctx.fillRect(0, 0, W, H)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.04)
    g.addColorStop(0, '#06160e'); g.addColorStop(0.7, '#03100a'); g.addColorStop(1, '#020805')
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2); ctx.fill()
    // Closed sectors: a machine that is asleep.
    for (const s of sectors) {
      if (s.machine.online) continue
      ctx.save(); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, s.b0 - Math.PI / 2, s.b1 - Math.PI / 2); ctx.closePath(); ctx.clip()
      ctx.strokeStyle = 'rgba(93,107,100,.07)'; ctx.lineWidth = 1
      for (let k = -R * 2; k < R * 2; k += 9) { ctx.beginPath(); ctx.moveTo(cx + k, cy - R); ctx.lineTo(cx + k + R * 2, cy + R); ctx.stroke() }
      ctx.restore()
    }
    // Range rings, and what each band means.
    ctx.lineWidth = 1
    for (const [k, word] of [[0.24, 'NEEDS YOU'], [0.47, 'FINAL'], [0.72, ''], [1, 'ON ITS OWN']]) {
      ctx.strokeStyle = k === 1 ? '#1f3a2c' : C.ring
      ctx.setLineDash(k === 0.72 ? [2, 6] : [])
      ctx.beginPath(); ctx.arc(cx, cy, k * R, 0, Math.PI * 2); ctx.stroke()
      if (word) {
        ctx.setLineDash([]); ctx.font = `10px ${MONO}`; ctx.fillStyle = '#2b4637'; ctx.textAlign = 'center'
        const p = at(Math.PI * 0.79, k * R - 7)
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-Math.PI * 0.21); ctx.fillText(spaced(word), 0, 0); ctx.restore()
      }
    }
    ctx.setLineDash([])
    // Compass rose on the rim.
    for (let deg = 0; deg < 360; deg += 5) {
      const b = deg * Math.PI / 180
      const len = deg % 30 === 0 ? 10 : deg % 10 === 0 ? 6 : 3
      const a = at(b, R), c = at(b, R - len)
      ctx.strokeStyle = deg % 30 === 0 ? '#2d4b3b' : '#1a2e24'
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke()
      if (deg % 30 === 0) {
        const p = at(b, R + 12); ctx.fillStyle = '#2e4a3b'; ctx.font = `9.5px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(String(deg).padStart(3, '0'), p.x, p.y)
      }
    }
    // Sector boundaries and names.
    for (const s of sectors) {
      const a = at(s.b0, 0.25 * R), c = at(s.b0, R)
      ctx.strokeStyle = '#1d3428'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.setLineDash([])
      const p = at(s.mid, R * 0.93)
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = `600 11px ${MONO}`; ctx.fillStyle = s.machine.online ? '#4f7d64' : '#3a4a42'
      ctx.fillText(spaced(s.machine.name.toUpperCase()), p.x, p.y)
      ctx.font = `9.5px ${MONO}`; ctx.fillStyle = '#2f4a3c'
      const sub = s.machine.online ? `${s.machine.here ? 'this computer · ' : ''}${s.machine.os}` : `closed · asleep since ${B.clock(s.machine.since)}`
      ctx.fillText(sub, p.x, p.y + 14)
      // The holding fix.
      const f = at(s.fix, 0.3 * R)
      ctx.strokeStyle = s.machine.online ? '#3b5f4b' : '#2a3a32'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(f.x, f.y - 5); ctx.lineTo(f.x + 4.5, f.y + 3); ctx.lineTo(f.x - 4.5, f.y + 3); ctx.closePath(); ctx.stroke()
      ctx.font = `9px ${MONO}`; ctx.fillStyle = '#35574a'; ctx.textAlign = 'left'
      ctx.fillText(fixName(s.machine.name), f.x + 7, f.y + 10)
      // Its holding pattern, drawn when someone is in it.
      if (desk.dispatches.some((d) => d.state === 'asking' && d.machine === s.machine.id)) {
        const u = { x: Math.sin(s.fix), y: -Math.cos(s.fix) }, v = { x: -u.y, y: u.x }
        const L = 0.075 * R, rr = 0.026 * R
        ctx.save(); ctx.translate(f.x, f.y); ctx.transform(u.x, u.y, v.x, v.y, 0, 0)
        ctx.strokeStyle = 'rgba(255,181,71,.22)'; ctx.setLineDash([3, 4])
        ctx.beginPath(); ctx.moveTo(-L / 2, rr); ctx.lineTo(L / 2, rr); ctx.arc(L / 2, 0, rr, Math.PI / 2, -Math.PI / 2, true); ctx.lineTo(-L / 2, -rr); ctx.arc(-L / 2, 0, rr, -Math.PI / 2, Math.PI / 2, true); ctx.stroke()
        ctx.restore()
      }
    }
    // The field: you, a runway and its final approach course.
    const thr = at(FINAL_BEARING, 0.03 * R), end = at(FINAL_BEARING + Math.PI, 0.03 * R)
    ctx.strokeStyle = '#7aa58c'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(thr.x, thr.y); ctx.lineTo(end.x, end.y); ctx.stroke()
    ctx.lineWidth = 1
    const fEnd = at(FINAL_BEARING, 0.47 * R)
    ctx.strokeStyle = 'rgba(191,232,255,.16)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(thr.x, thr.y); ctx.lineTo(fEnd.x, fEnd.y); ctx.stroke(); ctx.setLineDash([])
    for (let k = 1; k <= 8; k++) {
      const p = at(FINAL_BEARING, (0.03 + k * 0.055) * R), q = { x: Math.cos(FINAL_BEARING) * 4, y: Math.sin(FINAL_BEARING) * 4 }
      ctx.strokeStyle = 'rgba(191,232,255,.14)'; ctx.beginPath(); ctx.moveTo(p.x - q.x, p.y - q.y); ctx.lineTo(p.x + q.x, p.y + q.y); ctx.stroke()
    }
    // You. When something holds for you, the field glows.
    const holding = desk.dispatches.some((d) => d.state === 'asking')
    if (holding && !reduced) {
      const k = (now % 2400) / 2400
      ctx.strokeStyle = `rgba(255,181,71,${0.45 * (1 - k)})`; ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.arc(cx, cy, 0.02 * R + k * 0.2 * R, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1
    }
    ctx.font = `600 10px ${MONO}`; ctx.fillStyle = holding ? '#ffd08a' : '#9cc5ad'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('YOU', cx + 0.06 * R, cy + 0.05 * R)
    ctx.restore()
  }
  const spaced = (text) => text.split('').join(' ')
  const fixName = (name) => { const v = name.toUpperCase().replace(/[^A-Z]/g, ''); const c = v[0] + v.slice(1).replace(/[AEIOU]/g, ''); return (c + v).slice(0, 5) }

  function sweepArm(now) {
    if (reduced) return
    ctx.save()
    const grad = ctx.createConicGradient(sweep - Math.PI / 2 - 1.3, cx, cy)
    grad.addColorStop(0, 'rgba(111,220,156,0)')
    grad.addColorStop(0.16, 'rgba(111,220,156,0.018)')
    grad.addColorStop(0.2068, 'rgba(111,220,156,0.075)')
    grad.addColorStop(0.2070, 'rgba(111,220,156,0)')
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, sweep - Math.PI / 2 - 1.3, sweep - Math.PI / 2); ctx.closePath(); ctx.fill()
    const tip = at(sweep, R)
    ctx.strokeStyle = 'rgba(140,240,180,.38)'; ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tip.x, tip.y); ctx.stroke()
    ctx.restore()
  }

  /** The sweep paints a target as it passes: the shown position jumps, the old one stays as a history dot. */
  function paint(track, p, prev, now) {
    if (!track.shown || reduced) { track.shown = p; track.lit = reduced ? 0.85 : 1; return }
    const b = bearingOf(p)
    const crossed = prev <= sweep ? (b > prev && b <= sweep) : (b > prev || b <= sweep)
    if (crossed) {
      if (Math.hypot(track.shown.x - p.x, track.shown.y - p.y) > 0.6) { track.trail.push(track.shown); if (track.trail.length > 6) track.trail.shift() }
      track.shown = p; track.lit = 1
    } else track.lit = Math.max(0.42, track.lit - 0.0045)
  }

  function seed(track, d, kind, now, rank) {
    // A flight that was already flying has a history: lay its last scans down as dots.
    if (track.seeded || reduced) return
    track.seeded = true
    for (let k = 5; k >= 1; k--) {
      const t = now - k * SCAN_MS
      if (d.landedAt && t < d.landedAt + 5000 && kind !== 'hold') continue
      track.trail.push(truePos(d, kind, t, rank))
    }
  }

  const blink = (now, hz = 1) => Math.floor(now / (500 / hz)) % 2 === 0

  function targets(now, list, prevSweep) {
    const placed = []
    const blocks = []
    // Primaries: harnesses ⌘B never sent to — on the desk, not in the book.
    for (const h of desk.harnesses) {
      if (h.boss || h.state === 'stopped') continue
      const tr = prims.get(h.id) ?? { trail: [], lit: 0 }
      prims.set(h.id, tr)
      const p = primPos(h, now)
      paint(tr, p, prevSweep, now)
      const s = tr.shown
      ctx.strokeStyle = h.state === 'working' ? `rgba(111,220,156,${0.28 + 0.3 * tr.lit})` : 'rgba(93,107,100,.35)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(s.x - 3, s.y); ctx.lineTo(s.x + 3, s.y); ctx.moveTo(s.x, s.y - 3); ctx.lineTo(s.x, s.y + 3); ctx.stroke()
      if (h.state === 'working') {
        ctx.font = `9.5px ${MONO}`; ctx.fillStyle = 'rgba(111,220,156,.34)'; ctx.textBaseline = 'middle'
        const label = h.name.toLowerCase(), right = s.x + 6 + ctx.measureText(label).width < W - 8
        ctx.textAlign = right ? 'left' : 'right'; ctx.fillText(label, right ? s.x + 6 : s.x - 6, s.y)
      }
    }
    for (const f of list) {
      const { d, kind } = f
      if (kind === 'gnd' && !landings.has(d.id)) continue
      let tr = tracks.get(d.id)
      if (!tr || tr.kind !== kind) { tr = { trail: tr?.kind === kind ? tr.trail : [], lit: 1, kind, shown: tr?.shown }; tracks.set(d.id, tr) }
      const landing = landings.get(d.id)
      let p
      if (landing) {
        const k = Math.min(1, (now - landing.at) / 1700)
        if (k >= 1) { landings.delete(d.id); continue }
        const thr = at(FINAL_BEARING, 0.03 * R), end = at(FINAL_BEARING + Math.PI, 0.03 * R)
        p = k < 0.6 ? lerp(landing.from, thr, ease(k / 0.6)) : lerp(thr, end, ease((k - 0.6) / 0.4))
        tr.shown = p; tr.lit = 1 - k * 0.6
      } else {
        seed(tr, d, kind, now, f.rank)
        p = truePos(d, kind, now, f.rank)
        if (kind === 'dep' || kind === 'hold') { tr.shown = p; tr.lit = 1 } else paint(tr, p, prevSweep, now)
      }
      const s = tr.shown
      const k = landing ? KIND.fin : KIND[kind]
      const on = matches(d)
      const alpha = on ? 1 : 0.16
      const flashing = kind === 'hold' && !blink(now, 0.9)
      // History trail.
      if (trails && !landing) tr.trail.forEach((q, i) => { ctx.fillStyle = hexa(k.color, alpha * (0.1 + 0.36 * (i + 1) / tr.trail.length)); ctx.beginPath(); ctx.arc(q.x, q.y, 1.5, 0, Math.PI * 2); ctx.fill() })
      // The target symbol.
      ctx.save(); ctx.globalAlpha = alpha
      ctx.shadowColor = k.color; ctx.shadowBlur = reduced ? 0 : 10 * tr.lit
      ctx.fillStyle = hexa(k.color, 0.45 + 0.55 * tr.lit); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.4
      if (kind === 'hold') { ctx.beginPath(); ctx.moveTo(s.x, s.y - 5); ctx.lineTo(s.x + 5, s.y); ctx.lineTo(s.x, s.y + 5); ctx.lineTo(s.x - 5, s.y); ctx.closePath(); flashing ? ctx.stroke() : ctx.fill() }
      else if (kind === 'em') { ctx.beginPath(); ctx.arc(s.x, s.y, 5.5, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(s.x - 3, s.y - 3); ctx.lineTo(s.x + 3, s.y + 3); ctx.moveTo(s.x + 3, s.y - 3); ctx.lineTo(s.x - 3, s.y + 3); ctx.stroke() }
      else if (kind === 'fin' || landing) { const dir = FINAL_BEARING + Math.PI; const a = at(0, 0); ctx.beginPath(); ctx.moveTo(s.x + Math.sin(dir) * 6, s.y - Math.cos(dir) * 6); ctx.lineTo(s.x + Math.sin(dir + 2.4) * 4.5, s.y - Math.cos(dir + 2.4) * 4.5); ctx.lineTo(s.x + Math.sin(dir - 2.4) * 4.5, s.y - Math.cos(dir - 2.4) * 4.5); ctx.closePath(); ctx.fill(); void a }
      else if (kind === 'cst') { ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7) }
      else if (kind === 'dep') { ctx.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? 2.2 : 5.5, th = i * Math.PI / 4; ctx.lineTo(s.x + Math.cos(th) * r, s.y + Math.sin(th) * r) } ctx.closePath(); ctx.fill() }
      else { ctx.beginPath(); ctx.arc(s.x, s.y, 3.4, 0, Math.PI * 2); ctx.fill() }
      ctx.restore()
      placed.push({ x: s.x - 7, y: s.y - 7, w: 14, h: 14 })
      if (!landing) blocks.push({ f, s, k, alpha, flashing, tr })
    }
    // Data blocks, most urgent placed first so they win the clear spots.
    blocks.sort((a, b) => (b.f.d.id === sel) - (a.f.d.id === sel) || ORDER.indexOf(a.f.kind) - ORDER.indexOf(b.f.kind) || a.f.rank.i - b.f.rank.i)
    ladder = -Infinity
    for (const b of blocks) dataBlock(b, now, placed)
    // The selected flight: brackets, and its line home.
    const chosen = blocks.find((b) => b.f.d.id === sel)
    if (chosen) {
      const s = chosen.s, c = chosen.k.color
      ctx.strokeStyle = c; ctx.lineWidth = 1.2
      const r = 11, q = 4
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.moveTo(s.x + sx * r, s.y + sy * (r - q)); ctx.lineTo(s.x + sx * r, s.y + sy * r); ctx.lineTo(s.x + sx * (r - q), s.y + sy * r); ctx.stroke() }
      if (chosen.f.kind === 'hold' || chosen.f.kind === 'em') {
        ctx.strokeStyle = hexa(c, 0.35); ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(cx, cy); ctx.stroke(); ctx.setLineDash([])
      }
    }
  }

  function dataBlock({ f, s, k, alpha, flashing }, now, placed) {
    const d = f.d, isSel = d.id === sel
    const lines = [callsign(d)]
    const age = B.ago(now - (f.kind === 'enr' || f.kind === 'dep' ? (d.landedAt ?? d.at) : d.since))
    if (f.kind === 'hold') lines.push(`${k.code} ${age}  ${proj(d)}`)
    else if (f.kind === 'em') lines.push(d.state === 'undelivered' ? 'NO ROUTE' : `EM ${proj(d)}`)
    else if (f.kind === 'fin' && !isSel) { lines[0] = `${callsign(d).padEnd(9)}${age.padStart(4)}  ${proj(d)}` }
    else if (f.kind === 'fin') lines.push(`${k.code} ${age}  ${proj(d)}`)
    else if (f.kind === 'dep') lines.push(`HO ${proj(d)}`)
    else lines.push(`${k.code} ${age}  ${proj(d)}`)
    if (isSel || f.kind === 'hold') {
      const words = d.question ?? d.summary ?? d.error ?? d.text
      lines.push(clip(words, isSel ? 34 : 26))
      if (isSel) lines.push(clip(`“${d.text}”`, 34))
    }
    ctx.font = `600 11px ${MONO}`
    const w = Math.max(...lines.map((l, i) => { ctx.font = `${i === 0 ? 600 : 400} ${i < 2 ? 11 : 10.5}px ${MONO}`; return ctx.measureText(l).width })) + 4
    const h = lines.length * 13 + 2
    let box = null, least = Infinity
    if (f.kind === 'fin' && isSel) {
      // The chosen arrival opens out on the other side of the course, clear of the ladder.
      box = { x: Math.max(8, s.x - 30 - w), y: Math.max(50, s.y - 30 - h), w, h }
    } else if (f.kind === 'fin') {
      // The arrival sequence: one line each, in a ladder beside the final approach course.
      const side = { x: -Math.cos(FINAL_BEARING), y: -Math.sin(FINAL_BEARING) }
      box = { x: s.x + side.x * 26 + 4, y: Math.max(s.y + side.y * 26 - h / 2, ladder + 14), w, h }
      ladder = box.y
    } else {
      for (const dist of [10, 26, 46, 70]) {
        for (const [ux, uy] of [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]]) {
          const c = { x: ux > 0 ? s.x + dist : ux < 0 ? s.x - dist - w : s.x - w / 2, y: uy < 0 ? s.y - dist - h : uy > 0 ? s.y + dist : s.y - h / 2, w, h }
          if (c.x < 4 || c.y < 46 || c.x + w > W - 4 || c.y + h > H - 30) continue
          const hit = placed.reduce((sum, o) => sum + Math.max(0, Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x)) * Math.max(0, Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y)), 0)
          if (hit < least) { least = hit; box = c }
          if (!hit) break
        }
        if (least === 0) break
      }
      box ??= { x: s.x + 14, y: s.y - h - 8, w, h }
    }
    placed.push(box)
    ctx.save(); ctx.globalAlpha = alpha
    // Leader line.
    const lx = box.x > s.x ? box.x - 2 : box.x + w + 2, ly = box.y + 7
    ctx.strokeStyle = hexa(k.color, 0.4); ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(s.x + Math.sign(lx - s.x) * 5, s.y); ctx.lineTo(lx, ly); ctx.stroke()
    if (isSel) { ctx.fillStyle = 'rgba(2,10,6,.86)'; ctx.fillRect(box.x - 5, box.y - 3, w + 10, h + 6); ctx.strokeStyle = hexa(k.color, 0.5); ctx.strokeRect(box.x - 5, box.y - 3, w + 10, h + 6) }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    lines.forEach((l, i) => {
      ctx.font = `${i === 0 ? 600 : 400} ${i < 2 ? 11 : 10.5}px ${MONO}`
      ctx.fillStyle = i === 0 ? (flashing ? hexa(k.color, 0.35) : k.color) : i === 1 ? hexa(k.color, 0.78) : (i === 2 && f.kind === 'hold' ? '#f3d9ad' : '#a9c3b5')
      ctx.fillText(l, box.x, box.y + i * 13)
    })
    if (f.kind === 'dep' && blink(now, 1.6)) { ctx.fillStyle = C.white; ctx.font = `600 11px ${MONO}`; ctx.fillText('◂ HO', box.x + ctx.measureText(lines[0] + ' ').width + 6, box.y) }
    ctx.restore()
  }

  const clip = (text, n) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
  const ease = (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
  function hexa(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }

  function frame(t) {
    const now = Date.now()
    const dt = Math.min(100, t - lastFrame); lastFrame = t
    const prev = sweep
    if (!reduced) sweep = (sweep + (dt / SCAN_MS) * Math.PI * 2) % (Math.PI * 2)
    desk.now = now
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    scope(now)
    sweepArm(now)
    const list = flights(now)
    targets(now, list, prev)
    if (now - lastBay > 1000) bay()
    requestAnimationFrame(frame)
  }

  // ── ATIS line, the strip bay ────────────────────────────────────────────────────────────────────────

  const phonetic = ['ALFA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIETT', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO']
  let lastBay = 0
  function bay() {
    lastBay = Date.now()
    const now = desk.now
    const list = flights(now)
    const counts = Object.fromEntries(ORDER.map((k) => [k, list.filter((f) => f.kind === k).length]))
    const line = $('atisline')
    line.replaceChildren()
    const add = (text, cls) => { const s = document.createElement(cls ? 'b' : 'span'); if (cls) s.className = cls; s.textContent = text; line.append(s) }
    add(`INFORMATION ${phonetic[new Date(now).getHours() % phonetic.length]} · `)
    add(`${counts.hold} HOLDING`, counts.hold ? 'hot' : ''); add(' · ')
    add(`${counts.em} EMERGENCY`, counts.em ? 'em' : ''); add(' · ')
    add(`${counts.fin} ON FINAL`, counts.fin ? 'fin' : ''); add(' · ')
    add(`${counts.enr + counts.dep} EN ROUTE`); add(' · ')
    const closed = desk.machines.filter((m) => !m.online)
    add(closed.length ? `SECTOR ${closed.map((m) => m.name.toUpperCase()).join(', ')} CLOSED` : 'ALL SECTORS OPEN')
    if (desk.real) add(' · YOUR DESK')
    $('clock').replaceChildren(Object.assign(document.createElement('div'), { textContent: new Date(now).toLocaleTimeString('en-GB') + ' L' }),
      Object.assign(document.createElement('div'), { className: 's', textContent: desk.real ? 'your desk, read only' : 'an invented desk' }))
    const strips = $('strips')
    const order = stripOrder(list)
    $('baycount').textContent = `${order.filter((f) => f.kind !== 'gnd').length} airborne · ${counts.gnd} down`
    const keep = strips.scrollTop
    strips.replaceChildren()
    let group = null
    for (const f of order) {
      if (f.kind === 'dep' && group === 'enr') { /* departures sit with en route */ }
      const g = f.kind === 'dep' ? 'enr' : f.kind
      if (g !== group) {
        group = g
        const head = document.createElement('div'); head.className = 'group'
        const b = document.createElement('b'); b.textContent = KIND[g].label
        head.append(b, ` ${list.filter((x) => (x.kind === 'dep' ? 'enr' : x.kind) === g).length} · ${KIND[g].note}`)
        strips.append(head)
      }
      strips.append(strip(f, now))
    }
    strips.scrollTop = keep
  }

  function strip(f, now) {
    const d = f.d, h = B.harness(d.harness)
    const el = document.createElement('div')
    el.className = `strip ${f.kind === 'dep' ? 'enr' : f.kind}${d.id === sel ? ' sel' : ''}${f.kind === 'hold' ? ' flash' : ''}${matches(d) ? '' : ' dim'}`
    el.dataset.id = d.id
    const c1 = document.createElement('div')
    c1.append(Object.assign(document.createElement('div'), { className: 'cs', textContent: callsign(d) }),
      Object.assign(document.createElement('div'), { className: 'ty', textContent: h ? B.engine(h.engine).short : '—' }))
    const c2 = document.createElement('div')
    c2.append(Object.assign(document.createElement('div'), { className: 'rt', textContent: h ? `${(d.machine ?? '').toUpperCase()} → ${h.project.toUpperCase()}${d.created ? ' · NEW' : ''}` : 'NO ROUTE' }),
      Object.assign(document.createElement('div'), { className: 'tx', textContent: d.text }))
    const c3 = document.createElement('div'); c3.className = 'tm'
    const code = f.kind === 'dep' ? 'HO' : f.kind === 'em' && d.state === 'undelivered' ? 'NRT' : KIND[f.kind].code
    const age = B.ago(now - (f.kind === 'enr' || f.kind === 'dep' ? (d.landedAt ?? d.at) : d.since))
    c3.append(Object.assign(document.createElement('b'), { textContent: code }), age)
    el.append(c1, c2, c3)
    if (d.id === sel) el.append(more(f, now))
    el.addEventListener('click', () => select(d.id))
    return el
  }

  function more(f, now) {
    const d = f.d, h = B.harness(d.harness)
    const box = document.createElement('div'); box.className = 'more'
    const row = (label, text) => { const r = document.createElement('div'); r.className = 'row'; const b = document.createElement('b'); b.textContent = label; r.append(b, ' ', text); box.append(r) }
    if (d.state === 'asking') box.append(Object.assign(document.createElement('div'), { className: 'said', textContent: d.question }))
    else if (d.state === 'failed' || d.state === 'undelivered') box.append(Object.assign(document.createElement('div'), { className: 'said', textContent: d.error }))
    else if (d.summary) box.append(Object.assign(document.createElement('div'), { className: 'said', textContent: d.summary }))
    row('you said', `“${d.text}” at ${B.clock(d.at)}${d.via === 'voice' ? ', by voice' : ''}`)
    const dec = d.decision
    if (dec.kind === 'session') row('⌘B sent it to', `“${h?.name}”, already running · Jev ${dec.p?.toFixed(2)}${dec.runnerUp ? `, then “${dec.runnerUp.name}” ${dec.runnerUp.p.toFixed(2)}` : ''} · ${(dec.ms / 1000).toFixed(2)} s`)
    else if (dec.kind === 'new') row('⌘B started', `“${h?.name}”: ${dec.why} · Jev ${dec.p?.toFixed(2)} · ${(dec.ms / 1000).toFixed(2)} s`)
    else if (dec.kind === 'routing') row('⌘B', 'deciding…')
    else row('⌘B', 'decided nothing, so sent nothing')
    if (h) row('harness', `${h.name} · ${B.engine(h.engine).name} · ${h.project} on ${d.machine} · ${h.turns.filter((t) => t.at >= d.at).length} turns since`)
    const act = document.createElement('div'); act.className = 'act'
    const keys = f.kind === 'fin' ? [['⏎', 'land it (mark read)'], ['u', 'put the last one back']]
      : f.kind === 'hold' ? [['⏎', 'bring it forward'], ['→', 'answer in the chat']]
        : f.kind === 'em' ? [['⏎', d.state === 'undelivered' ? 'say it again' : 'bring it forward']]
          : f.kind === 'gnd' ? [['u', 'back on final']] : [['⏎', 'bring it forward']]
    keys.forEach(([k, w], i) => { if (i) act.append(' · '); act.append(Object.assign(document.createElement('kbd'), { textContent: k }), ` ${w}`) })
    box.append(act)
    return box
  }

  // ── keys ────────────────────────────────────────────────────────────────────────────────────────────

  function visibleOrder() { return stripOrder(flights(desk.now)).filter((f) => matches(f.d)) }
  function select(id) {
    sel = id
    bay()
    const el = document.querySelector(`.strip[data-id="${CSS.escape(id ?? '')}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }
  function move(step) {
    const order = visibleOrder().filter((f) => f.kind !== 'gnd' || sel)
    if (!order.length) return
    const i = order.findIndex((f) => f.d.id === sel)
    const next = order[(i < 0 ? (step > 0 ? 0 : order.length - 1) : (i + step + order.length) % order.length)]
    select(next.d.id)
  }
  function jump(kind) {
    const order = visibleOrder().filter((f) => f.kind === kind)
    if (!order.length) return toast(`nothing ${KIND[kind].label.toLowerCase()}`)
    const i = order.findIndex((f) => f.d.id === sel)
    select(order[(i + 1) % order.length].d.id)
  }
  function land(id) {
    const f = flights(desk.now).find((x) => x.d.id === id)
    if (!f || f.kind !== 'fin') return false
    const tr = tracks.get(id)
    landings.set(id, { from: tr?.shown ?? truePos(f.d, 'fin', desk.now, f.rank), at: Date.now() })
    lastLanded.push(id)
    B.markSeen(id)
    toast(`${callsign(f.d)} cleared to land · ${clip(f.d.summary, 60)}`)
    return true
  }
  function toast(text) {
    const el = $('toast'); el.textContent = text; el.classList.add('on')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 2600)
  }
  function showFilter() {
    $('filter').classList.toggle('on', query !== null)
    $('q').textContent = query ?? ''
    $('qn').textContent = query ? `${desk.dispatches.filter(matches).length} of ${desk.dispatches.length}` : ''
    bay()
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (typing) {
      if (e.key === 'Escape') { query = null; typing = false }
      else if (e.key === 'Enter') { typing = false; const first = visibleOrder()[0]; if (first) select(first.d.id) }
      else if (e.key === 'Backspace') query = query.slice(0, -1)
      else if (e.key.length === 1) query += e.key
      else return
      e.preventDefault(); showFilter(); return
    }
    const f = flights(desk.now).find((x) => x.d.id === sel)
    switch (e.key) {
      case '/': query = ''; typing = true; showFilter(); break
      case 'Tab': move(e.shiftKey ? -1 : 1); break
      case 'j': case 'ArrowDown': move(1); break
      case 'k': case 'ArrowUp': move(-1); break
      case 'h': jump('hold'); break
      case 'f': jump('fin'); break
      case 'e': jump('em'); break
      case ' ': { const first = stripOrder(flights(desk.now)).find((x) => x.kind === 'fin'); if (first) { land(first.d.id); select(first.d.id) } else toast('nothing on final'); break }
      case 'Enter':
        if (!f) { move(1); break }
        if (f.kind === 'fin') land(f.d.id)
        else if (f.kind === 'hold') toast(`${callsign(f.d)}: would bring “${B.harness(f.d.harness)?.name}” forward — or answer it in the chat`)
        else if (f.d.state === 'undelivered') toast('would say it again to ⌘B, on the desk as it is now')
        else toast(`would bring “${B.harness(f.d.harness)?.name ?? '—'}” forward`)
        break
      case 'ArrowRight': if (f) toast('→ the chat beside this viewer knows which one you mean'); break
      case 'u': { const id = lastLanded.pop() ?? (f?.kind === 'gnd' ? f.d.id : null); if (id) { B.unseen(id); select(id); toast('back on final') } break }
      case 't': trails = !trails; toast(trails ? 'history trails on' : 'history trails off'); break
      case 's': document.body.classList.toggle('nostrips'); setTimeout(resize, 0); break
      case 'Escape': if (query !== null) { query = null; showFilter() } else select(null); break
      default: return
    }
    e.preventDefault()
  })

  canvas.addEventListener('click', (e) => {
    const box = canvas.getBoundingClientRect()
    const x = e.clientX - box.left, y = e.clientY - box.top
    let best = null, dist = 18
    for (const [id, tr] of tracks) { if (!tr.shown) continue; const dd = Math.hypot(tr.shown.x - x, tr.shown.y - y); if (dd < dist && kindOf(desk.dispatches.find((d) => d.id === id) ?? {}, desk.now) !== 'gnd') { dist = dd; best = id } }
    select(best)
  })

  function keysLine() {
    const keys = $('keys')
    const parts = [['tab', 'next'], ['h f e', 'holding · final · emergency'], ['⏎', 'land / bring forward'], ['space', 'land next'], ['u', 'undo'], ['/', 'find'], ['t', 'trails'], ['s', 'strips']]
    parts.forEach(([k, w], i) => { if (i) keys.append('  ·  '); keys.append(Object.assign(document.createElement('kbd'), { textContent: k }), ` ${w}`) })
  }

  B.load().then((d) => {
    desk = d
    $('loading').remove()
    layoutSectors()
    resize()
    keysLine()
    // Start on what needs you most.
    const first = stripOrder(flights(desk.now))[0]
    if (first && first.kind !== 'gnd') sel = first.d.id
    const pick = new URLSearchParams(location.search).get('select')
    if (pick) sel = pick
    bay()
    B.subscribe((_, event) => { if (event.type !== 'tick' && event.type !== 'turn') { layoutSectors(); bay() } })
    addEventListener('resize', () => { resize(); bay() })
    requestAnimationFrame(frame)
  }).catch((error) => { $('loading').textContent = `could not read the desk: ${error.message}` })
})()
