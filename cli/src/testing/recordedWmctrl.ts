/**
 * wmctrl 1.07 as it ran on Ubuntu 24.04, for the X11 raise's specs (docs/plans/2026-11-19-dial-linux-plan.md, Task 2
 * and Task 35; spec § 2.3). Recorded 2026-11-19 in a disposable `arm64v8/ubuntu:24.04` container (Podman on macOS,
 * hostname `box`), from the archive's packages: wmctrl 1.07-7ubuntu3, openbox 3.6.1-12build5, xvfb
 * 2:21.1.12-1ubuntu1.9, xauth 1:1.1.2-1build1, xterm 390-1ubuntu3 and x11-utils 7.7+6build2. Nothing else installed;
 * no account.
 *
 * How it was made: `/tmp/.X11-unix` made by root with mode 1777, as systemd-tmpfiles makes it on a desktop. Then as
 * user `u` (uid 1000) in `/work`, with no `DISPLAY` or `XAUTHORITY` in the environment: a cookie for `:99` added to
 * `/home/u/.Xauthority` (`xauth add`), `Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -auth /home/u/.Xauthority`,
 * `openbox`, `xterm -T agent`, `xterm -T other` and `xmessage -name nopid -title nopid hi`, then `other` activated.
 * Every command ran as the X11 raise runs it, through `env DISPLAY=:99 XAUTHORITY=/home/u/.Xauthority wmctrl …`, each
 * part one argument; each value is its exact argv, exit code and output. What `stat` showed: `/tmp/.X11-unix` root
 * 1777, its `X99` a socket of `u` with mode 0777 (the X server's user owns it), `/home/u/.Xauthority` `u` 0600.
 */
export const RECORDED_WMCTRL = {
  source: 'recorded',
  version: '1.07',
  /** `wmctrl -lpx`: `<id> <desktop> <pid> <instance>.<class> <host> <title>`, the columns padded with spaces, the
   *  title the rest of the line. The ids are `0x` and eight hex digits. xmessage sets no `_NET_WM_PID` (`xprop` said
   *  `not found`), so its row's pid is `0`. */
  lpx:
    '0x0020000c  0 2259   xterm.XTerm           box agent\n' +
    '0x0080000c  0 2267   xterm.XTerm           box other\n' +
    '0x00a0001b  0 0      nopid.Xmessage        box nopid\n',
  /** The argv that printed `lpx`: exit 0, nothing on stderr. */
  lpxArgs: ['env', 'DISPLAY=:99', 'XAUTHORITY=/home/u/.Xauthority', 'wmctrl', '-lpx'],
  /** The two xterms' own pids (`ps -o comm=` said `xterm` for each): the pid in each one's row. */
  pids: { agent: 2259, other: 2267 },
  /** `xprop -root _NET_ACTIVE_WINDOW` before the activate: `other`'s window. xprop prints the id without leading
   *  zeros, so it is compared with `lpx`'s ids as a number. */
  activeBefore: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x80000c\n',
  /** `wmctrl -i -a <agent's id>`: no output. */
  activate: {
    args: ['env', 'DISPLAY=:99', 'XAUTHORITY=/home/u/.Xauthority', 'wmctrl', '-i', '-a', '0x0020000c'],
    code: 0,
    stdout: '',
    stderr: '',
  },
  /** `xprop -root _NET_ACTIVE_WINDOW` once it changed: `agent`'s window. */
  activeAfter: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x20000c\n',
  /** `-i -a` of an id that is no window: exit 1 and Xlib's error; the active window stayed `agent`'s. */
  missing: {
    args: ['env', 'DISPLAY=:99', 'XAUTHORITY=/home/u/.Xauthority', 'wmctrl', '-i', '-a', '0x0badf00d'],
    code: 1,
    stdout: '',
    stderr:
      'X Error of failed request:  BadWindow (invalid Window parameter)\n' +
      '  Major opcode of failed request:  20 (X_GetProperty)\n' +
      '  Resource id in failed request:  0xbadf00d\n' +
      '  Serial number of failed request:  8\n' +
      '  Current serial number in output stream:  8\n',
  },
  /** No `DISPLAY`. */
  noDisplay: {
    args: ['env', 'XAUTHORITY=/home/u/.Xauthority', 'wmctrl', '-lpx'],
    code: 1,
    stdout: '',
    stderr: 'Cannot open display.\n',
  },
  /** The display's socket with an `XAUTHORITY` that holds no cookie for it (a file that is not there): the server
   *  refuses the connection. */
  noAuth: {
    args: ['env', 'DISPLAY=:99', 'XAUTHORITY=/work/none', 'wmctrl', '-lpx'],
    code: 1,
    stdout: '',
    stderr: 'Authorization required, but no authorization protocol specified\n\nCannot open display.\n',
  },
} as const
