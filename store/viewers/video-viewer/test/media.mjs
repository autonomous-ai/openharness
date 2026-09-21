// Synthetic media and scratch workspaces for the tests: MP4s with a real moov box, GIFs and PNGs with
// real headers, and a viewer process started the way Harness starts it. No Manim, no ffmpeg.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')

export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
export const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
export const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]) }

/** A video trak: tkhd (size), mdia with mdhd, hdlr and an stbl whose stts gives the frames. */
export function videoTrak({ frames, fps = 15, width = 854, height = 480, ts = 15360, handler = 'vide', tkhd = true, stsd = true, stts = true, mdhdVersion = 0 } = {}) {
  const delta = ts / fps, dur = frames * delta
  const mdhd = mdhdVersion === 1
    ? box('mdhd', Buffer.from([1, 0, 0, 0]), Buffer.alloc(16), u32(ts), u32(0), u32(dur), u16(0), u16(0))
    : box('mdhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), u16(0), u16(0))
  return box('trak',
    ...(tkhd ? [box('tkhd', u32(0), u32(0), u32(0), u32(1), u32(0), u32(dur), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), Buffer.alloc(36), u32(width * 65536), u32(height * 65536))] : []),
    box('mdia', mdhd,
      box('hdlr', u32(0), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from([0])),
      box('minf', box('stbl',
        ...(stsd ? [box('stsd', u32(0), u32(1), u32(16), Buffer.from('avc1', 'latin1'), Buffer.alloc(8))] : []),
        ...(stts ? [box('stts', u32(0), u32(1), u32(frames), u32(delta))] : [])))))
}

/** A minimal MP4: ftyp, mdat, moov with one video track (and optionally a sound track). */
export function mp4({ frames, fps = 15, width = 854, height = 480, audio = false, moovFirst = false }) {
  const ts = 15360, dur = frames * (ts / fps)
  const moov = box('moov', box('mvhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), Buffer.alloc(80)), videoTrak({ frames, fps, width, height, ts }), ...(audio ? [videoTrak({ frames, fps, ts, handler: 'soun' })] : []))
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512))
  const mdat = box('mdat', Buffer.alloc(64))
  return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov])
}

/** A GIF of `delays` frames (hundredths of a second each; 0 means "unset"), 1×1, with or without a trailer. */
export function gif({ delays = [10, 10], globalTable = true, localTable = false, trailer = true, width = 32, height = 24 } = {}) {
  const parts = [Buffer.from('GIF89a', 'latin1'), Buffer.from([width & 255, width >> 8, height & 255, height >> 8, globalTable ? 0x80 : 0, 0, 0])]
  if (globalTable) parts.push(Buffer.alloc(6)) // 2 colours
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00])) // an extension that is not a delay
  for (const delay of delays) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, delay & 255, delay >> 8, 0x00, 0x00]))
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, localTable ? 0x80 : 0]))
    if (localTable) parts.push(Buffer.alloc(6))
    parts.push(Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]))
  }
  if (trailer) parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

/** A PNG with an IHDR and, when `complete`, an IEND chunk at the end. */
export function png({ width = 640, height = 360, complete = true } = {}) {
  const chunk = (type, data) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])), chunk('IDAT', Buffer.alloc(4)), ...(complete ? [chunk('IEND', Buffer.alloc(0))] : [])])
}

export function workspace(prefix = 'video-viewer-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const put = (rel, data, mtimeMs) => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    if (mtimeMs) utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000)
    return abs
  }
  return { dir, put, done: () => rmSync(dir, { recursive: true, force: true }) }
}

export const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) }) })

export async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * The viewer as Harness runs it: viewer.sh with a port and a workspace, the test preload imported
 * (it shortens the timers named in TEST_TIMERS). stop() sends SIGTERM and waits for a clean exit, which
 * is also when V8 writes the process's coverage.
 */
export async function startViewer(ws, env = {}) {
  const port = await freePort()
  const preload = pathToFileURL(join(PACKAGE, 'test', 'preload.mjs')).href
  const child = spawn(join(PACKAGE, 'viewer.sh'), {
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: ws, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })))
  await Promise.race([
    until(() => output.includes('listening'), 'the viewer to listen', 15_000),
    exited.then((e) => { throw new Error(`viewer exited ${JSON.stringify(e)}: ${output}`) }),
  ])
  const get = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.end(body)
  })
  /** An event stream: `text` grows as events arrive; wait(predicate) resolves with the text once it matches. */
  const events = (path = '/events') => new Promise((ok, fail) => {
    const stream = { text: '', ended: false }
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c) => { stream.text += c })
      res.on('end', () => { stream.ended = true })
      res.on('error', () => { stream.ended = true })
      stream.status = res.statusCode
      stream.headers = res.headers
      ok(stream)
    })
    req.on('error', fail)
    req.end()
    stream.close = () => req.destroy()
    stream.wait = (predicate, what, ms) => until(() => predicate(stream.text), what, ms)
    /** Every `library` event's data, parsed. */
    stream.libraries = () => stream.text.split('\n\n').filter((b) => b.includes('event: library')).map((b) => JSON.parse(b.split('\ndata: ')[1]))
  })
  const stop = async (signal = 'SIGTERM') => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); return exited }
  return { port, child, get, events, stop, exited, output: () => output }
}
