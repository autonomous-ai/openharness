import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, execute, now, publishSetup, stateDir } from './fleet.mjs';

/** The same bounded OpenAI-compatible request the manager already performs,
 * with a durable receipt the Models panel can read. Credentials stay in memory. */
export async function verifyModel(workspace, machine, mode, grid, model, { run = execute, request = fetch } = {}) {
  if (!grid || !model || [grid, model].some(v => typeof v !== 'string' || v.startsWith('-') || /[\x00-\x1f]/.test(v))) throw new Error('A grid and model name are required.');
  const record = { spec: 1, id: randomUUID(), stage: 'verifying', phase: 'running', model, grid, command: 'Verify model', machine: machine.id, startedAt: now(), updatedAt: now(), pid: process.pid };
  let pending = Promise.resolve();
  const publish = () => {
    const snapshot = { ...record, updatedAt: now() };
    pending = pending.then(async () => {
      await atomicJson(join(stateDir(workspace), 'operations', `${record.id}.json`), snapshot);
      await publishSetup(workspace, snapshot);
    });
    return pending;
  };
  await publish();
  const heartbeat = setInterval(() => { void publish().catch(() => {}); }, 5000);
  heartbeat.unref();
  try {
    const info = await run(machine, [`--${mode}`, 'info', grid, '--env']);
    if (!info.ok) throw new Error('Could not read the model endpoint. Check Model Manager and retry.');
    const values = {};
    for (const match of info.stdout.matchAll(/^export\s+(OPENAI_BASE_URL|OPENAI_API_KEY)=(.*)$/gm)) {
      const value = match[2].trim();
      values[match[1]] = value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0] ? value.slice(1, -1) : value;
    }
    if (!values.OPENAI_BASE_URL || !values.OPENAI_API_KEY) throw new Error('The model endpoint is not ready yet.');
    const response = await request(`${values.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${values.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(420_000),
    });
    if (!response.ok) throw new Error(`The model did not answer successfully (HTTP ${response.status}).`);
    const answer = await response.json();
    if (!/^\s*ok[.!]?\s*$/i.test(answer?.choices?.[0]?.message?.content ?? '')) throw new Error('The model did not complete the test reply. Ask Model Manager to check it.');
    record.phase = 'done';
    await publish();
    return { ok: true, model };
  } catch (error) {
    record.phase = 'failed';
    await publish();
    // No raw response bodies, endpoint credentials or arbitrary network errors.
    throw new Error(error.name === 'TimeoutError' ? 'The model did not answer in time. Ask Model Manager to check it.' :
      /^(Could not read|The model|The model endpoint)/.test(error.message) ? error.message : 'The model check was interrupted. Ask Model Manager to retry.');
  } finally { clearInterval(heartbeat); }
}
