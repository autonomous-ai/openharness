/** Offline wire regression against the installed Codex CLI (verified with 0.154.0).
 * RUN_CODEX_RESUME_E2E=1 npm exec vitest run src/engines/codex/portableHistory.real.spec.ts
 * Only the loopback mock is contacted; no vendor credential or inference is used. */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareCodexResume } from './portableHistory.js'

it.skipIf(process.env.RUN_CODEX_RESUME_E2E !== '1')('resumes the same Codex conversation after a rejected reasoning id is repaired', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'codex-resume-wire-'))
  const id = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
  const badId = 'msg_aY9suLof0GA06VzeKPXLM7rjUhoRRF9d'
  const timestamp = '2026-09-15T06:42:38.000Z'
  const record = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload })
  const dir = join(profile, 'sessions', '2026', '09', '15')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-09-15T13-42-38-${id}.jsonl`)
  writeFileSync(file, [
    record('session_meta', { id, timestamp, cwd: profile, originator: 'codex_cli_rs', cli_version: '0.154.0', source: 'cli', model_provider: 'mock' }),
    record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    record('response_item', { type: 'reasoning', id: badId, summary: [{ type: 'summary_text', text: 'Prior local summary.' }], content: [] }),
    record('response_item', { type: 'message', id: badId, role: 'assistant', content: [{ type: 'output_text', text: 'Hello back.' }] }),
  ].join('\n') + '\n')
  const requests: Array<{ input: Array<Record<string, unknown>> }> = []
  const server = createServer((req, res) => {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body)
      requests.push(request)
      const reasoning = request.input.find((item: Record<string, unknown>) => item.type === 'reasoning')
      if (reasoning?.id) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: { type: 'invalid_request_error', code: 'invalid_id_prefix', message: "Expected an ID that begins with 'rs'." },
        }))
        return
      }
      const item = { type: 'message', id: 'msg_reply', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Recovered.', annotations: [] }] }
      const response = { id: 'resp_test', object: 'response', created_at: 1789460000, model: 'gpt-5.6-luna', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'Recovered.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map((event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''))
    })
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock did not bind TCP')
    const args = ['exec', 'resume', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--json',
      '-m', 'gpt-5.6-luna', '-c', 'model_provider="mock"', '-c', 'model_providers.mock.name="Mock"',
      '-c', `model_providers.mock.base_url="http://127.0.0.1:${address.port}/v1"`,
      '-c', 'model_providers.mock.wire_api="responses"', '-c', 'model_providers.mock.supports_websockets=false',
      '-c', 'model_providers.mock.requires_openai_auth=false', id, 'continue']
    const run = () => promisify(execFile)(process.env.CODEX_TEST_BINARY || 'codex', args, {
      cwd: profile, env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: profile }, timeout: 20_000,
    }).then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

    const failed = await run()
    expect(failed.code).toBe(1)
    expect(requests[0].input.find(item => item.type === 'reasoning')?.id).toBe(badId)
    expect(failed.stdout + failed.stderr).toContain('invalid_id_prefix')

    expect(prepareCodexResume({ engine: 'codex', sessionId: id, transcriptPath: file, codexHome: profile }).repairedItems).toBe(1)
    const resumed = await run()
    expect(resumed.code, resumed.stderr).toBe(0)
    expect(resumed.stdout).toContain(`"thread_id":"${id}"`)
    expect(resumed.stdout).toContain('Recovered.')
    const replay = requests.at(-1)!.input
    expect(replay.find(item => item.type === 'reasoning')).toMatchObject({ summary: [{ type: 'summary_text', text: 'Prior local summary.' }] })
    expect(replay.find(item => item.type === 'reasoning')).not.toHaveProperty('id')
    expect(replay.find(item => item.id === badId)).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'Hello back.' }] })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(profile, { recursive: true, force: true })
  }
}, 45_000)
