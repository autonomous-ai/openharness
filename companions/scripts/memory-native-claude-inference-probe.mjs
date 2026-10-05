// Run from cli: node --import tsx scripts/memory-native-claude-inference-probe.mjs
// Actual production adapter and installed Claude binary, with only its environment redirected
// by a disposable launcher. Fake credentials and localhost responses; no live account or model.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runClaudeMemoryInference } from '../src/memory/claudeInference.ts'

const binary = execFileSync('/usr/bin/which', [process.env.CLAUDE_PATH || 'claude'], { encoding: 'utf8' }).trim()
const fixture = await mkdtemp(join(tmpdir(), 'memory-claude-inference-'))
const work = join(fixture, 'work'), config = join(fixture, 'config')
const canary = 'synthetic_unrequested_workspace_content_893f2'
const forbidden = join(work, 'forbidden-probe-file')
const launchFile = join(fixture, 'launch.json')
const marker = 'synthetic_extraction_input_295ab'
const answer = '{"proposals":[]}'
const model = 'claude-opus-4-6'
const runs = []
let current
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch { res.writeHead(400).end(); return }
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1000}'); return }
  if (path !== '/v1/messages' || !current) { res.writeHead(404).end(); return }
  const serialized = JSON.stringify(body)
  current.requests.push({ model: body.model, tools: (body.tools ?? []).map(tool => tool.name),
    promptReceived: serialized.includes(marker), workspaceContentReceived: serialized.includes(canary) })
  const useTool = current.mode === 'tool_attempt' && current.requests.length === 1
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  send({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  send({ type: 'content_block_start', index: 0, content_block: useTool
    ? { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: {} } : { type: 'text', text: '' } })
  send({ type: 'content_block_delta', index: 0, delta: useTool
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'touch forbidden-probe-file' }) }
    : { type: 'text_delta', text: answer } })
  send({ type: 'content_block_stop', index: 0 })
  send({ type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
  send({ type: 'message_stop' })
  res.end()
})
const originalPath = process.env.CLAUDE_PATH
try {
  await Promise.all(['home', 'config', 'work', 'work/.claude'].map(name => mkdir(join(fixture, name), { recursive: true, mode: 0o700 })))
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`
  const hook = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'unexpected hook')`].map(quote).join(' ')
  const settings = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook }] }] } })
  await writeFile(join(config, 'settings.json'), settings)
  await writeFile(join(work, '.claude', 'settings.json'), settings)
  await writeFile(join(work, 'CLAUDE.md'), canary)
  await writeFile(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { forbidden: { command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'unexpected MCP')`] } } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const environment = { PATH: process.env.PATH, HOME: join(fixture, 'home'), TMPDIR: fixture, TERM: 'dumb',
    CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_AUTH_TOKEN: 'synthetic-not-a-real-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' }
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: environment, timeout: 5000 }).trim()
  const launcher = join(fixture, 'claude-launcher')
  // Forward the real version and unchanged production argv. The test changes only the child's
  // environment, because production deliberately refuses ambient provider/credential overrides.
  await writeFile(launcher, `#!${process.execPath}
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
if (!args.includes('--version')) require('node:fs').writeFileSync(${JSON.stringify(launchFile)},JSON.stringify(args));
const child = spawn(${JSON.stringify(binary)},args,{env:${JSON.stringify(environment)},stdio:'inherit'});
child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code ?? 1));
`, { mode: 0o700 })
  process.env.CLAUDE_PATH = launcher
  for (const mode of ['text', 'tool_attempt']) {
    current = { mode, requests: [], observations: [] }
    runs.push(current)
    try {
      const result = await runClaudeMemoryInference({ cwd: work, model, effort: 'high',
        prompt: `Synthetic extraction fixture ${marker}. Return ${answer} without tools.`, timeoutMs: 25000,
        observe: value => current.observations.push(value) })
      current.expectedAnswer = result.text === answer
      current.error = null
    } catch (error) { current.error = error instanceof Error ? error.message : 'unknown'; current.expectedAnswer = false }
    current.forbiddenFileExists = await stat(forbidden).then(() => true, () => false)
    current.argv = await readFile(launchFile, 'utf8').then(JSON.parse, () => null)
    current.passed = current.requests.length > 0 && current.requests.every(request => request.model === model
      && request.promptReceived && !request.tools.length && !request.workspaceContentReceived)
      && !current.forbiddenFileExists && (mode === 'text' ? current.expectedAnswer && !current.error : current.error === 'inference_tool_or_error')
  }
  const files = ['src/memory/claudeInference.ts', 'src/memory/inferenceProcess.ts', 'src/memory/account.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async path => [path,
    createHash('sha256').update(await readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)))).digest('hex')])))
  const passed = runs.every(run => run.passed)
  console.log(JSON.stringify({ date: new Date().toISOString(), engine: 'claude', version, model, passed, sourceHashes, runs,
    limitations: ['Local mock replies and fake credentials; no real inference or semantic quality measurement.',
      'The launcher redirects native home and provider environment; this does not certify a production login or account switch.',
      'Prompt-hook lifecycle delivery is covered by the separate native lifecycle probe.'] }, null, 2))
  assert(passed, 'Native restricted extraction did not satisfy the probe')
} finally {
  if (originalPath === undefined) delete process.env.CLAUDE_PATH
  else process.env.CLAUDE_PATH = originalPath
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(fixture, { recursive: true, force: true })
}
