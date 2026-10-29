import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buddyGuardCommand, buddyGuardSource } from './buddyGuard.js'

// The guard Claude Code runs before each of a Buddy's tool calls, run here as it runs there: the script, with node, the
// hook's input on stdin and its decision on stdout.
// The Buddy's folder, with a file, a folder, and a link out of it; and somewhere outside it.
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'buddy-guard-')))
const root = join(parent, 'folder'), outside = join(parent, 'outside')
mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(outside)
writeFileSync(join(root, 'a.txt'), 'a\n'); writeFileSync(join(outside, 'secret.txt'), 'secret\n')
symlinkSync(outside, join(root, 'out'))
const script = join(root, 'buddy-guard.mjs')
writeFileSync(script, buddyGuardSource(root))
afterAll(() => rmSync(parent, { recursive: true, force: true }))

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
  it.each([
    ['Read', { file_path: join(root, 'a.txt') }],
    ['Read', { file_path: 'a.txt' }],
    ['Read', { file_path: join(root, 'not-there-yet.txt') }],
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: join(root, 'src') }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { pattern: '*.md', path: 'src' }],
    ['LS', { path: root }],
  ])('lets %s read in its folder (%j)', (tool, input) => {
    expect(decide(tool, input)).toBe('allow')
  })

  // Reads stay in the Buddy's folder (security review 2 of #2092): the machine is its person's, the folder is the project.
  it.each([
    ['Read', { file_path: '/etc/passwd' }],
    ['Read', { file_path: join(outside, 'secret.txt') }],
    ['Read', { file_path: join(root, '..', 'outside', 'secret.txt') }],
    ['Read', { file_path: join(root, 'out', 'secret.txt') }],
    ['Read', {}],
    ['Grep', { pattern: 'x', path: '/' }],
    ['Grep', { pattern: 'x', path: join(root, 'out') }],
    ['Glob', { pattern: '/etc/*' }],
    ['Glob', { pattern: '../**/*' }],
    ['Glob', { pattern: '*', path: outside }],
    ['LS', { path: '/' }],
  ])('refuses %s outside its folder (%j)', (tool, input) => {
    expect(decide(tool, input)).toBe('deny')
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
    // Its Super Tab commands, as the pane it runs in identifies it (superTabs/command.ts callerOf).
    'harness super-tab --tab t status',
    'harness super-tab --tab t messages chat',
    'harness super-tab --tab t message chat m1',
    'harness super-tab --tab t decisions --answered',
    "harness super-tab --tab t post chat 'see /etc and ../up, as text' op-3 --reply-to m1",
    'harness super-tab --tab t post chat note op-4 --attach notes/plan.md',
    'harness super-tab help',
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
    'rg --hostname-bin /bin/echo --hyperlink-format default needle',
    'rg --hostname-bin=/bin/echo needle',
    // Its Super Tab commands only as itself, on this machine, and only a Buddy's (security review 2 of #2092).
    'harness super-tab --tab t --agent someone-else post chat hi op',
    'harness super-tab --tab t --agent me status',
    'harness super-tab --tab t --port 18474 status',
    'harness super-tab --tab t --machine other status',
    'harness super-tab --tab t command op {}',
    'harness super-tab --tab t start op {}',
    'harness super-tab --tab t resume start-1',
    'harness super-tab --tab t route group {}',
    'harness super-tab --tab t capacity m {}',
    'harness super-tab --tab t screen agent',
    'harness super-tab --tab t type agent hi',
    'harness super-tab --tab t plan',
    'harness super-tab --tab t remove-machine m --yes',
    'harness super-tab --tab t set-agents m 1',
    'harness super-tab --tab t post chat x op --attach /etc/passwd',
    'harness super-tab --tab t post chat x op --attach ../secret.txt',
    'harness super-tab --tab=t status',
    'harness show agent',
    'harness search needle',
    'harness ps',
    'harness wait agent',
    // Reads stay in its folder.
    'cat /etc/passwd',
    'cat ../outside/secret.txt',
    'cat out/../../outside/secret.txt',
    'ls /dev',
    'head -c 10 /dev/zero',
    'rg -n needle /',
    'grep -f /etc/passwd needle a.txt',
    'wc --files0-from=/etc/passwd',
    'git show HEAD:../x',
    'git diff --no-index a.txt ../outside/secret.txt',
    'git diff --no-index a.txt b.txt',
    'gh issue view 1 -R other/private',
    'gh issue view 1 --repo other/private',
    'gh pr view 1 --repo=other/private',
    'gh pr list -Rother/private',
    // Nothing that runs on.
    'tail -f a.txt',
    'tail -F a.txt',
    'tail -nf 5 a.txt',
    'tail --follow a.txt',
    'tail --follow=name a.txt',
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

  it('refuses a read command run in the background (security review 2 of #2092)', () => {
    expect(decide('Bash', { command: 'git log', run_in_background: true })).toBe('deny')
    expect(decide('Bash', { command: 'git log', run_in_background: false })).toBe('allow')
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
      { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(root, 'a.txt') } }), encoding: 'utf8' })
    expect([working.status, JSON.parse(working.stdout).hookSpecificOutput.permissionDecision]).toEqual([0, 'allow'])
  })
})
