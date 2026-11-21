/**
 * herdr 0.9.5 as it ran on Ubuntu 24.04, for herdr's own-pane check (the pty's maker, scannedApp.ts), its client lookup
 * on Linux (herdrOuter.ts) and the e2e harness's herdr (docs/plans/2026-11-21-dial-linux-followups-plan.md, Task 2;
 * spec § 1 and § 2). Facts only, no binary.
 *
 * Recorded 2026-11-21 in a disposable `docker.io/library/ubuntu:24.04` container (24.04.5, arm64, `--hostname box`) on
 * the Podman machine `devcrew-dlf` (macOS host, Linux 7.2.11-200.fc44.aarch64), from the release's own static binary
 * `herdr-linux-aarch64` (sha256 checked against the release asset's digest on GitHub; herdr publishes no checksum
 * file), installed as `/usr/local/bin/herdr`. From the archive: iproute2, procps and gcc 4:13.2.0-7ubuntu1 (with
 * libc6-dev 2.39-0ubuntu8.12); after `ss` and `fds` were recorded, python3 3.12.3-0ubuntu2.1 too, which herdr's own
 * Claude Code hook needs (`nested.byReport`). Nothing else installed; no account signed in.
 *
 * How it was made: the image's `ubuntu` account removed and `useradd -m -u 1000 u`; every command ran as `podman exec
 * --user u` with `HOME=/home/u`, `TERM=xterm-256color`, in `/work`, so the recorder's own `sh` and `ps` (parent 0) are
 * in the tables. `~/.config/herdr/config.toml` was `[update]` `version_check = false`, `manifest_check = false`, as the
 * e2e harness writes it. A terminal is `pty`, a 30-line C helper (`forkpty` at 40x120) standing in for a terminal app:
 * it runs a command on a new pseudo-terminal, types into it what is written to its fifo and keeps what it draws;
 * `setsid -f` started each, so its parent is the container's pid 1 (`sleep infinity`). The scene, in order:
 * - client A: `pty a.in a.out herdr`. It started the default server itself (`/usr/local/bin/herdr server`, comm
 *   `herdr`): the client's child, in a session of its own, on no terminal; the first pane's shell is its child.
 * - client B: `pty b.in b.out herdr`, attached to the same server.
 * - `workspace.create` (`cwd` `/work/proj`) on `herdr.sock`, then `pane.send_text` of `/work/hb/claude\n` into its root
 *   pane `w2:p1`: the e2e harness's fake agent (herdrServer.ts `FAKE_AGENT`, built with `cc`, named `claude`), which
 *   herdr's process detection lists as `claude` with no report.
 * - `setsid -f herdr agent wait w2:p1 --until blocked`: a long-lived `herdr agent …` command.
 * - `pty o.in o.out herdr --session other`: a named session, which started a server of its own under
 *   `~/.config/herdr/sessions/other/`.
 * The panes' shell is `/bin/sh` (no `SHELL` in the exec's environment). Each value below is the exact stdout of the
 * command its comment names, with the scene up as above.
 */
export const RECORDED_HERDR = {
  version: '0.9.5',
  source: 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-aarch64',
  sha256: '17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c',
  arch: 'arm64',
  /** The release's Linux binaries, by `process.arch`; x64 is what `.github/workflows/cli-e2e-dial-hosts.yml` installs. */
  download: {
    x64: {
      url: 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64',
      sha256: '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d',
    },
    arm64: {
      url: 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-aarch64',
      sha256: '17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c',
    },
  },
  /** `dpkg-query -W`; `ss --version` said `ss utility, iproute2-6.1.0`, `ps --version` `ps from procps-ng 4.0.4`. */
  iproute2: '6.1.0-1ubuntu6.4',
  procps: '2:4.0.4-4ubuntu3.3',
  /** `type -P`. `/bin` is a link to `usr/bin`, so `/bin/ps` and `/bin/ss` are the same files (dpkg names `/bin/ss`);
   *  there is no `/usr/sbin/ss`. The account's PATH (`/etc/environment`) holds `/usr/bin`. */
  paths: { ps: '/usr/bin/ps', ss: '/usr/bin/ss' },
  /** The scene's pids: what each process is. */
  pids: {
    serverA: 1303, clientA: 1302, clientB: 1346, agentWait: 1371, firstPaneShell: 1309, agentShell: 1348, agent: 1366,
    otherServer: 1378, otherClient: 1376, otherShell: 1384, terminalA: 1301, terminalB: 1343, terminalOther: 1373,
  },
  /** `ps -axo pid=,ppid=,comm=`. */
  table:
    '      1       0 sleep\n' +
    '   1301       1 pty\n' +
    '   1302    1301 herdr\n' +
    '   1303    1302 herdr\n' +
    '   1309    1303 sh\n' +
    '   1343       1 pty\n' +
    '   1346    1343 herdr\n' +
    '   1348    1303 sh\n' +
    '   1366    1348 claude\n' +
    '   1371       1 herdr\n' +
    '   1373       1 pty\n' +
    '   1376    1373 herdr\n' +
    '   1378    1376 herdr\n' +
    '   1384    1378 sh\n' +
    '   1441       0 sh\n' +
    '   1443    1441 ps\n',
  /** `ps -o pid=,tty= -p 1302,1303,1346,1371,1376,1378` (every herdr). A tty is `pts/<n>`, with no `/dev/`; none is `?`. */
  ttys:
    '   1302 pts/0\n' +
    '   1303 ?\n' +
    '   1346 pts/2\n' +
    '   1371 ?\n' +
    '   1376 pts/4\n' +
    '   1378 ?\n',
  /** `ps -o tty= -p <pid>` for each scene process, by pid. A pid that is gone gives empty stdout and exit 1. */
  ttyOf: {
    1301: '?\n', 1302: 'pts/0\n', 1303: '?\n', 1309: 'pts/1\n', 1343: '?\n', 1346: 'pts/2\n', 1348: 'pts/3\n',
    1366: 'pts/3\n', 1371: '?\n', 1373: '?\n', 1376: 'pts/4\n', 1378: '?\n', 1384: 'pts/5\n',
  } as Readonly<Record<number, string>>,
  /**
   * `ss -xn`, whole: the container's network namespace holds the scene's sockets alone. Exit 0, 2147 bytes; 2.3 ms that
   * run (`date +%s%N` around it), then 35.8, 1.8, 1.1, 1.3 and 1.1 ms in five runs more. Each row: netid, state, two
   * queues, the local address (a bound path, or `*` for none) and its inode, the peer's address (`*`: a unix socket's
   * peer carries no path) and inode, and an empty Process column padded with spaces. The paths are right-aligned. The
   * server's accepted connections carry its listening path, `…/herdr-client.sock` for a client and `…/herdr.sock` for
   * an API request, with the peer's inode: client A's 50265 → 49272, client B's 48696 → 48695, `herdr agent wait`'s on
   * `herdr.sock` 49641 → 48705, the named session's client 51333 → 50577. The unnamed pairs are each process's own.
   * Listening sockets are not listed (`ss -xln` lists 50239 `herdr.sock` and 50250 `herdr-client.sock` of the default
   * server, 51315 and 51326 of `other`'s).
   */
  ss:
    'Netid State Recv-Q Send-Q                                          Local Address:Port  Peer Address:Port Process\n' +
    'u_str ESTAB 0      0                                                           * 51319            * 51318       \n' +
    'u_str ESTAB 0      0                                                           * 49282            * 49283       \n' +
    'u_str ESTAB 0      0                                                           * 51318            * 51319       \n' +
    'u_str ESTAB 0      0                                                           * 50579            * 50578       \n' +
    'u_str ESTAB 0      0                                                           * 50242            * 50243       \n' +
    'u_str ESTAB 0      0                     /home/u/.config/herdr/herdr-client.sock 50265            * 49272       \n' +
    'u_str ESTAB 0      0                                                           * 50243            * 50242       \n' +
    'u_str ESTAB 0      0                                                           * 50578            * 50579       \n' +
    'u_str ESTAB 0      0                            /home/u/.config/herdr/herdr.sock 49641            * 48705       \n' +
    'u_str ESTAB 0      0                     /home/u/.config/herdr/herdr-client.sock 48696            * 48695       \n' +
    'u_str ESTAB 0      0                                                           * 50577            * 51333       \n' +
    'u_str ESTAB 0      0                                                           * 48695            * 48696       \n' +
    'u_str ESTAB 0      0                                                           * 49283            * 49282       \n' +
    'u_str ESTAB 0      0                                                           * 48705            * 49641       \n' +
    'u_str ESTAB 0      0                                                           * 48699            * 48698       \n' +
    'u_str ESTAB 0      0      /home/u/.config/herdr/sessions/other/herdr-client.sock 51333            * 50577       \n' +
    'u_str ESTAB 0      0                                                           * 48698            * 48699       \n' +
    'u_str ESTAB 0      0                                                           * 49272            * 50265       \n',
  ssBytes: 2147,
  ssMs: 2.3,
  /** `ss -xpn` right after, exit 0: the same rows, each with the processes holding it, which confirms the pairs. */
  ssWithProcesses:
    'Netid State Recv-Q Send-Q                                          Local Address:Port  Peer Address:Port Process                                                   \n' +
    'u_str ESTAB 0      0                                                           * 51319            * 51318 users:(("herdr",pid=1378,fd=12))                         \n' +
    'u_str ESTAB 0      0                                                           * 49282            * 49283 users:(("herdr",pid=1302,fd=12),("herdr",pid=1302,fd=10))\n' +
    'u_str ESTAB 0      0                                                           * 51318            * 51319 users:(("herdr",pid=1378,fd=13),("herdr",pid=1378,fd=11))\n' +
    'u_str ESTAB 0      0                                                           * 50579            * 50578 users:(("herdr",pid=1376,fd=11))                         \n' +
    'u_str ESTAB 0      0                                                           * 50242            * 50243 users:(("herdr",pid=1303,fd=13),("herdr",pid=1303,fd=11))\n' +
    'u_str ESTAB 0      0                     /home/u/.config/herdr/herdr-client.sock 50265            * 49272 users:(("herdr",pid=1303,fd=19),("herdr",pid=1303,fd=18))\n' +
    'u_str ESTAB 0      0                                                           * 50243            * 50242 users:(("herdr",pid=1303,fd=12))                         \n' +
    'u_str ESTAB 0      0                                                           * 50578            * 50579 users:(("herdr",pid=1376,fd=12),("herdr",pid=1376,fd=10))\n' +
    'u_str ESTAB 0      0                            /home/u/.config/herdr/herdr.sock 49641            * 48705 users:(("herdr",pid=1303,fd=21))                         \n' +
    'u_str ESTAB 0      0                     /home/u/.config/herdr/herdr-client.sock 48696            * 48695 users:(("herdr",pid=1303,fd=20),("herdr",pid=1303,fd=7)) \n' +
    'u_str ESTAB 0      0                                                           * 50577            * 51333 users:(("herdr",pid=1376,fd=13),("herdr",pid=1376,fd=6)) \n' +
    'u_str ESTAB 0      0                                                           * 48695            * 48696 users:(("herdr",pid=1346,fd=13),("herdr",pid=1346,fd=6)) \n' +
    'u_str ESTAB 0      0                                                           * 49283            * 49282 users:(("herdr",pid=1302,fd=11))                         \n' +
    'u_str ESTAB 0      0                                                           * 48705            * 49641 users:(("herdr",pid=1371,fd=3))                          \n' +
    'u_str ESTAB 0      0                                                           * 48699            * 48698 users:(("herdr",pid=1346,fd=11))                         \n' +
    'u_str ESTAB 0      0      /home/u/.config/herdr/sessions/other/herdr-client.sock 51333            * 50577 users:(("herdr",pid=1378,fd=19),("herdr",pid=1378,fd=18))\n' +
    'u_str ESTAB 0      0                                                           * 48698            * 48699 users:(("herdr",pid=1346,fd=12),("herdr",pid=1346,fd=10))\n' +
    'u_str ESTAB 0      0                                                           * 49272            * 50265 users:(("herdr",pid=1302,fd=13),("herdr",pid=1302,fd=6)) \n',
  /**
   * For each herdr pid, as `u`, `readlink` of each `/proc/<pid>/fd/<n>` that reads `socket:[<inode>]`, by fd. Every
   * link read (`/proc/<pid>/fd` is `dr-x------ u u`). One socket can be on two fds (client A's 49272 on 6 and 13, the
   * server's 50265 on 18 and 19). The server holds its listening sockets (50239, 50250) and each accepted one.
   */
  fds: {
    1302: [{ fd: 6, link: 'socket:[49272]' }, { fd: 10, link: 'socket:[49282]' }, { fd: 11, link: 'socket:[49283]' }, { fd: 12, link: 'socket:[49282]' }, { fd: 13, link: 'socket:[49272]' }],
    1303: [{ fd: 6, link: 'socket:[50239]' }, { fd: 7, link: 'socket:[48696]' }, { fd: 11, link: 'socket:[50242]' }, { fd: 12, link: 'socket:[50243]' }, { fd: 13, link: 'socket:[50242]' }, { fd: 17, link: 'socket:[50250]' }, { fd: 18, link: 'socket:[50265]' }, { fd: 19, link: 'socket:[50265]' }, { fd: 20, link: 'socket:[48696]' }, { fd: 21, link: 'socket:[49641]' }],
    1346: [{ fd: 6, link: 'socket:[48695]' }, { fd: 10, link: 'socket:[48698]' }, { fd: 11, link: 'socket:[48699]' }, { fd: 12, link: 'socket:[48698]' }, { fd: 13, link: 'socket:[48695]' }],
    1371: [{ fd: 3, link: 'socket:[48705]' }],
    1376: [{ fd: 6, link: 'socket:[50577]' }, { fd: 10, link: 'socket:[50578]' }, { fd: 11, link: 'socket:[50579]' }, { fd: 12, link: 'socket:[50578]' }, { fd: 13, link: 'socket:[50577]' }],
    1378: [{ fd: 6, link: 'socket:[51315]' }, { fd: 11, link: 'socket:[51318]' }, { fd: 12, link: 'socket:[51319]' }, { fd: 13, link: 'socket:[51318]' }, { fd: 17, link: 'socket:[51326]' }, { fd: 18, link: 'socket:[51333]' }, { fd: 19, link: 'socket:[51333]' }],
  } as Readonly<Record<number, ReadonlyArray<{ fd: number; link: string }>>>,
  /**
   * herdr 0.9.0 removed `--no-session` (its release notes: "Removed the single-process `--no-session` mode. All terminal
   * UI launches now attach to a background server"), so on 0.9.5 the panes always run under a server. `herdr
   * --no-session`: no stdout, this stderr, exit 2.
   */
  noSession: { removedIn: '0.9.0', stderr: "unknown option: --no-session\nrun 'herdr --help' for usage\n", exit: 2 },
  /**
   * Client A's tty's access time (`stat -c %X /dev/pts/0`), polled every 0.25 s after one key (a space, then a
   * backspace) was typed into client A, in three rounds 10 s apart: it moved each time, 0.26, 0.007 and 0.03 s after
   * the key; client B's (`/dev/pts/2`) did not move. A key 3.5 s after one that moved it left it as it was: Linux writes
   * a tty's times only when the time's 8-second slot changes (tty_io.c `tty_update_time`), so keys into two clients
   * within one 8-second slot read the same.
   */
  atime: { moves: true, afterSeconds: [0.257867, 0.006516, 0.029463], otherClientMoves: false, granularitySeconds: 8 },
  /**
   * Whether herdr's agent listing (`agent.list` on `herdr.sock`, as herdrSource.ts asks) names an agent in pane P
   * (`w3:p1`, a workspace in `/work/nest`) whose process runs on a terminal started in P: P's shell ran `script -qfc …
   * /dev/null`, whose pty ran the fake `claude`.
   * - byProcess: `script -qfc /work/hb/claude /dev/null` typed into P; 3 s later and again a minute later the list named
   *   `w2:p1` alone, where herdr's detection had found the same fake `claude` on the pane's own pty within the 2 s after
   *   it was typed; `herdr agent explain w3:p1 --json` answered `agent_not_found`.
   * - byReport: herdr 0.9.5 has a Claude Code integration (`herdr integration install claude`: hook version 11 at
   *   `~/.claude/hooks/herdr-agent-state.sh`, run on `SessionStart`), which sends `pane.report_agent_session`
   *   (`pane_id` from `HERDR_PANE_ID`, `source` `herdr:claude`, `agent` `claude`, `agent_session_id` the hook input's
   *   `session_id`) and no state. That fake `claude` ended, `script -qfc 'sh agent.sh' /dev/null` in P ran the hook
   *   then the fake `claude` (rows in `nestedTable`): from P's nested pty, as Claude Code runs it (that pty
   *   inherited HERDR_BIN_PATH, HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_TAB_ID, HERDR_WORKSPACE_ID), it exited 0;
   *   the same request sent by hand was answered `{"type":"ok"}`; P stayed unlisted. The same report into `w2:p1` gave
   *   its listed row `agent_session` (`controlList`). A `pane.report_agent` state report into P (`source`
   *   `herdr:claude`, then `harness-e2e`) or into a pane holding only a shell was answered ok and listed nothing either:
   *   herdr lists only an agent its detection found on the pane's own pty, and a report only adds to that row.
   */
  nested: { byProcess: { listed: false }, byReport: { listed: false } },
  /** `ps -axo pid=,ppid=,tty=,comm=` with the nested agent up (the recorder's own `sh` and `ps` left out). */
  nestedTable:
    '   1763    1303 pts/6    sh\n' +
    '   3639    1763 pts/6    script\n' +
    '   3641    3639 pts/7    claude\n',
  /** `agent.list` after the nested report. */
  nestedList:
    '{"id":"3","result":{"type":"agent_list","agents":[{"terminal_id":"term_660bfe4a4aa6e2","agent":"claude","agent_status":"idle","workspace_id":"w2","tab_id":"w2:t1","pane_id":"w2:p1","focused":false,"state_change_seq":1,"cwd":"/work/proj","foreground_cwd":"/work/proj","revision":0}]}}\n',
  /** `agent.list` after the same report into `w2:p1`, whose agent herdr found. */
  controlList:
    '{"id":"l2","result":{"type":"agent_list","agents":[{"terminal_id":"term_660bfe4a4aa6e2","agent":"claude","agent_status":"idle","agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"0d1e2f30-4152-4637-8899-aabbccddeeff"},"workspace_id":"w2","tab_id":"w2:t1","pane_id":"w2:p1","focused":false,"state_change_seq":1,"cwd":"/work/proj","foreground_cwd":"/work/proj","revision":0}]}}\n',
} as const
