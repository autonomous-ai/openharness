/** The shipped hn and real daemons, connected locally and across an encrypted fleet lane.
 * TUI CI supplies HN_TUI_BINARY and E2E_BUNDLE=1; the CLI-only suite has no Rust binary. */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { startFleet, type Fleet } from './harness/fleet.js'
import { until } from './harness/daemon.js'

const exec = promisify(execFile)
const binary = process.env.HN_TUI_BINARY && resolve(process.env.HN_TUI_BINARY)
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
let world: Fleet | undefined
let hn: ((...args: string[]) => Promise<string>) | undefined
afterEach(async context => {
  if (context.task.result?.state === 'fail') {
    console.log('hn:', await hn?.('capture-pane', '-p', '-S', '-').catch(String))
    console.log('source:', world?.a.daemon.log().slice(-8000), 'destination:', world?.b.daemon.log().slice(-8000))
  }
  await hn?.('kill-server').catch(() => {})
  await world?.close()
  hn = undefined; world = undefined
})

it.runIf(binary)('keeps connected local shells interactive and composes a remote agent with literal argv, then returns to the original shell', async () => {
  expect(existsSync(binary!)).toBe(true)
  expect(process.env.E2E_BUNDLE_PATH, 'run with E2E_BUNDLE=1').toBeTruthy()
  // Ubuntu's system zshrc otherwise prompts about the runner's shared completion
  // directories before this private HOME's rc file can set up the test shell.
  const shellEnv = { SHELL: '/bin/zsh', skip_global_compinit: '1' }
  world = await startFleet({ envA: shellEnv, envB: shellEnv })
  const { a, b } = world
  // With the gateway in its own process, core-ready precedes relay registration.
  // Both computers must be online before this test asks hn to connect to them.
  await until('both fleet nodes online', () => world!.backend.nodeUp(a.machineId) && world!.backend.nodeUp(b.machineId))
  // These wrappers are the private equivalent of installed harness/hn binaries. They
  // retain each daemon's own environment and never fall through to a user's install.
  for (const machine of [a, b]) {
    const d = machine.daemon
    const wrapper = join(d.root, 'bin', 'harness')
    await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = tui ]; then shift; exec ' + quote(binary!) + ' "$@"; fi\nexec '
      + quote(process.execPath) + ' ' + quote(process.env.E2E_BUNDLE_PATH!) + ' "$@"\n', { mode: 0o700 })
    await writeFile(join(d.env.HOME!, '.zshrc'), 'PS1="SHELL_READY> "\nexport PATH=' + quote(join(d.root, 'bin')) + ':"$PATH"\n')
  }
  const env: NodeJS.ProcessEnv = { ...a.daemon.env, HN_TMPDIR: a.daemon.root, HN_DESKTOP: 'off', HARNESS_TUI_DESK: 'off',
    HARNESS_TUI_NOTIFY: 'off', HARNESS_SHELL_CLI: join(a.daemon.root, 'bin', 'harness') }
  delete env.TMUX; delete env.TMUX_PANE; delete env.HN_SOCKET
  hn = async (...args) => (await exec(binary!, ['-L', 'shell-e2e', '--port', String(a.daemon.port), '-f', '/dev/null', ...args],
    { env, cwd: a.daemon.projectsDir, timeout: 15_000 })).stdout.trim()
  const client = hn
  // Paths in the private HOME can exceed one terminal row. Join soft wraps so
  // the shell's output is checked independently of the headless pane's width.
  const screen = () => client('capture-pane', '-p', '-J', '-S', '-')
  const send = async (line: string) => { await client('send-keys', '-l', line); await client('send-keys', 'Enter') }
  const ready = () => until('interactive shell', async () => (await screen()).trimEnd().endsWith('SHELL_READY>'), 20_000)
  await client('new-session', '-d', '-s', 'shells', '-c', a.daemon.projectsDir)
  await ready()
  await send('export COMPOSER_KEEP=yes; printf "ORIGINAL_PID=%s\\n" "$$"')
  const pid = await until('the original shell PID', async () => /^ORIGINAL_PID=(\d+)$/m.exec(await screen())?.[1])
  const original = await client('display', '-p', '#{pane_id}')
  const originalPosition = await client('display', '-p', '#{window_id}:#{pane_index}:#{window_panes}')
  await client('new-window', '-c', a.daemon.projectsDir)
  await ready()
  await send('printf "NEW_WINDOW_%s\\n" OK')
  await until('new window input', async () => (await screen()).includes('NEW_WINDOW_OK'))
  await client('split-window', '-h', '-c', a.daemon.projectsDir)
  await ready()
  await send('printf "SPLIT_%s\\n" OK')
  await until('split input', async () => (await screen()).includes('SPLIT_OK'))
  expect(readdirSync(join(a.daemon.dataDir, 'shell-creations')).filter(n => n.endsWith('.json'))).toHaveLength(3)
  await client('select-window', '-t', 'shells:0')
  await client('select-pane', '-t', original)

  const cwd = join(b.daemon.env.HOME!, 'remote project ü')
  await mkdir(cwd)
  const marker = join(b.daemon.root, 'received-argv.json')
  await writeFile(b.daemon.env.CLAUDE_PATH!, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.0.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--resume --model'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
console.log('REMOTE_AGENT_READY');
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => { if (data.includes(3)) process.exit(130); });
`, { mode: 0o700 })
  const args = ['a b', '$(touch injected)', '; touch injected', "quote'and\"quote"]
  // Bracketed paste keeps the autocomplete trigger out of a complete command.
  const command = ['claude', '@machine-b', ':' + cwd, '--', ...args].map(quote).join(' ')
  await client('send-keys', '-l', '\x1b[200~' + command + '\x1b[201~')
  await client('send-keys', 'Enter')
  await until('remote agent receives composed argv', () => existsSync(marker), 30_000)
    .catch(async error => { throw new Error(String(error) + '\n' + await screen()) })
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ cwd, args: ['--', ...args] })
  expect(existsSync(join(cwd, 'injected'))).toBe(false)
  await until('remote view attached', async () => (await screen()).includes('REMOTE_AGENT_READY'))
  expect(await client('display', '-p', '#{pane_machine}')).toBe('machine-b')
  expect(readdirSync(join(b.daemon.dataDir, 'shell-creations')).filter(n => n.endsWith('.json'))).toHaveLength(1)
  await client('send-keys', 'C-c')
  await ready()
  await send('printf "RETURN=%s:%s:%s\\n" "$$" "$COMPOSER_KEEP" "$PWD"')
  await until('same shell after remote exit', async () => (await screen()).includes(`RETURN=${pid}:yes:${a.daemon.projectsDir}`))
  // Replacing an attached view allocates a new view id; its logical position
  // and the underlying shell process must both remain the same.
  expect(await client('display', '-p', '#{window_id}:#{pane_index}:#{window_panes}')).toBe(originalPosition)
  expect(await client('display', '-p', '#{pane_machine}')).toBe('machine-a')
  expect(readdirSync(join(a.daemon.dataDir, 'shell-creations')).filter(n => n.endsWith('.json'))).toHaveLength(3)
})
