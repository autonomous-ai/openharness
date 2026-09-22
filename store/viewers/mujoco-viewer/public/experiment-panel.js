import { capturePhysics, captureState, compareFutures, comparisonCsv } from './experiments.js'

const $ = (id) => document.getElementById(id)
const distance = (n) => Math.abs(n) < 1 ? `${(n * 100).toFixed(1)} cm` : `${n.toFixed(2)} m`
function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export class ExperimentPanel {
  constructor(root, context) {
    this.root = root
    this.context = context
    this.generation = 0
    this.previewing = this.running = this.playing = false
    root.innerHTML = `
      <div class="experiment-intro"><span class="eyebrow">A small physics lab</span>
        <h2>Try another future.</h2><p>Keep one starting point. Change the world around it. See what happens to both.</p></div>
      <div class="experiment-start"><button type="button" id="experiment-capture">Capture this moment</button>
        <span id="experiment-start-label">Choose a moment in the simulation or replay.</span></div>
      <label class="experiment-field">Follow a body<select id="experiment-body"></select></label>
      <div class="experiment-presets" aria-label="Ideas to try">
        <button type="button" data-experiment="moon">Lunar gravity</button>
        <button type="button" data-experiment="ice">Slippery ground</button>
        <button type="button" data-experiment="push">A sideways shove</button>
      </div>
      <label class="experiment-field" for="experiment-gravity"><span>Gravity <output id="experiment-gravity-value">1×</output></span>
        <input id="experiment-gravity" type="range" min="0" max="2" step="0.005" value="1"></label>
      <label class="experiment-field" for="experiment-grip"><span>Surface friction <output id="experiment-grip-value">1×</output></span>
        <input id="experiment-grip" type="range" min="0" max="2" step="0.05" value="1"></label>
      <label class="experiment-field" for="experiment-push"><span>Sideways force <output id="experiment-push-value">0 N</output></span>
        <input id="experiment-push" type="range" min="-100" max="100" step="1" value="0"></label>
      <p class="experiment-detail">Gravity and friction scale the model’s values. The shove lasts 0.15 seconds along the world’s X axis.</p>
      <label class="experiment-field experiment-duration">Compare the next <select id="experiment-duration"><option value="1">1 second</option><option value="3" selected>3 seconds</option><option value="5">5 seconds</option><option value="10">10 seconds</option></select></label>
      <div class="experiment-actions"><button type="button" class="accent" id="experiment-run">Compare futures</button><button type="button" id="experiment-cancel" hidden>Cancel</button></div>
      <p id="experiment-status" role="status" aria-live="polite"></p>
      <progress id="experiment-progress" max="1" value="0" hidden aria-label="Calculating both futures"></progress>
      <div id="experiment-results" hidden>
        <div class="experiment-legend"><span class="original">Original world · wireframe</span><span class="changed">Changed world · solid</span></div>
        <button type="button" id="experiment-frame">Frame both futures</button>
        <h3 id="experiment-result-title"></h3><p id="experiment-result-change" class="experiment-detail"></p>
        <div class="experiment-metrics"><button type="button" id="experiment-finish" title="Pause at the final stored frame"><strong id="experiment-separation"></strong><span>Apart at the finish</span><small>Show final moment →</small></button><button type="button" id="experiment-peak" title="Pause at the first stored frame with the greatest body separation"><strong id="experiment-maximum"></strong><span>Farthest apart</span><small id="experiment-peak-time"></small></button></div>
        <svg id="experiment-chart" viewBox="0 0 260 100" role="img" aria-label="Body height over time in the original and changed world"></svg>
        <div class="experiment-playback"><button type="button" id="experiment-play">Pause comparison</button><output id="experiment-clock">0.00 s</output></div>
        <input id="experiment-scrub" aria-label="Comparison frame" type="range" min="0" max="0" step="1" value="0">
        <p class="experiment-detail" id="experiment-control-note"></p>
        <div class="experiment-exports"><button type="button" id="experiment-json">Save experiment</button><button type="button" id="experiment-csv">Measurements CSV</button></div>
        <p class="experiment-detail">The saved experiment includes the model, its assets, starting state and controls. Give it to the agent to reproduce what you found, even after the project changes.</p>
      </div>
      <button type="button" id="experiment-return" hidden>Return to simulation</button>
    `
    $('experiment-capture').onclick = () => this.capture()
    $('experiment-run').onclick = () => this.run()
    $('experiment-cancel').onclick = () => this.leave()
    $('experiment-return').onclick = () => this.leave()
    $('experiment-frame').onclick = () => {
      if (!this.previewing && this.result) this.preview()
      this.context.stage.frameComparison(this.context.engine)
    }
    for (const name of ['gravity', 'grip', 'push']) $('experiment-' + name).oninput = () => this.labels()
    root.querySelectorAll('[data-experiment]').forEach((button) => button.addEventListener('click', () => {
      $('experiment-gravity').value = button.dataset.experiment === 'moon' ? '.165' : '1'
      $('experiment-grip').value = button.dataset.experiment === 'ice' ? '.05' : '1'
      $('experiment-push').value = button.dataset.experiment === 'push' ? '20' : '0'
      this.labels()
      this.run()
    }))
    $('experiment-play').onclick = () => {
      if (!this.previewing && this.result) this.preview()
      else {
        if (this.cursor >= (this.result?.baseline.frames.length ?? Infinity) - 1) { this.cursor = 0; this.playTime = 0; this.showFrame() }
        this.playing = !this.playing
      }
      this.playLabel()
    }
    $('experiment-scrub').oninput = () => this.seek(Number($('experiment-scrub').value))
    $('experiment-peak').onclick = () => this.seek(this.result?.metrics.maxSeparationFrame)
    $('experiment-finish').onclick = () => this.seek((this.result?.baseline.frames.length ?? 0) - 1)
    $('experiment-json').onclick = () => this.result && download('physics-experiment.json', JSON.stringify(this.result, null, 2), 'application/json')
    $('experiment-csv').onclick = () => this.result && download('physics-measurements.csv', comparisonCsv(this.result), 'text/csv')
    // Range keys and keyboard button activation belong to these controls, not the live transport.
    root.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && this.active) { event.preventDefault(); this.leave() }
    })
  }

  get active() { return this.running || this.previewing }

  labels() {
    $('experiment-gravity-value').textContent = `${Number($('experiment-gravity').value).toFixed(3).replace(/\.?0+$/, '') || '0'}×`
    $('experiment-grip-value').textContent = `${Number($('experiment-grip').value).toFixed(2).replace(/\.?0+$/, '') || '0'}×`
    $('experiment-push-value').textContent = `${$('experiment-push').value} N`
  }

  open() {
    if (!this.snapshot) this.capture()
  }

  capture() {
    const { engine: e, state } = this.context
    if (!e?.model) return
    this.leave({ notify: false })
    e.endPerturb(); e.clearPerturbForce()
    if (state.mode === 'video') this.context.simulate()
    state.playing = false
    this.snapshot = captureState(e.mujoco, e.model, e.data)
    this.original = capturePhysics(e.model)
    this.model = e.model
    this.revision = state.modelKey
    this.source = { model: state.modelPath, modelXml: state.compiledSource?.modelXml || null, modelPatch: structuredClone(state.compiledSource?.patch || {}), files: state.modelBundle }
    const follow = state.mode === 'replay' ? state.traj : state.ctrlSource === 'recording' ? state.follow : null
    this.tape = follow?.ctrl ? { ctrl: follow.ctrl.map((row) => [...row]), time0: follow.time0, dt: follow.dt } : null
    const select = $('experiment-body')
    const previous = Number(select.value)
    select.replaceChildren()
    for (const b of e.info.bodies) {
      if (b.id < 1 || b.mass <= 0) continue
      const option = document.createElement('option'); option.value = String(b.id); option.textContent = b.name; select.append(option)
    }
    const wanted = state.selected > 0 ? state.selected : previous || e.info.bodies.find((b) => b.id > 0 && b.joints.length)?.id
    if ([...select.options].some((option) => Number(option.value) === wanted)) select.value = String(wanted)
    $('experiment-start-label').textContent = `Pinned at ${this.snapshot.time.toFixed(2)} s · same start for every comparison`
    $('experiment-status').textContent = 'Try an idea above, or set your own conditions.'
    this.result = null
    $('experiment-results').hidden = true
  }

  async run() {
    if (this.running) return
    const { engine: e, state } = this.context
    if (!e?.model) return
    if (!this.snapshot || this.model !== e.model) this.capture()
    this.releasePreview()
    state.playing = false
    const generation = ++this.generation
    const abort = this.abort = new AbortController()
    this.running = true
    this.buttons()
    $('experiment-status').textContent = 'Calculating both futures from your pinned moment…'
    $('experiment-progress').value = 0
    try {
      const result = await compareFutures(e, {
        snapshot: this.snapshot, original: this.original, tape: this.tape, body: Number($('experiment-body').value),
        duration: Number($('experiment-duration').value), gravity: Number($('experiment-gravity').value),
        grip: Number($('experiment-grip').value), push: Number($('experiment-push').value), signal: abort.signal,
        onProgress: (f) => { if (generation === this.generation) $('experiment-progress').value = f },
      })
      if (generation !== this.generation) return
      result.modelRevision = this.revision
      result.source = this.source
      this.result = result
      this.running = false
      this.renderResult()
      this.preview()
      $('experiment-status').textContent = 'Two futures, ready to explore. Orbit the scene or scrub through time.'
    } catch (error) {
      if (generation !== this.generation) return
      $('experiment-status').textContent = error.name === 'AbortError' ? 'Experiment cancelled.' : String(error.message || error)
      this.running = false
    } finally {
      if (generation === this.generation) this.buttons()
    }
  }

  buttons() {
    for (const control of this.root.querySelectorAll('.experiment-presets button, #experiment-run, #experiment-capture, #experiment-body, #experiment-results button, #experiment-scrub')) control.disabled = this.running
    $('experiment-capture').disabled = this.running || this.previewing
    $('experiment-capture').title = this.previewing ? 'Return to the simulation or replay to pin a new moment' : ''
    $('experiment-cancel').hidden = !this.running
    $('experiment-progress').hidden = !this.running
    $('experiment-return').hidden = !this.active
    this.root.setAttribute('aria-busy', String(this.running))
    document.body.classList.toggle('comparing', this.previewing)
  }

  renderResult() {
    const r = this.result, c = r.change
    $('experiment-results').hidden = false
    $('experiment-result-title').textContent = `${r.bodyName} · ${r.duration.toFixed(2)} seconds`
    $('experiment-result-change').textContent = `${c.gravityScale}× gravity · ${c.frictionScale}× friction · ${c.pushNewtons} N shove`
    $('experiment-separation').textContent = distance(r.metrics.finalSeparation)
    $('experiment-maximum').textContent = distance(r.metrics.maxSeparation)
    $('experiment-peak-time').textContent = `At ${r.metrics.maxSeparationTime.toFixed(2)} s · Show moment →`
    $('experiment-control-note').textContent = r.controls.kind === 'recorded-open-loop'
      ? 'Both worlds use the recorded control tape, then hold its last values. The controller is not making new decisions.'
      : 'Both worlds hold the actuator values from your pinned moment.'
    $('experiment-scrub').max = String(r.baseline.frames.length - 1)
    this.chart()
  }

  chart() {
    const r = this.result, svg = $('experiment-chart'), ns = 'http://www.w3.org/2000/svg'
    const values = [...r.baseline.frames, ...r.variant.frames].map((f) => f.position[2])
    const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(.01, hi - lo)
    svg.replaceChildren()
    const make = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text) n.textContent = text; svg.append(n); return n }
    make('text', { x: 5, y: 12, class: 'chart-label' }, `Height · ${lo.toFixed(2)} to ${hi.toFixed(2)} m`)
    for (const [lane, run] of [r.baseline, r.variant].entries()) {
      const points = run.frames.map((f) => `${5 + f.t / r.duration * 250},${80 - (f.position[2] - lo) / span * 54}`).join(' ')
      make('polyline', { points, fill: 'none', class: lane ? 'changed' : 'original', 'stroke-width': 2, ...(lane ? {} : { 'stroke-dasharray': '4 3' }) })
    }
    make('line', { id: 'experiment-chart-cursor', x1: 5, x2: 5, y1: 22, y2: 82, class: 'chart-cursor' })
    make('text', { x: 5, y: 97, class: 'chart-label' }, '0 s')
    make('text', { x: 255, y: 97, 'text-anchor': 'end', class: 'chart-label' }, `${r.duration.toFixed(1)} s`)
  }

  preview() {
    if (!this.result || this.model !== this.context.engine.model) return
    this.releasePreview()
    const { engine: e, stage, state } = this.context
    state.playing = false
    this.data = [new e.mujoco.MjData(e.model), new e.mujoco.MjData(e.model)]
    stage.buildComparison(this.result)
    this.previewing = this.playing = true
    this.cursor = this.playTime = 0
    this.showFrame(); this.playLabel(); this.buttons()
  }

  showFrame() {
    if (!this.previewing) return
    const index = Math.floor(this.cursor), { engine: e, stage } = this.context
    for (const [lane, run] of [this.result.baseline, this.result.variant].entries()) {
      const f = run.frames[index], d = this.data[lane]
      d.qpos.set(f.qpos); d.qvel.set(f.qvel); d.ctrl.set(f.ctrl); d.act.set(f.act); d.time = f.time
      e.mujoco.mj_forward(e.model, d)
    }
    stage.syncComparison(...this.data)
    const t = this.result.baseline.frames[index].t
    $('experiment-clock').textContent = `${t.toFixed(2)} / ${this.result.duration.toFixed(2)} s`
    $('experiment-scrub').value = String(index)
    const x = 5 + t / this.result.duration * 250
    $('experiment-chart-cursor').setAttribute('x1', String(x)); $('experiment-chart-cursor').setAttribute('x2', String(x))
    this.context.legend(`${this.result.bodyName} · ${t.toFixed(2)} s`)
  }

  seek(index) {
    if (this.running || !this.result || !Number.isInteger(index) || index < 0 || index >= this.result.baseline.frames.length) return
    // Capture the requested frame before preview() resets the slider to its start.
    // This also lets a kept-on-screen comparison be inspected after returning live.
    if (!this.previewing) this.preview()
    if (!this.previewing) return
    this.playing = false
    this.cursor = index
    this.playTime = this.result.baseline.frames[index].t
    this.showFrame(); this.playLabel()
  }

  tick(elapsed) {
    if (!this.previewing || !this.playing) return
    const frames = this.result.baseline.frames
    this.playTime += elapsed
    while (this.cursor < frames.length - 1 && frames[this.cursor + 1].t <= this.playTime) this.cursor++
    if (this.playTime >= this.result.duration) { this.cursor = frames.length - 1; this.playing = false; this.playLabel() }
    this.showFrame()
  }

  playLabel() { $('experiment-play').textContent = this.playing ? 'Pause comparison' : this.cursor >= (this.result?.baseline.frames.length ?? Infinity) - 1 ? 'Replay comparison' : 'Play comparison' }

  releasePreview() {
    this.previewing = this.playing = false
    this.context.stage?.clearComparison()
    for (const d of this.data ?? []) d.delete()
    this.data = null
    this.context.legend(null)
  }

  leave({ notify = true } = {}) {
    const active = this.active
    this.abort?.abort(); this.generation++
    this.running = false
    this.releasePreview(); this.buttons()
    if (active) $('experiment-status').textContent = this.result ? 'Back in the simulation. Your comparison is still available below.' : 'Experiment cancelled.'
    if (notify && active) this.context.onLeave()
  }

  reset() {
    this.leave({ notify: false })
    this.snapshot = this.result = null
    $('experiment-results').hidden = true
    $('experiment-start-label').textContent = 'Capture a starting point in this model.'
    $('experiment-status').textContent = ''
  }
}
