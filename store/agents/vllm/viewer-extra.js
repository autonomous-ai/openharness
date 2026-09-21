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
