import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, relative, sep } from 'node:path'

export const MAX_UPLOAD = 50 * 1024 * 1024
const MAX_JSON = 2 * 1024 * 1024
const invalid = (message) => {
  throw Object.assign(new Error(message), { status: 400 })
}
const text = (value, max, label) =>
  typeof value === 'string' && value.length <= max ? value : invalid(`Invalid ${label}`)
const finite = (value, lo, hi, label) =>
  typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi
    ? value
    : invalid(`Invalid ${label}`)

export function readWave(bytes) {
  if (
    bytes.length < 56 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 3 ||
    bytes.readUInt16LE(22) !== 2 ||
    bytes.readUInt16LE(32) !== 8 ||
    bytes.readUInt16LE(34) !== 32 ||
    bytes.toString('ascii', 36, 40) !== 'fact' ||
    bytes.readUInt32LE(40) !== 4 ||
    bytes.toString('ascii', 48, 52) !== 'data' ||
    bytes.readUInt32LE(52) !== bytes.length - 56
  )
    invalid('Expected a stereo 32-bit float WAV recorded by this pane')
  const sampleRate = bytes.readUInt32LE(24),
    frames = bytes.readUInt32LE(44)
  if (
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    frames < 128 ||
    frames > Math.min(6_000_000, sampleRate * 120) ||
    bytes.readUInt32LE(28) !== sampleRate * 8 ||
    frames * 8 !== bytes.length - 56
  )
    invalid('Invalid recording length or sample rate')
  let peak = 0,
    squares = 0
  for (let i = 56; i < bytes.length; i += 4) {
    const value = bytes.readFloatLE(i)
    if (!Number.isFinite(value)) invalid('The recording contains non-finite samples')
    peak = Math.max(peak, Math.abs(value))
    squares += value * value
  }
  return {
    file: 'performance.wav',
    format: 'float32',
    channels: 2,
    sampleRate,
    frames,
    duration: frames / sampleRate,
    peak,
    rms: Math.sqrt(squares / (frames * 2)),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

export function unpackTake(body) {
  if (body.length < 4 || body.length > MAX_UPLOAD) invalid('Recording is too large or incomplete')
  const size = body.readUInt32LE(0)
  if (size > MAX_JSON || size + 60 > body.length) invalid('Invalid take metadata length')
  let input
  try {
    input = JSON.parse(body.toString('utf8', 4, 4 + size))
  } catch {
    invalid('Invalid take metadata')
  }
  if (!input || input.schema !== 'strudel-take/1') invalid('Unknown take format')
  if (
    input.captureId != null &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.captureId)
  )
    invalid('Invalid capture identity')
  const wav = body.subarray(4 + size),
    audio = readWave(wav)
  const title = text(input.title, 100, 'take name').trim()
  if (!title) invalid('Name this take before keeping it')
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 128)
    invalid('Expected 1–128 source versions')
  let sourceBytes = 0
  const sources = input.sources.map((source, index) => {
    if (!source || typeof source !== 'object') invalid('Invalid source version')
    const code = text(source.code, 65536, 'source code')
    const bytes = Buffer.byteLength(code)
    if (bytes > 65536) invalid('Each source version must fit in 64 KB')
    sourceBytes += bytes
    if (sourceBytes > 512 * 1024) invalid('Source versions exceed 512 KB')
    return {
      index,
      file: `source/version-${String(index + 1).padStart(3, '0')}.strudel`,
      code,
      sha256: createHash('sha256').update(code).digest('hex')
    }
  })
  if (!Array.isArray(input.events) || !input.events.length || input.events.length > 4000)
    invalid('Invalid performance journal')
  let previous = 0
  const names = (list) => {
    if (!Array.isArray(list) || list.length > 128) invalid('Invalid mix')
    return list.map((name) => text(name, 200, 'voice name'))
  }
  const events = input.events.map((event) => {
    if (!event || !['source', 'mix', 'marker', 'transport'].includes(event.type))
      invalid('Invalid journal event')
    const at = finite(event.at, previous, audio.duration, 'event time')
    previous = at
    const result = {
      type: event.type,
      at,
      cycle: finite(event.cycle, 0, 1e9, 'cycle'),
      cps: finite(event.cps, 0, 1e6, 'tempo')
    }
    if (event.type === 'source') {
      result.source = finite(event.source, 0, sources.length - 1, 'source index')
      if (!Number.isInteger(result.source)) invalid('Invalid source index')
    }
    if (event.type === 'source' || event.type === 'mix') {
      result.muted = names(event.muted)
      result.soloed = names(event.soloed)
    }
    if (event.type === 'marker') result.note = text(event.note, 240, 'marker')
    if (event.type === 'transport') result.playing = !!event.playing
    return result
  })
  if (events[0].type !== 'source' || events[0].at !== 0 || events[0].source !== 0)
    invalid('The initial source is missing')
  const take = {
    schema: input.schema,
    captureId: input.captureId,
    title,
    track: text(input.track, 500, 'track name'),
    recordedAt: text(input.recordedAt, 40, 'recording date'),
    reason: text(input.reason, 100, 'stop reason'),
    audio,
    sources,
    events,
    timing:
      'Events record control requests on the AudioContext clock. Scheduler lookahead and existing effect tails can delay audible changes. The WAV is the captured performance; the journal is not a deterministic replay.',
    engine: '@strudel/repl 1.3.0 (unmodified)'
  }
  if (!Number.isFinite(Date.parse(take.recordedAt))) invalid('Invalid recording date')
  return { take, wav }
}

// Small store-only ZIP: no executable archiver, paths or files supplied by the request.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function archive(entries) {
  const parts = [],
    central = []
  let offset = 0
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content),
      filename = Buffer.from(name)
    let crc = 0xffffffff
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const h = Buffer.alloc(30),
      c = Buffer.alloc(46)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(0x800, 6)
    h.writeUInt16LE(33, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(data.length, 18)
    h.writeUInt32LE(data.length, 22)
    h.writeUInt16LE(filename.length, 26)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x800, 8)
    c.writeUInt16LE(33, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(filename.length, 28)
    c.writeUInt32LE(offset, 42)
    parts.push(h, filename, data)
    central.push(c, filename)
    offset += h.length + filename.length + data.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

function shelf(workspace, create = false) {
  let path = realpathSync(workspace)
  for (const name of ['out', 'takes']) {
    path = join(path, name)
    if (!existsSync(path) && create) mkdirSync(path)
    if (!existsSync(path)) return null
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('out/takes must be a real workspace directory')
  }
  return path
}
export function listTakes(workspace) {
  let root
  try {
    root = shelf(workspace)
  } catch {
    return []
  }
  if (!root) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name))
    .slice(-1000)
    .flatMap((entry) => {
      try {
        const path = join(root, entry.name, 'take.json')
        if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > MAX_JSON) return []
        const take = JSON.parse(readFileSync(path, 'utf8'))
        if (
          take.schema !== 'strudel-take/1' ||
          typeof take.title !== 'string' ||
          typeof take.recordedAt !== 'string' ||
          !Number.isFinite(Date.parse(take.recordedAt)) ||
          !Number.isFinite(take.audio?.duration)
        )
          return []
        return [
          {
            id: entry.name,
            title: take.title,
            recordedAt: take.recordedAt,
            audio: take.audio,
            markers: take.events.filter((e) => e.type === 'marker').length,
            versions: take.sources.length
          }
        ]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, 100)
}
export function keepTake(workspace, body) {
  const { take, wav } = unpackTake(body),
    root = shelf(workspace, true),
    id = take.captureId || randomUUID()
  take.id = id
  take.uploadSha256 = createHash('sha256').update(body).digest('hex')
  const scratch = join(root, '.saving-' + id),
    destination = join(root, id)
  if (existsSync(destination)) {
    const path = join(destination, 'take.json')
    if (
      !lstatSync(destination).isSymbolicLink() &&
      !lstatSync(path).isSymbolicLink() &&
      lstatSync(path).size <= MAX_JSON
    ) {
      const previous = JSON.parse(readFileSync(path, 'utf8'))
      if (previous.uploadSha256 === take.uploadSha256)
        return { id, path: relative(workspace, destination).split(sep).join('/'), take: previous }
    }
    throw Object.assign(
      new Error('This capture was already kept with different details. Open it in Takes.'),
      { status: 409 }
    )
  }
  mkdirSync(scratch)
  const readme = `# ${take.title}\n\nRecorded from Strudel's actual stereo output.\n\n- performance.wav: ${take.audio.sampleRate} Hz, stereo, 32-bit float; no normalization.\n- take.json: measured audio, code versions, live mix changes and markers.\n- source/: editable patterns that successfully ran during this take.\n\n${take.timing}\n\nOpen any source version in Strudel to continue composing. Apply the corresponding muted/soloed voices from the journal if wanted. These files do not automatically replay the recorded gestures. Random patterns can differ on another run. External samples, custom imports and other dependencies are not bundled; the WAV is self-contained.\n\nPattern source is editable code. Review it before running.\n`
  const entries = [
    ['performance.wav', wav],
    ['take.json', JSON.stringify(take, null, 2) + '\n'],
    ['README.md', readme],
    ...take.sources.map((s) => [s.file, s.code])
  ]
  try {
    mkdirSync(join(scratch, 'source'))
    for (const [name, content] of entries) writeFileSync(join(scratch, name), content)
    writeFileSync(join(scratch, 'take.zip'), archive(entries))
    renameSync(scratch, destination)
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  return { id, path: relative(workspace, destination).split(sep).join('/'), take }
}
