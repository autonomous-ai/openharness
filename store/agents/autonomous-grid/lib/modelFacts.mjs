// What a model says about itself, for the case no engine recipe covers it: the files every Hugging Face
// model ships (config, generation defaults, chat template, model card), read from the Hub or a local
// folder, plus whether each engine's official supported-model list names its architecture. Facts only.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const HUB = 'https://huggingface.co';
const FILES = ['config.json', 'generation_config.json', 'tokenizer_config.json', 'chat_template.jinja', 'chat_template.json', 'README.md'];
const VLLM_SUPPORTED = 'https://raw.githubusercontent.com/vllm-project/vllm/main/docs/models/supported_models.md';
// SGLang's docs name families, not architectures; its model registry is one file per model_type with an EntryClass.
const SGLANG_MODELS = 'https://raw.githubusercontent.com/sgl-project/sglang/main/python/sglang/srt/models';
const SERVE = /\b(vllm serve|sglang serve|sglang\.launch_server|llama-server|mlx_lm\.server|ollama (run|create|pull)|lms (get|load))\b/;
const SAMPLING = ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'presence_penalty'];

const json = text => { try { return JSON.parse(text); } catch { return null; } };

async function hubReader(hfId, { fetchImpl, token }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetchImpl(`${HUB}/api/models/${hfId}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (response.status === 401 || response.status === 404) return { missing: true };
  if (!response.ok) throw new Error(`huggingface.co answered HTTP ${response.status} for ${hfId}`);
  const info = await response.json();
  const present = new Set((info.siblings ?? []).map(file => file.rfilename));
  return {
    gated: Boolean(info.gated), present,
    read: async name => {
      if (!present.has(name)) return null;
      const file = await fetchImpl(`${HUB}/${hfId}/raw/main/${name}`, { headers, signal: AbortSignal.timeout(20_000) });
      return file.ok ? file.text() : null;
    },
  };
}

function localReader(dir) {
  return { gated: false, read: name => readFile(join(dir, name), 'utf8').catch(() => null) };
}

/** A few lines of the chat template around its tool-call markup: compare them with the engine's parser docs. */
function toolSyntax(template) {
  const at = template.search(/<tool_call>|\[TOOL_CALLS\]|<\|python_tag\|>|tool_calls|<function|functools|tool▁call/);
  if (at < 0) return null;
  return template.slice(Math.max(0, at - 160), at + 320).trim();
}

function codeBlocks(markdown) {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match => match[1].trim());
}

/** `listed`: true = named by the engine's own list, false = its full list omits it, null = this check cannot tell. */
async function support(architecture, modelType, fetchImpl) {
  const text = url => fetchImpl(url, { signal: AbortSignal.timeout(20_000) }).then(r => (r.ok ? r.text() : null)).catch(() => null);
  const vllmList = architecture ? await text(VLLM_SUPPORTED) : null;
  const vllm = vllmList === null
    ? { listed: null, source: VLLM_SUPPORTED, note: architecture ? 'list unreachable' : 'config.json names no architecture' }
    : { listed: vllmList.split('\n').some(line => line.includes(`\`${architecture}\``)), source: VLLM_SUPPORTED,
      lines: vllmList.split('\n').filter(line => line.includes(`\`${architecture}\``)).map(line => line.trim().slice(0, 240)).slice(0, 3) };
  const registryFile = modelType && /^[\w.-]+$/.test(modelType) ? `${SGLANG_MODELS}/${modelType}.py` : null;
  const registry = registryFile && architecture ? await text(registryFile) : null;
  const sglang = registry?.includes(architecture)
    ? { listed: true, source: registryFile }
    : { listed: null, source: registryFile ?? SGLANG_MODELS,
      note: 'not found in the registry file for this model_type; it may live in another file, or run through --model-impl transformers' };
  return { vllm, sglang };
}

export async function modelFacts(target, { fetchImpl = globalThis.fetch, token = process.env.HF_TOKEN, checkSupport = true } = {}) {
  const isLocal = await stat(target).then(info => info.isDirectory()).catch(() => false);
  if (!isLocal && !/^[\w.-]+\/[\w.-]+$/.test(target || '')) throw new Error('Pass a Hugging Face id (ORG/NAME) or a model folder');
  const reader = isLocal ? localReader(target) : await hubReader(target, { fetchImpl, token });
  const source = isLocal ? target : `${HUB}/${target}`;
  if (reader.missing) return { source, found: false, note: 'Hugging Face has no such public model, or it is private: check the id; a private model needs HF_TOKEN.' };
  const files = Object.fromEntries(await Promise.all(FILES.map(async name => [name, await reader.read(name)])));
  if (reader.gated && !files['config.json']) {
    return { source, found: true, gated: true, note: 'Gated model: the person must accept its license on Hugging Face and provide HF_TOKEN. Ask; do not work around it.' };
  }
  const config = json(files['config.json']) ?? {}, text = config.text_config ?? {};
  const generation = json(files['generation_config.json']) ?? {};
  const tokenizer = json(files['tokenizer_config.json']) ?? {};
  const template = files['chat_template.jinja'] ?? json(files['chat_template.json'])?.chat_template
    ?? (typeof tokenizer.chat_template === 'string' ? tokenizer.chat_template : tokenizer.chat_template?.map?.(t => t.template).join('\n')) ?? '';
  const card = files['README.md'] ?? '';
  const architecture = config.architectures?.[0] ?? null, modelType = config.model_type ?? null;
  const flagValues = flag => [...new Set([...card.matchAll(new RegExp(`--${flag}[ =]+([A-Za-z0-9_.-]+)`, 'g'))].map(match => match[1]))];
  return {
    source, found: true, gated: reader.gated,
    architecture, modelType,
    contextLength: config.max_position_embeddings ?? text.max_position_embeddings ?? null,
    dtype: config.torch_dtype ?? config.dtype ?? text.torch_dtype ?? null,
    quantization: config.quantization_config?.quant_method ?? (config.quantization?.bits ? `mlx ${config.quantization.bits}-bit` : null),
    samplingDefaults: Object.fromEntries(SAMPLING.filter(key => generation[key] !== undefined).map(key => [key, generation[key]])),
    chatTemplate: template ? { toolCalls: /\btools\b/.test(template), toolSyntax: toolSyntax(template), thinking: /<think>|enable_thinking/.test(template) } : null,
    modelCard: {
      serveCommands: codeBlocks(card).filter(block => SERVE.test(block)).slice(0, 8),
      toolCallParsers: flagValues('tool-call-parser'), reasoningParsers: flagValues('reasoning-parser'),
    },
    support: checkSupport ? await support(architecture, modelType, fetchImpl) : null,
  };
}
