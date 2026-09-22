// Read the real CircuitJS API at solver time steps. No circuit solver or synthesized waveform.
export const CAPTURE_LIMITS = {
  probes: 8,
  samples: 5001,
  circuit: 512 * 1024,
  body: 4 * 1024 * 1024,
  wallMs: 30000
}

export function probesFor(sim) {
  const probes = [],
    labels = new Set()
  const elements = sim.getElements()
  if (elements.length > 1000)
    throw new Error('Scope Lab supports circuits with at most 1,000 elements')
  elements.forEach((element, index) => {
    const type = element.getType(),
      name = type.replace(/Elm$/, ''),
      count = element.getPostCount()
    if (type === 'LabeledNodeElm') {
      const label = element.getLabelName()
      if (label && !labels.has(label) && label.length <= 120) {
        labels.add(label)
        probes.push({
          id: `node:${label}`,
          kind: 'node',
          label: `V(${label})`,
          node: label,
          unit: 'V',
          type,
          index
        })
      }
      return
    }
    if (['WireElm', 'GroundElm', 'TextElm', 'BoxElm'].includes(type) || !count)
      return
    if (count === 2 || count === 1)
      probes.push({
        id: `v:${index}:${type}`,
        kind: count === 1 ? 'post' : 'voltage',
        index,
        type,
        label: `${name} #${index + 1} · voltage`,
        unit: 'V'
      })
    if (count === 2)
      probes.push({
        id: `i:${index}:${type}`,
        kind: 'current',
        index,
        type,
        label: `${name} #${index + 1} · current`,
        unit: 'A'
      })
  })
  return probes.sort((a, b) => (a.kind !== 'node') - (b.kind !== 'node'))
}

export function pacedCircuit(text) {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    new TextEncoder().encode(text).length > CAPTURE_LIMITS.circuit
  )
    throw new Error('The native circuit export must be at most 512 KB')
  // Change only the native display/iteration pacing. The solver timestep and parts stay as exported.
  if (/^\s*<cir\b/.test(text)) {
    const root = text.match(/^\s*<cir\b[^>]*>/)?.[0]
    if (!root || !/\bic="[0-9.eE+\-]+"/.test(root))
      throw new Error('Unsupported CircuitJS export pacing')
    return text.replace(root, root.replace(/\bic="[0-9.eE+\-]+"/, 'ic="2000"'))
  }
  if (/^\s*\$\s/.test(text))
    return text.replace(
      /^(\s*\$\s+\S+\s+\S+\s+)\S+/,
      (_, prefix) => prefix + '2000'
    )
  throw new Error('Unsupported native circuit export format')
}

export function sampleStatistics(samples, probes) {
  return probes.map((probe, col) => {
    let min = Infinity,
      max = -Infinity,
      sum = 0,
      squares = 0
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i][col + 1]
      min = Math.min(min, value)
      max = Math.max(max, value)
      if (i) {
        const dt = samples[i][0] - samples[i - 1][0],
          previous = samples[i - 1][col + 1]
        sum += (dt * (previous + value)) / 2
        squares += (dt * (previous * previous + value * value)) / 2
      }
    }
    const span = samples.length > 1 ? samples.at(-1)[0] - samples[0][0] : 0
    return {
      id: probe.id,
      min: samples.length ? min : null,
      max: samples.length ? max : null,
      mean: span ? sum / span : null,
      rms: span ? Math.sqrt(squares / span) : null
    }
  })
}

export function makeSampler({ sim, probes, duration, onFinish = () => {} }) {
  if (!Number.isFinite(duration) || duration < 0.001 || duration > 5)
    throw new Error('Choose a 1 ms–5 s capture')
  if (!probes.length || probes.length > CAPTURE_LIMITS.probes)
    throw new Error('Choose 1–8 probes')
  const elements = sim.getElements(),
    available = new Map(probesFor(sim).map((p) => [p.id, p]))
  for (const p of probes)
    if (!available.has(p.id) || available.get(p.id).label !== p.label)
      throw new Error(
        'The probes changed. Choose them again on the current circuit.'
      )
  const readers = probes.map((p) =>
    p.kind === 'node'
      ? () => sim.getNodeVoltage(p.node)
      : p.kind === 'post'
        ? () => elements[p.index].getVoltage(0)
        : p.kind === 'current'
          ? () => elements[p.index].getCurrent()
          : () => elements[p.index].getVoltageDiff()
  )
  const samples = [],
    origin = sim.getTime(),
    interval = duration / 2000
  let stopped = false,
    next = 0,
    previous = -Infinity,
    lastStepTime = -Infinity,
    steps = 0,
    minStep = Infinity,
    maxStep = 0
  const result = {
    samples,
    duration,
    interval,
    origin,
    status: 'recording',
    reason: '',
    solverSteps: 0,
    minStep: null,
    maxStep: null
  }
  function stop(reason = 'Stopped by you', complete = false) {
    if (stopped) return result
    stopped = true
    sim.setSimRunning(false)
    Object.assign(result, {
      status: complete ? 'complete' : 'partial',
      reason,
      solverSteps: steps,
      minStep: Number.isFinite(minStep) ? minStep : null,
      maxStep: maxStep || null
    })
    onFinish(result)
    return result
  }
  function step() {
    if (stopped) return
    try {
      const time = sim.getTime() - origin,
        dt = sim.getTimeStep()
      if (!Number.isFinite(time) || time < 0 || time < lastStepTime)
        return stop('The native simulation clock moved backwards')
      lastStepTime = time
      if (!Number.isFinite(dt) || dt <= 0)
        return stop('The native timestep is invalid')
      minStep = Math.min(minStep, dt)
      maxStep = Math.max(maxStep, dt)
      steps++
      result.solverSteps = steps
      if (time > previous && (time >= next || time >= duration)) {
        const values = readers.map((read) => read())
        if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))
          return stop(
            'A native probe returned a non-finite or out-of-range value'
          )
        samples.push([time, ...values])
        previous = time
        next = time + interval
        if (samples.length >= CAPTURE_LIMITS.samples)
          return stop('Sample limit reached')
      }
      if (time >= duration) stop('Requested simulation window captured', true)
      else if (steps >= 10000000) stop('Solver-step limit reached')
    } catch (error) {
      stop(`Native probe failed: ${error.message || error}`)
    }
  }
  return {
    result,
    step,
    stop,
    get stopped() {
      return stopped
    }
  }
}

export async function createCaptureEngine({
  frame,
  getSim,
  getSourceFile,
  getRuntime,
  onChange = () => {}
}) {
  let native = null,
    booting = null,
    active = null,
    timeout = null,
    poll = null
  async function boot() {
    if (native) return native
    if (booting) return booting
    frame.src =
      '/app/circuitjs.html?cct=%24%201%200.000005%205%2050%205%2043&running=false&mouseWheelEdit=false'
    booting = new Promise((resolve, reject) => {
      const start = Date.now(),
        timer = setInterval(() => {
          const candidate = frame.contentWindow?.CircuitJS1
          if (candidate?.getTime) {
            clearInterval(timer)
            native = candidate
            resolve(native)
          } else if (Date.now() - start > 15000) {
            clearInterval(timer)
            booting = null
            reject(new Error('The native capture simulator did not start'))
          }
        }, 40)
    })
    return booting
  }
  async function capture({ probes, duration }) {
    if (active) throw new Error('A capture is already running')
    const visible = getSim()
    if (!visible?.getElements().length) throw new Error('Load a circuit first')
    const sourceCircuit = visible.exportCircuit(),
      paced = pacedCircuit(sourceCircuit)
    const snapshot = {
      sourceCircuit,
      sourceFile: getSourceFile(),
      sourceTime: visible.getTime(),
      probes: structuredClone(probes),
      runtime: getRuntime()
    }
    active = { booting: true, cancelled: false }
    onChange({ status: 'starting' })
    try {
      const sim = await boot()
      if (active.cancelled)
        throw new Error('Capture cancelled before the simulator was ready')
      sim.setSimRunning(false)
      sim.ontimestep = () => {}
      sim.importCircuit(paced, false)
      const runCircuit = sim.exportCircuit(),
        start = performance.now()
      const take = {
        ...snapshot,
        spec: 'circuit-capture/1',
        id: crypto.randomUUID(),
        title: 'Circuit capture',
        note: '',
        createdAt: new Date().toISOString(),
        runCircuit,
        config: {
          duration,
          requestedPacing: 2000,
          maxTimeStep: sim.getMaxTimeStep()
        },
        samples: []
      }
      let resolveFinished
      const finished = new Promise((resolve) => {
        resolveFinished = resolve
      })
      const sampler = makeSampler({
        sim,
        probes,
        duration,
        onFinish: (result) => {
          clearTimeout(timeout)
          clearInterval(poll)
          Object.assign(take, result, {
            wallMs: performance.now() - start,
            statistics: sampleStatistics(result.samples, probes)
          })
          active = null
          sim.ontimestep = () => {}
          onChange(take)
          resolveFinished(take)
        }
      })
      active = sampler
      take.samples = sampler.result.samples
      sim.ontimestep = sampler.step
      timeout = setTimeout(
        () => sampler.stop('30-second capture time limit reached'),
        CAPTURE_LIMITS.wallMs
      )
      poll = setInterval(() => {
        if (!sim.isRunning() && !sampler.stopped)
          sampler.stop('The native simulator stopped')
        else onChange({ ...take, ...sampler.result })
      }, 150)
      sim.setSimRunning(true)
      return await finished
    } catch (error) {
      active = null
      clearTimeout(timeout)
      clearInterval(poll)
      onChange({ status: 'error', error: error.message })
      throw error
    }
  }
  return {
    capture,
    cancel() {
      if (active?.stop) active.stop()
      else if (active) active.cancelled = true
    },
    get busy() {
      return !!active
    }
  }
}
