const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gib = bytes => Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) : '—';
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const active = job => ['queued', 'running'].includes(job.status);
let state;
let selectedModel = sessionStorage.getItem('harness-model') || '';
let pending = false;
let modelSignature = '';
let benchmarkSignature = '';
let initialized = false;
let lastReceived = Date.now();
const jobElements = new Map();
const jobSignatures = new Map();
const chatHistory = new Map();
const chatRequests = new Map();
const completed = new Set();
const embedded = new URLSearchParams(location.search).get('view') === 'grid';
document.body.classList.toggle('embedded-viewer', embedded);

function toast(text) { const el = $('#toast'); el.textContent = text; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4500); }
function scrollConversation() { const el = $('#conversation'); el.scrollTop = el.scrollHeight; }
function appendMessage(text, user = false) {
  const el = document.createElement('div'); el.className = user ? 'user-message' : 'assistant-message';
  if (user) el.textContent = text;
  else el.innerHTML = `<span class="message-label">vLLM</span><p class="message-text">${escapeHTML(text)}</p>`;
  $('#conversation').append(el); scrollConversation(); return el;
}
async function api(path, body) {
  if (!state?.token) await refresh();
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': state?.token || '' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 403) void refresh(); throw new Error(result.error || 'The request failed.'); }
  return result;
}
async function refresh() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('Could not reach the vLLM viewer');
    applyState(await response.json());
  } catch (error) { $('#connection-status').textContent = 'vLLM viewer disconnected'; $('#operator-status').textContent = 'Reconnect to send a request'; return false; }
  return true;
}
function applyState(next) {
  lastReceived = Date.now(); state = { ...state, ...next };
  if (selectedModel && !state.runtime.models.some(m => m.id === selectedModel)) selectedModel = '';
  if (!selectedModel) selectedModel = state.runtime.models.find(m => m.running)?.id || '';
  render();
  if (!initialized) {
    [...state.jobs].slice(0, 4).reverse().forEach(job => showJob(job, true)); initialized = true;
  }
  for (const job of state.jobs) if (jobElements.has(job.id) || active(job)) showJob(job);
  renderActiveJob();
  renderActivity();
}
function selectModel(model) {
  selectedModel = model; sessionStorage.setItem('harness-model', model);
  $('#selected-model').value = model;
  $('#operator-status').textContent = model || 'vLLM harness';
  document.querySelectorAll('[data-model]').forEach(el => el.classList.toggle('selected', el.dataset.model === model));
}
function render() {
  const { runtime, system, benchmarks, runs } = state;
  const models = runtime.models || [];
  const loaded = models.filter(m => m.running);
  const lastJob = state.jobs[0];
  const notice = $('#runtime-notice');
  notice.hidden = lastJob?.status !== 'failed';
  if (!notice.hidden) {
    const affected = lastJob.activeModel || lastJob.model || lastJob.models?.join(', ') || 'vLLM';
    const explanation = /tensor.*size overflow/i.test(lastJob.message)
      ? "vLLM could not read this model’s weights. Other models can still run."
      : 'The last operation failed. Check the details before retrying.';
    notice.innerHTML = `<strong>${escapeHTML(affected)} · ${escapeHTML(lastJob.type)} failed</strong><p>${escapeHTML(explanation)}</p><details><summary>Error details</summary><pre>${escapeHTML(lastJob.message)}</pre></details>`;
  }
  $('#connection-status').textContent = runtime.online ? 'vLLM connected' : 'vLLM offline';
  $('#model-count').textContent = runtime.online ? models.length : '—';
  $('#models-total').textContent = models.length;
  $('#running-count').textContent = runtime.online ? loaded.length : '—';
  $('#model-memory').innerHTML = `${runtime.online ? gib(loaded.reduce((sum, m) => sum + (m.resident?.size || 0), 0)) : '—'} <small>GiB</small>`;
  const recent = runs[0];
  $('#last-speed').innerHTML = `${number(recent?.tokensPerSecond)} <small>tok/s</small>`;
  $('#last-speed').title = recent ? `${recent.model} · ${new Date(recent.at).toLocaleString()}` : 'A chat response will appear here';
  $('#map-status').textContent = runtime.online ? 'LIVE CONNECTION' : 'READY TO START';
  $('#map-status').classList.toggle('online', runtime.online);
  $('#machine-info').textContent = `${system.chip} · ${Math.round(system.totalMemory / 1024 ** 3)} GiB`;
  const signature = JSON.stringify({ online: runtime.online, version: runtime.version, models, selectedModel });
  if (signature !== modelSignature) {
    modelSignature = signature;
    $('#runtime-map').innerHTML = `<div class="runtime-node ${runtime.online ? '' : 'offline'}"><img class="node-icon" src="/assets/vllm-icon.png" width="42" height="42" alt=""><strong>vLLM</strong><small>${runtime.online ? `v${escapeHTML(runtime.version)}` : 'Not running'}</small></div><div class="model-nodes">${models.length ? models.map(m => `<button class="model-node ${m.running ? 'active' : ''} ${selectedModel === m.id ? 'selected' : ''}" data-model="${escapeHTML(m.id)}"><strong>${escapeHTML(m.name)}</strong><span>${m.running ? 'In memory' : 'On disk'} · ${gib(m.size)} GiB</span></button>`).join('') : `<div class="map-empty empty-node"><strong>Your first vLLM model starts here.</strong>Ask the operator to run your first model.<br>Its connection will appear here.</div>`}</div>`;
    $('#models-list').innerHTML = models.length ? models.map(m => `<button class="model-row ${selectedModel === m.id ? 'selected' : ''}" data-model="${escapeHTML(m.id)}"><span class="model-title"><strong>${escapeHTML(m.name)}</strong><small>${escapeHTML([m.family, m.parameters, m.quantization].filter(Boolean).join(' · '))}</small></span><span class="model-status ${m.running ? 'loaded' : ''}">${m.running ? 'In memory' : 'On disk'}</span><span class="model-numeric">${gib(m.size)} GiB</span><span class="model-numeric">vLLM</span></button>`).join('') : `<div class="empty-small"><p>${runtime.online ? 'No models downloaded yet.' : 'Start vLLM to discover your models.'}</p><span>Say “run a lightweight model” to get started.</span></div>`;
    $('#selected-model').innerHTML = `<option value="">Auto · running model</option>${models.map(m => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.name)}</option>`).join('')}`;
    $('#selected-model').value = selectedModel;
    $('#operator-status').textContent = selectedModel || 'vLLM harness';
  }
  const benchSignature = JSON.stringify(benchmarks.map(b => b.id));
  if (benchSignature !== benchmarkSignature) { benchmarkSignature = benchSignature; renderBenchmarks(); }
  $('#export-benchmarks').hidden = !benchmarks.length && !state.loadTests?.length; renderServing(); renderLoadTests();
}
function renderBenchmarks() {
  const latest = [...new Map([...state.benchmarks].reverse().map(b => [b.model, b])).values()].sort((a, b) => b.medianTokensPerSecond - a.medianTokensPerSecond);
  if (!latest.length) return;
  const maxSpeed = Math.max(...latest.map(b => b.medianTokensPerSecond), 1);
  const maxLatency = Math.max(...latest.map(b => b.medianFirstTokenMs), 1);
  const bars = (key, max, unit) => latest.map(b => `<div class="chart-row"><span>${escapeHTML(b.model.split("/").at(-1))}</span><div class="bar-track"><div class="bar-fill ${key === 'medianFirstTokenMs' ? 'latency' : ''}" style="width:${Math.max(0, b[key] / max * 100)}%"></div></div><span class="bar-value">${number(b[key], key === 'medianFirstTokenMs' ? 0 : 1)} <small>${unit}</small></span></div>`).join('');
  $('#performance-content').innerHTML = `<div class="chart-heading"><h3>Request throughput</h3><span>tokens/s · higher is faster</span></div><div class="chart-bars" role="group" aria-label="Measured median end-to-end request throughput">${bars('medianTokensPerSecond', maxSpeed, '')}</div><div class="chart-heading second-chart"><h3>Time to first token</h3><span>milliseconds · lower is faster</span></div><div class="chart-bars" role="group" aria-label="Measured median time to first token">${bars('medianFirstTokenMs', maxLatency, '')}</div><p class="benchmark-meta">Latest benchmark per model · median of 3 warm runs<br>Same prompt · 2,048-token context · up to 128 generated tokens · seed 42<br>Thinking off when supported; actual mode is recorded per run.<br>Repeated prompts can use the prefix cache. Token throughput includes prompt processing and HTTP; it is not native decode speed or answer quality.</p><details class="benchmark-details"><summary>Samples and measurement details</summary>${latest.map(b => `<div class="sample-record"><strong>${escapeHTML(b.model)}</strong><span>${new Date(b.at).toLocaleString()} · vLLM ${escapeHTML(b.runtime.version)}</span><span>Speed: ${b.samples.map(s => number(s.tokensPerSecond)).join(' / ')} tokens/s</span><span>First token: ${b.samples.map(s => number(s.firstTokenMs, 0)).join(' / ')} ms</span><span>Tokens generated: ${b.samples.map(s => s.tokens).join(' / ')} · thinking: ${escapeHTML(String(b.samples[0].thinking ?? 'not reported'))} · server RSS: ${gib(b.residentBytes)} GiB</span></div>`).join('')}</details>`;
}
function showJob(job, historical = false) {
  let el = jobElements.get(job.id);
  if (!el) {
    el = document.createElement('div'); el.className = 'assistant-message job-message';
    jobElements.set(job.id, el); $('#conversation').append(el);
  }
  const signature = JSON.stringify(job);
  if (jobSignatures.get(job.id) === signature) return;
  jobSignatures.set(job.id, signature);
  const failed = ['failed', 'cancelled', 'interrupted'].includes(job.status);
  const metrics = job.result?.metrics;
  const label = job.type === 'chat' ? job.model : 'vLLM';
  el.innerHTML = `<span class="message-label">${escapeHTML(label)} <span class="job-state ${failed ? 'error-text' : ''}">${escapeHTML(job.status)}</span></span><p class="message-text ${failed ? 'error-text' : ''}">${escapeHTML(job.message)}</p>${job.output ? `<div class="stream-output message-text">${escapeHTML(job.output)}</div>` : ''}${metrics ? `<p class="run-metrics">${number(metrics.tokensPerSecond)} tok/s · ${number(metrics.firstTokenMs, 0)} ms first token · ${metrics.tokens ?? '—'} tokens${metrics.thinking ? ` · ${number(metrics.firstOutputMs, 0)} ms to visible output · reasoning on` : ''}${metrics.peakMemoryBytes ? ` · ${gib(metrics.peakMemoryBytes)} GiB peak allocation` : ''}${metrics.doneReason === 'length' ? ' · output limit reached' : ''}</p>` : ''}${job.persistenceError ? '<p class="error-text">Could not save this result to disk.</p>' : ''}${job.status === 'succeeded' && job.type === 'deploy' ? `<div class="actions"><button data-prompt="Benchmark ${escapeHTML(job.model)}">Benchmark it</button><button data-chat="${escapeHTML(job.model)}">Ask a question</button></div>` : ''}${job.status === 'failed' ? '<p class="secondary">You can retry the request after addressing the error.</p>' : ''}`;
  if (job.status === 'succeeded' && !completed.has(job.id)) {
    completed.add(job.id);
    if (!historical && ['deploy', 'serve', 'chat', 'benchmark', 'load_test'].includes(job.type) && job.result?.model) selectModel(job.result.model);
    const request = chatRequests.get(job.id);
    if (request) {
      const history = chatHistory.get(job.model) || [];
      history.push({ role: 'user', content: request }, { role: 'assistant', content: job.output });
      chatHistory.set(job.model, history.slice(-6).map(m => ({ ...m, content: m.content.slice(0, 6000) }))); chatRequests.delete(job.id);
    }
  }
  if (!historical) scrollConversation();
}
function renderActiveJob() {
  const running = state.jobs.find(j => j.status === 'running') || state.jobs.find(j => j.status === 'queued');
  const panel = $('#job-panel'); panel.hidden = !running;
  if (!running) return;
  const queued = state.jobs.filter(j => j.status === 'queued').length;
  panel.innerHTML = `<div class="job-top"><strong>${escapeHTML(running.type === 'chat' ? 'Generating' : running.type.replaceAll('_', ' '))}</strong><button data-cancel="${escapeHTML(running.id)}">Cancel</button></div><div class="progress-track" role="progressbar" aria-label="Job progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(running.progress)}"><div class="progress-fill" style="width:${running.progress}%"></div></div><p>${escapeHTML(running.message)}${queued ? ` · ${queued} queued` : ''}</p>`;
}
function receiveJob(job) {
  if (!state) return;
  state.jobs = [job, ...state.jobs.filter(j => j.id !== job.id)];
  showJob(job); renderActiveJob(); renderActivity();
}
function renderActivity() {
  const jobs = state.jobs.slice(0, 6);
  $('#activity-content').innerHTML = jobs.length ? jobs.map(job => `<div class="activity-row"><span class="activity-state ${job.status === 'failed' ? 'error-text' : ''}">${escapeHTML(job.status)}</span><div><strong>${escapeHTML(job.model || job.models.join(', ') || 'vLLM')}</strong><p>${escapeHTML(job.message)}</p></div>${active(job) ? `<button data-cancel="${escapeHTML(job.id)}">Cancel</button>` : '<span class="activity-time">' + new Date(job.completedAt || job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>'}</div>`).join('') : '<p class="secondary">Ask the agent to run a model. Its progress will appear here.</p>';
}
async function sendCommand(text) {
  if (pending || !text.trim()) return;
  pending = true; $('#send-button').disabled = true; $('#suggestions').hidden = true;
  appendMessage(text, true); $('#command-input').value = '';
  try {
    const result = await api('/api/command', { text, selectedModel: selectedModel || undefined, history: chatHistory.get(selectedModel) || [] });
    if (result.job) {
      if (result.job.type === 'chat') { const prompt = text.match(/^(?:ask|tell|chat with)\s+.+?\s*:\s*([\s\S]+)$/i)?.[1] || text; chatRequests.set(result.job.id, prompt); }
      receiveJob(result.job);
    } else {
      const el = appendMessage(result.message || 'Choose a model to get started.');
      if (result.models) el.insertAdjacentHTML('beforeend', result.models.map(m => `<div class="catalog-card"><strong>${escapeHTML(m.name)}</strong><p>${escapeHTML(m.description)}</p><p class="secondary">About ${number(m.downloadGB, 2)} GB to download</p><button data-action="deploy" data-target="${escapeHTML(m.id)}">Run this model</button></div>`).join(''));
    }
  } catch (error) { appendMessage(error.message).classList.add('error-text'); }
  finally { pending = false; $('#send-button').disabled = false; scrollConversation(); }
}
async function runAction(type, model) {
  $('#model-dialog').close();
  const action = type === 'benchmark' ? { type, models: [model] } : { type, model };
  appendMessage(`${type === 'deploy' ? 'Run' : type[0].toUpperCase() + type.slice(1)} ${model}`, true);
  try { const result = await api('/api/action', action); receiveJob(result.job); return { jobId: result.job.id, status: result.job.status }; }
  catch (error) { appendMessage(error.message).classList.add('error-text'); throw error; }
}
function inspectModel(id) {
  const model = state.runtime.models.find(m => m.id === id); if (!model) return;
  selectModel(id);
  const resident = model.resident;
  $('#model-detail').innerHTML = `<p class="eyebrow">vLLM / MODEL DETAILS</p><h2 id="detail-title">${escapeHTML(model.name)}</h2><p class="secondary">${model.running ? 'Loaded and ready for inference' : 'Downloaded and available to load'}</p><div class="detail-grid"><div><span>Model parameters</span><strong>${escapeHTML(model.parameters || 'Unknown')}</strong></div><div><span>Quantization</span><strong>${escapeHTML(model.quantization || 'Unknown')}</strong></div><div><span>Size on disk</span><strong>${gib(model.size)} GiB</strong></div><div><span>Server process RSS</span><strong>${resident ? `${gib(resident.size)} GiB` : 'Not loaded'}</strong></div><div><span>Context window</span><strong>${resident?.context_length?.toLocaleString() || 'Set when loaded'}</strong></div><div><span>Idle expiry</span><strong>${resident?.expires_at ? new Date(resident.expires_at).toLocaleTimeString() : '—'}</strong></div></div><p class="secondary">RSS sums this workspace’s server processes and may count shared pages more than once. It is not GPU allocation. On Apple Silicon, CPU and GPU share unified memory; this is not a separate physical VRAM pool.</p><div class="actions"><button class="primary" data-action="deploy" data-target="${escapeHTML(id)}">${model.running ? 'Keep ready for 15m' : 'Load model'}</button><button data-action="benchmark" data-target="${escapeHTML(id)}">Benchmark</button><button data-action="load_test" data-target="${escapeHTML(id)}">Test 4 concurrent</button><button data-chat="${escapeHTML(id)}">Chat</button>${model.running ? `<button data-action="unload" data-target="${escapeHTML(id)}">Unload</button>` : ''}</div>`;
  $('#model-dialog').showModal();
}

$('#refresh').addEventListener('click', async () => { if (await refresh()) toast('Model status refreshed'); });
$('#selected-model').addEventListener('change', event => selectModel(event.target.value));
$('#command-form').addEventListener('submit', event => { event.preventDefault(); void sendCommand($('#command-input').value); });
$('#command-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#command-form').requestSubmit(); } });
$('.dialog-close').addEventListener('click', () => $('#model-dialog').close());
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.prompt) void sendCommand(button.dataset.prompt);
  if (button.dataset.model) inspectModel(button.dataset.model);
  if (button.dataset.action) void runAction(button.dataset.action, button.dataset.target).catch(() => {});
  if (button.dataset.chat) { selectModel(button.dataset.chat); $('#model-dialog').close(); $('#command-input').value = 'Ask it: '; $('#command-input').focus(); }
  if (button.dataset.cancel) void api('/api/cancel', { id: button.dataset.cancel }).then(result => receiveJob(result.job)).catch(error => toast(error.message));
});

function renderServing() {
  const serving = state.runtime.serving || {};
  $('#serving-state').textContent = `${serving.status || 'idle'} · Metal ${state.runtime.backendVersion || ''}`;
  const item = (label, value) => `<div class="serving-stat"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
  $('#serving-content').innerHTML = `<div class="serving-grid">${item('Context', serving.context?.toLocaleString() || '—')}${item('Parallel sequences', serving.maxSequences ?? '—')}${item('Metal memory budget', Number.isFinite(serving.memoryFraction) ? `${Math.round(serving.memoryFraction * 100)}%` : '—')}${item('Prefix cache', serving.prefixCaching === undefined ? '—' : serving.prefixCaching ? 'On' : 'Off')}${item('Requests running / waiting', `${serving.runningRequests ?? '—'} / ${serving.waitingRequests ?? '—'}`)}${item('KV cache used', Number.isFinite(serving.cacheUsage) ? `${(serving.cacheUsage * 100).toFixed(1)}%` : '—')}</div><p class="benchmark-meta">Ask the agent to change these settings. The memory budget uses Metal’s recommended working-set limit. Server telemetry can lag active requests.</p>${serving.model ? `<div class="actions"><button data-load-concurrency="1" data-target="${escapeHTML(serving.model)}">Measure 1 request at a time</button><button data-load-concurrency="4" data-target="${escapeHTML(serving.model)}">Measure 4 concurrent requests</button></div>` : ''}`;
  $('#model-memory').innerHTML = `${Number.isFinite(serving.processRssBytes) ? gib(serving.processRssBytes) : '—'} <small>GiB</small>`;
  $('#model-memory').title = 'Summed server process RSS. Shared pages may be counted more than once; this is not GPU allocation.';
  $('#last-speed').title += ' · client end-to-end throughput';
}
let loadTestSignature = '';
function renderLoadTests() {
  const results = (state.loadTests || []).slice(0, 6);
  const signature = JSON.stringify(results.map(test => test.id));
  if (signature === loadTestSignature) return;
  loadTestSignature = signature;
  if (!results.length) {
    $('#concurrency-content').innerHTML = '<div class="empty-small"><span class="empty-icon" aria-hidden="true">⇉</span><p>See what happens when requests overlap.</p><span>Run a model, then ask “test 4 concurrent requests”. Real throughput, latency and errors appear here.</span></div>';
    return;
  }
  const max = Math.max(1, ...results.map(test => test.aggregateTokensPerSecond));
  $('#concurrency-content').innerHTML = results.map(test => `<article class="load-result"><div class="load-title"><div><span class="concurrency-badge">${test.concurrency}×</span><strong>${escapeHTML(test.model.split('/').at(-1))}</strong></div><span class="secondary">${new Date(test.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div class="load-bar"><div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, test.aggregateTokensPerSecond / max * 100)}%"></div></div><strong>${number(test.aggregateTokensPerSecond)} <small>tok/s</small></strong></div><div class="load-metrics"><span><b>${number(test.medianLatencyMs, 0)}</b> ms median</span><span><b>${number(test.p95LatencyMs, 0)}</b> ms p95</span><span><b>${test.succeeded}/${test.requests}</b> completed</span><span class="${test.failed ? 'error-text' : ''}"><b>${test.failed}</b> errors</span></div><details class="load-details"><summary>Settings &amp; samples</summary><p>${test.serving.context.toLocaleString()} context · ${test.serving.maxSequences} parallel sequences · ${Math.round(test.serving.memoryFraction * 100)}% Metal budget · prefix cache ${test.serving.prefixCaching ? 'on' : 'off'}<br>${escapeHTML(test.mode)}<br>${new Date(test.at).toLocaleString()} · vLLM ${escapeHTML(test.runtime.version)} · Metal ${escapeHTML(test.runtime.backendVersion)}</p>${test.samples.map(sample => `<p>Request ${sample.index + 1}: ${sample.status === 'succeeded' ? `${sample.tokens} tokens · ${number(sample.totalMs, 0)} ms · ${number(sample.firstTokenMs, 0)} ms first token` : escapeHTML(sample.error)}</p>`).join('')}</details></article>`).join('') + '<p class="benchmark-meta">Aggregate output tokens ÷ measured batch time. Latency includes queueing, prompt processing and HTTP. Compare identical model and serving settings; shared prefixes may be cached. These small samples are exploratory. Raw samples are included in Export results.</p>';
}
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-load-concurrency]');
  if (!button) return;
  void api('/api/action', { type: 'load_test', model: button.dataset.target, concurrency: Number(button.dataset.loadConcurrency), requests: 8 }).then(result => receiveJob(result.job)).catch(error => toast(error.message));
});
if (document.modelContext?.registerTool) {
  try {
    await document.modelContext.registerTool({ name: 'vllm_serving_action', title: 'Configure or measure vLLM serving', description: 'Apply the serving settings shown in this viewer, or run a bounded concurrent request test. Returns a job ID.', inputSchema: { type: 'object', properties: { type: { enum: ['serve', 'load_test'] }, model: { type: 'string' }, context: { type: 'integer', minimum: 512, maximum: 16384 }, maxSequences: { type: 'integer', minimum: 1, maximum: 8 }, memoryFraction: { type: 'number', minimum: 0.05, maximum: 0.8 }, prefixCaching: { type: 'boolean' }, concurrency: { type: 'integer', minimum: 1, maximum: 8 }, requests: { type: 'integer', minimum: 1, maximum: 32 } }, required: ['type', 'model'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, async execute(input) { if (!['serve', 'load_test'].includes(input?.type)) throw new Error('Unsupported serving action.'); const result = await api('/api/action', input); receiveJob(result.job); return { jobId: result.job.id, status: result.job.status }; } });
  } catch (error) { console.info('vLLM WebMCP unavailable:', error.message); }
}

await refresh();
const events = new EventSource('/api/events');
events.addEventListener('state', event => { try { applyState(JSON.parse(event.data)); } catch { void refresh(); } });
events.addEventListener('job', event => { lastReceived = Date.now(); receiveJob(JSON.parse(event.data)); });
events.addEventListener('error', () => { $('#connection-status').textContent = 'Reconnecting…'; });
setInterval(() => { if (Date.now() - lastReceived > 12000) void refresh(); }, 10000);

// The same visible UI actions are available to supported agent browsers.
const lifecycle = new AbortController();
if (document.modelContext?.registerTool) {
  const register = tool => document.modelContext.registerTool(tool, { signal: lifecycle.signal });
  try {
    await register({ name: 'harness_inventory', title: 'Inspect local models', description: 'Read vLLM models, residency, recent benchmarks and job status from this viewer.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, async execute() { if (!await refresh()) throw new Error('The workspace service is disconnected.'); return { runtime: state.runtime, benchmarks: state.benchmarks, jobs: state.jobs.map(({ id, type, model, status, message }) => ({ id, type, model, status, message })) }; } });
    await register({ name: 'harness_start_action', title: 'Control a local model', description: 'Start one local vLLM action. Deploy downloads a missing model. Benchmark runs three warm measurements. Returns a job ID; inspect inventory to see completion.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['deploy', 'download', 'unload', 'benchmark'] }, model: { type: 'string', description: 'Exact Hugging Face text model ID, including its owner.' } }, required: ['type', 'model'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, async execute(input) { if (!input || !['deploy', 'download', 'unload', 'benchmark'].includes(input.type) || typeof input.model !== 'string') throw new Error('Provide an allowed action and model.'); return runAction(input.type, input.model); } });
  } catch (error) { console.info('WebMCP tools unavailable:', error.message); }
}
window.addEventListener('pagehide', () => { lifecycle.abort(); events.close(); });
