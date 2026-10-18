// The transcript scorer (score.mts). Run: npx tsx --test scripts/agent-eval/score.test.mts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { callsFromClaude, callsFromCodex, evalEnv, harnessVerb, score, type Case } from './score.mts'

const claude = (calls: Array<[string, string, boolean]>, answer: string): string[] => [
  ...calls.flatMap(([command, output, isError], i) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: output, is_error: isError }] } }),
  ]),
  JSON.stringify({ type: 'result', result: answer }),
]

test('finds the harness verb in a command, also by full path and inside bash -lc', () => {
  assert.equal(harnessVerb('harness ps'), 'ps')
  assert.equal(harnessVerb('~/.local/bin/harness wait reviewer --timeout 20m'), 'wait')
  assert.equal(harnessVerb("bash -lc 'harness new codex --name r -- go'"), 'new')
  assert.equal(harnessVerb('harness --help'), '--help')
  assert.equal(harnessVerb('ls harnesses/'), null)
})

test('reads Claude Code stream-json: commands, exit codes and the final answer', () => {
  const { calls, answer } = callsFromClaude(claude([['harness ps', 'rows', false], ['harness show x', 'Exit code 1\nNo harness named "x"', true]], 'done'))
  assert.deepEqual(calls.map((c) => [c.command, c.exit]), [['harness ps', 0], ['harness show x', 1]])
  assert.equal(answer, 'done')
})

test('reads Codex exec --json: command executions and the last agent message', () => {
  const { calls, answer } = callsFromCodex([
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: "bash -lc 'harness ps'", exit_code: 0, aggregated_output: 'rows' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex found two bugs.' } }),
  ])
  assert.deepEqual(calls.map((c) => [c.command, c.exit]), [["bash -lc 'harness ps'", 0]])
  assert.equal(answer, 'Codex found two bugs.')
})

const review: Case = { id: 'second-opinion', prompt: 'p', setup: 's', expect: { run: ['new', 'show'], answer: 'bug' } }

test('a clean run: one look, start, wait, read, close', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness ps', 'rows', false], ['harness new codex --name r -- review', 'Created r', false],
    ['harness wait r', 'r: idle', false], ['harness show r', 'answer', false], ['harness close r', 'Closed r.', false],
  ], 'One bug in ledger.ts'))
  assert.deepEqual(score(review, 'claude', calls, answer), {
    id: 'second-opinion', agent: 'claude', calls: 5, firstAction: 1, orientation: 1, wrong: 0, retriesAfterRefusal: 0,
    leftOpen: 0, ranExpected: true, ranForbidden: [], answerOk: true, done: true,
  })
})

test('counts wrong options, retries after a refusal, and harnesses left open', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness --help', 'Usage', false], ['harness version', '0.4.4', false],
    ['harness wait r --timout 5m', 'Exit code 2\nUnknown option --timout.', true],
    ['harness new codex --name r -- go', 'Exit code 1\nAgents may not start harnesses: the person turns on …', true],
    ['harness new claude --name r -- go', 'Exit code 1\nAgents may not start harnesses: the person turns on …', true],
  ], 'I could not'))
  const s = score({ ...review, expect: { notRun: ['new'], answer: 'person|turn on' } }, 'claude', calls, answer)
  assert.equal(s.orientation, 2)
  assert.equal(s.wrong, 1)
  assert.equal(s.retriesAfterRefusal, 1)
  assert.equal(s.answerOk, false)
  assert.equal(s.done, false)
})

test('starting again after closing one, as the refusal says, is not a retry', () => {
  const { calls, answer } = callsFromClaude(claude([
    ...[1, 2, 3, 4].map((i): [string, string, boolean] => [`harness new codex --name r${i} -- go`, 'Created', false]),
    ['harness new codex --name r5 -- go', 'Exit code 1\nYou have 4 harnesses running. Close one you are done with first (harness close <name>).', true],
    ['harness close r1', 'Closed r1.', false],
    ['harness new codex --name r5 -- go', 'Created', false],
    ...[2, 3, 4, 5].map((i): [string, string, boolean] => [`harness close r${i}`, 'Closed', false]),
  ], 'all five'))
  const s = score({ id: 'five-at-once', prompt: 'p', setup: 's', expect: { run: ['new', 'close'] } }, 'claude', calls, answer)
  assert.equal(s.retriesAfterRefusal, 0)
  assert.equal(s.leftOpen, 0)
  assert.equal(s.done, true)
})

test('sees every harness command joined with &&', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness new codex --name r -- go && harness wait r && harness show r', 'answer', false],
    ['harness close r', 'Closed r.', false],
  ], 'One bug in ledger.ts'))
  const s = score({ id: 'x', prompt: 'p', setup: 's', expect: { run: ['new', 'wait', 'show'] } }, 'claude', calls, answer)
  assert.equal(s.ranExpected, true)
  assert.equal(s.calls, 4)
  assert.equal(s.leftOpen, 0)
})

test('the cases accept an ordinary right answer', () => {
  const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')) as Case[]
  const answer = cases.find((c) => c.id === 'second-opinion')!.expect.answer!
  assert.match('childrenOf() drops rows after the ledger file rotates, so limits undercount.', new RegExp(answer, 'i'))
})

test('the eval agent does not inherit the operator\'s session', () => {
  const env = evalEnv({ PATH: '/bin', HOME: '/h', TMUX_PANE: '%3', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't', AI_AGENT: 'x', HARNESS_AGENT_SESSION: 'y' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' })
})
