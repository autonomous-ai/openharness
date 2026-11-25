/** A launch the native guard held (its Codex replaced while the pane sat in a slow rc file) starts again by itself in
 *  its own pane, a first launch's task delivered once, and never reads as held to a client
 *  (docs/plans/2026-11-25-held-launch-recovery-design.md). POSIX only: it needs the rc window. */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, fakeEngineShim, until } from './harness/daemon.js'

type Row = Record<string, any>
type Ran = { code: number; out: string; err: string }

/** The CLI as a person runs it from their own shell: no TMUX_PANE, so no pane of Harness's is "here". */
function harness(d: IsolatedDaemon, args: string[]): Promise<Ran> {
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

/** Every launch the fake engine made (e2e/harness/fakeEngine.mjs); a held launch never reaches it. */
const launches = (d: IsolatedDaemon): Array<{ engine: string; args: string[] }> => {
  try { return readFileSync(join(d.root, 'launch-argv'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
}

/** A new Codex where the old one was, by rename, as an upgrade lands: the next guard reads a changed executable. */
const upgradeCodex = (d: IsolatedDaemon) => {
  const bin = join(d.root, 'bin', 'codex')
  writeFileSync(`${bin}.new`, fakeEngineShim('codex', d.engineConfig), { mode: 0o755 })
  renameSync(`${bin}.new`, bin)
}

describe.skipIf(process.platform === 'win32')('a launch the native guard held', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

  /** A daemon whose panes sit 2 s in their rc file, as many people's do: the window an upgrade lands in. */
  const slowShellDaemon = async () => {
    const d = daemon = await IsolatedDaemon.create()
    onTestFailed(() => console.log(d.log()))
    writeFileSync(join(d.root, 'bin', 'codex'), fakeEngineShim('codex', d.engineConfig), { mode: 0o755 })
    appendFileSync(join(d.env.ZDOTDIR ?? d.env.HOME!, '.zshrc'), 'sleep 2\n')
    await d.start()
    return d
  }

  /** Polls [name]'s row until it is ready, keeping every launch state a client was sent for it, listed or synced. */
  const settle = async (c: LocalClient, name: string, ready: (row: Row) => boolean, ms: number) => {
    const states: string[] = []
    const seen = (state: string | undefined) => { if (state && states.at(-1) !== state) states.push(state) }
    const row = await until(`${name} ready`, async () => {
      const found = ((await c.request('agents_list', {}, 30_000)).agents as Row[]).find((one) => one.name === name)
      seen(found?.launch?.state)
      return found?.launch?.state === 'ready' && ready(found) ? found : null
    }, ms, 250).catch(() => null)
    const synced = c.frames.filter((f) => f.type === 'agent_synced' && f.payload?.agent?.name === name).map((f) => f.payload.agent.launch?.state)
    return { row, states, synced }
  }

  it('a first launch the guard held starts again in its own pane, its task delivered once', async () => {
    const d = await slowShellDaemon()
    const c = client = await LocalClient.connect(d)
    mkdirSync(join(d.projectsDir, 'b1'), { recursive: true })
    const created = harness(d, ['new', 'codex', join(d.projectsDir, 'b1'), '--name', 'b1', '--', 'hello'])
    const b1 = await until('b1 to be listed', async () =>
      ((await c.request('agents_list', {}, 30_000)).agents as Row[]).find((row) => row.name === 'b1'), 30_000, 50)
    // Its pane is in the 2 s rc file now, before the guard reads the executable.
    upgradeCodex(d)
    const waiting = harness(d, ['wait', 'b1', '--timeout', '2m'])
    const { row, states, synced } = await settle(c, 'b1', () => true, 30_000)
    const waited = await waiting
    await created

    expect(d.log()).toContain(`[launch] ${b1.id.slice(0, 8)} starting → held`)
    // Soft: a failure names each of what a person sees, not only the first.
    expect.soft(states, 'b1 as listed').not.toContain('held')
    expect.soft(synced, 'b1 as synced').not.toContain('held')
    expect.soft(row?.launch?.state, `b1's launch, seen as ${states.join(' → ')}`).toBe('ready')
    expect.soft(launches(d).filter((l) => l.engine === 'codex' && l.args.includes('hello'))).toHaveLength(1)
    expect.soft(waited.code, waited.out + waited.err).toBe(0)
    expect.soft(waited.out.trim()).toBe('b1: idle · read it: harness show b1')
  }, 180_000)

  it('a conversation the guard held on its restore resumes in its own pane, without a second engine', async () => {
    const d = await slowShellDaemon()
    let c = client = await LocalClient.connect(d)
    mkdirSync(join(d.projectsDir, 'c1'), { recursive: true })
    const created = await harness(d, ['new', 'codex', join(d.projectsDir, 'c1'), '--name', 'c1', '--', 'hi'])
    expect(created.code, created.out + created.err).toBe(0)
    const { row: first } = await settle(c, 'c1', (row) => !!row.sessionId, 60_000)
    expect(first, 'c1 to be ready with a conversation').toBeTruthy()
    const id: string = first!.id, S: string = first!.sessionId
    c.close()

    await d.stop()
    const before = launches(d).length, restartAt = d.log().length
    // Its pane gone, the restore opens a new one resuming S, which sits in the 2 s rc file.
    for (const pane of (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')).split('\n').filter(Boolean)) {
      await d.tmux.run('kill-pane', '-t', pane)
    }
    const restored = until('c1 restored into a new pane', () => d.log().slice(restartAt).split('\n')
      .some((line) => line.includes(`[restore] codex · agent ${id} · pane `) && line.includes(`· resuming ${S.slice(0, 8)}`)), 60_000, 50)
      .then(() => upgradeCodex(d))
    await d.start()
    await restored
    c = client = await LocalClient.connect(d)
    const { row, states, synced } = await settle(c, 'c1', (one) => one.sessionId === S, 60_000)

    expect(d.log().slice(restartAt)).toContain(`[launch] ${id.slice(0, 8)} starting → held`)
    expect.soft(states, 'c1 as listed').not.toContain('held')
    expect.soft(synced, 'c1 as synced').not.toContain('held')
    expect.soft(row?.launch?.state, `c1's launch, seen as ${states.join(' → ')}`).toBe('ready')
    const resumed = launches(d).slice(before).filter((l) => l.engine === 'codex')
    expect.soft(resumed).toHaveLength(1)
    expect.soft(resumed[0]?.args ?? []).toContain(S)
  }, 180_000)
})
