import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ASLEEP_CODE, ASLEEP_STATE, atomicJson, gridJson, NO_WAKE, now, number, operations, readConfig, readJson, stateDir, text } from './fleet.mjs';

const array = value => Array.isArray(value) ? value : [];
const objects = value => array(value).filter(v => v && typeof v === 'object' && !Array.isArray(v));
const firstNumber = (...values) => values.map(number).find(n => n !== null) ?? null;
const gb = mb => number(mb) === null ? null : mb / 1024;
const unique = values => [...new Set(values)];
const key = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function normalizeNode(raw, mode, modelNames = new Map(), index = 0) {
  const name = text(raw.name || raw.engine || raw.node_id || raw.id) || `Engine ${index + 1}`;
  const endpoint = safeUrl(raw.where || raw.endpoint_url);
  const plan = text(raw.plan_type);
  // Grid's engine inventory can advertise one card's memory_gb while live VRAM spans
  // every GPU. Use the matching aggregate sensor pair before rounded inventory fields.
  const memoryTotal = plan ? null : firstNumber(gb(raw.vram_total_mb), raw.vram_gb, raw.memory_gb);
  const used = plan ? null : firstNumber(gb(raw.vram_used_mb), raw.memory_used_gb);
  const platform = text(raw.platform);
  const models = unique(array(raw.models).map(v => text(typeof v === 'string' ? v : v?.model)).filter(Boolean)).map(id => modelNames.get(id.toLowerCase()) || id);
  const id = key(JSON.stringify([text(raw.node_id || raw.id), name, endpoint]));
  const answered = normalizeAnswered(raw.answered);
  return {
    id, name, engine: text(raw.kind || (raw.name ? raw.engine : '')) || 'Grid engine', endpoint,
    hardware: text(raw.chip || raw.hardware || raw.device), platform, hosted: Boolean(plan), plan: plan || null,
    online: raw.online === true ? true : raw.online === false ? false : mode === 'local' ? true : null,
    models, memoryKind: plan ? null : (text(raw.memory_kind) || (platform.toLowerCase().startsWith('macos-arm') ? 'Unified memory' : 'VRAM')),
    memoryTotalGb: memoryTotal, memoryUsedGb: used,
    memoryFreeGb: memoryTotal !== null && used !== null ? Math.max(0, memoryTotal - used) : null,
    temperatureC: firstNumber(raw.gpu_temp_c), utilizationPct: firstNumber(raw.gpu_util_pct),
    powerW: firstNumber(raw.gpu_power_w), powerLimitW: firstNumber(raw.gpu_power_limit_w),
    diskTotalGb: firstNumber(raw.disk_total_gb), diskUsedGb: firstNumber(raw.disk_used_gb),
    tokS: firstNumber(raw.throughput_tok_s), concurrency: firstNumber(raw.max_concurrency, raw.parallel),
    activeRequests: firstNumber(raw.active_tasks, raw.load?.active_tasks), answered,
    capabilities: models.map(model => {
      const caps = raw.model_capabilities?.[model.toLowerCase()] || raw.model_capabilities?.[model];
      const entry = array(raw.models).find(m => m?.model === model);
      return { model, contextLength: firstNumber(caps?.context_length, entry?.context_length), responses: array(raw.responses_models).some(m => String(m).toLowerCase() === model.toLowerCase()) };
    }),
  };
}

export function normalizeAnswered(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return { windowSeconds: number(raw.window_seconds), tokensIn: number(raw.tokens_in), tokensCached: number(raw.tokens_cached), tokensOut: number(raw.tokens_out), requests: number(raw.requests) };
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

export function normalizeDevice(machine, raw, observedAt) {
  const memory = raw?.memory || {}, disk = raw?.disk || {}, cpu = raw?.cpu || {}, device = raw?.machine || {};
  return {
    id: machine.id, name: machine.name, transport: machine.transport, observedAt,
    hardware: text(device.model || cpu.brand), platform: text(device.platform), backend: text(raw?.backend),
    memoryTotalGb: number(memory.total_gb), memoryAvailableGb: number(memory.available_gb),
    usableModelGb: number(raw?.usable_bytes) === null ? null : raw.usable_bytes / (1024 ** 3),
    cpuCores: number(cpu.physical_cores), cpuThreads: number(cpu.logical_threads),
    diskTotalGb: number(disk.total_gb), diskFreeGb: number(disk.free_gb),
    gpus: objects(raw?.gpus).map(g => ({ name: text(g.name), memoryGb: gb(g.memory_total_mb), memoryUsedGb: gb(g.memory_used_mb), temperatureC: firstNumber(g.temperature_c, g.gpu_temp_c), utilizationPct: firstNumber(g.utilization_pct, g.utilization_percent, g.gpu_util_pct), powerW: firstNumber(g.power_draw_w, g.gpu_power_w) })),
  };
}

/** How often a SLEEPING grid is looked at again. Nothing about it changes until something wakes it, and
 *  each look is a status read plus, for a member, one credential-less refusal — cheap, but not free. */
export const ASLEEP_POLL_MS = 30_000;

/** `HH:MM` on this computer's clock — the time a person reads next to "showing the reading from". */
const clock = iso => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; };

/**
 * One observation from `reads`. `hold` is set when this poll deliberately showed nothing new:
 * `'asleep'` (the platform says the grid is resting) or `'updating'` (this computer's `grid` is too
 * old for NO_WAKE, so it could not be read without waking it). Either way the previous nodes stay on
 * screen, marked stale, and NO event is derived — a resting grid has not lost its engines, and saying
 * "no longer serving" about every one of them was the false alarm this replaces.
 */
export function assemble(config, reads, previous = null, observedAt = now(), hold = null) {
  const scope = JSON.stringify([config.mode, config.grid, config.controller]);
  if (previous?.scope !== scope) previous = null;
  const sources = Object.fromEntries(Object.entries(reads).map(([name, result]) => [name, { ok: result.ok, error: result.ok ? null : result.error, observedAt }]));
  // Asleep is an answer, not a failed read: a member learns it from the refusal of a grid read, and
  // reporting that as a broken source would put an error finding in the agent's verdict for a grid at rest.
  if (hold === 'asleep') for (const [name, result] of Object.entries(reads)) if (result.refusal === ASLEEP_CODE) sources[name] = { ok: true, error: null, observedAt };
  // Too old to read without waking: the one refused read stands for the whole reading, under the
  // `engines` source the notice goes on below — not beside it as a raw usage line.
  if (hold === 'updating') for (const [name, result] of Object.entries(reads)) if (result.outdated) delete sources[name];
  const info = reads.info?.ok && reads.info.value && typeof reads.info.value === 'object' ? reads.info.value : {};
  const stats = reads.stats?.ok && reads.stats.value && typeof reads.stats.value === 'object' ? reads.stats.value : {};
  const modelNames = new Map(objects(reads.models?.value).map(m => [text(m.model).toLowerCase(), text(m.model)]).filter(([a,b]) => a && b));
  let nodes;
  const fresh = !hold && reads.engines?.ok && Array.isArray(reads.engines.value);
  // The time of the reading on screen: now when this poll read one, otherwise whatever the previous
  // observation was showing. An older snapshot on disk predates the field; its own time counts only if
  // it was itself a reading.
  const readingFrom = fresh ? observedAt : previous ? (previous.readingFrom ?? (['live', 'partial'].includes(previous.status) ? previous.observedAt : null)) : null;
  const controllerName = text(config.machines?.find(m => m.id === config.controller)?.name) || 'This computer';
  const notice = hold === 'asleep' ? 'Asleep · starts when you send a message'
    : hold === 'updating' ? `${controllerName} is being updated — ${readingFrom ? `showing the reading from ${clock(readingFrom)}` : 'there is no earlier reading to show'}`
    : undefined;
  if (hold === 'updating') sources.engines = { ok: false, error: notice, observedAt };
  if (fresh) {
    const cards = objects(stats.engines);
    nodes = objects(reads.engines.value).slice(0, 256).map((raw,i) => {
      const matches = cards.filter(c => c.engine === raw.name);
      const normalized = normalizeNode(matches.length === 1 ? { ...matches[0], ...raw } : raw, config.mode, modelNames, i);
      return { ...normalized, observedAt, stale: false };
    });
    // A missing engine remains visible briefly as offline. Do not invent ongoing traffic after it left.
    const ids = new Set(nodes.map(n => n.id));
    for (const node of previous?.nodes || []) if (!ids.has(node.id) && Date.parse(observedAt) - Date.parse(node.observedAt) < 10 * 60_000) nodes.push({ ...node, online: false, activeRequests: null, stale: false });
  } else {
    nodes = (previous?.nodes || []).map(n => ({ ...n, stale: true }));
    if (reads.engines?.ok) sources.engines = { ok: false, error: 'Grid returned an unexpected engine list.', observedAt };
  }
  // An id is a node identity, not a display label. Keep duplicate names independently inspectable.
  const seen = new Map();
  nodes = nodes.map(n => { const count = seen.get(n.id) || 0; seen.set(n.id, count + 1); return count ? { ...n, id: `${n.id}-${count}` } : n; });
  const online = nodes.filter(n => n.online === true && !n.stale);
  const modelIds = unique(online.flatMap(n => n.models));
  const models = modelIds.map(id => ({ id, nodes: online.filter(n => n.models.includes(id)).map(n => n.id) }));
  const history = Object.fromEntries(nodes.map(n => {
    const samples = [...(previous?.history?.[n.id] || [])].filter(s => Date.parse(observedAt) - Date.parse(s.at) < 15 * 60_000);
    if (fresh && n.online === true) samples.push({ at: observedAt, tokS: n.tokS, temperatureC: n.temperatureC, utilizationPct: n.utilizationPct, memoryUsedGb: n.memoryUsedGb, powerW: n.powerW });
    return [n.id, samples.slice(-90)];
  }));
  const events = [...(previous?.events || [])];
  const addEvent = (kind, message, nodeId) => events.unshift({ id: `${observedAt}:${kind}:${nodeId}`, at: observedAt, kind, message, nodeId });
  if (fresh) for (const n of nodes) {
    const old = previous?.nodes?.find(p => p.id === n.id);
    if ((!old || old.online !== true) && n.online === true) addEvent('online', `${n.name} joined the grid`, n.id);
    // Only a node last SEEN serving can be said to have stopped. One held stale through a sleep (or a
    // failed read) is a last-known entry: a cold wake that has not heard from it yet is not news.
    if (old?.online === true && !old.stale && n.online === false) addEvent('offline', `${n.name} is no longer serving`, n.id);
    if (old && n.online === true && JSON.stringify(old.models) !== JSON.stringify(n.models)) addEvent('models', `${n.name} updated its models`, n.id);
  }
  return {
    spec: 1, scope, observedAt, readingFrom, ...(notice ? { notice } : {}), mode: config.mode, grid: text(info.grid || stats.grid || config.grid) || 'Your grid', endpoint: safeUrl(info.grid_url),
    status: hold || (!fresh ? 'unavailable' : Object.values(sources).some(s => !s.ok) ? 'partial' : 'live'),
    sources, nodes, models, history, events: events.slice(0, 40),
    summary: { enginesOnline: online.length, enginesKnown: nodes.length, modelsServing: models.length, answered: normalizeAnswered(stats.answered), uptimePct: number(stats.uptime_pct), concurrency: number(stats.parallel), activeRequests: online.length && online.every(n => n.activeRequests !== null) ? online.reduce((sum,n) => sum + n.activeRequests, 0) : null },
    preferences: config.preferences,
  };
}

/**
 * A remote grid's reads, in the order that lets a sleeping grid be SEEN without being started — and
 * read ONCE per poll.
 *
 * `info` first: it asks the control plane, never the grid, and for the grid's owner its status says
 * `asleep` outright — then nothing else is read. A member is shown no status, so `stats` goes next,
 * alone, with NO_WAKE: a sleeping grid refuses it with ASLEEP_CODE. A `grid` too old for NO_WAKE refuses
 * it outright (exit 2); the others would be refused too, and running them WITHOUT the flag is exactly the
 * wake this exists to stop — so the poll ends there and the last reading stays up.
 *
 * `stats --json` carries `grid engines --json` and `grid models --json` under `listings`, out of the one
 * overview read it made (autonomous-grid `cli/remote_stats.py`; ⚠️ a cross-repo contract, pinned by that
 * repository's `tests/test_grid_reads_lockstep.py`). A `grid` older than the listings is read the old
 * way: engines alone, and only an engines answer earns models.
 */
async function readRemote(read) {
  const reads = { info: await read('info') };
  if (reads.info.ok && reads.info.value?.status === ASLEEP_STATE) return { reads, hold: 'asleep' };
  reads.stats = await read('stats', [NO_WAKE]);
  if (reads.stats.refusal === ASLEEP_CODE) return { reads, hold: 'asleep' };
  if (reads.stats.outdated) return { reads, hold: 'updating' };
  const listings = reads.stats.ok ? reads.stats.value?.listings : null;
  if (Array.isArray(listings?.engines) && Array.isArray(listings?.models)) {
    return { reads: { ...reads, engines: { ok: true, value: listings.engines }, models: { ok: true, value: listings.models } }, hold: null };
  }
  reads.engines = await read('engines', [NO_WAKE]);
  if (reads.engines.refusal === ASLEEP_CODE) return { reads, hold: 'asleep' };
  return { reads: { ...reads, models: await read('models', [NO_WAKE]) }, hold: null };
}

/** A LAN grid has no proxy and nothing to wake, so its reads are asked together as they always were —
 *  and without NO_WAKE, which a user's own older `grid` would refuse for no benefit at all. */
async function readLocal(read) {
  const names = ['info', 'engines', 'models'];
  const results = await Promise.all(names.map(name => read(name)));
  return { reads: Object.fromEntries(names.map((name, i) => [name, results[i]])), hold: null };
}

export function createCollector(workspace, { runJson = gridJson, intervalMs = 8000 } = {}) {
  let inFlight, deviceCache = new Map(), previous;
  async function followSelection(config) {
    // Only a workspace that HAS a grid follows the selection; one with none waits for `connect`
    // (initialization already consulted the selection once) and contacts nothing meanwhile.
    if (config.mode !== 'remote' || !config.grid) return null;
    const controller = config.machines.find(m => m.id === config.controller);
    const active = await runJson(controller, 'remote', ['use'], { timeoutMs: 5000 }).catch(() => null);
    const selected = typeof active?.value?.active === 'string' ? active.value.active.trim() : '';
    if (!selected || selected.startsWith('-') || selected === config.grid) return null;
    const next = { ...config, grid: selected };
    await atomicJson(join(workspace, 'grid-fleet.json'), next);
    return next;
  }
  async function collect() {
    let config = await readConfig(workspace);
    // Follow the CLI's selection: `grid use` is the one place a grid is chosen, and a workspace
    // that kept its own copy showed a team's grid for the rest of the day after the person had
    // switched to their own in a terminal. Read every poll (a local file, no network); a change
    // is written back so the next poll, and the agent, read the same grid.
    const followed = await followSelection(config);
    if (followed) config = followed;
    if (!config.grid) {
      const observedAt=now(),message='Choose a grid with fleet connect --mode local|remote --grid NAME. No fleet has been selected for this workspace.';
      const snapshot={spec:1,scope:JSON.stringify([config.mode,config.grid,config.controller]),observedAt,mode:config.mode,grid:'Choose your grid',status:'unconfigured',nodes:[],models:[],machines:[],history:{},events:[],operations:[],sources:{configuration:{ok:false,error:message,observedAt}},summary:{},preferences:config.preferences,pollIntervalMs:intervalMs};
      await atomicJson(join(stateDir(workspace),'snapshot.json'),snapshot);
      await atomicJson(join(workspace,'.harness','verdict.json'),{spec:1,ready:false,summary:'Choose a grid to connect your fleet',findings:[],updatedAt:observedAt});
      previous=snapshot;return snapshot;
    }
    const controller = config.machines.find(m => m.id === config.controller);
    const selector = config.grid ? [config.grid] : [];
    const read = (command, extra = []) => runJson(controller, config.mode, [command, ...selector, ...extra]).catch(() => ({ ok: false, error: `grid ${command} could not be read.` }));
    // `ls` beside the per-grid reads: the viewer's grid dropdown is every grid this account is in,
    // read fresh each poll so a grid joined a minute ago is offered without a restart.
    const listing = runJson(controller, config.mode, ['ls']).catch(() => null);
    const { reads, hold } = config.mode === 'remote' ? await readRemote(read) : await readLocal(read);
    const listed = await listing;
    const grids = Array.isArray(listed?.value)
      ? listed.value.map(row => ({ name: text(row.grid || row.name || row.id), type: text(row.type) })).filter(g => g.name && !g.name.startsWith('-'))
      : previous?.grids || [];
    previous ||= await readJson(join(stateDir(workspace), 'snapshot.json'), null).catch(() => null);
    const observedAt = now();
    const snapshot = assemble(config, reads, previous, observedAt, hold);
    snapshot.grids = grids;
    snapshot.machines = await Promise.all(config.machines.map(async machine => {
      const cacheKey = JSON.stringify(machine);
      let cached = deviceCache.get(cacheKey);
      if (!cached || Date.now() - cached.fetchedAt > 60_000) {
        const result = await runJson(machine, config.mode, ['device-info']).catch(() => ({ ok: false, error: 'Machine did not answer.' }));
        cached = { fetchedAt: Date.now(), result }; deviceCache.set(cacheKey, cached);
      }
      return cached.result.ok ? { ...normalizeDevice(machine, cached.result.value, new Date(cached.fetchedAt).toISOString()), reachable: true } : { id: machine.id, name: machine.name, transport: machine.transport, reachable: false, error: cached.result.error, observedAt: new Date(cached.fetchedAt).toISOString() };
    }));
    // Inventory edits should not retain unbounded old host entries in this long-running process.
    const activeKeys = new Set(config.machines.map(m => JSON.stringify(m)));
    for (const k of deviceCache.keys()) if (!activeKeys.has(k)) deviceCache.delete(k);
    snapshot.operations = await operations(workspace);
    snapshot.pollIntervalMs = hold === 'asleep' ? ASLEEP_POLL_MS : intervalMs;
    await atomicJson(join(stateDir(workspace), 'snapshot.json'), snapshot);
    const failures = Object.entries(snapshot.sources).filter(([,s]) => !s.ok);
    await atomicJson(join(workspace, '.harness', 'verdict.json'), {
      spec: 1, ready: snapshot.status !== 'unavailable',
      summary: snapshot.status === 'unavailable' ? 'Grid unavailable · ask the agent to connect your fleet' : snapshot.notice || `${snapshot.summary.enginesOnline} engines online · ${snapshot.summary.modelsServing} models serving${snapshot.status === 'partial' ? ' · partial telemetry' : ''}`,
      findings: failures.map(([kind,s]) => ({ severity: kind === 'engines' && !hold ? 'error' : 'warning', kind, message: s.error })),
      phases: [{ id: 'connect', name: 'Connect', state: snapshot.status === 'unavailable' ? 'active' : 'done' }, { id: 'observe', name: 'Observe', state: snapshot.status === 'unavailable' ? 'pending' : 'active' }], updatedAt: observedAt,
    });
    previous = snapshot;
    return snapshot;
  }
  return () => inFlight ||= collect().finally(() => { inFlight = null; });
}
