import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeSampler,
  pacedCircuit,
  probesFor,
  sampleStatistics
} from '../lab/capture.mjs'
import { captureSVG, nearestSample, traceBounds } from '../lab/plots.mjs'
import {
  captureHash,
  createCaptureStore,
  validateCapture
} from '../lab/store.mjs'

const runtime = {
  engine: 'CircuitJS1',
  sourceCommit: 'a'.repeat(40),
  compiledFiles: [{ name: 'test.cache.js', sha256: 'b'.repeat(64) }]
}
const source = '<cir f="1" ts="0.000005" ic="5"><r v="1000"/></cir>'
const probe = {
  id: 'node:OUT',
  kind: 'node',
  label: 'V(OUT)',
  node: 'OUT',
  unit: 'V',
  type: 'LabeledNodeElm',
  index: 0
}
function packet() {
  return {
    spec: 'circuit-capture/1',
    id: randomUUID(),
    title: 'RC response',
    note: 'Try 2 kΩ next.',
    createdAt: new Date().toISOString(),
    sourceFile: 'circuit.txt',
    sourceTime: 3,
    sourceCircuit: source,
    runCircuit: pacedCircuit(source),
    probes: [probe],
    config: { duration: 0.001, requestedPacing: 2000, maxTimeStep: 0.000005 },
    samples: [
      [0.000005, 1],
      [0.0005, 2],
      [0.001, 3]
    ],
    origin: 0,
    interval: 0.0000005,
    solverSteps: 200,
    minStep: 0.000005,
    maxStep: 0.000005,
    wallMs: 100,
    status: 'complete',
    reason: 'Requested simulation window captured',
    runtime
  }
}
function simulator() {
  const sim = {
    time: 4,
    dt: 0.0001,
    value: 2,
    running: true,
    getTime() {
      return this.time
    },
    getTimeStep() {
      return this.dt
    },
    getNodeVoltage() {
      return this.value
    },
    setSimRunning(v) {
      this.running = v
    },
    getElements() {
      return [
        {
          getType: () => 'LabeledNodeElm',
          getPostCount: () => 1,
          getLabelName: () => 'OUT'
        }
      ]
    }
  }
  return sim
}
function workspace() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'scope-lab-test-')))
}

test('pacing changes only display iteration field in both native formats', () => {
  assert.equal(pacedCircuit(source), source.replace('ic="5"', 'ic="2000"'))
  const text = '$ 65 5e-6 10.2 50 5 43 5e-11\nr 0 0 16 0 0 1000\n'
  assert.equal(pacedCircuit(text), text.replace('10.2', '2000'))
  assert.throws(() => pacedCircuit('<cir ts="1"/>'), /pacing/)
  assert.throws(() => pacedCircuit('r 0 0 0 0'), /format/)
  assert.throws(() => pacedCircuit(source + 'a'.repeat(512 * 1024)), /512 KB/)
})

test('probes prioritize named nodes and omit wires and duplicate labels', () => {
  const element = (type, count, label) => ({
    getType: () => type,
    getPostCount: () => count,
    getLabelName: () => label
  })
  const choices = probesFor({
    getElements: () => [
      element('ResistorElm', 2),
      element('WireElm', 2),
      element('LabeledNodeElm', 1, 'OUT'),
      element('LabeledNodeElm', 1, 'OUT'),
      element('TimerElm', 8),
      element('OutputElm', 1)
    ]
  })
  assert.deepEqual(
    choices.map((p) => p.id),
    ['node:OUT', 'v:0:ResistorElm', 'i:0:ResistorElm', 'v:5:OutputElm']
  )
})

test('sampler reads solver values and actual times, completes once, and stops only its simulator', () => {
  const sim = simulator()
  let completed = 0
  const sampler = makeSampler({
    sim,
    probes: [probe],
    duration: 0.001,
    onFinish: () => completed++
  })
  for (let i = 1; i <= 12; i++) {
    sim.time = 4 + i * 0.0001
    sim.value = i
    sampler.step()
  }
  assert.equal(sampler.result.status, 'complete')
  assert.equal(sim.running, false)
  assert.equal(completed, 1)
  assert.ok(sampler.result.samples.at(-1)[0] >= 0.001)
  assert.equal(sampler.result.samples[0][1], 1)
  assert.equal(sampler.result.minStep, 0.0001)
  assert.equal(sampler.result.solverSteps, sampler.result.samples.length)
  sampler.stop()
  assert.equal(completed, 1)
})

test('sampler catches clock reversal between stored samples', () => {
  const sim = simulator(),
    sampler = makeSampler({ sim, probes: [probe], duration: 5 })
  sim.time = 4.0001
  sampler.step()
  sim.time = 4.0002
  sampler.step()
  sim.time = 4.00015
  sampler.step()
  assert.equal(sampler.result.status, 'partial')
  assert.match(sampler.result.reason, /backwards/)
  assert.equal(sampler.result.samples.length, 1)
})

test('sampler records adaptive timesteps and never invents samples for missed intervals', () => {
  const sim = simulator(),
    sampler = makeSampler({ sim, probes: [probe], duration: 0.01 })
  sim.time += 0.001
  sim.dt = 0.001
  sampler.step()
  sim.time += 0.01
  sim.dt = 0.01
  sim.value = 7
  sampler.step()
  assert.equal(sampler.result.samples.length, 2)
  assert.equal(sampler.result.minStep, 0.001)
  assert.equal(sampler.result.maxStep, 0.01)
  assert.deepEqual(
    sampler.result.samples.map((r) => r[1]),
    [2, 7]
  )
})

test('sampler marks cancellation and invalid values as partial, and validates probe identity', () => {
  for (const value of [NaN, Infinity, 1e13]) {
    const sim = simulator(),
      sampler = makeSampler({ sim, probes: [probe], duration: 0.001 })
    sim.time += 0.0001
    sim.value = value
    sampler.step()
    assert.equal(sampler.result.status, 'partial')
    assert.equal(sampler.result.samples.length, 0)
  }
  const sim = simulator(),
    sampler = makeSampler({ sim, probes: [probe], duration: 0.001 })
  sampler.stop()
  assert.equal(sampler.result.status, 'partial')
  assert.match(sampler.result.reason, /Stopped by you/)
  assert.throws(
    () =>
      makeSampler({
        sim,
        probes: [{ ...probe, label: 'Wrong node' }],
        duration: 0.001
      }),
    /changed/
  )
  assert.throws(
    () => makeSampler({ sim, probes: [], duration: 0.001 }),
    /probes/
  )
})

test('statistics use time weighting; cursor picks the actual nearest stored sample', () => {
  const rows = [
      [0, 1],
      [1, 3],
      [4, 3]
    ],
    s = sampleStatistics(rows, [probe])[0]
  assert.equal(s.min, 1)
  assert.equal(s.max, 3)
  assert.equal(s.mean, 2.75)
  assert.equal(s.rms, Math.sqrt(8))
  assert.equal(nearestSample(rows, 2), rows[1])
  assert.equal(nearestSample(rows, 3.5), rows[2])
  assert.equal(nearestSample([], 1), null)
})

test('comparison maps matching probe identity and unit; SVG escapes user text', () => {
  const a = packet(),
    b = packet()
  b.samples = [
    [0, -12],
    [0.001, 15]
  ]
  assert.equal(traceBounds(a, 0, b).other, 0)
  assert.ok(traceBounds(a, 0, b).max > 15)
  b.probes = [{ ...probe, id: 'node:OTHER' }]
  assert.equal(traceBounds(a, 0, b).other, -1)
  a.title = '<script>alert("x")</script>'
  a.probes = [{ ...probe, label: 'A & B' }]
  const svg = captureSVG(a)
  assert.ok(!svg.includes('<script>'))
  assert.match(svg, /A &amp; B/)
  assert.ok(!/NaN|Infinity/.test(svg))
})

test('capture validation recomputes evidence and rejects inconsistent samples and completion', () => {
  const a = packet()
  a.statistics = [{ rms: 500 }]
  const valid = validateCapture(a, runtime)
  assert.notEqual(valid.statistics[0].rms, 500)
  assert.equal(valid.fingerprints.samples, captureHash(a.samples))
  for (const patch of [
    {
      samples: [
        [0, 1],
        [0, 2]
      ]
    },
    {
      samples: [
        [0, NaN],
        [0.001, 2]
      ]
    },
    { status: 'recording' },
    { solverSteps: 1 },
    { minStep: 0.01 },
    { createdAt: 'not a date' },
    {
      samples: [
        [0, 1],
        [0.0001, 2]
      ]
    },
    { probes: [probe, probe] },
    { id: '../outside' },
    { runtime: null }
  ])
    assert.throws(() => validateCapture({ ...a, ...patch }, runtime))
  assert.equal(
    validateCapture(
      {
        ...a,
        status: 'partial',
        samples: [
          [0, 1],
          [0.0001, 2]
        ]
      },
      runtime
    ).status,
    'partial'
  )
})

test('kept packets are immutable, retryable, self-contained, and reopen after source deletion', () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws, 'circuit.txt'), 'old source')
    const store = createCaptureStore(ws, runtime),
      a = packet(),
      saved = store.keep(a),
      dir = join(ws, '.harness', 'circuit-captures', a.id)
    assert.deepEqual(store.keep(a), saved)
    assert.throws(() => store.keep({ ...a, note: 'changed' }), /already kept/)
    rmSync(join(ws, 'circuit.txt'))
    const reopened = createCaptureStore(ws, {
      ...runtime,
      sourceCommit: 'c'.repeat(40)
    }).read(a.id)
    assert.equal(reopened.sourceCircuit, source)
    assert.deepEqual(reopened.runtime, runtime)
    assert.equal(store.list().length, 1)
    assert.equal(reopened.kept, true)
    const checks = JSON.parse(readFileSync(join(dir, 'checksums.json')))
    for (const [name, hash] of Object.entries(checks))
      assert.equal(captureHash(readFileSync(join(dir, name))), hash)
    assert.equal(
      readFileSync(join(dir, 'capture.zip')).readUInt32LE(0),
      0x04034b50
    )
    assert.match(readFileSync(join(dir, 'measurements.csv'), 'utf8'), /time_s/)
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /new simulation/)
    const zip = readFileSync(join(dir, 'capture.zip'))
    writeFileSync(join(dir, 'capture.zip'), 'changed archive')
    assert.throws(() => store.download(a.id), /archive was changed/)
    writeFileSync(join(dir, 'capture.zip'), zip)
    writeFileSync(join(dir, 'capture.json'), '{}')
    assert.throws(() => store.read(a.id), /changed on disk/)
    assert.throws(() => store.download(a.id), /changed on disk/)
    assert.deepEqual(store.list(), [])
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('failed ZIP leaves no published capture or staging directory', () => {
  const ws = workspace()
  try {
    const store = createCaptureStore(ws, runtime, {
      zipWriter() {
        throw new Error('disk full')
      }
    })
    assert.throws(() => store.keep(packet()), /disk full/)
    assert.deepEqual(readdirSync(join(ws, '.harness', 'circuit-captures')), [])
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('archives refuse symlinked directories and archive files', () => {
  const ws = workspace(),
    outside = workspace()
  try {
    symlinkSync(outside, join(ws, '.harness'))
    assert.throws(
      () => createCaptureStore(ws, runtime).keep(packet()),
      /real workspace/
    )
    assert.deepEqual(readdirSync(outside), [])
    rmSync(join(ws, '.harness'))
    const store = createCaptureStore(ws, runtime),
      a = packet()
    store.keep(a)
    const dir = join(ws, '.harness', 'circuit-captures', a.id)
    rmSync(join(dir, 'capture.zip'))
    writeFileSync(join(outside, 'secret'), 'not a packet')
    symlinkSync(join(outside, 'secret'), join(dir, 'capture.zip'))
    assert.throws(() => store.download(a.id), /unavailable/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
