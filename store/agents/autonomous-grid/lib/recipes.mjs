// Official serving recipes, read live from the engines' own sites. When a site has no entry for the
// model this throws NoRecipe: the caller says so and never invents flags.
const VLLM_SITE = 'https://recipes.vllm.ai';
const SGLANG_INDEX = 'https://docs.sglang.io/llms.txt';

export class NoRecipe extends Error {
  constructor(message) { super(message); this.code = 'NO_RECIPE'; }
}

const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');

async function get(fetchImpl, url, as) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status} for ${url}`);
  return as === 'json' ? response.json() : response.text();
}

function checkId(hfId) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(hfId || '')) throw new Error('Pass the Hugging Face id: ORG/NAME');
}

/** vLLM's per-model recipe: minimum version, always-on args, features (tool calls, reasoning, opt-ins), variants. */
export async function vllmRecipe(hfId, { fetchImpl = globalThis.fetch } = {}) {
  checkId(hfId);
  const catalogue = await get(fetchImpl, `${VLLM_SITE}/models.json`, 'json');
  if (!Array.isArray(catalogue)) throw new Error('recipes.vllm.ai/models.json did not return a list');
  const entry = catalogue.find(row => row.hf_id?.toLowerCase() === hfId.toLowerCase());
  if (!entry) throw new NoRecipe(`recipes.vllm.ai has no recipe for ${hfId}.`);
  const recipe = await get(fetchImpl, `${VLLM_SITE}${entry.json}`, 'json');
  if (!recipe) throw new NoRecipe(`recipes.vllm.ai lists ${entry.hf_id} but its recipe file is missing.`);
  const model = recipe.model ?? {}, optIn = new Set(recipe.opt_in_features ?? []);
  const recommended = recipe.recommended_command ?? {};
  return {
    engine: 'vllm', source: `${VLLM_SITE}${entry.url}`, hfId: entry.hf_id,
    minVersion: model.min_vllm_version ?? null, contextLength: Number(model.context_length) || null,
    architecture: model.architecture ?? null, parameters: model.parameter_count ?? null, activeParameters: model.active_parameters ?? null,
    baseArgs: model.base_args ?? [], baseEnv: model.base_env ?? {},
    features: Object.fromEntries(Object.entries(recipe.features ?? {}).map(([name, feature]) =>
      [name, { optIn: optIn.has(name), args: feature.args ?? [], env: feature.env ?? {}, description: feature.description ?? '' }])),
    variants: Object.fromEntries(Object.entries(recipe.variants ?? {}).map(([name, variant]) => [name, {
      modelId: variant.model_id ?? model.model_id ?? entry.hf_id, precision: variant.precision ?? null,
      vramMinimumGb: variant.vram_minimum_gb ?? null, extraArgs: variant.extra_args ?? [], description: variant.description ?? '',
    }])),
    install: model.install ?? null,
    recommended: { hardware: recommended.hardware ?? null, variant: recommended.variant ?? null, command: recommended.command ?? null, dockerImage: recommended.docker_image ?? null },
    guide: recipe.guide ?? '',
  };
}

/** A heading's text up to the next heading of the same or a higher level; `#` lines inside code fences are not headings. */
function section(markdown, heading) {
  const lines = markdown.split('\n'), wanted = new RegExp(`^(#{2,3}) .*${heading}`, 'i');
  let fenced = false, level = 0;
  const kept = [];
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;
    const depth = !fenced && !/^```/.test(line) ? line.match(/^(#{1,6}) /)?.[1].length : undefined;
    if (!level) { if (depth && wanted.test(line)) { level = depth; kept.push(line); } continue; }
    if (depth && depth <= level) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** SGLang's cookbook page for the model's family: its serve commands, parsers, install and tuning notes. */
export async function sglangCookbook(hfId, { fetchImpl = globalThis.fetch } = {}) {
  checkId(hfId);
  const index = await get(fetchImpl, SGLANG_INDEX, 'text');
  if (!index) throw new Error('docs.sglang.io/llms.txt is unavailable');
  const pages = [...index.matchAll(/\]\((https:\/\/docs\.sglang\.io\/cookbook\/autoregressive\/([^/)]+)\/([^/)]+)\.md)\)/g)]
    .map(([, url, org, family]) => ({ url, org, family }));
  const name = squash(hfId.split('/')[1]);
  const fits = pages.filter(page => squash(page.family) && name.startsWith(squash(page.family)));
  const longest = Math.max(0, ...fits.map(page => squash(page.family).length));
  const best = fits.filter(page => squash(page.family).length === longest);
  if (!best.length) throw new NoRecipe(`The SGLang cookbook has no page for ${hfId}.`);
  const page = best[0];
  const markdown = await get(fetchImpl, page.url, 'text');
  if (!markdown) throw new NoRecipe(`${page.url} is listed but missing.`);
  const blocks = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match => match[1].trim());
  const values = flag => [...new Set([...markdown.matchAll(new RegExp(`--${flag}[ =]+([A-Za-z0-9_.-]+)`, 'g'))].map(match => match[1]))];
  return {
    engine: 'sglang', source: page.url, family: page.family, alsoMatching: best.slice(1).map(other => other.url),
    toolCallParsers: values('tool-call-parser'), reasoningParsers: values('reasoning-parser'),
    serveCommands: blocks.filter(block => /sglang serve|sglang\.launch_server/.test(block)).slice(0, 6),
    installation: section(markdown, 'Installation'), configurationTips: section(markdown, 'Configuration Tips'),
  };
}

export async function recipe(engine, hfId, options) {
  if (engine === 'vllm') return vllmRecipe(hfId, options);
  if (engine === 'sglang') return sglangCookbook(hfId, options);
  throw new Error('Use: fleet recipe vllm|sglang ORG/NAME');
}
