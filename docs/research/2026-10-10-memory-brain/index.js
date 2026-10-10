// The lookbook: one card per prototype. Opened by serve.mjs, each card also opens on your own memories.
(function () {
  'use strict'
  const served = location.protocol.startsWith('http')
  const real = /[?&]real\b/.test(location.search)
  const PROTOTYPES = [
    ['synapse', 'Synapse', 'The Cell · Lucy · neural imaging',
      'Fly into a brain grown from your messages. Memories are bright engrams, projects are regions, About You sits at the core. Type, and recall spreads through it as light. Scrub time and watch it grow.',
      'type to recall · ←→ orbit · ↑↓ fly · enter dive · esc back · [ ] time · \\ replay'],
    ['self', 'Sense of Self', 'Inside Out 2',
      'About You hangs above as a luminous structure, one strand per belief. Below, the lake of memories. Threads rise from each memory to the beliefs it holds up: pluck one and see why your agents believe it.',
      'type to recall · ←→ branches · ↑↓ beliefs · space pluck · enter into the lake'],
    ['palace', 'Mind Palace', 'Sherlock · method of loci · Westworld',
      'Walk the halls in first person, drawn in light. About You is carved in the atrium; every project is a wing; old rooms gather dust and lose letters. Type, and words float up around you.',
      'type to recall · ↑↓ walk · ←→ turn · enter go in or read · tab map · ~ home'],
    ['tesseract', 'Tesseract', 'Interstellar',
      'Your months unrolled as a corridor of days. Each day holds what you said and what your agents wrote down. Strings tie a memory to every day it came up: pull one and the corridor lights.',
      'type to recall · ↑↓ days · shift weeks · ←→ messages · space pull · ~ about you'],
  ]
  const SHOTS = { synapse: 'synapse.png', self: 'self.jpg', palace: 'palace.jpg', tesseract: 'tesseract.png' }
  const mode = document.getElementById('mode')
  if (!served) mode.textContent = 'Opened as a file: invented memories. Run serve.mjs (see README.md) to open them on your own.'
  else if (real) mode.append('Showing your own memories on this computer. ', Object.assign(document.createElement('a'), { href: './', textContent: 'Show the invented person instead' }))
  else mode.append('Showing an invented person. ', Object.assign(document.createElement('a'), { href: './?real', textContent: 'Open them on your own memories' }))
  const grid = document.getElementById('grid')
  for (const [id, name, film, says, keys] of PROTOTYPES) {
    const card = document.createElement('article')
    card.className = 'card'
    const href = `${id}.html${real ? '?real' : ''}`
    const shot = Object.assign(document.createElement('a'), { className: 'shot', href, title: `Open ${name}` })
    shot.style.backgroundImage = `url("${SHOTS[id]}")`
    const body = document.createElement('div')
    body.className = 'body'
    const title = Object.assign(document.createElement('h2'), { textContent: name })
    const from = Object.assign(document.createElement('div'), { className: 'film', textContent: film })
    const text = Object.assign(document.createElement('p'), { textContent: says })
    const hint = Object.assign(document.createElement('div'), { className: 'keys', textContent: keys })
    const open = document.createElement('div')
    open.className = 'open'
    open.append(Object.assign(document.createElement('a'), { href: `${id}.html`, textContent: 'open' }))
    if (served) open.append(Object.assign(document.createElement('a'), { className: 'real', href: `${id}.html?real`, textContent: 'open on my memories' }))
    body.append(title, from, text, hint, open)
    card.append(shot, body)
    grid.append(card)
  }
})()
