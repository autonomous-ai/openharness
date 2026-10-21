import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EngineInstallRecipe } from '../../lib/engineInstall.js'
import { ENUMERATION_ATTEMPTS } from './nativeFiles.js'
import { createNativeInstallations, NATIVE_INSTALL_WORKER } from './nativeInstall.js'

const fixture = vi.hoisted(() => ({ failSync: false, argv: [] as string[], onSync: undefined as undefined | (() => number | void), onDirectoryOpen: undefined as undefined | (() => void) }))
vi.mock('../../lib/engineLaunch.js', () => ({ buildEngineInstallationArgv: () => fixture.argv }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    opendirSync: (...args: Parameters<typeof actual.opendirSync>) => {
      const directory = actual.opendirSync(...args)
      fixture.onDirectoryOpen?.()
      return directory
    },
    fsync: (_fd: number, done: (error: Error | null) => void) => {
      const delay = fixture.onSync?.()
      const finish = () => done(fixture.failSync ? Error('fixture unavailable disk') : null)
      if (delay) setTimeout(finish, delay); else queueMicrotask(finish)
    },
  }
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const recipe: EngineInstallRecipe = { command: 'fixture-only', source: 'fixture', executable: { names: ['fixture'] } }
let root: string, directory: string, environment: Record<string, string>
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-install-')))
  directory = join(root, 'claims')
  const home = join(root, 'home'); mkdirSync(home, { mode: 0o700 })
  environment = { HOME: home, PATH: '/usr/bin:/bin' }
  fixture.failSync = false; fixture.onSync = undefined; fixture.onDirectoryOpen = undefined
  fixture.argv = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(join(root, 'installed'))}, 'one\\n')`]
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
/** An ancestor of the claims that changes during every listing attempt (`ENUMERATION_ATTEMPTS`), then stops. */
function keepChanging(times = ENUMERATION_ATTEMPTS): () => void {
  return () => {
    if (--times === 0) fixture.onDirectoryOpen = undefined
    writeFileSync(join(root, `sibling-${times}`), 'changed during enumeration')
  }
}
const controller = (dispatch = vi.fn()) => ({ dispatch, ...createNativeInstallations({ directory, node: () => process.execPath, dispatch }) })
function complete(file = join(directory, '00000000.json'), code = 0): void {
  const text = readFileSync(file, 'utf8'), claim = JSON.parse(text)
  writeFileSync(`${file}.result`, JSON.stringify({ token: claim.token, claim: hash(text), code, signal: null }), { mode: 0o600 })
}

it('looks again when an ancestor changes once during a listing, as a busy temporary folder does', async () => {
  const install = controller()
  fixture.onDirectoryOpen = keepChanging(1)
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(fixture.onDirectoryOpen).toBeUndefined()
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  expect(existsSync(join(directory, '00000000.json'))).toBe(true)
})

it('does not reserve or dispatch after cancellation', async () => {
  const install = controller()
  expect(await install.ensure('opencode', recipe, environment, 'request', () => false)).toMatchObject({ complete: false })
  expect(existsSync(directory)).toBe(false)
  expect(install.dispatch).not.toHaveBeenCalled()
})

it('on Windows reports no obligation and holds an install with its reason, writing nothing', async () => {
  const dispatch = vi.fn()
  const install = createNativeInstallations({ directory, node: () => process.execPath, dispatch, platform: 'win32' })
  expect(await install.status('terminal', 'request', () => true)).toBeNull()
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true))
    .toEqual({ complete: false, detail: expect.stringMatching(/^opencode is not installed\. Installing engines is not supported on Windows yet/) })
  expect(dispatch).not.toHaveBeenCalled()
  expect(existsSync(directory)).toBe(false)
  expect(existsSync(`${directory}.authority`)).toBe(false)
})

it('reads installation obligations after reconstruction without creating a missing history', async () => {
  const install = controller()
  expect(await install.status('opencode', 'request', () => true)).toBeNull()
  expect(existsSync(directory)).toBe(false)
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(await controller().status('opencode', 'request', () => true)).toMatchObject({ complete: false })
  expect(await controller().status('codex', 'unrelated', () => true)).toBeNull()
  complete()
  expect(await controller().status('opencode', 'request', () => true)).toEqual({ complete: true })
  expect(await controller().status('opencode', 'new-request', () => true)).toBeNull()
  expect(install.dispatch).toHaveBeenCalledOnce()
})

it('confirms missing installation history through a stable parent alias and recovers its later result', async () => {
  const physical = join(root, 'physical'), alias = join(root, 'alias')
  mkdirSync(physical, { mode: 0o700 }); symlinkSync(physical, alias)
  directory = join(alias, 'claims')
  const install = controller()
  expect(await install.status('opencode', 'request', () => true)).toBeNull()
  expect(existsSync(directory)).toBe(false)
  await install.ensure('opencode', recipe, environment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledOnce()
  complete()
  expect(await controller().status('opencode', 'request', () => true)).toEqual({ complete: true })
})

it('does not treat a dangling authority leaf as missing through a parent alias', async () => {
  const physical = join(root, 'physical'), alias = join(root, 'alias')
  mkdirSync(physical, { mode: 0o700 }); symlinkSync(physical, alias)
  directory = join(alias, 'claims')
  symlinkSync(join(physical, 'missing-authority'), `${directory}.authority`)
  const install = controller()
  expect(await install.status('opencode', 'request', () => true)).toMatchObject({ complete: false })
  expect(existsSync(directory)).toBe(false)
  expect(install.dispatch).not.toHaveBeenCalled()
})

it('refuses a failed installation to its own request in its output\'s words, and installs again for a new one', async () => {
  const install = controller()
  await install.ensure('opencode', recipe, environment, 'failed-request', () => true)
  // What npm printed when a fresh computer could not reach its registry: the line that says what failed.
  const file = join(directory, '00000000.json'), text = readFileSync(file, 'utf8'), claim = JSON.parse(text)
  writeFileSync(`${file}.result`, JSON.stringify({ token: claim.token, claim: hash(text), code: 1, signal: null, detail: [
    'harness: engine is missing — installing it in this terminal', 'npm error code ENOTFOUND',
    'npm error network request to https://registry.npmjs.org/opencode-ai failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
    'npm error A complete log of this run can be found in: /fixture/_logs/debug-0.log',
    'harness: the install failed, so the agent was not started. The command is above; fix it and create the agent again.',
  ].join('\n') }), { mode: 0o600 })
  const failed = { complete: false, failed: true,
    detail: 'npm error network request to https://registry.npmjs.org/opencode-ai failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' }
  // Never run again for that request, across a reconstructed core, whether or not an executable appeared.
  expect(await controller().ensure('opencode', recipe, environment, 'failed-request', () => true)).toEqual(failed)
  expect(await controller().status('opencode', 'failed-request', () => true)).toEqual(failed)
  // A new request is a new attempt: an executable that is there is used, and one that is not is installed again.
  expect(await controller().status('opencode', 'new-request', () => true)).toBeNull()
  const again = controller()
  expect(await again.ensure('opencode', recipe, environment, 'new-request', () => true)).toMatchObject({ complete: false, running: true })
  expect(again.dispatch).toHaveBeenCalledOnce()
  expect(await controller().status('codex', 'unrelated-request', () => true)).toBeNull()
  expect(install.dispatch).toHaveBeenCalledOnce()
})

it('stops saying an installer whose helper never settled is installing, without ever replaying it', async () => {
  const install = controller()
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ running: true })
  expect(await controller().ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ running: true })
  expect(await controller().status('opencode', 'other', () => true)).toMatchObject({ running: true })
  // A reboot during the install: no result, ever, and the dispatch older than the helper's 20 minutes.
  const witness = `${directory}.00000000.dispatch`, past = new Date(Date.now() - 30 * 60_000)
  utimesSync(witness, past, past)
  const stale = await controller().ensure('opencode', recipe, environment, 'request', () => true)
  expect(stale).toEqual({ complete: false, detail: 'Waiting for the dispatched installer result. An uncertain dispatch is never repeated.' })
  expect(await controller().status('opencode', 'other', () => true)).not.toHaveProperty('running')
  expect(install.dispatch).toHaveBeenCalledOnce()
})

it('says how an installer that printed nothing ended', async () => {
  const install = controller()
  await install.ensure('opencode', recipe, environment, 'request', () => true)
  const file = join(directory, '00000000.json'), text = readFileSync(file, 'utf8'), claim = JSON.parse(text)
  writeFileSync(`${file}.result`, JSON.stringify({ token: claim.token, claim: hash(text), code: null, signal: 'SIGKILL' }), { mode: 0o600 })
  expect(await controller().ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ failed: true, detail: 'its installer was stopped (SIGKILL)' })
  writeFileSync(`${file}.result`, JSON.stringify({ token: claim.token, claim: hash(text), code: 2, signal: null }), { mode: 0o600 })
  expect(await controller().ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ failed: true, detail: 'its installer exited with status 2' })
})

it('retains one durable installation across duplicate requests and a reconstructed core', async () => {
  const install = controller()
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  expect(readdirSync(directory).sort()).toEqual(['00000000.json', '00000000.json.dispatch'])
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  const restarted = controller()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(restarted.dispatch).not.toHaveBeenCalled()
  complete()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toEqual({ complete: true })
  expect(restarted.dispatch).not.toHaveBeenCalled()
})

it('serializes different requests and engines while an installer owns a shared prefix', async () => {
  const first = controller(), other = controller()
  const result = await Promise.all([
    first.ensure('opencode', recipe, environment, 'one', () => true),
    other.ensure('codex', recipe, environment, 'two', () => true),
  ])
  expect(result.every(value => !value.complete)).toBe(true)
  expect(first.dispatch.mock.calls.length + other.dispatch.mock.calls.length).toBe(1)
  const claim = JSON.parse(readFileSync(join(directory, '00000000.json'), 'utf8'))
  complete()
  const engine = claim.engine === 'opencode' ? 'codex' : 'opencode'
  const request = claim.request === 'one' ? 'two' : 'one'
  expect(await other.ensure(engine, recipe, environment, request, () => true)).toMatchObject({ complete: false })
  expect(readdirSync(directory).sort()).toEqual(['00000000.json', '00000000.json.dispatch', '00000000.json.result', '00000001.json', '00000001.json.dispatch'])
})

it('never dispatches an unconfirmed claim and can recover before any publication', async () => {
  const install = controller()
  fixture.failSync = true
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(install.dispatch).not.toHaveBeenCalled()
  fixture.failSync = false
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(install.dispatch).toHaveBeenCalledTimes(1)
})

it('settles a durable non-dispatch cancellation through the ready-executable status path', async () => {
  const file = join(directory, '00000000.json')
  fixture.onSync = () => { if (existsSync(file)) fixture.failSync = true }
  const original = controller()
  await vi.waitFor(async () => {
    expect(await original.ensure('opencode', recipe, environment, 'original', () => true)).toMatchObject({ complete: false })
    expect(original.dispatch).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(true)
    expect(fixture.failSync).toBe(true)
  })
  const claimBytes = readFileSync(file, 'utf8'), claim = JSON.parse(claimBytes)
  fixture.failSync = false
  const witness = `${directory}.00000000.dispatch`
  fixture.onSync = () => { if (existsSync(witness)) fixture.failSync = true }
  const other = controller()
  // An ancestor that changes during every look is a real hold; keep each disk fault armed until its
  // stage is reached.
  fixture.onDirectoryOpen = keepChanging()
  expect(await other.ensure('codex', recipe, environment, 'other', () => true)).toMatchObject({ complete: false })
  expect(fixture.onDirectoryOpen).toBeUndefined()
  expect(existsSync(witness)).toBe(false)
  expect(fixture.failSync).toBe(false)
  expect(other.dispatch).not.toHaveBeenCalled()
  await vi.waitFor(async () => {
    expect(await other.ensure('codex', recipe, environment, 'other', () => true)).toMatchObject({ complete: false })
    expect(other.dispatch).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(witness, 'utf8'))).toEqual({ token: claim.token, claim: hash(claimBytes), kind: 'cancelled' })
    expect(fixture.failSync).toBe(true)
  })
  expect(readFileSync(file, 'utf8')).toBe(claimBytes)
  const witnessBytes = readFileSync(witness, 'utf8')
  expect(existsSync(`${file}.result`)).toBe(false)
  fixture.onSync = undefined; fixture.failSync = false
  const recovered = controller()
  await vi.waitFor(async () => {
    expect(await recovered.status('opencode', 'original', () => true)).toMatchObject({ complete: false })
    expect(JSON.parse(readFileSync(`${file}.result`, 'utf8')).notDispatched).toBe(true)
  })
  await vi.waitFor(async () => { expect(await recovered.status('opencode', 'original', () => true)).toBeNull() })
  expect(readFileSync(file, 'utf8')).toBe(claimBytes)
  expect(readFileSync(witness, 'utf8')).toBe(witnessBytes)
  expect(recovered.dispatch).not.toHaveBeenCalled()
})

it('does not replay a dispatch whose reply was lost', async () => {
  const install = controller(vi.fn(() => { throw Error('lost dispatch acknowledgement') }))
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  const restarted = controller()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  expect(restarted.dispatch).not.toHaveBeenCalled()
})

it.each(['changed owner', 'foreign result', 'failed installer', 'unsafe result', 'orphan result', 'malformed result', 'contradictory result'])('holds %s without dispatch or a false completion', async kind => {
  const install = controller()
  if (kind === 'failed installer') fixture.onDirectoryOpen = keepChanging()
  if (kind === 'failed installer') {
    expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({
      complete: false, detail: 'Waiting to confirm durable engine installation ownership.',
    })
    expect(fixture.onDirectoryOpen).toBeUndefined()
    expect(install.dispatch).not.toHaveBeenCalled()
    expect(existsSync(join(directory, '00000000.json'))).toBe(false)
  }
  // The failure injection below requires an actually dispatched fixture claim,
  // not an earlier safe hold caused by unrelated directory churn.
  await vi.waitFor(async () => {
    expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
    expect(install.dispatch).toHaveBeenCalledOnce()
  }, { timeout: 3_000 })
  const file = join(directory, '00000000.json')
  if (kind === 'changed owner') writeFileSync(file, readFileSync(file, 'utf8') + ' ')
  else if (kind === 'orphan result') writeFileSync(join(directory, '00000001.json.result'), '{}', { mode: 0o600 })
  else {
    complete(file, kind === 'failed installer' ? 1 : 0)
    if (kind === 'foreign result') writeFileSync(`${file}.result`, JSON.stringify({ token: 'different', claim: 'different', code: 0, signal: null }))
    if (kind === 'unsafe result') chmodSync(`${file}.result`, 0o666)
    if (kind === 'malformed result' || kind === 'contradictory result') {
      const value = JSON.parse(readFileSync(`${file}.result`, 'utf8'))
      value.notDispatched = kind === 'malformed result' ? 'yes' : true
      writeFileSync(`${file}.result`, JSON.stringify(value))
    }
  }
  expect(await install.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(install.dispatch).toHaveBeenCalledTimes(1)
})

it('runs only the claimed fixture installer and records completion after the core object is gone', async () => {
  const install = controller()
  await install.ensure('opencode', recipe, environment, 'request', () => true)
  const [node, file, digest] = install.dispatch.mock.calls[0] as unknown as [string, string, string]
  const code = await new Promise<number | null>((done, failed) => {
    const child = spawn(node, ['-e', NATIVE_INSTALL_WORKER, file, digest], { env: { ...process.env, ...environment }, stdio: 'pipe' })
    let error = ''; child.stderr.on('data', data => { error += data })
    child.on('error', failed)
    child.on('close', code => code === 0 ? done(code) : failed(Error(error)))
  })
  expect(code).toBe(0)
  expect(readFileSync(join(root, 'installed'), 'utf8')).toBe('one\n')
  expect(await controller().ensure('opencode', recipe, environment, 'request', () => true)).toEqual({ complete: true })
})


it('settles a known pre-dispatch cancellation so another engine can install', async () => {
  const install = controller()
  let current = true
  fixture.onSync = () => { if (existsSync(join(directory, '00000000.json'))) current = false }
  expect(await install.ensure('opencode', recipe, environment, 'cancelled', () => current)).toMatchObject({ complete: false })
  expect(install.dispatch).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(join(directory, '00000000.json.result'), 'utf8'))).toMatchObject({ notDispatched: true })
  fixture.onSync = undefined
  const later = controller()
  await later.ensure('codex', recipe, environment, 'later', () => true)
  expect(later.dispatch).toHaveBeenCalledTimes(1)
})

it.each(['missing', 'replaced', 'emptied', 'dispatch removed', 'witness removed'])('holds %s history after core reconstruction', async kind => {
  await controller().ensure('opencode', recipe, environment, 'request', () => true)
  if (kind === 'dispatch removed') unlinkSync(join(directory, '00000000.json.dispatch'))
  else if (kind === 'witness removed') unlinkSync(`${directory}.00000000.dispatch`)
  else if (kind === 'emptied') {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name))
  } else {
    renameSync(directory, `${directory}-former`)
    if (kind === 'replaced') mkdirSync(directory, { mode: 0o700 })
  }
  const restarted = controller()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(restarted.dispatch).not.toHaveBeenCalled()
})

it('keeps its history when a reboot renumbers the disk', async () => {
  await controller().ensure('opencode', recipe, environment, 'request', () => true)
  complete()
  const authority = `${directory}.authority`, saved = JSON.parse(readFileSync(authority, 'utf8'))
  writeFileSync(authority, JSON.stringify({ ...saved, directory: saved.directory.replace(/^\d+:/, '1:') }))
  const restarted = controller()
  expect(await restarted.status('opencode', 'request', () => true)).toEqual({ complete: true })
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toEqual({ complete: true })
  expect(restarted.dispatch).not.toHaveBeenCalled()
})

it('logs why a failed check holds, which the person never sees', async () => {
  await controller().ensure('opencode', recipe, environment, 'request', () => true)
  complete()
  unlinkSync(`${directory}.00000000.dispatch`)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await controller().status('codex', 'other', () => true)).toEqual({ complete: false, detail: 'Waiting to confirm durable engine installation ownership.' })
  expect(warn).toHaveBeenCalledWith('[native-install] codex held:', 'Missing installation dispatch witness')
})

it('confirms a readable result durably before crediting it or dispatching its successor', async () => {
  await controller().ensure('opencode', recipe, environment, 'request', () => true)
  complete()
  fixture.failSync = true
  const restarted = controller()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(await restarted.ensure('codex', recipe, environment, 'other', () => true)).toMatchObject({ complete: false })
  expect(restarted.dispatch).not.toHaveBeenCalled()
  fixture.failSync = false
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toEqual({ complete: true })
})

it('does not credit completion after the owner changes during result confirmation', async () => {
  await controller().ensure('opencode', recipe, environment, 'request', () => true)
  complete()
  let current = true
  fixture.onSync = () => { current = false }
  expect(await controller().ensure('opencode', recipe, environment, 'request', () => current)).toMatchObject({ complete: false })
})

it('keeps recipe and HOME snapshots across disk waits, and gives HOME a fresh evidence budget', async () => {
  const mutableRecipe = { ...structuredClone(recipe) }, mutableEnvironment = { ...environment }
  const expected = hash(JSON.stringify({ recipe: mutableRecipe, environment: mutableEnvironment }))
  let once = false
  fixture.onSync = () => {
    if (once) return
    once = true; mutableRecipe.command = 'changed'; mutableEnvironment.HOME = '/fixture/not-authorized'
    return 300
  }
  const install = controller()
  await install.ensure('opencode', mutableRecipe, mutableEnvironment, 'request', () => true)
  expect(install.dispatch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(readFileSync(join(directory, '00000000.json'), 'utf8'))).toMatchObject({ recipe: expected, environment })
})

it.each(['invalid name', 'oversized', 'relative home'])('refuses %s inputs before reserving an installation', async kind => {
  const install = controller()
  const invalid = kind === 'invalid name' ? { ...environment, 'A;false': 'x' }
    : kind === 'oversized' ? { ...environment, LARGE: 'x'.repeat(262144) } : { ...environment, HOME: 'relative' }
  expect(await install.ensure('opencode', recipe, invalid, 'request', () => true)).toMatchObject({ complete: false })
  expect(existsSync(directory)).toBe(false)
  expect(install.dispatch).not.toHaveBeenCalled()
})


it('does not rewrite an in-place result change during confirmation', async () => {
  await controller().ensure('opencode', recipe, environment, 'request', () => true)
  complete()
  const file = join(directory, '00000000.json.result')
  let changed = false
  fixture.onSync = () => {
    if (changed) return
    changed = true
    const value = JSON.parse(readFileSync(file, 'utf8')); value.code = 1
    writeFileSync(file, JSON.stringify(value))
  }
  const restarted = controller()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(JSON.parse(readFileSync(file, 'utf8')).code).toBe(1)
  fixture.onSync = undefined
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(restarted.dispatch).not.toHaveBeenCalled()
})


it('lets one of two independent recovering cores own an immutable outside dispatch slot', async () => {
  const first = controller()
  let delayed = false
  fixture.onSync = () => {
    if (delayed || !existsSync(join(directory, '00000000.json'))) return
    delayed = true
    return 1000
  }
  const initial = first.ensure('opencode', recipe, environment, 'request', () => true)
  for (let n = 0; n < 200 && !delayed; n++) await new Promise(done => setTimeout(done, 5))
  expect(delayed).toBe(true)
  // Separate module state models another core's independent disk reservations.
  vi.resetModules()
  const { createNativeInstallations: recoveredController } = await import('./nativeInstall.js')
  const dispatch = vi.fn()
  const recovered = recoveredController({ directory, node: () => process.execPath, dispatch })
  await recovered.ensure('opencode', recipe, environment, 'request', () => true)
  expect(dispatch).toHaveBeenCalledTimes(1)
  const saved = readFileSync(`${directory}.00000000.dispatch`, 'utf8')
  await initial
  expect(first.dispatch).not.toHaveBeenCalled()
  expect(readFileSync(`${directory}.00000000.dispatch`, 'utf8')).toBe(saved)
})

it('preserves a changed pending claim instead of confirming stale bytes', async () => {
  const file = join(directory, '00000000.json')
  fixture.onSync = () => { if (existsSync(file)) fixture.failSync = true }
  const original = controller()
  await original.ensure('opencode', recipe, environment, 'request', () => true)
  expect(existsSync(file)).toBe(true)
  expect(original.dispatch).not.toHaveBeenCalled()
  fixture.failSync = false
  let changed = false, expected = ''
  fixture.onSync = () => {
    if (changed) return
    changed = true; expected = readFileSync(file, 'utf8') + ' '
    writeFileSync(file, expected)
  }
  const restarted = controller()
  expect(await restarted.ensure('opencode', recipe, environment, 'request', () => true)).toMatchObject({ complete: false })
  expect(changed).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(expected)
  expect(restarted.dispatch).not.toHaveBeenCalled()
  expect(existsSync(`${directory}.00000000.dispatch`)).toBe(false)
})

it('holds oversized installation history without replaying or changing saved records', async () => {
  const install = controller()
  await install.ensure('opencode', recipe, environment, 'request', () => true)
  const original = readFileSync(join(directory, '00000000.json'), 'utf8')
  for (let index = 1; index <= 128; index++) writeFileSync(join(directory, `${String(index).padStart(8, '0')}.json`), original, { mode: 0o600 })
  install.dispatch.mockClear()
  const result = await install.ensure('opencode', recipe, environment, 'request', () => true)
  expect(result).toMatchObject({ complete: false, detail: expect.stringContaining('automatic recovery limit') })
  expect(install.dispatch).not.toHaveBeenCalled()
  expect(readFileSync(join(directory, '00000000.json'), 'utf8')).toBe(original)
})
