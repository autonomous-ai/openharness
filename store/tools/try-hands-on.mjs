#!/usr/bin/env node
// Run this checkout's viewer on an editable starter, using already installed native assets.
// Source is copied to an owned temporary runtime; package dependencies remain read-only links.
import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const choices = {
  mujoco: {
    name: 'MuJoCo',
    package: 'viewers/mujoco-viewer',
    native: 'mujoco-viewer',
    asset: 'node_modules',
    required: ['@mujoco/mujoco/mujoco.js', 'three/build/three.module.js'],
    source: 'store/viewers/mujoco-viewer/test/fixtures/pendulum.xml',
    file: 'scenes/pendulum.xml',
    query: '?model=scenes/pendulum.xml',
    hint: 'Open What if, try Lunar gravity, then click Farthest apart.'
  },
  strudel: {
    name: 'Strudel',
    package: 'agents/strudel',
    native: 'strudel',
    asset: 'node_modules',
    required: ['@strudel/repl/dist/index.js'],
    source: 'store/agents/strudel/test/fixtures/lantern-room.strudel',
    file: 'track.strudel',
    query: '?file=track.strudel',
    hint: 'Click Play, then Record take. Mute a voice, mark a moment and keep the sound.'
  },
  circuitjs: {
    name: 'CircuitJS',
    package: 'agents/circuitjs',
    native: 'circuitjs',
    asset: 'upstream',
    required: ['war/circuitjs.html', 'war/circuitjs1/circuitjs1.nocache.js'],
    source: 'store/agents/circuitjs/test/fixtures/rc-scope-lab.txt',
    file: 'circuit.txt',
    query: '?file=circuit.txt',
    hint: 'Open Scope Lab, capture the named nodes, change a resistor and compare the traces.'
  }
}
const ignored = new Set([
  'node_modules',
  'upstream',
  '.venv',
  'venv',
  'test',
  'test-results',
  '__pycache__',
  '.git',
  '.DS_Store'
])

function runtimeAssets(config, source, runtimeRoot) {
  const wanted =
    config.asset === 'node_modules'
      ? JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
          .dependencies || {}
      : {}
  for (const candidate of [
    join(source, config.asset),
    join(runtimeRoot, config.native, config.asset)
  ]) {
    if (!config.required.every((file) => existsSync(join(candidate, file))))
      continue
    try {
      if (
        Object.entries(wanted).some(
          ([name, version]) =>
            JSON.parse(
              readFileSync(join(candidate, name, 'package.json'), 'utf8')
            ).version !== version
        )
      )
        continue
      return realpathSync(candidate)
    } catch {
      /* Try the other installed location. */
    }
  }
  throw Error(
    `${config.name} needs its installed ${config.asset} assets${Object.keys(wanted).length ? ' at the versions pinned by this checkout' : ''}. Run setup for store/${config.package}, or pass --runtime-root to an existing cache of harness packages.`
  )
}

export async function startPlayground({
  id,
  workspace,
  runtimeRoot = join(homedir(), '.harness/dsh/autonomous'),
  signal
} = {}) {
  signal?.throwIfAborted()
  const config = Object.hasOwn(choices, id) ? choices[id] : null
  if (!config) throw Error(`Choose one of: ${Object.keys(choices).join(', ')}`)
  const source = join(repo, 'store', config.package)
  // Check prerequisites before creating a project or copying source.
  const assets = runtimeAssets(config, source, resolve(runtimeRoot))
  const requestedProject = workspace
    ? resolve(workspace)
    : mkdtempSync(join(tmpdir(), `harness-${id}-`))
  mkdirSync(requestedProject, { recursive: true })
  const project = realpathSync(requestedProject)
  const seed = join(project, config.file)
  if (basename(config.file) !== config.file) {
    const folder = join(project, 'scenes')
    mkdirSync(folder, { recursive: true })
    if (lstatSync(folder).isSymbolicLink())
      throw Error(
        'The starter source folder must be a real directory in the project.'
      )
  }
  if (!existsSync(seed))
    writeFileSync(seed, readFileSync(join(repo, config.source)), { flag: 'wx' })
  const runtime = realpathSync(
    mkdtempSync(join(tmpdir(), 'harness-preview-runtime-'))
  )
  let child,
    closed,
    cleaned = false
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true
      rmSync(runtime, { recursive: true, force: true })
    }
  }
  try {
    cpSync(source, runtime, {
      recursive: true,
      filter: (path) =>
        !relative(source, path)
          .split(sep)
          .some((part) => ignored.has(part))
    })
    symlinkSync(assets, join(runtime, config.asset), 'dir')
    const port = await new Promise((done, fail) => {
      const listener = createServer()
      listener.once('error', fail)
      listener.listen(0, '127.0.0.1', () => {
        const port = listener.address().port
        listener.close((error) => (error ? fail(error) : done(port)))
      })
    })
    const env = {
      ...process.env,
      HARNESS_WORKSPACE: project,
      HARNESS_VIEWER_PORT: String(port),
      HARNESS_DSH_DIR: runtime
    }
    // A model picker may also expose the locally installed robots. The starter
    // itself is a self-contained MJCF pendulum and needs no Python or downloads.
    if (id === 'mujoco') {
      const robots = join(resolve(runtimeRoot), 'mujoco/menagerie')
      env.MENAGERIE = existsSync(robots) ? robots : join(project, 'menagerie')
    }
    signal?.throwIfAborted()
    child = spawn(process.execPath, [join(runtime, 'viewer.mjs')], {
      cwd: project,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let exited = false
    const capture = (chunk) => {
      output = (output + chunk).slice(-16000)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    closed = new Promise((done, fail) => {
      child.once('error', (error) => {
        exited = true
        cleanup()
        fail(error)
      })
      child.once('exit', (code, signal) => {
        exited = true
        cleanup()
        done({ code, signal })
      })
    })
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return closed
      try {
        process.platform === 'win32'
          ? child.kill('SIGTERM')
          : process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.platform === 'win32'
              ? child.kill('SIGKILL')
              : process.kill(-child.pid, 'SIGKILL')
          } catch {}
        }
      }, 4000)
      try {
        return await closed
      } finally {
        clearTimeout(force)
      }
    }
    const abort = () => {
      stop().catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    closed.then(
      () => signal?.removeEventListener('abort', abort),
      () => signal?.removeEventListener('abort', abort)
    )
    if (signal?.aborted) {
      await stop()
      signal.throwIfAborted()
    }
    const url = `http://127.0.0.1:${port}/${config.query}`
    try {
      await Promise.race([
        (async () => {
          for (let i = 0; i < 100 && !exited; i++) {
            try {
              if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok)
                return
            } catch {}
            await new Promise((done) => setTimeout(done, 50))
          }
          throw Error(
            `The ${config.name} viewer did not become ready.\n${output}`
          )
        })(),
        closed.then((result) => {
          throw Error(
            `The ${config.name} viewer stopped before it was ready (${result.code}).\n${output}`
          )
        })
      ])
    } catch (error) {
      await stop()
      throw error
    }
    return {
      id,
      name: config.name,
      url,
      workspace: project,
      runtime,
      hint: config.hint,
      stop,
      closed
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

let isMain = false
try {
  isMain =
    Boolean(process.argv[1]) &&
    realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch {}
if (isMain) {
  const args = process.argv.slice(2)
  if (!args.length || args[0] === '--help' || args[0] === '--list') {
    console.log(
      'Try a native playground from this checkout:\n\n  node store/tools/try-hands-on.mjs mujoco|strudel|circuitjs\n  --workspace /path/to/project   Keep working in a chosen folder; existing source is retained.\n  --runtime-root /path/to/cache  Existing harness packages (default: ~/.harness/dsh/autonomous).\n\nEach launch prints a local URL and project path. Ctrl-C stops the preview server; saved work stays in the project.\nThe launcher uses installed native assets. It does not download or install them.'
    )
  } else {
    let preview
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    try {
      const id = args.shift(),
        options = { id }
      while (args.length) {
        const flag = args.shift(),
          value = args.shift()
        if (
          !['--workspace', '--runtime-root'].includes(flag) ||
          !value ||
          value.startsWith('--')
        )
          throw Error(`Invalid option: ${flag}`)
        options[flag === '--workspace' ? 'workspace' : 'runtimeRoot'] = value
      }
      preview = await startPlayground({ ...options, signal: controller.signal })
      console.log(
        `\n${preview.name}: ${preview.url}\nProject: ${preview.workspace}\n\n${preview.hint}\n\nCtrl-C stops the preview server. Your source and saved work remain in the project.`
      )
      const result = await preview.closed
      process.exitCode = result.code ?? 0
    } catch (error) {
      await preview?.stop()
      if (!controller.signal.aborted) {
        console.error(error.message)
        process.exitCode = 1
      }
    }
  }
}
