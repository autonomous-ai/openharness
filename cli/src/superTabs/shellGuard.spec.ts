import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUARD_REASONS, fileRefusal, shellRefusal, type GuardFacts } from './shellGuard.js'

/** No filesystem and no live processes: each rule is read from the words alone. */
const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  cwd: '/work/repo', platform: 'darwin',
  privateFolder: () => false, linkedWorktree: () => false, liveCwds: () => [],
  ...over,
})

const refused = (command: string, over: Partial<GuardFacts> = {}) => shellRefusal(command, facts(over))

describe('shell guard: kill by name', () => {
  it.each([
    'pkill -f node',
    'killall Finder',
    '/usr/bin/pkill harness',
    'kill $(pgrep -f vitest)',
    'kill -9 `pidof node`',
    'pgrep -f "next dev" | xargs kill',
    'ps aux | grep node | awk \'{print $2}\' | xargs kill -9',
    'lsof -ti :3000 | xargs kill',
    'for p in $(pgrep node); do kill $p; done',
    'fuser -k 3000/tcp',
    'bash -lc "pkill -f tsx"',
    'sh -c \'killall node\'',
    'true && env FOO=1 pkill node',
    'taskkill /IM node.exe /F',
    'Stop-Process -Name node',
    'Get-Process node | Stop-Process',
  ])('refuses %s', (command) => {
    expect(refused(command)).toBe(GUARD_REASONS.killByName)
  })

  it.each([
    'kill 12345',
    'kill -TERM 4242',
    'kill "$SERVER_PID"',
    'kill $(cat "$T/server.pid")',
    'ps -p 4242 >/dev/null && kill 4242',
    'taskkill /PID 4242 /F',
    'Stop-Process -Id 4242',
    'pgrep -fl vitest',
    'ps aux | grep node',
    'git log --grep=pkill',
    'echo "never use pkill"',
    'grep -rn killall src',
  ])('lets %s through', (command) => {
    expect(refused(command)).toBeNull()
  })
})

describe('shell guard: kill -1, every process the account can reach', () => {
  it.each([
    'kill -1',
    'kill -4242',
    'kill -- -4242',
    'kill -TERM -4242',
    'kill -s TERM -4242',
    'kill -n 9 -4242',
    'kill -- 0',
    'kill -9 -1',
    'kill -- -1',
    'kill -KILL -1',
    'kill -s TERM -1',
    '/bin/kill -1 -1',
    'kill 4242 -1',
    'kill -1',
    '/bin/kill -9 -1 ; true',
  ])('refuses %s', (command) => {
    expect(refused(command)).toBe(GUARD_REASONS.killAll)
  })

  it.each([
    'kill -1 4242',
    'kill -l',
  ])('lets %s through', (command) => {
    expect(refused(command)).toBeNull()
  })
})

describe('shell guard: sudo and system-wide installs', () => {
  it.each([
    'sudo rm -rf /opt/thing',
    'sudo -u other whoami',
    'doas pkg_add vim',
    'su -c "make install"',
    'npm install -g typescript',
    'npm i --global pnpm',
    'npm install --location=global tsx',
    'pnpm add -g turbo',
    'yarn global add serve',
    'bun add -g vercel',
    'brew install jq',
    'brew upgrade',
    'apt-get install -y ripgrep',
    'apt install jq',
    'dnf install gcc',
    'port install wget',
    'pacman -S ripgrep',
    'pacman -Syu',
    'pacman -Rns ripgrep',
    'pip install --break-system-packages requests',
    'python3 -m pip install --break-system-packages rich',
    'installer -pkg Thing.pkg -target /',
    'softwareupdate -i -a',
    'winget install Git.Git',
    'choco install nodejs',
    'msiexec /i thing.msi',
    'osascript -e \'do shell script "id" with administrator privileges\'',
    'Start-Process pwsh -Verb RunAs',
    'cd cli && sudo npm ci',
  ])('refuses %s', (command) => {
    expect(refused(command)).toBe(GUARD_REASONS.systemWide)
  })

  it.each([
    'npm ci',
    'npm install --save-dev vitest',
    'npm i lodash',
    'npx tsc --noEmit',
    'pnpm install',
    'brew list',
    'brew --prefix',
    'pacman -Qq',
    'pacman --query ripgrep',
    'pip install -r requirements.txt',
    'python3 -m venv .venv && .venv/bin/pip install rich',
    'cargo install ripgrep --root "$T/tools"',
    'git commit -m "no sudo here"',
    'grep -rn sudo docs',
  ])('lets %s through', (command) => {
    expect(refused(command)).toBeNull()
  })
})

describe('shell guard: heredocs', () => {
  it.each([
    "cat > notes.md <<'EOF'\nnever run sudo or pkill here\nEOF",
    'gh pr comment 1 --body-file - <<EOF\nuse sudo apt install x, then killall Finder\nEOF',
  ])('reads a heredoc body as text, not commands: %j', (command) => {
    expect(refused(command)).toBeNull()
  })

  it('still reads the command a heredoc feeds', () => {
    expect(refused('cat <<EOF | sudo tee /etc/x\nhi\nEOF')).toBe(GUARD_REASONS.systemWide)
    expect(refused('cat <<-EOF > /tmp/x\n\tbody\n\tEOF')).toBe(GUARD_REASONS.fixedTmp)
  })
})

describe('shell guard: temporary paths in simple variables', () => {
  it.each([
    'OUT=/tmp; echo hi > "$OUT/shared.txt"',
    'OUT=/tmp; cat ${OUT}/shared.txt',
    'OUT=/private; OUT="$OUT/tmp"; touch "$OUT/shared.txt"',
    'OUT=/tmp; NEXT=$OUT; curl -o "$NEXT/shared.txt" https://example.com',
    'export OUT=/tmp; tee "$OUT/shared.txt"',
    "bash -c 'OUT=/tmp; echo hi > \"$OUT/shared.txt\"'",
  ])('refuses %s', command => {
    expect(refused(command)).toBe(GUARD_REASONS.fixedTmp)
  })

  it.each([
    'OUT=/work; echo hi > "$OUT/shared.txt"',
    'OUT=/tmp; OUT=/work; echo hi > "$OUT/shared.txt"',
    "OUT=/tmp; echo '$OUT/shared.txt'",
    "OUT=/tmp; echo \\$OUT/shared.txt",
    'OUT=$(mktemp -d); echo hi > "$OUT/shared.txt"',
  ])('allows %s', command => {
    expect(refused(command)).toBeNull()
  })
})

describe('shell guard: fixed names in /tmp', () => {
  it.each([
    'echo hi > /tmp/out.txt',
    'cat build.log >>/tmp/build.log',
    'curl -o /tmp/thing.tgz https://example.com/thing.tgz',
    'curl --output=/tmp/thing.tgz https://example.com',
    'node script.js | tee /private/tmp/log.txt',
    'mkdir -p /tmp/work && cp a /tmp/work/',
    'touch /var/tmp/marker',
    'harness super-tab instructions > /tmp/instr_wren.txt 2>&1',
    'cd /tmp && echo x > y',
    'bash -c "echo x > /tmp/y"',
    'export OUT=/tmp/out.json',
    'sh /tmp/planted.sh',
  ])('refuses %s', (command) => {
    expect(refused(command)).toBe(GUARD_REASONS.fixedTmp)
  })

  it.each([
    'T=$(mktemp -d "${TMPDIR:-/tmp}/wren.XXXXXX")',
    'mktemp -d /tmp/build.XXXXXX',
    'mktemp -p /tmp',
    'echo x > "$TMPDIR/wren.abc/out.txt"',
    'ls /tmp',
    'curl https://example.com/tmp/file',
    'git log -- src/tmp/x.ts',
    'echo "/tmpfoo"',
  ])('lets %s through', (command) => {
    expect(refused(command)).toBeNull()
  })

  it('lets through a path inside a folder only this account can open (made by mktemp -d)', () => {
    const own = (path: string) => path === '/tmp/wren.AbC123'
    expect(refused('echo x > /tmp/wren.AbC123/out.txt', { privateFolder: own })).toBeNull()
    expect(refused('echo x > /tmp/other/out.txt', { privateFolder: own })).toBe(GUARD_REASONS.fixedTmp)
  })

  it('takes Claude Code\'s own folder (mode 700, this account\'s) as private, and another account\'s as not', () => {
    const own = (path: string) => path === '/private/tmp/claude-600' || path === '/tmp/claude-600'
    expect(refused('cat /private/tmp/claude-600/project/tasks/abc.output', { privateFolder: own })).toBeNull()
    expect(refused('tail -5 /tmp/claude-600/x/y.output', { privateFolder: own })).toBeNull()
    expect(refused('cat /private/tmp/claude-501/x/scratchpad/notes.md', { privateFolder: own })).toBe(GUARD_REASONS.fixedTmp)
  })

  it('checks relative redirections against the command cwd', () => {
    expect(refused('echo hi > shared.txt', { cwd: '/tmp' })).toBe(GUARD_REASONS.fixedTmp)
    expect(refused('echo hi > shared.txt')).toBeNull()
    expect(refused('echo hi', { cwd: '/tmp' })).toBeNull()
  })

  it('does not treat an escape from a private temporary folder as private', () => {
    const own = (path: string) => path === '/tmp/private'
    expect(refused('echo hi > /tmp/private/../shared.txt', { privateFolder: own })).toBe(GUARD_REASONS.fixedTmp)
    expect(refused('echo hi > ../shared.txt', { cwd: '/tmp/private', privateFolder: own })).toBe(GUARD_REASONS.fixedTmp)
    expect(refused('echo hi > inside.txt', { cwd: '/tmp/private', privateFolder: own })).toBeNull()
  })

  it('checks relative file-tool paths before allowing a fixed temporary name', () => {
    expect(fileRefusal('shared.txt', facts({ cwd: '/tmp' }))).toBe(GUARD_REASONS.fixedTmp)
    expect(fileRefusal('../shared.txt', facts({ cwd: '/tmp/private', privateFolder: path => path === '/tmp/private' })))
      .toBe(GUARD_REASONS.fixedTmp)
    expect(fileRefusal('notes.md', facts())).toBeNull()
  })
})

describe('shell guard: removing a worktree a live process uses', () => {
  const worktree = '/work/trees/bold-pine'
  const linked = (path: string) => path === worktree

  it.each([
    `git worktree remove ${worktree}`,
    `git worktree remove --force ${worktree}`,
    `git -C /work/repo worktree remove -f ${worktree}`,
    `rm -rf ${worktree}`,
    `rm -r -f ${worktree}/`,
    'git worktree remove ../trees/bold-pine',
  ])('refuses %s while a process works in it', (command) => {
    const liveCwds = () => [{ pid: 4242, cwd: `${worktree}/cli` }]
    expect(refused(command, { linkedWorktree: linked, liveCwds, cwd: '/work/repo' })).toBe(GUARD_REASONS.liveWorktree(worktree, 4242))
  })

  it('lets a worktree nobody works in go', () => {
    const liveCwds = () => [{ pid: 1, cwd: '/' }, { pid: 7, cwd: '/work/trees/bold-pine-2' }]
    expect(refused(`git worktree remove ${worktree}`, { linkedWorktree: linked, liveCwds })).toBeNull()
    expect(refused(`rm -rf ${worktree}`, { linkedWorktree: linked, liveCwds })).toBeNull()
  })

  it('does not check folders that are not worktrees', () => {
    const liveCwds = () => [{ pid: 4242, cwd: '/work/repo/node_modules/x' }]
    expect(refused('rm -rf node_modules', { liveCwds, cwd: '/work/repo' })).toBeNull()
  })

  // Rowan's security review (11-06): naming the worktree's parent, a glob over the worktrees or a ~/ path removed it too.
  describe('through a folder that holds it', () => {
    const live = () => [{ pid: 4242, cwd: `${worktree}/cli` }]
    const holding = { linkedWorktree: linked, liveCwds: live, home: '/work', cwd: '/work/repo',
      entries: (path: string) => (path === '/work/trees' ? ['bold-pine', 'other'] : path === '/work' ? ['trees', 'repo'] : []) }

    it.each([
      ['rm -rf /work/trees', '/work/trees'],
      ['rm -rf ../trees', '/work/trees'],
      ['rm -rf ~/trees', '/work/trees'],
      ['rm -rf /work/trees/*', worktree],
      ['rm -rf /work/trees/bold-*', worktree],
      ['cd /work && rm -rf tr*', '/work/trees'],
    ])('refuses %s', (command, target) => {
      expect(refused(command, holding)).toBe(GUARD_REASONS.liveWorktree(target, 4242))
    })

    it('lets the folder go when nobody works in the worktree it holds', () => {
      expect(refused('rm -rf /work/trees', { ...holding, liveCwds: () => [{ pid: 7, cwd: '/work/repo' }] })).toBeNull()
    })

    it('reads no live processes for a folder holding no worktree', () => {
      const liveCwds = () => { throw new Error('read live processes') }
      expect(refused('rm -rf build dist/*', { ...holding, liveCwds })).toBeNull()
    })
  })

  it('refuses when it cannot tell which processes are live', () => {
    expect(refused(`git worktree remove ${worktree}`, { linkedWorktree: linked, liveCwds: () => null }))
      .toBe(GUARD_REASONS.worktreeUnknown(worktree))
  })
})

describe('shell guard: ordinary work', () => {
  it.each([
    'git status --short',
    'cd cli && npx vitest run src/superTabs/shellGuard.spec.ts',
    'harness super-tab --tab abc mine',
    'gh pr view 12 --json title',
    'make check-ui-style',
    'flutter test test/super_tab_discovery_test.dart',
    'git worktree list',
    'rm -f build/out.js',
    '',
  ])('lets %s through', (command) => {
    expect(refused(command)).toBeNull()
  })
})

describe('shell guard: real folders', () => {
  const made: string[] = []
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('reads a mktemp -d folder as private and a shared one as not', async () => {
    const { privateFolderOf, linkedWorktreeOf } = await import('./shellGuard.js')
    const own = mkdtempSync(join(tmpdir(), 'guard-'))
    made.push(own)
    expect(privateFolderOf(own)).toBe(true)
    chmodSync(own, 0o755)
    expect(privateFolderOf(own)).toBe(false)
    const tree = join(own, 'tree')
    mkdirSync(tree)
    expect(linkedWorktreeOf(tree)).toBe(false)
    writeFileSync(join(tree, '.git'), 'gitdir: /work/repo/.git/worktrees/tree\n')
    expect(linkedWorktreeOf(tree)).toBe(true)
  })
})
