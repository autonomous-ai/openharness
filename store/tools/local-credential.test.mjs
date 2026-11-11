// node --test store/tools/local-credential.test.mjs
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { after, test } from 'node:test'
import { daemonBridge, localCredentialHeaders } from './local-credential.mjs'
import { removeTempFolders, tempFolder } from './test-folders.mjs'

after(removeTempFolders)

// A folder too long for a socket has one under the home folder: only a home too long as well is left on the port.
process.env.HOME = `/${'h'.repeat(120)}`

const CREDENTIAL = `test-local-credential-${'a'.repeat(21)}` // the CLI's shape: 43 base64url characters

/** A data folder as the CLI leaves it: 0700, holding a 0600 `hook-credential` (or none). */
function dataDir({ credential = CREDENTIAL, mode = 0o600, folderMode = 0o700 } = {}) {
  const dir = join(tempFolder('store-tools-credential-'), 'data-'.padEnd(120, 'x'))
  mkdirSync(dir, { mode: 0o700 })
  if (credential !== null) { writeFileSync(join(dir, 'hook-credential'), `${credential}\n`, { mode: 0o600 }); chmodSync(join(dir, 'hook-credential'), mode) }
  chmodSync(dir, folderMode)
  return dir
}

test('the local credential is read the way the CLI reads it, and only then', () => {
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir() }), { 'X-Harness-Local': CREDENTIAL })
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ credential: null }) }), {})
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: join(tmpdir(), 'store-tools-no-such-folder') }), {})
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ mode: 0o644 }) }), {}, 'a file others can read is not trusted')
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ folderMode: 0o777 }) }), {}, 'nor one in a folder others can write')
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ credential: 'too-short' }) }), {})
})

// On Windows the credential never goes to the port, whose holder may be another account's: the Team account's daemon
// starts at boot, before the owner's (audit W1). The package reaches the daemon over its proven pipe instead (localDaemon.mjs).
test('on Windows no credential is read: it never goes to the port', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ mode: 0o666, folderMode: 0o777 }) }), {})
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir() }), {}, 'nor a credential the POSIX checks would pass')
})

test('where a socket can be, a check opens it and shows nothing, and only if it is private', async (t) => {
  const short = tempFolder('tools-')
  writeFileSync(join(short, 'hook-credential'), `${CREDENTIAL}\n`, { mode: 0o600 })
  chmodSync(short, 0o700)
  const env = { ADAPTER_DATA_DIR: short, HOME: '/h' }, path = join(short, 'daemon-18473.sock')
  assert.deepEqual(localCredentialHeaders(env), {})
  assert.throws(() => daemonBridge(18473, env), /missing or not private/, 'no socket: the daemon is down, and the port is not tried')
  const server = createServer()
  await new Promise(ready => server.listen(path, ready))
  t.after(() => server.close())
  chmodSync(path, 0o600)
  assert.deepEqual(daemonBridge(18473, env), { url: `ws+unix://${path}:/api/local-ws`, headers: {} })
  chmodSync(path, 0o666)
  assert.throws(() => daemonBridge(18473, env), /missing or not private/)
  assert.deepEqual(daemonBridge(18473, { ADAPTER_DATA_DIR: dataDir() }).headers, { 'X-Harness-Local': CREDENTIAL })
})

test('on Windows a check opens the daemon\'s pipe with the pipe auth, never the port, and with no pipe says Harness is not running', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  const dir = dataDir()
  assert.throws(() => daemonBridge(18473, { ADAPTER_DATA_DIR: dir }), /Harness is not running/, 'no record: the port is not tried')
  const pipe = `\\\\.\\pipe\\harness-${'a'.repeat(32)}`
  writeFileSync(join(dir, 'daemon-18473.json'), JSON.stringify({ port: 18473, pipe, pid: process.pid }))
  writeFileSync(join(dir, 'daemon-token'), `${'b'.repeat(64)}\n`)
  const bridge = daemonBridge(18473, { ADAPTER_DATA_DIR: dir })
  assert.equal(bridge.url, 'ws://localhost/api/local-ws')
  assert.deepEqual(Object.keys(bridge.headers), ['X-Harness-Auth'], 'the pipe auth, and no credential')
  assert.equal(typeof bridge.createConnection, 'function')
  assert.equal(bridge.proven('0'.repeat(64)), false, 'an answer without the daemon\'s proof is refused')
})
