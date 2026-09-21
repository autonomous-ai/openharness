// Repeatable counterfactuals in the same MuJoCo engine as the live scene. Each run owns its data;
// temporary model options are restored before yielding to the viewer, including on cancellation.
export function capturePhysics(model) {
  return {
    gravity: Array.from(model.opt.gravity),
    geomFriction: Array.from(model.geom_friction),
    pairFriction: Array.from(model.pair_friction),
    overrideFriction: Array.from(model.opt.o_friction),
  }
}

export function captureState(m, model, data) {
  const spec = m.mjtState.mjSTATE_INTEGRATION.value
  const buffer = new m.DoubleBuffer(m.mj_stateSize(model, spec))
  try {
    m.mj_getState(model, data, buffer, spec)
    return { spec, values: Array.from(buffer.GetView()), time: data.time }
  } finally { buffer.delete() }
}

export function restoreState(m, model, data, snapshot) {
  m.mj_setState(model, data, snapshot.values, snapshot.spec)
  m.mj_forward(model, data)
}

/** Capture the exact files already compiled in this pane, even if the agent has since edited disk. */
export function captureModelFiles(engine, paths) {
  return [...new Set(paths)].map((path) => {
    const bytes = engine.mujoco.FS.readFile(`/working/${path}`)
    const parts = []
    for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)))
    return { path, base64: btoa(parts.join('')) }
  })
}

function physics(model, original, gravity = 1, grip = 1) {
  model.opt.gravity.set(original.gravity.map((x) => x * gravity))
  model.geom_friction.set(original.geomFriction.map((x) => x * grip))
  model.pair_friction.set(original.pairFriction.map((x) => x * grip))
  if (original.overrideFriction) model.opt.o_friction.set(original.overrideFriction.map((x) => x * grip))
}

// Same interpolation as the live viewer. A saved control tape is open loop: no Python controller
// or learned policy is being re-evaluated in the browser.
export function controlsAt(tape, time, ctrl) {
  if (!tape?.ctrl?.length || tape.ctrl[0].length !== ctrl.length) return
  const u = Math.max(0, Math.min(tape.ctrl.length - 1, (time - tape.time0) / tape.dt))
  const k = Math.floor(u), f = u - k
  const a = tape.ctrl[k], b = tape.ctrl[Math.min(k + 1, tape.ctrl.length - 1)]
  for (let i = 0; i < ctrl.length; i++) ctrl[i] = a[i] + (b[i] - a[i]) * f
}

function sample(m, model, data, body, start) {
  // mj_step leaves some derived quantities at the beginning of the step. Compute the actual
  // endpoint before measuring or drawing it, without disturbing the solver's warm start.
  m.mj_forward(model, data)
  const position = Array.from(data.xipos.subarray(body * 3, body * 3 + 3))
  if (![...data.qpos, ...data.qvel, ...position].every(Number.isFinite)) throw new Error('The experiment became unstable. Try a smaller change.')
  return { t: data.time - start, time: data.time, position, contacts: data.ncon,
    qpos: Array.from(data.qpos), qvel: Array.from(data.qvel), act: Array.from(data.act), ctrl: Array.from(data.ctrl) }
}

/** Both futures share one full integration state, body, timestep and control tape. */
export async function compareFutures(engine, {
  snapshot, original = capturePhysics(engine.model), tape = null,
  body, duration = 3, gravity = 1, grip = 1, push = 0,
  signal, onProgress = () => {}, yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0)),
}) {
  const { mujoco: m, model } = engine
  if (!model || !Number.isInteger(body) || body < 1 || body >= model.nbody) throw new Error('Select a moving body to compare.')
  for (const [name, value, lo, hi] of [['duration', duration, 0.1, 10], ['gravity', gravity, 0, 3], ['grip', grip, 0, 3], ['push', push, -100, 100]]) {
    if (!Number.isFinite(value) || value < lo || value > hi) throw new Error(`Invalid ${name} for this experiment.`)
  }
  const steps = Math.ceil(duration / model.opt.timestep)
  if (!Number.isFinite(steps) || steps > 100_000) throw new Error('This timestep needs too many steps. Choose a shorter experiment.')
  const stride = Math.max(1, Math.ceil(steps / 180))
  const currentPhysics = capturePhysics(model)
  const check = () => {
    if (signal?.aborted || engine.model !== model) throw new DOMException('Experiment cancelled', 'AbortError')
  }
  const runs = []
  for (let lane = 0; lane < 2; lane++) {
    check()
    const data = new m.MjData(model)
    const frames = []
    const variant = lane === 1
    try {
      restoreState(m, model, data, snapshot)
      const baseForce = data.xfrc_applied[body * 6]
      let step = 0
      while (step < steps) {
        check()
        const wall = performance.now()
        try {
          physics(model, original, variant ? gravity : 1, variant ? grip : 1)
          if (!step) frames.push(sample(m, model, data, body, snapshot.time))
          do {
            if (tape) controlsAt(tape, data.time, data.ctrl)
            data.xfrc_applied[body * 6] = baseForce + (variant && step * model.opt.timestep < 0.15 ? push : 0)
            const before = data.time
            m.mj_step(model, data)
            if (data.time <= before) throw new Error('MuJoCo reset an unstable experiment. Try a smaller change.')
            step++
            if (step % stride === 0 || step === steps) frames.push(sample(m, model, data, body, snapshot.time))
          } while (step < steps && performance.now() - wall < 8)
        } finally { physics(model, currentPhysics) }
        onProgress((lane + step / steps) / 2)
        await yieldFrame()
      }
      runs.push({ label: variant ? 'Changed world' : 'Original world', frames })
    } finally { data.delete() }
  }
  check()
  const baseline = runs[0], variant = runs[1]
  const distances = baseline.frames.map((frame, i) => Math.hypot(...frame.position.map((x, axis) => x - variant.frames[i].position[axis])))
  const maxSeparation = Math.max(...distances), maxSeparationFrame = distances.indexOf(maxSeparation)
  return {
    version: 1, kind: 'mujoco-counterfactual', model: engine.path, mujocoVersion: engine.version,
    body, bodyName: engine.info?.bodies[body]?.name || `body ${body}`, timestep: model.opt.timestep,
    duration: steps * model.opt.timestep, requestedDuration: duration,
    change: { gravityScale: gravity, frictionScale: grip, pushNewtons: push, pushAxis: '+X world', pushSeconds: Math.min(0.15, steps * model.opt.timestep) },
    originalPhysics: original, startingState: snapshot,
    controls: tape ? { kind: 'recorded-open-loop', tape } : { kind: 'held-at-start' },
    baseline, variant,
    metrics: { finalSeparation: distances.at(-1), maxSeparation,
      maxSeparationFrame, maxSeparationTime: baseline.frames[maxSeparationFrame].t,
      baselineMinHeight: Math.min(...baseline.frames.map((f) => f.position[2])), variantMinHeight: Math.min(...variant.frames.map((f) => f.position[2])) },
  }
}

export function comparisonCsv(result) {
  const rows = ['seconds,original_x_m,original_y_m,original_z_m,changed_x_m,changed_y_m,changed_z_m,separation_m,original_contacts,changed_contacts']
  result.baseline.frames.forEach((a, i) => {
    const b = result.variant.frames[i]
    rows.push([a.t, ...a.position, ...b.position, Math.hypot(...a.position.map((x, axis) => x - b.position[axis])), a.contacts, b.contacts].join(','))
  })
  return rows.join('\n') + '\n'
}
