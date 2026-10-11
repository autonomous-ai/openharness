/** Real generated installer shell and detached recorder, with only private fixture commands. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EngineInstallRecipe } from '../../lib/engineInstall.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'

let root: string, home: string, binary: string, directory: string, environment: Record<string, string>
let module: typeof import('./nativeInstall.js')
const children = new Set<ChildProcess>()
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-install-process-')))
  home = join(root, 'home'); mkdirSync(home, { mode: 0o700 })
  binary = join(root, 'fixture-engine'); directory = join(root, 'claims')
  for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'ZDOTDIR']) {
    const value = key === 'HOME' ? home : join(root, key)
    mkdirSync(value, { recursive: true, mode: 0o700 }); vi.stubEnv(key, value)
  }
  vi.stubEnv('OPENCODE_PATH', join(root, 'absent-default'))
  vi.stubEnv('SHELL', '/bin/sh'); vi.stubEnv('PATH', '/usr/bin:/bin')
  environment = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh' }
  vi.resetModules(); module = await import('./nativeInstall.js')
})
afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  // The recorder reaps its stopped group; the escaped fixture exits after five
  // seconds. Their recorded PIDs are observations, never cleanup authority.
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
})

const nodeCommand = (code: string) => `${shellSingleQuote(process.execPath)} -e ${shellSingleQuote(code)}`
const installCode = () => `require('node:fs').writeFileSync(${JSON.stringify(binary)},${JSON.stringify('#!/bin/sh\nprintf ran >' + shellSingleQuote(join(root, 'engine-ran')) + '\nexit 0\n')},{mode:0o700})`
const recipe = (code: string): EngineInstallRecipe => ({ command: nodeCommand(code), source: 'private fixture', executable: { names: [binary] } })
const controller = () => {
  const dispatch = vi.fn()
  return { dispatch, ...module.createNativeInstallations({ directory, node: () => process.execPath, dispatch }) }
}
function run(file: string, hash: string, deadline = 2000, prefix = ''): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, ['-e', prefix + module.NATIVE_INSTALL_WORKER, file, hash, String(deadline)], {
      env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    let stderr = ''; child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => { child.kill('SIGKILL'); failed(Error('Private installer recorder exceeded its test limit')) }, 8000)
    child.on('error', failed)
    child.on('close', code => { clearTimeout(timer); children.delete(child); done({ code, stderr }) })
  })
}
const settled = async (test: () => boolean) => {
  for (let n = 0; n < 200; n++) { if (test()) return; await new Promise(done => setTimeout(done, 10)) }
  throw Error('Private fixture did not reach its checkpoint')
}

it('executes the real installation wrapper once without starting the engine or dropping shell support', async () => {
  const install = controller(), chosen = recipe(installCode())
  await install.ensure('opencode', chosen, environment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  const [, file, hash] = install.dispatch.mock.calls[0]
  const result = await run(file, hash)
  expect(result.code).toBe(0)
  expect(result.stderr).not.toMatch(/harness_resume.*not found/)
  const recorded = JSON.parse(readFileSync(`${file}.result`, 'utf8'))
  expect(recorded, recorded.detail).toMatchObject({ code: 0, signal: null })
  expect(recorded.detail).not.toMatch(/harness_resume.*not found/)
  expect(existsSync(join(root, 'engine-ran'))).toBe(false)
  expect(existsSync(binary)).toBe(true)
  expect(await controller().ensure('opencode', chosen, environment, 'request', () => true)).toEqual({ complete: true })
}, 15_000)

it('waits for a private live Desktop download marker before using its installation', async () => {
  mkdirSync(join(home, '.harness', 'run'), { recursive: true })
  const downloader = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'harness-download-private-fixture'], { stdio: 'ignore' })
  children.add(downloader)
  writeFileSync(join(home, '.harness', 'run', 'downloading-opencode'), String(downloader.pid))
  const install = controller(), wrong = join(root, 'competing-install')
  await install.ensure('opencode', recipe(`require('node:fs').writeFileSync(${JSON.stringify(wrong)},'wrong');${installCode()}`), environment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  const [, file, hash] = install.dispatch.mock.calls[0]
  const running = run(file, hash)
  await new Promise(done => setTimeout(done, 150))
  expect(existsSync(wrong)).toBe(false)
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  downloader.kill('SIGTERM')
  expect((await running).code).toBe(0)
  expect(existsSync(wrong)).toBe(false)
  expect(JSON.parse(readFileSync(`${file}.result`, 'utf8')).code).toBe(0)
}, 15_000)

it('ends a stopped installer child at the group deadline', async () => {
  const pidFile = join(root, 'stopped.pid')
  const install = controller()
  await install.ensure('opencode', recipe(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.kill(process.pid,'SIGSTOP');${installCode()}`), environment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  const [, file, hash] = install.dispatch.mock.calls[0]
  const result = await run(file, hash, 500)
  expect(result.code).toBe(0)
  expect(existsSync(pidFile)).toBe(true)
  expect(JSON.parse(readFileSync(`${file}.result`, 'utf8'))).toMatchObject({ code: null, signal: 'SIGKILL' })
  expect(existsSync(binary)).toBe(false)
}, 15_000)

it('holds an escaped pipe owner after leader exit and closes the recorder without late group signalling', async () => {
  const pidFile = join(root, 'escaped.pid')
  const install = controller()
  const code = `${installCode()};const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:['ignore',1,2]});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref()`
  const chosen = recipe(code)
  await install.ensure('opencode', chosen, environment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  const [, file, hash] = install.dispatch.mock.calls[0]
  const result = await run(file, hash, 1000)
  expect(result.code).toBe(0)
  await settled(() => existsSync(pidFile))
  expect(existsSync(`${file}.result`)).toBe(false)
  expect(await controller().ensure('opencode', chosen, environment, 'request', () => true)).toMatchObject({ complete: false })
}, 15_000)

it('cannot publish a substituted success record from a replaced helper staging file', async () => {
  const install = controller(), chosen = recipe('process.exit(7)')
  await install.ensure('opencode', chosen, environment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  const [, file, hash] = install.dispatch.mock.calls[0]
  const prefix = `const injected=require('node:fs'), originalSync=injected.fsyncSync;let changed=false;injected.fsyncSync=function(fd){if(!changed&&injected.fstatSync(fd).isFile()){changed=true;const temporary=injected.readdirSync(${JSON.stringify(directory)}).find(name=>name.endsWith('.result-tmp'));const path=${JSON.stringify(directory)}+'/'+temporary;const value=JSON.parse(injected.readFileSync(path,'utf8'));value.code=0;value.signal=null;injected.unlinkSync(path);injected.writeFileSync(path,JSON.stringify(value),{mode:0o600});}return originalSync(fd)};\n`
  const result = await run(file, hash, 2000, prefix)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('Changed result staging file')
  expect(existsSync(`${file}.result`)).toBe(false)
  expect(await controller().ensure('opencode', chosen, environment, 'request', () => true)).toMatchObject({ complete: false })
}, 15_000)
