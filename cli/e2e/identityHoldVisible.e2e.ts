/**
 * A build that ships without its native process-image helper (macOS only) cannot read which conversation a Codex
 * process holds, and nothing recovers until Harness is reinstalled. The agent is held with a sentence that says so,
 * the daemon logs it once, not on every 5 s pass, and `harness wait` ends on it with exit 3 (docs/plans/
 * 2026-11-19-identity-hold-visible-design.md). Signed out, no backend.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { MISSING_HELPER } from '../src/engines/kit/identityScan.js'

/** `harness <args>` as a person's shell runs it: not a terminal, so plain text. */
function harness(d: IsolatedDaemon, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

describe.runIf(process.platform === 'darwin')('a build without its native helper', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('a build without its helper holds its agent with a sentence, logs it once, and wait ends with exit 3', async () => {
    const d = await IsolatedDaemon.create({ withoutProcessImages: true })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    // A Codex that runs no hooks: one that does is bound by its SessionStart, which needs no native read, and the
    // hold lasted only until then. Without hooks the descriptors are the only way to its conversation.
    const module = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
    const config = { ...d.engineConfig, withoutHooks: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt', 'PermissionRequest', 'PreToolUse'] }
    writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}\nimport(${JSON.stringify(module)}).then((m) => m.run('codex', ${JSON.stringify(config)}))\n`, { mode: 0o755 })
    await d.start()
    const client = await LocalClient.connect(d)
    const dir = join(d.projectsDir, 'held')
    mkdirSync(dir, { recursive: true })

    const started = await harness(d, ['new', 'codex', dir, '--name', 'held', '--', 'hello'])
    expect(started.code, started.out + started.err).toBe(0)
    const row = async () => ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'held')
    await until('the agent held with its sentence', async () => (await row())?.namedState === MISSING_HELPER, 60_000, 250)

    const waited = await harness(d, ['wait', 'held', '--timeout', '2m'])
    expect(waited.code, waited.out + waited.err).toBe(3)
    expect(waited.out.trim()).toBe(`held: held · ${MISSING_HELPER} Only the person can fix this.`)
    const shown = await harness(d, ['show', 'held', '--json'])
    expect(JSON.parse(shown.out), shown.err).toMatchObject({ state: 'held', namedState: MISSING_HELPER, needsPerson: true })
    const listed = await harness(d, ['ps', '--json'])
    expect(JSON.parse(listed.out).harnesses, listed.err).toEqual([expect.objectContaining({ name: 'held', state: 'held' })])
    // Once by the end of the test: the daemon has no per-pass signal to wait on, so how many passes ran since is
    // not bounded here.
    expect(d.log().split(`binding held · ${MISSING_HELPER}`)).toHaveLength(2)
    client.close()
  }, 180_000)
})
