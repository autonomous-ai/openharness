/**
 * A program-owned harness on the real daemon (#4393), signed out as a lamp ships: the program starts it with its
 * token, and every reply it types is answered `taken` once the engine has started that turn, task after task in one
 * session. The fake engines answer by echoing (harness/fakeEngine.mjs).
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon } from './harness/daemon.js'

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

describe('a program-owned harness, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('signed out, ten replies in a row into one session are each answered taken', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-250).join('\n')}`) })
    await d.start()
    const dir = join(d.projectsDir, 'lamp')
    mkdirSync(dir, { recursive: true })
    const token = join(d.root, 'lamp-token')
    writeFileSync(token, `${'k'.repeat(48)}\n`)
    chmodSync(token, 0o600)
    const run = (...args: string[]) => harness(d, args)

    const started = await run('new', 'claude', dir, '--name', 'lamp', '--program-token-file', token, '--json')
    expect(started.code, started.out + started.err).toBe(0)
    for (let i = 1; i <= 10; i++) {
      const replied = await run('reply', 'lamp', '--program-token-file', token, '--timeout', '60s', '--json', '--', `task number ${i}`)
      expect(replied.code, `reply ${i}: ${replied.out}${replied.err}`).toBe(0)
      const taken = JSON.parse(replied.out)
      expect(taken.state).toBe('taken')
      const waited = await run('wait', 'lamp', '--program-token-file', token, '--after', taken.inputId, '--timeout', '2m', '--json')
      expect(waited.code, `wait ${i}: ${waited.out}${waited.err}`).toBe(0)
    }
  }, 600_000)
})
