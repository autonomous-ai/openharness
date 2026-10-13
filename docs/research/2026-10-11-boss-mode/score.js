// Score: the desk as a conductor's full score. Time runs left to right, one staff per harness, grouped by
// machine the way an orchestra is grouped by family. Each task you handed off is a rehearsal mark with its
// cue; the harness's turns are its notes, beamed where it played fast. A harness that finished ends in
// a double bar and "Fine"; one that needs you holds a fermata — a note held until you cue it. You read the
// night the way a conductor reads a page: what played, what ended, what is still held for you.
(function () {
  'use strict'
  const B = window.BossData
  const css = getComputedStyle(document.documentElement)
  const MONO = css.getPropertyValue('--mono') || 'monospace'
  const SERIF = css.getPropertyValue('--serif') || 'serif'
  const C = { ink: '#e8e1d0', muted: '#9a9284', faint: '#5c574e', line: '#3a352e', gold: '#e8b860', amber: '#ffb547', red: '#ff6b5f', fine: '#f4efe2', green: '#9fd8a8' }
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const canvas = $('page')
  const ctx = canvas.getContext('2d')
  const SPANS = [6, 12, 22, 36].map((h) => h * B.HOUR)

  let desk = null
  let W = 0, H = 0, DPR = 1
  let L = 206, R = 0
  let span = SPANS[2], end = 0, follow = true
  let staves = [], groups = []
  let selStaff = 0, selMark = null
  let query = null, typing = false
  let partOpen = false
  let playing = null
  let sound = false, audio = null
  let toastTimer = 0

  // ── who plays what ─────────────────────────────────────────────────────────────────────────────────

  const dispatchesOf = (h) => desk.dispatches.filter((d) => d.harness === h.id).sort((a, b) => a.at - b.at)
  const latest = (h) => dispatchesOf(h).at(-1) ?? null
  function ending(h) {
    const d = latest(h)
    const state = d ? d.state : h.state
    if (state === 'asking') return 'held'
    if (state === 'failed') return 'broke'
    if (state === 'offline') return 'away'
    if (state === 'stopped') return 'stopped'
    if (state === 'working' || state === 'routing') return 'playing'
    if (state === 'done') return d && !d.seenAt ? 'fine' : 'fine-read'
    return h.state === 'working' ? 'playing' : 'quiet'
  }
  const matches = (h) => {
    if (!query) return true
    const hay = `${h.name} ${h.project} ${h.machine} ${dispatchesOf(h).map((d) => `${d.text} ${d.question ?? ''} ${d.summary ?? ''}`).join(' ')}`.toLowerCase()
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
  }

  function layout() {
    const rect = canvas.getBoundingClientRect()
    DPR = Math.min(2, devicePixelRatio || 1)
    W = rect.width; H = rect.height
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    L = W < 900 ? 132 : 206
    // An open part takes the right of the page, and the score makes room for it rather than hiding under it.
    R = W - (W < 900 ? 70 : 96) - (partOpen && W >= 1000 ? 456 : 0)
    const machines = [...desk.machines].sort((a, b) => (b.here - a.here) || (b.online - a.online))
    const t0 = desk.now - 36 * B.HOUR
    const plays = (h) => h.boss || h.state === 'working' || h.turns.some((t) => t.at > t0)
    groups = machines.map((m) => {
      const hs = desk.harnesses.filter((h) => h.machine === m.id && plays(h))
      const full = hs.filter((h) => h.boss).sort((a, b) => (dispatchesOf(a)[0]?.at ?? 0) - (dispatchesOf(b)[0]?.at ?? 0))
      const perc = hs.filter((h) => !h.boss).sort((a, b) => a.createdAt - b.createdAt)
      return { m, list: [...full.map((h) => ({ h, kind: 'full' })), ...perc.map((h) => ({ h, kind: 'perc' }))] }
    }).filter((g) => g.list.length)
    const top = 112, bottom = H - 64
    const need = groups.reduce((n, g) => n + g.list.reduce((k, s) => k + (s.kind === 'full' ? 40 : 22), 0) + 16, 0)
    const k = Math.max(0.6, Math.min(1.1, (bottom - top) / need))
    let y = top
    staves = []
    for (const g of groups) {
      g.top = y
      for (const s of g.list) {
        const h = (s.kind === 'full' ? 40 : 22) * k
        staves.push({ ...s, y: y + h / 2, hgt: h, group: g })
        y += h
      }
      g.bottom = y
      y += 16 * k
    }
    selStaff = Math.min(selStaff, staves.length - 1)
    bars = null
  }
  // Bars are as wide as what happened in them, the way an engraver spaces a dense measure wider: a quiet
  // night folds up, a busy hour opens out.
  let bars = null
  function spacing() {
    const from = end - span
    const first = new Date(from); first.setMinutes(0, 0, 0)
    const edges = [from]
    for (let t = first.getTime() + B.HOUR; t < end; t += B.HOUR) edges.push(t)
    edges.push(end)
    const busy = edges.slice(0, -1).map((t, i) => {
      const t1 = edges[i + 1]
      let n = 0
      for (const st of staves) for (const x of st.h.turns) if (x.at >= t && x.at < t1) n++
      n += 10 * desk.dispatches.filter((d) => d.at >= t && d.at < t1).length
      return n / ((t1 - t) / B.HOUR)
    })
    const most = Math.max(1, ...busy)
    const weight = busy.map((n, i) => ((edges[i + 1] - edges[i]) / B.HOUR) * (0.45 + 2.4 * Math.pow(n / most, 0.6)))
    const total = weight.reduce((a, b) => a + b, 0)
    let x = L
    bars = edges.map((t, i) => { const at = { t, x }; x += i < weight.length ? (weight[i] / total) * (R - L) : 0; return at })
    bars.key = `${Math.round(from / 60000)}:${span}:${desk.dispatches.length}`
  }
  function tx(t) {
    if (!bars) return L + ((t - (end - span)) / span) * (R - L)
    if (t <= bars[0].t) return L - ((bars[0].t - t) / span) * (R - L)
    for (let i = 1; i < bars.length; i++) {
      if (t <= bars[i].t) { const a = bars[i - 1], b = bars[i]; return a.x + ((t - a.t) / (b.t - a.t || 1)) * (b.x - a.x) }
    }
    return R + ((t - bars.at(-1).t) / span) * (R - L)
  }

  // ── engraving ──────────────────────────────────────────────────────────────────────────────────────

  function background() {
    ctx.fillStyle = '#0c0b0a'; ctx.fillRect(0, 0, W, H)
    const g = ctx.createRadialGradient(W * 0.55, H * 0.45, 0, W * 0.55, H * 0.45, Math.max(W, H) * 0.8)
    g.addColorStop(0, 'rgba(232,225,208,.025)'); g.addColorStop(1, 'rgba(0,0,0,.35)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  }

  function timeline(now) {
    const from = end - span
    const first = staves[0], last = staves.at(-1)
    if (!first) return
    const yTop = first.group.top, yBot = last.group.bottom
    // Night: 23:00 to 07:00, a cooler wash and a moon.
    for (let d = new Date(from - 24 * B.HOUR); d.getTime() < end; d = new Date(d.getTime() + 24 * B.HOUR)) {
      const n0 = new Date(d); n0.setHours(23, 0, 0, 0)
      const n1 = new Date(n0.getTime() + 8 * B.HOUR)
      const x0 = Math.max(L, tx(n0.getTime())), x1 = Math.min(R, tx(n1.getTime()))
      if (x1 <= x0) continue
      ctx.fillStyle = 'rgba(120,140,200,.045)'; ctx.fillRect(x0, 92, x1 - x0, yBot - 92 + 6)
      ctx.font = `italic 12px ${SERIF}`; ctx.fillStyle = 'rgba(160,175,220,.45)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      if (x1 - x0 > 60) ctx.fillText('☾ night', x0 + 6, yBot + 16)
    }
    // Bar lines on the hour, through each family; bar numbers are the hours.
    const hour = new Date(from); hour.setMinutes(0, 0, 0)
    const every = span > 24 * B.HOUR ? 3 : span > 12 * B.HOUR ? 2 : 1
    for (let t = hour.getTime() + B.HOUR; t < end; t += B.HOUR) {
      const x = tx(t)
      if (x < L + 2 || x > R) continue
      ctx.strokeStyle = 'rgba(232,225,208,.08)'; ctx.lineWidth = 1
      for (const g of groups) { ctx.beginPath(); ctx.moveTo(x + 0.5, g.top + 2); ctx.lineTo(x + 0.5, g.bottom - 2); ctx.stroke() }
      const h = new Date(t).getHours()
      if (h % every) continue
      ctx.font = h === 0 ? `600 10.5px ${MONO}` : `10.5px ${MONO}`; ctx.fillStyle = h === 0 ? C.ink : C.faint; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
      ctx.fillText(h === 0 ? new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }).toLowerCase() : String(h).padStart(2, '0'), x, 62)
    }
    // Now: the conductor's place.
    const xn = tx(now)
    if (xn <= R + 1) {
      ctx.strokeStyle = 'rgba(232,184,96,.55)'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(xn, 66); ctx.lineTo(xn, yBot + 4); ctx.stroke()
      ctx.font = `600 10.5px ${MONO}`; ctx.fillStyle = C.gold; ctx.textAlign = 'center'; ctx.fillText(`now ${B.clock(now)}`, xn, 62)
    }
  }

  function marks(now) {
    // Rehearsal marks: one boxed number per task you handed off, its cue dropping to the staff that took it.
    const rows = [[], []]
    const list = desk.dispatches.filter((d) => d.at >= end - span - B.HOUR && d.at <= end).sort((a, b) => a.at - b.at)
    for (const d of list) {
      const x = tx(d.at)
      if (x < L - 10 || x > R + 30) continue
      const label = String(d.n)
      ctx.font = `600 10.5px ${MONO}`
      const w = ctx.measureText(label).width + 9
      let row = rows[0].some((r) => Math.abs(r - x) < w + 3) ? 1 : 0
      if (row === 1 && rows[1].some((r) => Math.abs(r - x) < w + 3)) row = 0
      rows[row].push(x)
      const y = 72 + row * 18
      const s = staves.find((st) => st.h.id === d.harness)
      const isSel = d.id === selMark || (s && staves[selStaff]?.h.id === d.harness)
      const dim = s && !matches(s.h)
      ctx.save(); if (dim) ctx.globalAlpha = 0.25
      if (s) {
        ctx.strokeStyle = isSel ? 'rgba(232,184,96,.75)' : 'rgba(232,184,96,.13)'; ctx.lineWidth = 1; ctx.setLineDash(isSel ? [] : [2, 4])
        ctx.beginPath(); ctx.moveTo(x + 0.5, y + 8); ctx.lineTo(x + 0.5, s.y - s.hgt * 0.3); ctx.stroke(); ctx.setLineDash([])
      }
      ctx.fillStyle = isSel ? C.gold : '#0c0b0a'; ctx.fillRect(x - w / 2, y - 7, w, 15)
      ctx.strokeStyle = d.state === 'undelivered' ? C.red : C.gold; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2 + 0.5, y - 6.5, w - 1, 14)
      ctx.fillStyle = isSel ? '#1a140a' : d.state === 'undelivered' ? C.red : C.gold; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(label, x, y + 0.5)
      if (d.state === 'undelivered') { ctx.strokeStyle = C.red; ctx.beginPath(); ctx.moveTo(x - w / 2, y + 7); ctx.lineTo(x + w / 2, y - 7); ctx.stroke() }
      ctx.restore()
    }
  }

  function names() {
    for (const g of groups) {
      // The bracket that holds a machine's staves together, and the machine's name beside it.
      const x = L - 12
      ctx.strokeStyle = g.m.online ? 'rgba(232,225,208,.55)' : 'rgba(232,225,208,.2)'; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(x, g.top + 2); ctx.lineTo(x, g.bottom - 2); ctx.stroke()
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(x - 1, g.top + 2); ctx.quadraticCurveTo(x + 2, g.top - 4, x + 10, g.top - 5); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x - 1, g.bottom - 2); ctx.quadraticCurveTo(x + 2, g.bottom + 4, x + 10, g.bottom + 5); ctx.stroke()
      ctx.save(); ctx.translate(14, (g.top + g.bottom) / 2); ctx.rotate(-Math.PI / 2)
      ctx.font = `600 10px ${MONO}`; ctx.fillStyle = g.m.online ? C.muted : C.faint; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText((g.m.online ? g.m.name : `${g.m.name} · asleep`).toUpperCase().split('').join(' '), 0, 0)
      ctx.restore()
    }
    staves.forEach((s, i) => {
      const isSel = i === selStaff
      const right = L - 22
      ctx.save(); if (!matches(s.h)) ctx.globalAlpha = 0.25
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
      if (s.kind === 'full') {
        ctx.font = `italic ${isSel ? 14 : 13}px ${SERIF}`; ctx.fillStyle = isSel ? C.gold : C.ink
        ctx.fillText(fit(s.h.name, right - 26), right, s.y + 1)
        ctx.font = `9.5px ${MONO}`; ctx.fillStyle = C.faint
        ctx.fillText(fit(`${B.engine(s.h.engine).short} · ${s.h.project}`, right - 26), right, s.y + 13)
      } else {
        ctx.font = `italic 11.5px ${SERIF}`; ctx.fillStyle = isSel ? C.gold : C.faint
        ctx.fillText(fit(s.h.name, right - 26), right, s.y + 4)
      }
      ctx.restore()
    })
  }

  function staff(s, i, now) {
    const h = s.h
    const isSel = i === selStaff
    const end0 = ending(h)
    const ls = Math.min(5, s.hgt / 8)
    const from = end - span
    const xs = Math.max(L, tx(Math.max(from, h.createdAt)))
    const stopAt = ['held', 'playing'].includes(end0) ? now : h.since
    const xe = Math.min(R, tx(Math.min(end, stopAt)))
    ctx.save()
    if (!matches(h)) ctx.globalAlpha = 0.22
    if (isSel) { ctx.fillStyle = 'rgba(232,184,96,.06)'; ctx.fillRect(L - 4, s.y - s.hgt / 2 + 1, R - L + 90, s.hgt - 2) }
    const lineY = s.kind === 'full' ? [-2, -1, 0, 1, 2].map((k) => s.y + k * ls) : [s.y]
    // The staff lines, where the harness was on the desk; after its end, one faint line: tacet.
    ctx.strokeStyle = isSel ? 'rgba(232,225,208,.42)' : 'rgba(232,225,208,.24)'; ctx.lineWidth = 1
    if (xe > xs) for (const y of lineY) { ctx.beginPath(); ctx.moveTo(xs, y + 0.5); ctx.lineTo(xe, y + 0.5); ctx.stroke() }
    if (end0 !== 'held' && end0 !== 'playing' && xe < tx(now) && xe >= L) {
      ctx.strokeStyle = 'rgba(232,225,208,.07)'; ctx.setLineDash(end0 === 'away' ? [3, 4] : [])
      ctx.beginPath(); ctx.moveTo(xe, s.y + 0.5); ctx.lineTo(Math.min(R, tx(now)), s.y + 0.5); ctx.stroke(); ctx.setLineDash([])
    }
    // The notes.
    notes(s, ls, isSel, now)
    // How it ends.
    const ink = (a) => `rgba(232,225,208,${a})`
    const top = lineY[0], bot = lineY.at(-1)
    if ((end0 === 'fine' || end0 === 'fine-read' || end0 === 'stopped') && xe >= L && xe <= R) {
      const bright = end0 === 'fine'
      ctx.strokeStyle = bright ? C.fine : ink(0.4); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(xe - 4, top - (s.kind === 'perc' ? 5 : 0)); ctx.lineTo(xe - 4, bot + (s.kind === 'perc' ? 5 : 0)); ctx.stroke()
      ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(xe, top - (s.kind === 'perc' ? 5 : 0)); ctx.lineTo(xe, bot + (s.kind === 'perc' ? 5 : 0)); ctx.stroke()
      if (s.kind === 'full') {
        if (bright && !reduced) { ctx.shadowColor = 'rgba(244,239,226,.7)'; ctx.shadowBlur = 10 }
        ctx.font = `italic ${bright ? 600 : 400} 13px ${SERIF}`; ctx.fillStyle = bright ? C.fine : ink(0.4); ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
        ctx.fillText(end0 === 'stopped' ? 'stopped' : 'Fine', xe - 2, top - 5)
        ctx.shadowBlur = 0
      }
    }
    if (end0 === 'held') {
      // The last note, held: a fermata where it stopped, the note sustained to now, and a fermata at now.
      const x0 = Math.max(L, tx(h.since)), xn = Math.min(R, tx(now))
      const pulse = reduced ? 0.7 : 0.55 + 0.35 * Math.sin(now / 520)
      ctx.strokeStyle = `rgba(255,181,71,${0.35 + 0.4 * pulse})`; ctx.lineWidth = 2.2
      ctx.beginPath(); ctx.moveTo(x0, s.y); ctx.lineTo(xn, s.y); ctx.stroke()
      ctx.fillStyle = C.amber; whole(x0, s.y)
      fermata(x0, top - 6, 7, C.amber)
      if (!reduced) { ctx.shadowColor = C.amber; ctx.shadowBlur = 14 * pulse }
      fermata(xn + 2, top - 8, 11, C.amber)
      ctx.shadowBlur = 0
    }
    if (end0 === 'broke' && xe >= L) {
      ctx.strokeStyle = C.red; ctx.lineWidth = 1.6
      ctx.beginPath(); ctx.moveTo(xe, top - 4); for (let k = 0; k <= 6; k++) ctx.lineTo(xe + (k % 2 ? 4 : -2), top - 4 + k * ((bot - top + 8) / 6)); ctx.stroke()
      ctx.font = `italic 12.5px ${SERIF}`; ctx.fillStyle = C.red; ctx.textAlign = 'right'; ctx.fillText('broke off', xe - 4, top - 5)
    }
    // A word at the right edge, where the eye ends: what this staff needs from you now.
    const xr = Math.min(R, tx(now)) + 18
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    const word = { held: [`held ${B.ago(now - h.since)}`, C.amber, 600], fine: ['to read', C.fine, 500], broke: ['broke', C.red, 500], away: ['out of reach', C.faint, 400], playing: ['playing', 'rgba(159,216,168,.6)', 400] }[end0]
    if (word && xr < W - 10) { ctx.font = `${word[2]} 10.5px ${MONO}`; ctx.fillStyle = word[1]; ctx.fillText(word[0], end0 === 'held' ? xr + 6 : xr, s.y) }
    if (isSel && s.kind === 'full') dynamics(s, now)
    ctx.restore()
  }

  function hash(n) { let x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x) }

  function notes(s, ls, isSel, now) {
    const from = end - span
    const turns = s.h.turns.filter((t) => t.at >= from && t.at <= end)
    const lit = playing ? playing.at : Infinity
    // Clusters: turns close together are one run, beamed.
    const runs = []
    for (const t of turns) {
      const r = runs.at(-1)
      if (r && t.by === 'agent' && r.by === 'agent' && t.at - r.last < 6 * B.MIN) { r.list.push(t); r.last = t.at } else runs.push({ by: t.by, list: [t], last: t.at })
    }
    const full = s.kind === 'full'
    for (const r of runs) {
      const x0 = tx(r.list[0].at), x1 = tx(r.last)
      if (x1 < L - 2 || x0 > R + 2) continue
      const played = r.list[0].at <= lit
      const alpha = played ? 1 : 0.18
      if (r.by === 'you') {
        // You: a gold note with an accent.
        const y = full ? s.y - 2 * ls : s.y
        ctx.fillStyle = `rgba(232,184,96,${alpha})`; ctx.strokeStyle = ctx.fillStyle
        if (full) { head(x0, y, ls); stem(x0, y, ls, true) } else cross(x0, y, 3)
        ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x0 - 3, y - ls * 3.6 - 3); ctx.lineTo(x0 + 3, y - ls * 3.6 - 1.5); ctx.lineTo(x0 - 3, y - ls * 3.6); ctx.stroke()
        continue
      }
      const n = r.list.length
      const m = Math.max(1, Math.min(n, Math.floor((x1 - x0) / 5.5) + 1))
      const ink = isSel ? `rgba(244,239,226,${alpha})` : `rgba(232,225,208,${0.78 * alpha})`
      ctx.fillStyle = ink; ctx.strokeStyle = ink
      if (!full) { for (let k = 0; k < m; k++) cross(m === 1 ? x0 : x0 + (k * (x1 - x0)) / (m - 1), s.y, 2.6); continue }
      const pts = []
      for (let k = 0; k < m; k++) {
        const t = r.list[Math.floor((k * n) / m)]
        const x = m === 1 ? x0 : x0 + (k * (x1 - x0)) / (m - 1)
        // Pitch: bigger answers sit higher, with a little melody from the turn's own time.
        const p = Math.max(-4, Math.min(4, Math.round(Math.log(t.size + 1) / Math.log(6000) * 7 - 4 + (hash(t.at % 100000) - 0.5) * 3)))
        const y = s.y - p * ls / 2
        pts.push({ x, y, p })
        head(x, y, ls)
        // Ledger lines beyond the staff.
        if (Math.abs(p) > 4) { ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.stroke() }
      }
      const up = pts.reduce((a, b) => a + b.p, 0) / pts.length < 0
      const len = ls * 3.4
      ctx.lineWidth = 1
      for (const q of pts) { const sx = up ? q.x + ls * 0.62 : q.x - ls * 0.62; ctx.beginPath(); ctx.moveTo(sx, q.y); ctx.lineTo(sx, up ? q.y - len : q.y + len); ctx.stroke() }
      if (pts.length > 1) {
        // Beams: one for a run, two when it played fast.
        const a = pts[0], b = pts.at(-1)
        const ya = up ? Math.min(...pts.map((q) => q.y)) - len : Math.max(...pts.map((q) => q.y)) + len
        const off = up ? ls * 0.62 : -ls * 0.62
        const beams = n / m > 2 || n > 6 ? 2 : 1
        for (let k = 0; k < beams; k++) {
          const yy = ya + (up ? k * 3.5 : -k * 3.5)
          ctx.fillRect(a.x + off - 0.5, yy - (up ? 0 : 2), b.x - a.x + 1, 2)
        }
        for (const q of pts) { const sx = q.x + off; ctx.beginPath(); ctx.moveTo(sx, q.y); ctx.lineTo(sx, ya); ctx.stroke() }
      } else if (n === 1) {
        // A lone turn: a flag.
        const q = pts[0], sx = up ? q.x + ls * 0.62 : q.x - ls * 0.62, ty = up ? q.y - len : q.y + len
        ctx.beginPath(); ctx.moveTo(sx, ty); ctx.quadraticCurveTo(sx + 5, ty + (up ? 4 : -4), sx + 4, ty + (up ? 9 : -9)); ctx.stroke()
      }
    }
    // Long silences get a rest.
    if (full) {
      let prev = Math.max(from, s.h.createdAt)
      const stop = ['held', 'playing'].includes(ending(s.h)) ? now : s.h.since
      for (const t of [...turns, { at: Math.min(stop, end) }]) {
        if (t.at - prev > 2.5 * B.HOUR) { const x = tx((prev + t.at) / 2); if (x > L + 10 && x < R - 10) rest(x, s.y, ls) }
        prev = Math.max(prev, t.at)
      }
    }
  }

  function head(x, y, ls) { ctx.beginPath(); ctx.ellipse(x, y, ls * 0.66, ls * 0.46, -0.35, 0, Math.PI * 2); ctx.fill() }
  function whole(x, y) { ctx.save(); ctx.lineWidth = 1.6; ctx.strokeStyle = ctx.fillStyle; ctx.beginPath(); ctx.ellipse(x, y, 5, 3.4, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore() }
  function stem(x, y, ls, up) { ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + ls * 0.62, y); ctx.lineTo(x + ls * 0.62, up ? y - ls * 3.4 : y + ls * 3.4); ctx.stroke() }
  function cross(x, y, r) { ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke() }
  function fermata(x, y, r, color) {
    ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = r > 8 ? 2.2 : 1.6
    ctx.beginPath(); ctx.arc(x, y, r, Math.PI, 0); ctx.stroke()
    ctx.beginPath(); ctx.arc(x, y - 1, r > 8 ? 2.2 : 1.6, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
  function rest(x, y, ls) {
    ctx.save(); ctx.strokeStyle = 'rgba(232,225,208,.45)'; ctx.lineWidth = 1.6
    ctx.beginPath(); ctx.moveTo(x - 1.5, y - ls * 1.8); ctx.lineTo(x + 2, y - ls * 0.8); ctx.lineTo(x - 2, y + ls * 0.1); ctx.lineTo(x + 2, y + ls * 0.9); ctx.quadraticCurveTo(x - 3, y + ls * 0.6, x, y + ls * 1.8); ctx.stroke()
    ctx.restore()
  }
  function dynamics(s, now) {
    // Under the chosen staff: how loud it played, hour by hour.
    const from = end - span
    const step = Math.max(B.HOUR, span / 8)
    let last = null
    for (let t = from; t < Math.min(end, now); t += step) {
      const n = s.h.turns.filter((x) => x.at >= t && x.at < t + step && x.by === 'agent').length
      const mark = n === 0 ? null : n < 4 ? 'pp' : n < 9 ? 'p' : n < 16 ? 'mp' : n < 26 ? 'mf' : n < 40 ? 'f' : 'ff'
      if (!mark || mark === last) { last = mark ?? last; continue }
      last = mark
      ctx.font = `italic 700 12px ${SERIF}`; ctx.fillStyle = 'rgba(232,184,96,.75)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      const x = tx(t + step / 2)
      if (x > L && x < R - 10) ctx.fillText(mark, x, s.y + s.hgt / 2 - 1)
    }
  }
  function fit(text, width) { if (ctx.measureText(text).width <= width) return text; let t = text; while (t.length > 1 && ctx.measureText(t + '…').width > width) t = t.slice(0, -1); return t + '…' }

  function frame() {
    const now = Date.now()
    desk.now = now
    if (follow) end = now + span * 0.0
    if (playing) {
      const k = (now - playing.started) / playing.ms
      playing.at = end - span + k * span
      if (sound) chime(playing)
      if (k >= 1) playing = null
    }
    if (!bars || bars.key !== `${Math.round((end - span) / 60000)}:${span}:${desk.dispatches.length}` || now - (bars.made ?? 0) > 30000) { spacing(); bars.made = now }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    background()
    timeline(now)
    names()
    staves.forEach((s, i) => staff(s, i, now))
    marks(now)
    if (playing) { const x = tx(playing.at); ctx.strokeStyle = 'rgba(232,184,96,.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 66); ctx.lineTo(x, staves.at(-1).group.bottom); ctx.stroke() }
    requestAnimationFrame(frame)
  }

  // ── sound, off unless asked for: each note as the playhead passes it ─────────────────────────────────

  const SCALE = [0, 2, 4, 7, 9]
  function chime(p) {
    audio ??= new AudioContext()
    const before = p.heard ?? p.at
    p.heard = p.at
    let budget = 6
    staves.forEach((s, i) => {
      for (const t of s.h.turns) {
        if (t.at <= before || t.at > p.at || budget <= 0) continue
        budget--
        const o = audio.createOscillator(), g = audio.createGain()
        const deg = SCALE[(i + Math.floor(t.size / 900)) % SCALE.length] + 12 * (i % 3)
        o.frequency.value = (t.by === 'you' ? 330 : 196) * Math.pow(2, deg / 12)
        o.type = t.by === 'you' ? 'triangle' : 'sine'
        g.gain.setValueAtTime(0.0001, audio.currentTime)
        g.gain.exponentialRampToValueAtTime(t.by === 'you' ? 0.06 : 0.03, audio.currentTime + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.6)
        o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.65)
      }
    })
  }

  // ── the glance, the cue line, the part ─────────────────────────────────────────────────────────────

  function glance() {
    const ends = staves.filter((s) => s.kind === 'full').map((s) => ending(s.h))
    const n = (k) => ends.filter((e) => e === k).length
    const box = $('glance'); box.replaceChildren()
    const part = (text, cls) => box.append(cls ? el('b', cls, text) : text)
    part(`${n('held')} held for you`, n('held') ? 'held' : ''); part('  ·  ')
    part(`${n('fine')} finished, unread`, n('fine') ? 'fine' : ''); part('  ·  ')
    part(`${n('broke')} broke off`, n('broke') ? 'broke' : ''); part('  ·  ')
    part(`${n('playing')} playing`)
    $('clock').textContent = `${desk.real ? 'your desk' : 'an invented desk'} · ${Math.round(span / B.HOUR)}h on the page`
  }
  function cue() {
    const s = staves[selStaff]
    const box = $('cue'); box.replaceChildren()
    if (!s) return
    const d = desk.dispatches.find((x) => x.id === selMark) ?? latest(s.h)
    if (!d) { box.append(el('span', 'who', `${s.h.name} · ${B.engine(s.h.engine).short} · ${s.h.project} on ${s.h.machine} · started by hand, never sent a task by ⌘B`)); return }
    const words = d.state === 'asking' ? `held: ${d.question}` : d.state === 'done' ? `fine: ${d.summary}` : d.error ?? 'playing'
    box.append(el('b', null, String(d.n)), `“${d.text}”`, el('span', 'who', `→ ${s.h.name} · ${words}`))
  }

  function part() {
    const s = staves[selStaff]
    const box = $('part')
    box.replaceChildren()
    if (!s || !partOpen) { box.classList.remove('on'); return }
    const h = s.h
    const e = ending(h)
    box.style.setProperty('--edge', { held: '#ffb547', fine: '#f4efe2', broke: '#ff6b5f' }[e] ?? '#5c574e')
    box.append(el('h1', null, h.name), el('div', 'sub', `${B.engine(h.engine).name} · ${h.project} on ${h.machine}`))
    const d = latest(h)
    const now = el('div', 'now')
    const k = { held: `held for you · ${B.ago(desk.now - h.since)}`, fine: 'fine · unread', 'fine-read': 'fine · read', broke: 'broke off', away: 'out of reach', playing: 'playing', stopped: 'stopped', quiet: 'quiet' }[e]
    now.append(el('span', 'k', k), (d?.question ?? d?.summary ?? d?.error ?? h.summary ?? 'Nothing said yet.'))
    box.append(now)
    const list = dispatchesOf(h)
    if (list.length) {
      box.append(el('h2', null, 'cues you gave it'))
      for (const x of list) {
        const m = el('div', 'mark')
        const body = el('div')
        const dec = x.decision
        body.append(el('div', 'said', `“${x.text}”`), el('div', 'how', `${B.clock(x.at)}${x.via === 'voice' ? ' · by voice' : ''} · ${dec.kind === 'session' ? `⌘B: same work, Jev ${dec.p?.toFixed(2) ?? '—'}${dec.runnerUp ? `, next best “${dec.runnerUp.name}” ${dec.runnerUp.p.toFixed(2)}` : ''}` : dec.kind === 'new' ? `⌘B: new work, Jev ${dec.p?.toFixed(2) ?? '—'}` : dec.kind === 'direct' ? 'typed into the pane' : dec.kind}`))
        m.append(el('div', 'box', String(x.n)), body)
        box.append(m)
      }
    } else box.append(el('h2', null, 'started by hand: no cues from ⌘B'))
    box.append(el('h2', null, 'the part'))
    const st = el('div', 'stats')
    const row = (a, b) => st.append(el('b', null, a), el('span', null, b))
    const mine = h.turns.filter((t) => t.at > desk.now - span)
    row('turns', `${mine.filter((t) => t.by === 'agent').length} by it · ${mine.filter((t) => t.by === 'you').length} by you, in ${Math.round(span / B.HOUR)}h`)
    row('tokens', h.tokens >= 1e6 ? `${(h.tokens / 1e6).toFixed(1)}M` : `${Math.round(h.tokens / 1000)}k`)
    row('on the desk', `since ${B.clock(h.createdAt)} (${B.ago(desk.now - h.createdAt)})`)
    row('last turn', h.lastTurnAt ? `${B.ago(desk.now - h.lastTurnAt)} ago` : '—')
    box.append(st)
    const keys = el('div', 'keys')
    const kk = e === 'fine' ? [['r', 'mark it read'], ['esc', 'back to the score']] : e === 'held' ? [['→', 'answer in the chat'], ['esc', 'back']] : [['esc', 'back']]
    kk.forEach(([a, b], i) => { if (i) keys.append('  ·  '); keys.append(el('kbd', null, a), ` ${b}`) })
    box.append(keys)
    box.classList.add('on')
  }
  function refresh() { glance(); cue(); part() }

  // ── keys ───────────────────────────────────────────────────────────────────────────────────────────

  function pickStaff(i) { selStaff = Math.max(0, Math.min(staves.length - 1, i)); selMark = null; refresh() }
  function nextWhere(pred, dir = 1) {
    for (let k = 1; k <= staves.length; k++) {
      const i = (selStaff + dir * k + staves.length * 2) % staves.length
      if (pred(staves[i]) && matches(staves[i].h)) return pickStaff(i)
    }
    toast('none')
  }
  function stepMark(dir) {
    const list = desk.dispatches.filter((d) => d.harness).sort((a, b) => a.at - b.at)
    const cur = list.findIndex((d) => d.id === (selMark ?? latest(staves[selStaff]?.h ?? {})?.id))
    const d = list[Math.max(0, Math.min(list.length - 1, cur + dir))]
    if (!d) return
    const i = staves.findIndex((s) => s.h.id === d.harness)
    if (i >= 0) selStaff = i
    selMark = d.id
    if (tx(d.at) < L || tx(d.at) > R) { follow = false; end = Math.min(desk.now, d.at + span / 2) }
    refresh()
  }
  function markRead() {
    const s = staves[selStaff]
    const d = s && dispatchesOf(s.h).filter((x) => x.state === 'done' && !x.seenAt).at(-1)
    if (!d) return toast('nothing unread here')
    B.markSeen(d.id); toast(`#${d.n} read`); refresh()
  }
  function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200) }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (typing) {
      if (e.key === 'Escape') { query = null; typing = false }
      else if (e.key === 'Enter') typing = false
      else if (e.key === 'Backspace') query = query.slice(0, -1)
      else if (e.key.length === 1) query += e.key
      else return
      e.preventDefault(); $('find').classList.toggle('on', query !== null); $('q').textContent = query ?? ''; return
    }
    switch (e.key) {
      case 'j': case 'ArrowDown': pickStaff(selStaff + 1); break
      case 'k': case 'ArrowUp': pickStaff(selStaff - 1); break
      case 'g': pickStaff(0); break
      case 'G': pickStaff(staves.length - 1); break
      case 'n': nextWhere((s) => ending(s.h) === 'held'); break
      case 'N': nextWhere((s) => ending(s.h) === 'held', -1); break
      case 'f': nextWhere((s) => ending(s.h) === 'fine'); break
      case 'x': nextWhere((s) => ending(s.h) === 'broke'); break
      case ']': stepMark(1); break
      case '[': stepMark(-1); break
      case 'h': case 'ArrowLeft': follow = false; end = Math.max(desk.now - 48 * B.HOUR, end - span / 4); break
      case 'l': case 'ArrowRight': end = Math.min(desk.now, end + span / 4); follow = end >= desk.now; break
      case '$': follow = true; break
      case '0': follow = false; end = Math.min(desk.now, Math.min(...desk.dispatches.map((d) => d.at)) + span - B.HOUR); break
      case '+': case '=': span = SPANS[Math.max(0, SPANS.indexOf(span) - 1)]; glance(); break
      case '-': span = SPANS[Math.min(SPANS.length - 1, SPANS.indexOf(span) + 1)]; glance(); break
      case ' ': playing = { started: Date.now(), ms: reduced ? 1 : 12000, at: end - span }; if (sound) audio?.resume(); break
      case 'm': sound = !sound; if (sound) { audio ??= new AudioContext(); audio.resume() } toast(sound ? 'sound on: press space to hear the night' : 'sound off'); break
      case 'Enter': partOpen = !partOpen; layout(); part(); break
      case 'r': markRead(); break
      case '/': query = ''; typing = true; $('find').classList.add('on'); $('q').textContent = ''; break
      case 'Escape': if (partOpen) { partOpen = false; layout(); part() } else if (query) { query = null; $('find').classList.remove('on') } else { selMark = null; cue() } break
      default: return
    }
    e.preventDefault()
  })
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect(), y = e.clientY - r.top
    const i = staves.findIndex((s) => Math.abs(s.y - y) < s.hgt / 2)
    if (i >= 0) pickStaff(i)
  })

  function keysLine() {
    const parts = [['j k', 'staves'], ['n', 'next held'], ['f', 'next unread'], ['[ ]', 'cues'], ['h l', 'time'], ['+ −', 'zoom'], ['⏎', 'the part'], ['r', 'read'], ['space', 'play the night'], ['m', 'sound'], ['/', 'find']]
    parts.forEach(([k, w], i) => { if (i) $('keys').append('  ·  '); $('keys').append(el('kbd', null, k), ` ${w}`) })
  }

  B.load().then((d) => {
    desk = d
    end = desk.now
    $('loading').remove()
    layout()
    keysLine()
    const held = staves.findIndex((s) => ending(s.h) === 'held')
    selStaff = held >= 0 ? held : 0
    refresh()
    B.subscribe((_, event) => {
      if (['dispatch', 'landed', 'done', 'asking', 'refresh', 'seen', 'unseen'].includes(event.type)) {
        const id = staves[selStaff]?.h.id
        layout()
        const i = staves.findIndex((s) => s.h.id === id); if (i >= 0) selStaff = i
        refresh()
      }
    })
    addEventListener('resize', () => { layout(); refresh() })
    requestAnimationFrame(frame)
  }).catch((error) => { $('loading').textContent = `could not read the desk: ${error.message}` })
})()
