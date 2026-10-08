/** A connected shell opens through the service, with literal arguments and the terminal's existing access rules. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { SHELL_REQUESTS } from '../src/lib/shellProtocol.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

function shell(d: IsolatedDaemon) {
  const cwd = join(d.projectsDir, 'folder with spaces')
  mkdirSync(cwd, { recursive: true })
  const marker = join(cwd, 'argv.txt')
  const script = join(cwd, 'start shell.sh')
  // The caller sends only a path and literal arguments. This fixture writes what the shell received,
  // then becomes an interactive shell so the client can attach and type through the real stream.
  writeFileSync(script, 'marker="$1"\nshift\nprintf "%s\\n" "$PWD" "$@" > "$marker"\nexec /bin/sh -i\n')
  const args = ['a b', '$(touch injected)', '; touch injected', "quote'and\"quote", '']
  return { cwd, marker, args, payload: { creationId: randomUUID(), cwd, argv: ['/bin/sh', script, marker, ...args] } }
}
async function written(fixture: ReturnType<typeof shell>) {
  await until('the shell to record its literal arguments', () => existsSync(fixture.marker) || null, 15_000, 50)
  const [cwd, ...args] = readFileSync(fixture.marker, 'utf8').split('\n')
  expect(realpathSync(cwd)).toBe(realpathSync(fixture.cwd))
  expect(args).toEqual([...fixture.args, ''])
  expect(existsSync(join(fixture.cwd, 'injected'))).toBe(false)
}

describe('opening connected shells', () => {
  let daemon: IsolatedDaemon | undefined
  let world: PhoneMachine | undefined
  const clients: Array<{ close(): void }> = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await daemon?.close(); daemon = undefined
    await world?.close(); world = undefined
  })

  it('opens a local shell while a client is connected, accepts terminal input and recovers the same launch after reconnect', async () => {
    daemon = await IsolatedDaemon.create()
    const d = daemon
    onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
    await d.start()
    const client = await LocalClient.connect(d); clients.push(client)
    const fixture = shell(d)
    expect(await client.request('shell_capabilities')).toMatchObject({ protocol: 1 })
    const created = await client.request('shell_open', fixture.payload)
    expect(created).toMatchObject({ state: 'created', agent: { engine: 'terminal', terminal: { available: true } } })
    await written(fixture)
    const requestId = randomUUID()
    const attached = client.next(f => ['terminal_ready', 'terminal_error'].includes(f.type) && f.payload?.requestId === requestId)
    client.send('terminal_open', { requestId, protocolVersion: 3, agentId: created.agent.id, cols: 100, rows: 30 })
    const ready = await attached
    expect(ready.type, JSON.stringify(ready)).toBe('terminal_ready')
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId: ready.payload!.streamId, seq: 0, compressed: false,
      bytes: Buffer.from('printf shell-input-ok > input.txt\r') })
    await until('the shell to receive input from its attached view', () => existsSync(join(fixture.cwd, 'input.txt')) || null, 20_000, 100)
    expect(readFileSync(join(fixture.cwd, 'input.txt'), 'utf8')).toBe('shell-input-ok')
    // Kill only the edge child recorded by this fixture's master. The existing terminal stream belongs
    // to the core and must survive, while the restarted service recovers the same durable launch.
    await until('the shell service to connect', () => d.log().includes('[services] shell connected') || null, 30_000)
    const connects = d.log().split('[services] shell connected').length
    const edgePid = Number([...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)].at(-1)?.[1])
    expect(Number.isInteger(edgePid) && edgePid > 0).toBe(true)
    const processRow = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(edgePid)], { encoding: 'utf8' }).trim()
    expect(processRow).toMatch(new RegExp(`^${d.pid}\\s+harnessd-edge$`))
    process.kill(edgePid, 'SIGKILL')
    await until('shell receipts to reconnect after the edge crash', () => d.log().split('[services] shell connected').length > connects || null, 30_000)
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId: ready.payload!.streamId, seq: 1, compressed: false,
      bytes: Buffer.from('printf still-connected > after-crash.txt\r') })
    await until('the existing stream to keep writing after the service crash', () => existsSync(join(fixture.cwd, 'after-crash.txt')) || null, 20_000)
    expect(readFileSync(join(fixture.cwd, 'after-crash.txt'), 'utf8')).toBe('still-connected')
    expect(d.coresStarted()).toBe(1)
    client.close()
    const again = await LocalClient.connect(d); clients.push(again)
    expect(await again.request('shell_open_status', fixture.payload)).toMatchObject({ state: 'created', agent: { id: created.agent.id } })
    expect(await again.request('shell_open', fixture.payload)).toMatchObject({ state: 'created', agent: { id: created.agent.id } })
    expect((await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')).split('\n')).toHaveLength(1)
  })

  it('opens remotely through a sealed owner connection, answers only its requester and refuses every unsealed shell request', async () => {
    world = await startPhoneMachine()
    const w = world
    const d = w.machine.daemon
    onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
    const options = { backend: w.backend, machineId: w.machine.machineId, machinePub: w.machine.identity.pub, ...w.phone }
    // The machine on the relay first, as a phone finds it: a hello sent before then reaches nobody, and the
    // relay client here does not say it again (gatewayProcess.e2e.ts waits the same way). The services'
    // processes start together, so the gateway's link can come up a moment after the core says it is ready.
    await until('the machine to be on the relay', () => w.backend.nodeUp(w.machine.machineId) || null, 30_000)
    const phone = new RelayPhone(options); clients.push(phone); await phone.open()
    const witness = new RelayPhone(options); clients.push(witness); await witness.open()
    const fixture = shell(d)
    expect(await phone.request('shell_capabilities')).toMatchObject({ protocol: 1 })
    const created = await phone.request('shell_open', fixture.payload)
    expect(created).toMatchObject({ state: 'created', agent: { engine: 'terminal', terminal: { available: true } } })
    await written(fixture)
    expect(await phone.request('shell_open_status', fixture.payload)).toMatchObject({ state: 'created', agent: { id: created.agent.id } })
    expect(await phone.request('shell_visit_status', { agentId: created.agent.id })).toMatchObject({ exited: false })
    expect(await phone.request('shell_open', { ...fixture.payload, creationId: randomUUID(), command: 'echo unsafe' })).toMatchObject({ error: 'INVALID_ARGV' })
    for (const type of SHELL_REQUESTS) {
      const requestId = randomUUID()
      w.backend.injectDown(w.machine.machineId, phone.connId!, { type, payload: { ...fixture.payload, creationId: randomUUID(), requestId } })
      const refused = await phone.waitFor(f => f.type === `${type}_result` && f.payload?.requestId === requestId)
      expect(refused.payload).toMatchObject({ error: 'E2EE_REQUIRED' })
    }
    // A subsequent answer is a barrier on the same connection, so the witness assertion needs no sleep.
    await witness.request('agents_list')
    const results = w.backend.webReceived.get(phone.connId!)!.filter(f => SHELL_REQUESTS.some(type => f.type === `${type}_result`))
    expect(results.length).toBeGreaterThan(4)
    expect(results.every(f => f.payload?.__e2e?.k === 'p')).toBe(true)
    expect(witness.frames.some(f => SHELL_REQUESTS.some(type => f.type === `${type}_result`))).toBe(false)
    expect(JSON.stringify(w.backend.webSent.get(phone.connId!))).not.toContain(fixture.cwd)
    expect((await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')).split('\n')).toHaveLength(1)
  })

  it('answers unavailable when the service cannot start, while the core continues serving agents', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'shell' } })
    await daemon.start()
    const client = await LocalClient.connect(daemon); clients.push(client)
    for (const type of SHELL_REQUESTS) expect(await client.request(type)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'shell' })
    expect(await client.request('agents_list')).toHaveProperty('agents')
    expect(daemon.coresStarted()).toBe(1)
  })
})
