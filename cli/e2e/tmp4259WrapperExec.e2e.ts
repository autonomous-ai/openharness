/**
 * TEMPORARY: removed before the pull request, with .github/workflows/tmp-4259-wrapper-exec.yml.
 * #4259 on a real Linux process table: `hermes` is a wrapper that stays `hermes` for 2 s, then execs `unshare`,
 * under which the fake Hermes (e2e/harness/fakeHermes.mjs) starts only after it has "loaded".
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { fakeHermesScript } from './harness/fakeHermes.mjs'

const VERSION = 'Hermes Agent v0.23.1 (2026.11.1)'
type Agent = { id: string; status?: string }
type Saved = { agentId: string; processIdentity?: { pid: number } | null }

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

/** A started daemon whose Hermes loads for [loads] seconds under `unshare`, and one Hermes agent created on it. */
async function rig(loads: number) {
  const d = daemon = await IsolatedDaemon.create()
  onTestFailed(() => console.log(d.log()))
  d.env.HERMES_HOME = join(d.root, 'hermes')
  d.env.HERMES_PATH = join(d.root, 'bin', 'hermes')
  d.env.HOOK_INSTALL_ENGINES = 'hermes'
  mkdirSync(d.env.HERMES_HOME, { recursive: true })
  const script = join(d.root, 'hermes-script.jsonl')
  writeFileSync(script, '')
  // The fake's text without its `#!node` line, under a /bin/sh head: each line sh runs is a comment to Node, which
  // then runs this same file, so the engine the daemon finds is `node <HERMES_PATH>` (fakeHermes.mjs).
  const fake = fakeHermesScript({ version: VERSION, script }).split('\n').slice(1).join('\n')
  const sh = [
    `case "$1" in --version) echo '${VERSION}'; exit 0;; esac`,
    'sleep 2',
    `exec unshare --fork -- /bin/sh -c 'sleep ${loads} && exec "$@"' sh '${process.execPath}' "$0" "$@"`,
  ]
  writeFileSync(d.env.HERMES_PATH, `#!/bin/sh\n${sh.map((line) => `// 2>/dev/null; ${line}`).join('\n')}\n${fake}`, { mode: 0o755 })
  const cwd = join(d.projectsDir, 'p1')
  mkdirSync(cwd, { recursive: true })
  await d.start()
  const connect = async () => { client?.close(); return client = await LocalClient.connect(d) }
  const created = await (await connect()).request('agent_create', { engine: 'hermes', cwd }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  const pane = String(created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane)
  const boundPid = () => (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Saved[])
    .find((row) => row.agentId === agentId)?.processIdentity?.pid
  /** The pid the new-pane watcher bound: the wrapper's, while it was still `hermes`. */
  const wrapper = await until('the wrapper bound', () => boundPid(), 30_000, 50)
  const loaded = async () => {
    await until('the fake Hermes', async () => (await d.capture(pane)).includes('fake-hermes-ready') || null, 120_000, 100)
    return until('the agent on the engine', () => { const pid = boundPid(); return pid && pid !== wrapper ? pid : null }, 30_000, 100)
  }
  const agents = async () => (await client!.request<{ agents: Agent[] }>('agents_list', { includeStopped: true })).agents
  return { d, connect, agentId, wrapper, loaded, agents }
}
const ps = (field: 'comm' | 'ppid', pid: number) => execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()

describe.runIf(process.platform === 'linux')('an agent launched through a wrapper that execs into another name', () => {
  it('stays while its engine loads, moves to the engine, and is stopped when the engine ends', async () => {
    const r = await rig(15)
    const engine = await r.loaded()
    // The scenario's own ground: what was bound first is `unshare` now, and the engine is its child.
    expect(ps('comm', r.wrapper)).toBe('unshare')
    expect(ps('ppid', engine)).toBe(String(r.wrapper))
    expect((await r.agents()).map((agent) => [agent.id, agent.status === 'stopped'])).toEqual([[r.agentId, false]])
    expect(r.d.log()).not.toMatch(/retained · engine process absent/)
    process.kill(engine)
    await until('the agent stopped', async () => (await r.agents()).find((agent) => agent.id === r.agentId)?.status === 'stopped' || null, 60_000, 250)
  })

  it('is kept by a daemon that restarts while only the wrapper\'s process is in its pane', async () => {
    const r = await rig(40)
    await until('the wrapper\'s exec', () => ps('comm', r.wrapper) === 'unshare' || null, 15_000, 100)
    await r.d.stop()
    const mark = r.d.log().length
    await r.d.start()
    await r.connect()
    const engine = await r.loaded()
    expect(ps('ppid', engine)).toBe(String(r.wrapper))
    expect(r.d.log().slice(mark)).not.toContain('its engine exited while the daemon was down')
    expect((await r.agents()).map((agent) => [agent.id, agent.status === 'stopped'])).toEqual([[r.agentId, false]])
  })
})
