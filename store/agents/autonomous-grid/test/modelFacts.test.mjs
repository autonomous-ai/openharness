import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelFacts } from '../lib/modelFacts.mjs';

const template = '{%- if tools %}<tools>{{ tools }}</tools>\nReturn <tool_call>{"name": ..., "arguments": ...}</tool_call>{%- endif %}{% if enable_thinking %}<think>{% endif %}';
const card = [
  '# Widget-7B', '', 'Serve it:', '', '```bash', 'vllm serve Acme/Widget-7B --enable-auto-tool-choice --tool-call-parser widget --reasoning-parser widget_r', '```',
  '', '```python', 'print("not a serve command")', '```',
].join('\n');
const hub = {
  'https://huggingface.co/api/models/Acme/Widget-7B': { gated: false, siblings: ['config.json', 'generation_config.json', 'tokenizer_config.json', 'README.md'].map(rfilename => ({ rfilename })) },
  'https://huggingface.co/Acme/Widget-7B/raw/main/config.json': { architectures: ['WidgetForCausalLM'], model_type: 'widget', max_position_embeddings: 131072, torch_dtype: 'bfloat16' },
  'https://huggingface.co/Acme/Widget-7B/raw/main/generation_config.json': { temperature: 0.7, top_p: 0.8, eos_token_id: 2 },
  'https://huggingface.co/Acme/Widget-7B/raw/main/tokenizer_config.json': { chat_template: template },
  'https://huggingface.co/Acme/Widget-7B/raw/main/README.md': card,
  'https://huggingface.co/api/models/Acme/Locked-7B': { gated: 'manual', siblings: [{ rfilename: 'config.json' }] },
  'https://raw.githubusercontent.com/vllm-project/vllm/main/docs/models/supported_models.md': '| `WidgetForCausalLM` | Widget | `Acme/Widget-7B` | ✅︎ |\n| `OtherForCausalLM` | Other |',
  'https://raw.githubusercontent.com/sgl-project/sglang/main/python/sglang/srt/models/widget.py': 'class WidgetForCausalLM:\n    pass\n\nEntryClass = WidgetForCausalLM\n',
  'https://huggingface.co/api/models/Acme/Gizmo-3B': { gated: false, siblings: [{ rfilename: 'config.json' }] },
  'https://huggingface.co/Acme/Gizmo-3B/raw/main/config.json': { architectures: ['GizmoForCausalLM'], model_type: 'gizmo' },
};
const fetchImpl = async url => {
  const body = hub[url];
  if (body === undefined) return new Response('', { status: url.includes('/Locked-7B/raw/') ? 401 : 404 });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
};

test('a model with no recipe is read from its own files: architecture, context, sampling, tool syntax, card commands, support', async () => {
  const facts = await modelFacts('Acme/Widget-7B', { fetchImpl, token: undefined });
  assert.deepEqual([facts.found, facts.gated, facts.architecture, facts.modelType, facts.contextLength, facts.dtype],
    [true, false, 'WidgetForCausalLM', 'widget', 131072, 'bfloat16']);
  assert.deepEqual(facts.samplingDefaults, { temperature: 0.7, top_p: 0.8 });
  assert.equal(facts.chatTemplate.toolCalls, true);
  assert.equal(facts.chatTemplate.thinking, true);
  assert.match(facts.chatTemplate.toolSyntax, /<tool_call>\{"name"/);
  assert.equal(facts.modelCard.serveCommands.length, 1);
  assert.deepEqual(facts.modelCard.toolCallParsers, ['widget']);
  assert.deepEqual(facts.modelCard.reasoningParsers, ['widget_r']);
  assert.equal(facts.support.vllm.listed, true);
  assert.equal(facts.support.sglang.listed, true);
});

test('engine support is only claimed from the engine\'s own list; an absent registry file means unknown, not unsupported', async () => {
  const facts = await modelFacts('Acme/Gizmo-3B', { fetchImpl, token: undefined });
  assert.equal(facts.support.vllm.listed, false);
  assert.equal(facts.support.sglang.listed, null);
  assert.match(facts.support.sglang.note, /model-impl transformers/);
});

test('a gated or unknown model is reported as such, never filled in', async () => {
  const locked = await modelFacts('Acme/Locked-7B', { fetchImpl, token: undefined });
  assert.equal(locked.gated, true);
  assert.match(locked.note, /accept its license/);
  const missing = await modelFacts('Acme/Nothing-1B', { fetchImpl, token: undefined });
  assert.equal(missing.found, false);
  await assert.rejects(modelFacts('not an id', { fetchImpl }), /ORG\/NAME/);
});

test('a model folder already on disk is read in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ architectures: ['WidgetForCausalLM'], max_position_embeddings: 65536, quantization: { bits: 4, group_size: 64 } }));
  await writeFile(join(dir, 'chat_template.jinja'), template);
  const facts = await modelFacts(dir, { fetchImpl, checkSupport: false });
  assert.deepEqual([facts.source, facts.architecture, facts.contextLength, facts.quantization], [dir, 'WidgetForCausalLM', 65536, 'mlx 4-bit']);
  assert.equal(facts.chatTemplate.toolCalls, true);
  assert.equal(facts.support, null);
});
