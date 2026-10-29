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
// Links out of it, as a pull could bring them after launch: to a folder, to a file, and to nothing.
symlinkSync(outside, join(root, 'out'))
symlinkSync(join(outside, 'secret.txt'), join(root, 'outlink'))
symlinkSync(join(parent, 'gone'), join(root, 'broken'))
symlinkSync(join(root, 'a.txt'), join(root, 'inlink'))
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
    'grep -rn needle src',
    "grep -rn --include='*.ts' --exclude-dir=node_modules --ignore-case --line-number needle src",
    'grep --count --files-with-matches --fixed-strings needle a.txt',
    'cat inlink',
    'git blame -L1,5 a.txt',
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
    "rg --line-number --ignore-case --glob '*.ts' --type ts --context 2 --hidden needle src",
    'rg --files-with-matches --fixed-strings --max-count=3 needle',
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
    // A path glued to a short option is a path too (review 3 of #2092).
    'git blame -S/etc/passwd a.txt',
    'git blame -S../outside/secret.txt a.txt',
    'git grep -f/etc/passwd',
    'git grep -fout/secret.txt',
    'rg -f/etc/passwd needle',
    'rg -f../outside/secret.txt needle',
    'grep -f/etc/passwd needle a.txt',
    'grep -fout/secret.txt needle a.txt',
    'head -n1 -c5 -- -/etc/passwd',
    // A link out of the folder, by its real path when the command runs, a link a pull brought after launch included.
    'cat outlink',
    'cat out/secret.txt',
    'head -n 1 outlink',
    'grep needle outlink',
    'grep -r needle out',
    'rg needle out',
    'git blame outlink',
    'cat broken',
    'harness super-tab --tab t post chat x op --attach outlink',
    'harness super-tab --tab t post chat x op --attach out/secret.txt',
    // Nor following links while it walks the folder.
    'grep -R needle .',
    'grep -rS needle .',
    'grep -O -r needle .',
    'grep --dereference-recursive needle .',
    // A Buddy's grep is Claude Code's built-in ugrep, whose long options go further (security re-check of #2092): only a
    // fixed set of grep's own is allowed, by its whole name.
    'grep -r --dereference-files needle .',
    'grep -r --dereference needle .',
    'grep --filter=sh:x needle a.txt',
    'grep --config=x needle a.txt',
    'grep ---x needle a.txt',
    'grep --save-config needle',
    'grep --pager=less needle a.txt',
    'grep --view=vi -Q needle a.txt',
    'grep -Q needle a.txt',
    'grep --index needle .',
    'grep --line-num needle a.txt',
    'rg -L needle',
    'rg --follow needle',
    // rg's long options by allowlist, as grep's, so a newer bundled rg cannot add one unnoticed (re-check of #2092).
    'rg --some-new-option needle',
    'rg --hidd needle',
    'rg --no-config --follow needle',
    'rg --files --follow',
    'ls -L out',
    'ls -lL .',
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
