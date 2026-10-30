/**
 * The viewers' process on demand (core/viewersWake.ts, harnessd/services.ts `viewers`: the harness viewers and the
 * Store), on the real daemon, signed out: a computer with no harness runs no viewers' process, about 96 MiB it never
 * pays, and whatever needs it starts it.
 * - Idle with no harness: no process, while the others run.
 * - A Store request, a client's rendered frame or its viewer stream: the first starts it, those that come while it
 *   starts wait with it, and each is answered by it, never refused for its never having started.
 * - A harness here: created, it asks for the process and its viewer comes up; after a restart, the core asks for it
 *   as it starts, and the viewer comes back.
 * - Named in `HARNESSD_SERVICES`, as every master before this one ran it: it starts with the daemon.
 * - From a release bundle (`E2E_BUNDLE=1`): the release's own harnesses are put in place as the core starts, and
 *   once they are, the next start asks for nothing.
 * A core too old to ask has it started as it binds: harnessd/services.spec.ts, and e2e/reexec.e2e.ts under a release.
 */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { BUNDLED_HARNESSES } from '../src/dsh/builtinIds.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const HARNESS = 'e2e/sketch'
/** A run from a release bundle, which carries the release's own harnesses (only a bundle does). */
const BUNDLED = !!process.env.E2E_BUNDLE_PATH
const ASKING = "asking for the viewers' process"

const viewerScript = (d: IsolatedDaemon) => join(d.env.DSH_DIR!, 'e2e', 'sketch', 'viewer.mjs')
const installedFile = (d: IsolatedDaemon) => join(d.env.DSH_DIR!, 'installed.json')
const installed = (d: IsolatedDaemon): Array<Record<string, unknown>> => {
  try { return JSON.parse(readFileSync(installedFile(d), 'utf8')) } catch { return [] }
}
const bundledInstalled = (d: IsolatedDaemon): boolean => {
  const records = installed(d)
  return BUNDLED_HARNESSES.every((harness) => records.some((record) =>
    record.id === harness.id && record.source === harness.source && typeof record.revision === 'string'))
}

/** A harness with a viewer of its own (a small web server on the port the daemon hands it), added to what is
 *  installed here: a bundle's own harnesses stay in place, or every start would ask for the Store again. */
function installHarness(d: IsolatedDaemon): void {
  const dir = join(d.env.DSH_DIR!, 'e2e', 'sketch')
  mkdirSync(dir, { recursive: true })
  writeFileSync(viewerScript(d), [
    "import { createServer } from 'node:http'",
    "createServer((_, res) => res.end(`sketch viewer ${process.pid}`)).listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1')",
  ].join('\n') + '\n')
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({
    spec: 1, id: HARNESS, name: 'Sketch', engine: 'claude',
    viewer: { command: `'${process.execPath}' '${viewerScript(d)}'`, url: 'http://127.0.0.1:${port}/' },
  }))
  writeFileSync(installedFile(d), JSON.stringify([
    ...installed(d).filter((record) => record.id !== HARNESS),
    { id: HARNESS, dir, source: dir, ref: null, commit: null, linked: false, installedAt: Date.now() },
  ]))
}
/** The viewer servers this daemon's harness started that are still running. */
const viewerServers = (d: IsolatedDaemon): number[] =>
  execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, , command]) => command.includes(viewerScript(d))).map(([, pid]) => Number(pid))

/** What the log says from `from` on. */
const since = (d: IsolatedDaemon, from: number) => d.log().slice(from)
const starts = (d: IsolatedDaemon, from = 0) => [...since(d, from).matchAll(/\[harnessd\] service viewers started/g)].length
const connections = (d: IsolatedDaemon, from = 0) => [...since(d, from).matchAll(/\[services\] viewers connected/g)].length

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
const viewerUrl = (client: LocalClient, agentId: string): Promise<string> =>
  until(`a viewer URL for ${agentId}`, async () => {
    const url = (await row(client, agentId))?.viewerUrl
    return typeof url === 'string' ? url : null
  }, 60_000, 250)
const serves = async (url: string): Promise<string | null> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null)
  return response?.ok ? response.text() : null
}

describe('the viewers\' process, once something needs it', () => {
  let daemon: IsolatedDaemon | undefined
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
  /** A daemon as a computer runs it from its second start on, settled: from a bundle, the first start puts the
   *  release's own harnesses in place, which asks for the Store (the last test). Returns where its log stands then. */
  const fresh = async (env: Record<string, string> = {}): Promise<{ d: IsolatedDaemon; from: number }> => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', ...env } })
    daemon = d
    started.push(d)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    if (BUNDLED) {
      await until('the release\'s harnesses in place', () => bundledInstalled(d) || null, 60_000, 250)
      await d.restart()
    }
    const from = d.log().lastIndexOf('[harnessd] core started')
    // The others are up, and the core has had time to ask for anything it would ask for as it starts.
    await until('the services to connect', () => since(d, from).includes('[services] search connected') || null, 30_000, 200)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    return { d, from }
  }

  it('runs no viewers\' process with no harness here; a Store request starts it, and the requests meanwhile wait with it', async () => {
    const { d, from } = await fresh()
    expect(starts(d, from), 'a viewers\' process on a computer with no harness').toBe(0)
    expect(since(d, from)).not.toContain(ASKING)
    const window = await LocalClient.connect(d)
    // Three while it starts, two of the Store's and one of the viewers': each waits for it and is its answer.
    const [list, again, surface] = await Promise.all([
      window.request('dsh_list', {}, 60_000),
      window.request('dsh_list', {}, 60_000),
      window.request('viewer_surface', { surfaceId: 'e2e', agentId: 'nobody', op: 'close' }, 30_000),
    ])
    expect(list.error, JSON.stringify(list)).toBeUndefined()
    expect(Array.isArray(list.dsh)).toBe(true)
    expect(again.error, JSON.stringify(again)).toBeUndefined()
    expect(surface).toMatchObject({ closed: true })
    expect(surface.error).toBeUndefined()
    expect(starts(d, from)).toBe(1)
    expect(connections(d, from)).toBe(1)
    // Started, it stays: the next request is answered by the same process.
    expect(Array.isArray((await window.request('dsh_list', {}, 60_000)).dsh)).toBe(true)
    expect(starts(d, from)).toBe(1)
    expect(d.coresStarted()).toBe(BUNDLED ? 2 : 1)
    window.close()
  })

  it('a client\'s viewer stream before it ever started starts it and is answered by the viewers, not refused for their never having started', async () => {
    const { d, from } = await fresh()
    expect(starts(d, from)).toBe(0)
    const phone = await LocalClient.connect(d)
    const streamId = randomUUID()
    const closed = phone.next((frame: Frame) => frame.type === 'viewer_close' && frame.payload?.streamId === streamId, 30_000, 'the stream\'s close')
    phone.send('viewer_request', { streamId, agentId: 'nobody', origin: 'http://127.0.0.1:9', path: '/', method: 'GET', headers: {}, upgrade: false })
    // The viewers' own answer for an agent with no viewer, once they have started and connected.
    expect((await closed).payload).toMatchObject({ streamId, error: 'Viewer is no longer available' })
    await until('the viewers to have connected', () => connections(d, from) >= 1 || null, 10_000, 100)
    expect(starts(d, from)).toBe(1)
    expect(since(d, from)).toContain(`[viewers] a viewer stream: ${ASKING}`)
    phone.close()
  })

  it('a harness created here starts it and gets its viewer; after a restart the core asks for it as it starts', async () => {
    const { d, from } = await fresh()
    installHarness(d)
    const window = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'sketch')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, dsh: HARNESS }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    // Started once, by whichever came first: the create asks the Store for the harness's workspace, then attaches it.
    expect(await serves(await viewerUrl(window, created.agent.id))).toMatch(/^sketch viewer \d+$/)
    expect(starts(d, from)).toBe(1)
    window.close()

    await d.restart()
    const after = d.log().lastIndexOf('[harnessd] core started')
    expect(since(d, after)).toContain(`[viewers] a harness here: ${ASKING}`)
    await until('the viewers to connect', () => connections(d, after) >= 1 || null, 30_000, 200)
    const again = await LocalClient.connect(d)
    await until('the harness\'s viewer back', async () => {
      const url = (await row(again, created.agent.id))?.viewerUrl
      return typeof url === 'string' && /^sketch viewer \d+$/.test(await serves(url) ?? '') || null
    }, 60_000, 250)
    again.close()
  })

  it('named in HARNESSD_SERVICES, as every master before this one ran it, it starts with the daemon with no harness here', async () => {
    const { d, from } = await fresh({ HARNESSD_SERVICES: 'search,viewers' })
    await until('the viewers to connect', () => connections(d, from) >= 1 || null, 30_000, 200)
    expect(since(d, from)).not.toContain(ASKING)
    const window = await LocalClient.connect(d)
    expect(Array.isArray((await window.request('dsh_list', {}, 60_000)).dsh)).toBe(true)
    expect(starts(d, from)).toBe(1)
    window.close()
  })

  it.skipIf(!BUNDLED)('from a release bundle, puts the release\'s own harnesses in place as the core starts, and asks nothing once they are', async () => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200' } })
    daemon = d
    started.push(d)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    expect(d.log()).toContain(`[viewers] Model Manager to put in place: ${ASKING}`)
    await until('the release\'s harnesses in place', () => bundledInstalled(d) || null, 60_000, 250)
    await d.restart()
    const from = d.log().lastIndexOf('[harnessd] core started')
    await until('the services to connect', () => since(d, from).includes('[services] search connected') || null, 30_000, 200)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    // This build's revisions are what the Store recorded (build-bundle.mjs, dsh/builtins.ts): nothing to ask for.
    expect(since(d, from)).not.toContain(ASKING)
    expect(starts(d, from)).toBe(0)
  })
})
