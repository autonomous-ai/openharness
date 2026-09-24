import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureFrames } from '../pane/capture-worklet.mjs'
import { wave, packTake } from '../pane/recording.mjs'
import { unpackTake, readWave } from '../takes.mjs'
import { markedPassage, passageWave } from '../pane/take-loop.mjs'

test('a marked passage ends at the next distinct marker, including duplicate and end markers', () => {
  const events = [0.2, 0.2, 0.65, 1].map((at) => ({ type: 'marker', at }))
  const take = { audio: { frames: 8000, sampleRate: 8000 }, events }
  assert.deepEqual(markedPassage(take, events[0]), { startFrame: 1600, endFrame: 5200, start: 0.2, end: 0.65 })
  assert.equal(markedPassage(take, events[1]).end, 0.65)
  assert.equal(markedPassage(take, events[2]).endFrame, 8000)
  assert.equal(markedPassage(take, events[3]), null)
  assert.equal(markedPassage(take, { type: 'marker', at: 0.1 }), null)
})

test('loop audio contains the exact stereo frames of the selected passage without changing the full take', async () => {
  const samples = Float32Array.from({ length: 16000 }, (_, i) => (i % 101 - 50) / 40)
  const bytes = await wave([samples], 8000, 8000).arrayBuffer()
  const before = Buffer.from(bytes).toString('base64')
  const marker = { type: 'marker', at: 0.20006 }
  const take = { audio: { frames: 8000, sampleRate: 8000 }, events: [marker, { type: 'marker', at: 0.65006 }] }
  const range = markedPassage(take, marker)
  const loop = Buffer.from(await passageWave(bytes, take.audio, range).arrayBuffer())
  assert.equal(readWave(loop).frames, 3600)
  assert.equal(readWave(loop).duration, 0.45)
  assert.deepEqual(loop.subarray(56), Buffer.from(bytes).subarray(56 + 1600 * 8, 56 + 5200 * 8))
  assert.equal(Buffer.from(bytes).toString('base64'), before)
})

test('looping rejects mismatched audio and empty or out-of-bounds passages', async () => {
  const bytes = await wave([new Float32Array(16000)], 8000, 8000).arrayBuffer()
  const audio = { frames: 8000, sampleRate: 8000 }
  const range = { startFrame: 0, endFrame: 4000 }
  assert.throws(() => passageWave(bytes.slice(0, 20), audio, range), /does not match/)
  assert.throws(() => passageWave(bytes, { ...audio, sampleRate: 48000 }, range), /does not match/)
  for (const bad of [{ startFrame: -1, endFrame: 20 }, { startFrame: 0, endFrame: 8001 }, { startFrame: 2, endFrame: 2 }])
    assert.throws(() => passageWave(bytes, audio, bad), /Choose a moment/)
})

test('worklet buffer preserves exact stereo frames across chunks, stop is idempotent', () => {
  const messages = [],
    recorder = new CaptureFrames(20000, (message) => messages.push(message))
  const left = Float32Array.from({ length: 128 }, (_, i) => i / 128)
  const right = left.map((x) => -x)
  for (let n = 0; n < 40; n++) recorder.push([left, right], 128, 48000 + n * 128)
  recorder.stop()
  recorder.stop()
  assert.deepEqual(messages[0], { type: 'start', frame: 48000 })
  const samples = messages.filter((m) => m.type === 'chunk').flatMap((m) => [...m.data])
  assert.equal(samples.length, 5120 * 2)
  for (let i = 0; i < 5120; i++) {
    assert.equal(samples[i * 2], left[i % 128])
    assert.equal(samples[i * 2 + 1], right[i % 128] || 0)
  }
  assert.equal(messages.filter((m) => m.type === 'done').length, 1)
  assert.equal(recorder.push([left, right], 128, 60000), false)
})

test('recording limit ends at the exact frame; disconnected input is silence and mono copies to stereo', () => {
  const messages = [],
    recorder = new CaptureFrames(129, (message) => messages.push(message))
  recorder.push([], 128, 0)
  assert.equal(recorder.push([new Float32Array([0.25, 0.5])], 2, 128), false)
  const chunk = messages.find((m) => m.type === 'chunk').data
  assert.deepEqual([...chunk.slice(0, 256)], Array(256).fill(0))
  assert.deepEqual([...chunk.slice(256)], [0.25, 0.25])
  assert.deepEqual(messages.at(-1), { type: 'done', frames: 129, reason: 'limit' })
})

test('float WAV preserves values above unity and derives measured duration, peak and RMS', async () => {
  const samples = new Float32Array(2048).fill(-1.25)
  const bytes = Buffer.from(await wave([samples], 1024, 48000).arrayBuffer())
  assert.equal(bytes.toString('ascii', 36, 40), 'fact')
  assert.equal(bytes.readFloatLE(56), -1.25)
  const audio = readWave(bytes)
  assert.equal(audio.peak, 1.25)
  assert.equal(audio.rms, 1.25)
  assert.equal(audio.duration, 1024 / 48000)
  const wrongFrames = Buffer.from(bytes)
  wrongFrames.writeUInt32LE(1025, 44)
  assert.throws(() => readWave(wrongFrames), /length/)
  const invalidFloat = Buffer.from(bytes)
  invalidFloat.writeFloatLE(Infinity, 56)
  assert.throws(() => readWave(invalidFloat), /non-finite/)
})

const manifest = () => ({
  schema: 'strudel-take/1',
  title: 'A live idea',
  track: 'track.strudel',
  recordedAt: '2026-09-21T12:00:00.000Z',
  reason: 'finished',
  sources: [{ code: 'note("a3").s("sine")' }],
  events: [
    { type: 'source', at: 0, cycle: 2.5, cps: 0.5, source: 0, muted: [], soloed: [] },
    { type: 'marker', at: 0.05, cycle: 2.525, cps: 0.5, note: 'Keep this' }
  ]
})
test('bounded performance journal rejects bad source references, event times and missing initial source', async () => {
  const wav = wave([new Float32Array(1600)], 800, 8000)
  const pack = async (value) => Buffer.from(await packTake(value, wav).arrayBuffer())
  const valid = unpackTake(await pack(manifest()))
  assert.equal(valid.take.events[1].note, 'Keep this')
  assert.equal(valid.take.sources[0].file, 'source/version-001.strudel')
  assert.throws(() => unpackTake(Buffer.from([0, 0, 0, 255])), /length/)
  for (const edit of [
    (m) => {
      m.events[0].source = 4
    },
    (m) => {
      m.events[1].at = 100
    },
    (m) => {
      m.events.reverse()
    },
    (m) => {
      m.sources[0].code = 'x'.repeat(65537)
    },
    (m) => {
      m.title = ''
    },
    (m) => {
      m.events[0].muted = ['x'.repeat(201)]
    }
  ]) {
    const value = manifest()
    edit(value)
    const bytes = await pack(value)
    assert.throws(() => unpackTake(bytes))
  }
})
