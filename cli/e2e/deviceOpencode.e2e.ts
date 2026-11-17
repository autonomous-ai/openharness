/**
 * opencode's sessions on the dial (docs/plans/2026-11-17-dial-opencode-design.md), on the real daemon: an opencode V2
 * service of the test's own (src/testing/fakeOpencode.ts), an HTTP server on loopback registered in the `service.json`
 * of the daemon's throwaway state folder, holds sessions that a fake dial on the desk lists on its own `opencode` page,
 * follows through their turns and speaks to. A service started after the dial comes with no restart, and goes when it
 * stops; after a daemon restart a tile has its last answer back as history, with no new card.
 *
 * No opencode runs. The daemon reads `$XDG_STATE_HOME/opencode/service.json` under its own home and nowhere else.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { OPENCODE_MESSAGE } from '../src/cable/hosts/opencodeClient.js'
import { fakeOpencode, type FakeOpencode, type FakeSession } from '../src/testing/fakeOpencode.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c3'.repeat(16), computerId: 'e2e-device-opencode-computer', name: 'Fixture', token: 'e2e-device-opencode-token' }
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** The service's password, which no log line may hold. */
const PASSWORD = 'e2e-opencode-word'

/** One list the dial was sent: its rows, between `agents.begin` and `agents.end`. */
function rosters(dial: FakeDial, since = 0): DialMessage[][] {
  const out: DialMessage[][] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push(rows); rows = null }
  }
  return out
}
/** The list the dial shows now, once it passes [test]. */
const showing = (dial: FakeDial, what: string, test: (rows: DialMessage[]) => boolean, since = 0, ms = 45_000): Promise<DialMessage[]> =>
  until(what, () => {
    const last = rosters(dial, since).at(-1)
    return last && test(last) ? last : null
  }, ms, 100)
const named = (name: string) => (rows: DialMessage[]) => rows.some((row) => row.host === 'opencode' && row.name === name)
const noOpencode = (rows: DialMessage[]) => !rows.some((row) => row.host === 'opencode')
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)

/** The dial speaks [words] to [agentId], and the fake backend transcribes them: what the dial hears back. */
const speak = (dial: FakeDial, relay: FakeBackend, agentId: unknown, words: string, uploadId: string): Promise<DialMessage> => {
  relay.speech = words
  const since = dial.messages.length
  dial.send({ t: 'voice.begin', agentId, uploadId, sr: 16_000, lang: 'en' })
  dial.audio(Buffer.alloc(3_200, 1))
  dial.send({ t: 'voice.end', uploadId })
  return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
}

let daemon: IsolatedDaemon | undefined
let desk: Desk | undefined
let backend: FakeBackend | undefined
const services: FakeOpencode[] = []
afterEach(async () => {
  // The services before the daemon, so its devices see opencode stop rather than a socket torn from under them.
  for (const service of services.splice(0)) await service.stop()
  await desk?.close()
  await daemon?.close()
  await backend?.close()
  daemon = undefined
  desk = undefined
  backend = undefined
})

const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk; relay: FakeBackend }> => {
  const relay = await FakeBackend.start()
  backend = relay
  relay.addMachine(ME)
  const d = await IsolatedDaemon.create({
    env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
  })
  daemon = d
  // The daemon's own state folder, made as on a computer that has one: the devices watch it for opencode's folder (P5).
  d.env.XDG_STATE_HOME = join(d.env.HOME!, '.local', 'state')
  mkdirSync(d.env.XDG_STATE_HOME, { recursive: true })
  const file = join(d.root, 'dials.json')
  d.env.HARNESSD_TEST_DIAL_PORT = file
  writeFileSync(file, '[]')
  const theDesk = new Desk(file)
  desk = theDesk
  // Signed in as ME: the session `harness login` leaves, which the core reads at start.
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
  await d.start()
  return { d, desk: theDesk, relay }
}

/** An opencode service registered in the daemon's state folder, holding [sessions]. They are set before the daemon can
 *  read the file: its first request is answered on a later turn of this event loop. */
const service = async (d: IsolatedDaemon, sessions: FakeSession[]): Promise<FakeOpencode> => {
  const opencode = await fakeOpencode({ stateDir: d.env.XDG_STATE_HOME, password: PASSWORD })
  services.push(opencode)
  for (const session of sessions) opencode.session(session)
  return opencode
}
const stopped = async (opencode: FakeOpencode): Promise<void> => {
  services.splice(services.indexOf(opencode), 1)
  await opencode.stop()
}
/** A session at rest, its last turn seen, its last answer [answer]. */
const atRest = (d: IsolatedDaemon, name: string, answer?: string): FakeSession => {
  const now = Date.now()
  return { id: `ses_${name}`, directory: join(d.projectsDir, name), updated: now - 60_000, idle: now - 60_000, viewed: now - 30_000, answer }
}

describe("opencode's sessions on the dial, from a fake opencode service", () => {
  it("opencode's sessions are on the dial's opencode page, with their turns and the dial's words", async () => {
    const { d, desk, relay } = await fresh()
    const opencode = await service(d, [atRest(d, 'api', 'All 12 tests pass.'), { id: 'ses_web', directory: join(d.projectsDir, 'web') }])
    opencode.start('ses_web')

    // 1. Both listed on the dial's own opencode page, from the service alone.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'apps' && m.shown === 'opencode'
      && (m.apps as Array<{ id: string; name: string; count: number }>).some((app) => app.id === 'opencode' && app.name === 'opencode' && app.count === 2),
    45_000, "opencode's page")
    const rows = await showing(dial, 'api and web listed', (listed) => named('api')(listed) && named('web')(listed))
    const api = rows.find((row) => row.name === 'api')!
    const web = rows.find((row) => row.name === 'web')!
    expect(api).toMatchObject({ name: 'api', engine: 'opencode', host: 'opencode', caps: 'sv' })
    expect(web).toMatchObject({ name: 'web', engine: 'opencode', host: 'opencode', caps: 'sv' })

    // 2. A turn, as opencode tells it: started, waiting on a permission, answered, done with its answer.
    let since = dial.messages.length
    opencode.start('ses_api')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === api.id, 45_000, 'its turn started', since)
    since = dial.messages.length
    const permission = opencode.ask('ses_api')
    await dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === api.id && m.text === 'Waiting for you · opencode',
      45_000, 'the waiting line', since)
    since = dial.messages.length
    opencode.reply('ses_api', permission)
    opencode.end('ses_api', 'succeeded', 'Fixed the flaky test.')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === api.id, 45_000, 'its turn done', since)
    await dial.next((m) => m.t === 'summary' && m.agentId === api.id && !m.restore && m.text === 'Fixed the flaky test.', 45_000, 'its answer', since)

    // 3. The dial's words reach the session at rest as one queued prompt, under our own message id.
    expect(await speak(dial, relay, api.id, 'run the spoken tests', 'spoken-1'))
      .toMatchObject({ t: 'voice.transcript', text: 'run the spoken tests', agentId: api.id })
    expect((await opencode.got('POST /api/session/ses_api/prompt')).body)
      .toEqual({ text: 'run the spoken tests', id: expect.stringMatching(OPENCODE_MESSAGE), delivery: 'queue' })
    await said(d, '[device] voice · opencode')

    // 4. A running session takes none, and opencode is asked nothing.
    expect(await speak(dial, relay, web.id, 'not now', 'spoken-2')).toMatchObject({ t: 'voice.error' })
    await said(d, '[device] voice · busy')
    expect(opencode.requests.filter((request) => request.method === 'POST').map((request) => request.path))
      .toEqual(['/api/session/ses_api/prompt'])

    // 5. No session id, folder, url, password or words in the log.
    const log = d.log()
    expect(log).toContain('[opencode] listed · 2 sessions')
    for (const secret of ['ses_api', 'ses_web', join(d.projectsDir, 'api'), join(d.projectsDir, 'web'), opencode.url, PASSWORD,
      'run the spoken tests', 'not now']) {
      expect(log).not.toContain(secret)
    }
  })

  it('after a daemon restart the tile has the last answer, and no new card', async () => {
    const { d, desk } = await fresh()
    const opencode = await service(d, [atRest(d, 'api', 'All 12 tests pass.')])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await showing(dial, 'api listed', named('api'))

    // 1. The daemon starts again behind the same port; the dial finds it by its own greeting.
    const since = dial.messages.length
    await d.restart()
    await dial.welcomeAfter(since)
    const api = (await showing(dial, 'api listed again', named('api'), since)).find((row) => row.name === 'api')!

    // 2. Its answer is history on the tile.
    await dial.next((m) => m.t === 'summary' && m.agentId === api.id && m.restore === true && m.text === 'All 12 tests pass.',
      45_000, 'its answer restored', since)

    // 3. Its next turn is the first card it gets: nothing told it done, or its answer as news, in between.
    opencode.start('ses_api')
    const started = await dial.next((m) => m.t === 'turn.started' && m.agentId === api.id, 45_000, 'its turn started', since)
    const between = dial.messages.slice(since, dial.messages.indexOf(started))
    expect(between.filter((m) => m.agentId === api.id && (m.t === 'turn.done' || (m.t === 'summary' && !m.restore)))).toEqual([])
  })

  it('a service started after the dial is listed with no daemon restart, and goes when it stops', async () => {
    const { d, desk } = await fresh()

    // 1. No service: the dial's first list has no opencode row.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    expect(rosters(dial).every(noOpencode)).toBe(true)

    // 2. opencode starts: the devices hear its service.json come, on the same daemon.
    const first = await service(d, [atRest(d, 'api')])
    await showing(dial, 'api listed', named('api'))

    // 3. It stops: the row goes.
    let since = dial.messages.length
    await stopped(first)
    await showing(dial, 'api gone', noOpencode, since)

    // 4. Started again: the row comes back.
    since = dial.messages.length
    await service(d, [atRest(d, 'api')])
    await showing(dial, 'api listed again', named('api'), since)
  })
})
