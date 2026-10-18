import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { LocalClient } from './harness/client.js'
import { account, signIn as signInTo, startRealBackend, type RealBackend, type Account } from './harness/realBackend.js'

const alice = account('alice'), bob = account('bob')
const times: string[] = []
let backend: RealBackend
const signIn = async (a: Account) => {
  const t = Date.now()
  const s = await signInTo(backend, a)
  times.push(`daemon ${a.name} ${Date.now() - t}ms`)
  return { d: s.daemon, machineId: s.machineId, client: s.client }
}

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('two accounts (spike)', () => {
  beforeAll(async () => { backend = await startRealBackend([alice, bob], l => times.push(l)) }, 180_000)
  afterAll(async () => {
    console.log('timings', times.join(' | '))
    // vitest hides a passing test's console output from a piped run, so a measuring loop reads this file.
    if (process.env.SPIKE_TIMINGS_FILE) appendFileSync(process.env.SPIKE_TIMINGS_FILE, `${times.join(' | ')}\n`)
    await backend?.stop()
  })

  it('signs in two accounts and shares a harness read-only from one to the other', async () => {
    const A = await signIn(alice), B = await signIn(bob)
    for (const [who, me] of [[alice, A], [bob, B]] as const) {
      await until(`${who.name} machine running`, async () => {
        const ms = (await backend.api(who, '/api/machines')).body.data.machines
        return ms.length === 1 && ms[0].machineId === me.machineId && ms[0].status === 'running'
      }, 60_000, 200)
    }
    const cwd = join(A.d.projectsDir, 'shared'); mkdirSync(cwd, { recursive: true })
    const a1 = (await A.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)).agent
    const t = Date.now()
    const inv = await A.client.request('harness_share_invite', { agentId: a1.id, emails: [bob.email], days: 7 })
    expect(inv.shares[0].pending).toBeFalsy()
    const watch = await LocalClient.connect(B.d, { tcp: true, machineId: A.machineId, shareId: inv.shares[0].id })
    const connected = watch.frames.find(f => f.type === 'connected')
    expect(connected?.payload?.readOnly).toBe(true)
    // terminal_open is answered by terminal_ready (not terminal_open_result), as terminal.e2e.ts reads it.
    const requestId = randomUUID()
    const ready = watch.next(f => f.type === 'terminal_ready' && f.payload?.requestId === requestId, 30_000, 'terminal_ready')
    watch.send('terminal_open', { requestId, protocolVersion: 3, agentId: a1.id, cols: 120, rows: 40 })
    const open = await ready
    expect(open.payload?.readOnly).toBe(true)
    expect((await watch.request('agent_delete', { agentId: a1.id })).error).toBe('VIEW_ONLY')
    times.push(`share ${Date.now() - t}ms`)
  }, 300_000)
})
