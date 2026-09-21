import { capture, packTake } from './recording.mjs'

const $ = (id) => document.getElementById(id)
const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const node = (tag, value, className) => {
  const el = document.createElement(tag)
  if (value) el.textContent = value
  if (className) el.className = className
  return el
}
const urlFor = (id, file) => `/out/takes/${encodeURIComponent(id)}/${file}`

export function installPerformance({ state: S, cycle, stop }) {
  let active = null,
    draft = null,
    preparing = false,
    saving = false,
    blobURL = null,
    duration = 0
  let takes = [],
    waveSamples = null
  const mix = () => ({ muted: [...S.muted], soloed: [...S.soloed] })
  const clock = () => ({ cycle: cycle(), cps: Math.max(0, Number(S.sched?.cps) || 0) })
  function message(value = '', error = false) {
    $('take-message').textContent = value
    $('take-message').hidden = !value
    $('take-message').classList.toggle('error', error)
  }
  function sync() {
    $('record').disabled = preparing || saving || (!active && (!S.started || (!!draft && !draft.id)))
    $('record').classList.toggle('recording', !!active)
    $('record-label').textContent = preparing ? 'Starting…' : active ? 'Finish take' : 'Record take'
    $('record').title =
      !S.started && !active
        ? 'Play the track, then record your performance'
        : 'Record the actual stereo output'
    $('take-live').hidden = !active
    $('mark').hidden = !active
    $('take-hint').textContent = active
      ? `Recording · up to ${time(active.recorder.maxSeconds)}`
      : draft && !draft.id
        ? 'Listen, name it, and keep the performance.'
        : 'Keep a performance, from first note to final drop.'
    $('keep-take').disabled = saving
    $('discard-take').disabled = saving
    $('picker').disabled = !!active || preparing
    $('apply-pending').disabled = !!active || preparing
    if (!$('pending').hidden)
      $('pending-reason').textContent =
        active || preparing
          ? 'Finish this take before loading it.'
          : S.dirty
            ? 'Loading it will replace your unsaved pane edits.'
            : 'Load it when you are ready.'
    $('take-count').textContent = String(takes.length)
    for (const button of $('take-list').querySelectorAll('button'))
      button.disabled = !!active || preparing || saving || (!!draft && !draft.id)
  }
  function event(type, data = {}) {
    if (!active || active.stopping) return
    if (active.manifest.events.length >= 3999) {
      active.stopping = true
      active.recorder.stop('journal limit')
      return
    }
    active.manifest.events.push({ type, audioTime: active.context.currentTime, ...clock(), ...data })
  }
  function source(code) {
    if (!active || active.stopping) return
    let index = active.manifest.sources.findIndex((s) => s.code === code)
    if (index < 0) {
      const bytes = new TextEncoder().encode(code).length
      if (bytes > 65536 || active.manifest.sources.length >= 128 || active.sourceBytes + bytes > 512 * 1024) {
        active.stopping = true
        active.recorder.stop('source journal limit')
        return
      }
      index = active.manifest.sources.length
      active.manifest.sources.push({ code })
      active.sourceBytes += bytes
    }
    event('source', { source: index, ...mix() })
  }
  function clearDraft() {
    $('take-audio').pause()
    $('take-audio').removeAttribute('src')
    $('take-audio').load()
    if (blobURL) URL.revokeObjectURL(blobURL)
    blobURL = null
    draft = null
    waveSamples = null
    $('take-draft').hidden = true
    sync()
  }
  function drawWave() {
    if (!waveSamples) return
    const canvas = $('take-wave'),
      rect = canvas.getBoundingClientRect(),
      ratio = devicePixelRatio || 1
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(52 * ratio)
    const ctx = canvas.getContext('2d')
    ctx.scale(ratio, ratio)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--h-accent')
    const maximum = Math.max(0.0001, ...waveSamples.left, ...waveSamples.right)
    for (let channel = 0; channel < 2; channel++) {
      const samples = channel ? waveSamples.right : waveSamples.left
      ctx.globalAlpha = channel ? 0.6 : 1
      for (let x = 0; x < rect.width; x++) {
        const v = samples[Math.min(samples.length - 1, Math.floor((x / rect.width) * samples.length))]
        const h = Math.max(0.5, (v / maximum) * 20)
        ctx.fillRect(x, (channel ? 39 : 13) - h / 2, 1, h)
      }
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--h-ink')
    const x = ($('take-audio').currentTime / duration) * rect.width
    ctx.fillRect(x, 0, 1, 52)
  }
  async function showDraft(value, wav) {
    clearDraft()
    draft = value
    duration = value.audio.duration
    if (wav) blobURL = URL.createObjectURL(wav)
    const url = blobURL || urlFor(value.id, 'performance.wav')
    $('take-audio').src = url
    $('download-draft').href = url
    $('take-name').value = value.title
    $('take-name').readOnly = !!value.id
    $('keep-take').hidden = !!value.id
    $('discard-take').textContent = value.id ? 'Close' : 'Discard'
    $('take-draft').hidden = false
    $('draft-details').textContent =
      `${time(duration)} · ${value.audio.sampleRate / 1000} kHz · ${value.sources.length} code version${value.sources.length === 1 ? '' : 's'}`
    $('take-markers').replaceChildren(
      ...value.events
        .filter((e) => e.type === 'marker')
        .map((event) => {
          const button = node('button', `${time(event.at)} · ${event.note}`)
          button.onclick = () => {
            $('take-audio').currentTime = event.at
            drawWave()
          }
          return button
        })
    )
    sync()
    try {
      const bytes = await (wav || (await (await fetch(url)).blob())).arrayBuffer()
      if (draft !== value) return
      const floats = new Float32Array(bytes, 56),
        bins = 1600
      waveSamples = { left: new Float32Array(bins), right: new Float32Array(bins) }
      for (let i = 0; i < floats.length; i += 2) {
        const b = Math.min(bins - 1, Math.floor((i / floats.length) * bins))
        waveSamples.left[b] = Math.max(waveSamples.left[b], Math.abs(floats[i]))
        waveSamples.right[b] = Math.max(waveSamples.right[b], Math.abs(floats[i + 1]))
      }
      drawWave()
    } catch {
      message('Audio is available; the waveform could not be drawn.')
    }
  }
  async function record() {
    if (active) {
      active.stopping = true
      active.recorder.stop()
      return
    }
    if (preparing || saving || !S.started || (draft && !draft.id)) return
    const code = S.ed.repl.state.activeCode
    if (!code || new TextEncoder().encode(code).length > 65536) {
      message('Recording needs an active pattern of at most 64 KB.', true)
      return
    }
    if (draft) clearDraft()
    preparing = true
    sync()
    message()
    let recorder
    try {
      const context = window.getAudioContext(),
        output = window.getSuperdoughAudioController().output.destinationGain
      const manifest = {
        schema: 'strudel-take/1',
        captureId: crypto.randomUUID(),
        title: '',
        track: S.file,
        recordedAt: new Date().toISOString(),
        sources: [{ code }],
        events: [{ type: 'source', audioTime: context.currentTime, ...clock(), source: 0, ...mix() }]
      }
      recorder = await capture(context, output, (seconds) => {
        $('take-clock').textContent = time(seconds)
      })
      manifest.sources[0].code = S.ed.repl.state.activeCode
      if (new TextEncoder().encode(manifest.sources[0].code).length > 65536)
        throw new Error('The active pattern exceeds the 64 KB recording limit.')
      manifest.events[0] = { type: 'source', audioTime: context.currentTime, ...clock(), source: 0, ...mix() }
      const session = {
        recorder,
        context,
        output,
        manifest,
        sourceBytes: new TextEncoder().encode(manifest.sources[0].code).length,
        stopping: false
      }
      active = session
      preparing = false
      sync()
      $('take-clock').textContent = '0:00'
      $('take-live-note').textContent = 'Recording your mix and code changes.'
      recorder.start()
      await recorder.started
      if (!S.started) recorder.stop('transport stopped')
      const audio = await recorder.done
      if (active !== session) return
      active = null
      // First event describes the sound at the first captured frame. Later requests are clamped
      // to the captured interval when the context was suspended or stopped between render quanta.
      manifest.events = manifest.events.map(({ audioTime, ...event }, i) => ({
        ...event,
        at: i === 0 ? 0 : Math.max(0, Math.min(audio.duration, audioTime - audio.startedAt))
      }))
      manifest.title = `Take ${takes.length + 1}`
      manifest.reason = audio.reason
      manifest.audio = { duration: audio.duration, frames: audio.frames, sampleRate: audio.sampleRate }
      if (!audio.frames) throw new Error('No audio was captured. Play the track and try again.')
      await showDraft(manifest, audio.blob)
      message(
        audio.reason === 'finished'
          ? 'Captured. Listen back and keep the parts you want to remember.'
          : `Captured · ${audio.reason}. Your take is ready to keep.`
      )
    } catch (error) {
      recorder?.stop('recorder error')
      active = null
      message(error.message, true)
    } finally {
      preparing = false
      sync()
    }
  }
  async function keep() {
    if (!draft || draft.id || saving) return
    const title = $('take-name').value.trim()
    if (!title) {
      $('take-name').focus()
      message('Give this take a name.', true)
      return
    }
    draft.title = title
    saving = true
    sync()
    message('Keeping audio, source and moments…')
    try {
      const wav = await (await fetch(blobURL)).blob()
      const token = document.querySelector('meta[name="take-token"]'),
        body = packTake(draft, wav)
      const upload = () =>
        fetch('/_takes', { method: 'POST', headers: { 'x-take-token': token.content }, body })
      let response = await upload()
      if (response.status === 403) {
        // A server restart rotates the token. Refresh it without reloading and losing the take.
        const page = await (await fetch('/', { cache: 'no-store' })).text()
        const refreshed = new DOMParser()
          .parseFromString(page, 'text/html')
          .querySelector('meta[name="take-token"]')?.content
        if (refreshed) {
          token.content = refreshed
          response = await upload()
        }
      }
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not keep this take')
      draft.id = result.id
      $('take-name').readOnly = true
      $('keep-take').hidden = true
      $('discard-take').textContent = 'Close'
      message(`Kept “${title}”. Audio, code and moments are in ${result.path}.`)
      await refreshTakes()
      $('take-shelf').hidden = false
      $('open-takes').setAttribute('aria-expanded', 'true')
    } catch (error) {
      message(`${error.message}. Your recording is still here; retry or download the WAV.`, true)
    } finally {
      saving = false
      sync()
    }
  }
  async function refreshTakes() {
    try {
      const response = await fetch('/_takes', { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load saved takes')
      takes = await response.json()
      $('take-list').replaceChildren(
        ...takes.map((take) => {
          const card = node('article', '', 'take-card'),
            actions = node('div', '', 'actions')
          card.append(
            node('strong', take.title),
            node(
              'p',
              `${time(take.audio.duration)} · ${take.markers} moment${take.markers === 1 ? '' : 's'} · ${take.versions} code version${take.versions === 1 ? '' : 's'}`
            )
          )
          const open = node('button', 'Open take')
          open.onclick = async () => {
            if (active || preparing || saving || (draft && !draft.id)) return
            try {
              const response = await fetch(urlFor(take.id, 'take.json'))
              if (!response.ok) throw new Error('This take is no longer available')
              await showDraft(await response.json())
              message(`Kept ${new Date(take.recordedAt).toLocaleString()}`)
            } catch (error) {
              message(error.message, true)
            }
          }
          actions.append(open)
          for (const [label, file] of [
            ['WAV', 'performance.wav'],
            ['Audio + source', 'take.zip']
          ]) {
            const link = node('a', label)
            link.href = urlFor(take.id, file)
            link.download = file
            actions.append(link)
          }
          card.append(actions)
          return card
        })
      )
      $('take-empty').hidden = !!takes.length
      sync()
    } catch (error) {
      message(error.message, true)
    }
  }
  function marker() {
    if (!active) return
    const note =
      $('marker-note').value.trim() ||
      `Moment ${active.manifest.events.filter((e) => e.type === 'marker').length + 1}`
    event('marker', { note })
    $('marker-note').value = ''
    $('take-live-note').textContent = `Marked: ${note}`
  }
  $('record').onclick = record
  $('keep-take').onclick = keep
  $('mark').onclick = marker
  $('add-marker').onclick = marker
  $('marker-note').onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      marker()
    }
  }
  $('discard-take').onclick = () => {
    if (!saving) {
      clearDraft()
      message()
    }
  }
  $('open-takes').onclick = () => {
    const open = $('take-shelf').hidden
    $('take-shelf').hidden = !open
    $('open-takes').setAttribute('aria-expanded', String(open))
    if (open) refreshTakes()
  }
  $('take-audio').onplay = () => {
    if (active || preparing) $('take-audio').pause()
    else stop()
  }
  $('take-audio').ontimeupdate = drawWave
  $('take-wave').onclick = (event) => {
    if (duration) {
      $('take-audio').currentTime = (duration * event.offsetX) / $('take-wave').clientWidth
      drawWave()
    }
  }
  new ResizeObserver(drawWave).observe($('take-wave'))
  window.addEventListener('beforeunload', (event) => {
    if (active || preparing || (draft && !draft.id)) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  refreshTakes()
  return {
    sync,
    source,
    refreshTakes,
    busy: () => !!active || preparing,
    mix: () => event('mix', mix()),
    transport(playing) {
      if (playing) $('take-audio').pause()
      event('transport', { playing })
      if (!playing && active) {
        active.stopping = true
        active.recorder.stop('transport stopped')
      }
      sync()
    },
    checkOutput(output) {
      if (active && active.output !== output) {
        active.stopping = true
        active.recorder.stop('audio output changed')
      }
    }
  }
}
