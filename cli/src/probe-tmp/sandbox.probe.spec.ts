import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
const claudeBin = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
interface Call { name: string; input: Record<string, unknown> }
interface Result { is_error?: boolean; content: string }
/** Answers Claude Code's requests in the Messages API's streaming shape: each tool call in turn, then "done". [started]
 *  runs once, at the conversation's first request: Claude Code is up by then, and has run nothing yet. */
function fakeModel(calls: Call[], started: () => void = () => {}) {
  const results = new Map<string, Result>()
  const bodies: string[] = []
  const startedAt: string[][] = []
  let step = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return
      }
      bodies.push(body)
      const json = JSON.parse(body || '{}')
      const last = json.messages?.at(-1)
      if (!startedAt.length && Array.isArray(json.tools) && json.tools.length > 0) { startedAt.push([]); started() }
      for (const block of Array.isArray(last?.content) ? last.content : []) {
        if (block.type !== 'tool_result') continue
        const content = typeof block.content === 'string' ? block.content
          : (block.content as { text?: string }[]).map((part) => part.text ?? '').join('')
        results.set(block.tool_use_id, { is_error: block.is_error, content })
      }
      // Only the conversation itself has tools; Claude Code's own side requests (a title, a summary) get plain text.
      const main = Array.isArray(json.tools) && json.tools.length > 0
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: json.model,
        content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      if (main && step < calls.length) {
        const call = calls[step++]
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step}`, name: call.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      }
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  return { server, results, bodies, started: () => startedAt.length > 0, id: (call: Call) => `toolu_${calls.indexOf(call) + 1}` }
}


const OUT = process.env.PROBE_OUT!
it('probes the sandbox', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-')))
  const folder = join(root, 'buddy'), home = join(root, 'home'), scratch = join(root, 'scratch')
  for (const d of [folder, home, join(home, '.ssh'), scratch, join(root, 'config')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_x'), 'KEY')
  writeFileSync(join(home, 'ok.txt'), 'OK')
  const hits: string[] = []
  const local: Server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end('local-ok') })
  await new Promise<void>(r => local.listen(0, '127.0.0.1', r))
  const lp = (local.address() as AddressInfo).port
  const sb = JSON.parse(process.env.PROBE_SANDBOX!.replaceAll("HOME", process.env.PROBE_REAL_HOME || home).replaceAll("SCRATCH", scratch).replaceAll("FOLDER", folder))
  const bash = (command: string): Call => ({ name: 'Bash', input: { command, description: 'p' } })
  const calls = [
    bash(`curl -s -m 5 http://127.0.0.1:${lp}/get`),
    bash(`curl -s -m 5 -X POST -d x http://127.0.0.1:${lp}/post`),
    bash(`/usr/bin/env node -e "fetch('http://127.0.0.1:${lp}/node').then(r=>r.text()).then(console.log,e=>console.log('ERR',e.cause?.code||e.message))"`),
    bash('curl -s -m 8 -o /dev/null -w %{http_code} https://example.com/'),
    bash('curl -s -m 8 -o /dev/null -w %{http_code} https://api.github.com/zen'),
    bash(`touch ${home}/written`),
    bash(`touch ${scratch}/x && echo wrote-scratch`),
    bash(`touch ${folder}/x && echo wrote-folder`),
    bash(`cat ${home}/.ssh/id_x`),
    bash(`cat ${home}/ok.txt`),
    { name: 'Bash', input: { command: `cat ${home}/.ssh/id_x`, description: 'p', dangerouslyDisableSandbox: true } },
  ]
  if (process.env.PROBE_CMDS) calls.splice(0, calls.length, ...JSON.parse(process.env.PROBE_CMDS).map((c: string) => bash(c)))
  const api = fakeModel(calls)
  await new Promise<void>(r => api.server.listen(0, '127.0.0.1', r))
  mkdirSync(join(folder, '.claude'))
  writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: ['Bash'] }, sandbox: sb }))
  const env = { PATH: `${process.env.PROBE_NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.PROBE_REAL_HOME || home, SHELL: '/bin/bash', CLAUDE_CONFIG_DIR: join(root, 'config'),
    ANTHROPIC_API_KEY: 'sk-ant-not-a-key-0123456789abcdefghij', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, DISABLE_AUTOUPDATER: '1', TMPDIR: root }
  let out = '', err = ''
  const c = spawn(claudeBin, ['-p', 'go', '--permission-mode', 'dontAsk', '--setting-sources', 'local', '--strict-mcp-config', '--model', 'claude-sonnet-4-5', '--output-format', 'json'], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stdout.on('data', d => { out += d }); c.stderr.on('data', d => { err += d })
  await new Promise<void>(r => c.on('close', () => r()))
  calls.forEach((call, i) => appendFileSync(OUT, `${call.input.dangerouslyDisableSandbox ? '[unsandboxed] ' : ''}${call.input.command}\n  => ${JSON.stringify(api.results.get(`toolu_${i + 1}`)).slice(0, 300)}\n`))
  appendFileSync(OUT, `local hits: ${JSON.stringify(hits)}\nstderr: ${err.slice(0, 500)}\nresult: ${out.slice(0, 300)}\n`)
}, 180_000)
