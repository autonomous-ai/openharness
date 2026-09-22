import { createCaptureEngine, probesFor, sampleStatistics } from './capture.mjs'
import { drawCapture, nearestSample, quantity, traceBounds } from './plots.mjs'
const node = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

export async function initScopeLab({ getSim, getSourceFile }) {
  const modal = node('dialog', 'sl-modal')
  modal.innerHTML = `<div class="sl-shell">
    <header class="sl-head"><div><span class="sl-eyebrow">CIRCUITJS / SCOPE LAB</span><h2>See what the circuit is doing.</h2><p>Capture a native simulation. Turn a value. Compare the traces.</p></div><button id="slClose" aria-label="Close Scope Lab">×</button></header>
    <div id="slNotice" class="sl-notice" role="status" hidden></div>
    <div class="sl-body"><aside class="sl-controls">
      <label for="slProbe">PROBES <span id="slProbeCount"></span></label><select id="slProbe"></select><button id="slAdd">Add probe</button><div id="slProbes" class="sl-probes"></div>
      <label for="slDuration">SIMULATION WINDOW</label><select id="slDuration"><option value="0.001">1 ms</option><option value="0.01">10 ms</option><option value="0.1">100 ms</option><option value="0.5" selected>500 ms</option><option value="1">1 s</option><option value="5">5 s</option></select>
      <button id="slCapture" class="sl-primary">Capture circuit</button><button id="slCancel" hidden>Stop capture</button><p class="sl-caption">A separate CircuitJS instance runs an export of your current circuit at faster display pacing. Your visible circuit stays yours to edit.</p>
      <div class="sl-divider"></div><label for="slTake">YOUR CAPTURES</label><select id="slTake"><option value="">No captures yet</option></select><label for="slReference">COMPARE WITH</label><select id="slReference"><option value="">No reference</option></select><p id="slLegend" class="sl-caption">Color: this capture. Dashed gray: reference. Times share a new simulation origin; transients can differ.</p>
      <label for="slTitle">NAME THIS CAPTURE</label><input id="slTitle" maxlength="120" placeholder="e.g. Softer response · 2 kΩ"><label for="slNote">WHAT DID YOU LEARN?</label><textarea id="slNote" maxlength="2000" placeholder="What changed, and what would you try next?"></textarea>
      <button id="slKeep" class="sl-primary" disabled>Keep capture</button><a id="slDownload" class="sl-link" hidden>Download capture.zip</a><button id="slDiscard" hidden>Discard unsaved capture</button>
    </aside><section class="sl-readout"><div class="sl-status"><b id="slStatus">Choose probes, then capture.</b><span id="slProgress"></span></div><p id="slSummary" class="sl-caption">Node voltages, component voltage and current come from native solver callbacks.</p><div class="sl-cursorbar"><button id="slCursorA" class="on">Place A</button><button id="slCursorB">Place B</button><span id="slDelta">Click a trace to measure.</span><button id="slZoom" disabled>Zoom to A–B</button><button id="slAll" hidden>Show all</button><button id="slClear">Clear cursors</button></div><div id="slPlotWrap"><canvas id="slPlot" tabindex="0" aria-label="Native voltage and current traces. Click to place cursors, or use arrow keys to move the active cursor and Enter to switch cursors."></canvas><div id="slEmpty">Keep a trace of the circuit you actually tried.<br>Then change a component and see the difference.</div></div><div id="slValues"></div></section></div>
    <footer>Sampled native simulation, not hardware measurements. Faster signals and narrow spikes need finer sampling.</footer>
  </div>`
  document.body.append(modal)
  const frame = node('iframe', 'sl-engine')
  frame.title = 'Native capture simulator'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  document.body.append(frame)
  const $ = (id) => modal.querySelector(`#${id}`)
  const takes = new Map(),
    selectedProbes = new Map()
  let state = null,
    nativeRuntime = null,
    runtimeChanged = false,
    choices = [],
    selected = null,
    reference = null,
    savedList = [],
    busy = false,
    mode = 'a',
    cursors = {},
    viewWindow = null,
    redraw = null,
    focus = null,
    opening = 0,
    activeDraft = null
  const notice = (message = '', error = false) => {
    $('slNotice').hidden = !message
    $('slNotice').textContent = message
    $('slNotice').classList.toggle('error', error)
  }
  async function api(path = '', options = {}) {
    const response = await fetch('/__lab/api' + path, options)
    let data
    try {
      data = await response.json()
    } catch {
      throw new Error('The capture service is unavailable')
    }
    if (!response.ok || data.ok === false)
      throw Object.assign(new Error(data.error || 'Capture request failed'), {
        status: response.status
      })
    return data
  }
  async function refreshLibrary() {
    const next = await api()
    nativeRuntime ??= next.runtime
    runtimeChanged =
      JSON.stringify(nativeRuntime) !== JSON.stringify(next.runtime)
    if (runtimeChanged)
      notice(
        'The simulator installation changed. Reload the pane before a new capture.',
        true
      )
    state = next
    savedList = next.captures
    renderShelf()
  }
  const engine = await createCaptureEngine({
    frame,
    getSim,
    getSourceFile,
    getRuntime: () => nativeRuntime,
    onChange(take) {
      if (take.samples) {
        activeDraft = take
        draw(take)
      }
      $('slStatus').textContent =
        take.status === 'starting'
          ? 'Starting a separate native simulator…'
          : take.status === 'recording'
            ? 'Capturing native solver steps…'
            : take.status === 'error'
              ? take.error
              : `${take.status === 'complete' ? 'Captured' : 'Partial capture'} · ${take.reason || ''}`
      $('slProgress').textContent = take.samples
        ? `${take.solverSteps.toLocaleString()} solver steps · ${take.samples.length.toLocaleString()} samples`
        : ''
    }
  })
  function current() {
    return selected ? takes.get(selected) : null
  }
  function controls() {
    $('slCapture').disabled =
      busy ||
      runtimeChanged ||
      !selectedProbes.size ||
      selectedProbes.size > 8 ||
      !getSim()
    $('slCancel').hidden = !engine.busy
    $('slCancel').disabled = !engine.busy
    const take = current()
    $('slKeep').disabled =
      busy || !take || take.samples.length < 2 || !!take.kept
    $('slKeep').hidden = !!take?.kept
    $('slDownload').hidden = !take?.kept
    $('slDiscard').hidden = !take || !!take.kept
    $('slDiscard').disabled = busy
    $('slTitle').disabled = busy || !take || !!take.kept
    $('slNote').disabled = busy || !take || !!take.kept
    for (const id of [
      'slProbe',
      'slAdd',
      'slDuration',
      'slTake',
      'slReference'
    ])
      $(id).disabled = busy
  }
  async function action(work) {
    if (busy) return
    busy = true
    controls()
    try {
      await work()
    } catch (error) {
      notice(error.message || String(error), true)
    } finally {
      busy = false
      controls()
    }
  }
  function probeChoices() {
    try {
      choices = getSim() ? probesFor(getSim()) : []
    } catch (e) {
      notice(e.message, true)
      choices = []
    }
    const valid = new Set(choices.map((p) => p.id))
    for (const id of selectedProbes.keys())
      if (!valid.has(id)) selectedProbes.delete(id)
      else
        selectedProbes.set(
          id,
          choices.find((p) => p.id === id)
        )
    if (!selectedProbes.size) {
      const defaults = choices.filter((p) => p.kind === 'node').slice(0, 3)
      if (!defaults.length)
        defaults.push(
          ...choices
            .filter(
              (p) =>
                (p.type === 'CapacitorElm' && p.kind === 'voltage') ||
                p.type === 'OutputElm'
            )
            .slice(0, 2)
        )
      if (!defaults.length && choices.length) defaults.push(choices[0])
      for (const p of defaults) selectedProbes.set(p.id, p)
    }
    $('slProbe').replaceChildren(
      ...choices
        .filter((p) => !selectedProbes.has(p.id))
        .map((p) => {
          const o = node('option', '', p.label)
          o.value = p.id
          return o
        })
    )
    $('slProbeCount').textContent = `${selectedProbes.size}/8`
    $('slProbes').replaceChildren(
      ...[...selectedProbes.values()].map((p) => {
        const item = node('div', 'sl-probe'),
          remove = node('button', '', '×')
        remove.title = `Remove ${p.label}`
        item.append(node('span', '', p.label), remove)
        remove.addEventListener('click', () => {
          if (busy) return
          selectedProbes.delete(p.id)
          renderProbesOnly()
        })
        return item
      })
    )
    controls()
  }
  function renderProbesOnly() {
    // Keep an intentionally empty selection empty; defaults are only offered when opening the lab.
    $('slProbe').replaceChildren(
      ...choices
        .filter((p) => !selectedProbes.has(p.id))
        .map((p) => {
          const o = node('option', '', p.label)
          o.value = p.id
          return o
        })
    )
    $('slProbeCount').textContent = `${selectedProbes.size}/8`
    $('slProbes').replaceChildren(
      ...[...selectedProbes.values()].map((p) => {
        const item = node('div', 'sl-probe'),
          remove = node('button', '', '×')
        remove.title = `Remove ${p.label}`
        item.append(node('span', '', p.label), remove)
        remove.onclick = () => {
          if (!busy) {
            selectedProbes.delete(p.id)
            renderProbesOnly()
          }
        }
        return item
      })
    )
    controls()
  }
  function renderShelf() {
    const items = new Map(savedList.map((t) => [t.id, { ...t, kept: true }]))
    for (const t of takes.values()) items.set(t.id, t)
    const options = [...items.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    for (const [id, selectedId, placeholder] of [
      ['slTake', selected, 'Choose a capture'],
      ['slReference', reference, 'No reference']
    ]) {
      const blank = node('option', '', placeholder)
      blank.value = ''
      $(id).replaceChildren(
        blank,
        ...options
          .filter((t) => id !== 'slReference' || t.id !== selected)
          .map((t) => {
            const o = node(
              'option',
              '',
              `${t.kept ? '' : 'Unsaved · '}${t.title} · ${t.id.slice(0, 6)}`
            )
            o.value = t.id
            return o
          })
      )
      $(id).value = selectedId || ''
    }
  }
  async function load(id) {
    if (!takes.has(id)) {
      const data = await api('/' + id)
      takes.set(id, data.capture)
    }
    return takes.get(id)
  }
  function showTake(take) {
    selected = take.id
    activeDraft = null
    cursors = {}
    viewWindow = null
    if (reference === selected) reference = null
    $('slTitle').value = take.title
    $('slNote').value = take.note || ''
    $('slStatus').textContent =
      `${take.kept ? 'Kept' : take.status === 'complete' ? 'Captured' : 'Partial capture'} · ${take.title}`
    $('slProgress').textContent =
      `${take.solverSteps.toLocaleString()} solver steps · ${take.samples.length.toLocaleString()} samples`
    $('slDownload').href = `/__lab/api/${take.id}/download`
    $('slDownload').download = `circuit-capture-${take.id}.zip`
    renderShelf()
    controls()
    draw(take)
  }
  function draw(take = activeDraft || current()) {
    if (!take) return
    cancelAnimationFrame(redraw)
    redraw = requestAnimationFrame(() => {
      $('slEmpty').hidden = true
      $('slPlot').hidden = false
      drawCapture(
        $('slPlot'),
        take,
        reference ? takes.get(reference) : null,
        cursors,
        viewWindow
      )
      const end = take.samples.at(-1)?.[0] || 0
      $('slSummary').textContent =
        `${quantity(end, 's')} observed · requested spacing ${quantity(take.interval || take.config.duration / 2000, 's')} · native time step ${quantity(take.minStep || take.config.maxTimeStep, 's')}${take.maxStep && take.maxStep !== take.minStep ? '–' + quantity(take.maxStep, 's') : ''}. ${take.reason || ''}`
      values(take)
    })
  }
  function values(take) {
    const stats = sampleStatistics(take.samples, take.probes),
      a = Number.isFinite(cursors.a)
        ? nearestSample(take.samples, cursors.a)
        : null,
      b = Number.isFinite(cursors.b)
        ? nearestSample(take.samples, cursors.b)
        : null
    $('slDelta').textContent =
      a && b
        ? `Δt ${quantity(b[0] - a[0], 's')} · nearest stored samples`
        : a
          ? `A ${quantity(a[0], 's')} · now place B`
          : b
            ? `B ${quantity(b[0], 's')} · now place A`
            : 'Click a trace to measure.'
    $('slZoom').disabled = !a || !b || a[0] === b[0]
    $('slAll').hidden = !viewWindow
    const table = node('table'),
      head = node('tr')
    for (const title of [
      'Probe',
      'Capture min / max',
      'Capture RMS',
      'A',
      'B',
      'Δ'
    ])
      head.append(node('th', '', title))
    const thead = node('thead')
    thead.append(head)
    table.append(thead)
    const body = node('tbody')
    take.probes.forEach((p, i) => {
      const row = node('tr'),
        s = stats[i]
      for (const value of [
        p.label,
        `${quantity(s.min, p.unit)} / ${quantity(s.max, p.unit)}`,
        quantity(s.rms, p.unit),
        a ? quantity(a[i + 1], p.unit) : '—',
        b ? quantity(b[i + 1], p.unit) : '—',
        a && b ? quantity(b[i + 1] - a[i + 1], p.unit) : '—'
      ])
        row.append(node('td', '', value))
      body.append(row)
    })
    table.append(body)
    $('slValues').replaceChildren(table)
  }
  $('slCapture').onclick = () =>
    action(async () => {
      if ([...takes.values()].filter((t) => !t.kept).length >= 8)
        throw new Error(
          'Keep or discard one of your eight open captures before making another'
        )
      notice()
      viewWindow = null
      cursors = {}
      const requested = [...selectedProbes.values()],
        duration = Number($('slDuration').value)
      const promise = engine.capture({ probes: requested, duration })
      controls()
      const take = await promise
      take.title = `Capture ${takes.size + 1} · ${quantity(take.samples.at(-1)?.[0] || duration, 's')}`
      takes.set(take.id, take)
      showTake(take)
      if (take.samples.length < 2)
        notice(
          'The native simulator did not produce two samples. Try a longer window or check the circuit.',
          true
        )
    })
  $('slCancel').onclick = () => engine.cancel()
  $('slDiscard').onclick = () => {
    if (busy || !current() || current().kept) return
    takes.delete(selected)
    selected = null
    activeDraft = null
    cursors = {}
    const next = [...takes.values()].at(-1)
    if (next) showTake(next)
    else {
      $('slTitle').value = ''
      $('slNote').value = ''
      $('slStatus').textContent = 'Choose probes, then capture.'
      $('slProgress').textContent = ''
      $('slValues').replaceChildren()
      $('slPlot').hidden = true
      $('slEmpty').hidden = false
      renderShelf()
      controls()
    }
  }
  $('slAdd').onclick = () => {
    if (selectedProbes.size >= 8)
      return notice('Choose at most eight probes', true)
    const p = choices.find((p) => p.id === $('slProbe').value)
    if (p) selectedProbes.set(p.id, p)
    renderProbesOnly()
  }
  $('slTake').onchange = () =>
    action(async () => {
      if ($('slTake').value) showTake(await load($('slTake').value))
    })
  $('slReference').onchange = () =>
    action(async () => {
      reference = $('slReference').value || null
      if (reference) await load(reference)
      draw()
    })
  for (const [id, key] of [
    ['slTitle', 'title'],
    ['slNote', 'note']
  ])
    $(id).oninput = () => {
      const take = current()
      if (take && !take.kept) take[key] = $(id).value
      renderShelf()
    }
  $('slKeep').onclick = () =>
    action(async () => {
      const take = current()
      if (!take) return
      const body = JSON.stringify(take)
      let data
      try {
        data = await api('', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-circuit-lab': state.token
          },
          body
        })
      } catch (error) {
        // Lost acknowledgement: recover the exact already-published packet. A new id is never minted.
        try {
          data = await api('/' + take.id)
        } catch {
          if (error.status === 403) {
            await refreshLibrary()
            data = await api('', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-circuit-lab': state.token
              },
              body
            })
          } else throw error
        }
      }
      takes.set(take.id, data.capture)
      showTake(data.capture)
      await refreshLibrary()
      notice(
        'Kept the circuit export, native samples, trace and your note in this workspace.'
      )
    })
  for (const key of ['a', 'b'])
    $('slCursor' + key.toUpperCase()).onclick = () => {
      mode = key
      $('slCursorA').classList.toggle('on', key === 'a')
      $('slCursorB').classList.toggle('on', key === 'b')
    }
  $('slClear').onclick = () => {
    cursors = {}
    draw()
  }
  $('slZoom').onclick = () => {
    const take = current(),
      a = nearestSample(take?.samples || [], cursors.a),
      b = nearestSample(take?.samples || [], cursors.b)
    if (a && b && a[0] !== b[0]) {
      viewWindow = { start: Math.min(a[0], b[0]), end: Math.max(a[0], b[0]) }
      draw()
    }
  }
  $('slAll').onclick = () => {
    viewWindow = null
    draw()
  }
  $('slPlot').addEventListener('pointerdown', (event) => {
    const take = activeDraft || current()
    if (!take?.samples.length) return
    const box = $('slPlot').getBoundingClientRect(),
      col = Math.max(
        0,
        Math.min(
          take.probes.length - 1,
          Math.floor((event.clientY - box.top) / 170)
        )
      ),
      bounds = traceBounds(take, col, reference ? takes.get(reference) : null)
    const start = viewWindow?.start || 0,
      end = viewWindow?.end || bounds.end
    cursors[mode] = Math.max(
      start,
      Math.min(
        end,
        start +
          ((event.clientX - box.left - 74) / (box.width - 92)) * (end - start)
      )
    )
    cursors[mode] = nearestSample(take.samples, cursors[mode])[0]
    mode = mode === 'a' ? 'b' : 'a'
    $('slCursorA').classList.toggle('on', mode === 'a')
    $('slCursorB').classList.toggle('on', mode === 'b')
    draw(take)
  })
  $('slPlot').addEventListener('keydown', (event) => {
    const take = activeDraft || current()
    if (
      !take?.samples.length ||
      !['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)
    )
      return
    event.preventDefault()
    if (event.key === 'Enter') {
      mode = mode === 'a' ? 'b' : 'a'
      $('slCursorA').classList.toggle('on', mode === 'a')
      $('slCursorB').classList.toggle('on', mode === 'b')
      return
    }
    const bounds = traceBounds(
        take,
        0,
        reference ? takes.get(reference) : null
      ),
      start = viewWindow?.start || 0,
      end = viewWindow?.end || bounds.end
    const row = nearestSample(take.samples, cursors[mode] ?? start)
    const index = Math.max(
      0,
      Math.min(
        take.samples.length - 1,
        take.samples.indexOf(row) +
          (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1)
      )
    )
    cursors[mode] = Math.max(start, Math.min(end, take.samples[index][0]))
    draw(take)
  })
  function close() {
    modal.close()
    focus?.focus()
  }
  $('slClose').onclick = close
  modal.addEventListener('cancel', (e) => {
    e.preventDefault()
    close()
  })
  new ResizeObserver(() => {
    if (modal.open) draw()
  }).observe($('slPlotWrap'))
  window.addEventListener('beforeunload', (e) => {
    if (engine.busy || [...takes.values()].some((t) => !t.kept)) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  return {
    update() {
      if (modal.open && !busy) probeChoices()
    },
    async show() {
      focus = document.activeElement
      modal.showModal()
      const mine = ++opening
      try {
        await refreshLibrary()
        if (mine !== opening) return
        probeChoices()
        if (current()) showTake(current())
      } catch (error) {
        notice(error.message, true)
      }
    }
  }
}
