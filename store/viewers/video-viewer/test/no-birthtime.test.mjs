// Clips in progress are ordered by when they were made; a filesystem that keeps no birth time (some
// Linux mounts report 0) orders them by their modification time instead. This file stands in for such
// a filesystem by patching statSync before the library is loaded, so it runs in a process of its own.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { after, test } from 'node:test'
import { mp4, workspace } from './media.mjs'

const statSync = fs.statSync
fs.statSync = (...args) => { const st = statSync(...args); st.birthtimeMs = 0; return st }
syncBuiltinESMExports()
const { createLibrary } = await import('../lib/library.mjs')

const ws = workspace('video-viewer-no-birth-')
after(() => ws.done())

test('without birth times, clips in progress are in modification order', () => {
  const now = Date.now()
  const q = 'out/videos/b/480p15/partial_movie_files/B'
  // times only move forward: on macOS a time set before a file's birth moves its birth time too
  ws.put(`${q}/made-first-touched-last.mp4`, mp4({ frames: 15 }), now + 1000)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  ws.put(`${q}/made-last-touched-first.mp4`, mp4({ frames: 15 }), now + 50)
  const [live] = createLibrary(ws.dir).scan().live
  assert.deepEqual(live.clips.map((c) => c.path.split('/').pop()), ['made-last-touched-first.mp4', 'made-first-touched-last.mp4'])
  assert.equal(live.startedAtMs, now + 50)
  assert.equal(live.updatedAtMs, now + 1000)
})
