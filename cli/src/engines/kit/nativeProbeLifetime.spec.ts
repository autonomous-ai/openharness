import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { executableIdentity } from './nativeExecutable.js'

let root = '', worker: ChildProcess | undefined, probePid = 0, probeFile = ''
const exactProbeLives = () => new Promise<boolean>(resolve => {
  if (!probePid) { resolve(false); return }
  execFile('ps', ['-p', String(probePid), '-o', 'command='], { timeout: 1000, maxBuffer: 8192 },
    (error, output) => resolve(!error && output.includes(probeFile)))
})
afterEach(async () => {
  if (worker && worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGCONT'); worker.kill('SIGKILL') }
  if (await exactProbeLives()) process.kill(probePid, 'SIGKILL')
  if (worker && worker.exitCode === null && worker.signalCode === null) await new Promise<void>(done => worker!.once('exit', () => done()))
  if (root) rmSync(root, { recursive: true, force: true })
  worker = undefined; probePid = 0
})

it.skipIf(process.platform === 'win32').each(['kill', 'freeze'] as const)('bounds the exact probe child after setup %s', { timeout: 12_000 }, async failure => {
  root = mkdtempSync(join(tmpdir(), 'setup-probe-lifetime-')); probeFile = join(root, 'fixture-engine')
  const marker = join(root, 'started')
  writeFileSync(probeFile, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)\n`, { mode: 0o700 })
  const module = pathToFileURL(resolve('src/services/engineSetup.ts')).href
  const payload = { command: probeFile, identity: executableIdentity(probeFile), kind: 'help', environment: { HOME: root, PATH: '/usr/bin:/bin' } }
  const script = `import { startEngineSetup } from ${JSON.stringify(module)}; const setup = startEngineSetup(${JSON.stringify(root)}); await setup.requests.setup_download({engine:'claude'}, {local:true,owner:true}); await setup.requests.setup_probe(${JSON.stringify(payload)}, {local:true,owner:true}); setup.stop();`
  worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: root, USERPROFILE: root, ADAPTER_DATA_DIR: root, ADAPTER_RUNTIME_DIR: root, SHELL: '' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  let error = ''; worker.stderr!.on('data', chunk => { error = (error + String(chunk)).slice(-4096) })
  await vi.waitFor(() => { if (worker!.exitCode !== null) throw Error(`fixture setup ended: ${error}`); expect(existsSync(marker)).toBe(true) }, { timeout: 4000 })
  probePid = Number(readFileSync(marker, 'utf8'))
  expect(Number.isSafeInteger(probePid) && probePid > 1).toBe(true)
  expect(await exactProbeLives()).toBe(true)
  worker.kill(failure === 'kill' ? 'SIGKILL' : 'SIGSTOP')
  await vi.waitFor(async () => expect(await exactProbeLives()).toBe(false), { timeout: failure === 'kill' ? 1500 : 6500 })
})
