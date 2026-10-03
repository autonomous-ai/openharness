// Models to download for an engine that is installed but has nothing to serve. MLX: the mlx-community
// organisation on Hugging Face, sized from each repo's own safetensors and config — nothing is downloaded
// here. Every candidate carries its size, its cache cost at the context asked, and whether it fits.
const HUB = 'https://huggingface.co';
const CHAT_TASKS = new Set(['text-generation', 'image-text-to-text']);

/**
 * A first estimate for filtering only: the Hub counts a quantized repo's parameters unpacked (a 4B model at
 * 4 bits reports 4.0e9 "U32"), so size ≈ parameters × bits ÷ 8, plus ~15% for scales. The real size comes
 * from the files (`repoBytes`).
 */
export function estimateBytes(safetensors, bits) {
  return Math.round((safetensors?.total ?? 0) * (bits / 8) * 1.15);
}

/** The exact size of a repo's weight files, from the Hub's file listing. */
export async function repoBytes(id, fetchImpl) {
  const info = await fetchImpl(`${HUB}/api/models/${id}?blobs=true`, { signal: AbortSignal.timeout(20_000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!info) return null;
  return (info.siblings ?? []).filter(file => file.rfilename.endsWith('.safetensors')).reduce((sum, file) => sum + (file.size ?? 0), 0) || null;
}

/** f16/bf16 KV-cache bytes per token from a Hugging Face config, counting only layers that keep a cache. */
export function kvBytesFromConfig(config) {
  const text = config.text_config ?? config;
  const layers = text.num_hidden_layers, heads = text.num_attention_heads;
  const kvHeads = text.num_key_value_heads ?? heads;
  const headDim = text.head_dim ?? (text.hidden_size && heads ? text.hidden_size / heads : undefined);
  if (!layers || !kvHeads || !headDim) return null;
  let cached = layers;
  if (Array.isArray(text.layer_types)) cached = text.layer_types.filter(type => /full|global/.test(type) || type === 'attention').length;
  else if (text.full_attention_interval > 1) cached = Math.floor(layers / text.full_attention_interval);
  return cached * kvHeads * headDim * 2 * 2;
}

/**
 * MLX models for this Mac: chat-capable, quantized, public, newest-first within popularity, each checked
 * against `budgetBytes` at `contextTokens`. `search` narrows by name (e.g. a family the person asked for).
 */
const SORTS = { downloads: 'downloads', trending: 'trendingScore', recent: 'lastModified' };

export async function mlxCandidates({ budgetBytes, contextTokens = 65536, search = '', sort = 'downloads', limit = 12, fetchImpl = globalThis.fetch } = {}) {
  if (!SORTS[sort]) throw new Error('sort is downloads, trending or recent');
  const query = new URLSearchParams({ author: 'mlx-community', sort: SORTS[sort], direction: '-1', limit: '300' });
  if (search) query.set('search', search);
  for (const field of ['safetensors', 'config', 'downloads', 'pipeline_tag', 'lastModified', 'gated']) query.append('expand[]', field);
  const response = await fetchImpl(`${HUB}/api/models?${query}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`huggingface.co answered HTTP ${response.status}`);
  // Weights alone must fit before the config is worth reading.
  const listed = (await response.json()).filter(row => CHAT_TASKS.has(row.pipeline_tag) && !row.gated && row.config?.quantization_config?.bits
    && (!budgetBytes || estimateBytes(row.safetensors, row.config.quantization_config.bits) < budgetBytes));
  const out = [];
  for (const row of listed.slice(0, limit)) {
    const bytes = await repoBytes(row.id, fetchImpl) ?? estimateBytes(row.safetensors, row.config.quantization_config.bits);
    const config = await fetchImpl(`${HUB}/${row.id}/raw/main/config.json`, { signal: AbortSignal.timeout(20_000) })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    const kv = config ? kvBytesFromConfig(config) : null;
    const contextMax = config ? (config.text_config ?? config).max_position_embeddings ?? null : null;
    const need = kv === null ? null : bytes + kv * contextTokens + 512 * 1024 ** 2;
    out.push({
      id: row.id, downloads: row.downloads, lastModified: row.lastModified, task: row.pipeline_tag,
      bits: row.config.quantization_config.bits, architecture: row.config.architectures?.[0] ?? null,
      bytes, kvBytesPerToken: kv, contextMax, needBytesAtContext: need,
      fits: need === null || !budgetBytes ? null : need <= budgetBytes && (contextMax ?? contextTokens) >= contextTokens,
      toolCalls: /\btools\b/.test(row.config.tokenizer_config?.chat_template ?? '') || null,
    });
  }
  return { source: `${HUB}/models?author=mlx-community`, contextTokens, budgetBytes: budgetBytes ?? null, candidates: out };
}
