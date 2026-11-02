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
 * The client's stream is newline-delimited JSON-RPC (MCP's stdio transport). Each message becomes one POST of MCP's HTTP transport,
 * whose answer is JSON or an event stream. `initialize` goes first and alone: its answer names the session the rest carry. A
 * service's own unprompted stream (GET) is not opened, so `notifications/*_changed` are not relayed.
 */
import { SOCKET_KEY } from './bridge.js'

export const MCP_SHIM_SOURCE = String.raw`#!/usr/bin/env node
// Written by Harness (lib/connectors/mcpShimSource.ts); it is replaced at each daemon start.
import { lstatSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const NOT_RUNNING = 'Harness is not running on this computer, so this connection cannot be reached. Start it and try again.'
const UNREADABLE = "The connection's answer could not be read. Try again."
const NOT_PRIVATE = "Harness's connection socket is not private to this account, so it was not used. Restart Harness."

const [flag, socket, code, graceFlag, grace] = process.argv.slice(2)
if (flag !== '--socket' || !socket || !code) { console.error('usage: mcp-shim --socket PATH CODE'); process.exit(2) }
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
  const state = socketState()
  if (state !== 'private') { failed(state === 'absent' ? NOT_RUNNING : NOT_PRIVATE); return }
  const request = httpRequest({ socketPath: socket, method: 'POST', path,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) } },
  (answer) => {
    open.delete(request)
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
