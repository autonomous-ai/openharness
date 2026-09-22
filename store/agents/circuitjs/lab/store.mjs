import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { CAPTURE_LIMITS, sampleStatistics } from './capture.mjs'
import { captureSVG, quantity } from './plots.mjs'
import { writeProjectZip } from './zip.mjs'

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export const captureHash = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest('hex')
const bad = (message) => {
  throw Object.assign(new Error(message), { status: 400 })
}
const text = (v, max, name) => {
  if (typeof v !== 'string' || v.length > max)
    bad(`${name} must contain at most ${max} characters`)
  return v
}
const number = (v, lo, hi, name) => {
  if (!Number.isFinite(v) || v < lo || v > hi)
    bad(`${name} is outside the supported range`)
  return v
}
const csv = (v) => {
  let s = String(v ?? '')
  if (/^[=+@\-\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`
  return `"${s.replaceAll('"', '""')}"`
}

export function validateCapture(input, runtime) {
  if (!input || input.spec !== 'circuit-capture/1' || !UUID.test(input.id))
    bad('Provide a native circuit capture identifier')
  const sourceCircuit = text(
      input.sourceCircuit,
      CAPTURE_LIMITS.circuit,
      'Circuit export'
    ),
    runCircuit = text(
      input.runCircuit,
      CAPTURE_LIMITS.circuit,
      'Capture circuit'
    )
  for (const circuit of [sourceCircuit, runCircuit])
    if (
      !/^\s*(<cir\b|\$\s)/.test(circuit) ||
      Buffer.byteLength(circuit) > CAPTURE_LIMITS.circuit
    )
      bad(
        'Provide a complete native CircuitJS circuit export of at most 512 KB'
      )
  if (
    !Array.isArray(input.probes) ||
    !input.probes.length ||
    input.probes.length > CAPTURE_LIMITS.probes
  )
    bad('Choose 1–8 probes')
  const ids = new Set()
  const probes = input.probes.map((p) => {
    if (!p || !['node', 'post', 'voltage', 'current'].includes(p.kind))
      bad('Invalid probe kind')
    const id = text(p.id, 180, 'Probe identifier')
    if (!id || ids.has(id)) bad('Probe identifiers must be unique')
    ids.add(id)
    const unit = p.kind === 'current' ? 'A' : 'V'
    if (p.unit !== unit) bad('Probe units must match the measurement')
    const probe = {
      id,
      kind: p.kind,
      label: text(p.label, 180, 'Probe label'),
      unit,
      type: text(p.type, 100, 'Native element type'),
      index: number(p.index, 0, 999, 'Element index')
    }
    if (!Number.isInteger(probe.index)) bad('Element indices must be integers')
    if (p.kind === 'node') probe.node = text(p.node, 120, 'Node name')
    return probe
  })
  if (
    !Array.isArray(input.samples) ||
    input.samples.length < 2 ||
    input.samples.length > CAPTURE_LIMITS.samples
  )
    bad('Keep 2–5,001 native samples')
  let previous = -1
  const samples = input.samples.map((row) => {
    if (!Array.isArray(row) || row.length !== probes.length + 1)
      bad('Each sample must contain time and every probe value')
    const time = number(row[0], 0, 1e6, 'Simulation time')
    if (time <= previous) bad('Sample times must increase strictly')
    previous = time
    return [
      time,
      ...row.slice(1).map((v) => number(v, -1e12, 1e12, 'Probe value'))
    ]
  })
  if (!['complete', 'partial'].includes(input.status))
    bad('Stop the native capture before keeping it')
  const config = {
    duration: number(input.config?.duration, 0.001, 5, 'Requested duration'),
    requestedPacing: number(
      input.config?.requestedPacing,
      1,
      2000,
      'Capture pacing'
    ),
    maxTimeStep: number(
      input.config?.maxTimeStep,
      1e-15,
      1e6,
      'Maximum timestep'
    )
  }
  if (
    !Number.isInteger(input.solverSteps) ||
    input.solverSteps < samples.length ||
    input.minStep > input.maxStep
  )
    bad('Invalid native solver-step record')
  if (input.status === 'complete' && samples.at(-1)[0] < config.duration)
    bad('A complete capture must reach the requested window')
  if (!Number.isFinite(Date.parse(input.createdAt)))
    bad('Provide the capture creation date')
  const capturedRuntime = input.runtime
  if (
    !capturedRuntime ||
    capturedRuntime.engine !== 'CircuitJS1' ||
    !Array.isArray(capturedRuntime.compiledFiles) ||
    capturedRuntime.compiledFiles.length > 12
  )
    bad('Provide the captured simulator version')
  const recordedRuntime = {
    engine: 'CircuitJS1',
    sourceCommit:
      capturedRuntime.sourceCommit == null
        ? null
        : text(capturedRuntime.sourceCommit, 40, 'Source commit'),
    compiledFiles: capturedRuntime.compiledFiles.map((f) => {
      if (!f || !/^[a-f0-9]{64}$/.test(f.sha256))
        bad('Invalid simulator fingerprint')
      return { name: text(f.name, 100, 'Runtime file'), sha256: f.sha256 }
    })
  }
  const out = {
    spec: input.spec,
    id: input.id,
    title: text(input.title, 120, 'Title').trim() || 'Circuit capture',
    note: text(input.note || '', 2000, 'Note'),
    createdAt: text(input.createdAt, 40, 'Creation date'),
    sourceFile: text(input.sourceFile || '', 512, 'Workspace source name'),
    sourceTime: number(input.sourceTime, 0, 1e12, 'Source simulation time'),
    sourceCircuit,
    runCircuit,
    probes,
    config,
    samples,
    origin: number(input.origin, 0, 1e12, 'Capture origin'),
    interval: number(input.interval, 1e-15, 5, 'Requested sample spacing'),
    solverSteps: number(input.solverSteps, 1, 10000000, 'Solver steps'),
    minStep: number(input.minStep, 1e-15, 1e6, 'Minimum timestep'),
    maxStep: number(input.maxStep, 1e-15, 1e6, 'Maximum timestep'),
    wallMs: number(input.wallMs, 0, 120000, 'Capture time'),
    status: input.status,
    reason: text(input.reason || '', 300, 'Completion reason'),
    runtime: recordedRuntime,
    statistics: sampleStatistics(samples, probes),
    fingerprints: {
      source: captureHash(sourceCircuit),
      capturedCircuit: captureHash(runCircuit),
      samples: captureHash(samples)
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(out, null, 2)) >
    CAPTURE_LIMITS.body - 4096
  )
    bad('The capture exceeds the 4 MB packet limit')
  return out
}

export function createCaptureStore(
  workspace,
  runtime,
  { zipWriter = writeProjectZip } = {}
) {
  const token = randomUUID(),
    rootWorkspace = existsSync(workspace)
      ? realpathSync(workspace)
      : resolve(workspace)
  function directory(parent, name, create = false) {
    const path = join(parent, name)
    if (!existsSync(path)) {
      if (!create) return null
      mkdirSync(path, { mode: 0o700 })
    }
    if (
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isDirectory() ||
      realpathSync(path) !== path
    )
      bad('Capture folders must be real workspace directories')
    return path
  }
  function root(create = false) {
    if (!existsSync(rootWorkspace)) {
      if (create) bad('The workspace is unavailable')
      return null
    }
    if (
      !lstatSync(rootWorkspace).isDirectory() ||
      realpathSync(rootWorkspace) !== rootWorkspace
    )
      bad('The workspace directory changed')
    const h = directory(rootWorkspace, '.harness', create)
    return h ? directory(h, 'circuit-captures', create) : null
  }
  function file(dir, name, max = CAPTURE_LIMITS.body * 4) {
    const path = join(dir, name),
      s = lstatSync(path)
    if (!s.isFile() || s.isSymbolicLink() || s.size > max)
      bad('The capture file is unavailable or too large')
    return path
  }
  function folder(id) {
    if (!UUID.test(id)) bad('Invalid capture identifier')
    const r = root(),
      d = r && directory(r, id)
    if (!d) throw Object.assign(new Error('Capture not found'), { status: 404 })
    return d
  }
  function read(id) {
    const dir = folder(id),
      body = readFileSync(
        file(dir, 'capture.json', CAPTURE_LIMITS.body),
        'utf8'
      ),
      checks = JSON.parse(readFileSync(file(dir, 'checksums.json', 32768)))
    if (captureHash(body) !== checks['capture.json'])
      bad('This capture was changed on disk')
    const data = JSON.parse(body)
    if (data.id !== id || data.spec !== 'circuit-capture/1')
      bad('Invalid saved capture')
    return { ...data, kept: true }
  }
  function list() {
    const r = root()
    if (!r) return []
    return readdirSync(r)
      .filter((n) => UUID.test(n))
      .slice(0, 100)
      .flatMap((id) => {
        try {
          const t = read(id)
          return [
            {
              id,
              title: t.title,
              createdAt: t.createdAt,
              status: t.status,
              samples: t.samples.length,
              duration: t.samples.at(-1)[0],
              probes: t.probes.map((p) => p.label)
            }
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  function keep(input) {
    const take = validateCapture(input, runtime),
      requestHash = captureHash(take),
      r = root(true)
    if (existsSync(join(r, take.id))) {
      const previous = read(take.id)
      if (previous.requestHash !== requestHash)
        bad(
          'This capture was already kept with different notes; reopen the saved copy'
        )
      return previous
    }
    if (readdirSync(r).filter((n) => UUID.test(n)).length >= 100)
      bad(
        'Move older captures out of this workspace before keeping more than 100'
      )
    const saved = {
        ...take,
        requestHash,
        keptAt: new Date().toISOString(),
        runtimeAtSave: runtime
      },
      rows = [
        ['time_s', ...take.probes.map((p) => `${p.label} (${p.unit})`)],
        ...take.samples
      ]
    const nativeName = /^\s*</.test(take.sourceCircuit)
      ? 'circuit.xml'
      : 'circuit.txt'
    const runName = /^\s*</.test(take.runCircuit)
      ? 'capture-circuit.xml'
      : 'capture-circuit.txt'
    const table = take.statistics
      .map(
        (s, i) =>
          `| ${take.probes[i].label.replaceAll('|', '\\|')} | ${quantity(s.min, take.probes[i].unit)} | ${quantity(s.max, take.probes[i].unit)} | ${quantity(s.mean, take.probes[i].unit)} | ${quantity(s.rms, take.probes[i].unit)} |`
      )
      .join('\n')
    const files = {
      'capture.json': JSON.stringify(saved, null, 2) + '\n',
      [nativeName]: take.sourceCircuit,
      [runName]: take.runCircuit,
      'measurements.csv':
        rows.map((r) => r.map(csv).join(',')).join('\r\n') + '\r\n',
      'trace.svg': captureSVG(take),
      'notes.md': `# ${take.title}\n\n${take.note || 'No note added.'}\n\n${take.status}: ${take.reason}. ${take.samples.length} stored samples over ${quantity(take.samples.at(-1)[0], 's')}; ${take.solverSteps} native solver callbacks.\n\n| Probe | Min | Max | Sampled mean | Sampled RMS |\n|---|---:|---:|---:|---:|\n${table}\n\nMean and RMS use trapezoidal time weighting on the stored samples. Narrow spikes and faster signals can be missed by sampling. No bandwidth, hardware or physical-model validation is implied.\n`,
      'README.md': `# Native CircuitJS capture\n\n${nativeName} is the exact export of the visible circuit at capture start, including in-pane edits. ${runName} is the native export of the separate simulator after import with faster display pacing. The solver timestep and element values are not intentionally changed. The visible circuit and workspace source are not overwritten.\n\nThis is a new simulation of an exported circuit, not a complete checkpoint of every internal solver state. Importing it again can produce a different transient; current source time is recorded, but the capture has its own time origin. CircuitJS exports native XML on current builds; import it through CircuitJS File → Import From Text or importCircuit. Keep the original workspace text format for normal agent edits.\n\nmeasurements.csv has seconds and native volts/amperes from solver callbacks, sampled at a requested spacing of ${take.interval} s. Actual sample timestamps and the native timestep range are in capture.json. Read min/max/mean/RMS as sampled observations. Reduce the timestep and sample spacing for faster signals. No physical hardware was measured.\n\ntrace.svg and notes.md describe this capture alone. In the originating workspace, choose the two saved captures in Scope Lab. Elsewhere, inspect their CSV/JSON or import a circuit into native CircuitJS. The packet includes circuit source and node labels; keep it where you keep the project. Runtime source/build fingerprints are in capture.json. Upstream CircuitJS1, by Paul Falstad and Iain Sharp, is GPL-2.0 and is installed separately; no upstream runtime is bundled. The OpenHarness capture wrapper is MIT.\n`
    }
    const temp = mkdtempSync(join(r, '.pending-'))
    try {
      for (const [name, content] of Object.entries(files))
        writeFileSync(join(temp, name), content, { flag: 'wx', mode: 0o600 })
      writeFileSync(
        join(temp, 'checksums.json'),
        JSON.stringify(
          Object.fromEntries(
            Object.entries(files).map(([n, c]) => [n, captureHash(c)])
          ),
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      )
      zipWriter(temp, join(temp, 'capture.zip'))
      writeFileSync(
        join(temp, 'archive.sha256'),
        captureHash(readFileSync(join(temp, 'capture.zip'))) + '\n',
        { mode: 0o600 }
      )
      renameSync(temp, join(r, take.id))
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      throw error
    }
    return { ...saved, kept: true }
  }
  return {
    token,
    runtime,
    list,
    read,
    keep,
    download(id) {
      const dir = folder(id)
      read(id)
      const archive = file(dir, 'capture.zip')
      if (
        captureHash(readFileSync(archive)) !==
        readFileSync(file(dir, 'archive.sha256', 100), 'utf8').trim()
      )
        bad('This capture archive was changed on disk')
      return archive
    }
  }
}
