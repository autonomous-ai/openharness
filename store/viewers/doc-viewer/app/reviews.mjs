const $ = (id) => document.getElementById(id)
const node = (tag, text, className) => {
  const n = document.createElement(tag)
  n.textContent = text
  if (className) n.className = className
  return n
}
const normalize = (text) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()
const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
function validSaved(value) {
  const str = (v, max) => typeof v === 'string' && v.length <= max
  const source = value?.source,
    ids = new Set()
  return (
    value?.spec === 'doc-review/1' &&
    str(value.title, 120) &&
    source &&
    str(source.path, 512) &&
    Number.isInteger(source.pages) &&
    source.pages >= 1 &&
    source.pages <= 500 &&
    /^[a-f0-9]{64}$/.test(source.sha256) &&
    Array.isArray(value.notes) &&
    value.notes.length <= 100 &&
    value.notes.every((n) => {
      if (!n || !str(n.id, 36) || ids.has(n.id)) return false
      ids.add(n.id)
      return (
        Number.isInteger(n.page) &&
        n.page >= 1 &&
        n.page <= source.pages &&
        ['change', 'keep', 'question'].includes(n.kind) &&
        str(n.text, 2000) &&
        str(n.quote, 2000) &&
        Array.isArray(n.rects) &&
        n.rects.length <= 80 &&
        n.rects.every(
          (r) =>
            Array.isArray(r) &&
            r.length === 4 &&
            r.every(Number.isFinite) &&
            r[0] >= 0 &&
            r[1] >= 0 &&
            r[2] > 0 &&
            r[3] > 0 &&
            r[0] + r[2] <= 1.000001 &&
            r[1] + r[3] <= 1.000001
        )
      )
    })
  )
}

export function installReviews(reader) {
  let draft = null,
    pdf = null,
    holding = false,
    view = 'live',
    busy = false,
    dirty = false,
    requestId = null,
    keptId = null
  let composer = null,
    editing = null,
    activeNote = null,
    picking = false,
    latestInfo = null,
    heldInfo = null,
    latestHash = null
  let state = null,
    sequence = 0,
    discardArmed = false
  const panel = $('review-panel')
  function status(text, error = false) {
    $('review-status').textContent = text
    $('review-status').classList.toggle('error', error)
  }
  function changed() {
    dirty = true
    requestId = null
    discardArmed = false
    sync()
  }
  function sync() {
    $('review-work').hidden = !draft
    $('review-start').disabled = busy || !reader.current() || (draft && dirty)
    $('review-start').hidden = Boolean(draft && holding)
    $('review-start').textContent = draft
      ? 'Review current PDF'
      : 'Hold this draft'
    $('review-close').disabled = busy
    $('review-discard').disabled = busy
    $('review-discard').textContent = discardArmed
      ? 'Discard unsaved notes?'
      : 'Clear draft'
    $('review-save').disabled = busy || !draft || !dirty
    $('review-save').textContent = busy
      ? 'Working…'
      : dirty && keptId
        ? 'Keep changes'
        : 'Keep review'
    for (const id of [
      'review-title',
      'review-text',
      'review-kind',
      'review-add',
      'review-original',
      'review-latest'
    ])
      $(id).disabled = busy
    for (const id of ['review-selection', 'review-area', 'review-page'])
      $(id).disabled = busy || !draft || !holding || view !== 'original'
    $('review-original').setAttribute(
      'aria-pressed',
      String(holding && view === 'original')
    )
    $('review-latest').setAttribute(
      'aria-pressed',
      String(holding && view === 'latest')
    )
    $('btn-review').setAttribute('aria-pressed', String(!panel.hidden))
    $('btn-review').classList.toggle('held', holding)
    $('app').classList.toggle('review-open', !panel.hidden)
    $('review-area').setAttribute('aria-pressed', String(picking))
    const pending =
      holding &&
      draft &&
      state?.pdf &&
      state.pdf.path === draft.source.path &&
      state.pdf.mtimeMs !==
        (view === 'latest' ? latestInfo?.mtimeMs : heldInfo?.mtimeMs)
    $('review-pending').hidden = !pending
  }
  async function start() {
    if (busy || !reader.current() || (draft && dirty)) return
    const original = reader.current()
    if (original.doc.numPages > 500 || original.size > 30 * 1024 * 1024) {
      status('Reviews support PDFs up to 30 MB and 500 pages.', true)
      return
    }
    holding = true
    busy = true
    reader.freeze()
    sync()
    status('Holding the exact draft you are reading…')
    try {
      const bytes = await original.doc.getData()
      if (bytes.length > 30 * 1024 * 1024)
        throw new Error('This PDF is larger than the 30 MB review limit')
      const hash = await digest(bytes)
      draft = {
        spec: 'doc-review/1',
        title:
          `${original.title || original.path.split('/').pop()} · review`.slice(
            0,
            120
          ),
        source: {
          path: original.path,
          title: (original.title || original.path).slice(0, 200),
          pages: original.doc.numPages,
          sha256: hash,
          bytes: bytes.length
        },
        notes: []
      }
      pdf = bytes
      heldInfo = {
        path: original.path,
        size: original.size,
        mtimeMs: original.mtimeMs
      }
      latestInfo = null
      latestHash = null
      view = 'original'
      keptId = null
      requestId = null
      dirty = true
      composer = null
      editing = null
      activeNote = null
      discardArmed = false
      $('review-title').value = draft.title
      $('review-composer').hidden = true
      $('review-download').hidden = true
      $('review-saved-path').textContent = ''
      renderNotes()
      draw()
      status(
        'Draft held. Select text, pin an area, or leave a note for the page.'
      )
    } catch (error) {
      holding = false
      status(error.message, true)
      reader.follow()
    } finally {
      busy = false
      sync()
    }
  }
  function compose(anchor, id = null) {
    composer = anchor
    editing = id
    $('review-anchor').textContent =
      `Page ${anchor.page}${anchor.quote ? ' · “' + anchor.quote.slice(0, 160) + '”' : ' · marked area or page'}`
    $('review-kind').value = anchor.kind || 'change'
    $('review-text').value = anchor.text || ''
    $('review-add').textContent = id ? 'Update note' : 'Add note'
    $('review-composer').hidden = false
    $('review-text').focus()
    $('review-composer').scrollIntoView({ block: 'nearest' })
  }
  function selection() {
    if (!draft || !holding || view !== 'original' || busy) return
    const selected = window.getSelection(),
      text = selected?.toString().trim()
    if (!text || !selected.rangeCount) {
      status(
        'Select words in the PDF first, then choose Note selected text.',
        true
      )
      return
    }
    if (text.length > 2000) {
      status('Select a shorter passage, up to 2,000 characters.', true)
      return
    }
    const range = selected.getRangeAt(0),
      root = reader.current().viewer
    const element = (n) =>
      n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement
    const page = element(range.startContainer)?.closest('.page'),
      end = element(range.endContainer)?.closest('.page')
    if (!page || page !== end || !root.contains(page)) {
      status('Choose a passage on one PDF page.', true)
      return
    }
    const box = page.getBoundingClientRect(),
      rects = []
    for (const r of range.getClientRects()) {
      const left = Math.max(box.left, r.left),
        top = Math.max(box.top, r.top),
        right = Math.min(box.right, r.right),
        bottom = Math.min(box.bottom, r.bottom)
      if (right > left && bottom > top)
        rects.push([
          (left - box.left) / box.width,
          (top - box.top) / box.height,
          (right - left) / box.width,
          (bottom - top) / box.height
        ])
    }
    if (!rects.length || rects.length > 80) {
      status('Select a shorter passage to anchor this note.', true)
      return
    }
    compose({ page: Number(page.dataset.pageNumber), quote: text, rects })
    selected.removeAllRanges()
  }
  function add() {
    if (!composer || busy) return
    const text = $('review-text').value.trim()
    if (!text) {
      status('Write what should change, stay, or be answered.', true)
      return
    }
    if (!editing && draft.notes.length >= 100) {
      status('This review already has 100 notes.', true)
      return
    }
    const note = {
      id: editing || crypto.randomUUID(),
      page: composer.page,
      quote: composer.quote || '',
      rects: composer.rects || [],
      kind: $('review-kind').value,
      text
    }
    if (editing)
      draft.notes[draft.notes.findIndex((n) => n.id === editing)] = note
    else draft.notes.push(note)
    activeNote = note.id
    composer = null
    editing = null
    $('review-composer').hidden = true
    changed()
    renderNotes()
    draw()
    status('Note added to this exact draft. Keep the review when it is ready.')
  }
  function renderNotes() {
    $('review-notes').replaceChildren(
      ...(draft?.notes || []).map((note, i) => {
        const card = node('article', '', 'review-note ' + note.kind)
        card.dataset.noteId = note.id
        card.classList.toggle('selected', note.id === activeNote)
        const jump = node(
          'button',
          `${i + 1}. ${note.kind[0].toUpperCase() + note.kind.slice(1)} · page ${note.page}`,
          'review-jump'
        )
        jump.onclick = () => focusNote(note)
        card.append(jump)
        if (note.quote) card.append(node('blockquote', note.quote))
        card.append(node('p', note.text))
        const buttons = node('div', '', 'review-row')
        const edit = node('button', 'Edit', 'review-button'),
          remove = node('button', 'Remove', 'review-button')
        edit.onclick = () => {
          if (!busy) compose(note, note.id)
        }
        remove.onclick = () => {
          if (busy) return
          draft.notes = draft.notes.filter((n) => n.id !== note.id)
          if (activeNote === note.id) activeNote = null
          changed()
          renderNotes()
          draw()
        }
        buttons.append(edit, remove)
        card.append(buttons)
        return card
      })
    )
  }
  function clearMarks() {
    document
      .querySelectorAll('.review-marks, .review-pick-layer')
      .forEach((el) => el.remove())
  }
  function draw() {
    clearMarks()
    if (!draft || !holding || view !== 'original') return
    const root = reader.current()?.viewer
    if (!root) return
    for (const page of root.querySelectorAll('.page')) {
      const number = Number(page.dataset.pageNumber),
        layer = node('div', '', 'review-marks')
      for (const [index, note] of draft.notes.entries()) {
        if (note.page !== number) continue
        for (const r of note.rects) {
          const mark = node(
            'div',
            '',
            `review-highlight ${note.kind}${note.id === activeNote ? ' selected' : ''}`
          )
          position(mark, r)
          layer.append(mark)
        }
        const pin = node(
            'button',
            String(index + 1),
            `review-pin ${note.kind}`
          ),
          point = note.rects[0] || [0.94, 0.03, 0.04, 0.02]
        pin.style.left = `calc(${Math.min(0.95, point[0]) * 100}% - 12px)`
        pin.style.top =
          Math.max(0, point[1] + Math.min(0.012, point[3] / 2)) * 100 + '%'
        pin.title = `${note.kind}: ${note.text}`
        pin.onclick = () => focusNote(note)
        layer.append(pin)
      }
      page.append(layer)
      if (picking) {
        const cover = node('div', '', 'review-pick-layer')
        page.append(cover)
        cover.onpointerdown = (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          cover.setPointerCapture(event.pointerId)
          const box = page.getBoundingClientRect(),
            start = point(event, box),
            mark = node('div', '', 'review-highlight selected')
          cover.append(mark)
          let rect
          cover.onpointermove = (move) => {
            const end = point(move, box)
            rect = [
              Math.min(start[0], end[0]),
              Math.min(start[1], end[1]),
              Math.abs(end[0] - start[0]),
              Math.abs(end[1] - start[1])
            ]
            position(mark, rect)
          }
          cover.onpointerup = (up) => {
            up.preventDefault()
            up.stopPropagation()
            cover.onpointermove = null
            picking = false
            draw()
            sync()
            if (rect && rect[2] > 0.002 && rect[3] > 0.002)
              compose({ page: number, quote: '', rects: [rect] })
            else
              status(
                'Drag a rectangle around the part of the page you want to discuss.'
              )
          }
          cover.onpointercancel = () => {
            picking = false
            draw()
            sync()
            status('Area selection cancelled.')
          }
        }
      }
    }
  }
  const point = (event, box) => [
    Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
    Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))
  ]
  function position(el, rect) {
    const [x, y, w, h] = rect
    Object.assign(el.style, {
      left: x * 100 + '%',
      top: y * 100 + '%',
      width: w * 100 + '%',
      height: h * 100 + '%'
    })
  }
  async function focusNote(note) {
    if (busy) return
    panel.hidden = false
    activeNote = note.id
    renderNotes()
    draw()
    sync()
    const card = [...$('review-notes').children].find(
      (el) => el.dataset.noteId === note.id
    )
    requestAnimationFrame(() => card?.scrollIntoView({ block: 'nearest' }))
    if (!holding || view === 'original') {
      if (!holding) await original()
      reader.go(note.page)
      return
    }
    if (!note.quote) {
      status(
        'This area is anchored to the reviewed draft. Use Reviewed draft to inspect it.'
      )
      return
    }
    const current = reader.current(),
      ticket = ++sequence,
      quote = normalize(note.quote)
    if (!quote || !current) return
    reader.clearFind()
    status('Looking for the quoted words in the latest draft…')
    const hits = []
    try {
      for (let page = 1; page <= current.doc.numPages; page++) {
        const content = await (await current.doc.getPage(page)).getTextContent()
        if (ticket !== sequence || current !== reader.current()) return
        const text = normalize(
          content.items.map((item) => item.str || '').join(' ')
        )
        let at = text.indexOf(quote)
        while (at >= 0) {
          hits.push(page)
          if (hits.length > 1) break
          at = text.indexOf(quote, at + quote.length)
        }
        if (hits.length > 1) break
      }
      if (hits.length === 1) {
        reader.go(hits[0])
        reader.find(note.quote)
        status(
          `The quoted words occur once in the latest draft, on page ${hits[0]}. Review the surrounding change.`
        )
      } else
        status(
          hits.length
            ? 'The quote occurs more than once in the latest draft. Its location is ambiguous.'
            : 'The exact quote is absent from the latest draft. The wording may have changed; inspect the reviewed draft.'
        )
    } catch (error) {
      if (ticket === sequence)
        status('Could not inspect the latest PDF text: ' + error.message, true)
    }
  }
  async function original() {
    if (!draft || busy) return
    busy = true
    holding = true
    reader.freeze()
    ++sequence
    sync()
    picking = false
    try {
      await reader.show(pdf, {
        ...heldInfo,
        path: draft.source.path,
        size: pdf.length
      })
      view = 'original'
      reader.clearFind()
      draw()
      status('Showing the exact reviewed draft.')
    } catch (error) {
      status(error.message, true)
    } finally {
      busy = false
      sync()
    }
  }
  async function latest() {
    if (!draft || busy) return
    busy = true
    holding = true
    reader.freeze()
    ++sequence
    sync()
    picking = false
    try {
      const response = await fetch(
          '/api/state?file=' + encodeURIComponent(draft.source.path),
          { cache: 'no-store' }
        ),
        value = await response.json()
      if (!response.ok || !value.pdf)
        throw new Error(
          'This document is not currently available in the live workspace'
        )
      if (value.pdf.size > 30 * 1024 * 1024)
        throw new Error('Review comparison supports PDFs up to 30 MB')
      const bytes = await reader.fetch(value.pdf)
      if (!bytes) throw new Error('The latest PDF has not finished writing')
      if (bytes.length > 30 * 1024 * 1024)
        throw new Error('Review comparison supports PDFs up to 30 MB')
      const hash = await digest(bytes)
      await reader.show(bytes, value.pdf)
      latestInfo = value.pdf
      latestHash = hash
      view = 'latest'
      clearMarks()
      status(
        hash === draft.source.sha256
          ? 'The latest PDF matches the reviewed draft exactly.'
          : 'Showing the latest draft. Choose a quoted note to find where its words moved.'
      )
    } catch (error) {
      status(error.message, true)
    } finally {
      busy = false
      sync()
    }
  }
  async function save() {
    if (!draft || busy || !dirty) return
    const title = $('review-title').value.trim()
    if (!title) {
      status('Name this review before keeping it.', true)
      return
    }
    busy = true
    sync()
    status('Keeping the PDF, its anchors and your notes…')
    requestId ||= crypto.randomUUID()
    const header = new TextEncoder().encode(
      JSON.stringify({
        spec: 'doc-review/1',
        id: requestId,
        title,
        source: draft.source,
        notes: draft.notes
      })
    )
    const size = new Uint8Array(4)
    new DataView(size.buffer).setUint32(0, header.length, true)
    const body = new Blob([size, header, pdf], {
      type: 'application/octet-stream'
    })
    try {
      const token = document.querySelector('meta[name="review-token"]')
      const send = () =>
        fetch('/api/reviews', {
          method: 'POST',
          headers: { 'x-doc-viewer': '1', 'x-review-token': token.content },
          body
        })
      let response = await send()
      if (response.status === 403) {
        const page = new DOMParser().parseFromString(
          await (await fetch('/', { cache: 'no-store' })).text(),
          'text/html'
        )
        const fresh = page.querySelector('meta[name="review-token"]')?.content
        if (fresh) {
          token.content = fresh
          response = await send()
        }
      }
      const result = await response.json()
      if (!response.ok)
        throw new Error(result.error || 'The review could not be kept')
      keptId = result.id
      draft.title = title
      dirty = false
      discardArmed = false
      keptLink(result.id, result.path)
      await refresh()
      status(
        `Kept “${title}” with ${draft.notes.length} note${draft.notes.length === 1 ? '' : 's'}.`
      )
    } catch (error) {
      status(error.message + ' Your review is still in this tab.', true)
    } finally {
      busy = false
      sync()
    }
  }
  function keptLink(id, path) {
    $('review-download').href = `/api/reviews/${id}/review.zip?download=1`
    $('review-download').download = 'review.zip'
    $('review-download').hidden = false
    $('review-saved-path').textContent = path || `.harness/doc-reviews/${id}`
  }
  async function open(id) {
    if (busy || (draft && dirty)) {
      status('Keep your current review before opening another.', true)
      return
    }
    const wasHolding = holding
    busy = true
    holding = true
    reader.freeze()
    ++sequence
    sync()
    try {
      const response = await fetch(`/api/reviews/${id}/review.json`, {
          cache: 'no-store'
        }),
        value = await response.json()
      if (!response.ok || !validSaved(value))
        throw new Error('This review is unavailable or its notes are damaged')
      const pdfResponse = await fetch(`/api/reviews/${id}/reference.pdf`)
      if (!pdfResponse.ok) throw new Error('The reviewed PDF is unavailable')
      const bytes = new Uint8Array(await pdfResponse.arrayBuffer())
      if (bytes.length > 30 * 1024 * 1024)
        throw new Error('The saved PDF exceeds the review size limit')
      if ((await digest(bytes)) !== value.source.sha256)
        throw new Error('The saved PDF no longer matches the review')
      await reader.show(bytes, {
        path: value.source.path,
        size: bytes.length,
        mtimeMs: 0,
        expectedPages: value.source.pages
      })
      draft = value
      pdf = bytes
      heldInfo = { path: value.source.path, size: bytes.length, mtimeMs: 0 }
      keptId = id
      dirty = false
      requestId = null
      view = 'original'
      activeNote = null
      picking = false
      composer = null
      editing = null
      discardArmed = false
      $('review-title').value = value.title
      $('review-composer').hidden = true
      keptLink(id)
      reader.clearFind()
      renderNotes()
      draw()
      status(
        `Kept review · ${value.notes.length} notes on the exact PDF draft.`
      )
    } catch (error) {
      status(error.message, true)
      holding = wasHolding
      if (!holding) reader.follow()
    } finally {
      busy = false
      sync()
    }
  }
  async function refresh() {
    try {
      const response = await fetch('/api/reviews', { cache: 'no-store' }),
        items = await response.json()
      if (!response.ok) throw new Error('Could not load kept reviews')
      $('review-library').replaceChildren(
        ...items.map((item) => {
          const card = node('article', '', 'review-saved'),
            button = node('button', item.title, 'review-jump')
          button.onclick = () => open(item.id)
          card.append(button, node('p', `${item.notes} notes · ${item.path}`))
          const link = node('a', 'PDF + notes')
          link.href = `/api/reviews/${item.id}/review.zip?download=1`
          link.download = 'review.zip'
          card.append(link)
          return card
        })
      )
      if (!items.length)
        $('review-library').append(
          node('p', 'Reviews you keep will appear here.', 'review-intro')
        )
    } catch (error) {
      status(error.message, true)
    }
  }
  function close() {
    if (busy) return
    holding = false
    view = 'live'
    picking = false
    ++sequence
    clearMarks()
    panel.hidden = true
    reader.clearFind()
    sync()
    reader.follow()
  }
  function discard() {
    if (busy) return
    if (dirty && draft?.notes.length && !discardArmed) {
      discardArmed = true
      sync()
      status(
        'Choose Discard unsaved notes? again to clear this draft. Kept reviews stay in the library.'
      )
      return
    }
    draft = null
    pdf = null
    dirty = false
    requestId = null
    keptId = null
    composer = null
    editing = null
    discardArmed = false
    holding = false
    view = 'live'
    picking = false
    ++sequence
    clearMarks()
    sync()
    reader.follow()
    status('Draft cleared. Kept reviews are still in the library.')
  }
  $('btn-review').onclick = () => {
    panel.hidden = !panel.hidden
    if (panel.hidden) {
      picking = false
      draw()
    }
    if (!panel.hidden) {
      refresh()
      if (draft && !holding)
        status(
          'Your review is still in this tab. Choose Reviewed draft to resume it.'
        )
    }
    sync()
  }
  $('review-start').onclick = start
  $('review-close').onclick = close
  $('review-original').onclick = original
  $('review-latest').onclick = latest
  $('review-selection').onpointerdown = (e) => e.preventDefault()
  $('review-selection').onclick = selection
  $('review-area').onclick = () => {
    picking = !picking
    draw()
    sync()
    status(
      picking ? 'Drag a rectangle on a PDF page.' : 'Area selection cancelled.'
    )
  }
  $('review-page').onclick = () =>
    compose({
      page: reader.current().pdfViewer.currentPageNumber,
      quote: '',
      rects: []
    })
  $('review-add').onclick = add
  $('review-cancel').onclick = () => {
    composer = null
    editing = null
    $('review-composer').hidden = true
  }
  $('review-title').oninput = changed
  $('review-save').onclick = save
  $('review-refresh').onclick = refresh
  $('review-discard').onclick = discard
  $('review-text').onkeydown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      add()
    }
  }
  window.addEventListener('beforeunload', (event) => {
    if (draft && dirty && draft.notes.length) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  refresh()
  sync()
  return {
    holding: () => holding,
    draw,
    loaded: sync,
    close,
    cancelArea() {
      if (!picking) return false
      picking = false
      draw()
      sync()
      status('Area selection cancelled.')
      return true
    },
    update(value) {
      state = value
      sync()
    },
    inspect: () => ({ draft, holding, view, busy, dirty, keptId, latestHash })
  }
}
