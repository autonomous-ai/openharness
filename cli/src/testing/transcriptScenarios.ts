/**
 * Realistic Claude Code and Codex transcripts, record by record, in the shapes the engines write — the
 * fixtures attach (lib/attachTranscript.spec.ts) and paging (lib/transcriptPages.spec.ts) are checked
 * against at every cut point.
 */
// ── Codex records, in the shapes a 0.159 rollout writes ──────────────────────────────────────────────
export const cx = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: '2026-10-03T23:21:44.458Z', type, payload })
export const codex = {
  meta: (version = '0.159.0') => cx('session_meta', { id: 'thread-1', cli_version: version, cwd: '/tmp/work' }),
  context: (model: string, effort: string | null, mode: string | null) => cx('turn_context', {
    turn_id: 't', model, ...(effort ? { reasoning_effort: effort } : {}), ...(mode ? { collaboration_mode: { mode } } : {}),
  }),
  settings: (model: string, effort: string, mode: string) => cx('event_msg', {
    type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort, collaboration_mode: { mode } },
  }),
  started: (turn: string) => cx('event_msg', { type: 'task_started', turn_id: turn }),
  user: (text: string) => cx('event_msg', { type: 'user_message', message: text }),
  userItem: (text: string) => cx('event_msg', {
    type: 'item_completed', turn_id: 't', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text, text_elements: [] }] },
  }),
  goal: (objective: string) => cx('response_item', {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `<codex_internal_context source="goal">\n<objective>${objective}</objective>\n</codex_internal_context>` }],
  }),
  developer: (text: string) => cx('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }),
  agent: (text: string, phase = 'final_answer') => cx('event_msg', {
    type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }], phase },
  }),
  reasoning: (text: string) => cx('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text }] }),
  call: (id: string, cmd: string) => cx('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd }) }),
  output: (id: string, output: string) => cx('response_item', { type: 'function_call_output', call_id: id, output }),
  complete: (turn: string) => cx('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'done' }),
  aborted: (turn: string) => cx('event_msg', { type: 'turn_aborted', turn_id: turn }),
  compacted: (bytes: number) => cx('compacted', { message: '📘é'.repeat(bytes / 6), replacement_history: [] }),
  contextCompacted: () => cx('event_msg', { type: 'context_compacted' }),
  tokens: () => cx('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } }),
}

/** A rollout with every shape attach has to get right, in the order Codex writes them. */
export const codexScenario = (): string[] => [
  codex.meta(),
  codex.developer('<permissions instructions>'),
  codex.settings('gpt-5.5', 'high', 'default'),
  codex.started('t1'), codex.context('gpt-5.5', 'high', 'default'), codex.user('first question'),
  codex.reasoning('Planning'), codex.call('c1', 'ls'), codex.output('c1', 'a\nb'), codex.agent('one answer'), codex.complete('t1'),
  codex.started('t2'), codex.context('gpt-6', 'xhigh', 'plan'), codex.userItem('second, in the item shape'),
  codex.reasoning('Thinking 漢字 📘'), codex.agent('looking', 'commentary'),
  codex.compacted(150_000), codex.contextCompacted(), codex.tokens(),
  codex.call('c2', 'npm test'), codex.output('c2', 'ok'), codex.agent('second answer'), codex.complete('t2'),
  codex.settings('gpt-6', 'low', 'default'),
  codex.started('t3'), codex.context('gpt-6', null, 'default'), codex.user('third: effort left out'),
  codex.call('c3', 'sleep 1'),
  codex.user(''), // an empty message opens nothing
  codex.output('c3', 'slept'), codex.complete('t3'),
  codex.started('t4'), codex.context('gpt-6', 'medium', 'default'), codex.user('interrupted one'), codex.aborted('t4'),
  codex.started('t5'), codex.context('gpt-6', 'medium', 'default'), codex.goal('ship the release'), codex.reasoning('goal work'), codex.complete('t5'),
  codex.started('t6'), codex.context('gpt-6', 'medium', 'default'), codex.goal('ship the release'), codex.agent('continuing'), codex.complete('t6'),
  codex.started('t7'), codex.context('gpt-6', 'medium', 'default'), codex.user('a question mid-goal'), codex.complete('t7'),
  codex.started('t8'), codex.context('gpt-6', 'medium', 'default'), codex.goal('ship the release'), codex.reasoning('still the goal'),
  codex.call('c8', 'make'), codex.complete('t8'),
  codex.started('t9'), codex.context('gpt-6', 'max', 'plan'), codex.goal('a different goal'), codex.reasoning('new goal'),
  codex.complete('t9'),
  // A message sent mid-task, with a call still in flight: its output arrives after the new message.
  codex.started('t10'), codex.context('gpt-6', 'max', 'default'), codex.user('start the build'),
  codex.call('c10', 'make all'), codex.user('also run the tests while that builds'),
  codex.output('c10', 'built'), codex.reasoning('now the tests'), codex.call('c11', 'npm test'),
]

// ── Claude Code records ───────────────────────────────────────────────────────────────────────────────
let uuid = 0
export const cl = (record: Record<string, unknown>): string => JSON.stringify({
  parentUuid: null, isSidechain: false, userType: 'external', cwd: '/tmp', sessionId: 's', version: '2.1.212',
  timestamp: '2026-10-03T23:21:44.458Z', uuid: `u${++uuid}`, ...record,
})
export const claude = {
  user: (content: unknown, extra: Record<string, unknown> = {}) => cl({ type: 'user', message: { role: 'user', content }, ...extra }),
  assistant: (content: unknown[], stop: string | null, model = 'claude-opus-5-5') =>
    cl({ type: 'assistant', message: { id: `m${uuid}`, role: 'assistant', model, content, stop_reason: stop } }),
  text: (text: string) => ({ type: 'text', text }),
  thinking: (thinking: string) => ({ type: 'thinking', thinking }),
  tool: (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } }),
  result: (id: string, content: string) => cl({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }),
  compact: () => cl({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }),
  summary: () => cl({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary of the earlier conversation' } }),
}

export const claudeScenario = (): string[] => [
  JSON.stringify({ type: 'summary', summary: 'Earlier work', leafUuid: 'x' }),
  claude.user('first prompt'),
  claude.assistant([claude.thinking('let me think'), claude.text('First answer.')], 'end_turn'),
  claude.user('second prompt with a tool'),
  claude.assistant([claude.text('Checking.'), claude.tool('toolu_1', 'ls')], 'tool_use'),
  claude.result('toolu_1', 'files'),
  claude.assistant([claude.thinking('found them 漢字'), claude.text('Done: '.repeat(20_000))], 'end_turn', 'claude-fable-5-1'),
  claude.user('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>'),
  claude.user('<bash-input>git status</bash-input><bash-stdout>clean</bash-stdout>'),
  claude.user('third prompt, interrupted'),
  claude.assistant([claude.tool('toolu_2', 'sleep 100')], 'tool_use'),
  claude.user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  claude.user('<task-notification><task-id>a</task-id><tool-use-id>toolu_9</tool-use-id><status>completed</status><summary>bg done</summary></task-notification>'),
  claude.compact(), claude.summary(),
  claude.user('loop iteration', { isMeta: true, promptSource: 'system' }),
  claude.assistant([claude.text('Loop ran.')], 'end_turn', '<synthetic>'),
  claude.user('a bookkeeping line', { isMeta: true }),
  claude.user('fourth prompt'),
  claude.assistant([claude.text('Working on it'), claude.tool('toolu_3', 'make')], 'tool_use'),
  claude.result('toolu_3', 'built'),
  claude.assistant([claude.thinking('almost'), claude.text('Built it.')], 'end_turn'),
  claude.user('fifth prompt, left running'),
  claude.assistant([claude.tool('toolu_4', 'npm test')], 'tool_use'),
  // A prompt that lands while a call is in flight: the result arrives after it, naming its call.
  claude.user('sixth prompt, typed during the tests'),
  claude.result('toolu_4', 'tests passed'),
  claude.assistant([claude.thinking('reading results'), claude.text('All green.')], 'end_turn'),
]
