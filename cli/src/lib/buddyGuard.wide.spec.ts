import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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

const wide = buddyWideOf({ home, dataDir, tmpDirs: [tmpClaude], personKey: 'person-1:generation-1' })
const script = join(parent, 'buddy-guard.mjs'), narrow = join(parent, 'buddy-guard-narrow.mjs')
writeFileSync(script, buddyGuardSource(root, reads, wide))
writeFileSync(narrow, buddyGuardSource(root, reads))
afterAll(() => rmSync(parent, { recursive: true, force: true }))

function decide(tool: string, input: Record<string, unknown>, guard = script): string {
  const run = spawnSync(process.execPath, [guard], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
    cwd: root }), encoding: 'utf8', timeout: 10_000 })
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout).hookSpecificOutput.permissionDecision
}
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
