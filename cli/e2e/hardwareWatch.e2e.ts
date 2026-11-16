/**
 * `harness hardware watch` on the real daemon, as the menu-bar app runs it: a stdin pipe held open and stdout read
 * line by line. The first daemons run with CABLE_DISABLE (no dial and no devices' process), so their status is "not
 * attached"; the exit codes are the app's probe of the daemon: 3 it cannot be reached, 0 the app closed the pipe. The
 * last two run a fake dial (harness/desk.ts): the watch changes its sound, and this computer's Notifications setting,
 * from a line on its stdin.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk, SETTINGS } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

const children: ReturnType<typeof spawn>[] = []
/** The command as the menu-bar app runs it: a stdin pipe held open, stdout and stderr read line by line as it prints. */
function watch(d: IsolatedDaemon) {
  const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
    cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const lines: string[] = [], errors: string[] = []
  createInterface({ input: child.stdout! }).on('line', (line) => { lines.push(line) })
  createInterface({ input: child.stderr! }).on('line', (line) => { errors.push(line) })
  const exit = new Promise<number | null>((done) => child.on('close', (code) => done(code)))
  return { child, lines, errors, exit }
}
const stopWatches = (): void => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
}

describe('harness hardware watch on the real daemon', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => {
    stopWatches()
    await daemon?.close(); daemon = undefined
  })

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

/** `muted` on a line the watch printed. */
const mutedOf = (line: string | undefined): unknown => (line === undefined ? undefined : (JSON.parse(line) as { muted?: unknown }).muted)

describe('harness hardware watch with a dial: Sound', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const windows: LocalClient[] = []
  afterEach(async () => {
    stopWatches()
    for (const window of windows.splice(0)) window.close()
    await desk?.close(); desk = undefined
    await daemon?.close(); daemon = undefined
  })

  /** A daemon that finds the dials on a desk of its own, as dialAppFilter.e2e.ts makes one. */
  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    return { d, desk: theDesk }
  }

  it('a muted line reaches the dial, and the check\'s line follows only what the dial says', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const run = watch(d)
    onTestFailed(() => { console.log(`---- the watch's stdout\n${run.lines.join('\n')}\n---- its stderr\n${run.errors.join('\n')}`) })
    await until('the watch to say the sound is on', () => mutedOf(run.lines.at(-1)) === false, 60_000)

    let since = dial.messages.length
    run.child.stdin!.write('{"muted":true}\n')
    expect(await dial.next((m) => m.t === 'settings.set', 30_000, 'settings.set', since)).toEqual({ t: 'settings.set', muted: true })
    // Sent is not done: the line moves only when the dial says so.
    expect(mutedOf(run.lines.at(-1))).toBe(false)

    // Any line since, not only the last: the dial greets again every 15 s with the settings it was plugged in with
    // (muted false), which can turn the line back between two looks.
    const from = run.lines.length
    dial.send({ t: 'settings.state', ok: true, settings: { ...SETTINGS, muted: true } })
    await until('the watch to say the sound is off', () => run.lines.slice(from).some((line) => mutedOf(line) === true), 30_000)

    // Desktop's switch: the watch follows the dial whoever changed it.
    const window = await LocalClient.connect(d)
    windows.push(window)
    since = dial.messages.length
    expect(await window.request('harness_device_settings', { id: 'E2E-A', patch: { muted: false } })).toMatchObject({ ok: true })
    expect(await dial.next((m) => m.t === 'settings.set', 30_000, 'a second settings.set', since)).toEqual({ t: 'settings.set', muted: false })
    dial.send({ t: 'settings.state', ok: true, settings: SETTINGS })
    await until('the watch to say the sound is on again', () => mutedOf(run.lines.at(-1)) === false, 30_000)

    // The daemon's answer on the watch's own socket, under its request id, which no unit test reaches: a second change
    // goes out at once only if the first was answered. One never answered holds the slot 12 s, then says
    // `sound: NO_ANSWER`, which the last check reads, and only then sends the second.
    since = dial.messages.length
    run.child.stdin!.write('{"muted":true}\n')
    expect(await dial.next((m) => m.t === 'settings.set', 30_000, 'the watch\'s second settings.set', since)).toEqual({ t: 'settings.set', muted: true })

    await desk.unplug('E2E-A')
    await until('the watch to say no dial', () => run.lines.at(-1) === '{"attached":false}', 60_000)
    run.child.stdin!.write('{"muted":true}\n')
    await until('the watch to say it has no dial to change', () => run.errors.includes('sound: NO_DIAL'), 30_000)
    // The first change was answered ok before the second went out: no NO_ANSWER, nor any other sound line.
    expect(run.errors.filter((line) => line.startsWith('sound: '))).toEqual(['sound: NO_DIAL'])
  })
})

/** `notify` on a line the watch printed: the Notifications setting. */
const notifyOf = (line: string | undefined): unknown => (line === undefined ? undefined : (JSON.parse(line) as { notify?: unknown }).notify)

describe('harness hardware watch with a dial: Notifications', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  afterEach(async () => {
    stopWatches()
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close(); desk = undefined
    await daemon?.close(); daemon = undefined
  })

  /** A daemon that finds the dials on a desk of its own, as the Sound block's. */
  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    return { d, desk: theDesk }
  }
  /** [engine], once the dial lists it after [listedSince], takes a prompt and ends its turn: the summary the dial hears. */
  const turnEnds = async (dial: FakeDial, engine: Outside, prompt: string, listedSince: number): Promise<DialMessage> => {
    await dial.next((m) => m.t === 'agent' && m.id === engine.id, 45_000, 'the agent listed', listedSince)
    const since = dial.messages.length
    engine.type(prompt)
    return dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', since)
  }

  it("the menu's mode is kept by the daemon, and a finished turn follows it", async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    // An agent outside a pane: its finished turn is decided on this computer, by its rules.
    const engine = await Outside.start(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    outside.push(engine)
    let run = watch(d)
    onTestFailed(() => { console.log(`---- the watch's stdout\n${run.lines.join('\n')}\n---- its stderr\n${run.errors.join('\n')}`) })
    await until('the watch to say Full', () => notifyOf(run.lines.at(-1)) === 'full', 60_000)

    // On any line since, never on a count of lines: the dial greets again every 15 s, and a greeting brings a status.
    let from = run.lines.length
    run.child.stdin!.write('{"notify":"you"}\n')
    await until('the watch to say Only you', () => run.lines.slice(from).some((line) => notifyOf(line) === 'you'), 30_000)
    expect(readFileSync(join(d.dataDir, 'dial-notify.json'), 'utf8')).toBe('{"mode":"you"}\n')
    // An ordinary finished turn is a drawer row: the dial does not beep.
    expect(await turnEnds(dial, engine, 'build it', 0)).toMatchObject({ tier: 'list', quiet: true })

    // Kept by the daemon: a watch on the daemon started again says it.
    const listedSince = dial.messages.length
    await d.restart()
    run = watch(d)
    await until('the new watch to say Only you', () => notifyOf(run.lines.at(-1)) === 'you', 60_000)

    from = run.lines.length
    run.child.stdin!.write('{"notify":"full"}\n')
    await until('the watch to say Full again', () => run.lines.slice(from).some((line) => notifyOf(line) === 'full'), 30_000)
    expect(await turnEnds(dial, engine, 'build it again', listedSince)).toMatchObject({ tier: 'alert' })

    await desk.unplug('E2E-A')
    await until('the watch to say no dial', () => run.lines.at(-1) === '{"attached":false}', 60_000)
    run.child.stdin!.write('{"notify":"you"}\n')
    await until('the watch to say it has no dial to change it for', () => run.errors.includes('notify: NO_DIAL'), 30_000)
    // Each change before was answered with its mode: no NO_ANSWER, nor any other notify line.
    expect(run.errors.filter((line) => line.startsWith('notify: '))).toEqual(['notify: NO_DIAL'])
  })
})
