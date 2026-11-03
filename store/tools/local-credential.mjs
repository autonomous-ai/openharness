// The daemon's local credential, for the daemon checks here (dsh-*.mjs, experience-tests/daemon.mjs).
//
// Since Harness 0.4.21 the loopback port (REST and `/api/local-ws`) answers 401 to a process that does
// not show `X-Harness-Local: <credential>`, the 0600 `hook-credential` file in Harness's data folder
// (`ADAPTER_DATA_DIR`, default `~/.harness/cli/data`). Read with the CLI's own checks
// (cli/src/lib/hookAuth.ts `readHookCredential`); anything else is no credential and no header. On Windows
// there is none: the checks reach the daemon over its pipe (audit W1). The Store packages that talk to the
// daemon each carry the same function, by the same name.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { daemonPipe, daemonSocketPath, HARNESS_NOT_RUNNING, socketIsPrivate } from './local-daemon.mjs'

/**
 * Where a check using the `ws` package opens the daemon's bridge, and what it shows: its private socket and nothing, where one can be
 * (a holder of the TCP port would hear anything sent to it, audit H1). On Windows its pipe, with the pipe auth and a check of the
 * daemon's proof, and never the port (audit W1); `openDaemonBridge` applies that check.
 */
export function daemonBridge(port = 18473, env = process.env) {
  if (process.platform === 'win32') {
    const pipe = daemonPipe(port, env)
    if (!pipe) throw new Error(HARNESS_NOT_RUNNING)
    return { url: 'ws://localhost/api/local-ws', headers: pipe.headers, createConnection: () => connect(pipe.path), proven: pipe.proven }
  }
  const socket = daemonSocketPath(port, env)
  if (socket && !socketIsPrivate(socket)) throw new Error(`The Harness socket is missing or not private: ${socket}. Start Harness as this user.`)
  return socket ? { url: `ws+unix://${socket}:/api/local-ws`, headers: {} } : { url: `ws://127.0.0.1:${port}/api/local-ws`, headers: localCredentialHeaders(env) }
}

/**
 * The `ws` package's WebSocket (`WebSocket`) on the daemon's bridge. On the pipe an upgrade without the daemon's proof is ended before
 * `open`, so a check that sends its first frame on `open` sends whatever took the pipe's name nothing (cli pipeClient.ts).
 */
export function openDaemonBridge(WebSocket, port = 18473, env = process.env) {
  const { url, proven, ...options } = daemonBridge(port, env)
  const socket = new WebSocket(url, options)
  if (proven) socket.on('upgrade', (answer) => { if (!proven(answer.headers['x-harness-proof'])) socket.terminate() })
  return socket
}

export function localCredentialHeaders(env = process.env) {
  if (process.platform === 'win32' || daemonSocketPath(65_535, env)) return {}
  const dir = env.ADAPTER_DATA_DIR || join(homedir(), '.harness', 'cli', 'data')
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const opened = []
  try {
    const folder = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    opened.push(folder)
    const where = fstatSync(folder)
    if (!where.isDirectory() || (uid !== null && where.uid !== uid) || (where.mode & 0o022) !== 0) return {}
    const file = openSync(join(dir, 'hook-credential'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    opened.push(file)
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.size > 128 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) return {}
    const value = readFileSync(file, 'utf8').trim()
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? { 'X-Harness-Local': value } : {}
  } catch {
    return {}
  } finally {
    for (const fd of opened) closeSync(fd)
  }
}

/** What a check prints when the daemon answers its upgrade 401. */
export const CREDENTIAL_REFUSED = "Harness refused this process's local credential (hook-credential in ADAPTER_DATA_DIR, default ~/.harness/cli/data). Run this as the same OS user as Harness."
