// The Pass: ⌘B's office as a restaurant's expo station. Every task you handed off is a ticket the printer
// fires onto the rail. A cook with a question flags it for the chef. Finished work comes up on the pass
// under the heat lamps and waits for you to pick it up — and, like a plate, it dies in the window if you
// leave it there. Read ones go on the spike; failed ones are 86'd on the board. The bump bar is the
// keyboard.
(function () {
  'use strict'
  const B = window.BossData
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const ZONES = ['rail', 'pass', 'spike', 'board']
  let desk = null
  let zone = 'pass', sel = null
  let query = null, typing = false
  let reading = false
  const bumped = []
  const fresh = new Set()
  let toastTimer = 0

  // ── what is where ──────────────────────────────────────────────────────────────────────────────────

  function zoneOf(d) {
    if (['routing', 'working', 'asking', 'offline'].includes(d.state)) return 'rail'
    if (d.state === 'done' && !d.seenAt) return 'pass'
    if (d.state === 'failed' || d.state === 'undelivered') return 'board'
    return 'spike'
  }
  const matches = (d) => {
    if (!query) return true
    const h = B.harness(d.harness)
    const hay = `#${d.n} ${d.text} ${h?.name ?? ''} ${h?.project ?? ''} ${d.machine ?? ''} ${d.question ?? ''} ${d.summary ?? ''} ${d.error ?? ''}`.toLowerCase()
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
  }
  function items(z) {
    const list = desk.dispatches.filter((d) => zoneOf(d) === z)
    if (z === 'rail') return list.sort((a, b) => a.at - b.at)
    if (z === 'pass') return list.sort((a, b) => a.since - b.since)
    if (z === 'spike') return list.sort((a, b) => (b.seenAt ?? b.since) - (a.seenAt ?? a.since))
    return list.sort((a, b) => b.at - a.at)
  }
  const span = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000))
    return m < 60 ? `0:${String(m).padStart(2, '0')}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }
  const upper = (t) => String(t ?? '').toUpperCase()
  const via = (d) => {
    const dec = d.decision
    if (dec.kind === 'routing') return '⌘B · DECIDING…'
    if (dec.kind === 'none') return '⌘B · SENT NOWHERE'
    if (dec.kind === 'direct') return 'TYPED IN THE PANE'
    const p = dec.p != null ? ` · JEV ${dec.p.toFixed(2).replace(/^0/, '')}` : ''
    return dec.kind === 'new' ? `⌘B · NEW${p}` : `⌘B · SAME WORK${p}`
  }

  // ── tickets ────────────────────────────────────────────────────────────────────────────────────────

  function ticket(d, now) {
    const h = B.harness(d.harness)
    const t = el('article', 'ticket')
    t.dataset.id = d.id
    const hd = el('div', 'hd'); hd.append(el('span', null, `#${String(d.n).padStart(2, '0')}`), el('span', 'at', B.clock(d.at)))
    t.append(hd, el('div', 'meta', h ? upper(h.project) : 'NO STATION'), el('div', 'meta', h ? upper(d.machine) : ''))
    t.append(el('hr'))
    const order = el('div', 'order'); order.append(el('span', null, '1'), el('span', 'what', upper(d.text)))
    t.append(order, el('hr'))
    t.append(el('div', 'cook', h ? `${upper(B.engine(h.engine).short)} · ${upper(h.name)}` : '—'))
    t.append(el('div', 'cook', via(d)))
    const timer = el('div', 'timer')
    if (d.state === 'asking') {
      const wait = now - d.since
      timer.classList.add(wait > 10 * B.MIN ? 'red' : 'amber')
      timer.append(el('span', null, 'WAITING'), span(wait))
      t.append(el('div', 'flag', 'CHEF?'), el('div', 'chit', d.question))
      if (!reduced) t.classList.add('swing')
    } else if (d.state === 'offline') {
      timer.style.background = '#55534e'
      timer.append(el('span', null, 'STATION CLOSED'), span(now - d.since))
    } else if (d.state === 'routing') {
      timer.style.background = '#3a3f45'
      timer.append(el('span', null, 'FIRING'), '0:00')
    } else {
      const on = now - (d.landedAt ?? d.at)
      timer.classList.add(on > 2 * B.HOUR ? 'amber' : 'green')
      timer.append(el('span', null, 'ON THE LINE'), span(on))
    }
    t.append(timer)
    if (d.id === sel) t.classList.add('sel')
    if (!matches(d)) t.classList.add('dim')
    if (fresh.has(d.id)) { t.classList.add('new'); fresh.delete(d.id) }
    t.addEventListener('click', () => { pick('rail', d.id); open() })
    return t
  }

  function plate(d, now) {
    const h = B.harness(d.harness)
    const p = el('article', 'plate')
    p.dataset.id = d.id
    const sat = now - d.since
    // Warm under the lamp at first; past three hours it is dying in the window, past eight it is cold.
    const k = Math.min(1, Math.max(0, (sat - 0.5 * B.HOUR) / (8 * B.HOUR)))
    p.style.setProperty('--warm', String(0.26 * (1 - k) + 0.02))
    p.style.setProperty('--sat', String(1 - 0.35 * k))
    p.style.setProperty('--hue', `${-14 * k}deg`)
    if (sat > 3 * B.HOUR) p.classList.add('cold')
    const hd = el('div', 'hd'); hd.append(el('span', null, `#${String(d.n).padStart(2, '0')} · ${upper(h?.project ?? '')}`))
    p.append(hd, el('div', 'order', upper(d.text)), el('div', 'result', d.summary ?? ''))
    p.append(el('div', 'state', sat > 3 * B.HOUR ? 'DYING IN THE WINDOW' : sat < 30 * B.MIN ? 'JUST UP' : 'UP'))
    const up = el('div', 'up')
    up.append(el('span', null, `${span(sat)} in the window · ${d.machine ?? ''}`), el('span', 'stamp', d.pr ? `PR #${d.pr}` : 'UP'))
    p.append(up)
    if (sat < 2 * B.HOUR && !reduced) {
      const steam = el('div', 'steam')
      for (let i = 0; i < 4; i++) { const w = el('i'); w.style.left = `${18 + i * 22}%`; w.style.animationDelay = `${i * 0.7}s`; steam.append(w) }
      p.append(steam)
    }
    if (d.id === sel) p.classList.add('sel')
    if (!matches(d)) p.classList.add('dim')
    p.addEventListener('click', () => { pick('pass', d.id); open() })
    return p
  }

  // ── the whole kitchen ──────────────────────────────────────────────────────────────────────────────

  function rects() {
    const out = new Map()
    for (const e of document.querySelectorAll('[data-id]')) out.set(e.dataset.id, e.getBoundingClientRect())
    return out
  }
  function flip(before) {
    if (reduced) return
    for (const e of document.querySelectorAll('[data-id]')) {
      const was = before.get(e.dataset.id)
      if (!was) continue
      const now = e.getBoundingClientRect()
      const dx = was.left - now.left, dy = was.top - now.top
      if (Math.abs(dx) + Math.abs(dy) < 2) continue
      e.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 650, easing: 'cubic-bezier(.2,.7,.2,1)' })
    }
  }

  function render() {
    const before = rects()
    const now = desk.now
    // All day: the expo's count of everything on.
    const n = Object.fromEntries(ZONES.map((z) => [z, items(z)]))
    const asking = n.rail.filter((d) => d.state === 'asking').length
    const all = $('allday'); all.replaceChildren(el('span', 'k', 'ALL DAY'))
    const part = (text, cls) => all.append(cls ? el('b', cls, text) : text)
    part(`${n.rail.length - asking} FIRED`); part(' · ')
    part(`${asking} NEED YOU`, asking ? 'hands' : ''); part(' · ')
    part(`${n.pass.length} UP`, n.pass.length ? 'up' : ''); part(' · ')
    part(`${n.board.length} 86'D`, n.board.length ? 'x86' : '')
    const first = desk.dispatches.reduce((m, d) => Math.min(m, d.at), now)
    $('clock').replaceChildren(el('div', null, new Date(now).toLocaleTimeString('en-GB')), el('div', null, `${desk.real ? 'your desk' : 'an invented desk'} · service ${B.ago(now - first)}`))
    for (const z of ZONES) $(z).classList.toggle('cur', z === zone)

    // The rail: tickets overlap like real ones when the rail is full.
    const rail = $('railtickets')
    const width = rail.getBoundingClientRect().width
    const list = n.rail
    const tw = Math.max(150, Math.min(184, width / Math.max(1, list.length) - 12))
    const step = list.length > 1 ? Math.min(tw + 14, (width - tw) / (list.length - 1)) : 0
    rail.replaceChildren(...list.map((d, i) => {
      const t = ticket(d, now)
      t.style.setProperty('--tw', `${tw}px`)
      t.style.left = `${i * step}px`
      t.style.zIndex = String(d.state === 'asking' ? 20 + i : 1 + i)
      return t
    }))
    $('printer').classList.toggle('on', list.some((d) => d.state === 'routing'))

    // The pass, its lamps over it.
    const plates = $('passplates')
    plates.replaceChildren(...n.pass.map((d) => plate(d, now)))
    const passBox = $('pass').getBoundingClientRect()
    const lamps = $('lamps')
    const count = Math.max(2, Math.min(5, Math.round(passBox.width / 300)))
    lamps.replaceChildren(...Array.from({ length: count }, (_, i) => { const l = el('div', 'lamp'); l.style.left = `${((i + 0.5) / count) * 100}%`; return l }))
    $('pass').querySelector('.empty')?.remove()
    if (!n.pass.length) $('pass').append(el('div', 'empty', 'nothing up · the pass is clear'))

    // The spike: newest on top.
    const spiked = $('spiked')
    const shown = n.spike.slice(0, 9)
    spiked.replaceChildren(...shown.map((d, i) => {
      const s = el('div', 'stub', `#${String(d.n).padStart(2, '0')} ${d.state === 'stopped' ? 'STOPPED · ' : ''}${upper(d.text)}`)
      s.dataset.id = d.id
      s.style.top = `${48 + (shown.length - 1 - i) * 15}px`
      s.style.rotate = `${(((d.n * 37) % 11) - 5) * 0.9}deg`
      s.style.zIndex = String(20 - i)
      if (d.id === sel) s.classList.add('sel')
      s.addEventListener('click', () => { pick('spike', d.id); open() })
      return s
    }))
    $('spikecount').textContent = `${n.spike.filter((d) => d.state === 'done').length} picked up · ${n.spike.filter((d) => d.state === 'stopped').length} stopped`

    // The 86 board.
    const slate = $('slate')
    slate.replaceChildren(...(n.board.length ? n.board.map((d) => {
      const r = el('div', 'row86')
      r.dataset.id = d.id
      r.append(el('span', 'no', `86 #${String(d.n).padStart(2, '0')}`), d.text)
      r.append(el('span', 'why', d.error ?? ''))
      if (d.id === sel) r.classList.add('sel')
      r.addEventListener('click', () => { pick('board', d.id); open() })
      return r
    }) : [el('div', 'none', 'nothing 86’d')]))

    // Stations: every cook on every machine, lit by what they are doing.
    const crew = $('crew')
    crew.replaceChildren(...desk.machines.map((m) => {
      const cooks = desk.harnesses.filter((h) => h.machine === m.id && h.state !== 'stopped')
      const st = el('div', `st${m.online ? '' : ' closed'}`)
      st.append(el('b', null, m.name), el('span', 'n', m.online ? `${cooks.filter((h) => h.state === 'working').length} cooking · ${cooks.length} on` : `closed ${m.since ? B.clock(m.since) : ''}`))
      const row = el('div', 'cooks')
      for (const h of cooks) { const c = el('span', `cook ${h.state}`); c.title = `${h.name} · ${B.STATES[h.state]?.word ?? h.state}`; row.append(c) }
      st.append(row)
      return st
    }))
    flip(before)
    document.querySelector(`.plate.sel`)?.scrollIntoView({ block: 'nearest' })
    if (reading) open()
  }

  // ── reading a ticket ──────────────────────────────────────────────────────────────────────────────

  function open() {
    const d = desk.dispatches.find((x) => x.id === sel)
    if (!d) return
    reading = true
    const h = B.harness(d.harness)
    const big = $('big')
    big.replaceChildren()
    const h1 = el('h1'); h1.append(el('span', null, `#${String(d.n).padStart(2, '0')}`), el('span', null, `${B.clock(d.at)} · ${B.ago(desk.now - d.at)} ago`))
    big.append(h1, el('div', 'meta', h ? `${d.machine} · ${h.project} · ${B.engine(h.engine).name}` : 'no station'), el('hr'), el('div', 'order', d.text), el('hr'))
    if (d.state === 'asking') big.append(el('div', 'said q', d.question))
    else if (d.error) big.append(el('div', 'said', d.error))
    else if (d.summary) big.append(el('div', 'said', d.summary))
    else big.append(el('div', 'said', `${B.STATES[d.state]?.word ?? d.state}…`))
    big.append(el('hr'))
    const line = (k, v) => { const r = el('div', 'line'); r.append(el('b', null, k), el('span', null, v)); big.append(r) }
    line('cook', h ? `${h.name} (${B.engine(h.engine).short})` : '—')
    const dec = d.decision
    line('⌘B', dec.kind === 'session' ? `sent to “${h?.name}”, already running${dec.p != null ? ` · Jev ${dec.p.toFixed(2)}` : ''}${dec.runnerUp ? `; next best “${dec.runnerUp.name}” ${dec.runnerUp.p.toFixed(2)}` : ''}${dec.ms ? ` · ${(dec.ms / 1000).toFixed(2)} s` : ''}`
      : dec.kind === 'new' ? `started “${h?.name}”: ${dec.why}${dec.p != null ? ` · Jev ${dec.p.toFixed(2)}` : ''}${dec.ms ? ` · ${(dec.ms / 1000).toFixed(2)} s` : ''}`
        : dec.kind === 'direct' ? 'typed into the harness itself, not through ⌘B'
          : dec.kind === 'routing' ? 'deciding…' : 'decided nothing, so nothing was sent')
    line('said by', d.via === 'voice' ? 'voice' : d.via === 'pane' ? 'keyboard, in the pane' : 'keyboard, ⌘B')
    if (h) line('since', `${h.turns.filter((t) => t.at >= d.at).length} turns · ${h.tokens >= 1e6 ? `${(h.tokens / 1e6).toFixed(1)}M` : `${Math.round(h.tokens / 1000)}k`} tokens in all`)
    const tl = el('div', 'tl')
    const WORD = { routing: 'fired', working: 'on the line', asking: 'chef?', done: 'up', failed: "86'd", undelivered: "86'd", offline: 'station closed', stopped: 'stopped' }
    for (const step of d.history) { const s = el('span'); s.append(`${WORD[step.state] ?? step.state} `, el('b', null, B.clock(step.at))); tl.append(s) }
    if (d.seenAt) { const s = el('span'); s.append('picked up ', el('b', null, B.clock(d.seenAt))); tl.append(s) }
    big.append(el('hr'), tl)
    const keys = el('div', 'keys')
    const z = zoneOf(d)
    const k = z === 'pass' ? [['b', 'pick it up'], ['←→', 'next plate'], ['esc', 'back']]
      : d.state === 'asking' ? [['→', 'answer it in the chat'], ['⏎', 'bring it forward'], ['esc', 'back']]
        : z === 'spike' ? [['r', 'back on the pass'], ['esc', 'back']] : [['←→', 'next ticket'], ['esc', 'back']]
    k.forEach(([a, b], i) => { if (i) keys.append('  ·  '); keys.append(el('kbd', null, a), ` ${b}`) })
    big.append(keys)
    $('read').classList.add('on')
  }
  function close() { reading = false; $('read').classList.remove('on') }

  // ── the bump bar ───────────────────────────────────────────────────────────────────────────────────

  function pick(z, id) { zone = z; sel = id; render() }
  function move(step) {
    const list = items(zone).filter(matches)
    if (!list.length) return
    const i = list.findIndex((d) => d.id === sel)
    sel = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + step))].id
    render()
  }
  function zoneStep(step) {
    let i = ZONES.indexOf(zone)
    for (let k = 0; k < ZONES.length; k++) {
      i = (i + step + ZONES.length) % ZONES.length
      const list = items(ZONES[i]).filter(matches)
      if (list.length) { zone = ZONES[i]; sel = list[0].id; render(); return }
    }
  }
  function bump() {
    const d = desk.dispatches.find((x) => x.id === sel)
    if (!d) return
    if (zoneOf(d) === 'pass') {
      const node = document.querySelector(`.plate[data-id="${CSS.escape(d.id)}"]`)
      const list = items('pass').filter(matches)
      const next = list[list.findIndex((x) => x.id === d.id) + 1] ?? list[list.findIndex((x) => x.id === d.id) - 1]
      const go = () => { bumped.push(d.id); B.markSeen(d.id); sel = next?.id ?? null; if (!next) zoneStep(1); toast(`#${String(d.n).padStart(2, '0')} picked up · heard`) }
      if (node && !reduced) { node.classList.add('bumped'); setTimeout(go, 420) } else go()
    } else if (d.state === 'asking') toast('the cook is asking you: answer it in the chat →')
    else if (zoneOf(d) === 'rail') toast('still on the line')
    else toast('nothing to pick up')
  }
  function recall() {
    const id = bumped.pop() ?? (zoneOf(desk.dispatches.find((x) => x.id === sel) ?? {}) === 'spike' ? sel : null)
    const d = desk.dispatches.find((x) => x.id === id)
    if (!d || d.state !== 'done') return toast('nothing to recall')
    B.unseen(id); zone = 'pass'; sel = id; render(); toast(`#${String(d.n).padStart(2, '0')} recalled to the pass`)
  }
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('on')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2400)
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (typing) {
      if (e.key === 'Escape') { query = null; typing = false }
      else if (e.key === 'Enter') typing = false
      else if (e.key === 'Backspace') query = query.slice(0, -1)
      else if (e.key.length === 1) query += e.key
      else return
      e.preventDefault(); $('find').classList.toggle('on', query !== null); $('q').textContent = query ?? ''; render(); return
    }
    if (reading) {
      if (e.key === 'Escape' || e.key === 'q') close()
      else if (e.key === 'ArrowRight' || e.key === 'l') move(1)
      else if (e.key === 'ArrowLeft' || e.key === 'h') move(-1)
      else if (e.key === 'b' || e.key === ' ') { bump(); if (zoneOf(desk.dispatches.find((x) => x.id === sel) ?? {}) !== 'pass') close() }
      else if (e.key === 'r') { close(); recall() }
      else if (e.key === 'Enter') toast('would bring it forward in its pane')
      else return
      e.preventDefault(); return
    }
    if (/^[1-9]$/.test(e.key)) { const list = items(zone).filter(matches); const d = list[Number(e.key) - 1]; if (d) { sel = d.id; render() } e.preventDefault(); return }
    switch (e.key) {
      case 'ArrowRight': case 'l': move(1); break
      case 'ArrowLeft': case 'h': move(-1); break
      case 'ArrowDown': case 'j': zoneStep(1); break
      case 'ArrowUp': case 'k': zoneStep(-1); break
      case 'Enter': if (!sel) move(0); open(); break
      case 'b': case ' ': bump(); break
      case 'r': recall(); break
      case 'a': { const c = $('call'); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); break }
      case '/': query = ''; typing = true; $('find').classList.add('on'); $('q').textContent = ''; break
      case 'Escape': if (query) { query = null; $('find').classList.remove('on'); render() } else { sel = null; render() } break
      default: return
    }
    e.preventDefault()
  })
  $('read').addEventListener('click', (e) => { if (e.target === $('read')) close() })

  function keysLine() {
    const parts = [['← →', 'along'], ['↑ ↓', 'rail · pass · spike · 86'], ['1–9', 'ticket'], ['⏎', 'read'], ['b', 'pick up'], ['r', 'recall'], ['a', 'all day'], ['/', 'find']]
    const keys = $('keys')
    parts.forEach(([k, w], i) => { if (i) keys.append('  ·  '); keys.append(el('kbd', null, k), ` ${w}`) })
  }

  B.load().then((d) => {
    desk = d
    $('loading').remove()
    keysLine()
    const pick0 = new URLSearchParams(location.search).get('select')
    const start = (pick0 && desk.dispatches.find((x) => x.id === pick0)) ?? items('pass')[0] ?? items('rail')[0]
    if (start) { zone = zoneOf(start); sel = start.id }
    render()
    let last = 0
    B.subscribe((_, event) => {
      if (event.type === 'dispatch') fresh.add(event.dispatch)
      if (event.type === 'turn') return
      if (event.type === 'tick' && Date.now() - last < 15000) return
      last = Date.now()
      render()
    })
    addEventListener('resize', render)
  }).catch((error) => { $('loading').textContent = `could not read the desk: ${error.message}` })
})()
