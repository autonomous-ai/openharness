/**
 * The agent browser on the real daemon (services/agentBrowser.ts), with a fake `podman` first on the fixture's PATH and
 * in its login shell: the real Podman is never run here, another process may be using it.
 *
 * The person starts and stops an agent's browser from its chat (`agent_browser_start`, `_stop`), and the agent drives it
 * with `harness browser <command>` from its own pane (docs/superpowers/specs/2026-11-11-browser-from-chat-design.md).
 * The command runs as an agent's shell tool runs it: a child of the engine in the agent's pane, so its parents prove the
 * pane. A browser left on follows its agent through a restart, a stop and a resume, and a daemon restart; its purge
 * removes its container, volume, network and proxy secret; and the service failing costs the agent nothing.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { browserAssetsHash } from '../src/services/agentBrowser/assets.js'
import { imageTag } from '../src/services/agentBrowser/image.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, fakeEngineShim, IsolatedDaemon, until } from './harness/daemon.js'

const GiB = 1024 ** 3

/**
 * A `podman` that logs each argv as a line and answers what a browser's start asks; `events` streams nothing. Its exec
 * of the tool server (browser-tools.mjs) answers each line as the real one does: a snapshot with [TREE], a screenshot
 * with [SHOT], and the window with the size it was asked for.
 */
function writeFakePodman(daemon: IsolatedDaemon): string {
  const calls = join(daemon.root, 'podman-calls.log')
  const image = `localhost/${imageTag(browserAssetsHash(), new Date())}`
  const shot = join(daemon.root, 'shot.jpg')
  writeFileSync(shot, SHOT)
  const script = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n')
const line = args.join(' ')
if (args[0] === 'events') { setInterval(() => {}, 1 << 30); return }
if (args[0] === 'exec' && args.at(-1) === '/opt/harness-browser/browser-tools.mjs') {
  const answers = {
    browser_snapshot: () => ({ content: [{ type: 'text', text: ${JSON.stringify(TREE)} }] }),
    browser_screenshot: () => ({ content: [{ type: 'image', data: fs.readFileSync(${JSON.stringify(shot)}).toString('base64'), mimeType: 'image/jpeg' }] }),
  }
  require('node:readline').createInterface({ input: process.stdin }).on('line', (text) => {
    const { id, method, params } = JSON.parse(text)
    const result = method === 'window' ? { width: params.width, height: params.height }
      : method === 'tools/call' && answers[params.name] ? answers[params.name]() : null
    process.stdout.write(JSON.stringify(result ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
  })
  return
}
if (line.startsWith('info')) process.stdout.write(JSON.stringify({ version: { Version: '5.8.1' }, host: { memTotal: ${8 * GiB} } }))
else if (line.startsWith('images')) process.stdout.write(JSON.stringify([{ Names: [${JSON.stringify(image)}], Created: 1, Containers: 0 }]))
else if (line.startsWith('ps')) process.stdout.write('[]')
else if (line.startsWith('machine list')) process.stdout.write('[{"Running":true}]')
`
  const bin = join(daemon.root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'podman'), script, { mode: 0o755 })
  // The daemon finds podman through the login shell (podman.ts), and on macOS that shell's /etc/zprofile puts
  // /etc/paths.d, with the real /opt/podman/bin, ahead of the daemon's PATH. The fixture's own rc files put the fake
  // first again, after every system file, for zsh and bash alike.
  for (const rc of ['.zshrc', '.bashrc']) appendFileSync(join(daemon.root, 'home', rc), `export PATH='${bin}':"$PATH"\n`)
  appendFileSync(calls, '')
  return calls
}

/** Where the engine in [pane] takes the commands it runs (`writePaneRunner`). */
const commandsOf = (d: IsolatedDaemon, pane: string) => join(d.root, 'pane-commands', pane.replace(/\W/g, ''))

/**
 * The fake Claude Code, which also runs shell commands as an agent's shell tool does: a child of the engine, in its pane.
 * An agent's pane runs its engine, not a prompt, so a command is handed over as a file (`<id>.cmd`) in its pane's
 * folder, and its exit code and output come back as `<id>.json`. Only an engine in a pane takes them: the daemon's
 * probes of `claude` run in none.
 */
function writePaneRunner(d: IsolatedDaemon): void {
  const engine = fakeEngineShim('claude', { ...d.engineConfig })
  const runner = `
{
  const fs = require('node:fs')
  const { join } = require('node:path')
  const { spawn } = require('node:child_process')
  const pane = process.env.TMUX_PANE
  if (pane && process.stdin.isTTY) {
    const folder = join(${JSON.stringify(join(d.root, 'pane-commands'))}, pane.replace(/\\W/g, ''))
    fs.mkdirSync(folder, { recursive: true })
    const run = (id) => {
      const taken = join(folder, id + '.taken')
      const child = spawn('/bin/sh', ['-c', fs.readFileSync(taken, 'utf8')], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('close', (code) => {
        fs.writeFileSync(join(folder, id + '.part'), JSON.stringify({ code, out, err }))
        fs.renameSync(join(folder, id + '.part'), join(folder, id + '.json'))
      })
    }
    setInterval(() => {
      for (const name of fs.readdirSync(folder)) {
        if (!name.endsWith('.cmd')) continue
        const id = name.slice(0, -4)
        // Taken once: an engine that restarts in the same pane never runs a command twice.
        try { fs.renameSync(join(folder, name), join(folder, id + '.taken')) } catch { continue }
        run(id)
      }
    }, 100).unref()
  }
}
`
  const [shebang, ...rest] = engine.split('\n')
  writeFileSync(join(d.root, 'bin', 'claude'), [shebang, runner, ...rest].join('\n'), { mode: 0o755 })
}

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/** `harness <args>` run by the agent in its own pane, from the run's bundle or the sources: its exit code and output. */
async function inPane(d: IsolatedDaemon, client: LocalClient, agentId: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const pane = String((await row(client, agentId))?.tmuxPane ?? '')
  expect(pane, 'the agent\'s pane').toMatch(/^%\d+$/)
  const folder = commandsOf(d, pane)
  mkdirSync(folder, { recursive: true })
  const bundle = process.env.E2E_BUNDLE_PATH
  const harness = [process.execPath, ...(bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']), ...args]
  const id = randomUUID()
  writeFileSync(join(folder, `${id}.part`), `cd ${quote(CLI_ROOT)} && exec ${harness.map(quote).join(' ')}`)
  renameSync(join(folder, `${id}.part`), join(folder, `${id}.cmd`))
  return until(`harness ${args.join(' ')} to end in the agent's pane`, () => {
    try { return JSON.parse(readFileSync(join(folder, `${id}.json`), 'utf8')) as { code: number; out: string; err: string } } catch { return null }
  }, 120_000, 100)
}

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents)
    .find((agent) => agent.id === agentId)

const ready = (client: LocalClient, agentId: string, what: string) =>
  until(what, async () => (await row(client, agentId))?.browser?.state === 'ready' || null, 60_000, 250)

async function newAgent(daemon: IsolatedDaemon, client: LocalClient, name: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, ...extra }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  return created.agent
}

/** A daemon with the fake `podman` and the engine that runs commands in its pane, and a client of it. */
async function started(onDaemon: (d: IsolatedDaemon) => void, options: Parameters<typeof IsolatedDaemon.create>[0] = {}) {
  const d = await IsolatedDaemon.create(options)
  onDaemon(d)
  const calls = writeFakePodman(d)
  // The last read of the calls, for a failed test: its root is gone by then.
  let read = ''
  const log = () => (read = readFileSync(calls, 'utf8')).split('\n').filter(Boolean)
  onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}\n---- podman calls\n${read}`) })
  writePaneRunner(d)
  await d.start()
  const client = await LocalClient.connect(d)
  return { d, client, log }
}

const OFF_LINE = 'Your browser is off. Ask your person to start it: Browser in your chat.'

/** What the fake tool server's snapshot answers. */
const TREE = '- main [ref=e1]:\n  - button "Sign in" [ref=e7]'

/** A JPEG of 1 MiB, its bytes not all the same, as the fake tool server's screenshot. */
const SHOT = (() => {
  const bytes = Buffer.alloc(1024 ** 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0)
  bytes.set([0xff, 0xd9], bytes.length - 2)
  return bytes
})()

describe('the agent browser on the real daemon', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('a plain agent: the app starts its browser, the agent drives it, the person stops it, and a delete removes it', async () => {
    const { d, client, log } = await started((created) => { daemon = created })
    const agent = await newAgent(d, client, 'plain')
    const name = `harness-browser-${agent.id}`
    const bound = await until('the agent to bind its conversation', async () => {
      const found = await row(client, agent.id)
      return found?.sessionId && found.tmuxPane ? found : null
    }, 45_000, 250)
    expect(bound.browser).toBeUndefined()

    // The person's Start, as the app sends it.
    expect(await client.request('agent_browser_start', { agentId: agent.id }, 60_000)).toMatchObject({ ok: true })
    await ready(client, agent.id, 'the browser to be ready in its frame')
    expect(log().some((line) => line.startsWith('create ') && line.includes(`--name ${name} `))).toBe(true)

    // The agent drives it from its own pane.
    const snapshot = await inPane(d, client, agent.id, ['browser', 'snapshot'])
    expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ code: 0, out: `${TREE}\n` })
    // A screenshot past the local socket's 512 KiB request limit: the whole JPEG, byte for byte, in a file.
    const shot = await inPane(d, client, agent.id, ['browser', 'screenshot'])
    expect(shot.code, JSON.stringify({ ...shot, out: shot.out.slice(0, 400) })).toBe(0)
    const path = shot.out.trim()
    expect(path).toMatch(/\/browser\/shot-\d{8}-\d{6}-\d{3}\.jpg$/)
    expect(readFileSync(path).equals(SHOT)).toBe(true)
    // The panel's size, held to the smallest window.
    expect(await client.request('agent_browser_window', { agentId: agent.id, width: 800, height: 500 }, 30_000)).toMatchObject({ width: 1024, height: 640 })

    // The person's Stop: the browser goes from the frame, and its login stays.
    expect(await client.request('agent_browser_stop', { agentId: agent.id }, 60_000)).toMatchObject({ ok: true })
    await until('the frame to have no browser', async () => (await row(client, agent.id))?.browser === undefined || null, 30_000, 250)
    await until('its container to be removed', () => log().includes(`rm --force --time 10 ${name}`) || null, 30_000, 250)
    expect(log().filter((line) => line.startsWith('volume rm'))).toEqual([])
    const off = await inPane(d, client, agent.id, ['browser', 'snapshot'])
    expect(off).toMatchObject({ code: 4, out: '', err: `${OFF_LINE}\n` })

    // Started again, with the backend unreachable and the agent in no Swarm.
    const before = log().length
    expect(await client.request('agent_browser_start', { agentId: agent.id }, 60_000)).toMatchObject({ ok: true })
    await ready(client, agent.id, 'the browser to be ready again')
    expect(log().slice(before).some((line) => line.startsWith(`create `) && line.includes(`--name ${name}`))).toBe(true)

    // A turn first, as agentBrowserPodman.e2e.ts takes before its stop: until one ends, the fake engine's conversation
    // has no opening, and a purge is held (IDENTITY_UNAVAILABLE, retryable).
    const createdAt = Date.parse(agent.createdAt)
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agent.id, 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: 'One turn before the purge' })
    await ended
    const purging = log().length
    const review = await client.request('agent_purge', { agentId: agent.id, sessionId: bound.sessionId, createdAt, mode: 'inspect' }, 60_000)
    expect(review.error, JSON.stringify(review)).toBeUndefined()
    const deleted = await client.request('agent_purge', { agentId: agent.id, sessionId: bound.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true })
    await until('its container, volume, network and secret to be removed', () => {
      const lines = log().slice(purging)
      return [`rm --force --time 10 ${name}`, `network rm ${name}`, `volume rm ${name}`, `secret rm harness-proxy-${agent.id}`]
        .every((line) => lines.includes(line)) || null
    }, 30_000, 250)
    client.close()
  })

  it('an older Desktop\'s browser:true still gives a browser', async () => {
    const { d, client, log } = await started((created) => { daemon = created })
    const agent = await newAgent(d, client, 'with-browser', { browser: true })
    await ready(client, agent.id, 'the browser to be ready in its frame')
    expect(log().some((line) => line.startsWith(`create --memory 2g --cpus 2 --pids-limit 512 --shm-size 1g --name harness-browser-${agent.id} `))).toBe(true)
    // Its settings never ride the frame.
    expect(JSON.stringify(await row(client, agent.id))).not.toContain('proxy')
    // The state file is the person's alone.
    expect(existsSync(join(d.dataDir, 'agent-browser.json'))).toBe(true)
    client.close()
  })

  it('a browser left on follows its agent', async () => {
    const { d, client: first, log } = await started((created) => { daemon = created })
    let client = first
    const agent = await newAgent(d, client, 'follows')
    const name = `harness-browser-${agent.id}`
    await until('the agent to bind its conversation', async () => (await row(client, agent.id))?.sessionId || null, 45_000, 250)
    expect(await client.request('agent_browser_start', { agentId: agent.id }, 60_000)).toMatchObject({ ok: true })
    await ready(client, agent.id, 'the browser to be ready')
    // A turn first: until one ends, the fake engine's conversation has no opening, and Stop Harness is held
    // (IDENTITY_UNAVAILABLE, retryable).
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agent.id, 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: 'One turn before the stop' })
    await ended

    // The engine restarts: the browser stays as it is.
    let mark = log().length
    expect((await client.request('agent_restart', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    await until('the agent to run again', async () => {
      const found = await row(client, agent.id)
      return found?.status === 'active' && found.sessionId && found.browser?.state === 'ready' ? found : null
    }, 60_000, 250)
    expect(log().slice(mark).filter((line) => line.startsWith('rm --force'))).toEqual([])

    // Stop Harness: its container goes, its login stays, and the agent is listed stopped.
    mark = log().length
    expect((await client.request('agent_delete', { agentId: agent.id }, 60_000)).error).toBeUndefined()
    await until('the agent to be stopped', async () => (await row(client, agent.id))?.status === 'stopped' || null, 60_000, 250)
    await until('its container to be removed', () => log().slice(mark).includes(`rm --force --time 10 ${name}`) || null, 30_000, 250)
    expect(log().filter((line) => line.startsWith('volume rm'))).toEqual([])

    // Resumed, its browser comes back with it, with no Start.
    mark = log().length
    expect((await client.request('agent_resume', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    await ready(client, agent.id, 'the browser to come back with its agent')
    expect(log().slice(mark).some((line) => line.startsWith('create ') && line.includes(`--name ${name}`))).toBe(true)

    // The daemon restarts: the browser is attached again.
    client.close()
    mark = log().length
    await d.restart()
    client = await LocalClient.connect(d)
    await ready(client, agent.id, 'the browser to be ready after the daemon restarted')
    expect(log().slice(mark).some((line) => line.startsWith('create ') && line.includes(`--name ${name}`))).toBe(true)
    client.close()
  })

  it('HARNESSD_TEST_FAULTS=agentBrowser: the service crashes and the agent keeps working', async () => {
    const { d, client } = await started((created) => { daemon = created }, { env: { HARNESSD_TEST_FAULTS: 'agentBrowser' } })
    const agent = await newAgent(d, client, 'browser-down', { browser: true })
    // The agent starts and binds as any other, and its frame says nothing of a browser nobody serves.
    const bound = await until('the agent to bind its conversation', async () => {
      const found = await row(client, agent.id)
      return found?.sessionId ? found : null
    }, 45_000, 500)
    expect(bound.browser).toBeUndefined()
    expect(await client.request('agent_browser_available', {}, 60_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'agentBrowser' })
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})

