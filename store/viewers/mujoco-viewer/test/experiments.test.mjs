import { test } from 'node:test'
import assert from 'node:assert/strict'
import loadMujoco from '../node_modules/@mujoco/mujoco/mujoco.js'
import { capturePhysics, captureState, compareFutures, comparisonCsv, controlsAt } from '../public/experiments.js'

const m = await loadMujoco()
const XML = `<mujoco model="freefall"><option timestep="0.001" integrator="RK4"/>
  <worldbody><body name="ball" pos="0 0 10"><freejoint/><geom type="sphere" size=".1" mass="1"/></body></worldbody></mujoco>`
m.FS.writeFile('/experiment.xml', XML)
function fixture() {
  const model = m.MjModel.mj_loadXML('/experiment.xml'), data = new m.MjData(model)
  m.mj_forward(model, data)
  return { mujoco: m, model, data, path: 'scenes/freefall.xml', version: m.mj_versionString(),
    info: { bodies: [{}, { name: 'ball' }] }, dispose() { data.delete(); model.delete() } }
}
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`)
const immediate = async () => {}

test('freefall counterfactual agrees with analytical gravity and preserves the live state', async () => {
  const e = fixture()
  try {
    const snapshot = captureState(m, e.model, e.data), original = capturePhysics(e.model)
    const result = await compareFutures(e, { snapshot, body: 1, duration: 1, gravity: 0.165, yieldFrame: immediate })
    close(result.baseline.frames.at(-1).position[2], 10 - 9.81 / 2, 'Earth drop')
    close(result.variant.frames.at(-1).position[2], 10 - 9.81 * 0.165 / 2, 'reduced gravity drop')
    close(result.metrics.finalSeparation, 9.81 * (1 - 0.165) / 2, 'difference in positions')
    assert.deepEqual(captureState(m, e.model, e.data), snapshot)
    assert.deepEqual(capturePhysics(e.model), original)
    assert.equal(result.controls.kind, 'held-at-start')
    const csv = comparisonCsv(result).trim().split('\n')
    assert.equal(csv.length, result.baseline.frames.length + 1)
    close(Number(csv.at(-1).split(',')[7]), result.metrics.finalSeparation, 'CSV matches measured separation')
  } finally { e.dispose() }
})

test('unchanged futures match exactly; fixed force pulse follows impulse mechanics', async () => {
  const e = fixture()
  try {
    const snapshot = captureState(m, e.model, e.data)
    const same = await compareFutures(e, { snapshot, body: 1, duration: 1, yieldFrame: immediate })
    assert.deepEqual(same.baseline.frames, same.variant.frames)
    const pushed = await compareFutures(e, { snapshot, body: 1, duration: 1, push: 10, yieldFrame: immediate })
    close(pushed.variant.frames.at(-1).qvel[0], 10 * .15, 'velocity from 0.15 s pulse')
    close(pushed.variant.frames.at(-1).position[0], 10 * .15 * (1 - .15 / 2), 'horizontal displacement')
    const again = await compareFutures(e, { snapshot, body: 1, duration: 1, push: 10, yieldFrame: immediate })
    assert.deepEqual(pushed.variant.frames, again.variant.frames)
  } finally { e.dispose() }
})

test('friction changes real sliding contacts, including explicit contact pairs', async () => {
  m.FS.writeFile('/sliding.xml', `<mujoco><option timestep=".001"/><worldbody>
    <geom name="ground" type="plane" size="4 4 .1"/>
    <body name="slider" pos="0 0 .1"><freejoint/><geom name="box" type="box" size=".1 .1 .1" mass="1"/></body>
    </worldbody><contact><pair geom1="ground" geom2="box" friction=".7 .7 .01 .001 .001"/></contact></mujoco>`)
  const model = m.MjModel.mj_loadXML('/sliding.xml'), data = new m.MjData(model)
  const e = { mujoco: m, model, data, path: 'sliding.xml', version: m.mj_versionString() }
  try {
    data.qvel[0] = 2
    m.mj_forward(model, data)
    const original = capturePhysics(model), snapshot = captureState(m, model, data)
    const result = await compareFutures(e, { snapshot, body: 1, duration: 2, grip: .01, yieldFrame: immediate })
    assert.ok(result.baseline.frames.at(-1).position[0] < .8, 'normal surface brings the slider to rest')
    assert.ok(result.variant.frames.at(-1).position[0] > 3.5, 'low-friction surface preserves most of its motion')
    assert.deepEqual(capturePhysics(model), original)
    assert.deepEqual(captureState(m, model, data), snapshot)
  } finally { data.delete(); model.delete() }
})

test('cancellation and callback failure restore model options before returning control', async () => {
  const e = fixture()
  try {
    const original = capturePhysics(e.model), snapshot = captureState(m, e.model, e.data)
    const abort = new AbortController()
    await assert.rejects(compareFutures(e, { snapshot, body: 1, gravity: 0, grip: .1, signal: abort.signal,
      onProgress(f) { assert.deepEqual(capturePhysics(e.model), original); if (f > .5) abort.abort() }, yieldFrame: immediate }), { name: 'AbortError' })
    assert.deepEqual(capturePhysics(e.model), original)
    await assert.rejects(compareFutures(e, { snapshot, body: 1, gravity: 0, onProgress() { throw new Error('callback failed') }, yieldFrame: immediate }), /callback failed/)
    assert.deepEqual(capturePhysics(e.model), original)
    assert.deepEqual(captureState(m, e.model, e.data), snapshot)
  } finally { e.dispose() }
})

test('control tape interpolates, holds its ends, and never invents a feedback policy', () => {
  const tape = { time0: 2, dt: .5, ctrl: [[0, 4], [2, 2], [4, 0]] }, ctrl = new Float64Array(2)
  controlsAt(tape, 0, ctrl); assert.deepEqual([...ctrl], [0, 4])
  controlsAt(tape, 2.25, ctrl); assert.deepEqual([...ctrl], [1, 3])
  controlsAt(tape, 9, ctrl); assert.deepEqual([...ctrl], [4, 0])
})

test('invalid parameters cannot run an unbounded simulation', async () => {
  const e = fixture()
  try {
    const snapshot = captureState(m, e.model, e.data)
    for (const option of [{ duration: Infinity }, { duration: 0 }, { gravity: NaN }, { body: 0 }, { grip: -1 }, { push: 101 }]) {
      await assert.rejects(compareFutures(e, { snapshot, body: 1, ...option }), /Invalid|Select/)
    }
    e.model.opt.timestep = .0000001
    await assert.rejects(compareFutures(e, { snapshot, body: 1 }), /too many steps/)
  } finally { e.dispose() }
})
