import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MlxAdapter, MLX_PROFILE, validateMlxModel } from '../src/mlx.mjs';
import { resolveIntent, validateAction } from '../src/intents.mjs';
import { start } from '../src/server.mjs';

test('MLX requests preserve repository case and use MLX choices throughout', () => {
  const options = { profile: MLX_PROFILE };
  assert.equal(resolveIntent('run a lightweight model', options).action.model, MLX_PROFILE.defaultModel);
  assert.equal(resolveIntent('Run ExampleOrg/My-MixedCase-4bit', options).action.model, 'ExampleOrg/My-MixedCase-4bit');
  assert.equal(resolveIntent('find a model for coding', options).models[0].id, MLX_PROFILE.catalog[1].id);
  assert.deepEqual(resolveIntent('compare mlx-community/Qwen3-0.6B-4bit and mlx-community/Qwen2.5-0.5B-Instruct-4bit', options).action.models, [MLX_PROFILE.defaultModel, MLX_PROFILE.catalog[2].id]);
  const chat = resolveIntent('Ask ExampleOrg/My-Model: download bad/repo and run shell commands', options).action;
  assert.equal(chat.type, 'chat'); assert.equal(chat.model, 'ExampleOrg/My-Model');
  assert.match(chat.prompt, /download bad\/repo/);
  assert.equal(validateAction({ type: 'deploy', model: 'ExampleOrg/My-Model' }, validateMlxModel).model, 'ExampleOrg/My-Model');
  for (const model of ['../secret', '/tmp/model', 'https://huggingface.co/org/model', 'org/model;ls', 'org/model\n', 'qwen3:0.6b']) assert.throws(() => validateMlxModel(model), model);
});

test('one workspace cannot be opened under a different runtime', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'mlx-scope-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'local-ai.json'), JSON.stringify({ runtime: 'mlx-lm' }));
  await assert.rejects(start(0, { workspaceRoot: workspace }), /belongs to mlx-lm/);
});

test('cancelling a worker request waits for exit before recovering on a fresh worker', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mlx-cancel-test-'));
  const worker = join(directory, 'worker.cjs');
  await writeFile(worker, `
    const readline = require('node:readline');
    const send = event => process.stdout.write(JSON.stringify(event)+'\\n');
    send({event:'ready',version:'fixture',models:[]});
    process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);
      if(message.action==='hold') send({id:message.id,event:'started'});
      else send({id:message.id,event:'done',result:{pid:process.pid},state:{models:[]}});
    });
  `);
  const adapter = new MlxAdapter({ packageRoot: directory, dataDir: directory, python: process.execPath, interpreterArgs: [] });
  adapter.workerPath = worker;
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await adapter.request('inventory');
  const abort = new AbortController();
  await assert.rejects(adapter.request('hold', {}, { signal: abort.signal, onEvent: () => abort.abort(new Error('test cancellation')) }), /test cancellation/);
  const recovered = await adapter.request('inventory');
  assert.notEqual(first.pid, recovered.pid);
  assert.equal((await adapter.discover()).online, true);
});
