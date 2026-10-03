import test from 'node:test';
import assert from 'node:assert/strict';
import { NoRecipe, sglangCookbook, vllmRecipe } from '../lib/recipes.mjs';

const site = routes => async url => {
  const body = routes[url];
  if (body === undefined) return new Response('not found', { status: 404 });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
};

const vllmSite = site({
  'https://recipes.vllm.ai/models.json': [
    { hf_id: 'Acme/Widget-7B', url: '/Acme/Widget-7B', json: '/Acme/Widget-7B.json' },
    { hf_id: 'Acme/Widget-70B', url: '/Acme/Widget-70B', json: '/Acme/Widget-70B.json' },
  ],
  'https://recipes.vllm.ai/Acme/Widget-7B.json': {
    hf_id: 'Acme/Widget-7B',
    model: { model_id: 'Acme/Widget-7B', min_vllm_version: '0.17.0', context_length: 262144, base_args: ['--trust-remote-code'], base_env: {} },
    features: {
      tool_calling: { args: ['--enable-auto-tool-choice', '--tool-call-parser', 'widget'] },
      reasoning: { args: ['--reasoning-parser', 'widget'] },
      spec_decoding: { args: ['--speculative-config', '{"method":"mtp"}'] },
    },
    opt_in_features: ['spec_decoding'],
    variants: { default: { precision: 'bf16', vram_minimum_gb: 22 }, fp8: { model_id: 'Acme/Widget-7B-FP8', precision: 'fp8', vram_minimum_gb: 11, extra_args: ['--kv-cache-dtype', 'fp8'] } },
    recommended_command: { command: 'vllm serve Acme/Widget-7B', docker_image: 'vllm/vllm-openai:latest' },
    guide: '## Troubleshooting\n- lower the capture size',
  },
});

test('a vLLM recipe gives the minimum version, the flags an agent always needs, and the variants by GPU memory', async () => {
  const found = await vllmRecipe('acme/widget-7b', { fetchImpl: vllmSite });
  assert.equal(found.source, 'https://recipes.vllm.ai/Acme/Widget-7B');
  assert.equal(found.minVersion, '0.17.0');
  assert.deepEqual(found.baseArgs, ['--trust-remote-code']);
  assert.deepEqual(found.features.tool_calling, { optIn: false, args: ['--enable-auto-tool-choice', '--tool-call-parser', 'widget'], env: {}, description: '' });
  assert.equal(found.features.spec_decoding.optIn, true);
  assert.deepEqual(found.variants.fp8, { modelId: 'Acme/Widget-7B-FP8', precision: 'fp8', vramMinimumGb: 11, extraArgs: ['--kv-cache-dtype', 'fp8'], description: '' });
  assert.equal(found.variants.default.modelId, 'Acme/Widget-7B');
  assert.match(found.guide, /Troubleshooting/);
});

test('no vLLM recipe is an explicit answer, never a sibling model standing in for it', async () => {
  await assert.rejects(vllmRecipe('Acme/Widget-3B', { fetchImpl: vllmSite }), NoRecipe);
  await assert.rejects(vllmRecipe('not an id', { fetchImpl: vllmSite }), /ORG\/NAME/);
});

const cookbookPage = `# Widget

## 1. Model Introduction
Text.

## 2. SGLang Installation

SGLang 0.5.9 or newer is required.

\`\`\`bash Command theme={null}
uv pip install sglang
\`\`\`

## 3. Model Deployment

### 3.2 Configuration Tips
* Lower \`--mem-fraction-static\` when images are large.

## 4. Model Invocation

\`\`\`shell Command theme={null}
sglang serve \\
  --model-path Acme/Widget-2.5-7B \\
  --reasoning-parser widget \\
  --tool-call-parser widget_xml \\
  --host 0.0.0.0 --port 30000
\`\`\`
`;
const sglangSite = site({
  'https://docs.sglang.io/llms.txt': [
    '- [Widget](https://docs.sglang.io/cookbook/autoregressive/Acme/Widget.md): older family',
    '- [Widget 2.5](https://docs.sglang.io/cookbook/autoregressive/Acme/Widget-2.5.md): current family',
    '- [Image](https://docs.sglang.io/cookbook/diffusion/Acme/Paint.md): not a language model',
  ].join('\n'),
  'https://docs.sglang.io/cookbook/autoregressive/Acme/Widget-2.5.md': cookbookPage,
});

test('the SGLang cookbook page is the most specific family match, with its commands, parsers and notes', async () => {
  const found = await sglangCookbook('Acme/Widget-2.5-7B-Instruct', { fetchImpl: sglangSite });
  assert.equal(found.source, 'https://docs.sglang.io/cookbook/autoregressive/Acme/Widget-2.5.md');
  assert.deepEqual(found.toolCallParsers, ['widget_xml']);
  assert.deepEqual(found.reasoningParsers, ['widget']);
  assert.equal(found.serveCommands.length, 1);
  assert.match(found.installation, /0\.5\.9 or newer/);
  assert.match(found.configurationTips, /mem-fraction-static/);
});

test('no SGLang cookbook page is an explicit answer, never a guess', async () => {
  await assert.rejects(sglangCookbook('Other/Gadget-1B', { fetchImpl: sglangSite }), NoRecipe);
});
