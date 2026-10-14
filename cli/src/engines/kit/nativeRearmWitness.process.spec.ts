/** Real shell/standalone writer checks use only owned child processes, a private
 * tmux socket and disposable homes. No daemon or installed engine is contacted. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildNativeHook } from '../../../scripts/lib/nativeHookBundle.mjs'
import { env } from '../../config/env.js'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { HARNESS_OWNER_OPTION, harnessPaneOwner, ownerCommand } from '../../lib/harnessSessionLabel.js'
import { AgentCreationReceipts, creationFingerprint } from '../../lib/agentCreationReceipt.js'
import { buildEngineLaunchArgv } from '../../lib/engineLaunch.js'
import { NATIVE_PANE_ALLOCATION_OPTION } from '../../lib/nativePaneAllocation.js'
import { nativeRearmRequest, nativeTurnTarget, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import { prepareProcessImageHelper, type ProcessImageArtifact } from '../../lib/nativeProcessImageArtifact.js'
import { probeNativeProcessControl, type NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { readProcessEvidence } from '../../lib/processEvidence.js'
import { isolatedTmux, type IsolatedTmux } from '../../testing/isolatedTmux.js'
import type { NativeLaunch } from '../nativeLaunch.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'
import { nativeHookScope } from './nativeHookScope.js'
import type { HookPreparationProof } from './nativeHookFiles.js'
import { nativeRearmExecCommand, prepareNativeRearmWitness, type NativeRearmWitnessCommand } from './nativeRearmWitness.js'
import { createNativeRearmProof } from './nativeRearmProof.js'
import { closeNativeStopPane, createNativePhysicalStop, type NativePhysicalStopOwner } from './nativePhysicalStop.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { executableSnapshot, nativeVersionProbe } from './nativeVersion.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'

const artifactPath = process.env.HARNESS_PROCESS_IMAGES_ARTIFACT
const supported = process.platform === 'linux' || process.platform === 'darwin' && !!artifactPath
const originalRuntime = env.ADAPTER_RUNTIME_DIR
const originalData = env.ADAPTER_DATA_DIR
let root: string, artifact: string, images: ProcessImageArtifact | undefined, tmux: IsolatedTmux | undefined
const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<void> }> = []
let sequence = 0
const lifetimes: Array<{ path: string; marker: string }> = []
beforeAll(async () => {
  if (process.platform === 'darwin' && process.env.HARNESS_REQUIRE_PROCESS_IMAGES === '1' && !artifactPath) throw Error('Pinned process image artifact required')
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-rearm-process-')))
  mkdirSync(join(root, 'package'), { mode: 0o700 }); mkdirSync(join(root, 'home'), { mode: 0o700 }); mkdirSync(join(root, 'tmux'), { mode: 0o700 })
  const source = artifactPath ? readFileSync(artifactPath, 'utf8') : undefined
  images = source ? JSON.parse(source) : undefined
  await buildNativeHook({ outDir: join(root, 'package'), version: 'fixture', processImages: source })
  artifact = join(root, 'package', 'notify.mjs')
})
afterEach(async () => {
  // A failed assertion must not skip other fixture cleanup. Remove every owned
  // lifetime first, then always close the private server and direct children.
  const failures: unknown[] = [], pending = lifetimes.splice(0)
  const pids: number[] = []
  for (const lifetime of pending) {
    try { if (existsSync(lifetime.marker)) pids.push(JSON.parse(readFileSync(lifetime.marker, 'utf8')).pid) }
    catch (error) { failures.push(error) }
    try { rmSync(lifetime.path, { force: true }) } catch (error) { failures.push(error) }
  }
  try {
    for (const pid of pids) {
      try { await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 }) }
      catch (error) { failures.push(error) }
    }
  } finally {
    try { await tmux?.close() } catch (error) { failures.push(error) }
    finally {
      tmux = undefined
      for (const { child, closed } of children.splice(0)) {
        try {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
          }
          await closed
        } catch (error) { failures.push(error) }
      }
      vi.unstubAllEnvs(); vi.unstubAllGlobals()
      env.ADAPTER_RUNTIME_DIR = originalRuntime; env.ADAPTER_DATA_DIR = originalData
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Private native fixture cleanup failed')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
function environment(directory: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, 'home'), ZDOTDIR: join(root, 'home'), ADAPTER_DATA_DIR: directory,
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), HARNESS_HOOK_ROUTES_DIR: join(root, 'routes'), TMUX_TMPDIR: join(root, 'tmux'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TZ: 'UTC', TMPDIR: '/tmp' }
  delete env.TMUX; delete env.TMUX_PANE; delete env.NODE_OPTIONS; delete env.BASH_ENV; delete env.ENV
  return env
}
function start(script: string, directory: string, args: string[] = []) {
  const child = spawn('/bin/sh', ['-c', script, 'fixture', ...args], { env: environment(directory), cwd: directory,
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', stdout = '', code: number | null | undefined, signal: NodeJS.Signals | null | undefined
  child.stderr!.on('data', bytes => { stderr += bytes }); child.stdout!.on('data', bytes => { stdout += bytes })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (value, stopped) => { code = value; signal = stopped; resolve() })
  })
  children.push({ child, closed })
  return { child, closed, output: () => ({ stdout, stderr, code, signal }) }
}
async function fixture(hold = false, spaced = false, originalPane = '%1', source: 'live' | 'saved' = 'live', exitsWithTerminal = false) {
  const directory = join(root, `case-${++sequence}${spaced ? ' with spaces' : ''}`); mkdirSync(directory, { mode: 0o700 })
  const id = `private-rearm-request-${sequence}`, agentId = `fixture-agent-${sequence}`, token = `private-launch-token-${sequence}`
  const saved = { schemaVersion: 3, agentId, registeredAt: 1, engine: 'cursor', sessionId: 'fixture-session', boundAt: 2, active: source === 'live',
    processIdentity: { pid: 41, executable: '/fixture/cursor', startMarker: 'fixture-birth' }, runtimes: [{ backend: 'tmux', paneId: originalPane }],
    primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: originalPane }), tmuxPane: originalPane, cwd: directory, transcriptPath: null } as RegisteredSession
  const target = nativeTurnTarget(saved)
  const control: NativeTurnIntent = { version: 1, cancel: { processKey: null, target, request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId, conversationId: saved.sessionId, frontier: { index: -1, digest: null },
  } }, rearm: { requestId: id, agentId, operation: source === 'live' ? 'restart' : 'resume', launchToken: token, target, source,
    sourceProcess: { processKey: null } } }
  if (source === 'saved') {
    mkdirSync(join(directory, 'stopped-agents'), { mode: 0o700 })
    writeFileSync(join(directory, 'stopped-agents', `${agentId}.json`), JSON.stringify({ version: 1, session: { ...saved, nativeControl: control } }), { mode: 0o600 })
  } else writeFileSync(join(directory, 'registry.json'), JSON.stringify([{ ...saved, nativeControl: control }]), { mode: 0o600 })
  const request = nativeRearmRequest(control)!, fingerprint = creationFingerprint(request)
  const receipts = new AgentCreationReceipts(join(directory, 'agent-creations'))
  await receipts.runIntent(id, fingerprint, request, { service: 'native', detail: 'fixture' }, async () => async () => ({ state: 'unconfirmed' }))
  const marker = join(directory, 'engine.json'), resumed = join(directory, 'continued'), engine = join(directory, 'cursor-agent')
  const gate = join(directory, 'exec-allowed'), waiting = join(directory, 'waiting'), alive = join(directory, 'fixture-alive')
  writeFileSync(alive, 'alive'); lifetimes.push({ path: alive, marker })
  const main = hold ? join(directory, 'cursor-agent-package', 'cursor-agent', 'versions', '1', 'index.js') : engine
  if (hold) mkdirSync(join(directory, 'cursor-agent-package', 'cursor-agent', 'versions', '1'), { recursive: true })
  writeFileSync(main, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));process.on('SIGCONT',()=>fs.writeFileSync(${JSON.stringify(resumed)},'continued'));${exitsWithTerminal ? "process.on('SIGHUP',()=>process.exit(0));process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));process.stdin.resume();" : "process.on('SIGHUP',()=>{});"}setInterval(()=>{if(!fs.existsSync(${JSON.stringify(alive)}))process.exit(0)},50);\n`, { mode: 0o700 })
  if (hold) writeFileSync(engine, '#!/bin/bash -p\n' + `printf '%s' $$ > ${shellSingleQuote(waiting)}\n`
    + `while [ ! -f ${shellSingleQuote(gate)} ]; do /bin/sleep 0.05; done\n`
    + `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(main)} "$@"\n`, { mode: 0o700 })
  const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 100 }, () => engine))!
  const proofs: HookPreparationProof[] = []
  const launch: NativeLaunch = { token, executable, opencodeMajor: null, environment: {}, proofs, current: () => executable.current() && proofs.every(p => p.current()),
    ready: () => true, retain: proof => { proofs.push(proof); return true }, prepareHooks: async () => true, permission: async () => 'supported' }
  const input = { version: 1 as const, dataDir: directory, source, id, fingerprint, request, control }
  const command = prepareNativeRearmWitness(launch, input, process.execPath, pathToFileURL(join(root, 'package', 'cli.js')).href)
  const run = (text = nativeRearmExecCommand(command)) => start(`harness_engine_bin=${shellSingleQuote(engine)}\n${text}`, directory, ['literal one', "quote' two"])
  const helpers: NativeControlHelpers = { prepare: async () => {
    if (!images) return null
    const path = await prepareProcessImageHelper(images, join(directory, 'probe-runtime'))
    return path ? { path, key: images.sha256 } : null
  }, invalidate: () => {} }
  return { directory, input, receipts, marker, engine, launch, command, run, helpers, resumed, saved, control, gate, waiting }
}

async function paneLaunch(p: Awaited<ReturnType<typeof fixture>>, shell = '/bin/sh', wrapped = false) {
  tmux = await isolatedTmux(environment(p.directory))
  tmux.env.HOME = join(root, 'home'); tmux.env.ZDOTDIR = join(root, 'home')
  vi.stubEnv('TMUX', undefined); vi.stubEnv('TMUX_PANE', undefined); vi.stubEnv('TMUX_TMPDIR', tmux.root)
  vi.stubEnv('HOME', join(root, 'home')); vi.stubEnv('ZDOTDIR', join(root, 'home'))
  env.ADAPTER_RUNTIME_DIR = join(p.directory, 'probe-runtime')
  env.ADAPTER_DATA_DIR = p.directory
  if (images) vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(images))
  const owner = harnessPaneOwner(p.directory)
  const argv = buildEngineLaunchArgv('cursor', { native: p.launch }, shell, process.execPath, '/fixture/grid', resolveBinaryOnPath('tmux'))
  await tmux.run('new-session', '-d', '-s', 'fixture-rearm', ...(wrapped ? ownerCommand(owner, argv) : argv),
    ';', 'set-option', '-p', HARNESS_OWNER_OPTION, owner)
  return tmux.run('display-message', '-p', '-t', 'fixture-rearm', '#{pane_id}')
}

async function replacement(p: Awaited<ReturnType<typeof fixture>>, pane: string, pid: number) {
  const observed = (await readProcessEvidence(pid, new NativeEvidenceBudget())).parent!
  const row: RegisteredSession = { ...p.saved, nativeControl: p.control, tmuxPane: pane, primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: pane }),
    runtimes: [{ backend: 'tmux', paneId: pane }], processIdentity: { pid, executable: observed.executable,
      startMarker: observed.startMarker, ...(observed.startTicks !== undefined ? { startTicks: observed.startTicks } : {}) } }
  const path = join(p.directory, 'registry.json'), image = JSON.stringify([row])
  writeFileSync(path, image, { mode: 0o600 })
  const verify = () => { if (readFileSync(path, 'utf8') !== image) throw Error('private binding changed') }
  const read = createNativeRearmProof({ receipts: p.receipts, owner: harnessPaneOwner(p.directory) })
  return { row, prove: () => read(row, p.input, { verify, current: verify }) }
}

it.skipIf(!supported)('the shipped writer preserves boot/PID/precise birth through exec and refuses replay', async () => {
  const p = await fixture(), first = p.run()
  await vi.waitFor(() => expect(existsSync(p.marker), first.output().stderr).toBe(true), { timeout: 8000 })
  const engine = JSON.parse(readFileSync(p.marker, 'utf8'))
  expect(engine.args).toEqual(['literal one', "quote' two"])
  const witness = p.receipts.readNativeRelaunchProcess(p.input.id, p.input).process
  expect(witness.boot).toBe(await kernelBootId(new NativeEvidenceBudget()))
  expect(witness.pid).toBe(engine.pid)
  const scope = await nativeHookScope(join(p.directory, 'agent-creations'), new NativeEvidenceBudget(), p.helpers)
  try { expect(witness.namespace).toBe(scope.namespace) } finally { scope.close() }
  const row = (await probeNativeProcessControl([engine.pid], 0, new NativeEvidenceBudget(), false, p.helpers)).rows.get(engine.pid)!
  expect(row.birth).toBe(witness.birth)
  const replay = p.run()
  await vi.waitFor(() => expect(replay.output().stderr).toContain('Waiting for the original native relaunch record'), { timeout: 8000 })
  expect(JSON.parse(readFileSync(p.marker, 'utf8')).pid).toBe(engine.pid)
  expect(p.receipts.status(p.input.id)).toEqual({ state: 'unconfirmed' })
}, 20000)

it.skipIf(!supported)('the existing top-level wrapper resumes the witnessed engine after a real Stop', async () => {
  const p = await fixture()
  const pane = await paneLaunch(p)
  try { await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 }) }
  catch (error) { console.log(await tmux!.run('capture-pane', '-p', '-t', 'fixture-rearm')); throw error }
  const pid = JSON.parse(readFileSync(p.marker, 'utf8')).pid
  const rootPid = await tmux!.run('display-message', '-p', '-t', pane, '#{pane_pid}')
  expect(await tmux!.run('display-message', '-p', '-t', pane, `#{${NATIVE_PANE_ALLOCATION_OPTION}}`)).toBe(`active:${p.launch.token}:${rootPid}`)
  expect(existsSync(join(p.directory, 'agent-creations', `${p.input.id}.json.process`))).toBe(true)
  expect(p.receipts.readNativeRelaunchProcess(p.input.id, p.input).process.pid).toBe(pid)
  const allocation = p.receipts.readNativeRelaunchProcess(p.input.id, p.input).process.allocation
  expect(allocation).toMatchObject({ pane, rootPid: Number(rootPid), token: p.launch.token, owner: harnessPaneOwner(p.directory),
    endpoint: { binary: realpathSync(resolveBinaryOnPath('tmux')!), socket: tmux!.socket } })
  const candidate = await replacement(p, pane, pid)
  expect((await candidate.prove()).key).toContain(`\0${pid}\0`)
  process.kill(pid, 'SIGSTOP')
  await vi.waitFor(() => expect(existsSync(p.resumed)).toBe(true), { timeout: 8000 })
  expect(JSON.parse(readFileSync(p.marker, 'utf8')).pid).toBe(pid)
  expect((await candidate.prove()).key).toContain(`\0${pid}\0`)
}, 20000)

for (const mode of ['active', 'released', 'lost-close-reply', 'detached-survivor'] as const) {
  it.skipIf(!supported)(`physical Stop accounts the original witnessed engine and ${mode} allocation on a private server`, async () => {
    const p = await fixture(false, false, '%1', 'live', mode !== 'detached-survivor'), pane = await paneLaunch(p)
    await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 })
    const receipt = p.receipts.readNativeRelaunchProcess(p.input.id, p.input), witness = receipt.process
    expect(witness.namespace).toBeTypeOf('string')
    const rootPid = Number(await tmux!.run('display-message', '-p', '-t', pane, '#{pane_pid}'))
    const serverPid = Number(await tmux!.run('display-message', '-p', '#{pid}'))
    const server = (await probeNativeProcessControl([serverPid], 0, new NativeEvidenceBudget(), false, p.helpers)).rows.get(serverPid)!
    expect(witness.allocation).toMatchObject({ pane, rootPid, token: p.launch.token, owner: harnessPaneOwner(p.directory),
      endpoint: { binary: realpathSync(resolveBinaryOnPath('tmux')!), socket: tmux!.socket,
        server: { boot: witness.boot, namespace: witness.namespace!, pid: serverPid, birth: server.birth } } })
    const row = { ...p.saved, nativeControl: { ...p.control, rearm: { ...p.control.rearm!, revoked: true as const } } }
    const file = join(p.directory, 'registry.json'), image = JSON.stringify([row])
    writeFileSync(file, image, { mode: 0o600 })
    const owner: NativePhysicalStopOwner = {
      budget: new NativeEvidenceBudget(3000, 320),
      source: { target: nativeTurnTarget(row), controlFingerprint: creationFingerprint(row.nativeControl) },
      engines: [{ ...witness, namespace: witness.namespace! }],
      allocations: [witness.allocation!],
      verify: () => { if (readFileSync(file, 'utf8') !== image) throw Error('original Stop source changed') },
      verifyAllocations: receipt.verify, current: () => {},
    }
    if (mode === 'released') {
      process.kill(witness.pid, 'SIGTERM')
      await vi.waitFor(async () => expect(await tmux!.run('display-message', '-p', '-t', pane,
        `#{${NATIVE_PANE_ALLOCATION_OPTION}}`)).toBe(`released:${p.launch.token}:${rootPid}`), { timeout: 4000 })
    }
    const observedPane = (await tmux!.run('display-message', '-p', '-t', pane,
      `#{pid}\n#{pane_id}\n#{pane_pid}\n#{${HARNESS_OWNER_OPTION}}\n#{${NATIVE_PANE_ALLOCATION_OPTION}}\n#{pane_start_command}`)).split('\n')
    expect(observedPane.slice(0, 5)).toEqual([String(serverPid), pane, String(rootPid), harnessPaneOwner(p.directory),
      `${mode === 'released' ? 'released' : 'active'}:${p.launch.token}:${rootPid}`])
    expect(observedPane.slice(5).join('\n').startsWith(`/usr/bin/env HARNESS_NATIVE_LAUNCH_TOKEN=${p.launch.token} `)).toBe(true)
    let lostReply = mode === 'lost-close-reply'
    const closePane = vi.fn(async (...args: Parameters<typeof closeNativeStopPane>) => {
      await closeNativeStopPane(...args)
      if (lostReply) { lostReply = false; throw Error('fixture lost close reply') }
    })
    const stop = createNativePhysicalStop({ roots: [p.directory, join(p.directory, 'agent-creations')], helpers: p.helpers, closePane })
    const consume = vi.fn(proof => {
      proof.verifyStopped()
      // The real Registry owns this intentional leaf transition separately.
      // Physical receipt/scope authority must remain valid across it.
      writeFileSync(file, '[]', { mode: 0o600 })
      proof.verifyStopped(); proof.current()
      return 'retired'
    })
    const first = await stop(owner, consume).then(value => value, error => error as Error)
    if (mode === 'lost-close-reply') {
      expect(first).toBeInstanceOf(Error); expect((first as Error).message).toContain('fixture lost close reply')
      expect(consume).not.toHaveBeenCalled()
    } else if (first instanceof Error) {
      // tmux may acknowledge its close before the child actually exits. That
      // outcome must remain held, then acquire fresh evidence on a later request.
      expect(first.message).toContain('original engine is still running')
      expect(consume).not.toHaveBeenCalled()
    }
    if (mode === 'detached-survivor') {
      expect(first).toBeInstanceOf(Error); expect((first as Error).message).toContain('original engine is still running')
      expect(consume).not.toHaveBeenCalled(); expect(closePane).toHaveBeenCalledOnce()
      expect(() => process.kill(witness.pid, 0)).not.toThrow()
      expect(readFileSync(file, 'utf8')).toBe(image)
      stop.close(); return
    }
    await vi.waitFor(() => expect(() => process.kill(witness.pid, 0)).toThrow(), { timeout: 5000 })
    if (first instanceof Error) await expect(stop(owner, consume)).resolves.toBe('retired')
    else expect(first).toBe('retired')
    expect(consume).toHaveBeenCalledOnce()
    expect(closePane).toHaveBeenCalledTimes(mode === 'released' ? 0 : 1)
    if (mode === 'released') {
      expect(await tmux!.run('display-message', '-p', '-t', pane, '#{pane_pid}')).toBe(String(rootPid))
      expect(() => process.kill(rootPid, 0)).not.toThrow()
    }
    stop.close()
  }, 20000)
}

it.skipIf(!supported)('recovers the witnessed engine while its source still records the old process', async () => {
  const p = await fixture(false, false, '%0'), pane = await paneLaunch(p)
  expect(pane).toBe(p.saved.tmuxPane)
  await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 })
  const pid = JSON.parse(readFileSync(p.marker, 'utf8')).pid
  const file = join(p.directory, 'registry.json'), before = readFileSync(file, 'utf8')
  const source = { ...p.saved, nativeControl: p.control }
  const verify = () => { if (readFileSync(file, 'utf8') !== before) throw Error('original source changed') }
  const read = createNativeRearmProof({ receipts: p.receipts, owner: harnessPaneOwner(p.directory) })
  const proof = await read.recover(source, p.input, { verify, current: verify }, pane)
  expect(proof.processIdentity.pid).toBe(pid)
  expect(proof.key).toContain(`\0${pid}\0`)
  expect(source.processIdentity?.pid).toBe(41)
  expect(readFileSync(file, 'utf8')).toBe(before)
  proof.verify()
}, 20000)

it.skipIf(!supported)('finds the original saved Resume allocation without trusting its historical pane', async () => {
  const p = await fixture(false, false, '%999', 'saved'), pane = await paneLaunch(p, '/bin/sh', true)
  expect(pane).not.toBe(p.saved.tmuxPane)
  await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 })
  const pid = JSON.parse(readFileSync(p.marker, 'utf8')).pid
  const file = join(p.directory, 'stopped-agents', `${p.saved.agentId}.json`), before = readFileSync(file, 'utf8')
  const source = { ...p.saved, nativeControl: p.control }
  const verify = () => { if (readFileSync(file, 'utf8') !== before) throw Error('original saved source changed') }
  const read = createNativeRearmProof({ receipts: p.receipts, owner: harnessPaneOwner(p.directory) })
  const proof = await read.recoverSaved(source, p.input, { verify, current: verify })
  expect(proof.pane).toBe(pane); expect(proof.processIdentity.pid).toBe(pid)
  expect(source.processIdentity?.pid).toBe(41)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(existsSync(join(p.directory, 'registry.json'))).toBe(false)
  proof.verify()
}, 20000)

it.skipIf(!supported)('a witnessed pre-exec shell in a spaced path holds until that same process executes the engine', async () => {
  const p = await fixture(true, true), pane = await paneLaunch(p, '/bin/sh', true)
  await vi.waitFor(() => expect(existsSync(p.waiting)).toBe(true), { timeout: 8000 })
  const pid = Number(readFileSync(p.waiting, 'utf8')), waiting = await replacement(p, pane, pid)
  await expect(waiting.prove()).rejects.toThrow('current Cursor image could not be proven')
  writeFileSync(p.gate, '')
  await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 })
  expect(JSON.parse(readFileSync(p.marker, 'utf8')).pid).toBe(pid)
  const started = await replacement(p, pane, pid)
  expect((await started.prove()).key).toContain(`\0${pid}\0`)
}, 20000)

for (const name of ['sh', 'bash', 'zsh', 'dash', 'tcsh']) {
  const binary = resolveBinaryOnPath(name)
  it.skipIf(!supported || !binary)(`${name} keeps the witnessed engine as the original pane child`, async () => {
    const p = await fixture(), pane = await paneLaunch(p, binary!)
    await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 })
    const pid = JSON.parse(readFileSync(p.marker, 'utf8')).pid
    const candidate = await replacement(p, pane, pid)
    expect((await candidate.prove()).key).toContain(`\0${pid}\0`)
  }, 15000)
}

it.skipIf(!supported)('an exited witness cannot be adopted by a manually started replacement', async () => {
  const p = await fixture(), pane = await paneLaunch(p)
  await vi.waitFor(() => expect(existsSync(p.marker)).toBe(true), { timeout: 8000 })
  const pid = JSON.parse(readFileSync(p.marker, 'utf8')).pid, original = await replacement(p, pane, pid)
  const rootPid = await tmux!.run('display-message', '-p', '-t', pane, '#{pane_pid}')
  await original.prove()
  process.kill(pid, 'SIGTERM')
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
  await vi.waitFor(async () => expect(await tmux!.run('display-message', '-p', '-t', pane,
    `#{${NATIVE_PANE_ALLOCATION_OPTION}}`)).toBe(`released:${p.launch.token}:${rootPid}`), { timeout: 4000 })
  await expect(original.prove()).rejects.toThrow()
  await tmux!.run('respawn-pane', '-k', '-t', pane, process.execPath, p.engine)
  await vi.waitFor(() => expect(JSON.parse(readFileSync(p.marker, 'utf8')).pid).not.toBe(pid), { timeout: 8000 })
  const manual = await replacement(p, pane, JSON.parse(readFileSync(p.marker, 'utf8')).pid)
  await expect(manual.prove()).rejects.toThrow('process differs from the recorded exec')
}, 25000)

it.skipIf(!supported)('the fixed handoff ignores inherited startup files and exported functions', async () => {
  const p = await fixture(), startup = join(p.directory, 'startup.sh'), marker = join(p.directory, 'inherited-code')
  writeFileSync(startup, `/usr/bin/touch ${shellSingleQuote(marker)}\nexit 0\n`)
  const inherited = `BASH_FUNC_exec%%=() { /usr/bin/touch ${shellSingleQuote(marker)}; }`
  const child = p.run(`BASH_ENV=${shellSingleQuote(startup)}; ENV=${shellSingleQuote(startup)}; export BASH_ENV ENV\n`
    + `env ${shellSingleQuote(inherited)} ${nativeRearmExecCommand(p.command)}`)
  await vi.waitFor(() => expect(existsSync(p.marker), child.output().stderr).toBe(true), { timeout: 8000 })
  expect(existsSync(marker)).toBe(false)
  expect(p.receipts.readNativeRelaunchProcess(p.input.id, p.input).process.pid).toBe(JSON.parse(readFileSync(p.marker, 'utf8')).pid)
}, 15000)

it.skipIf(!supported)('launch wiring refuses a different engine or reservation token', async () => {
  const p = await fixture()
  expect(() => buildEngineLaunchArgv('codex', { native: p.launch }, '/bin/sh', process.execPath, '/fixture/grid', null)).toThrow()
  p.launch.rearmWitness = { ...p.command, token: 'another-reservation-token' }
  expect(() => buildEngineLaunchArgv('cursor', { native: p.launch }, '/bin/sh', process.execPath, '/fixture/grid', null)).toThrow()
})

it.each(['failure', 'killed', 'before-reset', 'after-reset'] as const)('a %s writer cannot pass the exec handoff', async failure => {
  const directory = join(root, `shell-${++sequence}`); mkdirSync(directory, { mode: 0o700 })
  const writer = join(directory, 'writer.js'), marker = join(directory, 'executed')
  writeFileSync(writer, failure === 'killed' ? "process.kill(process.pid,'SIGKILL')" : failure === 'failure' ? 'process.exitCode=75' : '')
  const command: NativeRearmWitnessCommand = { token: 'private-launch-token', node: process.execPath, artifact: writer, request: '{}' }
  let text = nativeRearmExecCommand(command)
  // Inject a signal at the exact handoff edge; an old check-before-reset would
  // observe zero, catch the signal afterwards, then incorrectly execute.
  if (failure === 'before-reset') text = text.replace('trap - INT QUIT HUP TERM\n', () => 'kill -INT $$\ntrap - INT QUIT HUP TERM\n')
  if (failure === 'after-reset') text = text.replace('trap - INT QUIT HUP TERM\n', () => 'trap - INT QUIT HUP TERM\nkill -TERM $$\n')
  const child = start(`harness_engine_bin=/usr/bin/touch\n${text}`, directory, [marker])
  await vi.waitFor(() => {
    if (failure === 'after-reset') expect(child.output().code ?? child.output().signal).toBeTruthy()
    else expect(child.output().stderr).toContain('Waiting for the original native relaunch record')
  }, { timeout: 5000 })
  expect(existsSync(marker)).toBe(false)
}, 10000)

it('an invalid writer invocation is held and cannot inherit ordinary hook no-op success', async () => {
  const child = start(`${shellSingleQuote(process.execPath)} ${shellSingleQuote(artifact)} --native-rearm-witness '{}' 1`, root)
  await child.closed
  expect(child.output()).toMatchObject({ stdout: '', code: 75 })
})
