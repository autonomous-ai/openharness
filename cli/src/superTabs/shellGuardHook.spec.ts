import { describe, expect, it } from 'vitest'
import { GUARD_REASONS, type GuardFacts } from './shellGuard.js'
import { hookAnswer } from './shellGuardHook.js'

const facts = (cwd: string): GuardFacts => ({
  cwd, platform: 'darwin', privateFolder: () => false, linkedWorktree: () => false, liveCwds: () => [],
})
const answer = (call: unknown) => hookAnswer(JSON.stringify(call), facts)
const deny = (reason: string) =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`

describe('shell guard hook', () => {
  it('denies a Claude Code Bash call by name with its reason', () => {
    expect(answer({ tool_name: 'Bash', tool_input: { command: 'pkill -f node' }, cwd: '/work' })).toBe(deny(GUARD_REASONS.killByName))
  })

  it('denies a file tool writing a fixed name in /tmp', () => {
    expect(answer({ tool_name: 'Write', tool_input: { file_path: '/tmp/notes.md', content: 'x' } })).toBe(deny(GUARD_REASONS.fixedTmp))
    expect(answer({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/private/tmp/n.ipynb' } })).toBe(deny(GUARD_REASONS.fixedTmp))
    expect(answer({ tool_name: 'Edit', tool_input: { file_path: '/work/src/a.ts' } })).toBe('')
  })

  it('reads a Codex shell call given as a line or as its argv', () => {
    expect(answer({ tool_name: 'Bash', tool_input: { command: 'sudo ls' } })).toBe(deny(GUARD_REASONS.systemWide))
    expect(answer({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'npm i -g tsx'] } })).toBe(deny(GUARD_REASONS.systemWide))
    expect(answer({ tool_name: 'exec_command', tool_input: { cmd: 'killall node' } })).toBe(deny(GUARD_REASONS.killByName))
  })

  it('answers nothing for ordinary work, for patches and for what it cannot read', () => {
    expect(answer({ tool_name: 'Bash', tool_input: { command: 'git status --short' }, cwd: '/work' })).toBe('')
    expect(answer({ tool_name: 'apply_patch', tool_input: { command: '*** Add File: /tmp/x' } })).toBe('')
    expect(answer({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })).toBe('')
    expect(answer({ tool_name: 'Bash' })).toBe('')
    expect(hookAnswer('not json', facts)).toBe('')
  })

  it('reads the command in the folder the call names', () => {
    const seen: string[] = []
    hookAnswer(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/work/tree' }), (cwd) => { seen.push(cwd); return facts(cwd) })
    expect(seen).toEqual(['/work/tree'])
  })

  it('uses a Codex command workdir when checking a relative worktree removal', () => {
    const tree = '/work/trees/live'
    const result = hookAnswer(JSON.stringify({ tool_name: 'exec_command', cwd: '/work/repo',
      tool_input: { cmd: 'git worktree remove .', workdir: tree } }), cwd => ({ ...facts(cwd),
      linkedWorktree: path => path === tree, liveCwds: () => [{ pid: 4242, cwd: tree }] }))
    expect(result).toBe(deny(GUARD_REASONS.liveWorktree(tree, 4242)))
  })
})
