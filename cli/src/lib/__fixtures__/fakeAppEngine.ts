/**
 * A fake `ollama` or `llama-server`, for specs that start an app's engine (`appModels.ts`).
 *
 * Asked for port 0, the real engines bind a port of the system's choosing and print it in their log: Ollama 0.32.6
 * and llama.cpp 9550 did on this Mac on 2026-11-14, and this fake prints the lines they printed. It binds the port it
 * is asked for on 127.0.0.1, answers every request `200 {}` with a line in its log, and appends each start to a log
 * the spec reads back.
 * Named as the real binary, so `ps` shows the name Stop checks for.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `exits`: binds nothing, names no port and exits 1. `port-zero`: says it bound port 0, as llama.cpp before build
 *  4240 did. `split-line`: its line in two writes, cut inside the port. `early-line`: first the line llama.cpp prints
 *  before it loads the model, which names the port it was asked for. */
export type FakeEngineFault = 'exits' | 'port-zero' | 'split-line' | 'early-line'
export interface FakeEngineStart { pid: number; argv: string[]; host: string | null; port: number | null }
export interface FakeAppEngine {
  /** The fake's path: a file named `ollama` or `llama-server`, so `ps` shows the name Stop checks for. */
  binary: string
  /** Every start of the fake, oldest first: its pid, its arguments, its OLLAMA_HOST and the port it bound. */
  starts: () => FakeEngineStart[]
  /** Ends every fake still running, each by its pid, then deletes the folder. */
  dispose: () => void
}

const script = (kind: 'ollama' | 'llama.cpp', fault: FakeEngineFault | null) => `#!/usr/bin/env node
const fs = require('fs')
const http = require('http')
const path = require('path')
const kind = ${JSON.stringify(kind)}, fault = ${JSON.stringify(fault)}
const argv = process.argv.slice(2)
const host = process.env.OLLAMA_HOST ?? null
const asked = kind === 'ollama' ? Number(host.slice(host.lastIndexOf(':') + 1)) : Number(argv[argv.indexOf('--port') + 1])
const started = (port) => fs.appendFileSync(path.join(__dirname, 'starts.jsonl'), JSON.stringify({ pid: process.pid, argv, host, port }) + '\\n')
// Each where the real engine prints it: Ollama on stderr, llama.cpp on stdout.
const out = kind === 'ollama' ? process.stderr : process.stdout
const line = (port) => kind === 'ollama'
  ? 'time=2026-11-14T16:07:52.187+07:00 level=INFO source=routes.go:1990 msg="Listening on 127.0.0.1:' + port + ' (version 0.32.6)"'
  : '0.00.227.185 I srv  llama_server: server is listening on http://127.0.0.1:' + port
if (fault === 'exits') {
  started(null)
  out.write('Error: listen tcp 127.0.0.1:0: bind: operation not permitted\\n')
  process.exit(1)
}
process.on('SIGTERM', () => process.exit(0))
if (fault === 'early-line') out.write('main: HTTP server is listening, hostname: 127.0.0.1, port: 0, http threads: 9\\n')
const server = http.createServer((request, response) => {
  // A line for each request, as the real engines print one, before the answer: a spec that has its answer has the line.
  out.write((kind === 'ollama' ? '[GIN] | 200 | 127.0.0.1 | ' + request.method + ' "' + request.url + '"'
    : 'srv  log_server_r: request: ' + request.method + ' ' + request.url + ' 127.0.0.1 200') + '\\n')
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end('{}')
})
server.listen(asked, '127.0.0.1', () => {
  const port = server.address().port
  started(port)
  const said = line(fault === 'port-zero' ? 0 : port)
  if (fault !== 'split-line') return out.write(said + '\\n')
  const cut = said.indexOf('127.0.0.1:') + '127.0.0.1:'.length + 2
  out.write(said.slice(0, cut))
  setTimeout(() => out.write(said.slice(cut) + '\\n'), 300)
})
`

export function fakeAppEngine(kind: 'ollama' | 'llama.cpp', fault?: FakeEngineFault): FakeAppEngine {
  const root = mkdtempSync(join(tmpdir(), 'fake-engine-'))
  const binary = join(root, kind === 'ollama' ? 'ollama' : 'llama-server')
  writeFileSync(binary, script(kind, fault ?? null))
  chmodSync(binary, 0o755)
  const starts = (): FakeEngineStart[] => {
    try {
      return readFileSync(join(root, 'starts.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeEngineStart)
    } catch {
      return []
    }
  }
  return {
    binary,
    starts,
    dispose: () => {
      for (const { pid } of starts()) {
        // Only a pid that still runs this fake: one that has ended may belong to another process by now.
        let command = ''
        try { command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }) } catch { continue }
        if (command.includes(binary)) process.kill(pid, 'SIGKILL')
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}
