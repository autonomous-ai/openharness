// setup.sh, doctor.sh, init-workspace.sh, viewer.sh and the art/check/marp wrappers, run for real by
// /bin/bash against a scratch install whose PATH is only stub commands and the few coreutils the scripts
// use: every ok, warn and miss line is reached without npm, a browser or a network. runtimes.sh looks for
// Harness's own Node in a runtime dir of the sandbox's (ADAPTER_RUNTIME_DIR), never the real ~/.harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLCHAIN = fileURLToPath(new URL('..', import.meta.url))
const COREUTILS = ['dirname', 'sed', 'basename', 'mkdir', 'cat', 'bash', 'rm', 'mv']
const SHELL_VERSION = readFileSync(join(TOOLCHAIN, 'browser.sh'), 'utf8').match(/^MARP_HEADLESS_SHELL_VERSION=(\S+)$/m)[1]
const SHELL_SUMS = Object.fromEntries([...readFileSync(join(TOOLCHAIN, 'setup.sh'), 'utf8').matchAll(/platform=(\S+) sum=([0-9a-f]{64})/g)].map((m) => [m[1], m[2]]))
const shellUrl = (platform) => `https://storage.googleapis.com/chrome-for-testing-public/${SHELL_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`
// node as runtimes.sh probes it: `node -e <script> 18` exits 0 when new enough.
const NODE = 'case "$1" in -e) exit "${NODE_OLD:-0}" ;; --version) echo v22.11.0 ;; -p) echo 4.1.0 ;; *) exit "${NODE_EXIT:-0}" ;; esac'
// A bash line tracer's hooks (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT), passed through when set.
const TRACER = Object.fromEntries(['BASH_ENV', 'SHCOV_OUT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'marp-scripts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const install = join(root, 'install')
  mkdirSync(join(install, 'toolchain'), { recursive: true })
  // Linked, not copied: $0 still names the scratch install, and a line tracer can map back to the source.
  for (const script of ['doctor.sh', 'setup.sh', 'init-workspace.sh', 'viewer.sh', 'runtimes.sh', 'browser.sh', 'art', 'check', 'marp']) symlinkSync(join(TOOLCHAIN, script), join(install, 'toolchain', script))
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const apps = join(root, 'Applications')
  const runtime = join(root, 'runtime')
  for (const dir of [bin, home, apps]) mkdirSync(dir)
  for (const name of COREUTILS) symlinkSync(['/bin', '/usr/bin'].map((d) => join(d, name)).find((p) => existsSync(p)), join(bin, name))
  const calls = join(root, 'calls.log')
  writeFileSync(calls, '')
  const box = {
    root, install, bin, home, apps, runtime,
    file(rel, body = '') { const full = join(install, rel); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body); return full },
    stub(name, body = '', where = bin) {
      const full = join(where, name)
      mkdirSync(where, { recursive: true })
      rmSync(full, { force: true }) // never write through a link to a real command
      writeFileSync(full, `#!/bin/bash\necho "${name} $*" >> "$CALLS"\n${body}\n`)
      chmodSync(full, 0o755)
      return full
    },
    run(script, { cwd = install, env = {}, args = [] } = {}) {
      const r = spawnSync('/bin/bash', [join(install, 'toolchain', script), ...args], {
        cwd, encoding: 'utf8', timeout: 30_000,
        env: { PATH: bin, HOME: home, CALLS: calls, MARP_APPLICATIONS_DIR: apps, ADAPTER_RUNTIME_DIR: runtime, ...TRACER, ...env },
      })
      return { code: r.status, lines: r.stdout.split('\n').filter(Boolean), stderr: r.stderr }
    },
    logged: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    /** The calls, minus runtimes.sh's `node -e` version probe (its script spans several lines). */
    ran: () => readFileSync(calls, 'utf8').split('\n').filter((c) => /^(node \/|npm |marp )/.test(c)),
    /** No node on PATH, Harness's own recorded where the CLI lays it down. */
    harnessNode() {
      const node = box.stub('node', NODE, join(root, 'harness-node'))
      mkdirSync(runtime, { recursive: true })
      writeFileSync(join(runtime, 'current-node'), `${node}\n`)
    },
    noNode: () => `miss node >= 18, and Harness's own Node is not in ${runtime} — run \`harness start\` once to lay it down`,
    /** The headless shell as setup.sh leaves it, for `version` (the pinned one by default). */
    headlessShell(version = SHELL_VERSION) {
      const shell = box.stub('chrome-headless-shell', '', join(install, 'toolchain', 'browser', 'chrome-headless-shell-mac-arm64'))
      writeFileSync(join(install, 'toolchain', 'browser', '.version'), `${version}\n`)
      return shell
    },
    /** No browser here: uname says `platform`, curl hands over a zip unless CURL_FAIL, shasum answers `sum`,
     *  and extract-zip lays out the shell unless UNZIP_FAIL. */
    shellDownload({ uname = 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac', sum = SHELL_SUMS['mac-arm64'] } = {}) {
      box.stub('uname', uname)
      box.stub('curl', 'for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n[ -n "$CURL_FAIL" ] && exit 22\necho zip > "$out"')
      box.stub('shasum', `echo "${sum}  $3"`)
      box.stub('extract-zip', '[ -n "$UNZIP_FAIL" ] && exit 1\nmkdir -p "$2/chrome-headless-shell-mac-arm64" && printf "#!/bin/sh\\n" > "$2/chrome-headless-shell-mac-arm64/chrome-headless-shell" && /bin/chmod +x "$2/chrome-headless-shell-mac-arm64/chrome-headless-shell"',
        join(install, 'toolchain', 'node_modules', '.bin'))
    },
  }
  return box
}

/** A machine with everything: node 22, the installed toolchain, the pane, Chrome. */
function healthy(t) {
  const box = sandbox(t)
  box.stub('node', NODE)
  mkdirSync(join(box.install, 'toolchain/node_modules/@marp-team/marp-core'), { recursive: true })
  chmodSync(box.file('toolchain/node_modules/.bin/marp'), 0o755)
  for (const f of ['toolchain/viewer.mjs', 'toolchain/viewer/index.html', 'toolchain/viewer/app.js']) box.file(f)
  mkdirSync(join(box.apps, 'Google Chrome.app'))
  return box
}

const OK = [
  'ok   node 22.11.0',
  'ok   marp-core 4.1.0',
  'ok   marp-cli (PDF, PPTX and HTML export)',
  'ok   viewer pane (slide, grid, presenter, present)',
  'ok   browser for PDF/PPTX export: Google Chrome.app',
]

test('doctor: a machine with everything is ready', (t) => {
  const r = healthy(t).run('doctor.sh')
  assert.deepEqual(r.lines, OK)
  assert.equal(r.code, 0)
})

test('doctor: without node on PATH, Harness\'s own serves', (t) => {
  const box = healthy(t)
  rmSync(join(box.bin, 'node'))
  box.harnessNode()
  assert.deepEqual(box.run('doctor.sh').lines, OK)
})

test('doctor: node missing, or older than 18 with no Harness Node to fall back on', (t) => {
  const box = healthy(t)
  let r = box.run('doctor.sh', { env: { NODE_OLD: '1' } })
  assert.deepEqual([r.code, r.lines[0]], [1, box.noNode()])
  rmSync(join(box.bin, 'node'))
  r = box.run('doctor.sh')
  assert.deepEqual(r.lines.slice(0, 2), [box.noNode(), 'ok   marp-core present'], 'the version needs node; the install is still there')
  assert.equal(r.code, 1)
})

test('doctor: no toolchain is a miss, no marp-cli only a warning, an incomplete pane a miss', (t) => {
  const box = healthy(t)
  rmSync(join(box.install, 'toolchain/node_modules/.bin/marp'))
  let r = box.run('doctor.sh')
  assert.equal(r.lines[2], 'warn marp-cli missing — decks show live but do not export')
  assert.equal(r.code, 0)
  rmSync(join(box.install, 'toolchain/node_modules'), { recursive: true })
  r = box.run('doctor.sh')
  assert.equal(r.lines[1], 'miss marp toolchain not installed — run toolchain/setup.sh')
  assert.equal(r.code, 1)
  for (const f of ['toolchain/viewer/app.js', 'toolchain/viewer/index.html', 'toolchain/viewer.mjs']) {
    const box2 = healthy(t)
    rmSync(join(box2.install, f))
    const r2 = box2.run('doctor.sh')
    assert.equal(r2.lines[3], 'miss toolchain/viewer/ is incomplete — reinstall the harness', f)
    assert.equal(r2.code, 1)
  }
})

test('doctor: each browser marp-cli can export with, or a warning when there is none', (t) => {
  for (const app of ['Chromium.app', 'Microsoft Edge.app', 'Brave Browser.app']) {
    const box = healthy(t)
    rmSync(join(box.apps, 'Google Chrome.app'), { recursive: true })
    mkdirSync(join(box.apps, app))
    assert.equal(box.run('doctor.sh').lines[4], `ok   browser for PDF/PPTX export: ${app}`)
  }
  const box = healthy(t)
  rmSync(join(box.apps, 'Google Chrome.app'), { recursive: true })
  let r = box.run('doctor.sh')
  assert.equal(r.lines[4], 'warn no Chrome/Chromium/Edge — HTML export only until toolchain/setup.sh fetches a headless one')
  assert.equal(r.code, 0, 'a warning is not a miss')
  box.stub('google-chrome-stable')
  assert.equal(box.run('doctor.sh').lines[4], 'ok   browser for PDF/PPTX export: google-chrome-stable')
  box.stub('chromium-browser')
  assert.equal(box.run('doctor.sh').lines[4], 'ok   browser for PDF/PPTX export: chromium-browser')
  box.stub('chromium')
  assert.equal(box.run('doctor.sh').lines[4], 'ok   browser for PDF/PPTX export: chromium')
})

test('doctor: the headless shell setup.sh fetched counts, at the pinned version only', (t) => {
  const box = healthy(t)
  rmSync(join(box.apps, 'Google Chrome.app'), { recursive: true })
  box.headlessShell('120.0.0.0')
  assert.equal(box.run('doctor.sh').lines[4], 'warn no Chrome/Chromium/Edge — HTML export only until toolchain/setup.sh fetches a headless one')
  box.headlessShell()
  assert.equal(box.run('doctor.sh').lines[4], 'ok   browser for PDF/PPTX export: chrome-headless-shell')
  rmSync(join(box.install, 'toolchain', 'browser', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
  assert.equal(box.run('doctor.sh').lines[4], 'warn no Chrome/Chromium/Edge — HTML export only until toolchain/setup.sh fetches a headless one')
})

test('setup: npm ci from the lockfile, npm install without one, and the version it got', (t) => {
  const box = sandbox(t)
  box.stub('node', 'echo 4.1.0')
  box.stub('npm')
  box.file('toolchain/package-lock.json', '{}')
  mkdirSync(join(box.apps, 'Google Chrome.app'))
  let r = box.run('setup.sh')
  assert.deepEqual([r.code, r.lines], [0, ['ok   marp toolchain 4.1.0', 'ok   browser for PDF/PPTX export: Google Chrome.app']])
  rmSync(join(box.install, 'toolchain/package-lock.json'))
  r = box.run('setup.sh')
  assert.equal(r.code, 0)
  assert.deepEqual(box.logged().filter((c) => c.startsWith('npm')), ['npm ci --no-audit --no-fund --no-update-notifier --loglevel=error', 'npm install --no-audit --no-fund --no-update-notifier --loglevel=error'])
})

test('setup: without node on PATH, npm runs on Harness\'s own Node', (t) => {
  const box = sandbox(t)
  box.harnessNode()
  box.stub('npm', 'echo "npm sees $(command -v node)" >> "$CALLS"')
  box.file('toolchain/package-lock.json', '{}')
  box.stub('chromium')
  const r = box.run('setup.sh')
  assert.deepEqual([r.code, r.lines], [0, ['ok   marp toolchain 4.1.0', 'ok   browser for PDF/PPTX export: chromium']])
  assert.ok(box.logged().includes(`npm sees ${join(box.root, 'harness-node', 'node')}`))
})

test('setup: a machine with no browser gets Chrome\'s headless shell, once', (t) => {
  const box = sandbox(t)
  box.stub('node', 'echo 4.1.0')
  box.stub('npm')
  box.shellDownload()
  mkdirSync(join(box.install, 'toolchain', 'browser.partial', 'from-a-killed-run'), { recursive: true })
  let r = box.run('setup.sh')
  assert.deepEqual([r.code, r.lines], [0, [
    'ok   marp toolchain 4.1.0',
    `     no Chrome/Chromium/Edge here: fetching Chrome's headless shell ${SHELL_VERSION} for PDF and PPTX (~100 MB)`,
    `ok   browser for PDF/PPTX export: chrome-headless-shell ${SHELL_VERSION}`,
  ]], r.stderr)
  const browser = join(box.install, 'toolchain', 'browser')
  assert.equal(readFileSync(join(browser, '.version'), 'utf8'), `${SHELL_VERSION}\n`)
  assert.ok(existsSync(join(browser, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')))
  assert.ok(!existsSync(join(browser, 'shell.zip')) && !existsSync(join(box.install, 'toolchain', 'browser.partial')))
  assert.ok(box.logged().includes(`curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 -o browser.partial/shell.zip ${shellUrl('mac-arm64')}`))
  assert.ok(box.logged().includes(`extract-zip browser.partial/shell.zip ${box.install}/toolchain/browser.partial`))
  r = box.run('setup.sh')
  assert.deepEqual(r.lines, ['ok   marp toolchain 4.1.0', 'ok   browser for PDF/PPTX export: chrome-headless-shell'])
  assert.equal(box.logged().filter((c) => c.startsWith('curl')).length, 1, 'the second run keeps it')
  writeFileSync(join(browser, '.version'), '120.0.0.0\n')
  r = box.run('setup.sh')
  assert.equal(r.lines[2], `ok   browser for PDF/PPTX export: chrome-headless-shell ${SHELL_VERSION}`, 'one for another version is fetched again')
})

test('setup: each platform Chrome builds a headless shell for, and the ones it does not', (t) => {
  for (const [s, m, platform] of [['Darwin', 'x86_64', 'mac-x64'], ['Linux', 'x86_64', 'linux64']]) {
    const box = sandbox(t)
    box.stub('node', 'echo 4.1.0')
    box.stub('npm')
    box.shellDownload({ uname: `case "$1" in -s) echo ${s} ;; -m) echo ${m} ;; esac`, sum: SHELL_SUMS[platform] })
    const r = box.run('setup.sh')
    assert.equal(r.lines[2], `ok   browser for PDF/PPTX export: chrome-headless-shell ${SHELL_VERSION}`, platform)
    assert.ok(box.logged().some((c) => c.endsWith(shellUrl(platform))), platform)
  }
  const box = sandbox(t)
  box.stub('node', 'echo 4.1.0')
  box.stub('npm')
  box.shellDownload({ uname: 'case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; esac' })
  const r = box.run('setup.sh')
  assert.deepEqual([r.code, r.lines.at(-1)], [0, 'warn no Chrome/Chromium/Edge, and Chrome has no headless build for Linux aarch64 — HTML export only'])
  assert.ok(!box.logged().some((c) => c.startsWith('curl')))
})

test('setup: a headless shell that does not arrive is a warning, and leaves nothing behind', (t) => {
  const cases = [
    [{ CURL_FAIL: '1' }, {}, `warn could not download ${shellUrl('mac-arm64')} — HTML export only until toolchain/setup.sh runs again`],
    [{}, { sum: '0'.repeat(64) }, `warn ${shellUrl('mac-arm64')} did not match its pinned checksum — HTML export only`],
    [{ UNZIP_FAIL: '1' }, {}, 'warn the headless shell would not unpack — HTML export only until toolchain/setup.sh runs again'],
    [{ NO_SHASUM: '1' }, {}, `warn ${shellUrl('mac-arm64')} did not match its pinned checksum — HTML export only`],
  ]
  for (const [env, download, line] of cases) {
    const box = sandbox(t)
    box.stub('node', 'echo 4.1.0')
    box.stub('npm')
    box.shellDownload(download)
    if (env.NO_SHASUM) { // no shasum on this machine: coreutils' sha256sum answers instead
      rmSync(join(box.bin, 'shasum'))
      box.stub('sha256sum', 'echo "1111  $1"')
    }
    const r = box.run('setup.sh', { env })
    assert.deepEqual([r.code, r.lines.at(-1)], [0, line])
    assert.ok(!existsSync(join(box.install, 'toolchain', 'browser.partial')) && !existsSync(join(box.install, 'toolchain', 'browser')))
  }
})

test('setup: no node is a miss, and a failed install fails setup', (t) => {
  const box = sandbox(t)
  let r = box.run('setup.sh')
  assert.deepEqual([r.code, r.lines], [1, [box.noNode()]])
  box.stub('node', 'echo 4.1.0')
  box.stub('npm', 'exit 1')
  r = box.run('setup.sh')
  assert.notEqual(r.code, 0)
  assert.deepEqual(r.lines, [], 'no ok line after a failed npm')
})

test('init-workspace: makes the folders and seeds the verdict, even when the check fails', (t) => {
  const box = sandbox(t)
  const ws = join(box.root, 'ws')
  mkdirSync(ws)
  box.stub('node', 'case "$1" in -e) exit 0 ;; *) exit 1 ;; esac')
  const r = box.run('init-workspace.sh', { cwd: ws, env: { HARNESS_DSH_DIR: box.install } })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(existsSync(join(ws, '.harness')) && existsSync(join(ws, 'assets')))
  assert.deepEqual(box.ran(), [`node ${box.install}/toolchain/check.mjs deck.md`])
})

test('init-workspace: no node anywhere still makes the folders', (t) => {
  const box = sandbox(t)
  const ws = join(box.root, 'ws')
  mkdirSync(ws)
  const r = box.run('init-workspace.sh', { cwd: ws, env: { HARNESS_DSH_DIR: box.install } })
  assert.deepEqual([r.code, r.lines, box.logged()], [0, [], []])
  assert.ok(existsSync(join(ws, '.harness')) && existsSync(join(ws, 'assets')))
})

test('init-workspace: needs the install dir', (t) => {
  const box = sandbox(t)
  const r = box.run('init-workspace.sh', { cwd: box.root })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /HARNESS_DSH_DIR: HARNESS_DSH_DIR is required/)
})

test('viewer.sh: needs a port and a workspace, then becomes the node server', (t) => {
  const box = sandbox(t)
  box.stub('node', 'echo "server $HARNESS_VIEWER_PORT $HARNESS_WORKSPACE"')
  let r = box.run('viewer.sh', { env: { HARNESS_WORKSPACE: '/Users/example/deck' } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /HARNESS_VIEWER_PORT is required/)
  r = box.run('viewer.sh', { env: { HARNESS_VIEWER_PORT: '4100' } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /HARNESS_WORKSPACE is required/)
  r = box.run('viewer.sh', { env: { HARNESS_VIEWER_PORT: '4100', HARNESS_WORKSPACE: '/Users/example/deck' } })
  assert.deepEqual([r.code, r.lines], [0, ['server 4100 /Users/example/deck']])
  assert.deepEqual(box.ran(), [`node ${box.install}/toolchain/viewer.mjs`])
})

test('viewer.sh: no node anywhere is a miss', (t) => {
  const box = sandbox(t)
  const r = box.run('viewer.sh', { env: { HARNESS_VIEWER_PORT: '4100', HARNESS_WORKSPACE: '/Users/example/deck' } })
  assert.deepEqual([r.code, r.lines], [1, [box.noNode()]])
})

test('art and check: the .mjs beside them, on Harness\'s own Node when PATH has none, with the exit code', (t) => {
  const box = sandbox(t)
  box.harnessNode()
  const ws = join(box.root, 'ws')
  mkdirSync(ws)
  let r = box.run('art', { cwd: ws, args: ['wallpaper', '-o', 'assets/hero.svg', '--seed', '7'] })
  assert.equal(r.code, 0, r.stderr)
  r = box.run('check', { cwd: ws, args: ['talk.md'], env: { NODE_EXIT: '1' } })
  assert.equal(r.code, 1, 'a deck that is not ready exits 1 through the wrapper')
  assert.deepEqual(box.ran(), [
    `node ${box.install}/toolchain/art.mjs wallpaper -o assets/hero.svg --seed 7`,
    `node ${box.install}/toolchain/check.mjs talk.md`,
  ])
})

test('art, check and marp: no node anywhere is a miss', (t) => {
  const box = sandbox(t)
  for (const wrapper of ['art', 'check', 'marp']) {
    const r = box.run(wrapper, { args: ['deck.md'] })
    assert.deepEqual([r.code, r.lines], [1, [box.noNode()]], wrapper)
  }
  assert.deepEqual(box.logged(), [])
})

test('marp: the pinned marp-cli, with node on PATH for its own launcher, or a miss before setup', (t) => {
  const box = sandbox(t)
  box.harnessNode()
  let r = box.run('marp', { args: ['deck.md', '-o', 'dist/deck.pdf'] })
  assert.deepEqual([r.code, r.lines], [1, ['miss marp-cli — run toolchain/setup.sh']])
  box.stub('marp', 'echo "node is $(command -v node)"; exit 3', join(box.install, 'toolchain', 'node_modules', '.bin'))
  r = box.run('marp', { args: ['deck.md', '-o', 'dist/deck.pdf'] })
  assert.deepEqual([r.code, r.lines], [3, [`node is ${join(box.root, 'harness-node', 'node')}`]])
  assert.deepEqual(box.ran(), ['marp deck.md -o dist/deck.pdf'])
})

test('marp: renders through the headless shell only when the machine has no browser of its own', (t) => {
  const box = sandbox(t)
  box.stub('node', NODE)
  box.stub('marp', 'echo "CHROME_PATH=${CHROME_PATH:-}"', join(box.install, 'toolchain', 'node_modules', '.bin'))
  assert.deepEqual(box.run('marp').lines, ['CHROME_PATH='], 'no browser at all: marp-cli says so itself')
  const shell = box.headlessShell()
  assert.deepEqual(box.run('marp').lines, [`CHROME_PATH=${shell}`])
  assert.deepEqual(box.run('marp', { env: { CHROME_PATH: '/Users/example/chrome' } }).lines, ['CHROME_PATH=/Users/example/chrome'], 'one the user chose wins')
  mkdirSync(join(box.apps, 'Microsoft Edge.app'))
  assert.deepEqual(box.run('marp').lines, ['CHROME_PATH='], 'a browser of its own: marp-cli finds it')
})
