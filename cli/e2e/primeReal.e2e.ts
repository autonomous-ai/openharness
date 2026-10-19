/**
 * The REAL Prime Agent under a private daemon, home and tmux: opt-in (`RUN_REAL_PRIME=1`), since it needs an
 * installed, signed-in `prime-agent` and spends a few small model turns. Never part of CI.
 *
 * Prime is isolated as well as the daemon: its own agent directory (a copy of the person's auth and settings;
 * the Python kernel's venv linked, not rebuilt) and its own supervisor (`--daemon-socket`), so the person's
 * running Prime agents, sessions and extensions are never touched.
 *
 *   RUN_REAL_PRIME=1 npx vitest run --config vitest.e2e.config.ts e2e/primeReal.e2e.ts
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const REAL = process.env.RUN_REAL_PRIME === '1'
const realBinary = () => execFileSync('/bin/sh', ['-lc', 'command -v prime-agent'], { encoding: 'utf8' }).trim()

type Agent = { id: string; sessionId: string | null; engine: string; transcriptPath?: string | null }
const rows = async (client: LocalClient) => (await client.request('agents_list', {})).agents as Agent[]

describe.skipIf(!REAL)('Prime Agent, for real', () => {
  let daemon: IsolatedDaemon | undefined
  let client: LocalClient | undefined
  let socket = ''
  let testRoot = ''
  afterAll(async () => {
    client?.close()
    await daemon?.close()
    // Its supervisor and workers outlive the panes by design (Prime's docs/daemon.md): stop them.
    // `shutdown` takes no --daemon-socket (0.9.5). End the supervisor and its workers together: a worker that
    // outlives its supervisor starts a replacement (Prime's docs/daemon.md). Workers name the socket only in
    // their environment (PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET), which `ps eww` shows for our own.
    // Match the test's root too: every worker inherits its Prime directory from the wrapper and every kernel runs
    // from its home, including ones whose supervisor is already gone (seen: orphaned workers, ppid 1, and kernels).
    if (socket) {
      const table = execFileSync('ps', ['-axww', '-e', '-o', 'pid=,command='], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 })
      const pids = table.split('\n').filter((line) => line.includes(socket) || (!!testRoot && line.includes(testRoot)))
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => pid > 0 && pid !== process.pid)
      for (const pid of pids) try { process.kill(pid, 'SIGTERM') } catch {}
    }
  })

  it('follows a launched agent through a typed turn, a recap, a turn its own child started and a /new switch', async () => {
    const real = realBinary()
    const d = daemon = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: 'claude,codex,prime' } })
    onTestFailed(() => console.log(d.log()))
    testRoot = realpathSync(join(d.projectsDir, '..'))
    const primeDir = join(testRoot, 'prime-agent')
    mkdirSync(primeDir, { recursive: true })
    // The suite's HOME is a throwaway one (vitest.setup.ts); the account's own is where Prime is signed in.
    const person = process.env.REAL_PRIME_AGENT_DIR ?? join(userInfo().homedir, '.prime', 'agent')
    for (const file of ['auth.json', 'settings.json']) copyFileSync(join(person, file), join(primeDir, file))
    for (const dir of ['kernel-venv', 'bin']) if (existsSync(join(person, dir))) symlinkSync(join(person, dir), join(primeDir, dir))
    socket = `/tmp/pa-e2e-${process.pid}.sock`
    rmSync(socket, { force: true })
    const wrapper = join(d.projectsDir, '..', 'prime-bin', 'prime-agent')
    mkdirSync(join(wrapper, '..'), { recursive: true })
    writeFileSync(wrapper, `#!/bin/sh\nexport PRIME_AGENT_CODING_AGENT_DIR=${JSON.stringify(primeDir)}\nexec ${JSON.stringify(real)} --daemon-socket ${JSON.stringify(socket)} "$@"\n`, { mode: 0o755 })
    // Before start: the containment check (assertHooksContained) then sees Prime's directory inside the root.
    Object.assign(d.env, { PRIME_AGENT_PATH: wrapper, PRIME_AGENT_CODING_AGENT_DIR: primeDir })
    await d.start()
    // Hooks install once the core is up, after start() returns.
    await until('the Prime extension installed in its own directory', () => existsSync(join(primeDir, 'extensions', 'harness-register.ts')), 60_000, 200)
    const c = client = await LocalClient.connect(d)

    const cwd = join(d.projectsDir, 'prime'); mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\n')
    const created = await c.request('agent_create', { engine: 'prime', cwd }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId = created.agent.id as string

    // The typed turn binds the session (registration happens at the first message for a fresh draft too).
    const started = c.next((f) => f.type === 'turn_started' && f.agentId === agentId, 120_000, 'turn_started')
    const ended = c.next((f) => f.type === 'turn_ended' && f.agentId === agentId, 180_000, 'turn_ended')
    const summary = c.next((f) => f.type === 'turn_summary' && f.agentId === agentId, 240_000, 'turn_summary')
    await until('the Prime pane is ready', async () => (await rows(c)).find((a) => a.id === agentId) ?? null, 60_000, 500)
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    c.send('message', { agentId, content: 'Count the lines in notes.txt with a shell command, then reply with just the number.' })
    await started
    await ended
    const bound = await until('the bound session', async () => (await rows(c)).find((a) => a.id === agentId && a.sessionId) ?? null, 30_000, 500)
    expect(bound.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    await summary

    // A turn nobody typed: the child's reply arrives as an agent_message and Prime answers it.
    const second = c.next((f) => f.type === 'turn_started' && f.agentId === agentId
      && JSON.stringify(f.payload ?? {}).includes('agent-message from child'), 240_000, 'the child-started turn')
    c.send('message', { agentId, content: 'Spawn one child agent with rlm.spawn named pinger whose task is: reply to your parent with agent_message.send saying pong. Then end your turn without waiting.' })
    await second
    await c.next((f) => f.type === 'turn_ended' && f.agentId === agentId, 300_000, 'the child-started turn’s end')
    const history = await c.request('session_get', { sessionId: agentId, limit: 50 }, 30_000)
    expect(JSON.stringify(history)).toContain('agent-message from child:pinger')

    // `/new` switches conversation inside the same worker. The new one is a draft with no file until its first
    // message (measured), so the move comes with that message, through the extension's hook. `/new` opens no
    // turn, so the input path gives up on it after its two re-presses (~9s); wait those out first.
    c.send('message', { agentId, content: '/new' })
    await new Promise((resolve) => setTimeout(resolve, 12_000))
    c.send('message', { agentId, content: 'Reply with the single word: second' })
    const moved = await until('the agent bound to the new conversation', async () => {
      const row = (await rows(c)).find((a) => a.id === agentId)
      return row?.sessionId && row.sessionId !== bound.sessionId ? row : null
    }, 120_000, 500)
    await until('the new conversation’s answer in its history', async () => {
      const page = await c.request('session_get', { sessionId: agentId, limit: 20 }, 30_000)
      // The prompt is only in the NEW conversation's file: finding it proves the agent reads that one now.
      return JSON.stringify(page.events ?? page).includes('Reply with the single word: second') ? page : null
    }, 120_000, 1_000)
  }, 900_000)
})
