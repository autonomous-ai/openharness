import { describe, expect, it, vi } from 'vitest'
import { keyRoutes, type KeyOps } from './keyRoutes.js'

const OK = { status: 200, body: { ok: true } }

/** Every command answering OK, and saying what it was asked. */
function commands(): Record<keyof KeyOps, ReturnType<typeof vi.fn>> {
  const names = ['pair', 'listPairs', 'revoke', 'revokeAll', 'setRemotePassword', 'clearRemotePassword', 'remotePasswordStatus', 'trustLinkedPeer',
    'groupList', 'groupSync', 'groupRemove', 'devicesList', 'devicesRemove', 'devicesHistory', 'devicesDismiss', 'devicesRebaseline']
  return Object.fromEntries(names.map((name) => [name, vi.fn(async () => OK)])) as Record<keyof KeyOps, ReturnType<typeof vi.fn>>
}
const asOps = (ops: Record<keyof KeyOps, ReturnType<typeof vi.fn>>): KeyOps => ops as unknown as KeyOps

const BAD_JSON = { status: 400, body: { error: 'bad json' } }
const key = Buffer.alloc(32, 7).toString('base64')
const machineId = 'a'.repeat(32)

describe('the keys\' routes, answered by the gateway', () => {
  it('takes only its own paths and methods, and leaves every other to the account\'s', () => {
    const routes = keyRoutes(asOps(commands()))
    for (const [method, path] of [['GET', '/api/pair'], ['POST', '/api/pairs'], ['GET', '/api/devices/remove'], ['GET', '/api/desk'], ['GET', 'toString'], ['GET', '/api/group/']]) {
      expect(routes(method, path, undefined), `${method} ${path}`).toBeNull()
    }
  })

  it('reads its lists and statuses, and runs the commands that take no body', async () => {
    const ops = commands()
    const routes = keyRoutes(asOps(ops))
    for (const [method, path, name] of [['GET', '/api/pairs', 'listPairs'], ['POST', '/api/revoke-all', 'revokeAll'], ['POST', '/api/remote-password/clear', 'clearRemotePassword'],
      ['GET', '/api/remote-password/status', 'remotePasswordStatus'], ['GET', '/api/group', 'groupList'], ['POST', '/api/group/sync', 'groupSync'],
      ['GET', '/api/devices', 'devicesList'], ['GET', '/api/devices/history', 'devicesHistory']]) {
      expect(await routes(method, path, 'not read'), path).toEqual(OK)
      expect(ops[name as keyof KeyOps], name).toHaveBeenCalledTimes(1)
    }
  })

  it('pairs and unpairs with the code and id they are given, in the door\'s words for what is missing', async () => {
    const ops = commands()
    const routes = keyRoutes(asOps(ops))
    expect(await routes('POST', '/api/pair', '{"code":"123456"}')).toEqual(OK)
    expect(ops.pair).toHaveBeenCalledWith('123456')
    expect(await routes('POST', '/api/pair', '{}')).toEqual({ status: 400, body: { error: 'MISSING_CODE' } })
    expect(await routes('POST', '/api/pair', 'nope')).toEqual(BAD_JSON)
    expect(await routes('POST', '/api/pair', undefined)).toEqual(BAD_JSON)
    expect(await routes('POST', '/api/revoke', '{"id":"AB12"}')).toEqual(OK)
    expect(ops.revoke).toHaveBeenCalledWith('AB12')
    expect(await routes('POST', '/api/revoke', '{}')).toEqual({ status: 400, body: { error: 'MISSING_ID' } })
    expect(await routes('POST', '/api/remote-password/set', '{"password":"pw"}')).toEqual(OK)
    expect(ops.setRemotePassword).toHaveBeenCalledWith('pw')
    expect(await routes('POST', '/api/remote-password/set', '{}')).toEqual({ status: 400, body: { error: 'MISSING_PASSWORD' } })
  })

  it('says a pairing\'s or a password\'s own failure in its message, and any other as an internal one, logged', async () => {
    const ops = commands()
    const log = vi.fn()
    const routes = keyRoutes(asOps(ops), log)
    ops.pair.mockRejectedValueOnce(new Error('the round timed out'))
    expect(await routes('POST', '/api/pair', '{"code":"1"}')).toEqual({ status: 500, body: { error: 'the round timed out' } })
    ops.setRemotePassword.mockRejectedValueOnce('not an error')
    expect(await routes('POST', '/api/remote-password/set', '{"password":"pw"}')).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    ops.groupSync.mockRejectedValueOnce(new Error('roster unreadable'))
    expect(await routes('POST', '/api/group/sync', undefined)).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    ops.listPairs.mockRejectedValueOnce('gone')
    expect(await routes('GET', '/api/pairs', undefined)).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    // A body of JSON that holds no record, reached for a field, as the door's catch-all answered it.
    expect(await routes('POST', '/api/pair', 'null')).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    expect(log.mock.calls).toEqual([['[gateway] POST /api/group/sync KEY_ROUTE_FAILED'], ['[gateway] GET /api/pairs KEY_ROUTE_FAILED'],
      ['[gateway] POST /api/pair KEY_ROUTE_FAILED']])
  })

  it('trusts a linked peer only with a real key and machine id, and trims its label', async () => {
    const ops = commands()
    const routes = keyRoutes(asOps(ops))
    for (const bad of [{ pub: 'x', machineId }, { pub: key, machineId: 'nope' }, { machineId }, { pub: `${key}AA`, machineId }, { pub: key }]) {
      expect(await routes('POST', '/api/link/trust-peer', JSON.stringify(bad)), JSON.stringify(bad)).toEqual({ status: 400, body: { error: 'BAD_PEER' } })
    }
    expect(await routes('POST', '/api/link/trust-peer', JSON.stringify({ pub: key, machineId, label: `  ${'n'.repeat(80)} ` }))).toEqual(OK)
    expect(await routes('POST', '/api/link/trust-peer', JSON.stringify({ pub: key, machineId, label: '   ' }))).toEqual(OK)
    expect(ops.trustLinkedPeer.mock.calls).toEqual([[{ pub: key, machineId, label: 'n'.repeat(60) }], [{ pub: key, machineId, label: machineId }]])
  })

  it('removes a group member and a device by what names them, trimmed, and refuses an empty one', async () => {
    const ops = commands()
    const routes = keyRoutes(asOps(ops))
    expect(await routes('POST', '/api/group/remove', '{"selector":" 1 "}')).toEqual(OK)
    expect(ops.groupRemove).toHaveBeenCalledWith('1')
    for (const body of ['{"selector":"  "}', '{"selector":5}', '{}']) expect(await routes('POST', '/api/group/remove', body), body).toEqual({ status: 400, body: { error: 'MISSING_SELECTOR' } })
    expect(await routes('POST', '/api/devices/remove', '{"pub":"k"}')).toEqual(OK)
    expect(ops.devicesRemove).toHaveBeenCalledWith('k')
    for (const body of ['{"pub":""}', '{"pub":5}', '{}']) expect(await routes('POST', '/api/devices/remove', body), body).toEqual({ status: 400, body: { error: 'MISSING_PUB' } })
  })

  it('rebaselines on the head the person was shown, and refuses a malformed one', async () => {
    const ops = commands()
    const routes = keyRoutes(asOps(ops))
    expect(await routes('POST', '/api/devices/rebaseline', '{"confirm":true,"head":{"seq":3,"hash":"h"}}')).toEqual(OK)
    expect(ops.devicesRebaseline).toHaveBeenLastCalledWith(true, { seq: 3, hash: 'h' })
    expect(await routes('POST', '/api/devices/rebaseline', '{"confirm":"yes"}')).toEqual(OK)
    expect(ops.devicesRebaseline).toHaveBeenLastCalledWith(false, undefined)
    for (const head of [{ seq: -1, hash: 'h' }, 'x', null, { seq: 1.5, hash: 'h' }, { seq: '1', hash: 'h' }, { seq: 1, hash: 7 }, { seq: 1, hash: 'h'.repeat(129) }]) {
      expect(await routes('POST', '/api/devices/rebaseline', JSON.stringify({ confirm: true, head })), JSON.stringify(head)).toEqual({ status: 400, body: { error: 'BAD_HEAD' } })
    }
    for (const body of ['null', '5', 'nope']) expect(await routes('POST', '/api/devices/rebaseline', body), body).toEqual(BAD_JSON)
  })

  it('dismisses what a window displayed, bounded, and asks the other devices only on a literal "It\'s mine"', async () => {
    const ops = commands()
    const routes = keyRoutes(asOps(ops))
    const dismiss = (body: unknown) => routes('POST', '/api/devices/dismiss', typeof body === 'string' ? body : JSON.stringify(body))
    for (const [body, asked] of [[{ pub: 'k' }, { pub: 'k' }], [{ baseline: true }, { baseline: true }], [{}, {}], [{ pubs: ['a', 'b'] }, { pubs: ['a', 'b'] }],
      [{ pubs: ['a'], confirm: true }, { pubs: ['a'], confirm: true }], [{ pub: 'k', confirm: 'yes', baseline: 1 }, { pub: 'k' }]] as const) {
      expect(await dismiss(body), JSON.stringify(body)).toEqual(OK)
      expect(ops.devicesDismiss).toHaveBeenLastCalledWith(asked)
    }
    for (const body of [{ pub: 5 }, { pub: '' }]) expect(await dismiss(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'MISSING_PUB' } })
    for (const body of [{ pubs: 'a' }, { pubs: ['a', 5] }, { pubs: [''] }, { pubs: ['x'.repeat(257)] }, { pubs: Array.from({ length: 257 }, (_, i) => `k${i}`) }]) {
      expect(await dismiss(body), JSON.stringify(body).slice(0, 40)).toEqual({ status: 400, body: { error: 'BAD_PUBS' } })
    }
    for (const body of ['{bad', 'null']) expect(await dismiss(body), body).toEqual(BAD_JSON)
  })

  it('says what failed on the console when not told otherwise', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ops = commands()
    ops.devicesList.mockRejectedValueOnce(new Error('private-key-fixture'))
    expect(await keyRoutes(asOps(ops))('GET', '/api/devices', undefined)).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    expect(error).toHaveBeenCalledWith('[gateway] GET /api/devices KEY_ROUTE_FAILED')
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-key-fixture')
    error.mockRestore()
  })
})
