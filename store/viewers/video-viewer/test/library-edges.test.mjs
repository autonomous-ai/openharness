// The library on every shape a workspace can be in: what the walk lists and skips, where chapters and
// beats come from (the wrapper's sidecar, Manim's own files) and when they are not trusted, what changed
// since the render before, renders in progress from the files and from the wrapper's status, and
// malformed files that must cost a render its extras rather than the pane its library.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { chmodSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLibrary, diffRenders, manimParts, qualityParts, readClipList } from '../lib/library.mjs'
import { box, gif, mp4, png, u32, videoTrak, workspace } from './media.mjs'

const MIN = 60_000
const spaces = []
function scratch() {
  const ws = workspace('video-viewer-library-')
  spaces.push(ws)
  const json = (rel, value, mtimeMs) => ws.put(rel, typeof value === 'string' ? value : JSON.stringify(value), mtimeMs)
  const scan = (options) => createLibrary(ws.dir, options).scan()
  return { ...ws, json, scan }
}
after(() => { for (const ws of spaces) ws.done() })
const render = (lib, path) => lib.renders.find((r) => r.path === path)
const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512))
const mvhd = (ts = 15360, dur = 15360) => box('mvhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), Buffer.alloc(80))
/** A whole movie whose track has no timing table: no frame count, no rate of its own. */
const noStts = (frames) => Buffer.concat([ftyp, box('moov', mvhd(), videoTrak({ frames, stts: false }))])
/** A whole movie with frames but no media or movie header: no duration anywhere, no rate of its own. */
const noTimes = (frames) => Buffer.concat([ftyp, box('moov', box('trak', box('mdia',
  box('hdlr', u32(0), u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)),
  box('minf', box('stbl', box('stts', u32(0), u32(1), u32(frames), u32(1)))))))])

test('paths: Manim layouts with and without a media folder, qualities, clip lists', () => {
  assert.deepEqual(manimParts('videos/proof/720p30/Proof.mov'), { media: '', module: 'proof', quality: '720p30', scene: 'Proof', file: 'Proof', key: 'videos/proof/Proof', qdir: 'videos/proof/720p30' })
  assert.deepEqual(qualityParts('1080p60'), { height: 1080, fps: 60 })
  assert.equal(qualityParts('hd'), null)
  assert.equal(qualityParts(undefined), null)
  const ws = scratch()
  assert.equal(readClipList(join(ws.dir, 'missing.txt')), null)
})

test('diffRenders: nothing to compare, contiguous and separate changes, chapters added, removed and retimed', () => {
  const beats = (list) => { let s = 0; return list.map(([name, frames]) => { const b = { name, fp: name, start: s, frames }; s += frames; return b }) }
  assert.deepEqual(diffRenders({ duration: null, frames: null, beats: null, sections: null }, { mtimeMs: 5, duration: null, frames: null, beats: null, sections: null }),
    { at: 5, durationDelta: 0, framesDelta: 0, ranges: null, sections: null, same: false }, 'without beats a render is never known to be the same')

  const prev = { duration: 2, frames: 30, beats: beats([['h1', 10], ['h2', 20]]), sections: null }
  assert.deepEqual(diffRenders(prev, { duration: 1, frames: 12, beats: beats([['n1', 8], ['n2', 4]]), sections: null }).ranges, [[0, 12]], 'adjacent new animations are one range')
  assert.deepEqual(diffRenders(prev, { duration: 3, frames: 43, beats: beats([['n1', 8], ['h1', 10], ['h2', 20], ['n3', 5]]), sections: null }).ranges, [[0, 8], [38, 43]])

  const A = { name: 'A', start: 0, frames: 10 }, B = { name: 'B', start: 10, frames: 20 }
  const withSections = (sections, list = [['h1', 10], ['h2', 20]]) => ({ duration: 2, frames: 30, beats: beats(list), sections })
  assert.deepEqual(diffRenders(withSections(null), withSections([A, B])).sections, { added: ['A', 'B'], removed: [], changed: [] })
  assert.deepEqual(diffRenders(withSections([A, B]), withSections(null)).sections, { added: [], removed: ['A', 'B'], changed: [] })
  const retimed = diffRenders(withSections([A, B]), withSections([A, { ...B, frames: 25 }]))
  assert.deepEqual(retimed.sections, { added: [], removed: [], changed: ['B'] })
  assert.equal(retimed.same, false)
  const touched = diffRenders(withSections([A, B]), withSections([A, B], [['n1', 10], ['h2', 20]]))
  assert.deepEqual(touched.sections.changed, ['A'], 'a new animation inside a chapter changes it; the chapter after it is untouched')
  const late = diffRenders(withSections([A, B]), withSections([A, B], [['h1', 10], ['h2', 20], ['n3', 5]]))
  assert.deepEqual(late.sections.changed, [], 'an animation after every chapter touches none')
  const same = diffRenders(withSections([A, B]), withSections([A, B]))
  assert.equal(same.same, true)
  assert.equal(diffRenders({ ...withSections([A]), beats: null }, withSections([A])).sections.changed.length, 0, 'no ranges: only retiming changes a chapter')
})

test('the walk lists videos, GIFs and Manim stills, and skips what is not a render', async () => {
  const ws = scratch()
  const T = Date.now() - 5 * MIN
  ws.put('README', 'no extension', T)
  ws.put('clip.gif', gif({ delays: [10, 10] }), T)
  ws.put('images/proof/Proof_ManimCE_v0.19.0.png', png({ width: 800, height: 450 }), T)
  ws.put('images/loose.png', png({ complete: false }), T)
  ws.put('art/cover.png', png(), T)
  ws.put('.cache-like/x.mp4', mp4({ frames: 1 }), T)
  ws.put('node_modules/pkg/x.mp4', mp4({ frames: 1 }), T)
  ws.put('out/videos/proof/480p15/sections/Proof_0000_Intro.mp4', mp4({ frames: 1 }), T)
  ws.put('1/2/3/4/5/6/7/8/9/deep.mp4', mp4({ frames: 1 }), T)
  ws.put('1/2/3/4/5/6/7/8/9/10/deeper.mp4', mp4({ frames: 1 }), T)
  ws.put('out/videos/half/480p15/Half.mp4', mp4({ frames: 30 }).subarray(0, 100), T)
  ws.put('renders/half.mp4', Buffer.alloc(8), T)
  symlinkSync(join(ws.dir, 'nowhere.mp4'), join(ws.dir, 'broken.mp4'))
  const socket = createServer().listen(join(ws.dir, 'socket.mp4'))
  await new Promise((ok) => socket.on('listening', ok))
  try {
    const lib = ws.scan()
    assert.deepEqual(lib.renders.map((r) => r.path).sort(), ['1/2/3/4/5/6/7/8/9/deep.mp4', 'clip.gif', 'images/loose.png', 'images/proof/Proof_ManimCE_v0.19.0.png', 'out/videos/half/480p15/Half.mp4', 'renders/half.mp4'])
    assert.deepEqual(render(lib, 'clip.gif'), { path: 'clip.gif', kind: 'gif', key: 'clip.gif', title: 'clip', module: null, quality: null, size: gif({ delays: [10, 10] }).length, mtimeMs: T, complete: true, width: 32, height: 24, fps: 10, frames: 2, duration: 0.2, audio: false, sections: null, beats: null, changes: null })
    assert.deepEqual(render(lib, 'images/proof/Proof_ManimCE_v0.19.0.png'), { path: 'images/proof/Proof_ManimCE_v0.19.0.png', kind: 'image', key: 'images/proof/Proof_ManimCE_v0.19.0.png', title: 'Proof', module: 'proof', quality: null, size: png().length, mtimeMs: T, complete: true, width: 800, height: 450, fps: null, frames: null, duration: null, audio: false, sections: null, beats: null, changes: null })
    const loose = render(lib, 'images/loose.png')
    assert.deepEqual([loose.title, loose.module, loose.complete], ['loose', null, false])
    const half = render(lib, 'out/videos/half/480p15/Half.mp4')
    assert.deepEqual([half.complete, half.fps, half.height, half.width, half.beats], [false, 15, 480, null, null], 'a movie mid-write: what its quality folder says, nothing more')
    const plain = render(lib, 'renders/half.mp4')
    assert.deepEqual([plain.complete, plain.fps, plain.height], [false, null, null])
  } finally {
    socket.close()
  }
})

test('the walk stops after 30,000 entries', () => {
  const ws = scratch()
  for (let i = 0; i < 30_001; i++) writeFileSync(join(ws.dir, `c${String(i).padStart(5, '0')}.mp4`), '')
  // the root counts as nothing; every name read counts one, and the 30,001st ends the walk
  assert.equal(ws.scan().renders.length, 30_000)
})

test('a file is probed again only when its size or time changes', () => {
  const ws = scratch()
  const T = Date.now() - 5 * MIN
  const lib = createLibrary(ws.dir)
  ws.put('a.mp4', mp4({ frames: 10 }), T)
  assert.equal(lib.scan().renders[0].frames, 10)
  ws.put('a.mp4', mp4({ frames: 20 }), T) // same size, same time: the answer is the cached one
  assert.equal(lib.scan().renders[0].frames, 10)
  utimesSync(join(ws.dir, 'a.mp4'), (T + 1000) / 1000, (T + 1000) / 1000)
  assert.equal(lib.scan().renders[0].frames, 20)
  ws.put('a.mp4', mp4({ frames: 20, audio: true }), T + 1000) // same time, new size
  assert.equal(lib.scan().renders[0].audio, true)
})

test('Manim folders that cannot be read are skipped, not fatal', () => {
  const ws = scratch()
  const T = Date.now() - 5 * MIN
  ws.put('out/videos/a/480p15/A.mp4', mp4({ frames: 15 }), T)
  ws.put('out/videos/a/480p15/partial_movie_files/not-a-scene.txt', 'x', T)
  symlinkSync(join(ws.dir, 'nowhere'), join(ws.dir, 'out/videos/a/480p15/partial_movie_files/Broken'))
  ws.put('out/videos/a/480p15/partial_movie_files/Locked/uncached_00000.mp4', mp4({ frames: 15 }))
  ws.put('out/videos/b/480p15/partial_movie_files/B/uncached_00000.mp4', mp4({ frames: 15 }))
  const locked = join(ws.dir, 'out/videos/a/480p15/partial_movie_files/Locked')
  const lockedRoot = join(ws.dir, 'out/videos/b/480p15/partial_movie_files')
  chmodSync(locked, 0o000)
  chmodSync(lockedRoot, 0o000)
  try {
    const lib = ws.scan()
    assert.deepEqual(lib.renders.map((r) => r.path), ['out/videos/a/480p15/A.mp4'])
    assert.deepEqual(lib.live, [], 'clips that cannot be listed are no render in progress')
  } finally {
    chmodSync(locked, 0o755)
    chmodSync(lockedRoot, 0o755)
  }
})

test('beats from the wrapper\'s sidecar: clip files, run times, and when the sidecar is not believed', () => {
  const ws = scratch()
  const T = Date.now() - 10 * MIN
  // run times only (no clips folder), animations that are not about a clip ignored
  ws.put('out/videos/s/480p15/One.mp4', mp4({ frames: 45 }), T)
  ws.json('.harness/renders/out/videos/s/480p15/One.mp4.json', { clips: ['a.mp4', 'b.mp4'], animations: [null, { index: 7, label: 'Write', runTime: 1, clip: 'a.mp4', section: 0 }, { label: 'no clip' }, { runTime: 2, clip: 'b.mp4' }] }, T + 50)
  // a clips folder: a whole clip gives its frames, a clip mid-write or missing falls back to its run time
  const q = 'out/videos/s/720p30'
  ws.put(`${q}/Two.mp4`, mp4({ frames: 60, fps: 30 }), T)
  ws.put(`${q}/partial_movie_files/Two/h1.mp4`, mp4({ frames: 20, fps: 30 }), T - 5000)
  ws.put(`${q}/partial_movie_files/Two/h2.mp4`, Buffer.from('not yet a movie, still being written'), T - 5000)
  ws.json(`.harness/renders/${q}/Two.mp4.json`, {
    tool: 'manim', source: 'scenes/s.py', tookMs: 1234, clipsDir: `${q}/partial_movie_files/Two`,
    clips: [{ name: 'h1.mp4', size: 1 }, { name: 'h2.mp4' }, { name: 'h3.mp4' }],
    animations: [{ index: 0, label: 'A', clip: 'h1.mp4', runTime: 9 }, { index: 1, label: 'B', clip: 'h2.mp4', runTime: 1 }, { index: 2, clip: 'h3.mp4', runTime: 1 / 3 }],
    sections: [{ name: 'Intro', animation: 0 }, { name: 'Rest', animation: 1 }, { name: 'Beyond', animation: 9 }],
  }, T + 50)
  // a sidecar that does not add up, is older than the movie, or is not a sidecar
  ws.put('out/videos/s/480p15/Short.mp4', mp4({ frames: 45 }), T)
  ws.json('.harness/renders/out/videos/s/480p15/Short.mp4.json', { clips: ['a.mp4'], animations: [{ clip: 'a.mp4', runTime: 2 }] }, T + 50)
  ws.put('out/videos/s/480p15/NoTime.mp4', mp4({ frames: 45 }), T)
  ws.json('.harness/renders/out/videos/s/480p15/NoTime.mp4.json', { clips: ['a.mp4'] }, T + 50)
  ws.put('out/videos/s/480p15/NullClip.mp4', mp4({ frames: 45 }), T)
  ws.json('.harness/renders/out/videos/s/480p15/NullClip.mp4.json', { clips: [null] }, T + 50)
  ws.put('out/stale.mp4', mp4({ frames: 15 }), T)
  ws.json('.harness/renders/out/stale.mp4.json', { clips: ['a.mp4'], animations: [{ clip: 'a.mp4', runTime: 1 }] }, T - 5000)
  for (const [name, body] of [['bad', 'not json'], ['null', 'null'], ['number', '5'], ['noclips', { clips: 'a.mp4' }]]) {
    ws.put(`out/${name}.mp4`, mp4({ frames: 15 }), T)
    ws.json(`.harness/renders/out/${name}.mp4.json`, body, T + 50)
  }
  // no rate anywhere (not a Manim path, no timing table): run times cannot become frames
  ws.put('renders/plain.mp4', noStts(15), T)
  ws.json('.harness/renders/renders/plain.mp4.json', { clips: [{ name: 'x.mp4' }], animations: [{ clip: 'x.mp4', runTime: 1 }] }, T + 50)
  // no frame count: beats are not checked against it, and chapters past the last beat start at 0
  ws.put('out/videos/s/480p15/Open.mp4', noStts(0), T)
  ws.json('.harness/renders/out/videos/s/480p15/Open.mp4.json', { clips: ['c1.mp4'], animations: [{ clip: 'c1.mp4', runTime: 1, index: 0 }], sections: [{ name: 'A', animation: 0 }, { name: 'B', animation: 5 }] }, T + 50)
  // one chapter is no chapters
  ws.put('out/videos/s/480p15/Single.mp4', mp4({ frames: 15 }), T)
  ws.json('.harness/renders/out/videos/s/480p15/Single.mp4.json', { clips: ['c1.mp4'], animations: [{ clip: 'c1.mp4', runTime: 1 }], sections: [{ name: 'Only', animation: 0 }] }, T + 50)

  const lib = ws.scan()
  const one = render(lib, 'out/videos/s/480p15/One.mp4')
  assert.deepEqual(one.beats, [{ name: 'a.mp4', start: 0, frames: 15, label: 'Write' }, { name: 'b.mp4', start: 15, frames: 30, label: null }])
  assert.deepEqual([one.sections, one.tool, one.source, one.tookMs, one.changes], [null, null, null, null, null])

  const two = render(lib, `${q}/Two.mp4`)
  assert.deepEqual(two.beats, [{ name: 'h1.mp4', start: 0, frames: 20, label: 'A' }, { name: 'h2.mp4', start: 20, frames: 30, label: 'B' }, { name: 'h3.mp4', start: 50, frames: 10, label: null }])
  assert.deepEqual(two.sections, [
    { index: 0, name: 'Intro', type: null, start: 0, frames: 20, video: null },
    { index: 1, name: 'Rest', type: null, start: 20, frames: 40, video: null },
    { index: 2, name: 'Beyond', type: null, start: 60, frames: 0, video: null },
  ])
  assert.deepEqual([two.tool, two.source, two.tookMs], ['manim', 'scenes/s.py', 1234])

  for (const path of ['out/videos/s/480p15/Short.mp4', 'out/videos/s/480p15/NoTime.mp4', 'out/videos/s/480p15/NullClip.mp4', 'out/stale.mp4', 'out/bad.mp4', 'out/null.mp4', 'out/number.mp4', 'out/noclips.mp4', 'renders/plain.mp4']) {
    assert.equal(render(lib, path).beats, null, path)
  }
  assert.equal(render(lib, 'out/stale.mp4').tool, null, 'a sidecar older than its movie describes an earlier render')

  const open = render(lib, 'out/videos/s/480p15/Open.mp4')
  assert.equal(open.frames, null)
  assert.deepEqual(open.beats, [{ name: 'c1.mp4', start: 0, frames: 15, label: null }])
  assert.deepEqual(open.sections.map((s) => [s.name, s.start, s.frames]), [['A', 0, 0], ['B', 0, 0]])
  assert.equal(render(lib, 'out/videos/s/480p15/Single.mp4').sections, null)
})

test('chapters from Manim\'s sections file, and when it is not believed', () => {
  const ws = scratch()
  const T = Date.now() - 10 * MIN
  const q = 'media/videos/sec/480p15'
  ws.put(`${q}/Sec.mp4`, mp4({ frames: 25 }), T)
  ws.json(`${q}/sections/Sec.json`, [{ name: 'Intro', type: 'default.normal', nb_frames: '10', video: 'Sec_0000_Intro.mp4' }, { duration: '1' }, { nb_frames: 'x', duration: 'x' }], T + 50)
  for (const [scene, body, at] of [['Stale', [{ name: 'A', nb_frames: 1 }], T - 5000], ['Object', { name: 'A' }, T], ['Empty', [], T]]) {
    ws.put(`${q}/${scene}.mp4`, mp4({ frames: 15 }), T)
    ws.json(`${q}/sections/${scene}.json`, body, at)
  }
  // a quality folder that says 0 fps, and a movie with no rate of its own: 15 fps is assumed
  ws.put('media/videos/sec/480p0/Zero.mp4', noStts(0), T)
  ws.json('media/videos/sec/480p0/sections/Zero.json', [{ duration: 2 }], T)

  const lib = ws.scan()
  assert.deepEqual(render(lib, `${q}/Sec.mp4`).sections, [
    { index: 0, name: 'Intro', type: 'default.normal', start: 0, frames: 10, video: `${q}/sections/Sec_0000_Intro.mp4` },
    { index: 1, name: 'Section 2', type: null, start: 10, frames: 15, video: null },
    { index: 2, name: 'Section 3', type: null, start: 25, frames: 0, video: null },
  ])
  assert.equal(render(lib, `${q}/Sec.mp4`).key, 'media/videos/sec/Sec')
  for (const scene of ['Stale', 'Object', 'Empty']) assert.equal(render(lib, `${q}/${scene}.mp4`).sections, null, scene)
  assert.deepEqual(render(lib, 'media/videos/sec/480p0/Zero.mp4').sections.map((s) => s.frames), [30])
})

test('beats from Manim\'s clip list, and when it is not believed', () => {
  const ws = scratch()
  const T = Date.now() - 10 * MIN
  const q = 'out/videos/list/480p15'
  const scene = (name, { frames = 45, clips = {}, list = Object.keys(clips).map((c) => `file 'file:/Users/example/elsewhere/${c}'`).join('\n'), listAt = T - 1000 } = {}) => {
    ws.put(`${q}/${name}.mp4`, mp4({ frames }), T)
    for (const [clip, data] of Object.entries(clips)) if (data) ws.put(`${q}/partial_movie_files/${name}/${clip}`, data, T - 2000)
    if (list !== null) ws.put(`${q}/partial_movie_files/${name}/partial_movie_file_list.txt`, `# ffmpeg concat list\n${list}\n`, listAt)
  }
  const good = { 'uncached_00000.mp4': mp4({ frames: 20 }), 'abc.mp4': mp4({ frames: 25 }) }
  scene('Good', { clips: good })
  scene('NoList', { clips: good, list: null })
  scene('ListAfter', { clips: good, listAt: T + 5000 })
  scene('ListLongBefore', { clips: good, listAt: T - 40 * MIN })
  scene('ListEmpty', { clips: good, list: '' })
  scene('ListLocked', { clips: good })
  scene('ClipMissing', { clips: { 'uncached_00000.mp4': mp4({ frames: 20 }), 'abc.mp4': null } })
  scene('ClipWriting', { clips: { 'uncached_00000.mp4': mp4({ frames: 20 }), 'abc.mp4': Buffer.from('half a movie, being written now') } })
  scene('ClipNoFrames', { clips: { 'uncached_00000.mp4': mp4({ frames: 20 }), 'abc.mp4': noTimes(0) } })
  scene('Mismatch', { frames: 60, clips: good })
  const lockedList = join(ws.dir, q, 'partial_movie_files/ListLocked/partial_movie_file_list.txt')
  chmodSync(lockedList, 0o000)
  try {
    const lib = ws.scan()
    assert.deepEqual(render(lib, `${q}/Good.mp4`).beats, [{ name: 'uncached_00000.mp4', start: 0, frames: 20, label: null }, { name: 'abc.mp4', start: 20, frames: 25, label: null }])
    for (const name of ['NoList', 'ListAfter', 'ListLongBefore', 'ListEmpty', 'ListLocked', 'ClipMissing', 'ClipWriting', 'ClipNoFrames', 'Mismatch']) {
      assert.equal(render(lib, `${q}/${name}.mp4`).beats, null, name)
    }
    assert.deepEqual(lib.live, [], 'clips older than their movie are not a render in progress')
  } finally {
    chmodSync(lockedList, 0o644)
  }
})

test('what changed since the render before: from the sidecar\'s record, and from the last scan', () => {
  const ws = scratch()
  const T = Date.now() - 10 * MIN
  const q = 'out/videos/change/480p15'
  // The wrapper's record: animations added at the start and the end, a chapter added, one removed.
  ws.put(`${q}/Changed.mp4`, mp4({ frames: 75 }), T)
  ws.json(`.harness/renders/${q}/Changed.mp4.json`, {
    duration: 4, renderedAtMs: T + 60,
    clips: [{ name: '111_a.mp4', size: 1 }, { name: '222_b.mp4', size: 1 }, { name: '333_c.mp4', size: 1 }, { name: '444_d.mp4', size: 1 }],
    animations: [0, 1, 2, 3].map((i) => ({ index: i, runTime: i === 1 ? 2 : 1, clip: ['111_a.mp4', '222_b.mp4', '333_c.mp4', '444_d.mp4'][i] })),
    sections: [{ name: 'Setup', animation: 0 }, { name: 'Main', animation: 1 }, { name: 'New', animation: 3 }],
    previous: { duration: 3, clips: [{ name: '999_old.mp4', size: 1 }, { name: '222_b.mp4', size: 1 }, { name: '333_c.mp4', size: 1 }], sections: [{ name: 'Setup' }, { name: 'Main' }, { name: 'Gone' }] },
  }, T + 60)
  // The same clips as before, recorded without sizes, sections or durations, on a movie with no duration.
  ws.put(`${q}/Same.mp4`, noTimes(15), T)
  ws.json(`.harness/renders/${q}/Same.mp4.json`, { clips: [{ name: 'uncached_00000.mp4' }], animations: [{ clip: 'uncached_00000.mp4', runTime: 1 }], previous: { clips: [{ name: 'uncached_00000.mp4' }] } }, T + 60)
  // The same clips, a chapter gone.
  ws.put(`${q}/Gone.mp4`, mp4({ frames: 15 }), T)
  ws.json(`.harness/renders/${q}/Gone.mp4.json`, { clips: ['h.mp4'], animations: [{ clip: 'h.mp4', runTime: 1 }], previous: { clips: [{ name: 'h.mp4' }], sections: [{ name: 'Old' }] } }, T + 60)
  // The same clips and the same chapters.
  ws.put(`${q}/Kept.mp4`, mp4({ frames: 30 }), T)
  ws.json(`.harness/renders/${q}/Kept.mp4.json`, { clips: ['h1.mp4', 'h2.mp4'], animations: [{ clip: 'h1.mp4', runTime: 1, index: 0 }, { clip: 'h2.mp4', runTime: 1, index: 1 }], sections: [{ name: 'A', animation: 0 }, { name: 'B', animation: 1 }], previous: { clips: [{ name: 'h1.mp4' }, { name: 'h2.mp4' }], sections: [{ name: 'A' }, { name: 'B' }] } }, T + 60)
  // No wrapper: what changed is what this library saw change.
  ws.put('out/plain.mp4', mp4({ frames: 30 }), T)

  const lib = createLibrary(ws.dir)
  let scan = lib.scan()
  assert.deepEqual(render(scan, `${q}/Changed.mp4`).changes, { at: T + 60, durationDelta: 1, framesDelta: null, ranges: [[0, 15], [60, 75]], sections: { added: ['New'], removed: ['Gone'], changed: ['Setup'] }, same: false })
  assert.deepEqual(render(scan, `${q}/Same.mp4`).changes, { at: T, durationDelta: null, framesDelta: null, ranges: [], sections: null, same: true })
  assert.deepEqual(render(scan, `${q}/Gone.mp4`).changes.sections, { added: [], removed: ['Old'], changed: [] })
  assert.equal(render(scan, `${q}/Gone.mp4`).changes.same, false)
  assert.equal(render(scan, `${q}/Kept.mp4`).changes.same, true)
  assert.equal(render(scan, 'out/plain.mp4').changes, null, 'nothing seen before')

  // Every movie rendered again, a minute later.
  for (const [path, data] of [[`${q}/Same.mp4`, noTimes(15)], [`${q}/Gone.mp4`, mp4({ frames: 15 })], ['out/plain.mp4', mp4({ frames: 45 })]]) ws.put(path, data, T + MIN)
  ws.json(`.harness/renders/${q}/Same.mp4.json`, { clips: [{ name: 'uncached_00000.mp4' }], animations: [{ clip: 'uncached_00000.mp4', runTime: 1 }], previous: { clips: [{ name: 'uncached_00000.mp4' }] } }, T + MIN + 60)
  ws.json(`.harness/renders/${q}/Gone.mp4.json`, { clips: ['h.mp4'], animations: [{ clip: 'h.mp4', runTime: 1 }], previous: { clips: [{ name: 'h.mp4' }], sections: [{ name: 'Old' }] } }, T + MIN + 60)
  scan = lib.scan()
  assert.equal(render(scan, `${q}/Same.mp4`).changes.durationDelta, 0, 'no duration then, none now')
  assert.equal(render(scan, `${q}/Gone.mp4`).changes.durationDelta, 0)
  assert.deepEqual(render(scan, 'out/plain.mp4').changes, { at: T + MIN, durationDelta: 1, framesDelta: 15, ranges: null, sections: null, same: false })
  scan = lib.scan()
  assert.equal(render(scan, 'out/plain.mp4').changes.framesDelta, 15, 'kept until the next render')
})

test('renders in progress, judged from the clips on disk', () => {
  const ws = scratch()
  const now = Date.now()
  const T = now - 10 * MIN
  const q = 'out/videos/live/480p15'
  // an earlier movie (as .mov), two numbered clips since (one still being written), and what is not a new clip
  ws.put(`${q}/Live.mov`, mp4({ frames: 45 }), T)
  ws.put(`${q}/partial_movie_files/Live/uncached_00000.mp4`, mp4({ frames: 15 }), now - 3000)
  ws.put(`${q}/partial_movie_files/Live/uncached_00002.mp4`, Buffer.from('half a clip being written now'), now - 1000)
  ws.put(`${q}/partial_movie_files/Live/old.mp4`, mp4({ frames: 15 }), T - 1000)
  ws.put(`${q}/partial_movie_files/Live/notes.txt`, 'x', now)
  ws.put(`${q}/partial_movie_files/Live/partial_movie_file_list.txt`, "file 'a.mp4'\nfile 'b.mp4'\nfile 'c.mp4'\n", T - 1000)
  symlinkSync(join(ws.dir, 'nowhere.mp4'), join(ws.dir, q, 'partial_movie_files/Live/gone.mp4'))
  // hashed clips in the order they were made, after a GIF movie whose wrapper recorded its animations
  ws.put(`${q}/Gif.gif`, gif(), T)
  ws.json(`.harness/renders/${q}/Gif.gif.json`, { animations: [{}, {}, {}] }, T)
  // made b, then a; b touched last: neither name order nor time order is the order they were made in.
  // (Times only move forward here: on macOS a time set before a file's birth moves its birth time too.)
  ws.put(`${q}/partial_movie_files/Gif/b_made_first.mp4`, mp4({ frames: 15 }))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  ws.put(`${q}/partial_movie_files/Gif/a_made_second.mp4`, mp4({ frames: 15 }), now + 50)
  utimesSync(join(ws.dir, q, 'partial_movie_files/Gif/b_made_first.mp4'), (now + 1000) / 1000, (now + 1000) / 1000)
  // a first render: no movie yet, and sections on (so Manim's clip list says nothing about the whole)
  ws.put(`${q}/partial_movie_files/Fresh/uncached_00000.mp4`, mp4({ frames: 15 }), now - 1000)
  ws.put(`${q}/partial_movie_files/Fresh/partial_movie_file_list.txt`, "file 'a.mp4'\n", now - 1000)
  ws.json(`${q}/sections/Fresh.json`, [{ name: 'A', nb_frames: 15 }], now - 1000)
  // abandoned long ago
  ws.put(`${q}/partial_movie_files/Old/uncached_00000.mp4`, mp4({ frames: 15 }), now - 30 * MIN)
  // clips outside Manim's layout
  ws.put('renders/partial_movie_files/Clip/uncached_00000.mp4', mp4({ frames: 15 }), now - 500)

  const byKey = (lib) => Object.fromEntries(lib.live.map((l) => [l.key, l]))
  let live = byKey(ws.scan())
  assert.deepEqual(Object.keys(live).sort(), ['out/videos/live/Fresh', 'out/videos/live/Gif', 'out/videos/live/Live', 'renders/Clip'])
  const l = live['out/videos/live/Live']
  assert.deepEqual({ ...l, clips: l.clips.map((c) => [c.path.split('/').pop(), c.ready, c.frames]), startedAtMs: undefined, updatedAtMs: undefined }, {
    key: 'out/videos/live/Live', title: 'Live', module: 'live', quality: '480p15', output: `${q}/Live.mov`, source: 'files', state: 'rendering',
    startedAtMs: undefined, updatedAtMs: undefined, animation: 3, expected: 3, current: null, sections: [], animations: [],
    clips: [['uncached_00000.mp4', true, 15], ['uncached_00002.mp4', false, null]], contiguous: false, error: null,
  })
  assert.equal(l.updatedAtMs, now - 1000)
  const g = live['out/videos/live/Gif']
  assert.deepEqual([g.output, g.animation, g.expected, g.contiguous, g.clips.map((c) => c.path.split('/').pop())], [`${q}/Gif.gif`, 2, 3, false, ['b_made_first.mp4', 'a_made_second.mp4']])
  const f = live['out/videos/live/Fresh']
  assert.deepEqual([f.output, f.expected, f.contiguous, f.animation], [`${q}/Fresh.mp4`, null, true, 1])
  const c = live['renders/Clip']
  assert.deepEqual([c.title, c.module, c.quality, c.output, c.expected], ['Clip', null, null, 'renders/Clip.mp4', null])

  live = byKey(ws.scan({ now: () => now + 2 * MIN }))
  assert.equal(live['out/videos/live/Live'].state, 'stalled', 'no new clip for a while')
})

test('a render the wrapper reports in .harness/render.json', () => {
  const now = Date.now()
  const statusOf = (body, { at, files, now: clock } = {}) => {
    const ws = scratch()
    if (files) files(ws)
    ws.json('.harness/render.json', body, at)
    return ws.scan(clock ? { now: clock } : undefined).live
  }
  for (const body of ['not json', 'null', '5', {}]) assert.deepEqual(statusOf(body), [], JSON.stringify(body))

  const [full] = statusOf({
    state: 'rendering', pid: process.pid, scene: 'S', output: 'out/videos/m/480p15/S.mp4', startedAtMs: now - 5000, updatedAtMs: now - 100,
    animation: '2', expected: '5', current: 'Write(Text)', quality: '1080p60', source: 'scenes/m.py',
    sections: [null, { name: 5 }, { name: 'Skipped', skipped: true }, { name: 'Intro', animation: '1' }, { name: 'Body' }],
    animations: [null, 'x', { index: 0, label: 'Create', runTime: 1, clip: 'c.mp4', section: 0 }, { index: 1 }],
    clips: ['out/missing.mp4', 5, 'out/clip.mp4'], error: null,
  }, { files: (ws) => ws.put('out/clip.mp4', mp4({ frames: 15 }), now - 60_000) })
  assert.deepEqual(full, {
    key: 'out/videos/m/S', title: 'S', module: 'm', quality: '1080p60', output: 'out/videos/m/480p15/S.mp4', sourceFile: 'scenes/m.py', source: 'status',
    state: 'rendering', startedAtMs: now - 5000, updatedAtMs: now - 100, finishedAtMs: null, animation: 2, expected: 5, current: 'Write(Text)',
    sections: [{ name: 'Intro', animation: 1 }, { name: 'Body', animation: 0 }],
    animations: [{ index: 0, label: 'Create', runTime: 1, clip: 'c.mp4', section: 0 }, { index: 1, label: null, runTime: null, clip: null, section: null }],
    clips: [{ path: 'out/missing.mp4', ready: false }, { path: 'out/clip.mp4', ready: true, frames: 15, fps: 15, duration: 1, width: 854, height: 480, mtimeMs: now - 60_000 }],
    contiguous: true, error: null,
  })

  const at = now - 30_000
  const [bare] = statusOf({ state: 'rendering', pid: 'not a pid' }, { at })
  assert.deepEqual(bare, { key: 'render', title: 'Render', module: null, quality: null, output: null, sourceFile: null, source: 'status', state: 'stopped', startedAtMs: null, updatedAtMs: at, finishedAtMs: null, animation: 0, expected: null, current: null, sections: [], animations: [], clips: [], contiguous: true, error: null })
  assert.equal(statusOf({ state: 'rendering', pid: -1 })[0].state, 'stopped')
  assert.equal(statusOf({ state: 'rendering', pid: 1 })[0].state, 'rendering', 'a process this user may not signal is still alive')
  assert.equal(statusOf({ state: 'rendering', scene: 'Quiet' }, { at: now - 2 * MIN })[0].state, 'stalled', 'no pid, no update for a while')
  const [quiet] = statusOf({ state: 'rendering', scene: 'Quiet', updatedAtMs: now - 2 * MIN }, { at: now })
  assert.deepEqual([quiet.state, quiet.key, quiet.title], ['stalled', 'Quiet', 'Quiet'])
  assert.equal(statusOf({ state: 'rendering', updatedAtMs: now })[0].state, 'rendering')

  const output = 'out/videos/m/480p15/S.mp4'
  assert.deepEqual(statusOf({ state: 'done', output }), [])
  assert.equal(statusOf({ state: 'failed', output, finishedAtMs: now - 5000, error: { message: 'boom' } })[0].error.message, 'boom')
  assert.deepEqual(statusOf({ state: 'failed', output, finishedAtMs: now - 5000 }, { files: (ws) => ws.put(output, mp4({ frames: 15 }), now - 1000) }), [], 'a newer render of the same scene replaces the failure')
  assert.equal(statusOf({ state: 'failed', output, updatedAtMs: now - 5000 }, { files: (ws) => ws.put(output, mp4({ frames: 15 }), now - 9000) }).length, 1, 'an older render does not')
  assert.deepEqual(statusOf({ state: 'failed', output }, { at: now - 25 * MIN }), [], 'a failure is forgotten after a while')
})

test('the status and the files, about the same render', () => {
  const now = Date.now()
  const q = 'out/videos/m/480p15'
  const both = (status, { clipAt = now - 500, clock } = {}) => {
    const ws = scratch()
    ws.put(`${q}/partial_movie_files/S/uncached_00000.mp4`, mp4({ frames: 15 }), clipAt)
    ws.json('.harness/render.json', { output: `${q}/S.mp4`, ...status })
    return ws.scan(clock ? { now: clock } : undefined).live
  }
  assert.deepEqual(both({ state: 'failed', updatedAtMs: now - 5000 }).map((l) => l.source), ['files'], 'a plain render after the wrapper\'s failed run is newer news')
  assert.deepEqual(both({ state: 'failed', updatedAtMs: now - 800 }).map((l) => l.source), ['status'])
  assert.deepEqual(both({ state: 'rendering', updatedAtMs: now - 5000, pid: process.pid }).map((l) => l.source), ['status'], 'the wrapper is still running: its word stands')
  assert.deepEqual(both({ state: 'done' }).map((l) => l.source), ['files'], 'clips still arriving after a done status: rendering again')
  assert.deepEqual(both({ state: 'done' }, { clock: () => now + 2 * MIN }), [], 'stalled clips after a done status are what the render left behind')
  const ws = scratch()
  ws.json('.harness/render.json', { state: 'failed', output: 'renders/x.mp4', updatedAtMs: now })
  ws.put('out/videos/m/480p15/partial_movie_files/Other/uncached_00000.mp4', mp4({ frames: 15 }), now - 1000)
  assert.deepEqual(ws.scan().live.map((l) => [l.source, l.key]), [['status', 'renders/x.mp4'], ['files', 'out/videos/m/Other']], 'two renders, newest first')
})

test('the verdict and the scene count', () => {
  const ws = scratch()
  assert.deepEqual([ws.scan().verdict, ws.scan().scenes], [null, 0])
  ws.json('.harness/verdict.json', { ready: 1, summary: '2 renders', artifact: 'out/a.mp4', updatedAt: '2026-09-17T00:00:00Z' })
  ws.put('scenes/a.py', 'x')
  ws.put('scenes/b.py', 'x')
  ws.put('scenes/notes.md', 'x')
  assert.deepEqual([ws.scan().verdict, ws.scan().scenes], [{ ready: true, summary: '2 renders', artifact: 'out/a.mp4', updatedAt: '2026-09-17T00:00:00Z' }, 2])
  ws.json('.harness/verdict.json', {})
  assert.deepEqual(ws.scan().verdict, { ready: false, summary: '', artifact: null, updatedAt: null })
  ws.json('.harness/verdict.json', '5')
  assert.equal(ws.scan().verdict, null)
})

test('a sidecar or sections file that is not the shape written costs that render its extras, never the library', () => {
  const ws = scratch()
  const T = Date.now() - 10 * MIN
  const q = 'out/videos/bad/480p15'
  const cases = {
    Animations: { clips: ['a.mp4'], animations: { a: 1 } },
    ClipName: { clipsDir: `${q}/partial_movie_files/ClipName`, clips: [{ name: 5 }] },
    Previous: { clips: ['a.mp4'], animations: [{ clip: 'a.mp4', runTime: 1 }], previous: { clips: [null] } },
    SectionEntry: { clips: ['a.mp4'], animations: [{ clip: 'a.mp4', runTime: 1 }], sections: [null, null] },
  }
  for (const [scene, sidecar] of Object.entries(cases)) {
    ws.put(`${q}/${scene}.mp4`, mp4({ frames: 15 }), T)
    ws.json(`.harness/renders/${q}/${scene}.mp4.json`, sidecar, T + 50)
  }
  ws.put(`${q}/Sections.mp4`, mp4({ frames: 15 }), T)
  ws.json(`${q}/sections/Sections.json`, [null], T + 50)
  ws.put('out/good.mp4', mp4({ frames: 30 }), T)

  const lib = ws.scan()
  assert.equal(lib.renders.length, 6)
  for (const scene of [...Object.keys(cases), 'Sections']) {
    const r = render(lib, `${q}/${scene}.mp4`)
    assert.deepEqual([r.complete, r.frames, r.title, r.beats, r.sections, r.changes], [true, 15, scene, null, null, null], scene)
  }
  assert.equal(render(lib, 'out/good.mp4').frames, 30)
})
