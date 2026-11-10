/**
 * The agent browser on the real daemon (services/agentBrowser.ts), with a fake `podman` on the fixture's PATH: the real
 * Podman is never run here, another process may be using it. An agent created with Browser gets its browser and says
 * so in its frame; its purge removes its container, volume, network and proxy secret; and the service failing costs the
 * agent nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { browserAssetsHash } from '../src/services/agentBrowser/assets.js'
import { imageTag } from '../src/services/agentBrowser/image.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const GiB = 1024 ** 3

/** A `podman` that logs each argv as a line and answers what a browser's start asks; `events` streams nothing. */
function writeFakePodman(daemon: IsolatedDaemon): string {
  const calls = join(daemon.root, 'podman-calls.log')
  const image = `localhost/${imageTag(browserAssetsHash(), new Date())}`
  const script = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n')
const line = args.join(' ')
if (args[0] === 'events') { setInterval(() => {}, 1 << 30); return }
if (line.startsWith('info')) process.stdout.write(JSON.stringify({ version: { Version: '5.8.1' }, host: { memTotal: ${8 * GiB} } }))
else if (line.startsWith('images')) process.stdout.write(JSON.stringify([{ Names: [${JSON.stringify(image)}], Created: 1, Containers: 0 }]))
else if (line.startsWith('ps')) process.stdout.write('[]')
else if (line.startsWith('machine list')) process.stdout.write('[{"Running":true}]')
`
  mkdirSync(join(daemon.root, 'bin'), { recursive: true })
  writeFileSync(join(daemon.root, 'bin', 'podman'), script, { mode: 0o755 })
  appendFileSync(calls, '')
  return calls
}

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents)
    .find((agent) => agent.id === agentId)

async function browserAgent(daemon: IsolatedDaemon, client: LocalClient, name: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, browser: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  return created.agent
}

describe('the agent browser on the real daemon', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('create a browser agent, see browser ready in its frame, delete it, see remove calls', async () => {
    daemon = await IsolatedDaemon.create()
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    const calls = writeFakePodman(d)
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await browserAgent(d, client, 'with-browser')
    const name = `harness-browser-${agent.id}`
    await until('the browser to be ready in its frame', async () => (await row(client, agent.id))?.browser?.state === 'ready' || null, 60_000, 500)
    const log = () => readFileSync(calls, 'utf8')
    expect(log()).toContain(`create --memory 2g --cpus 2 --pids-limit 512 --shm-size 1g --name ${name}`)
    // Its settings never ride the frame.
    expect(JSON.stringify(await row(client, agent.id))).not.toContain('proxy')
    // The state file is the person's alone.
    expect(existsSync(join(d.dataDir, 'agent-browser.json'))).toBe(true)

    const createdAt = Date.parse(agent.createdAt)
    await until('the agent to bind its conversation', async () => (await row(client, agent.id))?.sessionId || null, 45_000, 500)
    const bound = await row(client, agent.id)
    const review = await client.request('agent_purge', { agentId: agent.id, sessionId: bound!.sessionId, createdAt, mode: 'inspect' }, 60_000)
    expect(review.error, JSON.stringify(review)).toBeUndefined()
    const deleted = await client.request('agent_purge', { agentId: agent.id, sessionId: bound!.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true })
    await until('its container, volume, network and secret to be removed', () => {
      const lines = log().split('\n')
      return [`rm --force --time 10 ${name}`, `network rm ${name}`, `volume rm ${name}`, `secret rm harness-proxy-${agent.id}`]
        .every((line) => lines.includes(line)) || null
    }, 30_000, 250)
    client.close()
  })

  it('HARNESSD_TEST_FAULTS=agentBrowser: the service crashes and the agent keeps working', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'agentBrowser' } })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    writeFakePodman(d)
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await browserAgent(d, client, 'browser-down')
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
