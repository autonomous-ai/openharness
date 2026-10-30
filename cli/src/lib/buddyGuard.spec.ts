import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  truncateSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { allowBuddyReads, artifactLinks, buddyGuardCommand, buddyGuardSource, buddyReadsOf, forgetBuddyReads, grantBuddyWide, recordBuddyApprovals } from './buddyGuard.js'

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
// Where Harness downloads chat files (lib/pasteDropFiles.ts), and the list of those its person attached in its own Buddy
// chat, which the host keeps for this Buddy alone (superTabs/host.ts).
const drops = join(parent, 'paste-drops')
const reads = { file: join(parent, 'buddy-reads', 'session.json'), drops }
mkdirSync(drops); mkdirSync(dirname(reads.file))
const script = join(root, 'buddy-guard.mjs')
writeFileSync(script, buddyGuardSource(root, reads))
afterAll(() => rmSync(parent, { recursive: true, force: true }))

function hook(stdin: string, guard = script): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [guard], { input: stdin, encoding: 'utf8', timeout: 10_000 })
  return { status: run.status, stdout: run.stdout }
}
function decide(tool: string, input: Record<string, unknown>, guard = script): string {
  const run = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: root }), guard)
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
    // And how to open what its person sent it, when it tried the shell or another path (Tony, 10-30).
    expect(reason).toContain('A file your person sent you in your chat opens with Read, by the path you were given')
    expect(reason).toContain('an Artifact link they sent, with the Artifact tool\'s read and that link')
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

// Tony, 10-30: his Buddy could not open the screenshot he sent it, nor an Artifact he linked, in their Buddy chat. Its
// person's own files and links there, as the host lists them for this Buddy, and nothing else.
describe('what its person sent in its own Buddy chat', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const shot = join(drops, '1a2b3c4d-screen.png'), otherChat = join(drops, '5e6f7a8b-screen.png')
  const LINK = 'https://claude.ai/artifact/abc-123', CODE_LINK = 'https://claude.ai/code/artifact/0b7e8f2c-1d2e-4f3a-9b8c-7d6e5f4a3b2c'
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    return { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
  }
  /** The list as the host writes it (allowBuddyReads), written here by hand. */
  const list = (files: unknown[], links: unknown[] = []) => writeFileSync(reads.file, JSON.stringify({ version: 1, files, links }))
  const now = () => Date.now()
  beforeEach(() => {
    for (const path of [shot, otherChat]) { rmSync(path, { force: true }); writeFileSync(path, PNG) }
    list([{ ...identity(shot), at: now() }], [{ url: LINK, at: now() }, { url: CODE_LINK, at: now() }])
  })

  it('lets Read open a picture its person sent, by the path it was handed', () => {
    expect(decide('Read', { file_path: shot })).toBe('allow')
    expect(decide('Read', { file_path: shot, offset: 1, limit: 10 })).toBe('allow')
  })

  it.each([
    ['another chat\'s file in the same folder', () => otherChat],
    ['the folder itself', () => drops],
    ['the path with a ".." in it', () => `${drops}/../paste-drops/1a2b3c4d-screen.png`],
    ['the path with a doubled slash', () => `${drops}//1a2b3c4d-screen.png`],
    ['the path relative to its folder', () => join('..', 'paste-drops', '1a2b3c4d-screen.png')],
    ['a link to it', () => { const link = join(drops, 'link.png'); rmSync(link, { force: true }); symlinkSync(shot, link); return link }],
  ])('refuses Read of %s', (_, path) => {
    expect(decide('Read', { file_path: path() })).toBe('deny')
  })

  it('refuses a listed path that is a link, whatever it points to', () => {
    const link = join(drops, '9c9c9c9c-link.png')
    rmSync(link, { force: true }); symlinkSync(otherChat, link)
    list([{ ...identity(link), at: now() }])
    expect(decide('Read', { file_path: link })).toBe('deny')
    list([{ ...identity(otherChat), path: link, at: now() }])
    expect(decide('Read', { file_path: link })).toBe('deny')
  })

  it('refuses it while it has a second name (a hard link), and lets it again once that is gone', () => {
    const second = join(parent, 'second-name.png')
    linkSync(shot, second)
    expect(decide('Read', { file_path: shot })).toBe('deny')
    expect(decide('Read', { file_path: second })).toBe('deny')
    rmSync(second)
    expect(decide('Read', { file_path: shot })).toBe('allow')
  })

  it('refuses another file put in its place, or the same file grown since', () => {
    rmSync(shot); writeFileSync(join(drops, 'filler'), PNG); writeFileSync(shot, PNG)
    rmSync(join(drops, 'filler'))
    expect(decide('Read', { file_path: shot })).toBe('deny')
    list([{ ...identity(shot), at: now() }])
    expect(decide('Read', { file_path: shot })).toBe('allow')
    appendFileSync(shot, 'more')
    expect(decide('Read', { file_path: shot })).toBe('deny')
  })

  // Security reviews 1 and 2 of #2248: written over in place, a file keeps its device, inode and size, and Read opened bytes
  // its person never sent. Its SHA-256, taken when it was listed, is what tells.
  describe('bytes its person never sent, in the same file at the same length', () => {
    const note = join(drops, 'c0ffee00-note.txt')
    beforeEach(() => {
      rmSync(note, { force: true }); writeFileSync(note, 'OWNER')
      list([{ ...identity(note), at: now() }])
      expect(decide('Read', { file_path: note })).toBe('allow')
    })
    const same = (before: Stats) => {
      const after = lstatSync(note)
      expect([after.dev, after.ino, after.size, after.nlink]).toEqual([before.dev, before.ino, before.size, 1])
    }

    it('refuses it once written over with other bytes of the same length, and lets it again once they are its own', () => {
      const before = lstatSync(note)
      writeFileSync(note, 'OTHER', { flag: 'r+' })
      same(before)
      expect(readFileSync(note, 'utf8')).toBe('OTHER')
      expect(decide('Read', { file_path: note })).toBe('deny')
      writeFileSync(note, 'OWNER', { flag: 'r+' })
      expect(decide('Read', { file_path: note })).toBe('allow')
    })

    it('refuses it once grown and cut back to its length with other bytes', () => {
      const before = lstatSync(note)
      writeFileSync(note, 'OTHER, and more besides', { flag: 'r+' })
      expect(decide('Read', { file_path: note })).toBe('deny')
      truncateSync(note, 5)
      same(before)
      expect(readFileSync(note, 'utf8')).toBe('OTHER')
      expect(decide('Read', { file_path: note })).toBe('deny')
    })
  })

  it('refuses a listed file outside Harness\'s downloads folder', () => {
    list([{ ...identity(join(outside, 'secret.txt')), at: now() }, { ...identity(join(root, 'a.txt')), path: join(outside, 'secret.txt'), at: now() }])
    expect(decide('Read', { file_path: join(outside, 'secret.txt') })).toBe('deny')
  })

  it('keeps a file a day, as Harness keeps the download', () => {
    list([{ ...identity(shot), at: now() - 24 * 60 * 60 * 1000 }])
    expect(decide('Read', { file_path: shot })).toBe('deny')
    list([{ ...identity(shot), at: now() - 23 * 60 * 60 * 1000 }])
    expect(decide('Read', { file_path: shot })).toBe('allow')
  })

  it.each([
    ['missing', () => rmSync(reads.file)],
    ['not JSON', () => writeFileSync(reads.file, '{"files": [')],
    ['a list', () => writeFileSync(reads.file, '[]')],
    ['files that are not a list', () => writeFileSync(reads.file, JSON.stringify({ files: { 0: identity(shot) } }))],
    ['entries that are not files', () => list([null, 1, shot, [shot]])],
    ['an entry without its time', () => list([identity(shot)])],
    ['an entry with its identity as numbers', () => list([{ ...identity(shot), dev: Number(identity(shot).dev), ino: Number(identity(shot).ino), size: PNG.length, at: now() }])],
    ['an entry without its SHA-256', () => list([{ ...identity(shot), sha256: undefined, at: now() }])],
    ['an entry with another file\'s SHA-256', () => list([{ ...identity(shot), sha256: createHash('sha256').update('other').digest('hex'), at: now() }])],
  ])('refuses everything when the list is %s', (_, make) => {
    make()
    expect(decide('Read', { file_path: shot })).toBe('deny')
    expect(decide('Artifact', { action: 'read', url: LINK })).toBe('deny')
  })

  it.each([
    ['Write', { file_path: shot, content: 'x' }],
    ['Edit', { file_path: shot, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: shot, edits: [] }],
    ['NotebookEdit', { notebook_path: shot, new_source: 'x' }],
    ['Bash', { command: `cat ${shot}`, description: 'x' }],
    ['Bash', { command: `head -c 10 ${shot}`, description: 'x' }],
    ['Grep', { pattern: 'x', path: drops }],
    ['Grep', { pattern: 'x', path: shot }],
    ['Glob', { pattern: '*', path: drops }],
    ['Glob', { pattern: shot }],
    ['LS', { path: drops }],
  ])('only reads it, with Read: refuses %s (%j)', (tool, input) => {
    expect(decide(tool, input)).toBe('deny')
  })

  it('reads its own list only: another Buddy\'s guard refuses this Buddy\'s file and lets its own', () => {
    const theirs = { file: join(parent, 'buddy-reads', 'their-session.json'), drops }
    const guard = join(parent, 'their-guard.mjs')
    writeFileSync(guard, buddyGuardSource(root, theirs))
    writeFileSync(theirs.file, JSON.stringify({ version: 1, files: [{ ...identity(otherChat), at: now() }], links: [] }))
    expect(decide('Read', { file_path: shot }, guard)).toBe('deny')
    expect(decide('Read', { file_path: otherChat }, guard)).toBe('allow')
    expect(decide('Read', { file_path: otherChat })).toBe('deny')
  })

  it.each([
    { action: 'read', url: LINK },
    { action: 'read', url: `${LINK}/` },
    { action: 'read', url: 'https://CLAUDE.ai/artifact/abc-123' },
    { action: 'read', url: CODE_LINK },
    { action: 'read', url: LINK, prompt: 'What does the chart show?' },
    { action: 'read', url: LINK, page: true },
  ])('lets the Artifact tool read a link its person sent (%j)', input => {
    expect(decide('Artifact', input)).toBe('allow')
  })

  it.each([
    // Links it was not sent.
    { action: 'read', url: 'https://claude.ai/artifact/abc-1234' },
    { action: 'read', url: 'https://claude.ai/code/artifact/abc-123' },
    { action: 'read', url: `${LINK}?version=2` },
    { action: 'read', url: `${LINK}#top` },
    { action: 'read', url: `${LINK}/files` },
    { action: 'read', url: 'https://claude.ai/artifact/abc-123%2F..' },
    { action: 'read', url: 'http://claude.ai/artifact/abc-123' },
    { action: 'read', url: 'https://claude.ai:8443/artifact/abc-123' },
    { action: 'read', url: 'https://someone@claude.ai/artifact/abc-123' },
    { action: 'read', url: 'https://evil.claude.ai/artifact/abc-123' },
    { action: 'read', url: 'https://claude.ai.example.com/artifact/abc-123' },
    { action: 'read', url: 'claude.ai/artifact/abc-123' },
    { action: 'read', url: 'abc-123' },
    { action: 'read' },
    { action: 'read', url: ['https://claude.ai/artifact/abc-123'] },
    // Anything but reading the page: its other actions, saving a file of it to a folder, or another type.
    { url: LINK },
    { action: 'list' },
    { action: 'list', url: LINK, scope: 'files' },
    { action: 'publish', url: LINK, file_path: 'page.html' },
    { action: 'delete', url: LINK },
    { action: 'open', url: LINK },
    { action: 'pin', url: LINK },
    { action: 'quickstart', intent: 'other' },
    { action: 'read', url: LINK, path: 'index.html' },
    { action: 'read', url: LINK, paths: ['index.html'] },
    { action: 'read', url: LINK, out_dir: drops },
    { action: 'read', url: LINK, type_url: LINK },
    { action: 'read', url: LINK, prompt: 1 },
    { action: 'read', url: LINK, page: 'yes' },
  ])('refuses the Artifact tool anything else (%j)', input => {
    expect(decide('Artifact', input)).toBe('deny')
  })

  it('keeps a link a day, and lets no other tool use it', () => {
    list([], [{ url: LINK, at: now() - 24 * 60 * 60 * 1000 }])
    expect(decide('Artifact', { action: 'read', url: LINK })).toBe('deny')
    list([], [{ url: LINK, at: now() }])
    expect(decide('WebFetch', { url: LINK, prompt: 'x' })).toBe('deny')
    expect(decide('ArtifactComments', { url: LINK })).toBe('deny')
    expect(decide('ArtifactData', { url: LINK, action: 'list', collection: 'x' })).toBe('deny')
    expect(decide('Bash', { command: `curl ${LINK}`, description: 'x' })).toBe('deny')
  })
})

describe('the host\'s list of what a Buddy\'s person sent it', () => {
  const lists = join(parent, 'lists')
  const mine = { file: join(lists, 'mine.json'), drops }
  const guard = join(parent, 'list-guard.mjs')
  writeFileSync(guard, buddyGuardSource(root, mine))
  const sent = join(drops, 'aaaa0001-plan.pdf'), later = join(drops, 'aaaa0002-chart.png')
  const held = () => JSON.parse(readFileSync(mine.file, 'utf8'))
  // The mark beside [list] that [session] listed in it, which its end finds by name (follow-up to #2248).
  const mark = (list: string, session: string) => `${list.replace(/\.json$/, '')}.${createHash('sha256').update(session).digest('hex')}.owner`
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    return { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
  }
  beforeEach(() => {
    rmSync(lists, { recursive: true, force: true })
    for (const path of [sent, later]) { rmSync(path, { force: true }); writeFileSync(path, 'bytes') }
  })

  it('is kept for each Buddy session apart, in Harness\'s data folder, beside its downloads folder', () => {
    expect(buddyReadsOf('session-key')).toEqual({
      file: join(process.env.ADAPTER_DATA_DIR!, 'buddy-reads', '1add55581aaea687f8c5e7919f217cb6640cba7d2c14e7e4d6d4df21460642cf.json'),
      drops: join(process.env.ADAPTER_DATA_DIR!, 'paste-drops') })
    expect(buddyReadsOf('another-session').file).not.toBe(buddyReadsOf('session-key').file)
  })

  it('lists each file with what makes it that file, and each link, and the guard then lets the Buddy read them', () => {
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: ['https://claude.ai/artifact/abc-123'] }, 1_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', files: [{ ...identity(sent), at: 1_000 }], links: [{ url: 'https://claude.ai/artifact/abc-123', at: 1_000 }] })
    expect(lstatSync(mine.file).mode & 0o777).toBe(0o600)
    expect(lstatSync(lists).mode & 0o777).toBe(0o700)
    expect(readdirSync(lists).sort()).toEqual([basename(mark(mine.file, 'harness-1')), 'mine.json'].sort())
    expect(readFileSync(mark(mine.file, 'harness-1'), 'utf8')).toBe('')
    expect(lstatSync(mark(mine.file, 'harness-1')).mode & 0o777).toBe(0o600)
    // Now: the first file, listed at 1 000 ms since 1970, is long past its day.
    allowBuddyReads(mine, { session: 'harness-1', files: [later], links: [] })
    expect(decide('Read', { file_path: later }, guard)).toBe('allow')
    expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
  })

  it.each([
    ['a file outside the downloads folder', () => join(outside, 'secret.txt')],
    ['a path into it with a ".."', () => `${drops}/../paste-drops/aaaa0001-plan.pdf`],
    ['a link', () => { const link = join(drops, 'aaaa0003-link'); rmSync(link, { force: true }); symlinkSync(sent, link); return link }],
    ['a file with a second name', () => { const twin = join(drops, 'aaaa0004-twin'); rmSync(twin, { force: true }); linkSync(later, twin); return later }],
    ['a folder', () => drops],
    ['a file that is gone', () => join(drops, 'aaaa0005-gone.png')],
    ['a file larger than a message\'s file can be', () => { const big = join(drops, 'aaaa0006-big'); writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1)); return big }],
  ])('lists no %s', (_, path) => {
    allowBuddyReads(mine, { session: 'harness-1', files: [sent, path()], links: [] }, 1_000)
    expect(held().files).toEqual([{ ...identity(sent), at: 1_000 }])
  })

  it('lists only claude.ai Artifact links', () => {
    allowBuddyReads(mine, { session: 'harness-1', files: [], links: ['https://example.com/artifact/x', 'https://claude.ai/artifact/ok', 'http://claude.ai/artifact/x',
      'https://claude.ai/artifact/x?v=1', 'https://claude.ai/chat/x'] }, 1_000)
    expect(held().links).toEqual([{ url: 'https://claude.ai/artifact/ok', at: 1_000 }])
  })

  it('writes nothing when there is nothing to list', () => {
    allowBuddyReads(mine, { session: 'harness-1', files: [join(outside, 'secret.txt')], links: ['https://example.com'] }, 1_000)
    expect(existsSync(lists)).toBe(false)
  })

  it('keeps the day\'s earlier entries, drops those a day old, and moves one sent again to its newest time', () => {
    const DAY = 24 * 60 * 60 * 1000
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: ['https://claude.ai/artifact/a'] }, 1_000)
    allowBuddyReads(mine, { session: 'harness-1', files: [later], links: ['https://claude.ai/artifact/b'] }, 2_000)
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: ['https://claude.ai/artifact/a'] }, 3_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', files: [{ ...identity(later), at: 2_000 }, { ...identity(sent), at: 3_000 }],
      links: [{ url: 'https://claude.ai/artifact/b', at: 2_000 }, { url: 'https://claude.ai/artifact/a', at: 3_000 }] })
    allowBuddyReads(mine, { session: 'harness-1', files: [], links: ['https://claude.ai/artifact/c'] }, 2_000 + DAY)
    expect(held()).toEqual({ version: 1, session: 'harness-1', files: [{ ...identity(sent), at: 3_000 }],
      links: [{ url: 'https://claude.ai/artifact/a', at: 3_000 }, { url: 'https://claude.ai/artifact/c', at: 2_000 + DAY }] })
  })

  it('holds at most the last 100 files and 50 links', () => {
    const many = Array.from({ length: 105 }, (_, i) => { const path = join(drops, `bbbb${String(i).padStart(4, '0')}-f`); writeFileSync(path, 'x'); return path })
    const links = Array.from({ length: 55 }, (_, i) => `https://claude.ai/artifact/l${i}`)
    allowBuddyReads(mine, { session: 'harness-1', files: many.slice(0, 60), links: links.slice(0, 30) }, 1_000)
    allowBuddyReads(mine, { session: 'harness-1', files: many.slice(60), links: links.slice(30) }, 2_000)
    expect(held().files.map((f: { path: string }) => f.path)).toEqual(many.slice(5))
    expect(held().links.map((l: { url: string }) => l.url)).toEqual(links.slice(5))
    for (const path of many) rmSync(path)
  })

  it('starts again from an unreadable list rather than failing the delivery', () => {
    mkdirSync(lists)
    writeFileSync(mine.file, '{"files": [')
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] }, 1_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', files: [{ ...identity(sent), at: 1_000 }], links: [] })
    writeFileSync(mine.file, JSON.stringify({ version: 1, session: 'harness-1', files: [null, { path: 1 }, { ...identity(later), at: 'now' },
      { ...identity(later), sha256: undefined, at: 900 }], links: [{ url: 2, at: 1 }] }))
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] }, 1_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', files: [{ ...identity(sent), at: 1_000 }], links: [] })
  })

  it('removes the lists of other Buddy sessions untouched for a day, and the marks of lists that are gone, and keeps the rest', () => {
    const DAY = 24 * 60 * 60 * 1000, at = Date.now()
    mkdirSync(lists)
    for (const name of ['old.json', 'old.json.0d1e.tmp', 'recent.json']) writeFileSync(join(lists, name), '{}')
    // A mark stays as long as its list does, however old, so the list's session still finds it; one whose list is gone goes.
    const kept = mark(join(lists, 'recent.json'), 'harness-2'), orphan = mark(join(lists, 'gone.json'), 'harness-3')
    for (const file of [kept, orphan]) writeFileSync(file, '')
    for (const file of [join(lists, 'old.json'), join(lists, 'old.json.0d1e.tmp'), kept]) utimesSync(file, new Date(at - DAY - 1_000), new Date(at - DAY - 1_000))
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] }, at)
    expect(readdirSync(lists).sort()).toEqual([basename(mark(mine.file, 'harness-1')), basename(kept), 'mine.json', 'recent.json'].sort())
  })

  it('keeps nothing another session listed under the same key', () => {
    allowBuddyReads(mine, { session: 'harness-0', files: [sent], links: ['https://claude.ai/artifact/a'] }, 1_000)
    allowBuddyReads(mine, { session: 'harness-1', files: [later], links: [] }, 2_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', files: [{ ...identity(later), at: 2_000 }], links: [] })
  })

  // Lead, 10-30: a Buddy removed, or its chat purged with its project, keeps nothing listed until the day is out. The Swarm
  // closes its session then (superTabs/host.ts endSession), and that session's lists go.
  // Follow-up to #2248 (Lead, 10-30): an end removes its own session's lists and nothing else, so nothing but its own holds it
  // back. One naming no session beside no mark is no session's: the host writes none, and the day's sweep removes it.
  it('forgets the lists a session the Swarm ended marked or names, and keeps every other session\'s and those that are no session\'s', () => {
    const theirs = { file: join(lists, 'theirs.json'), drops }
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] })
    allowBuddyReads(theirs, { session: 'harness-2', files: [later], links: [] })
    // From before lists were marked: it names its session.
    writeFileSync(join(lists, 'unmarked.json'), JSON.stringify({ version: 1, session: 'harness-1', files: [], links: [{ url: 'https://claude.ai/artifact/a', at: Date.now() }] }))
    writeFileSync(join(lists, 'broken.json'), '{"session": ')
    writeFileSync(join(lists, 'null.json'), 'null')
    writeFileSync(join(lists, 'nameless.json'), JSON.stringify({ version: 1, files: [], links: [{ url: 'https://claude.ai/artifact/a', at: Date.now() }] }))
    writeFileSync(join(lists, 'note.txt'), 'harness-1')
    expect(decide('Read', { file_path: sent }, guard)).toBe('allow')
    forgetBuddyReads('harness-1', lists)
    const left = [basename(mark(theirs.file, 'harness-2')), 'broken.json', 'nameless.json', 'note.txt', 'null.json', 'theirs.json'].sort()
    expect(readdirSync(lists).sort()).toEqual(left)
    expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
    forgetBuddyReads('harness-1', lists)
    expect(readdirSync(lists).sort()).toEqual(left)
  })

  // Follow-up to #2248 (Lead, 10-30): whose a list was that could not be read could not be told, so it held back the end of
  // every Buddy session on the machine. Re-check 1 of 116fa43a1 had made it fail the cleanup, since skipping it let it allow
  // again once it could be read. The mark beside a list says whose it is by its name alone: a session's own goes unread, and
  // another session's is that session's to remove.
  it('removes its own list even where it cannot be read, by the mark beside it, and fails nothing on another session\'s it cannot read', () => {
    const theirs = { file: join(lists, 'theirs.json'), drops }, theirGuard = join(parent, 'their-list-guard.mjs')
    writeFileSync(theirGuard, buddyGuardSource(root, theirs))
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] })
    allowBuddyReads(theirs, { session: 'harness-2', files: [later], links: [] })
    for (const list of [mine, theirs]) chmodSync(list.file, 0o000)
    try {
      expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
      expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
      expect(existsSync(mine.file)).toBe(false)
      expect(existsSync(mark(mine.file, 'harness-1'))).toBe(false)
      expect(existsSync(theirs.file)).toBe(true)
      expect(decide('Read', { file_path: later }, theirGuard)).toBe('deny')
      expect(() => forgetBuddyReads('harness-2', lists)).not.toThrow()
      expect(readdirSync(lists)).toEqual([])
    } finally { for (const list of [mine, theirs]) if (existsSync(list.file)) chmodSync(list.file, 0o600) }
    expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
    expect(decide('Read', { file_path: later }, theirGuard)).toBe('deny')
  })

  // Follow-up to #2248 (Lead, 10-30): a list that cannot be removed holds back its own session's end, and no other.
  it('fails the end of only the session whose own list it cannot remove, keeps that list\'s mark to try again, and its guard allows nothing', () => {
    const theirs = { file: join(lists, 'theirs.json'), drops }, theirGuard = join(parent, 'their-list-guard.mjs')
    writeFileSync(theirGuard, buddyGuardSource(root, theirs))
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] })
    allowBuddyReads(theirs, { session: 'harness-2', files: [later], links: [] })
    expect(decide('Read', { file_path: later }, theirGuard)).toBe('allow')
    // Their list can be neither removed, nor written over, nor read: a folder stands in its place, as a file the system will
    // not let go of would (one held open, on Windows).
    rmSync(theirs.file); mkdirSync(join(theirs.file, 'held'), { recursive: true })
    try {
      expect(decide('Read', { file_path: later }, theirGuard)).toBe('deny')
      expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
      expect(existsSync(mine.file)).toBe(false)
      expect(() => forgetBuddyReads('harness-2', lists)).toThrow(/director/i)
      expect(existsSync(mark(theirs.file, 'harness-2'))).toBe(true)
      expect(decide('Read', { file_path: later }, theirGuard)).toBe('deny')
    } finally { rmSync(theirs.file, { recursive: true, force: true }) }
    expect(() => forgetBuddyReads('harness-2', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
    expect(decide('Read', { file_path: later }, theirGuard)).toBe('deny')
  })

  it('fails while the mark beside its own list cannot be removed, though the list is gone, and passes once it can', () => {
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] })
    const own = mark(mine.file, 'harness-1')
    rmSync(own); mkdirSync(join(own, 'held'), { recursive: true })
    try {
      expect(() => forgetBuddyReads('harness-1', lists)).toThrow(/director/i)
      expect(existsSync(mine.file)).toBe(false)
      expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
    } finally { rmSync(own, { recursive: true, force: true }) }
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
  })

  it('keeps, at an earlier session\'s end, the list a later session wrote under the same key', () => {
    allowBuddyReads(mine, { session: 'harness-0', files: [sent], links: [] })
    allowBuddyReads(mine, { session: 'harness-1', files: [later], links: [] })
    forgetBuddyReads('harness-0', lists)
    expect(held().session).toBe('harness-1')
    expect(decide('Read', { file_path: later }, guard)).toBe('allow')
    expect(existsSync(mark(mine.file, 'harness-0'))).toBe(false)
    forgetBuddyReads('harness-1', lists)
    expect(readdirSync(lists)).toEqual([])
  })

  it('lists nothing when it cannot mark whose the list is', () => {
    mkdirSync(mark(mine.file, 'harness-1'), { recursive: true })
    expect(() => allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: [] })).toThrow()
    expect(existsSync(mine.file)).toBe(false)
    expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
  })

  // Re-check 2 of #2248: a list the host cannot delete must still allow nothing, and the failure must reach the host, which
  // tries again before it acknowledges the end of the session.
  it('empties a list it cannot delete, so the guard allows nothing, fails so it is tried again, and deletes it then', () => {
    allowBuddyReads(mine, { session: 'harness-1', files: [sent], links: ['https://claude.ai/artifact/a'] })
    expect(decide('Read', { file_path: sent }, guard)).toBe('allow')
    chmodSync(lists, 0o500)
    try {
      expect(() => forgetBuddyReads('harness-1', lists)).toThrow(/EACCES|EPERM/)
      expect(existsSync(mine.file)).toBe(true)
      expect(existsSync(mark(mine.file, 'harness-1'))).toBe(true)
      expect(decide('Read', { file_path: sent }, guard)).toBe('deny')
      expect(decide('Artifact', { action: 'read', url: 'https://claude.ai/artifact/a' }, guard)).toBe('deny')
    } finally { chmodSync(lists, 0o700) }
    forgetBuddyReads('harness-1', lists)
    expect(readdirSync(lists)).toEqual([])
  })

  // Security reviews of #2261, folded into #2310 (Lead, 10-30): every writer of a session's list marks it first, so a list
  // that cannot be read still holds back its own session's end, and only that one.
  const writers: Array<[string, (session: string) => void]> = [
    ['allowBuddyReads', (session) => allowBuddyReads(mine, { session, files: [sent], links: [] })],
    ['recordBuddyApprovals', (session) => recordBuddyApprovals({ reads: mine, session, approvals: join(parent, 'approvals', 'person.json'),
      judged: { wide: true, approve: [], refused: [], forgot: true }, messageId: 'm' })],
    ['grantBuddyWide', (session) => grantBuddyWide(mine, { session, wide: true })],
  ]
  it.each(writers)('marks the list %s writes, so its session\'s end finds it unread, holds back on it alone, and removes it', (_, write) => {
    write('harness-1')
    expect(existsSync(mark(mine.file, 'harness-1'))).toBe(true)
    chmodSync(mine.file, 0o000)
    chmodSync(lists, 0o500)
    try {
      expect(() => forgetBuddyReads('harness-2', lists)).not.toThrow()
      expect(() => forgetBuddyReads('harness-1', lists)).toThrow(/EACCES|EPERM/)
      expect(existsSync(mine.file)).toBe(true)
    } finally { chmodSync(lists, 0o700) }
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
  })

  it('fails on a list it cannot read with no session\'s mark beside it, as before, and skips one beside another session\'s mark', () => {
    const orphan = join(lists, 'orphan.json')
    mkdirSync(lists, { recursive: true })
    // Another session's list, which that session's own end removes: here its mark is not written yet.
    writeFileSync(orphan, JSON.stringify({ version: 1, session: 'harness-2', files: [], links: [] }))
    chmodSync(orphan, 0o000)
    try {
      expect(() => forgetBuddyReads('harness-1', lists)).toThrow(/EACCES|EPERM/)
      expect(existsSync(orphan)).toBe(true)
      writeFileSync(mark(orphan, 'harness-2'), '')
      expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
      expect(existsSync(orphan)).toBe(true)
    } finally { chmodSync(orphan, 0o600) }
    forgetBuddyReads('harness-2', lists)
    expect(readdirSync(lists)).toEqual([])
  })

  it('writes the mark only as a file of its own: never through a link, and keeps one already there', () => {
    mkdirSync(lists, { recursive: true })
    const elsewhere = join(parent, 'elsewhere-target.txt')
    writeFileSync(elsewhere, 'untouched')
    symlinkSync(elsewhere, mark(mine.file, 'harness-1'))
    try {
      expect(() => grantBuddyWide(mine, { session: 'harness-1', wide: true })).toThrow()
      expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
      expect(existsSync(mine.file)).toBe(false)
    } finally { rmSync(mark(mine.file, 'harness-1')); rmSync(elsewhere) }
    grantBuddyWide(mine, { session: 'harness-1', wide: true })
    grantBuddyWide(mine, { session: 'harness-1', wide: false })
    expect(lstatSync(mark(mine.file, 'harness-1')).isFile()).toBe(true)
    expect(held()).toMatchObject({ session: 'harness-1', wide: false })
  })

  it('takes the marks of other sessions away from a list a session writes', () => {
    allowBuddyReads(mine, { session: 'harness-0', files: [sent], links: [] })
    grantBuddyWide(mine, { session: 'harness-1', wide: true })
    expect(existsSync(mark(mine.file, 'harness-0'))).toBe(false)
    expect(existsSync(mark(mine.file, 'harness-1'))).toBe(true)
    // The earlier session's end no longer finds the list as its own.
    forgetBuddyReads('harness-0', lists)
    expect(held().session).toBe('harness-1')
  })

  it('forgets nothing, and fails nothing, where no list was ever written', () => {
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(existsSync(lists)).toBe(false)
  })

  it.each([
    ['a plain link', 'See https://claude.ai/artifact/abc-123', ['https://claude.ai/artifact/abc-123']],
    ['a link in Markdown, and one at the end of a sentence', '[the plan](https://claude.ai/artifact/abc-123) and https://claude.ai/code/artifact/0b7e-8f2c.',
      ['https://claude.ai/artifact/abc-123', 'https://claude.ai/code/artifact/0b7e-8f2c']],
    ['a link with a query, a fragment or a trailing slash, as its artifact', 'https://claude.ai/artifact/a?v=2 https://claude.ai/artifact/b#top https://claude.ai/artifact/c/',
      ['https://claude.ai/artifact/a', 'https://claude.ai/artifact/b', 'https://claude.ai/artifact/c']],
    ['the preview site, and a host in capitals', 'https://preview.claude.ai/artifact/p1 HTTPS://CLAUDE.AI/artifact/p2',
      ['https://preview.claude.ai/artifact/p1', 'https://claude.ai/artifact/p2']],
    ['one link sent twice', 'https://claude.ai/artifact/x and again https://claude.ai/artifact/x', ['https://claude.ai/artifact/x']],
    ['no look-alikes', 'http://claude.ai/artifact/a https://claude.ai.example.com/artifact/b https://evil.claude.ai/artifact/c '
      + 'https://claude.ai:8443/artifact/d https://me@claude.ai/artifact/e https://claude.ai/artifact/f/files https://claude.ai/chat/g '
      + 'claude.ai/artifact/h https://claude.ai/artifact/i%2F..', []],
  ])('finds the Artifact links in a message: %s', (_, text, links) => {
    expect(artifactLinks(text)).toEqual(links)
  })
})

// Scholes, 10-29, and the Lead's ruling on #2185's security reviews: a Buddy never waits on a person. Whatever shape a call
// takes, the guard answers it now, allow or deny, with a reason the Buddy reads; never "ask", which would put a prompt in a
// terminal nobody watches, and never silence, which would hand the call to the permission rules.
describe('a Buddy never waits on an approval', () => {
  const tools: Array<[string, Record<string, unknown>]> = [
    ['Monitor', { command: 'while true; do harness super-tab --tab t messages chat; sleep 30; done', description: 'x', persistent: true }],
    ['AskUserQuestion', { questions: [{ question: 'Go?', header: 'Go', options: [{ label: 'Yes' }, { label: 'No' }] }] }],
    ['ExitPlanMode', { plan: 'x' }], ['EnterPlanMode', {}], ['Agent', { prompt: 'x', description: 'x' }], ['Task', { prompt: 'x' }],
    ['WebFetch', { url: 'https://example.com', prompt: 'x' }], ['WebSearch', { query: 'x' }], ['NotebookEdit', { notebook_path: 'a.ipynb' }],
    ['Skill', { skill: 'x' }], ['CronCreate', { cron: '* * * * *', prompt: 'x' }], ['mcp__any__tool', {}], ['', {}],
    ['Read', { file_path: join(outside, 'secret.txt') }], ['Read', {}], ['Glob', { pattern: '../**' }], ['Grep', { pattern: 'x', path: '/' }],
    ['Bash', { command: 'harness super-tab --tab t messages chat', run_in_background: true }], ['Bash', {}],
  ]
  const words = ['harness super-tab --tab t messages chat', 'git log', 'git push', 'curl -X POST x', 'cat a.txt', 'sleep 30', 'rm -rf .',
    'gh pr create', 'tail -f a.txt', 'harness new codex', 'npm install', 'python3 -c 1']
  const joins = [(a: string, b: string) => `${a}; ${b}`, (a: string, b: string) => `${a} && ${b}`, (a: string, b: string) => `${a} | ${b}`,
    (a: string, b: string) => `${a} & ${b}`, (a: string, b: string) => `${a}\n${b}`, (a: string) => `$(${a})`, (a: string) => `\`${a}\``,
    (a: string) => `while true; do ${a}; done`, (a: string) => `bash -c '${a}'`, (a: string) => `${a} > out.txt`, (a: string) => `(${a})`,
    (a: string) => `nohup ${a}`, (a: string) => `FOO=1 ${a}`, (a: string) => a]
  const shapes = joins.flatMap(join => words.map((word, i) => join(word, words[(i + 1) % words.length]!)))

  function answer(tool: string, input: Record<string, unknown>) {
    const run = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: root }))
    return { status: run.status, output: run.stdout ? JSON.parse(run.stdout).hookSpecificOutput : null }
  }

  it.each(tools)('answers the %s tool now, never asking', (tool, input) => {
    const { status, output } = answer(tool, input)
    expect(status).toBe(0)
    expect(['allow', 'deny']).toContain(output.permissionDecision)
    expect(output.permissionDecisionReason).toEqual(expect.any(String))
    if (output.permissionDecision === 'deny') expect(output.permissionDecisionReason).toContain('nobody will be asked')
  })

  // One test each: a spawn per shape, so one slow machine never times out the whole set.
  it.each(shapes)('answers the shell shape %j now, never asking, and refuses it unless it only reads', command => {
    const { status, output } = answer('Bash', { command, description: 'x' })
    expect(status).toBe(0)
    expect(['allow', 'deny']).toContain(output.permissionDecision)
    if (output.permissionDecision === 'deny') expect(output.permissionDecisionReason).toContain('nobody will be asked')
    // Only a single plain command of the Buddy's own reads; every joined, looped, redirected or wrapped one is refused.
    if (/[;&|`$()>\n]|^(while|bash|nohup|FOO=)/.test(command)) expect(output.permissionDecision).toBe('deny')
  })
})
