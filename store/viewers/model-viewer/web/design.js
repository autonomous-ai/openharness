// Controls come from the authored Blender project. Every displayed variant is a real native build.
import { $, el, put } from './util.js'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const dimensions = (report) => report?.size_mm?.map((n) => Number(n.toFixed(1))).join(' × ') + ' mm'

export function createShapeLab(host) {
  const token = document.querySelector('meta[name=design-token]').content
  let data = null,
    opened = false,
    definition = null,
    revision = null,
    sourceFingerprint = null,
    draft = null
  let loaded = null,
    wanted = null,
    loading = null,
    timer,
    busy = false,
    generation = 0,
    cardsKey = ''
  const post = async (action, body) => {
    const response = await fetch('/api/design/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-design-token': token },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Design request failed')
    return result
  }
  function loadControls(source = data?.design) {
    if (!source) return
    definition = source.definition
    revision = source.revision
    sourceFingerprint = source.sourceFingerprint
    draft = { ...source.values }
    $('#design-title').textContent = definition.title
    put($('#design-controls'))
    for (const control of definition.controls) {
      const label = el('label', { class: 'design-control', for: 'design-param-' + control.id })
      const heading = el('span', { class: 'design-control-head' }, el('span', { text: control.label }))
      label.append(heading)
      const changed = (value) => {
        draft[control.id] = value
        schedule()
        render()
      }
      let input
      if (control.type === 'boolean') {
        input = el('input', { type: 'checkbox', id: 'design-param-' + control.id })
        input.checked = draft[control.id]
        input.onchange = () => changed(input.checked)
        heading.append(input)
      } else if (control.type === 'choice') {
        input = el('select', { id: 'design-param-' + control.id })
        for (const value of control.options) input.append(el('option', { value, text: value }))
        input.value = draft[control.id]
        input.onchange = () => changed(input.value)
        label.append(input)
      } else {
        const value = el('input', {
          type: 'number',
          min: control.min,
          max: control.max,
          step: control.step,
          value: draft[control.id],
          'aria-label': control.label + (control.unit ? ` (${control.unit})` : ''),
        })
        const suffix = el('span', { class: 'design-unit', text: control.unit })
        heading.append(el('span', { class: 'design-number' }, value, suffix))
        input = el('input', {
          type: 'range',
          id: 'design-param-' + control.id,
          min: control.min,
          max: control.max,
          step: control.step,
          value: draft[control.id],
        })
        input.oninput = () => {
          value.value = input.value
          changed(Number(input.value))
        }
        value.onchange = () => {
          input.value = value.value
          changed(Number(value.value))
        }
        label.append(input)
      }
      if (control.description) label.append(el('small', { text: control.description }))
      $('#design-controls').append(label)
    }
    render()
  }
  function schedule() {
    clearTimeout(timer)
    if ($('#design-auto').checked) timer = setTimeout(build, 450)
  }
  async function build() {
    clearTimeout(timer)
    if (!opened || !definition || busy) return
    const values = { ...draft },
      turn = ++generation
    $('#design-message').textContent = 'Snapshotting the design…'
    try {
      const result = await post('preview', { revision, values })
      if (turn !== generation || !opened) return
      wanted = result.id
      render()
      maybeLoad()
    } catch (error) {
      if (turn === generation) host.toast(error.message)
    }
  }
  async function show(variant, saved = false) {
    if (!opened || busy || loading === variant.id) return
    loading = variant.id
    render()
    const result = await host.load({
      path: saved ? `Saved designs/${variant.name}` : 'Shape Lab/Preview',
      url: variant.model,
      mtime: Date.parse(variant.at),
      size: 0,
      report: variant.report,
      design: true,
    })
    if (!opened || loading !== variant.id) return
    loading = null
    if (result) loaded = { ...variant, saved }
    render()
  }
  function maybeLoad() {
    if (opened && data?.last && data.last.id === wanted && loaded?.id !== wanted && loading !== wanted)
      void show(data.last)
  }
  function render() {
    if (!opened) return
    const changedSource = sourceFingerprint && data?.design?.sourceFingerprint !== sourceFingerprint
    if (!changedSource && data?.design) revision = data.design.revision
    $('#design-source-change').hidden = !changedSource
    const matching = loaded && same(loaded.values, draft)
    const pending =
      data?.request && ['building', 'queued'].includes(data.request.status) && data.request.id === wanted
    let message = !definition
      ? data?.error || 'This project has not published design controls yet.'
      : data?.request?.id === wanted && data.request.status === 'error'
        ? data.request.error
        : data?.request?.id === wanted && data.request.status === 'cancelled'
          ? 'Preview cancelled. Your last good design is still here.'
          : pending
            ? data.request.status === 'queued'
              ? 'Your latest values are next. Keeping the previous preview.'
              : 'Blender is building your design…'
            : loading
              ? 'Opening the new geometry…'
              : loaded
                ? `${dimensions(loaded.report)}${!matching ? ' · preview shows earlier values' : ''}`
                : 'Change a control to build a real Blender preview.'
    $('#design-message').textContent = message
    $('#design-build').disabled = busy || !definition || changedSource
    $('#design-cancel').hidden = !pending
    $('#design-keep').disabled = busy || !!loading || pending || !matching || loaded.saved
    $('#design-use').disabled = busy || (!loaded?.savedId && !loaded?.saved)
    $('#design-model').hidden = !loaded
    if (loaded) {
      $('#design-model').href = loaded.model
      $('#design-model').download =
        (loaded.name || 'design') + (definition?.output.endsWith('.gltf') ? '.gltf' : '.glb')
    }
    $('#design-original').disabled = busy || !!loading
    $('#design-close').disabled = busy
    $('#design-reload').disabled = busy
    for (const input of $('#design-controls').querySelectorAll('input,select')) input.disabled = busy
    const key = JSON.stringify(data?.variants || [])
    if (key !== cardsKey) {
      cardsKey = key
      put($('#design-variants'))
      if (!data?.variants?.length)
        $('#design-variants').append(
          el('p', {
            class: 'design-hint',
            text: 'Keep a few directions. Their models, chosen values, source and rebuild tools stay in your project.',
          }),
        )
      for (const variant of data?.variants || []) {
        const card = el('article', { class: 'design-variant', 'data-id': variant.id })
        const button = el('button', { class: 'design-variant-open', type: 'button' })
        if (variant.thumbnail)
          button.append(el('img', { src: variant.thumbnail, alt: variant.name, loading: 'lazy' }))
        button.append(el('strong', { text: variant.name }), el('small', { text: dimensions(variant.report) }))
        button.onclick = () => {
          if (busy) return
          clearTimeout(timer)
          generation++
          wanted = null
          loadControls({ ...variant, revision: variant.sourceRevision })
          void show(variant, true)
        }
        card.append(
          button,
          el('a', {
            class: 'design-download',
            href: `/ws/${variant.path}/project.zip`,
            download: `${variant.name}.zip`,
            text: 'Download project ↗',
          }),
        )
        $('#design-variants').append(card)
      }
    }
    for (const card of $('#design-variants').children) {
      const selected = card.dataset.id === loaded?.id
      card.classList.toggle('selected', selected)
      card.querySelector('button')?.setAttribute('aria-pressed', String(selected))
    }
  }
  $('#design-open').onclick = () => {
    if (opened) {
      $('#design-close').click()
      return
    }
    opened = true
    host.open(true)
    $('#design-lab').hidden = false
    loadControls(
      loaded ? { ...loaded, revision: loaded.saved ? loaded.sourceRevision : loaded.revision } : data?.design,
    )
    if (loaded) void show(loaded, loaded.saved)
    else void build()
  }
  $('#design-close').onclick = () => {
    opened = false
    generation++
    loading = null
    clearTimeout(timer)
    $('#design-lab').hidden = true
    host.open(false)
    host.original()
  }
  $('#design-reload').onclick = () => {
    clearTimeout(timer)
    generation++
    wanted = null
    loadControls()
    void build()
  }
  $('#design-build').onclick = build
  $('#design-auto').onchange = () => {
    if ($('#design-auto').checked) schedule()
    else clearTimeout(timer)
  }
  $('#design-cancel').onclick = () => {
    clearTimeout(timer)
    void post('cancel', { id: wanted }).catch((e) => host.toast(e.message))
  }
  $('#design-original').onclick = async () => {
    if (busy || loading) return
    clearTimeout(timer)
    generation++
    wanted = null
    if (await host.original()) loaded = null
    render()
  }
  $('#design-keep').onclick = async () => {
    if (busy || !loaded) return
    const name = $('#design-name').value.trim()
    if (!name) {
      $('#design-name').focus()
      return
    }
    busy = true
    render()
    try {
      const thumbnail = await host.capture()
      const result = await post('keep', { id: loaded.id, name, thumbnail })
      wanted = null
      loaded = {
        ...loaded,
        id: result.id,
        saved: true,
        name,
        sourceRevision: loaded.revision,
        model: `/__design/saved-${result.id}/${loaded.definition.output}`,
      }
      $('#design-name').value = ''
      host.toast(`Kept ${name} in ${result.path}`)
    } catch (e) {
      host.toast(e.message)
    } finally {
      busy = false
      render()
    }
  }
  $('#design-use').onclick = async () => {
    if (busy || !loaded || !data?.design) return
    busy = true
    render()
    try {
      await post('use-values', { id: loaded.savedId || loaded.id, revision: data.design.revision })
      host.toast('Saved design-values.json. The agent’s next build will use these values.')
    } catch (e) {
      host.toast(e.message)
    } finally {
      busy = false
      render()
    }
  }
  return {
    active: () => opened,
    receive(next) {
      data = next
      $('#design-open').hidden = !data?.available || (!data.design && !data.error && !data.variants?.length)
      if (opened) {
        render()
        maybeLoad()
      }
    },
  }
}
