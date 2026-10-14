import { expect, it } from 'vitest'
import { parseNativeLaunchAllocation } from './nativeLaunchAllocation.js'

const engine = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: 42 }
const fixture = () => ({ pane: '%7', rootPid: 10, token: 'original-launch-token', owner: 'a'.repeat(16),
  root: { ...engine, pid: 10, birth: '1000' }, endpoint: { binary: '/fixture/tmux', socket: '/fixture/socket',
    server: { ...engine, pid: 9, birth: '900' } } })

it('copies and freezes the full original pane association', () => {
  const source = fixture(), saved = parseNativeLaunchAllocation(source, engine)!
  expect(saved).toEqual(source)
  for (const value of [saved, saved.root, saved.endpoint, saved.endpoint.server]) expect(Object.isFrozen(value)).toBe(true)
  source.root.birth = '9999'; source.endpoint.server.birth = '9999'; source.endpoint.socket = '/another/socket'
  expect(saved).toEqual(fixture())
})

it.each(['null', 'array', 'extra', 'pane', 'rootPid', 'token', 'owner', 'root-extra', 'root-missing', 'root-birth',
  'root-boot', 'root-namespace', 'root-engine', 'server-engine', 'server-root', 'server-birth', 'server-boot', 'server-namespace',
  'server-extra', 'endpoint-extra', 'endpoint-missing', 'relative-binary', 'relative-socket', 'long-socket', 'nul-binary', 'newline-socket',
])('rejects %s pane provenance', change => {
  let value: any = fixture()
  if (change === 'null') value = null
  if (change === 'array') value = []
  if (change === 'extra') value.extra = true
  if (change === 'pane') value.pane = '%1; kill-server'
  if (change === 'rootPid') value.rootPid = 11
  if (change === 'token') value.token = 'short'
  if (change === 'owner') value.owner = 'invalid'
  if (change === 'root-extra') value.root.extra = true
  if (change === 'root-missing') delete value.root
  if (change === 'root-birth') value.root.birth = '001'
  if (change === 'root-boot') value.root.boot = value.root.boot.replace('aaaa', 'bbbb')
  if (change === 'root-namespace') value.root.namespace = 'linux:4:6'
  if (change === 'root-engine') value.root.pid = value.rootPid = engine.pid
  if (change === 'server-engine') value.endpoint.server.pid = engine.pid
  if (change === 'server-root') value.endpoint.server.pid = value.rootPid
  if (change === 'server-birth') value.endpoint.server.birth = '001'
  if (change === 'server-boot') value.endpoint.server.boot = value.root.boot.replace('aaaa', 'bbbb')
  if (change === 'server-namespace') value.endpoint.server.namespace = 'linux:4:6'
  if (change === 'server-extra') value.endpoint.server.extra = true
  if (change === 'endpoint-extra') value.endpoint.extra = true
  if (change === 'endpoint-missing') delete value.endpoint
  if (change === 'relative-binary') value.endpoint.binary = 'tmux'
  if (change === 'relative-socket') value.endpoint.socket = 'socket'
  if (change === 'long-socket') value.endpoint.socket = '/' + 'a'.repeat(4096)
  if (change === 'nul-binary') value.endpoint.binary += '\0'
  if (change === 'newline-socket') value.endpoint.socket += '\n'
  expect(parseNativeLaunchAllocation(value, engine)).toBeNull()
})

it('does not enrich a legacy witness without its original PID namespace', () => {
  expect(parseNativeLaunchAllocation(fixture(), { boot: engine.boot, pid: engine.pid })).toBeNull()
})

it('rejects a coherent foreign pane and server scope', () => {
  for (const scope of [{ boot: engine.boot.replace('aaaa', 'bbbb') }, { namespace: 'linux:4:6' }]) {
    const value = fixture()
    Object.assign(value.root, scope); Object.assign(value.endpoint.server, scope)
    expect(parseNativeLaunchAllocation(value, engine)).toBeNull()
  }
})
