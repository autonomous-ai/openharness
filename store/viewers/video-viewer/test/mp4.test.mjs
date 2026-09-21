// The header readers on files that are not the happy path: movies mid-write, odd box layouts, GIFs and
// PNGs whole and cut short, and things that are not media at all.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { chmodSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { niceFps, probe, probeGif, probePng } from '../lib/mp4.mjs'
import { box, gif, mp4, png, u16, u32, videoTrak, workspace } from './media.mjs'

const ws = workspace('video-viewer-mp4-')
after(() => ws.done())
const file = (name, data) => ws.put(name, data)
const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512))
const mvhd = (ts = 1000, dur = 3000) => box('mvhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), Buffer.alloc(80))
const movie = (...children) => probe(file(`m${Math.random().toString(36).slice(2)}.mp4`, Buffer.concat([ftyp, box('moov', ...children)])))

test('niceFps rounds a measured rate to the rate it was meant to be', () => {
  assert.equal(niceFps(29.9701), 29.97)
  assert.equal(niceFps(14.99), 15)
  assert.equal(niceFps(17.12345), 17.123, 'an unusual rate is kept, to the millisecond')
  assert.equal(niceFps(0), null)
  assert.equal(niceFps(undefined), null)
  assert.equal(niceFps(Infinity), null)
})

test('a file that is not a movie, or not a whole one yet, is not complete', () => {
  assert.deepEqual(probe(join(ws.dir, 'missing.mp4')), { complete: false })
  assert.deepEqual(probe(file('tiny.mp4', Buffer.from('ftyp'))), { complete: false }, 'under 16 bytes')
  assert.deepEqual(probe(file('text.mp4', Buffer.from('this is a text file, not a movie'))), { complete: false, unknown: true })
  assert.deepEqual(probe(file('zero-box.mp4', Buffer.concat([u32(3), Buffer.from('ftyp'), Buffer.alloc(16)]))), { complete: false, unknown: true }, 'a first box smaller than its header')
  assert.deepEqual(probe(file('no-moov.mp4', Buffer.concat([ftyp, box('mdat', Buffer.alloc(64))]))), { complete: false })
  const whole = mp4({ frames: 10, moovFirst: true })
  assert.deepEqual(probe(file('moov-first-cut.mp4', whole.subarray(0, whole.length - 10))), { complete: false }, 'moov whole, mdat still being written')
  // A 64-bit box header in the last bytes of the file: the rest of the header has not been written.
  assert.deepEqual(probe(file('big-header-cut.mp4', Buffer.concat([ftyp, box('moov', mvhd()), u32(1), Buffer.from('mdat'), Buffer.alloc(4)]))), { complete: false })
  const locked = file('locked.mp4', mp4({ frames: 5 }))
  chmodSync(locked, 0o000)
  assert.deepEqual(probe(locked), { complete: false }, 'unreadable')
  chmodSync(locked, 0o644)
})

test('a moov larger than 64 MiB is not read into memory', () => {
  const path = file('huge-moov.mp4', Buffer.concat([u32(65 * 1024 * 1024), Buffer.from('moov')]))
  truncateSync(path, 65 * 1024 * 1024) // sparse: the box is whole, the disk barely used
  assert.deepEqual(probe(path), { complete: false })
})

test('box sizes: 64-bit, to the end of the file, and nested the same ways', () => {
  const trak = videoTrak({ frames: 30, fps: 30, ts: 3000 })
  // moov with a 64-bit size, holding its trak as a size-0 ("to the end") child
  const moov64 = Buffer.concat([u32(1), Buffer.from('moov'), Buffer.alloc(8), mvhd(3000, 3000), u32(0), trak.subarray(4)])
  moov64.writeBigUInt64BE(BigInt(moov64.length), 8)
  const a = probe(file('moov64.mp4', Buffer.concat([ftyp, moov64])))
  assert.equal(a.complete, true)
  assert.equal(a.frames, 30)
  assert.equal(a.fps, 30)
  // an mdat whose size is 0 runs to the end of the file; a 64-bit child box inside moov
  const child64 = Buffer.concat([u32(1), Buffer.from('trak'), Buffer.alloc(8), trak.subarray(8)])
  child64.writeBigUInt64BE(BigInt(child64.length), 8)
  const b = probe(file('mdat0.mp4', Buffer.concat([ftyp, box('moov', mvhd(3000, 3000), child64), u32(0), Buffer.from('mdat'), Buffer.alloc(100)])))
  assert.equal(b.complete, true)
  assert.equal(b.frames, 30)
  // a child whose size overruns its parent, or is smaller than a header, ends the walk of that parent
  assert.equal(movie(mvhd(), Buffer.concat([u32(4000), Buffer.from('trak')])).audio, false)
  assert.equal(movie(mvhd(), Buffer.concat([u32(4), Buffer.from('trak')])).audio, false)
})

test('what a track says, and what it leaves out', () => {
  // version 1 (64-bit) media header; two stts runs, the longer one gives the rate
  const v1 = movie(mvhd(), videoTrak({ frames: 20, fps: 25, ts: 25_000, mdhdVersion: 1 }))
  assert.equal(v1.duration, 20 / 25)
  assert.equal(v1.fps, 25)
  const runs = box('trak', box('mdia',
    box('mdhd', u32(0), u32(0), u32(0), u32(600), u32(600 * 2), u16(0), u16(0)),
    box('hdlr', u32(0), u32(0), Buffer.from('vide'), Buffer.alloc(12)),
    box('minf', box('stbl', box('stts', u32(0), u32(3), u32(40), u32(10), u32(20), u32(20), u32(5), u32(99))))))
  const r = movie(mvhd(), runs)
  assert.equal(r.frames, 65)
  assert.equal(r.fps, 60, 'the longest run: 600 / 10')
  assert.equal(r.width, null, 'no tkhd')
  assert.equal(r.codec, null, 'no stsd')
  // an stts that claims more entries than it holds, a short stsd, no mvhd
  const short = box('trak',
    box('tkhd', Buffer.alloc(76), u32(320 * 65536), u32(240 * 65536)),
    box('mdia',
      box('mdhd', u32(0), u32(0), u32(0), u32(1000), u32(500), u16(0), u16(0)),
      box('hdlr', u32(0), u32(0), Buffer.from('vide'), Buffer.alloc(12)),
      box('minf', box('stbl', box('stsd', u32(0), u32(0)), box('stts', u32(0), u32(9), u32(12), u32(40))))))
  const s = probe(file('short.mp4', Buffer.concat([ftyp, box('moov', short)])))
  assert.deepEqual(s, { complete: true, duration: 0.5, width: 320, height: 240, fps: 25, frames: 12, audio: false, codec: null })
  // an empty stts and no media header: no rate, no duration of its own, the movie's instead
  const bare = box('trak', box('mdia', box('hdlr', u32(0), u32(0), Buffer.from('vide'), Buffer.alloc(12)), box('minf', box('stbl', box('stts', u32(0), u32(0))))))
  assert.deepEqual(movie(mvhd(1000, 4000), bare), { complete: true, duration: 4, width: null, height: null, fps: null, frames: 0, audio: false, codec: null })
  assert.equal(probe(file('bare-no-mvhd.mp4', Buffer.concat([ftyp, box('moov', bare)]))).duration, null)
  // no sample table timing at all: no frame count and no rate, but still a whole movie
  assert.deepEqual(movie(mvhd(), videoTrak({ frames: 10, stts: false })), { complete: true, duration: 10 / 15, width: 854, height: 480, fps: null, frames: null, audio: false, codec: 'avc1' })
  // no video track: the movie's duration and whether there is sound; a trak with no handler at all
  assert.deepEqual(movie(mvhd(1000, 2500), videoTrak({ frames: 10, handler: 'soun' })), { complete: true, duration: 2.5, audio: true })
  assert.deepEqual(movie(box('trak', box('mdia'))), { complete: true, duration: null, audio: false })
  // a media header cut short throws inside the reader: not complete, and the file is closed
  const cut = box('trak', box('mdia', box('mdhd', u32(0))))
  assert.deepEqual(movie(mvhd(), cut), { complete: false })
})

test('GIF: size, frames and duration from the blocks; unfinished or foreign data is not complete', () => {
  assert.deepEqual(probeGif(file('a.gif', gif({ delays: [10, 20, 0] }))), { complete: true, width: 32, height: 24, frames: 3, duration: 0.4, fps: 7.5 })
  assert.deepEqual(probeGif(file('local.gif', gif({ delays: [4], globalTable: false, localTable: true }))), { complete: true, width: 32, height: 24, frames: 1, duration: 0.04, fps: 25 })
  assert.deepEqual(probeGif(file('empty.gif', gif({ delays: [] }))), { complete: true, width: 32, height: 24, frames: 0, duration: 0, fps: null })
  assert.equal(probeGif(file('writing.gif', gif({ trailer: false }))).complete, false, 'no trailer yet')
  assert.equal(probeGif(file('junk.gif', Buffer.concat([gif({ trailer: false }), Buffer.from([0x99])]))).complete, false, 'an unknown block')
  assert.deepEqual(probeGif(file('png.gif', png())), { complete: false })
  assert.deepEqual(probeGif(file('stub.gif', Buffer.from('GIF'))), { complete: false }, 'a header cut short')
  assert.deepEqual(probeGif(join(ws.dir, 'missing.gif')), { complete: false })
})

test('PNG: size from IHDR, complete once IEND is written', () => {
  assert.deepEqual(probePng(file('a.png', png({ width: 1920, height: 1080 }))), { complete: true, width: 1920, height: 1080 })
  assert.deepEqual(probePng(file('writing.png', png({ complete: false }))), { complete: false, width: 640, height: 360 })
  assert.deepEqual(probePng(file('short.png', png().subarray(0, 20))), { complete: false })
  assert.deepEqual(probePng(file('gif.png', gif())), { complete: false })
  assert.deepEqual(probePng(join(ws.dir, 'missing.png')), { complete: false })
})

test('a file written as it is probed is read as far as it goes', () => {
  // readAt stops at the end of the file rather than returning zeros past it
  writeFileSync(join(ws.dir, 'grow.mp4'), Buffer.concat([ftyp, u32(1), Buffer.from('moov'), Buffer.alloc(2)]))
  assert.deepEqual(probe(join(ws.dir, 'grow.mp4')), { complete: false })
})
