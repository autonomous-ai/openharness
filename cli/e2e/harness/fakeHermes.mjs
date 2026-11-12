// A stand-in for Hermes v0.23's CLI, run in a real tmux pane by the daemon under test (e2e/hermesTerminalRecord.e2e.ts).
// It does what the daemon reads of a Hermes, as Hermes does it, and nothing more:
//
//   - answers `--version` with the release it is told to be;
//   - keeps its sessions in `<home>/state.db`, its home being `HERMES_HOME`, else `<HOME>/.hermes`
//     (`hermes_constants.py`): a session is `local-<sha256 hex>` with `source = 'local'` and `created_source = 'cli'`,
//     its messages in `messages`, the table `e2e/hermesAdmission.e2e.ts` makes; the session its terminal leaves (`/new`,
//     `/resume`, its exit) is ended, `ended_at` the time in seconds, and one it resumes is opened again
//     (`hermes_state.py` `end_session`, `reopen_session`);
//   - writes `<home>/terminal-sessions/<terminal id>` each time its terminal's session is set, through a temporary file
//     and a rename (`hermes_cli/terminal_breadcrumbs.py`), the terminal named as `get_terminal_id()` names it: the tty
//     of its stdin, else its tmux pane;
//   - notes in `<home>/started.json`, once it has started, the `HERMES_HOME` its launch exported (`FAKE_GIVEN_HERMES_HOME`,
//     which the wrapper sets), so a test can see what a relaunch named, its terminal id and the session it started on.
//
// Then it does what the test appends to its script file, one JSON line each, read from where the file ended when it
// started: `{"new":true}` a new session (as `/new` does), `{"resume":"<id>"}` that session (as `/resume` does),
// `{"say":"<text>"}` a user row and an answer in the session, `{"link":"<path>"}` its record replaced by a symlink to
// that path, `{"pad":<bytes>}` its record rewritten that large.
//
// It keeps its own argv: with `process.title` set, macOS `ps` no longer shows a process's environment, and the daemon
// reads a Hermes's home from it.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The text of a `hermes` the test writes at `HERMES_PATH`.
 *
 * `version`: what `--version` prints. `script`: the file of JSON lines the test appends to (it must exist).
 * `record: false`: no terminal record, as Hermes's TUI. `home`: a folder that is the process's `HOME`, with no
 * `HERMES_HOME`: a Hermes with a home of its own. `sandbox` (Linux): that, run under `unshare` with a private `/tmp`;
 * `'remapped'` sees its folder at `/tmp/home`, its work folder at `/tmp/work` and a `/dev/pts` of its own, `'unseen'`
 * has its `HOME` on the private `/tmp`.
 *
 * @param {{ version: string, script: string, record?: boolean, home?: string, sandbox?: 'same' | 'remapped' | 'unseen' }} options
 */
export function fakeHermesScript(options) {
  const fake = `import(${JSON.stringify(pathToFileURL(import.meta.filename).href)}).then((m) => m.run(${JSON.stringify(options)}))\n`
  if (!options.home && !options.sandbox) return `#!${process.execPath}\n${fake}`
  // A /bin/sh wrapper that is also the fake: each line sh runs is a comment to Node, which it then runs on this same
  // file, so the process the daemon finds is still `node <HERMES_PATH>`.
  const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`
  const node = quote(process.execPath)
  const lines = [
    `case "$1" in --version) echo ${quote(options.version)}; exit 0;; esac`,
    'FAKE_GIVEN_HERMES_HOME="${HERMES_HOME-}"; export FAKE_GIVEN_HERMES_HOME; unset HERMES_HOME',
  ]
  if (!options.sandbox) lines.push(`HOME=${quote(options.home)}; export HOME; exec ${node} "$0" "$@"`)
  else {
    const mounts = ['mount -t tmpfs tmpfs /tmp']
    if (options.sandbox === 'same') mounts.push(`HOME=${quote(options.home)}`)
    if (options.sandbox === 'remapped') {
      mounts.push('mkdir -p /tmp/home /tmp/work', `mount --bind ${quote(options.home)} /tmp/home`, 'mount --bind "$PWD" /tmp/work',
        'mount -t devpts -o newinstance devpts /dev/pts', 'cd /tmp/work', 'HOME=/tmp/home')
    }
    if (options.sandbox === 'unseen') mounts.push('mkdir -p /tmp/agent', 'HOME=/tmp/agent')
    const inside = [...mounts, 'export HOME', 'exec "$@"'].join(' && ')
    lines.push(`exec unshare --user --map-root-user --mount --pid --fork -- /bin/sh -c ${quote(inside)} sh ${node} "$0" "$@"`)
  }
  return `#!/bin/sh\n${lines.map((line) => `// 2>/dev/null; ${line}`).join('\n')}\n${fake}`
}

/** The fake itself, in the `hermes` process. */
export function run(options) {
  const args = process.argv.slice(2)
  if (args.includes('--version')) {
    console.log(options.version)
    process.exit(0)
  }
  // Node's warning that node:sqlite is experimental would be drawn in the pane.
  process.removeAllListeners('warning')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')

  const home = process.env.HERMES_HOME?.startsWith('/') ? process.env.HERMES_HOME : join(process.env.HOME, '.hermes')
  mkdirSync(home, { recursive: true })
  const db = new DatabaseSync(join(home, 'state.db'))
  db.exec('PRAGMA busy_timeout = 5000;'
    + 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, created_source TEXT, cwd TEXT, started_at REAL,'
    + ' ended_at REAL, end_reason TEXT);'
    + 'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,'
    + ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT);')

  // `hermes_cli/terminal_breadcrumbs.py`: outer whitespace and `/` off, anything outside [A-Za-z0-9._-] a `-`, 120 kept.
  const clean = (value) => value.trim().replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)
  const terminal = (() => {
    try {
      const tty = execFileSync('tty', { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8' }).trim()
      if (tty.startsWith('/')) return `tty-${clean(tty)}`
    } catch { /* no tty: its pane names it */ }
    return process.env.TMUX_PANE ? `tmux_pane-${clean(process.env.TMUX_PANE)}` : null
  })()
  const recordPath = terminal && join(home, 'terminal-sessions', terminal)
  const replaceRecord = (write) => {
    if (!recordPath || options.record === false) return
    mkdirSync(dirname(recordPath), { recursive: true })
    const temporary = `${recordPath}.${process.pid}.tmp`
    rmSync(temporary, { force: true })
    write(temporary)
    renameSync(temporary, recordPath)
  }
  let session = ''
  const record = (extra = {}) => replaceRecord((path) => writeFileSync(path,
    JSON.stringify({ session_id: session, cwd: process.cwd(), ts: Date.now() / 1000, ...extra })))
  // The first reason wins: an ended session is not ended again until it is opened again.
  const end = (reason) => {
    if (session) db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(Date.now() / 1000, reason, session)
  }
  const reopen = () => db.prepare('UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?').run(session)
  // In a pid namespace of its own it is pid 1, which a signal with no handler does not stop.
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => { end('cli_close'); process.exit(0) })
  const start = () => {
    end('new_session')
    session = `local-${createHash('sha256').update(randomBytes(32)).digest('hex')}`
    db.prepare("INSERT INTO sessions (id, source, created_source, cwd, started_at) VALUES (?, 'local', 'cli', ?, ?)")
      .run(session, process.cwd(), Date.now() / 1000)
    record()
  }

  const resumed = args.findIndex((arg) => arg === '--resume' || arg === '-r')
  if (resumed >= 0 && args[resumed + 1]) {
    session = args[resumed + 1]
    reopen()
    record()
  } else start()
  writeFileSync(join(home, 'started.json'), JSON.stringify({ given: process.env.FAKE_GIVEN_HERMES_HOME ?? '', terminal, session }))
  process.stdout.write('fake-hermes-ready\n❯ ')

  const step = (line) => {
    if (line.new) start()
    if (line.resume) {
      end('resumed_other')
      session = line.resume
      reopen()
      record()
    }
    if (typeof line.say === 'string') {
      const insert = db.prepare('INSERT INTO messages (session_id, role, content, finish_reason) VALUES (?, ?, ?, ?)')
      insert.run(session, 'user', line.say, null)
      insert.run(session, 'assistant', `heard: ${line.say}`, 'stop')
      process.stdout.write(`${line.say}\nheard: ${line.say}\n❯ `)
    }
    if (line.link) replaceRecord((path) => symlinkSync(line.link, path))
    if (line.pad) record({ pad: 'x'.repeat(line.pad) })
  }
  let offset = statSync(options.script).size
  let partial = ''
  const follow = () => {
    const size = statSync(options.script).size
    if (size <= offset) return
    const text = Buffer.alloc(size - offset)
    const fd = openSync(options.script, 'r')
    try { readSync(fd, text, 0, text.length, offset) } finally { closeSync(fd) }
    offset = size
    const lines = (partial + text.toString('utf8')).split('\n')
    partial = lines.pop()
    for (const line of lines) if (line.trim()) step(JSON.parse(line))
  }
  watch(options.script, follow)
  // A change the watch did not report is read on this tick.
  setInterval(follow, 1_000)
}
