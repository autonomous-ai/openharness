import { it, expect } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalModels } from './localModels.js'

it('discovers, downloads, starts, verifies, stops and restarts across real subprocesses and HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'models-pipeline-'))
  const gridHome = join(root, 'grid-home'), stateDir = join(root, 'state')
  const modelId = 'fixture/Tiny-GGUF'
  let replies = 0, catalogReads = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/grid/catalog') {
      expect(req.headers.authorization).toBe('Bearer catalog-fixture')
      expect(body.device.usable_bytes).toBe(16 * 1024 ** 3)
      catalogReads++
      res.end(JSON.stringify({ models: [{ repo_id: modelId, runnable: true, task: 'text-generation', format: 'GGUF',
        fit: { version: 'Q4', ctx: 4096 }, versions: [{ version: 'Q4', size_bytes: 64, pull_spec: `${modelId}:tiny.gguf` }] }] }))
    } else {
      expect(req.url).toBe('/v1/chat/completions')
      expect(req.headers.authorization).toBe('Bearer inference-fixture')
      expect(body).toMatchObject({ model: 'tiny.gguf', max_tokens: 8 })
      replies++
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  let service: LocalModels | undefined
  try {
    await mkdir(gridHome)
    await writeFile(join(gridHome, 'credentials.toml'), `session_token = 'catalog-fixture'\napi_url = '${base}'\n`)
    const executable = join(root, 'grid.mjs')
    await writeFile(executable, `#!${process.execPath}
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.GRID_HOME, args = process.argv.slice(2);
const recordDir = join(home, 'run', 'engines', 'fixture-grid');
const record = join(recordDir, 'remote.json');
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const result = value => console.log(JSON.stringify(value));
if (args[0] === 'device-info') result({ usable_bytes: 16 * 1024 ** 3, device_class: 'cpu', backend: 'cpu', memory: { total_gb: 16 } });
else if (args.includes('ls')) result([{ grid: 'home', id: 'fixture-grid' }]);
else if (args.includes('engines')) result(existsSync(record) ? [{ node_id: 'fixture-node', online: true, models: ['tiny'] }] : []);
else if (args[0] === 'pull') { mkdirSync(join(home, 'models'), { recursive: true }); process.stderr.write('42%\\r100%\\n'); writeFileSync(join(home, 'models', 'tiny.gguf'), Buffer.alloc(64)); }
else if (args[0] === 'engine') { mkdirSync(join(home, 'bin'), { recursive: true }); writeFileSync(join(home, 'bin', 'llama-server'), '#!/bin/sh\\nexit 0\\n', { mode: 0o700 }); }
else if (args.includes('join')) { mkdirSync(recordDir, { recursive: true }); writeFileSync(record, JSON.stringify({ node_id: 'fixture-node', engines: [{ models: ['tiny.gguf'] }] })); writeFileSync(join(recordDir, 'remote.heartbeat'), ''); }
else if (args.includes('leave')) rmSync(record);
else if (args.includes('info')) console.log("export OPENAI_BASE_URL='${base}/v1'\\nexport OPENAI_API_KEY='inference-fixture'");
else process.exitCode = 2;
`, { mode: 0o700 })
    const options = { stateDir, processEnv: { GRID_HOME: gridHome, HARNESS_GRID_BIN: executable, PATH: root } }
    service = new LocalModels(options)
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'available', canStart: true })
    expect(replies).toBe(0)
    await service.act('home', modelId, 'start'); await service.settled()
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'running', canStop: true, operation: { phase: 'done' } })
    expect(replies).toBe(1)
    // A fresh client/service can recover the completed status from disk.
    service = new LocalModels(options)
    expect((await service.list('home')).models[0].operation?.phase).toBe('done')
    await service.act('home', modelId, 'stop'); await service.settled()
    expect((await service.list('home')).models[0].state).toBe('downloaded')
    expect((await stat(join(gridHome, 'models', 'tiny.gguf'))).size).toBe(64)
    await service.act('home', modelId, 'start'); await service.settled()
    expect((await service.list('home')).models[0].state).toBe('running')
    const calls = (await readFile(join(gridHome, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(args => args[0] === 'pull')).toHaveLength(1)
    expect(calls.filter(args => args[0] === 'engine')).toHaveLength(1)
    expect(calls.find(args => args.includes('leave'))).toEqual(['--remote', 'leave', 'home', '--engine', 'tiny.gguf'])
    expect(catalogReads).toBeGreaterThan(1)
    expect(replies).toBe(2)
  } finally {
    await service?.settled()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
