// Harness's Node, as a store package's script finds it in Git Bash, from a current-node Windows wrote: `C:\…\node.exe`
// and a CRLF (cli/scripts/install.ps1, lib/selfUpdate.ts). The stand-in case runs on every host but Windows, with stubs
// for what Git Bash would answer; the real case runs in Git for Windows' bash on Windows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findGitBash } from './gitBash.js'

const RUNTIMES = fileURLToPath(new URL('../../../../store/tools/runtimes.sh', import.meta.url))

// node: `-v` prints the version; `-e SCRIPT MIN` is the at-least probe, answered in bash (store/tools/test_runtimes.py).
function nodeStub(version: string): string {
  return `#!/bin/bash
case "$1" in
  -v) echo "v${version}" ;;
  -e) IFS=. read -r a b _ <<< "$3.0"; IFS=. read -r x y _ <<< "${version}"
      if [ "$x" -gt "$a" ] || { [ "$x" -eq "$a" ] && [ "$y" -ge "$b" ]; }; then exit 0; fi; exit 1 ;;
esac
`
}

function stub(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function linkReal(bin: string, name: string): void {
  const found = ['/bin', '/usr/bin'].map((dir) => join(dir, name)).find((path) => existsSync(path))
  symlinkSync(found!, join(bin, name))
}

describe.skipIf(process.platform === 'win32')('a Windows current-node, in a stand-in Git Bash', () => {
  let root: string
  let bin: string
  let bare: string
  let home: string
  let own: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gitbash-node-')))
    // `bin` is Git Bash with cygpath; `bare` the same without it, for the fallback.
    bin = join(root, 'bin')
    bare = join(root, 'bare')
    for (const dir of [bin, bare]) {
      mkdirSync(dir)
      stub(join(dir, 'uname'), '#!/bin/bash\ncase "$1" in -s) echo MINGW64_NT-10.0-26100 ;; -m) echo x86_64 ;; esac\n')
      stub(join(dir, 'node'), nodeStub('20.0.0'))
      linkReal(dir, 'cat')
      linkReal(dir, 'tr')
    }
    // C:\Users\abcdef\… is <root>/c/Users/abcdef/… here, as /c/Users/abcdef/… is in Git Bash.
    stub(join(bin, 'cygpath'), `#!/bin/bash
p="$2"; rest="\${p:2}"; rest="\${rest//\\\\//}"
echo "${root}/$(printf %s "\${p:0:1}" | tr A-Z a-z)$rest"
`)
    home = join(root, 'c', 'Users', 'abcdef')
    own = join(home, '.harness', 'runtime', 'node-v22.12.0-win-x64')
    mkdirSync(own, { recursive: true })
    stub(join(own, 'node'), nodeStub('22.12.0'))
    writeFileSync(join(home, '.harness', 'runtime', 'current-node'), 'C:\\Users\\abcdef\\.harness\\runtime\\node-v22.12.0-win-x64\\node.exe\r\n')
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function run(script: string, path = bin, extra: Record<string, string> = {}) {
    return spawnSync('/bin/bash', ['-c', `set -euo pipefail; . "$RUNTIMES"; ${script}`], {
      env: { PATH: path, HOME: home, RUNTIMES, ...extra },
      encoding: 'utf8',
      timeout: 60_000,
    })
  }

  it("finds Harness's Node through a CRLF backslash current-node when the node on PATH is too old", () => {
    const result = run('harness_node 22; command -v node')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(join(own, 'node'))
  })

  it('asked twice, adds that folder to PATH once', () => {
    const result = run('harness_node 22 && harness_node 22 && echo "$PATH"')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(`${own}:${bin}`)
  })

  it.each([
    ['C:\\Users\\abcdef\\x\\node.exe\r', '/c/Users/abcdef/x'],
    ['c:\\Users\\abcdef\\x\\node.exe', '/c/Users/abcdef/x'],
    ['C:/Users/abcdef/x/node.exe', '/c/Users/abcdef/x'],
    ['C:\\Users\\abc def\\x\\node.exe\r', '/c/Users/abc def/x'],
    ['/home/abcdef/.harness/runtime/node-v22.12.0-linux-x64/bin/node', '/home/abcdef/.harness/runtime/node-v22.12.0-linux-x64/bin'],
  ])('with no cygpath, reads %j as the folder %s', (recorded, folder) => {
    const result = run('_harness_node_dir "$RECORDED"', bare, { RECORDED: recorded })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toBe(`${folder}\n`)
  })
})

const gitBash = process.platform === 'win32' ? findGitBash() : null

describe.runIf(gitBash !== null)('a Windows current-node, in the real Git Bash', () => {
  it("finds Harness's Node when an older node is first on PATH", () => {
    const profile = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gitbash-node-')))
    try {
      const major = process.versions.node.split('.')[0]!
      const runtime = join(profile, '.harness', 'runtime')
      const own = join(runtime, `node-v${major}-win-x64`)
      mkdirSync(own, { recursive: true })
      copyFileSync(process.execPath, join(own, 'node.exe'))
      writeFileSync(join(runtime, 'current-node'), `${join(own, 'node.exe')}\r\n`)
      const old = join(profile, 'old')
      mkdirSync(old)
      writeFileSync(join(old, 'node'), '#!/bin/bash\ncase "$1" in -v) echo v18.0.0 ;; -e) exit 1 ;; esac\n')
      // Windows keeps PATH as Path: drop every spelling so the one below is the one bash reads.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
      const result = spawnSync(gitBash!, ['-c',
        `set -euo pipefail; export ADAPTER_RUNTIME_DIR="$(cygpath -u "$RUNTIME_WIN")"; . "$(cygpath -u "$RUNTIMES_WIN")"; harness_node ${major}; command -v node`,
      ], {
        env: { ...env, PATH: `${old};${process.env.PATH ?? process.env.Path ?? ''}`, RUNTIME_WIN: runtime, RUNTIMES_WIN: RUNTIMES },
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout.trimEnd().split('\n').at(-1)).toMatch(new RegExp(`/node-v${major}-win-x64/node(\\.exe)?$`))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }, 60_000)
})
