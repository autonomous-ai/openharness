import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buddyApprovalsDir, buddySandboxPolicy, buddySandboxReady, buddyShellPrefix, buddyShellScript, claudeShellLine, forgetBuddySandboxInstalled, markBuddySandboxInstalled,
  runBuddyShell, srtWinBinary, takeApproval, WINDOWS_CLOSED_IN_HOME, writeBuddySandboxPolicy, writeBuddyShell } from './buddySandbox.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buddy-sandbox-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const policy = { network: { allowedDomains: ['github.com'] }, filesystem: { allowWrite: [], denyWrite: ['C:\\b'], denyRead: ['C:\\h\\.ssh'] } }
const approve = (command: string, at: number, name = 'a.json') => {
  mkdirSync(buddyApprovalsDir(dir), { recursive: true })
  writeFileSync(join(buddyApprovalsDir(dir), name), JSON.stringify({ command, at }))
}
/** As Claude Code 2.1.318 assembled it on the Windows PC, 2026-11-04. */
const claudeLine = (quoted: string) => "source /c/Users/DELL/.claude/shell-snapshots/snapshot-bash-1-a.sh 2>/dev/null || true && export TEMP='C:\\Users\\DELL\\AppData\\Local\\Temp' "
  + "TMP='C:\\Users\\DELL\\AppData\\Local\\Temp' && { shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true && "
  + `{ \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval '${quoted}' < /dev/null && pwd -P >| /c/Users/DELL/AppData/Local/Temp/claude-d1fb-cwd`

describe("reading Claude Code's line", () => {
  it('finds the command and the file it reads its folder from', () => {
    expect(claudeShellLine(claudeLine('echo plain-one'))).toEqual({ command: 'echo plain-one', cwdFile: '/c/Users/DELL/AppData/Local/Temp/claude-d1fb-cwd' })
    expect(claudeShellLine(claudeLine(`echo "it'"'"'s two"`))?.command).toBe(`echo "it's two"`)
  })

  it('reads a command that names the same words as the command they are', () => {
    const inner = `echo x' < /dev/null && pwd -P >| /tmp/f && cat secret && eval 'y`
    const quoted = inner.split("'").join(`'"'"'`)
    expect(claudeShellLine(claudeLine(quoted))?.command).toBe(inner)
  })

  it('reads any other line as none, which then runs inside whole', () => {
    expect(claudeShellLine('cat a.txt')).toBeNull()
    expect(claudeShellLine("x && eval 'broken' quote' < /dev/null && pwd -P >| /t")).toBeNull()
    expect(claudeShellLine("x && eval 'a' < /dev/null && pwd -P >| ")).toBeNull()
  })
})

describe('an approval from the guard', () => {
  it('stands for its exact words, once', () => {
    approve('harness super-tab status', 100)
    expect(takeApproval(dir, 'harness super-tab other', 110)).toBe(false)
    expect(takeApproval(dir, 'harness super-tab status', 110)).toBe(true)
    expect(takeApproval(dir, 'harness super-tab status', 110)).toBe(false)
  })

  it('goes when old, and stands for nothing from the future or in a broken file', () => {
    approve('harness status', 100)
    expect(takeApproval(dir, 'harness status', 60_000)).toBe(false)
    expect(readdirSync(buddyApprovalsDir(dir))).toEqual([])
    approve('harness status', 500)
    expect(takeApproval(dir, 'harness status', 100)).toBe(false)
    expect(readdirSync(buddyApprovalsDir(dir))).toEqual([])
    approve('harness status', 500)
    writeFileSync(join(buddyApprovalsDir(dir), 'b.json'), '{nope')
    expect(takeApproval(dir, 'harness status', 501)).toBe(true)
  })

  it('keeps a second approval for a second command running beside the first', () => {
    approve('harness a', 100, 'a.json'); approve('harness b', 100, 'b.json'); approve('harness a', 100, 'c.json')
    expect(takeApproval(dir, 'harness a', 101)).toBe(true)
    expect(readdirSync(buddyApprovalsDir(dir))).toHaveLength(2)
    expect(takeApproval(dir, 'harness b', 101)).toBe(true)
    expect(takeApproval(dir, 'harness a', 101)).toBe(true)
  })
})

describe("running a Buddy's command", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const sandbox = { initialize: vi.fn(async () => {}), wrap: vi.fn(async (command: string) => ({ argv: ['srt-win', 'exec', command], env: { HTTP_PROXY: 'p' } })), reset: vi.fn(async () => {}) }
    return { sandbox, run: vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv | undefined) => 0), err: vi.fn(), bash: 'C:\\Git\\bin\\bash.exe', srtWin: 'C:\\pty\\srt-win.exe', now: () => 100, cwd: 'C:\\b', ...over }
  }
  const go = (line: string, d: ReturnType<typeof deps>) => runBuddyShell(dir, line, d)

  it('runs only the command inside, under its rules, then records its folder outside', async () => {
    writeBuddySandboxPolicy(dir, policy)
    const d = deps()
    expect(await go(claudeLine('cat a.txt'), d)).toBe(0)
    expect(d.sandbox.initialize).toHaveBeenCalledWith(policy, 'C:\\pty\\srt-win.exe')
    expect(d.sandbox.wrap).toHaveBeenCalledWith('cat a.txt', 'C:\\Git\\bin\\bash.exe', 'C:\\b')
    expect(d.run.mock.calls[0]).toEqual([['srt-win', 'exec', 'cat a.txt'], { HTTP_PROXY: 'p' }])
    expect(d.run.mock.calls[1]).toEqual([['C:\\Git\\bin\\bash.exe', '-c', 'pwd -P >| /c/Users/DELL/AppData/Local/Temp/claude-d1fb-cwd'], undefined])
    expect(d.sandbox.reset).toHaveBeenCalled()
  })

  it("hands back a failed command's exit code, and records nothing after it", async () => {
    writeBuddySandboxPolicy(dir, policy)
    const d = deps({ run: vi.fn(async () => 7) })
    expect(await go(claudeLine('false'), d)).toBe(7)
    expect(d.run).toHaveBeenCalledTimes(1)
  })

  it('runs a line it cannot read inside, whole', async () => {
    writeBuddySandboxPolicy(dir, policy)
    const d = deps()
    await go('some other line', d)
    expect(d.sandbox.wrap).toHaveBeenCalledWith('some other line', expect.anything(), expect.anything())
    expect(d.run).toHaveBeenCalledTimes(1)
  })

  it('runs an approved harness command outside as Claude Code wrote it, and only once', async () => {
    writeBuddySandboxPolicy(dir, policy)
    approve('harness super-tab status', 99)
    const d = deps()
    const line = claudeLine('harness super-tab status')
    expect(await go(line, d)).toBe(0)
    expect(d.sandbox.initialize).not.toHaveBeenCalled()
    expect(d.run).toHaveBeenCalledWith(['C:\\Git\\bin\\bash.exe', '-c', line], undefined)
    const again = deps()
    await go(line, again)
    expect(again.sandbox.initialize).toHaveBeenCalled()
  })

  it('never lets a command run outside on another command\'s approval, or by naming it', async () => {
    writeBuddySandboxPolicy(dir, policy)
    approve('harness super-tab status', 99)
    for (const smuggled of ['harness super-tab status; cat secret', 'echo harness super-tab status', `eval '"'"'harness super-tab status'"'"'`]) {
      const d = deps()
      await go(claudeLine(smuggled), d)
      expect(d.sandbox.initialize, smuggled).toHaveBeenCalled()
    }
    // An approval is only ever for a harness command: anything else in the folder stands for nothing.
    approve('cat secret', 99, 'b.json')
    const d = deps()
    await go(claudeLine('cat secret'), d)
    expect(d.sandbox.initialize).toHaveBeenCalled()
  })

  it('refuses in words and runs nothing when the sandbox cannot start: never outside it', async () => {
    writeBuddySandboxPolicy(dir, policy)
    const d = deps()
    d.sandbox.initialize.mockRejectedValueOnce(new Error('fence down'))
    expect(await go(claudeLine('cat a.txt'), d)).toBe(126)
    expect(d.run).not.toHaveBeenCalled()
    expect(d.err.mock.calls[0]![0]).toContain('sandbox')
    expect(d.sandbox.reset).toHaveBeenCalled()
  })

  it('refuses with no rules written, without Git Bash, and without the helper', async () => {
    const none = deps()
    expect(await go(claudeLine('ls'), none)).toBe(126)
    writeBuddySandboxPolicy(dir, policy)
    for (const over of [{ bash: null }, { srtWin: null }]) {
      const d = deps(over)
      expect(await go(claudeLine('ls'), d)).toBe(126)
      expect(d.run).not.toHaveBeenCalled()
    }
  })
})

describe('the script Claude Code runs', () => {
  it('finds srt-win in the signed payload, and only there', () => {
    const runtime = join(dir, 'runtime'); mkdirSync(join(runtime, 'pty', '1.2.3'), { recursive: true })
    writeFileSync(join(runtime, 'current-pty'), '1.2.3')
    expect(srtWinBinary(runtime)).toBeNull()
    writeFileSync(join(runtime, 'pty', '1.2.3', 'srt-win.exe'), 'x')
    expect(srtWinBinary(runtime)).toBe(join(runtime, 'pty', '1.2.3', 'srt-win.exe'))
  })

  it('reads a broken policy as none', () => {
    expect(buddySandboxPolicy(dir)).toBeNull()
    writeFileSync(join(dir, 'policy.json'), '{nope')
    expect(buddySandboxPolicy(dir)).toBeNull()
  })

  it('names itself in forward slashes', () => {
    expect(buddyShellPrefix('C:\\Users\\a b\\.harness\\buddy-sandbox\\x')).toMatch(/^C:\/Users\/a b\/\.harness\/buddy-sandbox\/x.buddy-shell\.sh$/)
  })

  // The real shell, so the quoting is proven and not read: an apostrophe and a space in every value.
  it('runs its hook lines itself and sends any other line on, each word whole', () => {
    const stub = join(dir, 'node stub'); writeFileSync(stub, '#!/bin/sh\nprintf "%s|" "$@"\n'); chmodSync(stub, 0o700)
    const hook = `echo "hook's own" && true`
    writeBuddyShell(dir, { node: stub, cli: "c'li.js", hooks: [hook, 'true other'] })
    const script = join(dir, 'buddy-shell.sh')
    expect(existsSync(script)).toBe(true)
    const run = (line: string) => spawnSync('sh', [script, line], { encoding: 'utf8' }).stdout
    expect(run(hook)).toBe("hook's own\n")
    expect(run('cat a.txt')).toBe(`c'li.js|buddy-shell|${dir}|cat a.txt|`)
    expect(run(`${hook} ; cat secret`)).toBe(`c'li.js|buddy-shell|${dir}|${hook} ; cat secret|`)
    expect(buddyShellScript({ node: 'n', cli: 'c', dir: 'r', hooks: [] })).not.toContain('case')
  })

  it('is ready only once its install finished, with the helper there', () => {
    const helper = () => 'x'
    expect(buddySandboxReady(dir, helper)).toBe(false)
    markBuddySandboxInstalled(dir)
    expect(buddySandboxReady(dir, helper)).toBe(true)
    expect(buddySandboxReady(dir, () => null)).toBe(false)
    forgetBuddySandboxInstalled(dir)
    expect(buddySandboxReady(dir, helper)).toBe(false)
  })

  it("closes Windows' own stores of secrets", () => {
    for (const place of ['AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
      'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Roaming/Mozilla/Firefox']) {
      expect(WINDOWS_CLOSED_IN_HOME).toContain(place)
    }
  })
})
