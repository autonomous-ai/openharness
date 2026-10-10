/** Exercise the shipped artifact against an older installation, without an account or network. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readBuiltinBundle, readHarnessMonitorBundle, readMemoriesBundle, readModelManagerBundle } from './lib/modelManagerBundle.mjs'

const cli = resolve(process.argv[2] || fileURLToPath(new URL('../dist/cli.js', import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'core-harness-upgrade-'))
const dshDir = join(root, 'dsh')
const workspace = join(root, 'existing-workspace')
const packages = [
  ['autonomous-grid', 'model-manager', readModelManagerBundle],
  ['devices', 'devices', dir => readBuiltinBundle(dir, ['harness.json', 'AGENTS.md', 'LICENSE', 'template'])],
  ['harness-monitor', 'harness-monitor', readHarnessMonitorBundle],
  ['memories', 'memories', readMemoriesBundle],
]
const env = { ...process.env, DSH_DIR: dshDir, ADAPTER_DATA_DIR: join(root, 'data'),
  ADAPTER_COMPUTER_ID: 'core-upgrade-test', ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id') }
const run = (...args) => execFileSync(process.execPath, [cli, 'dsh', ...args], {
  cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
})
const index = () => JSON.parse(readFileSync(join(dshDir, 'installed.json'), 'utf8'))
let viewer
const monitorEnv = { HARNESS_MONITOR_CONFIG: process.env.HARNESS_MONITOR_CONFIG, HARNESS_MONITOR_STATE: process.env.HARNESS_MONITOR_STATE }
try {
  mkdirSync(dshDir)
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'NOTES.md'), 'Keep my workspace and conversation.\n')
  const previous = packages.map(([folder]) => {
    const dir = join(dshDir, 'autonomous', folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'Previous release resources\n')
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id: `autonomous/${folder}`, name: folder, engine: 'opencode' }))
    return { id: `autonomous/${folder}`, dir, source: 'https://github.com/autonomous-ai/autonomous-harness.git',
      path: `store/agents/${folder}`, ref: 'previous-release', commit: 'a'.repeat(40), revision: 'b'.repeat(40),
      linked: false, installedAt: 123 }
  })
  const blender = { ...previous[0], id: 'autonomous/blender', dir: join(dshDir, 'autonomous', 'blender'), path: 'store/agents/blender' }
  writeFileSync(join(dshDir, 'installed.json'), JSON.stringify([...previous, blender]))
  run('builtins')
  const upgraded = index()
  for (const [folder, builtin, readBundle] of packages) {
    const installed = upgraded.find(row => row.id === `autonomous/${folder}`)
    assert(installed, `release bundle is missing ${folder}`)
    assert.equal(installed.source, `builtin:${builtin}`)
    assert.equal(installed.installedAt, 123)
    assert.notEqual(installed.dir, previous.find(row => row.id === installed.id).dir)
    const source = fileURLToPath(new URL(`../../store/agents/${folder}`, import.meta.url))
    for (const [path, file] of Object.entries(readBundle(source))) {
      assert.deepEqual(readFileSync(join(installed.dir, path)), readFileSync(join(source, path)), `${folder}/${path}`)
      if (file.executable) assert(statSync(join(installed.dir, path)).mode & 0o111, `${folder}/${path} must be executable`)
    }
  }
  for (const record of previous) assert.equal(readFileSync(join(record.dir, 'AGENTS.md'), 'utf8'), 'Previous release resources\n')
  assert.equal(readFileSync(join(workspace, 'NOTES.md'), 'utf8'), 'Keep my workspace and conversation.\n')
  assert.deepEqual(upgraded.find(row => row.id === blender.id), blender)
  run('builtins')
  assert.deepEqual(index(), upgraded, 'repeated startup must reuse the installed core revisions')
  console.log('PASS release bundle migrates existing official core packages; prior files, workspaces and Store apps are retained')

  const monitor = upgraded.find(row => row.id === 'autonomous/harness-monitor')
  process.env.HARNESS_MONITOR_CONFIG = join(root, 'policy.jsonc')
  process.env.HARNESS_MONITOR_STATE = join(root, 'monitor-state')
  const { createViewer } = await import(pathToFileURL(join(monitor.dir, 'viewer.mjs')).href)
  viewer = createViewer({ workspace, collect: async () => ({ rows: [], shared: [], machines: [], problems: [], degraded: false }) })
  const port = await viewer.start()
  await viewer.observed
  assert.equal(viewer.snapshot().status, 'ok')
  for (const [route, file] of [['/', 'index.html'], ['/table.js', 'table.js'], ['/icons/codex.png', 'icons/codex.png']]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`)
    assert.equal(response.status, 200, route)
    const expected = readFileSync(join(monitor.dir, 'viewer', file))
    const served = Buffer.from(await response.arrayBuffer())
    if (route === '/') assert.equal(served.toString(), expected.toString().replace('__HPS_TOKEN__', viewer.token))
    else assert.deepEqual(served, expected, route)
  }
  console.log('PASS migrated Monitor serves the released viewer, table and binary icons')
} finally {
  await viewer?.close()
  for (const [key, value] of Object.entries(monitorEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
}
