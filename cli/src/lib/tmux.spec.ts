import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROCESS_ENGINES } from '../engines/types.js'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import {
  ambiguousAgentProcess,
  argvTokens,
  bypassPermissionActive,
  permissionModeFromArgv,
  engineProcessMatch,
  engineProcessMatchScore,
  isNoTmuxServerError,
  LOAD_BUFFER_TIMEOUT_MS,
  faithfulArgsFromCmdline,
  LSTART_MARKER_RE,
  liveProcessRows,
  parseProcessRow,
  pasteRawIntoTmux,
  quoteArgvElement,
  repairInteropRowFromCmdline,
  resumeSessionId,
  sendLiteralToTmux,
  sendToTmux,
  tmuxCaptureArgs,
  withStartTicks,
} from './tmux.js'
import { tmuxControlGate } from './tmuxControlGate.js'
import { assumeTmuxVersion, resetTmuxVersionCache } from './tmuxVersion.js'

const ownership = (cursor: string[] = [], grok: string[] = []): AgentCommandOwnershipSnapshot => ({
  cursorFileKeys: new Set(cursor),
  grokFileKeys: new Set(grok),
  conflictingFileKeys: new Set(cursor.filter((key) => grok.includes(key))),
  agentCandidates: [],
  cursorAgentCandidates: [],
  grokCandidates: [],
})

describe('telling no tmux server from a tmux that cannot be asked', () => {
  it('reads both of tmux\'s ways of saying no server is running, as measured on 3.7c', () => {
    // The socket file is there with nothing listening on it.
    expect(isNoTmuxServerError('no server running on /tmp/tmux-501/default')).toBe(true)
    // The socket file is gone: what kill-server, a tmux crash and a reboot leave.
    expect(isNoTmuxServerError('Command failed: tmux list-panes -a -F #{pane_id}\nerror connecting to /tmp/tmux-501/default (No such file or directory)\n')).toBe(true)
  })

  it('reads a translated message by the socket file it names, and any other failure as no answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-no-server-'))
    try {
      // A localized libc: the words differ, but the socket file is not there.
      expect(isNoTmuxServerError(`error connecting to ${join(dir, 'default')} (Datei oder Verzeichnis nicht gefunden)`)).toBe(true)
      // The file is there and tmux could not use it: that says nothing about the panes.
      expect(isNoTmuxServerError(`error connecting to ${dir} (Permission denied)`)).toBe(false)
      expect(isNoTmuxServerError('Command failed: tmux list-panes\nserver exited unexpectedly')).toBe(false)
      expect(isNoTmuxServerError('spawn tmux ENOENT')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tmux process primitives', () => {
  it('drops a zombie from the process table — it keeps the identity of the engine it no longer is', () => {
    // The row the remote-machine rig showed for a stopped agent's Claude, orphaned to a pid 1 that
    // never reaped: same pid, comm and start time as the saved identity, so resume thought it alive.
    const zombie = parseProcessRow('78206     1 claude          Tue Sep 22 08:23:44 2026 [claude] <defunct>')!
    const bsdZombie = parseProcessRow('78207     1 (claude)        Tue Sep 22 08:23:44 2026 <defunct>')!
    const live = parseProcessRow('3998  3992 node            Mon Sep 21 08:15:25 2026 node /home/node/.npm-global/bin/codex')!
    // Only a TRAILING marker is a corpse; an argument that mentions the word is a running process.
    const mentions = parseProcessRow('4000  3992 grep            Mon Sep 21 08:15:25 2026 grep <defunct> log.txt')!
    // Pids that do not exist here, so on Linux the /proc check cannot vouch for a live process either.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(liveProcessRows([zombie, live, bsdZombie, mentions])).toEqual([live, mentions])
    vi.restoreAllMocks()
  })


  it('adds the start ticks a clock step cannot move on Linux, and nothing elsewhere', () => {
    const live = parseProcessRow('3998  3992 node            Mon Sep 21 08:15:25 2026 node /home/node/.npm-global/bin/codex')!
    const gone = parseProcessRow('3999  3992 node            Mon Sep 21 08:15:25 2026 node codex')!
    const ticksOf = (pid: number) => pid === 3998 ? 26385008 : null
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(withStartTicks([live, gone], ticksOf)).toEqual([{ ...live, startTicks: 26385008 }, gone])
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(withStartTicks([live], ticksOf)).toEqual([live])
    vi.restoreAllMocks()
  })

  it('parses a process whose comm field contains spaces', () => {
    expect(parseProcessRow('4242 100 ⌘ Greeting Thu Jul 30 11:00:03 2026 cmd -r abcdef12-3456-7890-abcd-ef1234567890')).toEqual({
      pid: 4242,
      parentPid: 100,
      executable: '⌘ Greeting',
      startMarker: 'Thu Jul 30 11:00:03 2026',
      args: 'cmd -r abcdef12-3456-7890-abcd-ef1234567890',
    })
  })

  /**
   * Real `ps -axo pid=,ppid=,comm=,lstart=,args=` output captured on Ubuntu 24.04 (procps-ng 4.0.4),
   * not a macOS-shaped invention. Two things differ from macOS and both are load-bearing:
   *   - `comm` is a bare name, never a path (`/sbin/docker-init` reads back as `docker-init`);
   *   - `comm` is hard-capped at 15 bytes by TASK_COMM_LEN, so the binary really named
   *     `a-very-long-engine-name-binary` reads back as `a-very-long-eng`.
   * `tmux: server` also proves comm can still carry a space on Linux, which is why the parser anchors
   * on lstart rather than splitting comm as one token.
   */
  it('parses real Linux procps rows, including a 15-byte-truncated comm', () => {
    expect(parseProcessRow('    1     0 docker-init     Fri Aug 21 09:28:14 2026 /sbin/docker-init -- bash -lc')).toEqual({
      pid: 1,
      parentPid: 0,
      executable: 'docker-init',
      startMarker: 'Fri Aug 21 09:28:14 2026',
      args: '/sbin/docker-init -- bash -lc',
    })
    expect(parseProcessRow('   15     1 tmux: server    Fri Aug 21 09:28:14 2026 tmux new-session -d -s probe sleep 400')).toEqual({
      pid: 15,
      parentPid: 1,
      executable: 'tmux: server',
      startMarker: 'Fri Aug 21 09:28:14 2026',
      args: 'tmux new-session -d -s probe sleep 400',
    })
    const truncated = parseProcessRow(
      '   12     7 a-very-long-eng Fri Aug 21 09:28:14 2026 /tmp/a-very-long-engine-name-binary -e x')
    expect(truncated?.executable).toBe('a-very-long-eng')
    expect(Buffer.byteLength(truncated!.executable)).toBe(15)
  })

  /**
   * Linux procps substitutes `?` for any byte it cannot print in the current locale, and a daemon under
   * systemd/docker/ssh usually has no locale at all. Measured on Ubuntu 24.04: a Command Code pane reads
   * back as `??? <title>` in BOTH comm and args, so both halves of its marker fail and the reaper evicts
   * the live pane. processRows() now reads ps under LC_ALL=C.UTF-8 and repairs any surviving `?` row from
   * /proc, which is raw bytes. These two cases pin the before and the after.
   */
  /**
   * `lstart`'s shape belongs to LC_TIME, not to `ps`. Captured with
   * `LC_TIME=<locale> ps -axo pid=,ppid=,comm=,lstart=,args=` on macOS 15.5, one run per locale on the
   * same machine in the same second. Of sixteen locales tried only C, en_US and hu_HU parse at all; the
   * rest reorder the fields and yield ZERO rows out of ~590.
   *
   * Zero rows is the whole bug: processRows returns `[]`, not null, so "we looked and the machine is
   * empty" is indistinguishable from the truth, resolvePaneEngineProcess finds no engine under any pane,
   * and watchCreatedPane burns its full ten minutes before reporting START_TIMEOUT — "claude did not
   * expose an engine process within 10 minutes" — against a pane where claude is running and still
   * firing hooks. This is why processRows spawns ps under psEnv instead of inheriting the locale.
   */
  it('cannot parse an lstart column written by a locale that reorders it', () => {
    const rows = [
      '15160  2281 /Users/admin/.lo Tue 15 Sep 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo Di. 15 Sep. 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo mar. 15 sept. 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo \u706b  9/15 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo \u0432\u0442\u043e\u0440\u043d\u0438\u043a, 15 \u0441\u0435\u043d\u0442\u044f\u0431\u0440\u044f 2026 \u0433. 23:10:38 /Users/admin/.local/bin/claude',
    ]
    for (const row of rows) expect(parseProcessRow(row)).toBeNull()

    // The same process, same second, under the LC_TIME=C that psEnv guarantees.
    expect(parseProcessRow('15160  2281 /Users/admin/.lo Tue Sep 15 23:10:38 2026 /Users/admin/.local/bin/claude'))
      .toEqual({
        pid: 15160,
        parentPid: 2281,
        executable: '/Users/admin/.lo',
        startMarker: 'Tue Sep 15 23:10:38 2026',
        args: '/Users/admin/.local/bin/claude',
      })
  })

  /**
   * checkSessionRuntime adopts, rather than compares, any saved marker this rejects. It has to reject
   * localized stamps too: a marker recorded before psEnv landed (hu_HU parsed fine, `K szept. 15 …`) can
   * never equal the C-locale stamp read back for the same live process, and comparing them would evict a
   * live pane exactly once per session on upgrade.
   */
  it('recognises only a C-locale lstart stamp as a comparable start marker', () => {
    expect(LSTART_MARKER_RE.test('Tue Sep 15 23:10:38 2026')).toBe(true)
    expect(LSTART_MARKER_RE.test('Fri Aug 21 09:28:14 2026')).toBe(true)

    expect(LSTART_MARKER_RE.test('K szept. 15 23:10:38 2026')).toBe(false)   // hu_HU, parsed pre-fix
    expect(LSTART_MARKER_RE.test('Tue 15 Sep 23:10:38 2026')).toBe(false)    // en_AU
    expect(LSTART_MARKER_RE.test('Greeting Thu Jul 30 11:00:03 2026')).toBe(false) // pre-fix shifted comm
  })

  it('scores Command Code from the real bytes, and cannot from the mangled ones', () => {
    const mangled = parseProcessRow('  185   178 ??? harness-cli Fri Aug 21 09:34:20 2026 ??? harness-cli ubuntu probe')
    expect(engineProcessMatchScore(mangled!, 'commandcode')).toBe(0)

    const repaired = parseProcessRow('  185   178 ⌘ harness-cli Fri Aug 21 09:34:20 2026 ⌘ harness-cli ubuntu probe')
    expect(engineProcessMatchScore(repaired!, 'commandcode')).toBe(3)
  })

  it('recognises stable installed binary forms', () => {
    expect(engineProcessMatchScore({ executable: 'devin', args: 'devin' }, 'devin')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'muse-bin-0.1.0-R708.1', args: 'muse-bin-0.1.0-R708.1' }, 'muse')).toBe(3)
    expect(engineProcessMatchScore({ executable: '/Users/demo/.grok/bin/grok', args: 'grok' }, 'grok')).toBe(3)
  })

  /**
   * WSL interop: an engine resolved from a distro pane through `command -v` can be a WINDOWS binary
   * relayed by `/init` — live on Windows 11 + Ubuntu: `comm=node.exe`,
   * `args="/init \0 C:\...\node.exe \0 node.exe \0 C:\...\@openai\codex\bin\codex.js"` (node's
   * process.title rewrite duplicates the interpreter after the script path). The matcher used to see
   * `node.exe` + entrypoint `/init` and score 0, so the TUI ran fine while the launch stayed "failed"
   * and the terminal refused input. processRows() rewrites the row from /proc cmdline; the interpreter
   * regex now accepts `.exe`. These pins hold the two halves apart — an unchanged `ps args` row with
   * `/init` first must NOT be rewritten (no /proc evidence to back it), the repaired row must score.
   */
  it('scores a WSL-interop engine relayed through /init', () => {
    const psRow = parseProcessRow(
      ' 1037  1036 node.exe Thu Sep 17 08:20:11 2026 /init C:\\Program Files\\nodejs\\node.exe node.exe'
        + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js')
    // parseProcessRow alone cannot expose the engine: interpreter is `node.exe`, entrypoint `/init`.
    expect(engineProcessMatchScore(psRow!, 'codex')).toBe(0)

    // processRows() swaps in the /proc cmdline argv (leading /init dropped, duplicate node.exe
    // title-rewrite token removed, space-bearing paths double-quoted) — the same shape
    // engineProcessMatch is scored on here.
    const repairedArgs = '"C:\\Program Files\\nodejs\\node.exe"'
      + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'
    expect(engineProcessMatchScore({ executable: 'node.exe', args: repairedArgs }, 'codex')).toBe(2)
  })

  /**
   * The extraction itself, pinned host-independently (review finding P1): the
   * critical path runs INSIDE WSL/Linux — `path.basename` there would not
   * split the `C:\...` backslashes, the duplicate `node.exe` would survive as
   * the apparent entrypoint, and the row scores 0 again. Runs on any host.
   */
  it('repairInteropRowFromCmdline unwraps /init and quotes spaced Windows paths', () => {
    const fixed = repairInteropRowFromCmdline(
      [
        '/init',
        'C:\\Program Files\\nodejs\\node.exe',
        'node.exe',
        'C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js',
      ].join('\0'),
      'node.exe',
    )
    expect(fixed.executable).toBe('node.exe')
    // Backslashes inside quoted tokens are doubled (review cycle-4 P2): argvTokens() collapses
    // `\\` unconditionally, so quoting must double EVERY backslash for the round trip to be
    // token-faithful — `C:\Program Files\...` serializes as `"C:\\Program Files\\..."`.
    expect(fixed.args).toBe(
      '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\Program Files\\\\nodejs\\\\node_modules\\\\@openai\\\\codex\\\\bin\\\\codex.js"',
    )
    // The duplicate bare `node.exe` (node's process.title rewrite) is dropped:
    // `node.exe` appears once as executable inside nodejs/, and a second time
    // only as part of `node_modules` in the entrypoint path. Splitting on the
    // full `nodejs\\node.exe` token shows exactly one interpreter occurrence.
    expect((fixed.args ?? '').split('nodejs\\\\node.exe').length - 1).toBe(1)
    // And the repaired row still reaches the engine entrypoint.
    expect(
      engineProcessMatchScore(
        { executable: fixed.executable!, args: fixed.args! },
        'codex',
      ),
    ).toBe(2)
  })

  it('repairInteropRowFromCmdline leaves non-interop rows alone', () => {
    expect(repairInteropRowFromCmdline('bash\0-l\0', 'bash')).toEqual({})
    expect(repairInteropRowFromCmdline('', null)).toEqual({})
    expect(repairInteropRowFromCmdline('/init\0', 'init')).toEqual({})
  })

  /**
   * The interop repair itself, pinned host-independently because it once shipped a P1 that only
   * Linux-host tests could have caught: `path.basename` on Linux does not split `\\`, so the
   * interpreter-title dedup never fired for the real `C:\…\node.exe` argv inside WSL and the
   * entrypoint walk stopped on the bare duplicate.
   */
  describe('repairInteropRowFromCmdline', () => {
    const NUL = String.fromCharCode(0)

    const windowsArgv = '/init\0C:\\Program Files\\nodejs\\node.exe\0node.exe'
      + '\0C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'

    it('drops the interpreter-title duplicate behind a WINDOWS interpreter path', () => {
      expect(repairInteropRowFromCmdline(windowsArgv, 'node.exe')).toEqual({
        args: '"C:\\\\Program Files\\\\nodejs\\\\node.exe"'
          + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js',
        executable: 'node.exe',
      })
    })

    it('double-quotes space-bearing tokens so argvTokens() re-splits them as one', () => {
      expect(repairInteropRowFromCmdline(
        '/init\0C:\\Program Files\\nodejs\\node.exe\0C:\\Program Files\\my engine\\cli.js\0--flag',
        null,
      )).toEqual({
        // Quoted tokens carry doubled backslashes (review cycle-4 P2 round-trip rule).
        args: '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\Program Files\\\\my engine\\\\cli.js" --flag',
        executable: 'node.exe',
      })
    })

    it('prefers a real comm name over the relayed interpreter basename', () => {
      expect(repairInteropRowFromCmdline(['/init', '/home/demo/.local/bin/claude'].join(NUL), 'claude'))
        .toEqual({ args: '/home/demo/.local/bin/claude', executable: 'claude' })
      // Review cycle-3 P2: `comm` naming the RELAY (`init`/`/init`) ties the cmdline to nothing —
      // a native docker-init row can carry it too — so it never qualifies a rewrite on its own.
      expect(repairInteropRowFromCmdline(['/init', '/home/demo/.local/bin/claude'].join(NUL), '/init'))
        .toEqual({})
      expect(repairInteropRowFromCmdline(['/init', '/home/demo/.local/bin/claude'].join(NUL), 'init'))
        .toEqual({})
    })

    /**
     * Review cycle-3 P2: `comm` is 15-byte capped on Linux, so it may qualify as a TRUNCATION of
     * the relayed basename — but only a strict one: comm shorter than the basename AND a prefix of
     * it AND exactly 15 bytes. An arbitrary short prefix like `co` over `codex` establishes
     * nothing about interop and must leave the row untouched.
     */
    it('qualifies comm only as an exact name or a 15-byte truncation of the basename', () => {
      // Arbitrary prefix: not a truncation, no qualification.
      expect(repairInteropRowFromCmdline(['/init', '/usr/local/bin/codex', '--version'].join(NUL), 'co')).toEqual({})
      // Genuine 15-byte truncation (measured shape on Ubuntu 24.04) qualifies.
      expect(repairInteropRowFromCmdline(
        ['/init', '/opt/a-very-long-engine-name-binary', '--version'].join(NUL),
        'a-very-long-eng',
      )).toEqual({ args: '/opt/a-very-long-engine-name-binary --version', executable: 'a-very-long-eng' })
      // A comm SHORTER than 15 bytes that merely prefixes the basename is not evidence of
      // truncation — it could be any unrelated short name.
      expect(repairInteropRowFromCmdline(['/init', '/usr/local/bin/codex', '--version'].join(NUL), 'cod')).toEqual({})
    })

    /**
     * Review cycle-2 P2: an exact `/init` argv[0] alone must not qualify a row as a WSL-interop
     * relay. On a native Linux host `/init` is a real program (docker-init) whose cmdline can name
     * any child — rewriting it made `engineProcessMatch` report Codex (score 3) for
     * `/init\0/usr/local/bin/codex\0--version`, so a genuine Linux relay could be selected as the
     * engine instead of its child. Windows-argv evidence (drive-letter path, `.exe`) or a
     * Windows-binary comm is required before the rewrite fires.
     */
    it('leaves native Linux /init rows untouched even when they name an engine child', () => {
      const nativeInit = ['/init', '/usr/local/bin/codex', '--version'].join('\0')
      expect(repairInteropRowFromCmdline(nativeInit, 'docker-init')).toEqual({})
      expect(repairInteropRowFromCmdline(nativeInit, 'bash')).toEqual({})
      expect(repairInteropRowFromCmdline(nativeInit, null)).toEqual({})
      // WSL-interop evidence present -> the rewrite fires even for a POSIX-looking program path:
      // comm naming the relayed program's own basename ties cmdline to the process. An UNRELATED
      // comm (node.exe over a codex path) is exactly the spoof shape and stays untouched unless
      // the argv itself is Windows-shaped.
      expect(repairInteropRowFromCmdline(nativeInit, 'codex')).toEqual({
        args: '/usr/local/bin/codex --version',
        executable: 'codex',
      })
      expect(repairInteropRowFromCmdline(nativeInit, 'node.exe')).toEqual({})
      // Review cycle-4 P2: a `.exe`-shaped CHILD path must not outweigh contradictory comm
      // evidence either — a native Linux init wrapper around a `.exe`-named binary is exactly
      // this shape, and rewriting it made engineProcessMatch score 3 for the wrapper's child.
      expect(repairInteropRowFromCmdline(
        ['/init', '/usr/local/bin/opencode.exe', '--version'].join(NUL),
        'docker-init',
      )).toEqual({})
      // The same argv with NO comm (or a relay-neutral comm) still qualifies on argv shape alone.
      expect(repairInteropRowFromCmdline(
        ['/init', '/usr/local/bin/opencode.exe', '--version'].join(NUL),
        null,
      )).toEqual({ args: '/usr/local/bin/opencode.exe --version', executable: 'opencode.exe' })
      expect(repairInteropRowFromCmdline(
        ['/init', '/usr/local/bin/opencode.exe', '--version'].join(NUL),
        'init',
      )).toEqual({ args: '/usr/local/bin/opencode.exe --version', executable: 'opencode.exe' })
      expect(repairInteropRowFromCmdline(['/init', 'C:\\tools\\codex.exe', '--version'].join(NUL), null)).toEqual({
        args: 'C:\\tools\\codex.exe --version',
        executable: 'codex.exe',
      })
    })

    /**
     * Review cycle-4 P2: only the TERMINATING NUL field may be stripped. Legitimate empty
     * argv elements in the middle of the relayed command line are real boundaries
     * (`prog '' more` is three arguments, not two) and must survive the repair — which also
     * requires the serializer to emit `""` for an empty token, since an unquoted empty
     * element re-splits to ZERO tokens.
     */
    it('preserves interior empty argv elements through the round trip', () => {
      const interpreterPath = 'C:\\Program Files\\nodejs\\node.exe'
      const relayed = repairInteropRowFromCmdline(
        ['/init', interpreterPath, '', 'hello'].join(NUL),
        'node.exe',
      )
      expect(argvTokens(relayed.args!)).toEqual([interpreterPath, '', 'hello'])
      // The terminating NUL artifact is still stripped; the spaced path stays quoted (with
      // doubled backslashes per the round-trip rule) and the plain arg stays bare.
      expect(repairInteropRowFromCmdline(
        ['/init', interpreterPath, 'arg'].join(NUL) + NUL,
        'node.exe',
      ).args).toBe('"C:\\\\Program Files\\\\nodejs\\\\node.exe" arg')
    })

    /**
     * Review cycle-4 P2: the quote -> argvTokens round trip must be faithful for INTERNAL
     * doubled backslash runs too. argvTokens() collapses `\\` unconditionally inside double
     * quotes, so quote() must double EVERY backslash in a quoted token — not only runs that
     * touch a quote or the token end. A spaced UNC path came back with its runs halved.
     */
    it('round-trips internal doubled backslash runs token-faithfully', () => {
      const interpreterPath = 'C:\\\\Program Files\\\\nodejs\\\\node.exe'
      const unc = 'C:' + '\\\\' + '\\\\' + 'UNC share ' + '\\\\' + '\\\\' + ' y z'
      const relayed = repairInteropRowFromCmdline(['/init', interpreterPath, unc].join(NUL), 'node.exe')
      expect(argvTokens(relayed.args!)).toEqual([interpreterPath, unc])
      expect(bypassPermissionActive('codex', relayed.args!)).toBe(false)
    })

    /**
     * Review cycle-5 P2: the strip-ALL trailing-empty loop deleted legitimate empty FINAL
     * arguments. A cmdline read is the execve argv region — every element stored
     * NUL-terminated — so split() yields all elements plus exactly ONE artifact empty after
     * the final NUL, no matter how long the trailing NUL run is:
     * `/init\0prog\0x\0\0\0` is `prog x '' ''`, not `x` with three artifacts.
     */
    it('strips exactly one trailing artifact and keeps legitimate empty final elements', () => {
      // One terminating NUL: one artifact, nothing else lost.
      expect(repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x'].join(NUL) + NUL,
        'node.exe',
      ).args).toBe('node.exe x')
      // `/init\0node.exe\0x\0\0\0` — the kernel region of `prog x '' ''`: each element
      // carries its own terminating NUL, so the join needs the final one appended.
      const tailEmpties = repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x', '', ''].join(NUL) + NUL,
        'node.exe',
      )
      expect(argvTokens(tailEmpties.args!)).toEqual(['node.exe', 'x', '', ''])
      // A genuinely empty FINAL argument with a single terminator survives as one `""`.
      const finalEmpty = repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x', ''].join(NUL) + NUL,
        'node.exe',
      )
      expect(argvTokens(finalEmpty.args!)).toEqual(['node.exe', 'x', ''])
      // No trailing NUL at all (read stopped at buffer end): strip nothing.
      const unterminated = repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x'].join(NUL),
        'node.exe',
      )
      expect(argvTokens(unterminated.args!)).toEqual(['node.exe', 'x'])
    })
  })

  /**
   * Review cycle-8 P2: ordinary rows (no `?` mangle, no interop relay) used to keep flattened
   * `ps` text even with /proc readable, losing the boundaries of spaced arguments.
   * `repairMangledRows` now re-serializes ordinary rows through `faithfulArgsFromCmdline`;
   * rows with no /proc evidence stay flattened. Pinned through the pure pieces on every host.
   */
  describe('faithfulArgsFromCmdline', () => {
    it('serializes ordinary /proc argv with the shared quoting dialect', () => {
      expect(faithfulArgsFromCmdline('codex\0--flag')).toBe('codex --flag')
      expect(faithfulArgsFromCmdline('codex\0fix the bug')).toBe('codex "fix the bug"')
      expect(faithfulArgsFromCmdline('codex\0C:\\Program Files\\x\\y.exe'))
        .toBe('codex "C:\\\\Program Files\\\\x\\\\y.exe"')
    })

    it('strips exactly one trailing NUL artifact and refuses empty evidence', () => {
      expect(faithfulArgsFromCmdline('codex\0--flag\0')).toBe('codex --flag')
      expect(faithfulArgsFromCmdline('')).toBeNull()
    })

  })

  it.each([
    'codex --help',
    '/opt/bin/codex -h',
    'codex --version',
    'codex -V',
    'node /opt/node_modules/@openai/codex/bin/codex.js --help',
    'node --require setup.js /opt/node_modules/@openai/codex/bin/codex.js --help',
    'env CODEX_HOME=/tmp/profile codex --help',
    'ori --log-level debug codex --help',
  ])('does not adopt a capability probe as the restarted engine: %s', args => {
    const commands: AgentCommandOwnershipSnapshot = {
      ...ownership(), engineFileKeys: new Map([['codex', new Set(['codex-file'])]]),
    }
    // A known binary is still only a probe. File ownership must not override argv.
    expect(engineProcessMatchScore({ executable: 'codex', args, imageFileKey: 'codex-file' }, 'codex', commands)).toBe(0)
  })

  it.each([
    'codex resume 01234567-89ab-cdef-0123-456789abcdef',
    'codex --no-daemon resume 01234567-89ab-cdef-0123-456789abcdef',
    'codex "explain --help"',
    'codex -- "--help"',
    'codex --model --help',
  ])('keeps interactive launches and prompt text: %s', args => {
    expect(engineProcessMatchScore({ executable: 'codex', args }, 'codex')).toBeGreaterThan(0)
  })

  it.each([
    ['codex', 'codex-aarch64-apple-darwin'],
    ['codex', 'codex-x86_64-unknown-linux-musl'],
    ['kilo', 'kilo-darwin-arm64'],
    ['kilo', 'kilo-linux-x64-baseline'],
    ['grok', 'grok-1.0.5-macos-aarch64'],
    ['grok', 'grok-linux-x86_64'],
  ] as const)('recognises the %s standalone release image %s', (engine, executable) => {
    expect(engineProcessMatchScore({ executable, args: executable }, engine)).toBe(3)
  })

  it('uses installed executable identity ahead of misleading argv names', () => {
    const allFiles = new Map([['codex', new Set(['codex-native'])]]) as AgentCommandOwnershipSnapshot['engineFileKeys']
    const commands: AgentCommandOwnershipSnapshot = {
      ...ownership(),
      engineFileKeys: allFiles,
      engineCandidates: new Map(),
    }
    const row = {
      executable: 'renamed-release-image',
      args: 'renamed-release-image --some-flag',
      imagePath: '/custom/native/renamed-release-image',
      imageFileKey: 'codex-native',
    }
    expect(engineProcessMatch(row, 'codex', commands)).toEqual({
      score: 4,
      evidence: 'file-identity',
      imagePath: '/custom/native/renamed-release-image',
    })
    expect(engineProcessMatchScore(row, 'claude', commands)).toBe(0)
  })

  it.each(PROCESS_ENGINES)('recognises a renamed native %s image from installed file identity', (engine) => {
    const key = `native-${engine}`
    const commands: AgentCommandOwnershipSnapshot = {
      ...ownership(),
      engineFileKeys: new Map([[engine, new Set([key])]]),
      engineCandidates: new Map(),
    }
    expect(engineProcessMatch({
      executable: 'vendor-rewritten-title',
      args: 'vendor-rewritten-title',
      imageFileKey: key,
    }, engine, commands)).toMatchObject({ score: 4, evidence: 'file-identity' })
  })

  it('rejects Antigravity IDE binaries even when their basename is agy', () => {
    expect(engineProcessMatchScore({
      executable: '/Applications/Antigravity.app/Contents/Resources/bin/agy',
      args: '/Applications/Antigravity.app/Contents/Resources/bin/agy',
    }, 'agy')).toBe(0)
  })

  it('recognises Claude native installer version targets without accepting a bare semver', () => {
    expect(engineProcessMatchScore({
      executable: '/Users/demo/.local/share/claude/versions/2.1.246',
      args: '/Users/demo/.local/share/claude/versions/2.1.246',
    }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({
      executable: '2.1.246',
      args: '/home/demo/.local/share/claude/versions/2.1.246',
    }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({ executable: '2.1.246', args: '2.1.246' }, 'claude')).toBe(0)
  })

  it('reads Hermes out of the inline source it runs as', () => {
    // 0.21.5+2144.g7b761da, copied off `ps` on this machine. The `sh` stub in
    // `~/.hermes/hermes-agent/.hermes/bin/hermes` execs Hermes' own interpreter with the whole
    // launcher as `-c` text, so argv names no script and `comm` is a python. Nothing here carried
    // the engine's name anywhere the matcher looked, and a running Hermes read as absent: its pane
    // was retained six seconds after New Harness, then failed RESUME_UNCONFIRMED ten minutes later.
    const python = '/Users/demo/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3'
    const launcher = (entry: string) => `${python} -I -c import os, re, sys`
      + ` sys.path.insert(0, '/Users/demo/.hermes/hermes-agent')`
      + ` import hermes_bootstrap from ${entry} import main sys.exit(main())`
    // macOS prints `comm` through a 16-column field beside lstart, so every absolute path arrives
    // truncated. The interpreter has to be read from argv[0] or this row scores on a home directory.
    const comm = '/Users/demo'
    expect(engineProcessMatchScore({ executable: comm, args: launcher('hermes_cli.main') }, 'hermes')).toBe(2)
    // `hermes-acp` is the other stub in that bin, identical but for its entry module. An ACP adapter
    // is not the harness's engine, and the sys.path root alone would have claimed it.
    expect(engineProcessMatchScore({ executable: comm, args: launcher('acp_adapter.entry') }, 'hermes')).toBe(0)
    // Inline source stays unreadable as an entrypoint for everyone else: a prompt may say anything.
    expect(engineProcessMatchScore({
      executable: comm,
      args: `${python} -I -c print('x') compare hermes_cli and codex`,
    }, 'hermes')).toBe(0)
    expect(engineProcessMatchScore({
      executable: 'python3',
      args: `python3 worker.py from hermes_cli.main import main /Users/demo/.hermes/hermes-agent'`,
    }, 'hermes')).toBe(0)
    // And the shapes that already worked keep working.
    expect(engineProcessMatchScore({ executable: 'hermes', args: 'hermes --resume 20260728_115628_f2c86a' }, 'hermes')).toBe(3)
    expect(engineProcessMatchScore({ executable: comm, args: `${python} -m hermes_cli.main` }, 'hermes')).toBe(2)
  })

  it('reads Hermes out of its launcher as macOS `ps` really prints it, newlines as \\012', () => {
    // 0.21.5's launcher is a multi-line `-c` script, and macOS `ps` writes argv through vis(3): each
    // newline arrives as the four characters `\012`, a backslash as `\\`. Matching that text as Python
    // found no statement separator after `import os, re, sys`, so a running Hermes scored 0 — its pane
    // was restored as a terminal, and every hook it sent was "not a descendant of that engine process".
    const python = '/Users/demo/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3'
    const source = [
      'import os, re, sys',
      "os.environ.pop('PYTHONHOME', None)",
      "os.environ.pop('PYTHONPATH', None)",
      "sys.path.insert(0, '/Users/demo/.hermes/hermes-agent')",
      "if sys.argv[1:2] == ['--print-runtime-command']: sys.dont_write_bytecode = True",
      'from hermes_constants import get_default_hermes_root',
      "os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(get_default_hermes_root())",
      'import hermes_bootstrap',
      "sys.exit('a path with a \\\\ in it') if False else None",
      'from hermes_cli.main import main',
      'sys.exit(main())',
    ].join('\\012') + '\\012'
    expect(engineProcessMatchScore({ executable: '/Users/demo', args: `${python} -I -c ${source}` }, 'hermes')).toBe(2)
    expect(engineProcessMatchScore({ executable: '/Users/demo', args: `${python} -I -c ${source.replace('hermes_cli.main', 'acp_adapter.entry')}` }, 'hermes')).toBe(0)
  })

  it('recognizes managed Hermes runpy launchers without relying on their install directory', () => {
    const bootstrap = "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, '/opt/custom install'); os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(__import__('hermes_constants').get_default_hermes_root()); import hermes_bootstrap; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"
    const old = "import sys, runpy; sys.path.insert(0, '/opt/hermes-agent'); runpy.run_module('hermes_cli.main', run_name='__main__')"
    for (const code of [bootstrap, old]) {
      for (const source of [code, `\"${code}\"`]) {
        expect(engineProcessMatchScore({ executable: '/home/demo/.her', args: `/opt/python3.14 -I -I -c ${source} --resume 20260927_101500_ab12cd` }, 'hermes')).toBe(2)
      }
    }
    for (const args of [
      `python3 worker.py -c ${bootstrap}`,
      `node -c ${bootstrap}`,
      `python3 -c print(\"${bootstrap}\")`,
      `python3 -c ${bootstrap.replace('hermes_cli.main', 'acp_adapter.entry')}`,
      "python3 -c import sys; sys.path.insert(0, '/opt/hermes-agent'); print('from hermes_cli.main import main')",
    ]) {
      expect(engineProcessMatchScore({ executable: 'python3', args }, 'hermes')).toBe(0)
    }
  })

  it('reads an engine through the ori launcher, before and after its exec', () => {
    // `ori claude` computes an environment and then execve's the vendor binary away, so for all but the
    // first ~100ms the pane row IS `claude` — that case must keep scoring exactly as a bare launch does.
    expect(engineProcessMatchScore({ executable: 'claude', args: '/Users/demo/.local/bin/claude --resume x' }, 'claude')).toBe(3)
    // The pre-exec window (and any future ori that spawns instead of exec'ing) resolves through the flags.
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori claude' }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'ori', args: '/Users/demo/.local/bin/ori claude --model anthropic/claude-sonnet-4.6 -p hi' }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori --log-level debug codex --full-auto' }, 'codex')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori opencode' }, 'opencode')).toBe(3)
    // Wrapping does not make it a different engine, and ori's own subcommands are not engines.
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori claude' }, 'codex')).toBe(0)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori eval' }, 'claude')).toBe(0)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori login' }, 'claude')).toBe(0)
  })

  it('assigns the colliding agent basename only from executable ownership', () => {
    const cursor = ownership(['cursor-file'], ['grok-file'])
    const grok = ownership(['cursor-file'], ['grok-file'])
    const cursorRow = { executable: 'agent', args: 'agent', imageFileKey: 'cursor-file' }
    const grokRow = { executable: 'agent', args: 'agent', imageFileKey: 'grok-file' }

    expect(engineProcessMatchScore(cursorRow, 'cursor', cursor)).toBe(4)
    expect(engineProcessMatchScore(cursorRow, 'grok', cursor)).toBe(0)
    expect(engineProcessMatchScore(grokRow, 'grok', grok)).toBe(4)
    expect(engineProcessMatchScore(grokRow, 'cursor', grok)).toBe(0)
    expect(engineProcessMatchScore({ executable: 'agent', args: 'agent' }, 'cursor', cursor)).toBe(0)
    const conflict = ownership(['same-file'], ['same-file'])
    expect(engineProcessMatchScore({ executable: 'agent', args: 'agent', imageFileKey: 'same-file' }, 'cursor', conflict)).toBe(0)
    expect(engineProcessMatchScore({ executable: 'agent', args: 'agent', imageFileKey: 'same-file' }, 'grok', conflict)).toBe(0)
  })

  it('does not treat a daemon role named agent as the colliding CLI command', () => {
    expect(ambiguousAgentProcess({
      executable: '/usr/sbin/distnoted',
      args: '/usr/sbin/distnoted agent',
    }, ownership())).toBe(false)
    expect(ambiguousAgentProcess({
      executable: '/usr/sbin/cfprefsd',
      args: '/usr/sbin/cfprefsd agent',
    }, ownership())).toBe(false)
  })

  it('extracts only explicit resume ids', () => {
    expect(resumeSessionId('cursor', 'agent --resume=53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('opencode', 'opencode -s ses_05e335115ffeM05DT5hJHeN3Vp'))
      .toBe('ses_05e335115ffeM05DT5hJHeN3Vp')
    expect(resumeSessionId('hermes', 'hermes --resume 20260728_115628_f2c86a'))
      .toBe('20260728_115628_f2c86a')
    expect(resumeSessionId('kilo', 'kilo --session ses_024a007fdffe11yG68JPxsHJly'))
      .toBe('ses_024a007fdffe11yG68JPxsHJly')
    expect(resumeSessionId('pi', 'pi --session-id 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('commandcode', 'cmd --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('muse', 'muse resume 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('amp', 'amp threads continue T-019fda49-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('T-019fda49-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('grok', 'grok -r 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('commandcode', 'cmd -r Greeting')).toBeNull()
    // Devin's ids are word slugs; a bare word is not one.
    expect(resumeSessionId('devin', 'devin --resume brisk-otter')).toBe('brisk-otter')
    expect(resumeSessionId('devin', 'devin -r blue-agustinia --model x')).toBe('blue-agustinia')
    expect(resumeSessionId('devin', 'devin -r latest')).toBeNull()
    // Hermes takes -r too; opencode's --fork names the parent, never the session.
    expect(resumeSessionId('hermes', 'hermes -r 20260927_101500_ab12cd')).toBe('20260927_101500_ab12cd')
    expect(resumeSessionId('opencode', 'opencode -s ses_abc --fork')).toBeNull()
  })

  it('reads a claude/codex resume id from argv, but never the parent of a fork', () => {
    // A daemon that could not see the pane when SessionStart fired (a session named by an older build)
    // has only argv to learn the session from — measured on machine-remote-1, where six agents sat
    // sessionless for ten days and could not be forked.
    expect(resumeSessionId('claude', '/opt/agent-cli/.local/bin/claude --resume f56f0a36-aa58-4af1-a6e2-a77386122332'))
      .toBe('f56f0a36-aa58-4af1-a6e2-a77386122332')
    expect(resumeSessionId('claude', 'claude --dangerously-skip-permissions -r f4749d75-aef8-4d07-8031-48e2abecf7e5'))
      .toBe('f4749d75-aef8-4d07-8031-48e2abecf7e5')
    expect(resumeSessionId('codex', 'node /usr/local/bin/codex resume 53d3843c-724e-47ff-ae3a-9fedfa328bba --approve-for-me'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    // `--resume <parent> --fork-session` writes a NEW session: the id on argv is the parent's.
    expect(resumeSessionId('claude', 'claude --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba --fork-session')).toBeNull()
    // `codex fork <parent>` likewise names the parent, and is not a resume.
    expect(resumeSessionId('codex', 'codex fork 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
    expect(resumeSessionId('claude', 'claude --continue')).toBeNull()
  })

  it('reads the exact permission mode a live process was launched with', () => {
    expect(permissionModeFromArgv('claude', '/usr/local/bin/claude --dangerously-skip-permissions')).toBe('full')
    expect(permissionModeFromArgv('claude', 'claude --permission-mode plan --resume abc')).toBe('plan')
    expect(permissionModeFromArgv('claude', 'claude --permission-mode=acceptEdits')).toBe('acceptEdits')
    expect(permissionModeFromArgv('claude', 'claude --permission-mode auto')).toBe('auto')
    expect(permissionModeFromArgv('codex', 'codex --dangerously-bypass-approvals-and-sandbox')).toBe('full')
    expect(permissionModeFromArgv('codex', 'codex --sandbox read-only')).toBe('readOnly')
    expect(permissionModeFromArgv('codex', 'codex resume abc --approve-for-me')).toBe('auto')
    expect(permissionModeFromArgv('cursor', 'cursor-agent --force')).toBe('auto')
    expect(permissionModeFromArgv('opencode', 'opencode --auto')).toBe('auto')
    // Skip-everything outranks a mode named beside it: that process runs without permissions.
    expect(permissionModeFromArgv('claude', 'claude --permission-mode plan --dangerously-skip-permissions')).toBe('full')
  })

  it('names no mode for an argv that carries none — never `ask`, never a guess', () => {
    // No flag is silence, not a choice; `bypassPermission` keeps deciding there.
    expect(permissionModeFromArgv('claude', 'claude --resume abc')).toBeNull()
    // A mode the table does not know cannot be reapplied, so it is not recorded.
    expect(permissionModeFromArgv('claude', 'claude --permission-mode bogus')).toBeNull()
    expect(permissionModeFromArgv('claude', 'claude --permission-mode manual auto')).toBeNull()
    expect(permissionModeFromArgv('codex', 'codex --sandbox workspace-write')).toBeNull()
    // Only an exact token counts, as for the bypass flag.
    expect(permissionModeFromArgv('claude', 'claude "please avoid --dangerously-skip-permissions for now"')).toBeNull()
    expect(permissionModeFromArgv('claude', 'claude --dangerously-skip-permissions-explained')).toBeNull()
    // Engines with no mode table.
    expect(permissionModeFromArgv('pi', 'pi --dangerously-skip-permissions')).toBeNull()
    expect(permissionModeFromArgv('terminal', 'zsh -l')).toBeNull()
  })

  it('reads bypass-permission mode from a live process argv via exact token match', () => {
    expect(bypassPermissionActive('claude', '/usr/local/bin/claude --permission-mode auto')).toBe(true)
    expect(bypassPermissionActive('claude', 'claude --permission-mode=auto --resume abc')).toBe(true)
    expect(bypassPermissionActive('codex', 'codex resume abc --approve-for-me')).toBe(true)
    // Launched before the auto modes: the old flags still count as approving (and, recorded as the
    // `full` mode, come back as themselves on a relaunch).
    expect(bypassPermissionActive('claude', '/usr/local/bin/claude --dangerously-skip-permissions'))
      .toBe(true)
    expect(bypassPermissionActive('codex', 'codex --dangerously-bypass-approvals-and-sandbox'))
      .toBe(true)
    expect(bypassPermissionActive('cursor', 'cursor-agent --force')).toBe(true)
    expect(bypassPermissionActive('opencode', 'opencode --auto')).toBe(true)
  })

  /**
   * Review cycle-5 P1 (security): a bare `--` option terminator ends the option section in
   * every engine's CLI grammar — everything after it is a POSITIONAL, however flag-shaped.
   * Boundary-faithful tokenization (cycles 2-4) made a flag-shaped positional SURVIVE as a
   * token, so a relayed prompt `-- --dangerously-bypass-approvals-and-sandbox` read as an
   * active bypass flag and cli.ts persisted it for the relaunch. The flag must appear
   * BEFORE the terminator to count, for every engine with a confirmed flag.
   */
  it.each([
    ['claude', '--dangerously-skip-permissions'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['cursor', '--force'],
    ['opencode', '--auto'],
  ] as const)('does not count a flag-shaped positional after `--` for %s', (engine, flag) => {
    expect(bypassPermissionActive(engine, `engine -- ${flag}`)).toBe(false)
    expect(bypassPermissionActive(engine, `engine -- prompt about ${flag}`)).toBe(false)
    // Before the terminator it still counts.
    expect(bypassPermissionActive(engine, `engine ${flag} -- prompt`)).toBe(true)
    // No terminator at all: unchanged behavior.
    expect(bypassPermissionActive(engine, `engine ${flag}`)).toBe(true)
  })

  it('still reads flags when no `--` terminator is present', () => {
    expect(bypassPermissionActive('codex', 'codex --dangerously-bypass-approvals-and-sandbox')).toBe(true)
    expect(bypassPermissionActive('codex', 'codex --model gpt-5 --dangerously-bypass-approvals-and-sandbox')).toBe(true)
  })

  it('does not false-positive on a flag that only appears as a substring', () => {
    // The flag text can legitimately appear inside a prompt/argument; only an exact token counts.
    expect(bypassPermissionActive('claude', 'claude "please avoid --dangerously-skip-permissions for now"'))
      .toBe(false)
    expect(bypassPermissionActive('claude', 'claude --dangerously-skip-permissions-explained')).toBe(false)
  })

  /**
   * Review cycle-2 P1 (security): the WSL-interop repair re-quotes relayed argv by escaping
   * embedded double quotes as `\"`. The old argvTokens() regex split on those escapes, so ONE
   * relayed prompt argument — 'Explain " --dangerously-bypass-approvals-and-sandbox " please' —
   * re-tokenized with the flag standing alone, and bypassPermissionActive() flipped false → true.
   * cli.ts persists that state (registry.setBypassPermission) and reads it on relaunch, so prompt
   * text could enable bypass mode for the next session. argvTokens() must treat `\"` inside a
   * double-quoted token as a literal quote, exactly what quote() emits.
   */
  it('does not let an escaped quote inside a relayed prompt enable bypass mode', () => {
    const promptArg = 'Explain " --dangerously-bypass-approvals-and-sandbox " please'
    // quote()'s exact output shape for an element carrying spaces and double quotes.
    const relayedArgs = '"C:\\Program Files\\nodejs\\node.exe"'
      + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'
      + ` "${promptArg.replace(/"/g, '\\"')}"`
    expect(bypassPermissionActive('codex', relayedArgs)).toBe(false)
  })

  it('argvTokens treats \\" inside a double-quoted token as a literal quote', () => {
    expect(argvTokens('codex "say \\"hi\\" now"')).toEqual(['codex', 'say "hi" now'])
    // Unchanged behaviour for the plain cases the matcher relies on.
    expect(argvTokens('codex "hello world" --flag')).toEqual(['codex', 'hello world', '--flag'])
    expect(argvTokens("claude 'pick --dangerously-skip-permissions' x")).toEqual(
      ['claude', 'pick --dangerously-skip-permissions', 'x'])
    // A Windows path with spaces stays one token, and backslashes are not escapes outside quotes.
    expect(argvTokens('"C:\\Program Files\\nodejs\\node.exe" --version'))
      .toEqual(['C:\\Program Files\\nodejs\\node.exe', '--version'])
  })

  /**
   * Review cycle-4 P1 (security): the `?`-mangled-row branch — a localeless `ps` substitutes
   * `?` for every unprintable byte, and a PROMPT ending in `?` lands one in row.args — used to
   * NUL->space-join /proc cmdline with NO quoting and return before the interop repair ran.
   * The joined string re-tokenized with the flag standing alone and
   * bypassPermissionActive('codex', args) flipped to true from prompt text alone, and /init
   * stayed the entrypoint so relay discovery died with it. The branch must re-serialize the
   * raw argv through the same CRT-dialect quoting as the repair.
   *
   * readProcField is Linux-only (`/proc`), so the branch itself cannot run on this host — the
   * test pins the QUOTING CONTRACT through quoteArgvElement, the exact serializer the branch
   * joins with: re-splitting its output must reproduce the original argv elements verbatim.
   */
  it('does not let a ?-mangled cmdline re-split prompt text into flags (quoteArgvElement contract)', () => {
    // The cmdline argv of the repro: a prompt ending in `?` whose text names the bypass flag.
    const promptArg = 'Should I use --dangerously-bypass-approvals-and-sandbox ?'
    const cmdlineArgv = ['C:\\Program Files\\nodejs\\node.exe', 'codex.js', promptArg]
    const joined = cmdlineArgv.map(quoteArgvElement).join(' ')
    expect(argvTokens(joined)).toEqual(cmdlineArgv)
    expect(bypassPermissionActive('codex', joined)).toBe(false)
    // The old shape — the same argv NUL->space-joined bare — DID flip (documents the defect).
    const legacyJoin = cmdlineArgv.join(' ')
    expect(bypassPermissionActive('codex', legacyJoin)).toBe(true)
  })

  /**
   * Review cycle-3 P1 (security): the relayed argv round trip — quote() inside
   * repairInteropRowFromCmdline -> argvTokens() — must be token-faithful for EVERY element, or
   * prompt/argument text re-tokenizes into standalone flags and bypassPermissionActive() flips.
   * Two shapes closed the loop beyond cycle-2's escaped-double-quote repro:
   *   1. a token carrying SINGLE quotes around a flag was serialized bare-with-single-quotes;
   *      argvTokens stripped them and the flag stood alone.
   *   2. a token ending in a backslash emitted `...\"`, whose escape rule swallowed the closing
   *      quote and exposed the NEXT argument's flag text as standalone tokens.
   * Each case pins the round trip itself: repair -> re-split must return the ORIGINAL argv.
   */
  it('preserves argv boundaries through the repair quoting round trip', () => {
    const NUL = String.fromCharCode(0)
    const relayout = (elements: string[]) =>
      repairInteropRowFromCmdline(['/init', ...elements].join(NUL), 'node.exe')
    const interpreterPath = 'C:\\Program Files\\nodejs\\node.exe'

    // 1. Single-quoted flag argument: quote() double-quotes the whole element, the inner single
    //    quotes are literal content, and the flag NEVER stands alone as its own token.
    const singleQuoted = relayout([interpreterPath, "'--dangerously-bypass-approvals-and-sandbox'"])
    expect(argvTokens(singleQuoted.args!))
      .toEqual([interpreterPath, "'--dangerously-bypass-approvals-and-sandbox'"])
    expect(bypassPermissionActive('codex', singleQuoted.args!)).toBe(false)

    // 2. A prompt argument with embedded double quotes escapes as \" and round-trips exactly.
    const promptArg = 'Explain " --dangerously-bypass-approvals-and-sandbox " please'
    const relayed = relayout([interpreterPath, promptArg])
    expect(bypassPermissionActive('codex', relayed.args!)).toBe(false)
    expect(argvTokens(relayed.args!)).toEqual([interpreterPath, promptArg])

    // 3. Trailing-backslash token: backslashes double before the closing quote, so the quote
    //    survives as a boundary and no neighbouring text merges into the token.
    const backslashTail = relayout([interpreterPath, 'C:\\Dir\\', 'plain'])
    expect(argvTokens(backslashTail.args!)).toEqual([interpreterPath, 'C:\\Dir\\', 'plain'])

    // 4. The reviewer's repro shape: a space-bearing token ending in a backslash followed by a
    //    prompt whose text contains the flag — boundaries must hold so it stays prompt text.
    const repro = relayout([
      interpreterPath,
      'C:\\Dir With Space\\',
      'explain --dangerously-bypass-approvals-and-sandbox please',
    ])
    expect(bypassPermissionActive('codex', repro.args!)).toBe(false)
    expect(argvTokens(repro.args!)).toEqual([
      interpreterPath,
      'C:\\Dir With Space\\',
      'explain --dangerously-bypass-approvals-and-sandbox please',
    ])
  })

  it('reads false when the confirmed flag is absent', () => {
    expect(bypassPermissionActive('claude', 'claude --resume abc')).toBe(false)
    // Another mode, or "auto" that is not the mode's value.
    expect(bypassPermissionActive('claude', 'claude --permission-mode plan')).toBe(false)
    expect(bypassPermissionActive('codex', 'codex --sandbox read-only')).toBe(false)
    expect(bypassPermissionActive('claude', 'claude --permission-mode manual auto')).toBe(false)
    expect(bypassPermissionActive('claude', 'claude auto --permission-mode')).toBe(false)
  })

  it('always reads false for engines with no confirmed bypass flag — never guesses', () => {
    expect(bypassPermissionActive('pi', 'pi --dangerously-skip-permissions')).toBe(false)
    expect(bypassPermissionActive('hermes', 'hermes --dangerously-skip-permissions')).toBe(false)
    expect(bypassPermissionActive('devin', 'devin --dangerously-skip-permissions')).toBe(false)
  })

  /**
   * Review cycle-6 P1 (security): resumeSessionId's regex searched INSIDE quoted prompt
   * arguments, so one prompt 'Explain --session ses_OTHER now' supplied a false resume session
   * that discovery bound a relaunch to. The token form requires the flag as a STANDALONE token
   * with the id as the NEXT token, and stops at a bare `--` terminator.
   */
  it('does not read a session id out of prompt text', () => {
    // Quoted prompt argument: the flag text is inside ONE token, never a standalone flag.
    expect(resumeSessionId(
      'opencode', '"/usr/local/bin/opencode" "Explain --session ses_OTHER now"',
    )).toBeNull()
    // After the `--` option terminator everything is positional prompt text.
    expect(resumeSessionId('opencode', 'opencode -- Explain --session ses_OTHER now')).toBeNull()
    expect(resumeSessionId('cursor', 'agent -- --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
    // A real flag still binds.
    expect(resumeSessionId('opencode', 'opencode --session ses_05e335115ffeM05DT5hJHeN3Vp'))
      .toBe('ses_05e335115ffeM05DT5hJHeN3Vp')
  })

  /** Review cycle-6 P2: codex.exe/claude.exe native names scored 0 while opencode.exe scored. */
  it.each(['claude', 'codex'] as const)('recognises native Windows %s.exe basenames', (engine) => {
    expect(engineProcessMatchScore({ executable: `${engine}.exe`, args: `${engine}.exe --version` }, engine))
      .toBeGreaterThan(0)
  })

  /**
   * Review cycle-9 P2: the both-separator basename over-corrected the Windows port — `\` is a
   * legal filename character in POSIX paths, so a Linux script literally named `not\codex`
   * came out as basename `codex` and scored as a Codex match; discovery could claim an
   * unrelated process. The dialect is read from the path itself: drive-letter/UNC paths split
   * on both separators, POSIX paths on `/` only.
   */
  it('does not split a POSIX path on a backslash that is part of a filename', () => {
    expect(engineProcessMatchScore({
      executable: '/tmp/not\\codex',
      args: '/tmp/not\\codex --version',
    }, 'codex')).toBe(0)
    // The Windows dialect still splits on both separators.
    expect(engineProcessMatchScore({
      executable: 'C:\\tools\\not\\codex.exe',
      args: 'C:\\tools\\not\\codex.exe --version',
    }, 'codex')).toBeGreaterThan(0)
    expect(engineProcessMatchScore({
      executable: '\\\\nas\\share\\not\\codex.exe',
      args: '\\\\nas\\share\\not\\codex.exe --version',
    }, 'codex')).toBeGreaterThan(0)
  })

  it('maps neutral visible/history and ANSI capture options to tmux flags', () => {
    expect(tmuxCaptureArgs('%7', 60)).toEqual([
      'capture-pane', '-p', '-e', '-J', '-t', '%7', '-S', '-60',
    ])
    expect(tmuxCaptureArgs('%7', 60, { visible: true, ansi: false })).toEqual([
      'capture-pane', '-p', '-J', '-t', '%7',
    ])
  })

  // POSIX host artifact: the fake tmux is a `#!/bin/sh` script, which Windows cannot exec through
  // execFile, and the PATH injection below uses a `:` separator that Windows never matches.
  it.skipIf(process.platform === 'win32')('carries prompt and literal bytes only over stdin, never child argv or diagnostics', async () => {
    assumeTmuxVersion(null)
    const dir = mkdtempSync(join(tmpdir(), 'harness-tmux-input-'))
    const argsFile = join(dir, 'args')
    const stdinFile = join(dir, 'stdin')
    const fakeTmux = join(dir, 'tmux')
    const sentinel = `prompt sentinel $' ${process.pid}`
    writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_INPUT_ARGS"
if [ "$1" = "load-buffer" ]; then
  cat >> "$TMUX_INPUT_STDIN"
  printf '\\n' >> "$TMUX_INPUT_STDIN"
fi
if [ "$1" = "paste-buffer" ] && [ "$TMUX_INPUT_FAIL_PASTE" = "1" ]; then
  printf 'synthetic paste failure\\n' >&2
  exit 2
fi
`)
    chmodSync(fakeTmux, 0o700)
    const previous = {
      path: process.env.PATH,
      args: process.env.TMUX_INPUT_ARGS,
      stdin: process.env.TMUX_INPUT_STDIN,
      fail: process.env.TMUX_INPUT_FAIL_PASTE,
    }
    const errors: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.map(String).join(' '))
    })
    try {
      process.env.PATH = `${dir}:${previous.path ?? ''}`
      process.env.TMUX_INPUT_ARGS = argsFile
      process.env.TMUX_INPUT_STDIN = stdinFile
      expect(await sendLiteralToTmux('%7', sentinel)).toBe(true)
      expect(await sendToTmux('%7', sentinel)).toBe(true)
      process.env.TMUX_INPUT_FAIL_PASTE = '1'
      expect(await sendLiteralToTmux('%7', sentinel)).toBe(false)

      const argv = readFileSync(argsFile, 'utf8')
      expect(argv).not.toContain(sentinel)
      expect(readFileSync(stdinFile, 'utf8').split(sentinel)).toHaveLength(4)
      expect(errors.join('\n')).not.toContain(sentinel)
    } finally {
      error.mockRestore()
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.args === undefined) delete process.env.TMUX_INPUT_ARGS
      else process.env.TMUX_INPUT_ARGS = previous.args
      if (previous.stdin === undefined) delete process.env.TMUX_INPUT_STDIN
      else process.env.TMUX_INPUT_STDIN = previous.stdin
      if (previous.fail === undefined) delete process.env.TMUX_INPUT_FAIL_PASTE
      else process.env.TMUX_INPUT_FAIL_PASTE = previous.fail
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('brackets every submitted message and sends one separate Enter only after a successful paste', async () => {
    // Known up front: a `tmux -V` asked through the fake tmux would land in the commands compared below.
    assumeTmuxVersion(null)
    const dir = mkdtempSync(join(tmpdir(), 'harness-tmux-submit-'))
    const argsFile = join(dir, 'args')
    const fakeTmux = join(dir, 'tmux')
    writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_SUBMIT_ARGS"
if [ "$1" = "load-buffer" ]; then cat > /dev/null; fi
if [ "$1" = "paste-buffer" ] && [ "$TMUX_SUBMIT_FAIL" = "1" ]; then exit 2; fi
`)
    chmodSync(fakeTmux, 0o700)
    const previous = { path: process.env.PATH, args: process.env.TMUX_SUBMIT_ARGS, fail: process.env.TMUX_SUBMIT_FAIL }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = () => readFileSync(argsFile, 'utf8').trim().split('\n')
      .map(line => line.replace(/machinemsg-\d+-\d+/g, 'buffer'))
    try {
      process.env.PATH = `${dir}:${previous.path ?? ''}`
      process.env.TMUX_SUBMIT_ARGS = argsFile
      delete process.env.TMUX_SUBMIT_FAIL
      for (const message of ['Testing voice.', 'Résumé 日本語.', 'first\nsecond', 'x'.repeat(501)]) {
        writeFileSync(argsFile, '')
        expect(await sendToTmux('%7', message)).toBe(true)
        expect(commands()).toEqual([
          'load-buffer -b buffer -',
          'paste-buffer -t %7 -b buffer -p -d',
          'send-keys -t %7 Enter',
        ])
      }

      // A clipboard paste and a live filter edit must remain unsubmitted.
      writeFileSync(argsFile, '')
      expect(await pasteRawIntoTmux('%7', 'clipboard')).toBe(true)
      expect(await sendLiteralToTmux('%7', 'filter')).toBe(true)
      expect(commands()).toEqual([
        'load-buffer -b buffer -', 'paste-buffer -t %7 -b buffer -p -d',
        'load-buffer -b buffer -', 'paste-buffer -t %7 -b buffer -d',
      ])

      // Asked right before the Enter, after the paste: a reason keeps the Enter from being pressed, and an
      // engine that opened a dialog in between gets the text and no Enter.
      for (const message of ['short', 'first\nsecond']) {
        writeFileSync(argsFile, '')
        const asked: string[] = []
        expect(await sendToTmux('%7', message, async () => { asked.push(commands().at(-1)!); return 'permission_open' })).toEqual({ withheld: 'permission_open' })
        expect(asked).toEqual(['paste-buffer -t %7 -b buffer -p -d'])
        expect(commands()).toEqual(['load-buffer -b buffer -', 'paste-buffer -t %7 -b buffer -p -d'])
      }
      writeFileSync(argsFile, '')
      expect(await sendToTmux('%7', 'clear to send', async () => null)).toBe(true)
      expect(commands().at(-1)).toBe('send-keys -t %7 Enter')

      // A revoked engine operation must not paste after waiting for a tmux room or buffer load.
      writeFileSync(argsFile, '')
      expect(await sendToTmux('%7', '/model next', undefined, () => false)).toBe(false)
      expect(readFileSync(argsFile, 'utf8')).toBe('')
      writeFileSync(argsFile, '')
      expect(await sendToTmux('%7', '/model next', undefined, () => readFileSync(argsFile, 'utf8') === '')).toBe(false)
      expect(commands()).toEqual(['load-buffer -b buffer -', 'delete-buffer -b buffer'])

      // Revocation while the caller awaits a final admission check must withhold Enter.
      writeFileSync(argsFile, '')
      let allowed = true
      expect(await sendToTmux('%7', '/model next', async () => { allowed = false; return null }, () => allowed))
        .toEqual({ withheld: 'terminal control revoked' })
      expect(commands()).toEqual(['load-buffer -b buffer -', 'paste-buffer -t %7 -b buffer -p -d'])

      // tmux 3.4 can queue a paste behind a terminal attach. Revocation follows it through that queue.
      writeFileSync(argsFile, '')
      assumeTmuxVersion({ major: 3, minor: 4 })
      allowed = true
      const leave = await tmuxControlGate.enter('attach')
      const queued = sendToTmux('%7', '/model next', undefined, () => allowed)
      await new Promise(resolve => setTimeout(resolve, 10))
      allowed = false
      leave()
      expect(await queued).toBe(false)
      expect(readFileSync(argsFile, 'utf8')).toBe('')
      assumeTmuxVersion(null)

      writeFileSync(argsFile, '')
      process.env.TMUX_SUBMIT_FAIL = '1'
      expect(await sendToTmux('%7', 'must not send')).toBe(false)
      expect(commands()).toEqual([
        'load-buffer -b buffer -', 'paste-buffer -t %7 -b buffer -p -d', 'delete-buffer -b buffer',
      ])
    } finally {
      error.mockRestore()
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.args === undefined) delete process.env.TMUX_SUBMIT_ARGS
      else process.env.TMUX_SUBMIT_ARGS = previous.args
      if (previous.fail === undefined) delete process.env.TMUX_SUBMIT_FAIL
      else process.env.TMUX_SUBMIT_FAIL = previous.fail
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pastes a message or a clipboard with its control characters made visible, and types a literal as given', async () => {
    // A message carrying the paste's end marker ended its paste on tmux 3.2a and 3.3a, and what followed
    // was typed (e2e/content.e2e.ts): a buffer tmux pastes bracketed holds no control but tab and newline.
    const dir = mkdtempSync(join(tmpdir(), 'harness-tmux-paste-'))
    const fakeTmux = join(dir, 'tmux')
    writeFileSync(fakeTmux, `#!/bin/sh
if [ "$1" = "load-buffer" ]; then
  n=$(cat "$TMUX_PASTE_DIR/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$TMUX_PASTE_DIR/count"
  cat > "$TMUX_PASTE_DIR/buffer-$n"
fi
`)
    chmodSync(fakeTmux, 0o700)
    const previous = { path: process.env.PATH, dir: process.env.TMUX_PASTE_DIR }
    const hostile = 'hello\x1b[201~\r!exit\r'
    try {
      process.env.PATH = `${dir}:${previous.path ?? ''}`
      process.env.TMUX_PASTE_DIR = dir
      expect(await sendToTmux('%7', hostile)).toBe(true)
      expect(await pasteRawIntoTmux('%7', hostile)).toBe(true)
      expect(await sendLiteralToTmux('%7', 'filter\x1b')).toBe(true)
      const buffer = (n: number) => readFileSync(join(dir, `buffer-${n}`), 'utf8')
      // The message loses its trailing carriage return before the paste, as before, then its controls.
      expect(buffer(1)).toBe('hello^[[201~\n!exit')
      expect(buffer(2)).toBe('hello^[[201~\n!exit\n')
      expect(buffer(3)).toBe('filter\x1b')
    } finally {
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.dir === undefined) delete process.env.TMUX_PASTE_DIR
      else process.env.TMUX_PASTE_DIR = previous.dir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a paste on a tmux that crashes when one attaches as a buffer changes (tmuxControlGate.ts)', () => {
  it('waits for a terminal attaching before it sets its buffer, and goes straight through on tmux 3.7', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tmux-gate-'))
    const argsFile = join(dir, 'args')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$1" >> "$TMUX_GATE_ARGS"
if [ "$1" = "load-buffer" ]; then cat > /dev/null; fi
`)
    chmodSync(join(dir, 'tmux'), 0o700)
    writeFileSync(argsFile, '')
    const previous = { path: process.env.PATH, args: process.env.TMUX_GATE_ARGS }
    const asked = () => readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean)
    try {
      process.env.PATH = `${dir}:${previous.path ?? ''}`
      process.env.TMUX_GATE_ARGS = argsFile
      assumeTmuxVersion({ major: 3, minor: 4 })
      const attaching = await tmuxControlGate.enter('attach')
      const pasted = pasteRawIntoTmux('%7', 'clipboard')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(asked()).toEqual([])
      attaching()
      expect(await pasted).toBe(true)
      expect(asked()).toEqual(['load-buffer', 'paste-buffer'])

      writeFileSync(argsFile, '')
      assumeTmuxVersion({ major: 3, minor: 7 })
      const held = await tmuxControlGate.enter('attach')
      try {
        expect(await pasteRawIntoTmux('%7', 'clipboard')).toBe(true)
        expect(asked()).toEqual(['load-buffer', 'paste-buffer'])
      } finally {
        held()
      }
    } finally {
      resetTmuxVersionCache()
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.args === undefined) delete process.env.TMUX_GATE_ARGS
      else process.env.TMUX_GATE_ARGS = previous.args
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives up a paste whose tmux never takes its buffer, so the terminals waiting behind it open', async () => {
    // A tmux client whose server does not answer waits as long as the server does. Inside the notify room
    // that held every terminal open, every session made or killed, and every terminal closed with it.
    const dir = mkdtempSync(join(tmpdir(), 'harness-tmux-hung-'))
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
if [ "$1" = "load-buffer" ]; then exec sleep 30; fi
`)
    chmodSync(join(dir, 'tmux'), 0o700)
    const previous = process.env.PATH
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.env.PATH = `${dir}:${previous ?? ''}`
      assumeTmuxVersion({ major: 3, minor: 4 })
      const started = performance.now()
      const pasted = pasteRawIntoTmux('%7', 'clipboard')
      await new Promise((resolve) => setTimeout(resolve, 100))
      const opened = await Promise.race([
        tmuxControlGate.enter('attach').then((leave) => { leave(); return performance.now() - started }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
      ])
      expect(opened, 'a terminal opens behind a paste whose tmux does not answer').not.toBeNull()
      expect(opened).toBeGreaterThanOrEqual(LOAD_BUFFER_TIMEOUT_MS - 50)
      expect(await pasted).toBe(false)
      expect(error).toHaveBeenCalledWith('[tmux] load-buffer for %7 failed')
    } finally {
      error.mockRestore()
      resetTmuxVersionCache()
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
