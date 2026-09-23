import { describe, expect, it } from 'vitest'
import { emptyOutputLedger, ingestOutput, outputSnapshot, validOutputLedger } from './agentOutputStats.js'

const call = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const reply = (id: string, content: string, receipt?: unknown, failed = false) => ({ type: 'user', toolUseResult: receipt,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }] } })
const codex = (payload: Record<string, unknown>) => ({ type: 'response_item', payload })
const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n+added\n*** End Patch'
const url = 'https://github.com/team/project/pull/42'

describe('cached output receipts', () => {
  it('counts confirmed Claude edits once, including multi-match patches', () => {
    const state = emptyOutputLedger()
    for (let i = 0; i < 3; i++) {
      ingestOutput(state, call('edit', 'Edit', {}), 'claude')
      ingestOutput(state, reply('edit', 'Updated', { structuredPatch: [{ lines: [' context', '-old', '+new'] }, { lines: ['-old', '+new', '+added'] }] }), 'claude')
    }
    expect(outputSnapshot(state)).toEqual({ linesAdded: 3, linesRemoved: 2, pullRequestsCreated: null })
    expect(validOutputLedger(JSON.parse(JSON.stringify(state)))).toBe(true)
    expect(JSON.stringify(state)).not.toContain('context')
  })

  it('never counts failed, unfinished, read-only or unreported edits', () => {
    const state = emptyOutputLedger()
    for (const [id, name, fail] of [['failed', 'Edit', true], ['read', 'Read', false]] as const) {
      ingestOutput(state, call(id, name, {}), 'claude')
      ingestOutput(state, reply(id, 'Error', { structuredPatch: [{ lines: ['+x'] }] }, fail), 'claude')
    }
    ingestOutput(state, call('pending', 'Write', {}), 'claude')
    ingestOutput(state, call('unknown', 'Edit', {}), 'claude')
    ingestOutput(state, reply('unknown', 'Updated'), 'claude')
    expect(outputSnapshot(state)).toBeNull()
  })

  it('counts new-file lines without a phantom trailing line', () => {
    const state = emptyOutputLedger()
    ingestOutput(state, call('new', 'Write', {}), 'claude')
    ingestOutput(state, reply('new', 'Created', { type: 'create', content: 'a\nb\n' }), 'claude')
    ingestOutput(state, call('overwrite', 'Write', {}), 'claude')
    ingestOutput(state, reply('overwrite', 'Updated', { type: 'update', content: 'c\n' }), 'claude')
    expect(outputSnapshot(state)?.linesAdded).toBe(2)
  })

  it('credits only PR creation receipts, not mentions, reads, errors or duplicates', () => {
    const state = emptyOutputLedger()
    for (const [id, command, output, failed] of [
      ['one', 'gh pr create --title "hi" --body-file /tmp/body', url, false],
      ['two', 'cd project && gh pr create --body-file /tmp/body', url, false],
      ['view', 'gh pr view --json url', url, false],
      ['echo', 'echo "gh pr create"', url, false],
      ['masked', 'gh pr create || true', 'https://github.com/team/project/pull/45', false],
      ['later', 'gh pr create; gh pr view', 'https://github.com/team/project/pull/46', false],
      ['comment', '# gh pr create\necho hello', url, false],
      ['heredoc', "cat <<'EOF'\ngh pr create\nEOF", url, false],
      ['failed', 'gh pr create', 'https://github.com/team/project/pull/43', true],
      ['mentioned', 'gh pr create', 'Already exists: https://github.com/team/project/pull/44', true],
    ] as const) {
      ingestOutput(state, call(id, 'Bash', { command }), 'claude')
      ingestOutput(state, reply(id, output, undefined, failed), 'claude')
    }
    expect(outputSnapshot(state)).toEqual({ linesAdded: null, linesRemoved: null, pullRequestsCreated: 1 })
    expect(JSON.stringify(state)).not.toContain('team/project')
  })

  it('counts Codex patches only after success and preserves pending work across reloads', () => {
    let state = emptyOutputLedger()
    ingestOutput(state, codex({ type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: patch }), 'codex')
    state = JSON.parse(JSON.stringify(state))
    const result = codex({ type: 'custom_tool_call_output', call_id: 'patch', output: 'Success. Updated the following files:\nM a.ts' })
    ingestOutput(state, result, 'codex')
    ingestOutput(state, result, 'codex')
    ingestOutput(state, codex({ type: 'custom_tool_call', call_id: 'bad', name: 'apply_patch', input: patch }), 'codex')
    ingestOutput(state, codex({ type: 'custom_tool_call_output', call_id: 'bad', output: 'Failed', is_error: true }), 'codex')
    expect(outputSnapshot(state)).toEqual({ linesAdded: 2, linesRemoved: 1, pullRequestsCreated: null })
  })

  it('supports literal code-mode calls and structured receipts without executing JavaScript', () => {
    const state = emptyOutputLedger()
    ingestOutput(state, codex({ type: 'custom_tool_call', call_id: 'patch', name: 'exec', input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` }), 'codex')
    ingestOutput(state, codex({ type: 'custom_tool_call_output', call_id: 'patch', output: 'Success. Updated the following files:\nM a.ts' }), 'codex')
    ingestOutput(state, codex({ type: 'custom_tool_call', call_id: 'pr', name: 'exec', input: 'text(await tools.exec_command({cmd:"gh pr create --body-file /tmp/body"}));' }), 'codex')
    ingestOutput(state, codex({ type: 'custom_tool_call_output', call_id: 'pr', output: `Script completed\nWall time 1s\nOutput:\n${JSON.stringify({ output: url, exit_code: 0 })}` }), 'codex')
    expect(outputSnapshot(state)).toEqual({ linesAdded: 2, linesRemoved: 1, pullRequestsCreated: 1 })
  })

  it('rejects process failures, dynamic/compound scripts and incomplete deletion patches', () => {
    const state = emptyOutputLedger()
    for (const [id, name, input, output] of [
      ['bad', 'exec_command', JSON.stringify({ cmd: 'gh pr create' }), JSON.stringify({ exit_code: 1, output: url })],
      ['bad2', 'exec_command', JSON.stringify({ cmd: 'gh pr create' }), `Process exited with code 1\n${url}`],
      ['unfinished', 'exec_command', JSON.stringify({ cmd: 'gh pr create' }), JSON.stringify({ exit_code: null, session_id: 12, output: url })],
      ['dynamic', 'exec', 'text(await tools.exec_command({cmd: command}));', url],
      ['compound', 'exec', 'await tools.exec_command({cmd:"gh pr create"}); await tools.exec_command({cmd:"gh pr view"});', url],
      ['delete', 'apply_patch', '*** Begin Patch\n*** Delete File: a\n*** End Patch', 'Success. Updated the following files:\nD a'],
    ]) {
      ingestOutput(state, codex({ type: 'function_call', call_id: id, name, arguments: input }), 'codex')
      ingestOutput(state, codex({ type: 'function_call_output', call_id: id, output }), 'codex')
    }
    expect(outputSnapshot(state)).toBeNull()
  })

  it('keeps unknown distinct from measured zero and rejects corrupt checkpoints', () => {
    const state = emptyOutputLedger()
    expect(outputSnapshot(state)).toBeNull()
    expect(validOutputLedger(state)).toBe(true)
    expect(validOutputLedger({ ...state, added: -1 })).toBe(false)
    expect(validOutputLedger({ ...state, completedCount: 500 })).toBe(false)
    expect(validOutputLedger({ ...state, pending: { raw: { kind: 'edit' } } })).toBe(false)
  })
})
