// The lookbook: one card per prototype. Opened by serve.mjs, each card also opens on your own desk.
(function () {
  'use strict'
  const served = location.protocol.startsWith('http')
  const real = /[?&]real\b/.test(location.search)
  const PROTOTYPES = [
    ['approach', 'Approach', 'air traffic control · approach radar · flight strips',
      'the nearer the centre, the more it needs you',
      'You are the field. ⌘B is a departure; working tasks fly their machine’s sector, painted by the sweep. A task that asks you holds at its fix near the field, flashing. Finished ones line up on final, waiting for you to land them (read them). A failure squawks an emergency.',
      'tab next · h f e holding, final, emergency · ⏎ land · space land next · u undo · / find · s strips'],
    ['pass', 'The Pass', 'a restaurant’s expo station · the ticket rail · heat lamps',
      'finished work dies in the window if you leave it there',
      'Every handoff is a ticket the printer fires onto the rail. A cook with a question flags it: CHEF?. Finished work comes up on the pass under the heat lamps and cools while it waits for you. Read ones go on the spike; failed ones are 86’d on the board. The expo calls it all day.',
      '← → along · ↑ ↓ rail, pass, spike, 86 · 1–9 ticket · ⏎ read · b pick up · r recall · a all day'],
    ['switchboard', 'Switchboard', 'the cord switchboard · supervisory lamps · toll tickets',
      'where your words went, and how sure the operator was',
      '⌘B is an operator. Every harness on every machine is a line with a jack and a lamp; every task is a cord from the keyshelf to the line that took it. Flashing wants you, steady white means hung up: pull the cord. The toll ticket shows Jev’s confidence, and a ghost cord the line it nearly chose.',
      '← → cords · n flashing · w hung up · 0–9 dial a line · ⏎ listen in · p pull the cord'],
    ['score', 'Score', 'a conductor’s full score · cutaway staves · fermatas',
      'what happened since you handed it off, read like music',
      'One staff per harness, grouped by machine like an orchestra by family; bars as wide as what happened in them, so the night folds up. Each task is a rehearsal mark with its cue. Turns are notes, beamed when fast. Finished work ends in a double bar and Fine; a fermata is held for you.',
      'j k staves · n next held · f next unread · [ ] cues · h l time · ⏎ the part · space play the night'],
  ]
  const mode = document.getElementById('mode')
  if (!served) mode.textContent = 'Opened as a file: an invented desk. Run serve.mjs (see README.md) to open them on your own.'
  else if (real) mode.append('Showing your own desk, read only. ', Object.assign(document.createElement('a'), { href: './', textContent: 'Show the invented desk instead' }))
  else mode.append('Showing an invented desk. ', Object.assign(document.createElement('a'), { href: './?real', textContent: 'Open them on your own desk' }))
  const grid = document.getElementById('grid')
  const cards = PROTOTYPES.map(([id, name, from, idea, says, keys], i) => {
    const card = document.createElement('article')
    card.className = 'card'
    const href = `${id}.html${real ? '?real' : ''}`
    const shot = Object.assign(document.createElement('a'), { className: 'shot', href, title: `Open ${name}` })
    shot.style.backgroundImage = `url("${id}.jpg")`
    const body = document.createElement('div')
    body.className = 'body'
    const title = document.createElement('h2')
    title.append(name, Object.assign(document.createElement('small'), { textContent: String(i + 1) }))
    body.append(title,
      Object.assign(document.createElement('div'), { className: 'from', textContent: from }),
      Object.assign(document.createElement('div'), { className: 'idea', textContent: idea }),
      Object.assign(document.createElement('p'), { textContent: says }),
      Object.assign(document.createElement('div'), { className: 'keys', textContent: keys }))
    const open = document.createElement('div')
    open.className = 'open'
    open.append(Object.assign(document.createElement('a'), { href: `${id}.html`, textContent: 'open' }))
    if (served) open.append(Object.assign(document.createElement('a'), { className: 'real', href: `${id}.html?real`, textContent: 'open on my desk' }))
    body.append(open)
    card.append(shot, body)
    grid.append(card)
    return { id, card }
  })
  let sel = 0
  const show = () => cards.forEach((c, i) => c.card.classList.toggle('sel', i === sel))
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (/^[1-4]$/.test(e.key)) { sel = Number(e.key) - 1; show() }
    else if (['ArrowRight', 'ArrowDown', 'j', 'l'].includes(e.key)) { sel = (sel + 1) % cards.length; show() }
    else if (['ArrowLeft', 'ArrowUp', 'k', 'h'].includes(e.key)) { sel = (sel + cards.length - 1) % cards.length; show() }
    else if (e.key === 'Enter') location.href = `${cards[sel].id}.html${real ? '?real' : ''}`
    else if (e.key === 'r' && served) location.href = `${cards[sel].id}.html?real`
    else return
    e.preventDefault()
  })
  show()
})()
