/**
 * The DSH viewers in their own process, for a real harness agent on the real daemon: harnessd's master
 * runs viewers beside the core (`HARNESSD_SERVICES=viewers`, here with search too), the harness's viewer
 * server is the viewers process's own, and its URL reaches the window through the core, which keeps each
 * agent's last word for the frames it builds (core/viewersLink.ts). Whatever happens to the viewers costs
 * the viewers alone: hung or killed, the core keeps answering frames with what it last knew, agents keep
 * working, and the master starts them again, which stops the viewer server the dead process left behind
 * and starts a new one whose URL replaces the old. A core that restarts leaves the viewers to their
 * process: the viewer keeps its URL, and the new core answers with it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const HARNESS = 'e2e/sketch'
const viewerScript = (d: IsolatedDaemon) => join(d.env.DSH_DIR!, 'e2e', 'sketch', 'viewer.mjs')

/** A harness with a viewer of its own, installed in the daemon's harness folder: a small web server on
 *  the port the daemon hands it, which says which process it is. */
function installHarness(d: IsolatedDaemon): void {
  const dir = join(d.env.DSH_DIR!, 'e2e', 'sketch')
  mkdirSync(dir, { recursive: true })
  writeFileSync(viewerScript(d), [
    "import { createServer } from 'node:http'",
    "createServer((_, res) => res.end(`sketch viewer ${process.pid}`)).listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1')",
  ].join('\n') + '\n')
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({
    spec: 1, id: HARNESS, name: 'Sketch', engine: 'claude',
    // By its whole path, so a viewer server this test started is told apart from any other process.
    viewer: { command: `'${process.execPath}' '${viewerScript(d)}'`, url: 'http://127.0.0.1:${port}/' },
  }))
  writeFileSync(join(d.env.DSH_DIR!, 'installed.json'), JSON.stringify([
    { id: HARNESS, dir, source: dir, ref: null, commit: null, linked: false, installedAt: Date.now() },
  ]))
}

const processTable = (): Array<{ pid: number; command: string }> =>
  execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .map(([, pid, command]) => ({ pid: Number(pid), command }))
/** The viewer servers this daemon's harness started that are still running (and their shells). */
const viewerServers = (d: IsolatedDaemon): number[] =>
  processTable().filter(({ command }) => command.includes(viewerScript(d))).map(({ pid }) => pid)
/** A process's parents, nearest first. */
function ancestors(pid: number): number[] {
  const found: number[] = []
  for (let at = pid; found.length < 8;) {
    const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(at)]).toString().trim())
    if (!parent || parent <= 1) break
    found.push(parent)
    at = parent
  }
  return found
}

/** The viewers process the master runs now: the last one it said it started. Read from its log, never
 *  from the process table, where another daemon's viewers could be. */
const viewersPid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service viewers started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const restarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service viewers started .* restart \d+/g)].length
const ready = (d: IsolatedDaemon) => [...d.log().matchAll(/\[cli\] ready/g)].length

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, folder: string, extra: Record<string, unknown> = {}, engine = 'claude'): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true, ...extra }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
/** The viewer URL the core answers the agent's frame with, once it has one other than `previous`. */
const viewerUrl = (client: LocalClient, agentId: string, previous: string | null = null): Promise<string> =>
  until(`a viewer URL for ${agentId}${previous ? ` other than ${previous}` : ''}`, async () => {
    const url = (await row(client, agentId))?.viewerUrl
    return typeof url === 'string' && url !== previous ? url : null
  }, 60_000, 250)
/** What the viewer at `url` answers, or null when nothing serves it. */
const serves = async (url: string): Promise<string | null> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null)
  return response?.ok ? response.text() : null
}

describe('the DSH viewers in their own process', () => {
  let daemon: IsolatedDaemon | undefined
  /** Every daemon a test started, closed by the test or not: none may leave a viewer server behind. */
  const started: IsolatedDaemon[] = []
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
    // A viewer server runs in a process group of its own, and a failed test may have left one.
    for (const pid of started.splice(0).flatMap(viewerServers)) {
      try { process.kill(-pid, 'SIGKILL') } catch { /* not a group leader, or gone */ }
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  })
  const fresh = async (services: string) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: services,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    started.push(d)
    installHarness(d)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it('with HARNESSD_SERVICES=none the viewers stay in the core\'s process, as before', async () => {
    const d = await fresh('none')
    const client = await LocalClient.connect(d)
    const sketch = await create(d, client, 'sketch-default', { dsh: HARNESS })
    const answer = await serves(await viewerUrl(client, sketch.id))
    expect(answer).toMatch(/^sketch viewer \d+$/)
    expect(ancestors(Number(answer!.split(' ').pop()))).toContain(d.corePid())
    expect(viewersPid(d)).toBeNull()
    client.close()
  })

  it('a harness agent\'s viewer is the viewers process\'s, its URL reaches the window through the core, and search runs beside it', async () => {
    const d = await fresh('search,viewers')
    const client = await LocalClient.connect(d)
    await until('the viewers to connect to the core', () => d.log().includes('[services] viewers connected') || null, 30_000, 200)
    await until('search to connect to the core', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    const sketch = await create(d, client, 'sketch-one', { dsh: HARNESS })
    const url = await viewerUrl(client, sketch.id)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(await row(client, sketch.id)).toMatchObject({ dsh: HARNESS, dshName: 'Sketch', viewerName: 'Sketch Viewer' })
    // Pushed to the window on the agent's frame, not only there when it asks.
    await client.waitFor((frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === sketch.id && frame.payload.agent.viewerUrl === url,
      30_000, 'the agent\'s frame with its viewer URL')
    // A real server, and the viewers process's: the core is not among its parents.
    const answer = await serves(url)
    expect(answer).toMatch(/^sketch viewer \d+$/)
    const parents = ancestors(Number(answer!.split(' ').pop()))
    expect(parents).toContain(viewersPid(d))
    expect(parents).not.toContain(d.corePid())
    await turn(client, sketch.id, 'about the axolotl in the sketch')
    await until('search to find the harness agent\'s conversation', async () =>
      JSON.stringify(await client.request('session_search', { query: 'axolotl' }, 30_000)).includes(sketch.sessionId) || null, 60_000, 1_000)
    expect(d.coresStarted()).toBe(1)
    client.close()
    // Stopped with the daemon, it stops its viewer servers before it goes.
    await d.close()
    daemon = undefined
    await until('no viewer server to be left running', () => viewerServers(d).length === 0 || null, 10_000, 200)
  })

  it('hung, then killed, the viewers cost only themselves: frames build from what the core last knew, agents work, and the master brings them back with a new viewer', async () => {
    const d = await fresh('viewers')
    const client = await LocalClient.connect(d)
    const sketch = await create(d, client, 'sketch-killed', { dsh: HARNESS })
    const plain = await create(d, client, 'plain-codex', {}, 'codex')
    const before = await viewerUrl(client, sketch.id)
    const first = viewersPid(d)!
    // Hung: it hears nothing and says nothing. The core answers the agent's frame with what it last knew.
    process.kill(first, 'SIGSTOP')
    expect((await row(client, sketch.id))?.viewerUrl).toBe(before)
    await turn(client, plain.id, 'while the viewers were hung')
    // Killed: the master starts it again, and the new process stops the viewer server the old one left.
    process.kill(first, 'SIGKILL')
    await until('the master to restart the viewers', () => restarts(d) >= 1 || null, 30_000, 200)
    expect(viewersPid(d)).not.toBe(first)
    const after = await viewerUrl(client, sketch.id, before)
    await until('the viewer left behind to be stopped', async () => (await serves(before)) === null || null, 30_000, 250)
    expect(await serves(after)).toMatch(/^sketch viewer \d+$/)
    await client.waitFor((frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === sketch.id && frame.payload.agent.viewerUrl === after,
      30_000, 'the agent\'s frame with its new viewer URL')
    await turn(client, sketch.id, 'the harness agent never noticed')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a core that restarts leaves the viewers running: the new core answers with the same viewer', async () => {
    const d = await fresh('viewers')
    let client = await LocalClient.connect(d)
    const sketch = await create(d, client, 'sketch-core', { dsh: HARNESS })
    const url = await viewerUrl(client, sketch.id)
    const viewers = viewersPid(d)
    const core = d.corePid()!
    const wired = ready(d)
    process.kill(core, 'SIGKILL')
    await until('a new core to finish starting', () => ready(d) > wired || null, 60_000, 200)
    client.close()
    client = await LocalClient.connect(d)
    await until('the new core to answer with the same viewer', async () => (await row(client, sketch.id))?.viewerUrl === url || null, 60_000, 250)
    expect(viewersPid(d)).toBe(viewers)
    expect(restarts(d)).toBe(0)
    expect(await serves(url)).toMatch(/^sketch viewer \d+$/)
    await turn(client, sketch.id, 'after the core came back')
    client.close()
  })
})
