import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSetup, runTracked } from '../lib/fleet.mjs';
import { verifyModel } from '../lib/verify.mjs';

const temporary = async t => { const dir = await mkdtemp(join(tmpdir(), 'model-setup-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const receipt = async dir => JSON.parse(await readFile(join(dir, 'model-setup.json'), 'utf8'));
const machine = { id: 'local', transport: 'local' };
const run = async () => ({ ok: true, stdout: "export OPENAI_BASE_URL='http://fixture.invalid/v1'\nexport OPENAI_API_KEY='private-secret'\n" });

test('downloading publishes measured progress to a readable, credential-free project file', async t => {
  const dir = await temporary(t), grid = join(dir, 'grid');
  await writeFile(grid, '#!/bin/sh\necho "(42.5%)"\nexit 0\n', { mode: 0o755 });
  await runTracked(dir, { ...machine, gridBinary: grid }, 'local', ['pull', 'model'], { inherit: false });
  assert.deepEqual({ ...(await receipt(dir)), id: null, updatedAt: null }, {
    spec: 1, id: null, updatedAt: null, stage: 'downloading', phase: 'done', progressPercent: 42.5,
  });
});

test('ready requires a completed content reply; HTTP success and reasoning alone are insufficient', async t => {
  const dir = await temporary(t);
  for (const answer of [{ choices: [] }, { choices: [{ message: { reasoning_content: 'ok' } }] }]) {
    await assert.rejects(verifyModel(dir, machine, 'local', 'home', 'qwen', {
      run, request: async () => ({ ok: true, json: async () => answer }),
    }), /did not complete/);
    assert.equal((await receipt(dir)).phase, 'failed');
  }
  const result = await verifyModel(dir, machine, 'local', 'home', 'qwen', {
    run, request: async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/v1/chat/completions');
      assert.equal(JSON.parse(options.body).max_tokens, 8);
      assert.equal((await receipt(dir)).phase, 'running');
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal((await receipt(dir)).phase, 'done');
  assert.equal((await receipt(dir)).stage, 'verifying');
  assert.doesNotMatch(JSON.stringify(await receipt(dir)), /private-secret|fixture.invalid|pid|command/);
});

test('a failed request leaves recoverable status and never persists network secrets', async t => {
  const dir = await temporary(t);
  await assert.rejects(verifyModel(dir, machine, 'local', 'home', 'qwen', {
    run, request: async () => { throw new Error('private-secret'); },
  }), /check was interrupted/);
  assert.equal((await receipt(dir)).phase, 'failed');
  assert.doesNotMatch(JSON.stringify(await receipt(dir)), /private-secret/);
});

test('a later inspection or old operation cannot erase readiness', async t => {
  const dir = await temporary(t);
  await publishSetup(dir, { id: 'ready', startedAt: '2026-09-23T10:00:00Z', stage: 'verifying', phase: 'done', model: 'qwen' });
  await publishSetup(dir, { id: 'check', startedAt: '2026-09-23T11:00:00Z', stage: 'checking', phase: 'running' });
  await publishSetup(dir, { id: 'old-download', startedAt: '2026-09-23T09:00:00Z', stage: 'downloading', phase: 'done' });
  assert.equal((await receipt(dir)).id, 'ready');
});
