/**
 * What an MCP client runs to reach a connection (follow-up of audit H1, docs/plans/2026-11-02-connections-bridge-stdio-shim-plan.md).
 * A client on a loopback address talks to whoever holds that port, so another account that took it could read its tool calls and
 * feed false answers to the owner's running agents. This talks stdio to the client and HTTP to the bridge over its 0600 socket. It
 * holds no key, as reaching that socket is the credential, and it never falls back to a port: with the socket gone the daemon is
 * down, and the client is told so.
 *
 * Its own small script, written into the vault's private folder as lib/buddyGuard.ts writes its guard, for three reasons found in
 * review of #2558. An entry naming the running script would name the lean bundle from the daemon, which has no CLI, and from any
 * `harness connections` a worktree that may be removed. An entry naming cli.js would load all of it, about 45 MiB, once per
 * connection per agent. And the updater ships only cli.js and notify.mjs, so a third file there would need its manifest changed.
 * Node's built-ins only: nothing else is beside it.
 *
 * On Windows there is no socket: the shim reaches the bridge's pipe (bridge.ts serveBridgePipe, task #2162), named in a record in
 * the vault's private folder (`--pipe <record>`). Node cannot set a pipe's DACL, so reaching it proves nothing, and once the bridge
 * is gone any account can make a pipe of its name: the shim dials it only while the recorded process runs as this account, proves
 * the record's token without sending it, and relays no answer that does not prove the token back (lib/windows/pipeAuth.ts).
 *
 * The client's stream is newline-delimited JSON-RPC (MCP's stdio transport). Each message becomes one POST of MCP's HTTP transport,
 * whose answer is JSON or an event stream. `initialize` goes first and alone: its answer names the session the rest carry. A
 * service's own unprompted stream (GET) is not opened, so `notifications/*_changed` are not relayed.
 */
import { PIPE_AUTH_HEADER, PIPE_PROOF_HEADER } from '../windows/pipeAuth.js'
import { SOCKET_KEY } from './bridge.js'

export const MCP_SHIM_SOURCE = String.raw`#!/usr/bin/env node
// Written by Harness (lib/connectors/mcpShimSource.ts); it is replaced at each daemon start.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const NOT_RUNNING = 'Harness is not running on this computer, so this connection cannot be reached. Start it and try again.'
const UNREADABLE = "The connection's answer could not be read. Try again."
const NOT_PRIVATE = "Harness's connection socket is not private to this account, so it was not used. Restart Harness."
const UNPROVEN = "Something other than Harness answered on its connection pipe, so its answer was not used. Restart Harness."

const [flag, socket, code, graceFlag, grace] = process.argv.slice(2)
// --pipe names the bridge's pipe record on Windows (lib/connectors/bridge.ts serveBridgePipe), --socket its 0600 socket elsewhere.
const piped = flag === '--pipe'
if ((flag !== '--socket' && !piped) || !socket || !code) { console.error('usage: mcp-shim --socket PATH CODE | --pipe RECORD CODE'); process.exit(2) }
// How long open requests get once the client has gone, so a hung stream does not leave a process behind.
const graceMs = graceFlag === '--grace-ms' ? Number(grace) : 5000
const path = '/${SOCKET_KEY}/' + encodeURIComponent(code) + '/mcp'

// Whether the socket is what the daemon made: 0600, this account's, in a folder only this account can write to.
function socketState() {
  try {
    const uid = process.getuid?.()
    const file = lstatSync(socket), folder = lstatSync(dirname(socket))
    if (!file.isSocket() || (file.mode & 0o777) !== 0o600 || !folder.isDirectory() || (folder.mode & 0o022) !== 0) return 'open'
    return uid !== undefined && (file.uid !== uid || folder.uid !== uid) ? 'open' : 'private'
  } catch (error) {
    return error.code === 'ENOENT' ? 'absent' : 'open'
  }
}

// Mirrors LOCAL_PIPE_RE and isPipePath in lib/windows/pipeAuth.ts: on Windows a pipe on this computer named harness-<id>, never
// another computer's (an SMB connection that can carry this user's sign-in); elsewhere only the tests make one, a socket so named.
const PIPE_RE = process.platform === 'win32' ? /^\\\\\.\\pipe\\harness-([0-9a-f]{32})$/ : /(?:^|\/)harness-([0-9a-f]{32})$/

// The bridge's pipe, read from its record for each request so a bridge that restarted under a new name is followed; null when
// there is nothing to dial. The record must be a plain file (not a link), the very one opened, and private to this account where
// the system says so. The bridge is this account's, so a pid that is gone or answers EPERM (another account's process, one that
// took the pid since) means no bridge: a pipe of its name may be anyone's.
function pipeTarget() {
  let fd = null
  try {
    const seen = lstatSync(socket, { bigint: true })
    if (!seen.isFile() || seen.size > 4096n) return null
    fd = openSync(socket, 'r')
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino) return null
    const uid = process.getuid?.()
    if (process.platform !== 'win32' && ((opened.mode & 0o077n) !== 0n || (uid !== undefined && opened.uid !== BigInt(uid)))) return null
    const record = JSON.parse(readFileSync(fd, 'utf8'))
    const id = typeof record?.pipe === 'string' ? PIPE_RE.exec(record.pipe)?.[1] : null
    if (!id || typeof record.token !== 'string' || !/^[0-9a-f]{64}$/.test(record.token)) return null
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return null
    try { process.kill(record.pid, 0) } catch { return null }
    return { pipe: record.pipe, id, token: Buffer.from(record.token, 'hex') }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
const mac = (token, separator, nonce) => createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
const proven = (proof, token, nonce) => {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(mac(token, 0x00, nonce), 'hex'))
}

// A client that went away closes this stream: nothing more to say, and no reason to fall over saying it.
process.stdout.on('error', () => {})
let closing = false
const say = (message) => { if (!closing) process.stdout.write(JSON.stringify(message) + '\n') }
const refuse = (id, errorCode, message) => say({ jsonrpc: '2.0', id, error: { code: errorCode, message } })
let session, version
// The client's initialize and what it sent after, to open a new session when the service forgets this one.
let opening = null, opened = null
const open = new Set()

// One answer: JSON, or an event stream whose every data is a message of its own. quiet: for this shim alone.
const relay = (answer, sent, quiet) => new Promise((resolve, reject) => {
  const header = answer.headers['mcp-session-id']
  if (typeof header === 'string') session = header
  const status = answer.statusCode ?? 500
  const streaming = String(answer.headers['content-type'] ?? '').includes('text/event-stream')
  const asked = sent.method !== undefined && sent.id !== undefined
  let held = '', answered = false
  const take = (raw) => {
    let message
    // Not ours to read, a service's keep-alive say: it must not end the client's connection.
    try { message = JSON.parse(raw) } catch { return }
    answered ||= message.id === sent.id
    if (sent.method === 'initialize' && typeof message.result?.protocolVersion === 'string') version = message.result.protocolVersion
    if (!quiet) say(message)
  }
  // An event ends at a blank line; its data lines joined are its message.
  const events = () => {
    for (let at = held.search(/\r?\n\r?\n/); at >= 0; at = held.search(/\r?\n\r?\n/)) {
      const event = held.slice(0, at)
      held = held.slice(at).replace(/^\r?\n\r?\n/, '')
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (data) take(data)
    }
  }
  answer.setEncoding('utf8')
  answer.on('data', (chunk) => { held += chunk; if (streaming) events() })
  answer.on('error', reject)
  answer.on('end', () => {
    if (streaming) { held += '\n\n'; events() }
    else if (held.trim() && status < 300) take(held)
    else if (status >= 300 && asked) {
      // The bridge's refusal names no request: this one is what it answers.
      let reason = 'The connection answered ' + status + '.'
      try { reason = JSON.parse(held).error?.message ?? reason } catch { /* not its JSON */ }
      if (!quiet) refuse(sent.id, -32001, reason)
      answered = true
    }
    // A client would wait for ever on a request nothing answered.
    if (asked && !answered && !quiet) refuse(sent.id, -32001, UNREADABLE)
    resolve()
  })
})

// One POST; its status, or 0 when none came.
const post = (raw, sent, quiet = false, retried = false) => new Promise((resolve) => {
  const asked = sent.method !== undefined && sent.id !== undefined
  const failed = (reason) => { if (asked && !quiet) refuse(sent.id, -32001, reason); resolve(0) }
  let target = null, nonce = null
  if (piped) {
    target = pipeTarget()
    if (!target) { failed(NOT_RUNNING); return }
    nonce = target.id + randomBytes(16).toString('hex')
  } else {
    const state = socketState()
    if (state !== 'private') { failed(state === 'absent' ? NOT_RUNNING : NOT_PRIVATE); return }
  }
  const request = httpRequest({ socketPath: target ? target.pipe : socket, method: 'POST', path,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}),
      ...(target ? { '${PIPE_AUTH_HEADER}': nonce + '.' + mac(target.token, 0x01, nonce) } : {}) } },
  (answer) => {
    open.delete(request)
    // Before anything of it is read: an answer that is not the bridge's never reaches the client.
    if (target && !proven(answer.headers['${PIPE_PROOF_HEADER}'], target.token, nonce)) {
      request.destroy()
      failed(UNPROVEN)
      return
    }
    // The service forgot the session (it restarted, or it expired). An HTTP client opens another on a 404; a stdio client
    // cannot know to, so an agent running for days would lose this connection until it restarts.
    if (answer.statusCode === 404 && session && !retried && sent.method !== 'initialize' && opening) {
      answer.resume()
      reopen().then((ok) => {
        if (ok) post(raw, sent, quiet, true).then(resolve)
        else failed(code + ' could not be reached. Try again.')
      })
      return
    }
    relay(answer, sent, quiet).then(() => resolve(answer.statusCode ?? 0), () => failed(UNREADABLE))
  })
  open.add(request)
  request.on('error', () => { open.delete(request); failed(closing ? UNREADABLE : NOT_RUNNING) })
  request.end(raw)
})

// A new session from the client's own initialize, its answer kept to this shim. Requests that fail together share it.
let reopening = null
const reopen = () => reopening ??= (async () => {
  session = undefined
  // Each marked as retried: a 404 here must not wait on the very reopen that sent it.
  const status = await post(opening, JSON.parse(opening), true, true)
  if (status >= 300 || status === 0) return false
  if (opened) await post(opened, JSON.parse(opened), true, true)
  return true
})().finally(() => { reopening = null })

const running = new Set()
let first = null
for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!raw.trim()) continue
  let sent
  try {
    sent = JSON.parse(raw)
    if (!sent || typeof sent !== 'object') throw new Error('not a message')
  } catch { refuse(null, -32700, 'That line is not JSON.'); continue }
  // initialize alone: nothing else goes until its answer has named the session. Its notification goes in order too.
  if (first) await first
  if (sent.method === 'initialize') opening = raw
  else if (sent.method === 'notifications/initialized') opened = raw
  const send = post(raw, sent)
  if (sent.method === 'initialize' || sent.id === undefined) first = send
  running.add(send)
  send.finally(() => { running.delete(send) })
}
// The client has gone. What is open gets a moment; a hung stream must not keep this process.
await Promise.race([Promise.all(running), new Promise((resolve) => { setTimeout(resolve, graceMs).unref() })])
closing = true
process.exit(0)
`
