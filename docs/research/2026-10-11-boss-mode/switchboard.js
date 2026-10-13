// Switchboard: ⌘B is an operator, and this is its board. Every harness on every machine is a line with a
// jack and a lamp; every task you handed off is a cord from the keyshelf to the line that took it. The
// lamps say what needs you, the way they told an operator: a line flashing wants you, a steady white lamp
// means the call is over and the cord is waiting to be pulled (read), red is trouble, green is talking.
// The cord is where your words went; a ghost cord shows where ⌘B nearly sent them.
(function () {
  'use strict'
  const B = window.BossData
  const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace'
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const canvas = $('board')
  const ctx = canvas.getContext('2d')
  const LAMP = { flash: '#ffb547', white: '#fff3dc', green: '#7ee08f', red: '#ff5a4f', off: null, ring: '#ffb547' }

  let desk = null
  let W = 0, H = 0, DPR = 1
  let lines = [] // { h, x, y, num, panel }
  let panels = []
  let plugs = [] // { d, x, y }
  let shelfY = 0
  let sel = null // { kind: 'cord' | 'line', id }
  let listening = false
  let query = null, typing = false
  let dialed = '', dialTimer = 0
  const pulling = new Map() // dispatch id → started
  const plugging = new Map() // dispatch id → started
  let toastTimer = 0

  // ── what is plugged in, and what each lamp says ────────────────────────────────────────────────────

  const active = (d) => d.state !== 'stopped' && !(d.state === 'done' && d.seenAt)
  function lampOf(d) {
    if (d.state === 'routing') return 'ring'
    if (d.state === 'asking') return 'flash'
    if (d.state === 'done') return d.seenAt ? 'off' : 'white'
    if (d.state === 'failed' || d.state === 'undelivered') return 'red'
    if (d.state === 'working') return 'green'
    return 'off'
  }
  const RANK = { flash: 0, red: 1, white: 2, ring: 3, green: 4, off: 5 }
  function lineLamp(h) {
    const cords = desk.dispatches.filter((d) => d.harness === h.id && active(d))
    const best = cords.map(lampOf).sort((a, b) => RANK[a] - RANK[b])[0]
    if (best) return best
    if (h.state === 'working') return 'green'
    if (h.state === 'asking') return 'flash'
    if (h.state === 'failed') return 'red'
    return 'off'
  }
  const matches = (d) => {
    if (!query) return true
    const h = B.harness(d.harness)
    const hay = `#${d.n} ${d.text} ${h?.name ?? ''} ${h?.project ?? ''} ${d.machine ?? ''} ${d.question ?? ''} ${d.summary ?? ''}`.toLowerCase()
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
  }

  // ── layout ─────────────────────────────────────────────────────────────────────────────────────────

  function layout() {
    const rect = canvas.getBoundingClientRect()
    DPR = Math.min(2, devicePixelRatio || 1)
    W = rect.width; H = rect.height
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    const machines = [...desk.machines].sort((a, b) => (b.here - a.here) || (b.online - a.online))
    const onBoard = (h) => h.state !== 'stopped' || desk.dispatches.some((d) => d.harness === h.id && active(d))
    const groups = machines.map((m) => ({ m, hs: desk.harnesses.filter((h) => h.machine === m.id && onBoard(h)).sort((a, b) => a.createdAt - b.createdAt) })).filter((g) => g.hs.length || g.m.online)
    const total = groups.reduce((n, g) => n + g.hs.length, 0)
    const rows = total > 14 ? 3 : 2
    const cols = groups.map((g) => Math.max(1, Math.ceil(g.hs.length / rows)))
    const gap = 16, pad = 14
    const avail = W - 36 - gap * (groups.length - 1) - pad * 2 * groups.length
    const sx = Math.max(58, Math.min(96, avail / cols.reduce((a, b) => a + b, 0)))
    const sy = 86
    const top = 58
    let x = 18, num = 1
    panels = []; lines = []
    groups.forEach((g, i) => {
      const w = cols[i] * sx + pad * 2
      panels.push({ m: g.m, x, y: top, w, h: 92 + (rows - 1) * sy + 22 })
      g.hs.forEach((h, k) => {
        const c = Math.floor(k / rows), r = k % rows
        lines.push({ h, x: x + pad + c * sx + sx / 2, y: top + 92 + r * sy, num: num++, panel: g.m, w: sx })
      })
      x += w + gap
    })
    const fieldBottom = top + 92 + (rows - 1) * sy + 22
    shelfY = Math.max(fieldBottom + 170, H - 330)
    const cords = desk.dispatches.filter(active).sort((a, b) => a.at - b.at)
    const step = Math.min(66, (W - 80) / Math.max(1, cords.length))
    const start = W / 2 - (step * (cords.length - 1)) / 2
    plugs = cords.map((d, i) => ({ d, x: start + i * step, y: shelfY + 36 }))
  }
  const lineOf = (hid) => lines.find((l) => l.h.id === hid)

  // ── drawing ────────────────────────────────────────────────────────────────────────────────────────

  function wood() {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#140d09'); g.addColorStop(0.5, '#110b08'); g.addColorStop(1, '#0b0705')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
    // Grain.
    ctx.strokeStyle = 'rgba(120,80,50,.045)'; ctx.lineWidth = 1
    for (let y = 0; y < H; y += 7) { ctx.beginPath(); ctx.moveTo(0, y); for (let x = 0; x <= W; x += 60) ctx.lineTo(x, y + Math.sin((x + y * 3) / 90) * 2.2); ctx.stroke() }
  }

  function panel(p, now) {
    // Black bakelite with a brass edge.
    ctx.fillStyle = '#0a0807'; roundRect(p.x, p.y, p.w, p.h, 5); ctx.fill()
    ctx.strokeStyle = 'rgba(201,164,106,.35)'; ctx.lineWidth = 1.2; roundRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1, 5); ctx.stroke()
    // The nameplate.
    const nw = Math.min(p.w - 20, 190), nx = p.x + p.w / 2 - nw / 2, ny = p.y + 9
    const brass = ctx.createLinearGradient(0, ny, 0, ny + 20)
    brass.addColorStop(0, '#d9b97f'); brass.addColorStop(0.5, '#a9844c'); brass.addColorStop(1, '#7a5d33')
    ctx.fillStyle = p.m.online ? brass : '#3b332a'; roundRect(nx, ny, nw, 20, 2); ctx.fill()
    ctx.fillStyle = p.m.online ? '#2a1d10' : '#81776a'; ctx.font = `700 10.5px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    let plate = spaced((p.m.online ? p.m.name : `${p.m.name} · closed`).toUpperCase())
    if (ctx.measureText(plate).width > nw - 10) { ctx.font = `700 9px ${MONO}`; plate = fit((p.m.online ? p.m.name : `${p.m.name} · closed`).toUpperCase(), nw - 10) }
    ctx.fillText(plate, p.x + p.w / 2, ny + 10.5)
    if (!p.m.online && p.m.since) { ctx.font = `9.5px ${MONO}`; ctx.fillStyle = '#6a6052'; ctx.fillText(`asleep since ${B.clock(p.m.since)}`, p.x + p.w / 2, p.y + p.h - 10) }
  }

  function jack(l, now) {
    const lamp = lineLamp(l.h)
    const closed = !l.panel.online
    const lit = lamp === 'flash' ? (reduced || Math.floor(now / 480) % 2 === 0) : lamp === 'ring' ? Math.floor(now / 120) % 2 === 0 : lamp !== 'off'
    const color = LAMP[lamp]
    const isSel = sel && ((sel.kind === 'line' && sel.id === l.h.id) || (sel.kind === 'cord' && desk.dispatches.find((d) => d.id === sel.id)?.harness === l.h.id))
    const dim = query && !desk.dispatches.some((d) => d.harness === l.h.id && matches(d)) && !`${l.h.name} ${l.h.project}`.toLowerCase().includes(query.toLowerCase())
    ctx.save()
    if (dim || closed) ctx.globalAlpha = 0.35
    // The lamp: a jewel above the jack.
    const ly = l.y - 16
    if (lit && color) {
      const glow = ctx.createRadialGradient(l.x, ly, 0, l.x, ly, 26)
      glow.addColorStop(0, hexa(color, lamp === 'green' ? 0.28 : 0.5)); glow.addColorStop(1, hexa(color, 0))
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(l.x, ly, 26, 0, Math.PI * 2); ctx.fill()
    }
    const jewel = ctx.createRadialGradient(l.x - 1.5, ly - 1.5, 0.5, l.x, ly, 6)
    if (lit && color) { jewel.addColorStop(0, '#fffaf0'); jewel.addColorStop(0.35, color); jewel.addColorStop(1, hexa(color, 0.55)) }
    else { jewel.addColorStop(0, '#4a3f36'); jewel.addColorStop(1, '#1d1814') }
    ctx.fillStyle = jewel; ctx.beginPath(); ctx.arc(l.x, ly, 5.5, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = 'rgba(201,164,106,.4)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(l.x, ly, 6.5, 0, Math.PI * 2); ctx.stroke()
    // The jack: a brass ring and its hole.
    const ring = ctx.createRadialGradient(l.x - 2, l.y - 2, 1, l.x, l.y, 8)
    ring.addColorStop(0, '#f0d39a'); ring.addColorStop(0.6, '#b58d52'); ring.addColorStop(1, '#5e4526')
    ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(l.x, l.y, 7.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#050403'; ctx.beginPath(); ctx.arc(l.x, l.y, 3.6, 0, Math.PI * 2); ctx.fill()
    // The designation strip.
    const cw = Math.min(l.w - 8, 86), cx = l.x - cw / 2, cy = l.y - 56
    ctx.fillStyle = isSel ? '#fff4d8' : '#d6ccb4'; ctx.fillRect(cx, cy, cw, 27)
    ctx.fillStyle = '#241c14'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.font = `700 9.5px ${MONO}`; ctx.fillText(String(l.num).padStart(2, '0'), cx + 4, cy + 3)
    ctx.font = `9px ${MONO}`; ctx.fillStyle = '#5b4d3a'
    const eng = B.engine(l.h.engine).short.toUpperCase()
    ctx.fillText(fit(eng, cw - 26), cx + 22, cy + 3.5)
    ctx.fillStyle = '#241c14'; ctx.font = `600 9px ${MONO}`
    ctx.fillText(fit(l.h.name.toUpperCase(), cw - 7), cx + 4, cy + 15)
    if (isSel) { ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 1.5; ctx.strokeRect(cx - 2, cy - 2, cw + 4, 31) }
    ctx.restore()
  }

  function shelf() {
    // The keyshelf: a slab of walnut, its top face toward the board.
    const y = shelfY
    const top = ctx.createLinearGradient(0, y, 0, y + 60)
    top.addColorStop(0, '#3a2618'); top.addColorStop(1, '#24170e')
    ctx.fillStyle = top
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W - 30, y); ctx.lineTo(W - 10, y + 60); ctx.lineTo(10, y + 60); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = 'rgba(201,164,106,.25)'; ctx.beginPath(); ctx.moveTo(30, y + 0.5); ctx.lineTo(W - 30, y + 0.5); ctx.stroke()
    const edge = ctx.createLinearGradient(0, y + 60, 0, y + 78)
    edge.addColorStop(0, '#1d120b'); edge.addColorStop(1, '#0c0705')
    ctx.fillStyle = edge; ctx.fillRect(10, y + 60, W - 20, 18)
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(10, y + 78, W - 20, 6)
  }

  function plugAt(p, now) {
    const d = p.d
    const lamp = lampOf(d)
    const color = LAMP[lamp]
    const lit = lamp === 'flash' ? (reduced || Math.floor(now / 480) % 2 === 0) : lamp === 'ring' ? Math.floor(now / 120) % 2 === 0 : lamp !== 'off'
    const isSel = sel?.kind === 'cord' && sel.id === d.id
    ctx.save()
    if (!matches(d)) ctx.globalAlpha = 0.25
    // Its supervisory lamp, behind the hole.
    const ly = shelfY + 14
    if (lit && color) { const g = ctx.createRadialGradient(p.x, ly, 0, p.x, ly, 18); g.addColorStop(0, hexa(color, 0.45)); g.addColorStop(1, hexa(color, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, ly, 18, 0, Math.PI * 2); ctx.fill() }
    ctx.fillStyle = lit && color ? color : '#2a211a'; ctx.beginPath(); ctx.arc(p.x, ly, 4, 0, Math.PI * 2); ctx.fill()
    // The hole the cord rises from.
    ctx.fillStyle = '#060403'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 7, 3.2, 0, 0, Math.PI * 2); ctx.fill()
    // A brass tag on the shelf's edge.
    ctx.fillStyle = isSel ? '#ffd38a' : '#b0905c'; ctx.font = `700 10px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`#${String(d.n).padStart(2, '0')}`, p.x, shelfY + 69)
    if (isSel) { ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p.x - 14, shelfY + 78); ctx.lineTo(p.x + 14, shelfY + 78); ctx.stroke() }
    ctx.restore()
  }

  function cord(p, now) {
    const d = p.d
    const l = lineOf(d.harness)
    const isSel = sel?.kind === 'cord' && sel.id === d.id
    const a = { x: p.x, y: p.y }
    let b
    let k = 1
    if (!l) {
      // Sent nowhere: the plug dangles, no line at the other end.
      const sway = reduced ? 0 : Math.sin(now / 900 + d.n) * 6
      b = { x: p.x + 18 + sway, y: p.y - 70 }
    } else {
      b = { x: l.x, y: l.y }
      const started = plugging.get(d.id)
      if (started) { k = Math.min(1, (now - started) / 900); if (k >= 1) plugging.delete(d.id) }
      const pulled = pulling.get(d.id)
      if (pulled) { k = 1 - Math.min(1, (now - pulled) / 700) }
      if (k < 1) { const e = 1 - Math.pow(1 - k, 3); b = { x: a.x + (b.x - a.x) * e, y: a.y - 40 + (b.y - a.y + 40) * e } }
    }
    const sway = reduced ? 0 : Math.sin(now / 1700 + d.n * 1.7) * 5
    const c1 = { x: a.x, y: a.y - 110 }
    const c2 = { x: b.x + sway + (a.x - b.x) * 0.12, y: b.y + 120 + Math.abs(a.x - b.x) * 0.08 }
    const lamp = lampOf(d)
    const body = isSel ? '#d5ab6a' : lamp === 'flash' ? '#6a4a1f' : lamp === 'red' ? '#5a2620' : lamp === 'white' ? '#5a5244' : '#3b2b1f'
    ctx.save()
    if (!matches(d)) ctx.globalAlpha = 0.18
    if (isSel && !reduced) { ctx.shadowColor = 'rgba(255,190,110,.6)'; ctx.shadowBlur = 12 }
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#0a0604'; ctx.lineWidth = 7; bez(a, c1, c2, b); ctx.stroke()
    ctx.shadowBlur = 0
    ctx.strokeStyle = body; ctx.lineWidth = 5; bez(a, c1, c2, b); ctx.stroke()
    ctx.strokeStyle = 'rgba(255,230,190,.16)'; ctx.lineWidth = 1.2; bez({ x: a.x - 1.2, y: a.y }, { x: c1.x - 1.2, y: c1.y }, { x: c2.x - 1.2, y: c2.y }, { x: b.x - 1.2, y: b.y }); ctx.stroke()
    // The plug: a brass sleeve in the jack, or dangling.
    ctx.translate(b.x, b.y)
    const ang = Math.atan2(b.y - c2.y, b.x - c2.x) + Math.PI / 2
    ctx.rotate(ang)
    const sleeve = ctx.createLinearGradient(-4, 0, 4, 0)
    sleeve.addColorStop(0, '#7a5d33'); sleeve.addColorStop(0.5, '#e6c58a'); sleeve.addColorStop(1, '#6e5330')
    ctx.fillStyle = sleeve; ctx.fillRect(-4, 0, 8, 15)
    ctx.fillStyle = '#1a120c'; ctx.fillRect(-3.2, 15, 6.4, 7)
    if (!l) { ctx.fillStyle = '#e8d7b0'; ctx.fillRect(-1.2, -5, 2.4, 6) }
    ctx.restore()
    if (!l) { ctx.font = `600 9.5px ${MONO}`; ctx.fillStyle = '#ff7a6f'; ctx.textAlign = 'left'; ctx.fillText('NO CIRCUIT', b.x + 12, b.y + 4) }
    return { a, c1, c2, b }
  }

  function ghost(p, now) {
    // Where ⌘B nearly sent it: the runner-up line, as a cord that was never plugged.
    const r = p.d.decision?.runnerUp
    if (!r) return
    const l = lines.find((x) => x.h.name === r.name && x.h.id !== p.d.harness)
    if (!l) return
    const a = { x: p.x, y: p.y }, b = { x: l.x, y: l.y }
    ctx.save()
    ctx.setLineDash([3, 6]); ctx.strokeStyle = 'rgba(255,214,150,.42)'; ctx.lineWidth = 1.4
    bez(a, { x: a.x, y: a.y - 110 }, { x: b.x, y: b.y + 140 }, b); ctx.stroke()
    ctx.setLineDash([])
    ctx.font = `600 10px ${MONO}`; ctx.fillStyle = 'rgba(255,214,150,.8)'; ctx.textAlign = 'center'
    ctx.fillText(`next best ${r.p.toFixed(2)}`, b.x, b.y + 26)
    ctx.restore()
  }

  function frame() {
    const now = Date.now()
    desk.now = now
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    wood()
    for (const p of panels) panel(p, now)
    for (const l of lines) jack(l, now)
    shelf()
    for (const p of plugs) plugAt(p, now)
    const chosen = plugs.find((p) => sel?.kind === 'cord' && p.d.id === sel.id)
    // Cords: the selected one last, on top; its ghost under it.
    let selGeo = null
    for (const p of plugs) if (p !== chosen) cord(p, now)
    if (chosen) { ghost(chosen, now); selGeo = cord(chosen, now) }
    if (chosen && selGeo && chosen.d.decision?.p != null) {
      const m = point(selGeo, 0.42)
      const text = `Jev ${chosen.d.decision.p.toFixed(2)}`
      ctx.font = `700 10.5px ${MONO}`; const w = ctx.measureText(text).width + 12
      ctx.fillStyle = '#e9e0cb'; ctx.fillRect(m.x - w / 2, m.y - 9, w, 18)
      ctx.fillStyle = '#241c14'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, m.x, m.y + 0.5)
    }
    for (const [id, t] of pulling) if (now - t > 700) pulling.delete(id)
    requestAnimationFrame(frame)
  }

  function bez(a, c1, c2, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y) }
  function point({ a, c1, c2, b }, t) {
    const u = 1 - t
    return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y }
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  function fit(text, width) { if (ctx.measureText(text).width <= width) return text; let t = text; while (t.length > 1 && ctx.measureText(t + '…').width > width) t = t.slice(0, -1); return t + '…' }
  const spaced = (t) => t.split('').join(' ')
  function hexa(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }

  // ── the header and the toll ticket ─────────────────────────────────────────────────────────────────

  function header() {
    const cords = desk.dispatches.filter(active)
    const count = (lamp) => cords.filter((d) => lampOf(d) === lamp).length
    const box = $('lamps'); box.replaceChildren()
    box.append('operator ⌘B')
    for (const [lamp, word] of [['flash', 'flashing for you'], ['white', 'hung up, pull the cord'], ['red', 'trouble'], ['green', 'talking']]) {
      const n = count(lamp)
      const dot = el('i'); dot.style.background = n ? LAMP[lamp] : '#3a2f26'; if (n) dot.style.boxShadow = `0 0 8px ${LAMP[lamp]}`
      box.append(dot, el('b', null, String(n)), ` ${word}`)
    }
    const down = desk.dispatches.length - cords.length
    box.append(`   ·   ${down} cords down`)
    $('clock').textContent = `${new Date(desk.now).toLocaleTimeString('en-GB')} · ${desk.real ? 'your desk' : 'an invented desk'}`
  }

  function ticket() {
    const t = $('ticket')
    t.replaceChildren()
    if (!sel) { t.classList.remove('on'); return }
    t.classList.add('on')
    const EDGE = { flash: ['#d98a1c', '#8a5310'], white: ['#9a8e74', '#5d523f'], red: ['#c23b33', '#8f241e'], green: ['#3f9a59', '#2d6d40'], ring: ['#d98a1c', '#8a5310'], off: ['#8a7a5a', '#6e604a'] }
    if (sel.kind === 'line') {
      const l = lines.find((x) => x.h.id === sel.id)
      if (!l) { t.classList.remove('on'); return }
      const lamp = lineLamp(l.h)
      t.style.setProperty('--edge', EDGE[lamp][0]); t.style.setProperty('--edge-ink', EDGE[lamp][1])
      const no = el('div', 'no'); no.append(el('div', 't', 'LINE'), el('div', 'n', String(l.num).padStart(2, '0')), el('div', 's', B.STATES[l.h.state]?.label ?? l.h.state))
      const body = el('div', 'body'); body.append(el('div', 'said', l.h.name))
      const row = (k, v) => { const r = el('div', 'row'); r.append(el('b', null, k), el('span', null, v)); body.append(r) }
      row('line', `${B.engine(l.h.engine).name} · ${l.h.project} on ${l.panel.name}`)
      row('calls', 'no task of yours is on this line: you started it by hand, or ⌘B never sent to it')
      if (l.h.summary) body.append(el('div', 'line', l.h.summary))
      t.append(no, body)
      return
    }
    const d = desk.dispatches.find((x) => x.id === sel.id)
    if (!d) { t.classList.remove('on'); return }
    const h = B.harness(d.harness), l = lineOf(d.harness)
    const lamp = lampOf(d)
    t.style.setProperty('--edge', EDGE[lamp][0]); t.style.setProperty('--edge-ink', EDGE[lamp][1])
    const WORD = { flash: 'flashing', white: 'hung up', red: 'trouble', green: 'talking', ring: 'ringing', off: 'cleared' }
    const no = el('div', 'no'); no.append(el('div', 't', 'TOLL TICKET'), el('div', 'n', `#${String(d.n).padStart(2, '0')}`), el('div', 's', WORD[lamp]))
    const body = el('div', 'body')
    body.append(el('div', 'said', `“${d.text}”`))
    const row = (k, v) => { const r = el('div', 'row'); r.append(el('b', null, k), el('span', null, v)); body.append(r) }
    row('called', h ? `line ${String(l?.num ?? 0).padStart(2, '0')} · ${h.name} · ${B.engine(h.engine).short} · ${h.project} on ${d.machine}${d.created ? ' (a new line)' : ''}` : 'no line: nothing was connected')
    const dec = d.decision
    row('operator', dec.kind === 'session' ? `⌘B, by Jev ${dec.p?.toFixed(2) ?? ''}: the same work on the same subject${dec.runnerUp ? ` · next best “${dec.runnerUp.name}” ${dec.runnerUp.p.toFixed(2)}` : ''}`
      : dec.kind === 'new' ? `⌘B, by Jev ${dec.p?.toFixed(2) ?? ''}: ${dec.why}${dec.runnerUp ? ` · next best “${dec.runnerUp.name}” ${dec.runnerUp.p.toFixed(2)}` : ''}`
        : dec.kind === 'direct' ? 'none: you typed it into the line yourself'
          : dec.kind === 'routing' ? '⌘B, deciding…' : `⌘B could not connect it: ${d.error}`)
    const words = d.question ?? d.summary ?? d.error
    if (words && (listening || d.state === 'asking' || d.state === 'done' || d.state === 'failed')) body.append(el('div', 'line', `${d.state === 'asking' ? 'on the line, asking: ' : ''}${words}`))
    if (listening && h) {
      const c = el('canvas', 'wave'); body.append(c)
      requestAnimationFrame(() => wave(c, h, d))
    }
    const stamp = el('div', 'stamp')
    const st = (k, v) => { const r = el('div'); r.append(el('span', null, k), el('b', null, v)); stamp.append(r) }
    st('placed', B.clock(d.at))
    if (d.landedAt) st('connected', `${B.clock(d.landedAt)}${dec.ms ? ` · ${(dec.ms / 1000).toFixed(2)}s` : ''}`)
    if (d.state !== 'working' && d.state !== 'routing') st(WORD[lamp], B.clock(d.since))
    st('elapsed', B.ago(desk.now - d.at))
    if (h) st('turns since', String(h.turns.filter((x) => x.at >= d.at).length))
    const keys = el('div', 'keys')
    const k = lamp === 'white' ? [['p', 'pull the cord (read)'], ['⏎', 'listen in']] : lamp === 'flash' ? [['r', 'ring the line'], ['→', 'answer in the chat']] : [['⏎', 'listen in'], ['r', 'ring the line']]
    k.forEach(([a, b], i) => { if (i) keys.append(el('br')); keys.append(el('kbd', null, a), ` ${b}`) })
    stamp.append(keys)
    t.append(no, body, stamp)
  }

  /** Listening in: the call's rhythm since it was placed, your turns above the line, its below. */
  function wave(c, h, d) {
    const r = c.getBoundingClientRect()
    c.width = r.width * DPR; c.height = r.height * DPR
    const g = c.getContext('2d'); g.scale(DPR, DPR)
    const from = d.at, to = d.state === 'working' || d.state === 'asking' ? desk.now : Math.max(d.since, d.at + 60000)
    g.strokeStyle = 'rgba(36,28,20,.25)'; g.beginPath(); g.moveTo(0, r.height / 2); g.lineTo(r.width, r.height / 2); g.stroke()
    for (const t of h.turns) {
      if (t.at < from || t.at > to) continue
      const x = ((t.at - from) / (to - from)) * r.width
      const len = Math.min(r.height / 2 - 1, 3 + Math.sqrt(t.size) / 8)
      g.strokeStyle = t.by === 'you' ? '#a3501b' : '#241c14'; g.lineWidth = t.by === 'you' ? 2 : 1.2
      g.beginPath(); g.moveTo(x, r.height / 2); g.lineTo(x, r.height / 2 + (t.by === 'you' ? -len : len)); g.stroke()
    }
  }

  // ── keys ───────────────────────────────────────────────────────────────────────────────────────────

  function order() { return plugs.map((p) => p.d).filter(matches) }
  function choose(next) { sel = next; listening = false; ticket() }
  function step(n) {
    const list = order()
    if (!list.length) return
    const i = sel?.kind === 'cord' ? list.findIndex((d) => d.id === sel.id) : -1
    choose({ kind: 'cord', id: list[i < 0 ? 0 : (i + n + list.length) % list.length].id })
  }
  function nextLamp(lamp) {
    const list = order().filter((d) => lampOf(d) === lamp)
    if (!list.length) return toast(`no cord is ${{ flash: 'flashing', white: 'hung up', red: 'in trouble' }[lamp]}`)
    const i = sel?.kind === 'cord' ? list.findIndex((d) => d.id === sel.id) : -1
    choose({ kind: 'cord', id: list[(i + 1) % list.length].id })
  }
  function dial(digit) {
    dialed = (dialed + digit).slice(-3)
    $('dial').textContent = `☎ ${dialed}`; $('dial').classList.add('on')
    clearTimeout(dialTimer)
    dialTimer = setTimeout(() => {
      $('dial').classList.remove('on')
      const l = lines.find((x) => x.num === Number(dialed))
      dialed = ''
      if (!l) return toast('no such line')
      const cords = desk.dispatches.filter((d) => d.harness === l.h.id && active(d)).sort((a, b) => RANK[lampOf(a)] - RANK[lampOf(b)])
      choose(cords.length ? { kind: 'cord', id: cords[0].id } : { kind: 'line', id: l.h.id })
    }, 700)
  }
  function pull() {
    const d = sel?.kind === 'cord' && desk.dispatches.find((x) => x.id === sel.id)
    if (!d) return
    if (lampOf(d) !== 'white') return toast(lampOf(d) === 'flash' ? 'the line is flashing for you: answer it first' : 'the call is still on')
    pulling.set(d.id, Date.now())
    const list = order(), i = list.findIndex((x) => x.id === d.id)
    setTimeout(() => { B.markSeen(d.id); const nxt = order().filter((x) => x.id !== d.id)[Math.min(i, list.length - 2)]; layout(); choose(nxt ? { kind: 'cord', id: nxt.id } : null); header() }, 650)
    toast(`#${String(d.n).padStart(2, '0')} cleared · cord down`)
  }
  function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2300) }

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
    if (/^[0-9]$/.test(e.key)) { dial(e.key); e.preventDefault(); return }
    switch (e.key) {
      case 'ArrowRight': case 'l': case 'Tab': step(e.shiftKey ? -1 : 1); break
      case 'ArrowLeft': case 'h': step(-1); break
      case 'n': nextLamp('flash'); break
      case 'w': nextLamp('white'); break
      case 'x': nextLamp('red'); break
      case 'Enter': if (!sel) step(1); listening = !listening; ticket(); break
      case 'p': pull(); break
      case 'r': { const d = sel?.kind === 'cord' && desk.dispatches.find((x) => x.id === sel.id); toast(d?.harness ? `would ring “${B.harness(d.harness)?.name}”: its pane comes forward` : 'pick a cord first'); break }
      case 'ArrowDown': case 'j': nextLamp('flash'); break
      case 'ArrowUp': case 'k': nextLamp('white'); break
      case '/': query = ''; typing = true; $('find').classList.add('on'); $('q').textContent = ''; break
      case 'Escape': if (query) { query = null; $('find').classList.remove('on') } else choose(null); break
      default: return
    }
    e.preventDefault()
  })
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    const p = plugs.find((q) => Math.abs(q.x - x) < 16 && y > shelfY - 4 && y < shelfY + 84)
    if (p) return choose({ kind: 'cord', id: p.d.id })
    const l = lines.find((q) => Math.abs(q.x - x) < q.w / 2 && y > q.y - 60 && y < q.y + 14)
    if (l) { const cords = desk.dispatches.filter((d) => d.harness === l.h.id && active(d)).sort((a, b) => RANK[lampOf(a)] - RANK[lampOf(b)]); return choose(cords.length ? { kind: 'cord', id: cords[0].id } : { kind: 'line', id: l.h.id }) }
  })

  function keysLine() {
    const parts = [['← →', 'cords'], ['n', 'next flashing'], ['w', 'next hung up'], ['x', 'trouble'], ['0–9', 'dial a line'], ['⏎', 'listen in'], ['p', 'pull the cord'], ['r', 'ring'], ['/', 'find']]
    parts.forEach(([k, w], i) => { if (i) $('keys').append('  ·  '); $('keys').append(el('kbd', null, k), ` ${w}`) })
  }

  B.load().then((d) => {
    desk = d
    $('loading').remove()
    layout()
    keysLine()
    const first = order().sort((a, b) => RANK[lampOf(a)] - RANK[lampOf(b)] || a.since - b.since)[0]
    const pick = new URLSearchParams(location.search).get('select')
    if (pick) sel = { kind: 'cord', id: pick }
    else if (first) sel = { kind: 'cord', id: first.id }
    header(); ticket()
    B.subscribe((_, event) => {
      if (event.type === 'landed') { layout(); plugging.set(event.dispatch, Date.now()) }
      if (['dispatch', 'landed', 'done', 'asking', 'refresh', 'seen', 'unseen'].includes(event.type)) { layout(); header(); ticket() }
      if (event.type === 'tick' && Date.now() % 10000 < 1000) header()
    })
    addEventListener('resize', () => layout())
    requestAnimationFrame(frame)
  }).catch((error) => { $('loading').textContent = `could not read the desk: ${error.message}` })
})()
