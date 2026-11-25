// Harness's Node, as a store package's script finds it in Git Bash, from a current-node Windows wrote: `C:\…\node.exe`
// and a CRLF (cli/scripts/install.ps1, lib/selfUpdate.ts): runtimes.sh's harness_node, and the local AI packages'
// node.sh, which install alone and carry their own copy of the rule. The stand-in cases run on every host but Windows,
// with stubs for what Git Bash would answer; the real cases run in Git for Windows' bash on Windows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findGitBash } from './gitBash.js'

const RUNTIMES = fileURLToPath(new URL('../../../../store/tools/runtimes.sh', import.meta.url))
const NODE_SH = fileURLToPath(new URL('../../../../store/tools/local-ai/toolchain/node.sh', import.meta.url))

// The forms a current-node takes, and the folder each names in Git Bash with no cygpath: one table, both scripts' rule.
const CURRENT_NODE_FORMS: Array<[string, string]> = [
  ['C:\\Users\\abcdef\\x\\node.exe\r', '/c/Users/abcdef/x'],
  ['c:\\Users\\abcdef\\x\\node.exe', '/c/Users/abcdef/x'],
  ['C:/Users/abcdef/x/node.exe', '/c/Users/abcdef/x'],
  ['C:\\Users\\abc def\\x\\node.exe\r', '/c/Users/abc def/x'],
  ['/home/abcdef/.harness/runtime/node-v22.12.0-linux-x64/bin/node', '/home/abcdef/.harness/runtime/node-v22.12.0-linux-x64/bin'],
]

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

// node.sh's probe is `node -e SCRIPT`, the version check inside the script: Harness's Node passes it.
const NEW_NODE = '#!/bin/bash\ncase "$1" in -v) echo v22.12.0 ;; -e) exit 0 ;; esac\n'

function stub(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function linkReal(bin: string, name: string): void {
  const found = ['/bin', '/usr/bin'].map((dir) => join(dir, name)).find((path) => existsSync(path))
  symlinkSync(found!, join(bin, name))
}

interface StandIn { root: string; bin: string; bare: string; home: string; own: string }

// A throwaway Git Bash: `bin` with an old node and cygpath, `bare` the same without cygpath, for the fallback; Harness's
// Node as `ownName` in the runtime folder, and the current-node Windows wrote for it.
function standIn(ownName: string, ownBody: string): StandIn {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gitbash-node-')))
  const bin = join(root, 'bin')
  const bare = join(root, 'bare')
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
  const home = join(root, 'c', 'Users', 'abcdef')
  const own = join(home, '.harness', 'runtime', 'node-v22.12.0-win-x64')
  mkdirSync(own, { recursive: true })
  stub(join(own, ownName), ownBody)
  writeFileSync(join(home, '.harness', 'runtime', 'current-node'), 'C:\\Users\\abcdef\\.harness\\runtime\\node-v22.12.0-win-x64\\node.exe\r\n')
  return { root, bin, bare, home, own }
}

function runNodeSh(script: string, path: string, env: Record<string, string>) {
  return spawnSync('/bin/sh', ['-c', script, 'sh', NODE_SH], { env: { PATH: path, ...env }, encoding: 'utf8', timeout: 60_000 })
}

describe.skipIf(process.platform === 'win32')('a Windows current-node, in a stand-in Git Bash', () => {
  let root: string
  let bin: string
  let bare: string
  let home: string
  let own: string
  const boxes: StandIn[] = []

  // A stand-in of its own, for a case whose Harness's Node is not runtimes.sh's stub.
  function box(ownName: string): StandIn {
    const made = standIn(ownName, NEW_NODE)
    boxes.push(made)
    return made
  }

  beforeAll(() => {
    ({ root, bin, bare, home, own } = standIn('node', nodeStub('22.12.0')))
  })

  afterAll(() => {
    for (const dir of [root, ...boxes.map((made) => made.root)]) rmSync(dir, { recursive: true, force: true })
  })

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

  it.each(CURRENT_NODE_FORMS)('with no cygpath, reads %j as the folder %s', (recorded, folder) => {
    const result = run('_harness_node_dir "$RECORDED"', bare, { RECORDED: recorded })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toBe(`${folder}\n`)
  })

  it("the local AI packages find Harness's Node through a CRLF backslash current-node when the node on PATH is too old", () => {
    const made = box('node')
    const result = runNodeSh('. "$1" && printf "%s" "$LOCAL_AI_NODE"', made.bin, { HOME: made.home })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toBe(join(made.own, 'node'))
  })

  it('the local AI packages take node.exe when that is the file there', () => {
    const made = box('node.exe')
    const result = runNodeSh('. "$1" && printf "%s" "$LOCAL_AI_NODE"', made.bin, { HOME: made.home })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toBe(join(made.own, 'node.exe'))
  })

  // In `bare` node.sh finds no Node (the fallback's /c/… is not this host's), so the function is asked after it returns.
  it.each(CURRENT_NODE_FORMS)('the local AI packages, with no cygpath, read %j as the folder %s', (recorded, folder) => {
    const result = runNodeSh('. "$1"; local_ai_node_dir "$RECORDED"', bare, { HOME: home, RECORDED: recorded })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toBe(`${folder}\n`)
  })
})

const gitBash = process.platform === 'win32' ? findGitBash() : null

describe.runIf(gitBash !== null)('a Windows current-node, in the real Git Bash', () => {
  const major = process.versions.node.split('.')[0]!

  // A throwaway profile: Harness's Node as node.exe, the current-node Windows wrote for it, and an older node first on
  // PATH; `script` runs in Git Bash with RUNTIME_WIN and `files` (Windows paths) in its environment.
  function inProfile(script: string, files: Record<string, string>) {
    const profile = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gitbash-node-')))
    try {
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
      return spawnSync(gitBash!, ['-c', script], {
        env: { ...env, PATH: `${old};${process.env.PATH ?? process.env.Path ?? ''}`, RUNTIME_WIN: runtime, ...files },
        encoding: 'utf8',
        timeout: 60_000,
      })
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  it("finds Harness's Node when an older node is first on PATH", () => {
    const result = inProfile(
      `set -euo pipefail; export ADAPTER_RUNTIME_DIR="$(cygpath -u "$RUNTIME_WIN")"; . "$(cygpath -u "$RUNTIMES_WIN")"; harness_node ${major}; command -v node`,
      { RUNTIMES_WIN: RUNTIMES },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout.trimEnd().split('\n').at(-1)).toMatch(new RegExp(`/node-v${major}-win-x64/node(\\.exe)?$`))
  }, 60_000)

  it("the local AI packages find Harness's Node there too", () => {
    const result = inProfile(
      'export ADAPTER_RUNTIME_DIR="$(cygpath -u "$RUNTIME_WIN")"; . "$(cygpath -u "$NODE_SH_WIN")" && "$LOCAL_AI_NODE" -v',
      { NODE_SH_WIN: NODE_SH },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout.trimEnd()).toBe(process.version)
  }, 60_000)
})
