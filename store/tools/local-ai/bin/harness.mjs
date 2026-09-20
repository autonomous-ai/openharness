#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const runtimeName = process.env.LOCAL_AI_NAME || 'Ollama';
const runtime = process.env.LOCAL_AI_RUNTIME || 'ollama';
if (!args.length) { console.log(`Talk to the ${runtimeName} agent, or use:\n  local-ai "run a lightweight model"\n  local-ai status\n  local-ai action deploy MODEL\n  local-ai action benchmark MODEL [MODEL…]\n  local-ai action chat MODEL "PROMPT"\n  local-ai action unload MODEL\n  local-ai action-json '{"type":"serve","model":"OWNER/REPO","maxSequences":4}' (vLLM)\n  local-ai cancel JOB_ID`); process.exit(0); }
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = resolve(process.env.HARNESS_WORKSPACE || packageRoot);
let port = Number(process.env.HARNESS_PORT || ({ 'mlx-lm': 4311, vllm: 4312 }[runtime] || 4310));
try { const endpoint = JSON.parse(await readFile(join(workspace, '.harness', 'endpoint.json'), 'utf8')); if (Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535 && endpoint.workspace === workspace) port = endpoint.port; } catch {}
const base = `http://127.0.0.1:${port}`;
const get = async path => { const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15000) }); const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value; };
let currentJob;
try {
  const health = await get('/api/health');
  if (health.application !== 'local-ai-harnesses' || health.workspace !== workspace || (health.runtime || 'ollama') !== runtime) throw new Error(`This endpoint belongs to another workspace or framework. Open the ${runtimeName} viewer for this workspace.`);
  const state = await get('/api/state');
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': state.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
  };
  if (args[0] === 'status' && args.length === 1) {
    const { token, ...publicState } = state; console.log(JSON.stringify(publicState, null, 2)); process.exit(0);
  }
  if (args[0] === 'cancel') { const { job } = await post('/api/cancel', { id: args[1] }); console.log(JSON.stringify({ id: job.id, status: job.status, message: job.message }, null, 2)); process.exit(0); }
  let result;
  if (args[0] === 'action-json') {
    if (args.length !== 2) throw new Error('Pass one JSON action object.');
    result = await post('/api/action', JSON.parse(args[1]));
  } else if (args[0] === 'action') {
    const type = args[1];
    const body = type === 'benchmark' ? { type, models: args.slice(2) } : type === 'chat' ? { type, model: args[2], prompt: args.slice(3).join(' ') } : { type, model: args[2] };
    result = await post('/api/action', body);
  } else result = await post('/api/command', { text: args.join(' ') });
  if (!result.job) { console.log(result.message || JSON.stringify(result, null, 2)); if (result.models) console.log(result.models.map(m => `${m.id}: ${m.description}`).join('\n')); process.exit(0); }
  currentJob = result.job.id;
  console.log(`Job ${currentJob}`);
  process.once('SIGINT', async () => { try { await post('/api/cancel', { id: currentJob }); console.log('Cancellation requested.'); } finally { process.exit(130); } });
  let last;
  while (true) {
    const { jobs } = await get('/api/jobs');
    const job = jobs.find(j => j.id === currentJob);
    if (!job) throw new Error('The job could not be found. Check the viewer.');
    if (job.message !== last) { console.log(job.message); last = job.message; }
    if (!['queued', 'running'].includes(job.status)) {
      if (job.output) console.log(job.output);
      if (job.result?.metrics) console.log(JSON.stringify(job.result.metrics, null, 2));
      process.exit(job.status === 'succeeded' ? 0 : 1);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} catch (error) { console.error(error.cause?.code === 'ECONNREFUSED' ? `The viewer is not running. Open the ${runtimeName} harness viewer.` : `${error.message}${currentJob ? ` (job ${currentJob}; check its status before retrying)` : ''}`); process.exitCode = 1; }
