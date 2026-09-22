// Progressive enhancement. The generated HTML remains readable without JavaScript
// and opens directly from disk; only local media is used, with no fetch or service.
;(() => {
  const panels = [...document.querySelectorAll('.experience')]
  const picker = [...document.querySelectorAll('.crafts [data-experience]')]
  const byId = new Map(panels.map((panel) => [panel.id, panel]))
  if (!panels.length) return
  document.documentElement.classList.add('enhanced')

  function fitPrompts(panel) {
    for (const input of panel.querySelectorAll('.prompt')) {
      if (!input.getClientRects().length) continue
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight + 2}px`
    }
  }

  function show(id) {
    const chosen = byId.get(id) || panels[0]
    const previousFocus = document.activeElement.closest('.experience')
    for (const panel of panels) {
      panel.hidden = panel !== chosen
      if (panel.hidden) panel.querySelector('video')?.pause()
    }
    for (const link of picker) {
      if (link.dataset.experience === chosen.id)
        link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
    }
    document.title = `${chosen.querySelector('h2').textContent} · OpenHarness`
    fitPrompts(chosen)
    if (previousFocus && previousFocus.hidden) {
      const heading = chosen.querySelector('h2')
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
  }

  show(location.hash.slice(1))
  addEventListener('hashchange', () => show(location.hash.slice(1)))
  addEventListener('popstate', () => show(location.hash.slice(1)))
  addEventListener('resize', () => {
    const visible = panels.find((panel) => !panel.hidden)
    if (visible) fitPrompts(visible)
  })
  for (const details of document.querySelectorAll('details')) {
    details.addEventListener('toggle', () => {
      if (details.open) fitPrompts(details.closest('.experience'))
    })
  }
  for (const link of document.querySelectorAll('[data-experience]')) {
    link.addEventListener('click', (event) => {
      // Preserve ordinary links for new tabs, copying and JavaScript-free reading.
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      event.preventDefault()
      const id = link.dataset.experience
      if (!byId.has(id)) return
      if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`)
      show(id)
      // The next-craft link is in the panel we just hid. Move focus into the new
      // panel so keyboard users do not lose their place or focus a hidden link.
      if (link.closest('.next-craft')) {
        const title = byId.get(id).querySelector('h2')
        title.tabIndex = -1
        title.focus()
        title.scrollIntoView({ block: 'start' })
      }
    })
  }

  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const input = document.getElementById(button.dataset.copy)
      const status = button.parentElement.querySelector('.copy-status')
      button.disabled = true
      try {
        if (!navigator.clipboard?.writeText)
          throw Error('Clipboard unavailable')
        await navigator.clipboard.writeText(input.value)
        status.textContent = 'Copied.'
      } catch {
        input.focus()
        input.select()
        status.textContent = 'Selected. Press ⌘C or Ctrl+C to copy.'
      } finally {
        button.disabled = false
      }
    })
  }

  for (const button of document.querySelectorAll('[data-watch]')) {
    button.addEventListener('click', async () => {
      const panel = button.closest('.experience')
      const video = panel.querySelector('video')
      const poster = panel.querySelector('.poster')
      if (!video || panel.hidden) return
      if (!video.getAttribute('src')) video.src = video.dataset.src
      video.hidden = false
      poster.hidden = true
      button.hidden = true
      try {
        await video.play()
      } catch {
        // Native controls and the direct file link remain available if autoplay
        // policy, an unsupported codec or a missing file prevents this request.
        button.hidden = false
        button.textContent = 'Try playback again'
      }
      if (panel.hidden) video.pause()
    })
  }
})()
