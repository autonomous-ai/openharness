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

// Windows reports every file as 0o666 and every folder as 0o777, so the POSIX mode checks would refuse the
// credential the daemon wrote and the daemon, which wants it on TCP there, would answer 401 (cli hookAuth.ts).
test('on Windows the credential is read whatever mode the folder and file report', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ mode: 0o666, folderMode: 0o777 }) }), { 'X-Harness-Local': CREDENTIAL })
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ credential: 'too-short', mode: 0o666 }) }), {}, 'the value is still checked')
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
