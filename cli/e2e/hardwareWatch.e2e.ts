/**
 * `harness hardware watch` on the real daemon, as the menu-bar app runs it: a stdin pipe held open and stdout read
 * line by line. The daemon runs with CABLE_DISABLE (no dial and no devices' process), so its status is "not attached";
 * the exit codes are the app's probe of the daemon: 3 it cannot be reached, 0 the app closed the pipe.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

describe('harness hardware watch on the real daemon', () => {
  let daemon: IsolatedDaemon | undefined
  const children: ReturnType<typeof spawn>[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
    await daemon?.close(); daemon = undefined
  })

  /** The command as the menu-bar app runs it: a stdin pipe held open, stdout read line by line as it prints. */
  function watch(d: IsolatedDaemon) {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const lines: string[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => { lines.push(line) })
    const exit = new Promise<number | null>((done) => child.on('close', (code) => done(code)))
    return { child, lines, exit }
  }

  const started = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it('prints that no dial is attached, and stays', async () => {
    const d = await started()
    const run = watch(d)
    await until('watch\'s first line', () => run.lines.length > 0, 60_000)
    expect(run.lines[0]).toBe('{"attached":false}')
    expect(run.child.exitCode).toBeNull()
  })

  it('exits 3 when the daemon stops', async () => {
    const d = await started()
    const run = watch(d)
    await until('watch\'s first line', () => run.lines.length > 0, 60_000)
    await d.stop()
    expect(await run.exit).toBe(3)
    expect(run.lines).toEqual(['{"attached":false}'])

    const again = watch(d)
    expect(await again.exit).toBe(3)
    expect(again.lines).toEqual([])
  })

  it('exits 0 when its stdin closes, and leaves the daemon running', async () => {
    const d = await started()
    const run = watch(d)
    await until('watch\'s first line', () => run.lines.length > 0, 60_000)
    run.child.stdin!.end()
    expect(await run.exit).toBe(0)
    expect(run.lines).toEqual(['{"attached":false}'])
    expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
  })
})
