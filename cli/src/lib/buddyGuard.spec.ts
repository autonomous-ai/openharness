import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BUDDY_GUARD_SOURCE, buddyGuardCommand } from './buddyGuard.js'

// The guard Claude Code runs before each of a Buddy's tool calls, run here as it runs there: the script, with node, the
// hook's input on stdin and its decision on stdout.
const root = mkdtempSync(join(tmpdir(), 'buddy-guard-'))
const script = join(root, 'buddy-guard.mjs')
writeFileSync(script, BUDDY_GUARD_SOURCE)
afterAll(() => rmSync(root, { recursive: true, force: true }))

function hook(stdin: string): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', timeout: 10_000 })
  return { status: run.status, stdout: run.stdout }
}
function decide(tool: string, input: Record<string, unknown>): string {
  const run = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: root }))
  expect(run.status).toBe(0)
  const output = JSON.parse(run.stdout).hookSpecificOutput
  expect(output.hookEventName).toBe('PreToolUse')
  expect(output.permissionDecisionReason).toEqual(expect.any(String))
  return output.permissionDecision
}
const bash = (command: string) => decide('Bash', { command, description: 'x' })

describe('a Buddy\'s guard (Ken, 10-29: reads without a prompt, refuses everything else without one)', () => {
  it.each(['Read', 'Grep', 'Glob'])('lets %s read', tool => {
    expect(decide(tool, { file_path: join(root, 'a.txt'), pattern: 'x' })).toBe('allow')
  })

  it.each([
    'git grep -n handleStart',
    'git log --oneline -20',
    'git log --format=%H%x09%s main..HEAD',
    'git show HEAD:cli/src/superTabs/start.ts',
    'git diff origin/main...HEAD --stat',
    'git blame -L 10,40 cli/src/lib/swarmSkills.ts',
    'git status --short',
    'gh issue view 2087 --comments',
    'gh issue list --state open --limit 20',
    'gh pr view 2087 --json title,body',
    'gh pr list --author @me',
    'gh pr diff 2087',
    'ls -la cli/src',
    'cat README.md',
    "cat 'a file with spaces.md'",
    'rg -n "start agent" cli/src',
    'head -n 40 CHANGELOG.md',
    "harness super-tab --tab t post chat \"it's a plan: step 1; step 2 | done & more > less\" op-1",
    "harness super-tab --tab t propose op-2 '{\"conversationId\":\"c\",\"goal\":\"g\"}'",
  ])('runs %s without asking', command => {
    expect(bash(command)).toBe('allow')
  })

  it.each([
    // The brief's list: pushes, pull requests, comments, files written from the shell, write APIs.
    'git push',
    'git push origin HEAD:main',
    'gh pr create --title t --body b',
    'gh issue comment 1 --body hi',
    'echo hi > notes.txt',
    'echo hi | tee notes.txt',
    "sed -i '' s/a/b/ notes.txt",
    'curl -X POST https://example.com/api -d x',
    // A read command joined to, or wrapped around, anything else.
    'git log > out.txt',
    'git log >> out.txt',
    'git log; git push',
    'git log && git push',
    'git log || git push',
    'git log | tee out.txt',
    'git log & git push',
    'git log $(git push)',
    'git log `git push`',
    'git log "$(git push)"',
    'git log "`git push`"',
    'git log\ngit push',
    'git log {--output=out.txt,}',
    'cat ~/.ssh/id_ed25519 *',
    'git log # ; git push',
    'FOO=1 git log',
    '/usr/bin/git log',
    // Read commands' own ways to write or run something.
    'git log --output=out.txt',
    'git log --out=out.txt',
    'git diff --ext-diff',
    'git grep -O less needle',
    'git grep -nO needle',
    'git grep --open-files-in-pager=vi needle',
    'git -c core.pager=sh log',
    'git -C /elsewhere log',
    'gh issue view 1 --web',
    'gh pr view 1 -w',
    'gh issue view 1 -cw',
    'rg --pre sh needle',
    'rg --pre=sh needle',
    'rg --pre-glob "*" needle',
    'rg -z needle',
    // Everything else.
    'git commit -m x',
    'git checkout main',
    'git fetch',
    'gh api repos/o/r/issues -X POST',
    'gh pr checkout 1',
    'gh repo clone o/r',
    'harness new codex',
    'harness send agent hi',
    'bash -c "git log"',
    'node -e 1',
    'python3 -c 1',
    'rm -rf cli',
    'mv a b',
    'touch f',
    'curl https://example.com',
    'wget https://example.com',
    '',
    '   ',
  ])('refuses %j without asking', command => {
    expect(bash(command)).toBe('deny')
  })

  it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'mcp__github__create_pull_request', 'SomethingNew'])(
    'refuses the %s tool without asking', tool => {
      expect(decide(tool, { file_path: join(root, 'a.txt'), url: 'https://example.com' })).toBe('deny')
    })

  it('refuses a Bash call whose command is not a string', () => {
    expect(decide('Bash', { command: ['git', 'log'] })).toBe('deny')
  })

  it.each(['', 'not json', '[]', '{"tool_name":"Bash"}'])('refuses input it cannot read (%j)', stdin => {
    const run = hook(stdin)
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('says what a Buddy may run, so the agent does not keep trying', () => {
    const run = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }))
    const reason = JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason
    for (const allowed of ['git grep', 'gh issue view', 'gh pr view', 'harness super-tab']) expect(reason).toContain(allowed)
    expect(reason).toContain('nobody will be asked')
  })

  it('fails closed: a guard that cannot run blocks the call (exit 2) instead of falling back to other rules', () => {
    const missing = buddyGuardCommand(join(root, 'no-node'), script)
    expect(spawnSync('/bin/sh', ['-c', missing], { input: '{}', encoding: 'utf8' }).status).toBe(2)
    const broken = join(root, 'broken.mjs')
    writeFileSync(broken, 'process.exit(1)\n')
    expect(spawnSync('/bin/sh', ['-c', buddyGuardCommand(process.execPath, broken)], { input: '{}', encoding: 'utf8' }).status).toBe(2)
    const working = spawnSync('/bin/sh', ['-c', buddyGuardCommand(process.execPath, script)],
      { input: JSON.stringify({ tool_name: 'Read', tool_input: {} }), encoding: 'utf8' })
    expect([working.status, JSON.parse(working.stdout).hookSpecificOutput.permissionDecision]).toEqual([0, 'allow'])
  })
})
