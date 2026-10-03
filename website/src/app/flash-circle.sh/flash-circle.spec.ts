import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "src", "app", "flash-circle.sh", "flash-circle.sh");

describe("/flash-circle.sh boot-version verification", () => {
  it("is valid Bash and parses a serial log containing invalid UTF-8 bytes", () => {
    expect(spawnSync("bash", ["-n", script], { encoding: "utf8" }).status).toBe(0);

    const directory = mkdtempSync(join(tmpdir(), "harness-flash-log-"));
    const log = join(directory, "boot.log");
    writeFileSync(log, Buffer.concat([
      Buffer.from("booting\r\n"),
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from("\r\nApp version: 0.0.39\r\n"),
    ]));

    try {
      const result = spawnSync(
        "bash",
        ["-c", "LC_ALL=C sed -n 's/.*App version: *//p' \"$1\" | head -1 | tr -d '\\r'", "bash", log],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("0.0.39\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the byte locale while reading the serial boot log", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain('LC_ALL=C sed -n \'s/.*App version: *//p\'');
  });

  it("stops the Harness adapter before probing or flashing a board", () => {
    const source = readFileSync(script, "utf8");
    const stop = source.indexOf("stop_harness_for_flash");
    const flashFlow = source.indexOf('if [ "$NO_FLASH" -eq 0 ]; then');

    expect(source).toContain("harness stop");
    expect(stop).toBeGreaterThan(-1);
    expect(flashFlow).toBeGreaterThan(stop);
    expect(source).toContain('[ "$DETECT_ONLY" -eq 1 ] || stop_harness_for_flash');
    expect(source).toContain("ensure_esptool");
    expect(source).toContain("pick_port");
  });

  it("starts the adapter again however the script ends", () => {
    // A LINE AT THE END IS NOT ENOUGH, and that is the whole point of asserting on the trap. There are
    // several ways out of this script once the daemon is already down: --no-flash exits early, `die`
    // aborts on any failure from that moment on, and a person can interrupt a two-minute write. Each of
    // those leaving Harness stopped is worse than never having flashed — the dial goes dark and the
    // computer no longer knows it exists, and nobody reporting that later would call it a flasher bug.
    const source = readFileSync(script, "utf8");

    expect(source).toContain("trap flash_cleanup EXIT INT TERM");
    expect(source).toContain("harness start");
    // Only ever restarts what this script stopped: a board flashed on a machine with no Harness, or with
    // Harness already down, must not have a daemon started behind the user's back.
    expect(source).toContain('[ "$HARNESS_STOPPED" -eq 1 ] || return 0');
  });

  it("bounds the probe and never leaves esptool behind", () => {
    const source = readFileSync(script, "utf8");

    // A probe with no time limit is what made the dialog spin: esptool blocks for ever on a port
    // that never answers, and macOS ships no `timeout`(1) to wrap it in.
    expect(source).toContain("run_bounded");
    expect(source).toContain('PROBE_TIMEOUT="${HARNESS_PROBE_TIMEOUT:-25}"');
    expect(source).toMatch(/run_bounded "\$PROBE_TIMEOUT"/);
    // Once is enough to answer "is there an ESP32-S3 here", and each retry resets the board.
    expect(source).toContain("--connect-attempts 1");

    // The cleanup trap is armed BEFORE anything can spawn esptool, and outside the branch that
    // --detect-only skips — a cancelled detection used to have no trap at all, so its esptool was
    // reparented to init still holding the port, and they stacked up.
    const earlyTrap = source.indexOf("trap kill_child EXIT INT TERM");
    const firstProbe = source.indexOf("pick_port\n");
    expect(earlyTrap).toBeGreaterThan(-1);
    expect(earlyTrap).toBeLessThan(firstProbe);
    // TERM does not reach an esptool blocked in a serial read; that is how they survived being
    // cancelled, so the cleanup escalates.
    // `-s SIG -- -PID`, and the punctuation is load-bearing: `kill -TERM -1234` makes bash read
    // `-1234` as a signal NAME, report success, and signal nothing — that form was tried against a
    // process that ignores TERM and it survived.
    expect(source).toContain('kill -s KILL -- "-$CHILD_PID"');
    // Job control for the spawn, so the child leads its own group and the negative pid reaches
    // esptool's own child too — killing just the pid left that grandchild holding the port.
    expect(source).toContain("set -m");
  });

  it("tells the desktop app it is holding the port, before letting go of it", () => {
    // The desktop app supervises the daemon on a five-second timer and starts anything it finds
    // missing. Stopping the daemon without saying why means the app puts it straight back, it
    // reopens the dial, and esptool loses the port mid-write — the flash then dies with "No more
    // data to read from the serial port", which reads like broken hardware and is not.
    const source = readFileSync(script, "utf8");
    const flag = source.indexOf('> "$CACHE_DIR/flashing"');
    const stop = source.indexOf("harness stop >/dev/null");

    expect(flag).toBeGreaterThan(-1);
    // ORDER MATTERS: raised before the daemon goes down, or the app can win the race in between.
    expect(flag).toBeLessThan(stop);
    // Cleared on the way back up, in the same place the daemon is restarted — which is the trap, so
    // every exit path clears it.
    expect(source).toContain('rm -f "$CACHE_DIR/flashing"');
    // A timestamp, not a lock file: a script killed with -9 cannot clean up, and the app ignores a
    // flag older than its staleness window rather than leaving the daemon unsupervised for ever.
    expect(source).toContain('printf \'%s\\n\' "$(date +%s)"');
  });
});
