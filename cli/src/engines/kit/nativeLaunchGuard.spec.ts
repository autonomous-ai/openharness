import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { NativeLaunch } from '../nativeLaunch.js'
import { nativeLaunchGuard } from './nativeLaunchGuard.js'
import { inspectHookFile, runHookPreparation, type HookPreparationProof } from './nativeHookFiles.js'
import { executableSnapshot, nativeVersionProbe } from './nativeVersion.js'

let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-guard-'))) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function prepared(file = join(root, "settings with ' quotes")) {
  const command = join(root, 'engine')
  writeFileSync(command, '#!/bin/sh\nprintf engine\n'); chmodSync(command, 0o700)
  const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 100 }, () => command))!
  const proofs: HookPreparationProof[] = []
  await runHookPreparation([file], attempt => inspectHookFile(file).replace('hooks', attempt), { confirmed: proof => proofs.push(proof) })
  const launch: NativeLaunch = { executable, proofs, opencodeMajor: null, environment: {},
    current: () => executable.current() && proofs.every(proof => proof.current()), ready: () => true,
    prepareHooks: async () => true, permission: async () => 'supported' }
  const run = () => execFileSync('/bin/sh', ['-c', nativeLaunchGuard(launch, process.execPath, 'printf held; exit 0') + 'printf ready'], { encoding: 'utf8', timeout: 5_000 })
  return { command, file, run }
}

it('checks the prepared executable and durable hook files after shell startup', async () => {
  const p = await prepared()
  expect(p.run()).toBe('ready')
  writeFileSync(p.command, '#!/bin/sh\nprintf replacement\n')
  expect(p.run()).toBe('held')
})

it('holds changed hook contents without executing an engine', async () => {
  const p = await prepared()
  writeFileSync(p.file, 'foreign hooks')
  expect(p.run()).toBe('held')
})

it('holds a redirected settings alias even when both files have matching contents', async () => {
  const first = join(root, 'first'), second = join(root, 'second'), alias = join(root, 'alias')
  writeFileSync(first, 'hooks'); writeFileSync(second, 'hooks'); symlinkSync(first, alias)
  const p = await prepared(alias)
  expect(p.run()).toBe('ready')
  unlinkSync(alias); symlinkSync(second, alias)
  expect(p.run()).toBe('held')
})

it('adds no guard for a terminal without a native executable', () => {
  expect(nativeLaunchGuard({} as NativeLaunch, process.execPath, 'exit 1')).toBe('')
})

it('holds an inspected executable that never completed native preparation', async () => {
  const p = await prepared()
  const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 100 }, () => p.command))!
  const unprepared = { executable, proofs: [], ready: () => false } as unknown as NativeLaunch
  const output = execFileSync('/bin/sh', ['-c', nativeLaunchGuard(unprepared, process.execPath, 'printf held; exit 0') + 'printf ready'], { encoding: 'utf8', timeout: 5_000 })
  expect(output).toBe('held')
})
