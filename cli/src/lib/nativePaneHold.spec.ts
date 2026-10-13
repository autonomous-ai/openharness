import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { heldPaneArgv } from '../core/agents/heldLaunches.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { nativePaneHold, NATIVE_LAUNCH_MARKER } from './nativePaneHold.js'
import { shellSingleQuote } from './shellQuote.js'
import { TmuxBackend } from './tmuxBackend.js'
import { resetTmuxVersionCache } from './tmuxVersion.js'
import { paneOwnerFormat, paneOwnerOf } from './harnessSessionLabel.js'

const binary = resolveBinaryOnPath('tmux')
const owner = 'd00df00dd00df00d'
const hold = (token: string, binary: string | null, command: string) => nativePaneHold(token, binary, command, process.execPath, owner)
describe.skipIf(!binary)('native guard publication on private tmux servers', () => {
  let tmux: IsolatedTmux, other: IsolatedTmux | undefined
  const backend = new TmuxBackend(undefined, () => owner, () => {})
  beforeEach(async () => {
    tmux = await isolatedTmux()
    tmux.env.HOME = tmux.root; tmux.env.ZDOTDIR = tmux.root
    vi.stubEnv('HOME', tmux.root); vi.stubEnv('ZDOTDIR', tmux.root)
    vi.stubEnv('TMUX', undefined); vi.stubEnv('TMUX_PANE', undefined); vi.stubEnv('TMUX_TMPDIR', tmux.root)
    resetTmuxVersionCache()
    await tmux.run('new-session', '-d', '-s', 'fixture-anchor', '/bin/sleep', '300')
  })
  afterEach(async () => { await other?.close(); other = undefined; await tmux.close(); vi.unstubAllEnvs(); resetTmuxVersionCache() })
  const start = async (token: string, script: string, sourced = false) => {
    const file = join(tmux.root, randomUUID() + '.sh'); writeFileSync(file, script)
    const result = await backend.create({ label: `harness-fixture-${randomUUID()}`, command: [
      '/usr/bin/env', `${NATIVE_LAUNCH_MARKER}=${token}`, '/bin/sh', '-c', sourced ? `. ${shellSingleQuote(file)}` : script,
    ] })
    if (result.state !== 'succeeded') throw Error(result.reason)
    return result.runtime
  }
  const held = (token: string) => heldPaneArgv('Private native hold.', token).map(shellSingleQuote).join(' ')

  it.each([false, true])('recognizes a guard only after its inert transition: sourced %s', async sourced => {
    const token = randomUUID(), release = join(tmux.root, 'release')
    const script = `while [ ! -f ${shellSingleQuote(release)} ]; do sleep 0.01; done\n` + hold(token, binary!, held(token))
    const pane = await start(token, script, sourced)
    expect(await backend.isHeld(pane, token)).toBe(false)
    expect(await backend.respawn(pane, { command: ['/bin/false'], expectedHeldToken: token })).toMatchObject({ dispatch: 'not_started' })
    expect(await backend.killHeld(pane, token, () => true)).toMatchObject({ dispatch: 'not_started' })
    writeFileSync(release, '')
    await vi.waitFor(async () => expect(await backend.isHeld(pane, token)).toBe(true))
    // Before tmux 3.0 a renamed/moved pane cannot borrow its old window tag.
    const session = await tmux.run('display-message', '-p', '-t', pane.paneId, '#{session_id}')
    await tmux.run('rename-session', '-t', session, 'foreign-' + randomUUID())
    expect(paneOwnerOf(await tmux.run('display-message', '-p', '-t', pane.paneId, paneOwnerFormat(false)))).toBe(owner)
    expect(await backend.killHeld(pane, token, () => true)).toMatchObject({ state: 'succeeded' })
  })

  it.each(['pane', 'socket'] as const)('does not replace a foreign pane when rc changes the %s', async changed => {
    other = await isolatedTmux(tmux.env)
    await other.run('new-session', '-d', '-s', 'foreign', '/bin/sleep', '300')
    const foreign = await backend.create({ label: `harness-foreign-${randomUUID()}`, command: ['/bin/sleep', '300'] })
    if (foreign.state !== 'succeeded') throw Error(foreign.reason)
    const original = await tmux.run('display-message', '-p', '-t', foreign.runtime.paneId, '#{pane_pid}')
    const otherPid = await other.run('display-message', '-p', '-t', '%0', '#{pane_pid}')
    const token = randomUUID()
    const redirect = changed === 'pane' ? `export TMUX_PANE=${shellSingleQuote(foreign.runtime.paneId)}\n`
      : `export TMUX=${shellSingleQuote(other.socket + ',1,0')}; export TMUX_PANE=%0\n`
    const pane = await start(token, redirect + hold(token, binary!, held(token)))
    await vi.waitFor(async () => expect(await tmux.run('capture-pane', '-p', '-t', pane.paneId)).toContain('Private native hold.'))
    expect(await tmux.run('display-message', '-p', '-t', foreign.runtime.paneId, '#{pane_pid}')).toBe(original)
    expect(await other.run('display-message', '-p', '-t', '%0', '#{pane_pid}')).toBe(otherPid)
    expect(await backend.isHeld(pane, token)).toBe(false)
  })

  it('bounds a stalled transition and kills its client before falling back inert', async () => {
    const token = randomUUID(), pidFile = join(tmux.root, 'client-pid'), binary = join(tmux.root, 'stalled-tmux')
    writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 })
    const pane = await start(token, hold(token, binary, held(token)))
    onTestFailed(async () => console.log(await tmux.run('capture-pane', '-p', '-t', pane.paneId)))
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 3_000 })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await vi.waitFor(async () => expect(await tmux.run('capture-pane', '-p', '-t', pane.paneId)).toContain('Private native hold.'), { timeout: 5_000 })
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await backend.isHeld(pane, token)).toBe(false)
  }, 10_000)

  it('rejects a delayed server command after a replacement, even if it carries the original nonce', async () => {
    const token = randomUUID(), replacement = randomUUID(), invocation = join(tmux.root, 'invocation.json')
    const recorder = join(tmux.root, 'record-tmux')
    writeFileSync(recorder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invocation)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 })
    const pane = await start(token, hold(token, recorder, held(token)))
    await vi.waitFor(() => expect(existsSync(invocation)).toBe(true))
    const args = JSON.parse(readFileSync(invocation, 'utf8')) as string[]
    // Preserve the old nonce in the new start command too: PID must independently fence it.
    const replacementCommand = heldPaneArgv(`Replacement ${NATIVE_LAUNCH_MARKER}=${token}`, replacement)
    expect(await backend.respawn(pane, { command: replacementCommand })).toMatchObject({ state: 'succeeded' })
    const before = await tmux.run('display-message', '-p', '-t', pane.paneId, '#{pane_pid}')
    await tmux.run(...args)
    expect(await tmux.run('display-message', '-p', '-t', pane.paneId, '#{pane_pid}')).toBe(before)
    expect(await tmux.run('display-message', '-p', '-t', pane.paneId, '#{pane_start_command}')).toContain(replacement)
  })
})
