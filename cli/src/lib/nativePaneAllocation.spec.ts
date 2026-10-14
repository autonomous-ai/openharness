/** Only private tmux sockets, disposable homes and owned fixture processes. */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { engineFallbackPrelude } from './engineLaunch.js'
import { HARNESS_OWNER_OPTION } from './harnessSessionLabel.js'
import { NATIVE_PANE_ALLOCATION_OPTION, nativePaneAllocationArgs, nativePaneAllocationScript, type NativePaneAllocation } from './nativePaneAllocation.js'
import { NATIVE_LAUNCH_MARKER } from './nativePaneHold.js'
import { shellSingleQuote } from './shellQuote.js'

const binary = resolveBinaryOnPath('tmux'), owner = 'd00df00dd00df00d'
it.each([{ pane: 'not-a-pane' }, { pane: '%1; kill-server' }, { rootPid: 1 }, { rootPid: 2 ** 32 },
  { token: 'invalid' }, { token: 'a'.repeat(97) }, { owner: 'foreign' }])('rejects malformed allocation identity %#', fields => {
  expect(() => nativePaneAllocationArgs('close', { pane: '%1', rootPid: 42, token: 'a'.repeat(32), owner, ...fields })).toThrow()
})
it.each([null, 'relative-tmux'])('holds without a confirmed absolute tmux binary: %s', tmux => {
  expect(nativePaneAllocationScript('claim', 'a'.repeat(32), tmux, '/fixture/node', owner, 'exec /fixture/held')).toBe('exec /fixture/held\n')
})

describe.skipIf(!binary)('native allocation ownership on a private tmux server', () => {
  let tmux: IsolatedTmux
  beforeEach(async () => {
    tmux = await isolatedTmux()
    tmux.env.HOME = tmux.root; tmux.env.ZDOTDIR = tmux.root
    delete tmux.env.BASH_ENV; delete tmux.env.ENV; delete tmux.env.NODE_OPTIONS
    vi.stubEnv('HOME', tmux.root); vi.stubEnv('ZDOTDIR', tmux.root)
    vi.stubEnv('TMUX', undefined); vi.stubEnv('TMUX_PANE', undefined); vi.stubEnv('TMUX_TMPDIR', tmux.root)
    await tmux.run('new-session', '-d', '-s', 'fixture-anchor', '/bin/sleep', '300')
  })
  afterEach(async () => { await tmux.close(); vi.unstubAllEnvs() })
  const mark = (allocation: NativePaneAllocation) => tmux.run('show-options', '-p', '-v', '-t', allocation.pane, NATIVE_PANE_ALLOCATION_OPTION)
  const start = async (mode: 'normal' | 'no-claim' | 'no-release' | 'stalled-release' | 'lost-claim' | 'lost-release' = 'normal') => {
    const token = randomUUID(), gate = join(tmux.root, 'exit-engine'), ran = join(tmux.root, 'engine-ran')
    const fallback = join(tmux.root, 'manual-shell'), successor = join(tmux.root, 'successor-ran'), held = join(tmux.root, 'held')
    const client = join(tmux.root, 'client-pid')
    writeFileSync(fallback, '#!/bin/sh\n' + `printf '%s' "$$" > ${shellSingleQuote(successor)}\nexec /bin/sleep 300\n`, { mode: 0o700 })
    let tmuxBinary = binary!
    if (mode !== 'normal') {
      tmuxBinary = join(tmux.root, 'fixture-tmux')
      const condition = mode === 'no-claim' || mode === 'lost-claim' ? "args.some(value=>value.includes('set-option')&&value.includes(' active:'))"
        : "args.some(value=>value.includes('set-option')&&value.includes(' released:'))"
      const fault = mode === 'stalled-release'
        ? `require('node:fs').writeFileSync(${JSON.stringify(client)},String(process.pid));setInterval(()=>{},1000)`
        : mode.startsWith('lost-') ? `require('node:child_process').execFileSync(${JSON.stringify(binary)},args,{stdio:'ignore'});process.exit(0)` : 'process.exit(0)'
      writeFileSync(tmuxBinary, `#!${process.execPath}\nconst args=process.argv.slice(2);if(${condition}){${fault}}else{`
        + `require('node:child_process').execFileSync(${JSON.stringify(binary)},args,{stdio:'inherit'});}\n`, { mode: 0o700 })
    }
    const waiting = `printf held > ${shellSingleQuote(held)}\nexec /bin/sleep 300`
    const claim = nativePaneAllocationScript('claim', token, tmuxBinary, process.execPath, owner, waiting)
    const release = nativePaneAllocationScript('release', token, tmuxBinary, process.execPath, owner, waiting)
    const script = engineFallbackPrelude('cursor', fallback, binary!, release) + claim
      + `printf ran > ${shellSingleQuote(ran)}\nwhile [ ! -f ${shellSingleQuote(gate)} ]; do /bin/sleep 0.02; done\nharness_status=0\nharness_after\n`
    const pane = await tmux.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'fixture-native',
      '/usr/bin/env', `HARNESS_DAEMON=${owner}`, '/usr/bin/env', `${NATIVE_LAUNCH_MARKER}=${token}`, '/bin/sh', '-c', script,
      ';', 'set-option', '-p', HARNESS_OWNER_OPTION, owner)
    const rootPid = Number(await tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}'))
    const allocation = { pane, rootPid, token, owner }
    return { allocation, gate, ran, successor, held, client }
  }

  it('a queued close before release closes only its still-owned allocation', async () => {
    const p = await start()
    await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    expect(await mark(p.allocation)).toBe(`active:${p.allocation.token}:${p.allocation.rootPid}`)
    const queued = nativePaneAllocationArgs('close', p.allocation)
    await tmux.run(...queued)
    expect((await tmux.run('list-panes', '-a', '-F', '#{pane_id}')).split('\n')).not.toContain(p.allocation.pane)
    expect(existsSync(p.successor)).toBe(false)
  })

  it('a queued close after fallback preserves a manual successor with the same root and start command', async () => {
    const p = await start()
    await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    const queued = nativePaneAllocationArgs('close', p.allocation)
    const command = await tmux.run('display-message', '-p', '-t', p.allocation.pane, '#{pane_start_command}')
    writeFileSync(p.gate, '')
    await vi.waitFor(() => expect(existsSync(p.successor)).toBe(true), { timeout: 4000 })
    expect(Number(readFileSync(p.successor, 'utf8'))).toBe(p.allocation.rootPid)
    expect(await tmux.run('display-message', '-p', '-t', p.allocation.pane, '#{pane_start_command}')).toBe(command)
    expect(await mark(p.allocation)).toBe(`released:${p.allocation.token}:${p.allocation.rootPid}`)
    expect(await tmux.run(...queued)).toBe('native-allocation-mismatch')
    expect(await tmux.run('display-message', '-p', '-t', p.allocation.pane, '#{pane_pid}')).toBe(String(p.allocation.rootPid))
    expect(await tmux.run(...nativePaneAllocationArgs('claim', p.allocation))).toBe('native-allocation-mismatch')
    expect(await mark(p.allocation)).toBe(`released:${p.allocation.token}:${p.allocation.rootPid}`)
  })

  it('a delayed release cannot revoke a successor token', async () => {
    const p = await start(); await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    const successor = `active:${randomUUID()}:${p.allocation.rootPid}`
    await tmux.run('set-option', '-p', '-t', p.allocation.pane, NATIVE_PANE_ALLOCATION_OPTION, successor)
    expect(await tmux.run(...nativePaneAllocationArgs('claim', p.allocation))).toBe('native-allocation-mismatch')
    expect(await tmux.run(...nativePaneAllocationArgs('release', p.allocation))).toBe('native-allocation-mismatch')
    expect(await tmux.run(...nativePaneAllocationArgs('close', p.allocation))).toBe('native-allocation-mismatch')
    expect(await mark(p.allocation)).toBe(successor)
  })

  it('an old launch prefix cannot override the pane’s changed daemon owner', async () => {
    const p = await start(); await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    await tmux.run('set-option', '-p', '-t', p.allocation.pane, HARNESS_OWNER_OPTION, 'a'.repeat(16))
    for (const operation of ['claim', 'release', 'close'] as const) {
      expect(await tmux.run(...nativePaneAllocationArgs(operation, p.allocation))).toBe('native-allocation-mismatch')
    }
    expect(await mark(p.allocation)).toBe(`active:${p.allocation.token}:${p.allocation.rootPid}`)
  })

  it('a stale active marker cannot close a respawned root even with the old token prefix', async () => {
    const p = await start(); await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    const queued = nativePaneAllocationArgs('close', p.allocation)
    await tmux.run('respawn-pane', '-k', '-t', p.allocation.pane, '/usr/bin/env', `HARNESS_DAEMON=${owner}`,
      '/usr/bin/env', `${NATIVE_LAUNCH_MARKER}=${p.allocation.token}`, '/bin/sleep', '300')
    const nextPid = await tmux.run('display-message', '-p', '-t', p.allocation.pane, '#{pane_pid}')
    expect(nextPid).not.toBe(String(p.allocation.rootPid))
    expect(await mark(p.allocation)).toBe(`active:${p.allocation.token}:${p.allocation.rootPid}`)
    expect(await tmux.run(...queued)).toBe('native-allocation-mismatch')
    expect(await tmux.run('display-message', '-p', '-t', p.allocation.pane, '#{pane_pid}')).toBe(nextPid)
  })

  it('a marker cannot grant allocation authority to a command without the original token prefix', async () => {
    const allocation = { pane: '%0', rootPid: Number(await tmux.run('display-message', '-p', '-t', '%0', '#{pane_pid}')), token: randomUUID(), owner }
    await tmux.run('set-option', '-p', '-t', '%0', HARNESS_OWNER_OPTION, owner)
    await tmux.run('set-option', '-p', '-t', '%0', NATIVE_PANE_ALLOCATION_OPTION, `active:${allocation.token}:${allocation.rootPid}`)
    expect(await tmux.run(...nativePaneAllocationArgs('close', allocation))).toBe('native-allocation-mismatch')
    expect(await tmux.run('display-message', '-p', '-t', '%0', '#{pane_pid}')).toBe(String(allocation.rootPid))
  })

  it.each(['pane', 'rootPid', 'token', 'owner'] as const)('refuses a changed %s at the server-side close', async field => {
    const p = await start(); await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    const value = { ...p.allocation }
    if (field === 'pane') value.pane = '%0'
    if (field === 'rootPid') value.rootPid++
    if (field === 'token') value.token = randomUUID()
    if (field === 'owner') value.owner = 'a'.repeat(16)
    expect(await tmux.run(...nativePaneAllocationArgs('close', value))).toBe('native-allocation-mismatch')
    expect(await tmux.run('display-message', '-p', '-t', p.allocation.pane, '#{pane_pid}')).toBe(String(p.allocation.rootPid))
  })

  it('a missing claim acknowledgement never starts the engine or fallback', async () => {
    const p = await start('no-claim'); await vi.waitFor(() => expect(existsSync(p.held)).toBe(true))
    expect(existsSync(p.ran)).toBe(false); expect(existsSync(p.successor)).toBe(false)
  })

  it.each(['no-release', 'stalled-release'] as const)('an uncertain %s stays inert before shell startup', async mode => {
    const p = await start(mode); await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true))
    writeFileSync(p.gate, '')
    await vi.waitFor(() => expect(existsSync(p.held)).toBe(true), { timeout: 5000 })
    expect(existsSync(p.successor)).toBe(false)
    if (mode === 'stalled-release') expect(() => process.kill(Number(readFileSync(p.client, 'utf8')), 0)).toThrow()
  }, 10_000)

  it.each(['lost-claim', 'lost-release'] as const)('a published %s with a lost reply still leaves the wrapper inert', async mode => {
    const p = await start(mode)
    if (mode === 'lost-release') {
      await vi.waitFor(() => expect(existsSync(p.ran)).toBe(true)); writeFileSync(p.gate, '')
    }
    await vi.waitFor(() => expect(existsSync(p.held)).toBe(true))
    expect(await mark(p.allocation)).toBe(`${mode === 'lost-claim' ? 'active' : 'released'}:${p.allocation.token}:${p.allocation.rootPid}`)
    expect(existsSync(p.ran)).toBe(mode === 'lost-release'); expect(existsSync(p.successor)).toBe(false)
  })
})
