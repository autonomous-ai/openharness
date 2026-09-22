// Shape Lab runs a snapshot of an explicitly parameterized Blender project. It never runs a
// command supplied by HTTP, and workspace-relative preview outputs stay separate from originals.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { writeProjectZip } from './zip.mjs'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const stable = (value) =>
  JSON.stringify(value, function (_, v) {
    return v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v
  })
const id = () => randomBytes(10).toString('hex')
const validId = (value) => typeof value === 'string' && /^[a-f0-9]{20}$/.test(value)
const relativePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length < 300 &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  value.split('/').every((p) => p && !p.startsWith('.'))
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
function readJson(file, limit = 65536) {
  if (statSync(file).size > limit) throw new Error('Design record is too large')
  return JSON.parse(readFileSync(file, 'utf8'))
}
function safeFile(root, path) {
  const full = realpathSync(resolve(root, path))
  if (!inside(realpathSync(root), full) || !statSync(full).isFile())
    throw new Error('File must stay inside its project')
  return full
}
export function validateDefinition(value) {
  if (
    !value ||
    value.spec !== 1 ||
    value.kind !== 'blender-parameters' ||
    typeof value.title !== 'string' ||
    value.title.length > 100 ||
    !relativePath(value.entry) ||
    extname(value.entry) !== '.py' ||
    !relativePath(value.output) ||
    !/^out\/.+\.(glb|gltf)$/.test(value.output) ||
    value.output.startsWith('out/designs/') ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > 16 ||
    value.sources.some(
      (p) => !relativePath(p) || ['out', 'node_modules', 'venv', '_harness_tools'].includes(p.split('/')[0]),
    ) ||
    !value.sources.some((p) => value.entry === p || value.entry.startsWith(p + '/')) ||
    !Array.isArray(value.controls) ||
    !value.controls.length ||
    value.controls.length > 16
  )
    throw new Error('Invalid Shape Lab declaration. Rebuild the project to publish its controls.')
  const names = new Set()
  for (const c of value.controls) {
    if (
      !c ||
      typeof c.id !== 'string' ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(c.id) ||
      names.has(c.id) ||
      typeof c.label !== 'string' ||
      c.label.length > 80 ||
      typeof c.description !== 'string' ||
      c.description.length > 200 ||
      typeof c.unit !== 'string' ||
      c.unit.length > 16
    )
      throw new Error('Invalid design control')
    names.add(c.id)
    if (['number', 'integer'].includes(c.type)) {
      if (
        ![c.min, c.max, c.step].every(finite) ||
        c.min >= c.max ||
        c.step <= 0 ||
        (c.type === 'integer' && ![c.min, c.max, c.step].every(Number.isInteger))
      )
        throw new Error('Invalid control range')
    } else if (c.type === 'choice') {
      if (
        !Array.isArray(c.options) ||
        c.options.length < 2 ||
        c.options.length > 12 ||
        c.options.some((v) => typeof v !== 'string' || !v || v.length > 80) ||
        new Set(c.options).size !== c.options.length
      )
        throw new Error('Invalid control choices')
    } else if (c.type !== 'boolean') throw new Error('Unsupported design control')
  }
  validateValues(value, Object.fromEntries(value.controls.map((c) => [c.id, c.default])))
  return value
}
export function validateValues(definition, values) {
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some((k) => !definition.controls.some((c) => c.id === k))
  )
    throw new Error('Unknown design values')
  const result = {}
  for (const c of definition.controls) {
    const v = Object.hasOwn(values, c.id) ? values[c.id] : c.default
    if (
      (['number', 'integer'].includes(c.type) &&
        (!finite(v) || v < c.min || v > c.max || (c.type === 'integer' && !Number.isInteger(v)))) ||
      (c.type === 'boolean' && typeof v !== 'boolean') ||
      (c.type === 'choice' && !c.options.includes(v))
    )
      throw new Error(`${c.label}: choose a value within its declared range`)
    result[c.id] = v
  }
  return result
}

export function createDesignController({
  workspace,
  python,
  toolchain,
  notify = () => {},
  timeout = 120000,
}) {
  workspace = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace)
  const scratch = mkdtempSync(join(tmpdir(), 'harness-shape-lab-'))
  const jobs = new Map(),
    sourceCache = new Map()
  let active = null,
    queued = null,
    last = null,
    request = null,
    closed = false
  const available = !!(
    python &&
    toolchain &&
    existsSync(python) &&
    existsSync(join(toolchain, 'harness_design.py'))
  )
  function stop(job, signal = 'SIGTERM') {
    if (!job.child?.pid) return
    try {
      if (process.platform === 'win32') job.child.kill(signal)
      else process.kill(-job.child.pid, signal) // only this preview's own process group
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }

  function descriptor() {
    if (existsSync(workspace)) workspace = realpathSync(workspace)
    const path = join(workspace, '.harness/design.json')
    if (!existsSync(path)) return null
    const definition = validateDefinition(readJson(safeFile(workspace, '.harness/design.json')))
    const files = new Map()
    let bytes = 0
    function visit(rel, depth = 0) {
      if (depth > 16) throw new Error('Design source nesting is too deep')
      const full = join(workspace, rel),
        st = lstatSync(full)
      if (st.isSymbolicLink()) throw new Error('Design sources cannot contain symbolic links')
      if (!inside(workspace, realpathSync(full)))
        throw new Error('Design sources must stay inside the project')
      if (st.isDirectory()) {
        for (const name of readdirSync(full).sort())
          if (!name.startsWith('.') && name !== '__pycache__') visit(rel + '/' + name, depth + 1)
      } else if (st.isFile()) {
        if (files.has(rel)) return
        bytes += st.size
        if (files.size >= 2000 || bytes > 128 * 1024 * 1024)
          throw new Error('Design sources exceed 128 MB or 2,000 files')
        const mark = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
        let cached = sourceCache.get(rel)
        if (cached?.mark !== mark) {
          cached = { mark, hash: hash(readFileSync(full)) }
          sourceCache.set(rel, cached)
        }
        files.set(rel, cached.hash)
      } else throw new Error('Unsupported design source file')
    }
    for (const path of definition.sources) {
      let parent = workspace
      for (const part of path.split('/')) {
        parent = join(parent, part)
        if (lstatSync(parent).isSymbolicLink())
          throw new Error('Design sources cannot contain symbolic links')
      }
      visit(path)
    }
    for (const path of sourceCache.keys()) if (!files.has(path)) sourceCache.delete(path)
    if (!files.has(definition.entry)) throw new Error('The entry script is not in the declared sources')
    let chosen = {}
    if (existsSync(join(workspace, 'design-values.json'))) {
      const record = readJson(safeFile(workspace, 'design-values.json'), 16384)
      if (record.spec !== 1) throw new Error('Invalid design-values.json')
      chosen = record.values
    }
    const values = validateValues(definition, chosen)
    const sourceHashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)))
    const sourceFingerprint = hash(stable({ definition, sourceHashes }))
    const revision = hash(stable({ definition, sourceHashes, values }))
    return { definition, values, sourceHashes, sourceFingerprint, revision }
  }
  function publicJob(job) {
    if (!job) return null
    return {
      id: job.id,
      at: job.at,
      values: job.values,
      revision: job.revision,
      sourceFingerprint: job.sourceFingerprint,
      definition: job.definition,
      model: `/__design/${job.id}/${job.definition.output}`,
      report: job.report,
      seconds: job.seconds,
    }
  }
  function archiveRoot(create = false) {
    let path = workspace
    for (const part of ['out', 'designs']) {
      path = join(path, part)
      if (create && !existsSync(path)) mkdirSync(path)
      if (!existsSync(path)) return null
      if (!inside(workspace, realpathSync(path))) throw new Error('Saved designs must stay in the project')
    }
    return path
  }
  function saved(id) {
    if (!validId(id)) throw new Error('Invalid saved design')
    const root = archiveRoot(),
      folder = root && realpathSync(join(root, id))
    if (!folder || !inside(realpathSync(root), folder)) throw new Error('Saved design not found')
    const record = readJson(safeFile(folder, 'design.json'), 2000000)
    if (record.spec !== 1 || record.id !== id) throw new Error('Invalid saved design record')
    validateDefinition(record.definition)
    validateValues(record.definition, record.values)
    if (
      typeof record.name !== 'string' ||
      !record.name ||
      record.name.length > 80 ||
      typeof record.at !== 'string' ||
      !Number.isFinite(Date.parse(record.at)) ||
      !record.sourceHashes ||
      typeof record.sourceHashes !== 'object' ||
      Array.isArray(record.sourceHashes) ||
      Object.entries(record.sourceHashes).some(
        ([path, digest]) =>
          !relativePath(path) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest),
      ) ||
      !Array.isArray(record.report?.size_mm) ||
      record.report.size_mm.length !== 3 ||
      !record.report.size_mm.every(finite)
    )
      throw new Error('Invalid saved design record')
    return { record, folder }
  }
  function list() {
    const root = archiveRoot()
    if (!root) return []
    return readdirSync(root)
      .filter(validId)
      .flatMap((id) => {
        try {
          const { record } = saved(id)
          return [
            {
              ...record,
              sourceHashes: undefined,
              sourceFingerprint: hash(
                stable({ definition: record.definition, sourceHashes: record.sourceHashes }),
              ),
              model: `/__design/saved-${id}/${record.definition.output}`,
              thumbnail: record.thumbnail ? `/__design/saved-${id}/thumbnail.png` : null,
              path: `out/designs/${id}`,
            },
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.at.localeCompare(a.at))
  }
  function state() {
    let design = null,
      error = null,
      variants = []
    try {
      design = descriptor()
      variants = list()
    } catch (e) {
      error = e.message
    }
    return { available, design, request, last: publicJob(last), variants, error }
  }
  function launch(job) {
    active = job
    request = { id: job.id, status: 'building', values: job.values }
    notify()
    const start = Date.now()
    const child = spawn(python, [join(job.source, job.definition.entry)], {
      cwd: job.source,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HARNESS_WORKSPACE: job.source,
        HARNESS_DESIGN_PREVIEW: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: [join(job.source, '_harness_tools'), job.source].join(sep === '\\' ? ';' : ':'),
      },
    })
    job.child = child
    let log = ''
    for (const pipe of [child.stdout, child.stderr])
      pipe.on('data', (data) => {
        log = (log + data).slice(-12000)
      })
    const timer = setTimeout(() => {
      job.cancelled = true
      job.reason = 'Preview exceeded its time limit'
      stop(job)
      job.killTimer = setTimeout(() => stop(job, 'SIGKILL'), 1000)
    }, timeout)
    job.done = new Promise((resolveDone) => {
      let finished = false
      const finish = (code, error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearTimeout(job.killTimer)
        job.seconds = (Date.now() - start) / 1000
        try {
          if (job.cancelled) throw new Error(job.reason || 'Preview cancelled')
          if (error || code !== 0) throw new Error(error?.message || log.trim() || `Blender exited ${code}`)
          const actual = validateDefinition(readJson(safeFile(job.source, '.harness/design.json')))
          if (stable(actual) !== stable(job.definition))
            throw new Error(
              'The controls changed in source. Rebuild the project to publish the new controls.',
            )
          const model = safeFile(job.source, job.definition.output)
          if (statSync(model).size > 64 * 1024 * 1024) throw new Error('The preview model exceeds 64 MB')
          const content = readFileSync(model)
          if (
            content.length < 100 ||
            (extname(model) === '.glb'
              ? content.toString('ascii', 0, 4) !== 'glTF' ||
                content.readUInt32LE(4) !== 2 ||
                content.readUInt32LE(8) !== content.length
              : JSON.parse(content).asset?.version !== '2.0')
          )
            throw new Error('Blender did not produce a valid glTF preview')
          job.report = readJson(safeFile(job.source, 'out/report.json'))
          if (
            !Array.isArray(job.report.size_mm) ||
            job.report.size_mm.length !== 3 ||
            !job.report.size_mm.every((v) => finite(v) && v >= 0) ||
            !(job.report.faces > 0)
          )
            throw new Error('The preview has no measured geometry report')
          job.ready = true
          last = job
          if (!queued) request = { id: job.id, status: 'ready', values: job.values }
        } catch (e) {
          if (!queued)
            request = {
              id: job.id,
              status: job.cancelled ? 'cancelled' : 'error',
              values: job.values,
              error: String(e.message).slice(-3000),
            }
        }
        active = null
        resolveDone()
        if (!closed && queued) {
          const next = queued
          queued = null
          launch(next)
        }
        for (const [key, item] of jobs)
          if (jobs.size > 5 && item !== active && item !== queued && item !== last) {
            rmSync(item.root, { recursive: true, force: true })
            jobs.delete(key)
          }
        if (!closed) notify()
      }
      child.once('error', (error) => finish(null, error))
      child.once('close', (code) => finish(code))
    })
  }
  function preview(body) {
    if (closed || !available) throw new Error('The Blender toolchain is not available for this viewer')
    const design = descriptor()
    if (!design || body.revision !== design.revision)
      throw new Error('The project changed. Reload its controls before previewing.')
    const values = validateValues(design.definition, body.values)
    const job = { id: id(), at: new Date().toISOString(), ...design, values }
    job.root = join(scratch, job.id)
    job.source = join(job.root, 'source')
    try {
      mkdirSync(join(job.source, '.harness'), { recursive: true })
      for (const [path, expected] of Object.entries(job.sourceHashes)) {
        const bytes = readFileSync(safeFile(workspace, path))
        if (hash(bytes) !== expected) throw new Error('Source changed during the snapshot. Try again.')
        const target = join(job.source, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
      }
      mkdirSync(join(job.source, '_harness_tools'))
      for (const name of ['harness_blender.py', 'harness_design.py', 'LICENSE'])
        cpSync(join(toolchain, name), join(job.source, '_harness_tools', name))
      writeFileSync(join(job.source, '.harness/design.json'), JSON.stringify(job.definition))
      writeFileSync(
        join(job.source, 'design-values.json'),
        JSON.stringify({ spec: 1, values }, null, 2) + '\n',
      )
    } catch (e) {
      rmSync(job.root, { recursive: true, force: true })
      throw e
    }
    jobs.set(job.id, job)
    if (active) {
      if (queued) {
        rmSync(queued.root, { recursive: true, force: true })
        jobs.delete(queued.id)
      }
      queued = job
      request = { id: job.id, status: 'queued', values }
      notify()
    } else launch(job)
    return { id: job.id, values }
  }
  function keep(body) {
    const job = jobs.get(body.id)
    if (!job?.ready) throw new Error('Build a successful preview before keeping it')
    const name = String(body.name || '').trim()
    if (!name || name.length > 80) throw new Error('Name this design in 80 characters or fewer')
    const root = archiveRoot(true),
      key = id(),
      staging = join(root, '.' + key),
      target = join(root, key)
    const record = {
      spec: 1,
      id: key,
      name,
      at: new Date().toISOString(),
      definition: job.definition,
      values: job.values,
      sourceRevision: job.revision,
      sourceHashes: job.sourceHashes,
      report: job.report,
      seconds: job.seconds,
      thumbnail: false,
    }
    try {
      // Refuse links created by a script, including links in generated assets.
      let total = 0,
        files = 0
      const check = (path, depth = 0) => {
        const st = lstatSync(path)
        if (st.isSymbolicLink()) throw new Error('Saved designs cannot contain symbolic links')
        if (depth > 32) throw new Error('Saved design nesting is too deep')
        if (st.isDirectory()) for (const n of readdirSync(path)) check(join(path, n), depth + 1)
        else {
          if (!st.isFile()) throw new Error('Unsupported saved design entry')
          total += st.size
          if (++files > 9900 || total > 510 * 1024 * 1024) throw new Error('Saved design is too large')
        }
      }
      check(job.root)
      cpSync(job.root, staging, { recursive: true, force: false, errorOnExist: true })
      if (body.thumbnail != null) {
        if (
          typeof body.thumbnail !== 'string' ||
          body.thumbnail.length > 1500000 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.thumbnail)
        )
          throw new Error('Invalid preview image')
        const bytes = Buffer.from(body.thumbnail.split(',')[1], 'base64')
        if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
          throw new Error('Invalid PNG preview')
        writeFileSync(join(staging, 'thumbnail.png'), bytes)
        record.thumbnail = true
      }
      writeFileSync(join(staging, 'design.json'), JSON.stringify(record, null, 2) + '\n')
      writeFileSync(
        join(staging, 'rebuild.py'),
        `"""Rebuild this saved design with Python and bpy installed. Use --preview to skip renders."""\nimport os, runpy, sys\nfrom pathlib import Path\nroot = Path(__file__).resolve().parent / "source"\nos.chdir(root)\nos.environ["HARNESS_WORKSPACE"] = str(root)\nif "--preview" in sys.argv: os.environ["HARNESS_DESIGN_PREVIEW"] = "1"\nelse: os.environ.pop("HARNESS_DESIGN_PREVIEW", None)\nsys.path[:0] = [str(root / "_harness_tools"), str(root)]\nentry = ${JSON.stringify(job.definition.entry)}\nsys.argv = [str(root / entry)]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n`,
      )
      writeFileSync(
        join(staging, 'README.md'),
        `# ${name}\n\nA real Blender design, built from the included source and design-values.json.\n\nModel: source/${job.definition.output}\nMeasurements: source/out/report.json\nParameters and source fingerprints: design.json\n\nWith Python and bpy ${job.report.blender || ''} installed, run:\n\n    python rebuild.py --preview\n\nRemove --preview to also run the source's renders. Edit source/design-values.json or the\nsource code to keep making it your own. Install any additional Python dependencies the\nauthored source needs. _harness_tools contains the MIT-licensed OpenHarness helper code\nand its license; Blender/bpy retains its own GPL license.\n`,
      )
      writeProjectZip(staging, join(staging, 'project.zip'))
      renameSync(staging, target)
    } catch (e) {
      rmSync(staging, { recursive: true, force: true })
      throw e
    }
    notify()
    return { id: key, path: `out/designs/${key}`, name }
  }
  function useValues(body) {
    const { record } = saved(body.id),
      current = descriptor()
    if (
      !current ||
      body.revision !== current.revision ||
      stable(record.definition) !== stable(current.definition) ||
      stable(record.sourceHashes) !== stable(current.sourceHashes)
    )
      throw new Error('The source changed. Ask the agent to adapt this saved design before using its values.')
    const values = validateValues(current.definition, record.values)
    if (existsSync(join(workspace, 'design-values.json'))) safeFile(workspace, 'design-values.json')
    const temporary = join(workspace, `.design-values-${id()}.json`)
    writeFileSync(temporary, JSON.stringify({ spec: 1, values }, null, 2) + '\n')
    renameSync(temporary, join(workspace, 'design-values.json'))
    notify()
    return { path: 'design-values.json', values }
  }
  return {
    state,
    preview,
    keep,
    useValues,
    cancel(body) {
      if (queued?.id === body.id) {
        rmSync(queued.root, { recursive: true, force: true })
        jobs.delete(queued.id)
        queued = null
        request = { id: body.id, status: 'cancelled' }
        notify()
        return
      }
      if (active?.id === body.id) {
        active.cancelled = true
        const job = active
        stop(job)
        job.killTimer = setTimeout(() => stop(job, 'SIGKILL'), 1000)
      }
    },
    file(key, path) {
      if (key.startsWith('saved-')) {
        const { folder } = saved(key.slice(6))
        if (path === 'thumbnail.png') return safeFile(folder, path)
        return safeFile(join(folder, 'source'), path)
      }
      const job = jobs.get(key)
      if (!job?.ready || !path.startsWith('out/')) throw new Error('Preview not found')
      return safeFile(job.source, path)
    },
    async close() {
      closed = true
      queued = null
      if (active) {
        const job = active
        job.cancelled = true
        stop(job)
        job.killTimer = setTimeout(() => stop(job, 'SIGKILL'), 1000)
        await job.done
      }
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}
