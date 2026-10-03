import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBytes, kvBytesFromConfig, mlxCandidates } from '../lib/candidates.mjs';
import { parseNvidiaSmi, runnableEngines } from '../lib/inventory.mjs';

test('the filter estimate reads the Hub\'s unpacked parameter count at the repo\'s bit width', () => {
  // A 4B model at 4 bits: the Hub reports ~4.0e9 "U32"; its files are 2.26 GB.
  assert.equal(estimateBytes({ total: 4_022_468_096 }, 4), Math.round(4_022_468_096 * 0.5 * 1.15));
  assert.equal(estimateBytes(undefined, 4), 0);
});

test('cache per token counts only the layers that keep one', () => {
  const dense = { num_hidden_layers: 28, num_attention_heads: 16, num_key_value_heads: 8, head_dim: 128 };
  assert.equal(kvBytesFromConfig(dense), 28 * 8 * 128 * 4);
  assert.equal(kvBytesFromConfig({ ...dense, full_attention_interval: 4 }), 7 * 8 * 128 * 4);
  assert.equal(kvBytesFromConfig({ text_config: { ...dense, layer_types: ['linear_attention', 'full_attention', 'linear_attention', 'full_attention'] } }), 2 * 8 * 128 * 4);
  assert.equal(kvBytesFromConfig({ num_hidden_layers: 4 }), null);
});

test('MLX candidates are chat models that fit the budget at the asked context, sized without downloading', async () => {
  const GB = 1024 ** 3;
  const rows = [
    { id: 'mlx-community/Small-4bit', pipeline_tag: 'text-generation', downloads: 900, gated: false, config: { quantization_config: { bits: 4 }, architectures: ['SmallForCausalLM'], tokenizer_config: { chat_template: '{% if tools %}{% endif %}' } }, safetensors: { total: 4 * GB } },
    { id: 'mlx-community/Huge-4bit', pipeline_tag: 'text-generation', downloads: 800, gated: false, config: { quantization_config: { bits: 4 } }, safetensors: { total: 60 * GB } },
    { id: 'mlx-community/Speech', pipeline_tag: 'automatic-speech-recognition', downloads: 5000, gated: false, config: { quantization_config: { bits: 4 } }, safetensors: { total: GB } },
    { id: 'mlx-community/Locked-4bit', pipeline_tag: 'text-generation', downloads: 700, gated: 'manual', config: { quantization_config: { bits: 4 } }, safetensors: { total: GB } },
  ];
  const fetchImpl = async url => {
    if (url.startsWith('https://huggingface.co/api/models?')) {
      assert.match(url, /author=mlx-community/);
      return new Response(JSON.stringify(rows));
    }
    if (url === 'https://huggingface.co/api/models/mlx-community/Small-4bit?blobs=true') {
      return new Response(JSON.stringify({ siblings: [{ rfilename: 'model.safetensors', size: 2.26 * GB }, { rfilename: 'tokenizer.json', size: 11e6 }] }));
    }
    if (url.endsWith('/Small-4bit/raw/main/config.json')) return new Response(JSON.stringify({ num_hidden_layers: 24, num_attention_heads: 16, num_key_value_heads: 4, head_dim: 128, max_position_embeddings: 131072 }));
    return new Response('{}', { status: 404 });
  };
  const found = await mlxCandidates({ budgetBytes: 20 * GB, fetchImpl });
  assert.deepEqual(found.candidates.map(c => c.id), ['mlx-community/Small-4bit']);
  const [small] = found.candidates;
  assert.equal(small.bytes, 2.26 * GB, 'the real file size, not the parameter count');
  assert.equal(small.kvBytesPerToken, 24 * 4 * 128 * 4);
  assert.equal(small.fits, true);
  assert.equal(small.toolCalls, true);
});

test('a GPU counts only when its own tool answers; the engines a machine can run follow from it', () => {
  const [gpu] = parseNvidiaSmi('0, NVIDIA RTX 4090, 24564, 1200, 3, 580.1\n');
  assert.deepEqual([gpu.name, gpu.totalBytes, gpu.active, gpu.driver], ['NVIDIA RTX 4090', 24564 * 1024 ** 2, true, '580.1']);
  assert.deepEqual(runnableEngines('darwin', 'arm64', []), ['llama.cpp', 'mlx-lm', 'ollama', 'lm-studio']);
  assert.deepEqual(runnableEngines('linux', 'x64', [gpu]), ['llama.cpp', 'ollama', 'vllm', 'sglang']);
  assert.deepEqual(runnableEngines('linux', 'x64', [{ vendor: 'nvidia', active: false }]), ['llama.cpp', 'ollama']);
});
