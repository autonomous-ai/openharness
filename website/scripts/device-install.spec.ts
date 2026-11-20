import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEVICE_ASSET_PREFIXES, DEVICE_MANIFEST_URL } from "@/lib/deviceRelease";

const installer = join(process.cwd(), "scripts", "device-install.sh");

/** The app-list entry's one rule, which the app, Desktop and this script all follow (Task 50). */
const vectors = JSON.parse(
  readFileSync(join(process.cwd(), "..", "tests", "fixtures", "app-list-entry-vectors.json"), "utf8"),
) as {
  dataHome: { env: { HOME?: string; XDG_DATA_HOME?: string }; dataHome: string | null }[];
  exec: { path: string; exec: string | null }[];
  entries: { appImage: string; dataHome: string; icon: boolean; entry: string }[];
  decisions: { name: string; existing: string | null }[];
};

const VERSION = "1.4.2";
const PLACE = "/.local/opt/Harness-Device.AppImage";
const MEMBER = "usr/share/icons/hicolor/128x128/apps/harness-device.png";
const ICON_BYTES = "the image icon";

const releaseUrl = (arch: string, prefix = DEVICE_ASSET_PREFIXES[0], version = VERSION) =>
  `${prefix}${version}/Harness-Device-linux-${arch}.AppImage`;

/** The pattern that finds a process whose command is `path`: its regex characters escaped, anchored at the start. */
const commandPattern = (path: string) => `^${path.replace(/[\][\\.*^$+?(){}|]/g, "\\$&")}( |$)`;

interface Options {
  os?: string;
  machine?: string;
  /** HOME under the run's folder (absolute) or as given (relative, read from the run's folder); null leaves it unset. */
  home?: string | null;
  xdgDataHome?: string;
  /** What the manifest says of this arch's AppImage, over what the served file is. */
  entry?: { url?: string; sha256?: string; size?: number };
  /** More of the script's environment. */
  env?: Record<string, string>;
  /** A process's command line, made from the place, which runs before the script does. */
  running?: (place: string) => string;
  /** Whether `--appimage-extract` gives the icon. */
  icon?: boolean;
  /** Files written before the run, by path under the run's folder. */
  before?: Record<string, string>;
  /** A signal `--appimage-extract` sends the script, as a Ctrl-C or a closed terminal does. */
  signal?: string;
  /** The variable the shell ends with byte 0xE9, Latin-1's é: Node's environment holds only UTF-8. */
  latin1?: "HOME" | "XDG_DATA_HOME";
  /** Whether the app, started, ends at once, as with no FUSE or another arch's userland. */
  startFails?: boolean;
  /** The download whose server sends without end, never naming its size. */
  endless?: "manifest" | "app";
}

/**
 * Stub uname, curl, pgrep, setsid, mv, sync and sleep, first on PATH, steered by STUB_* variables; sha256sum, sed and the
 * rest are real. curl serves the manifest at its URL and the AppImage at any other, recording each URL. pgrep matches
 * its pattern as the extended regex it is against the command lines in the log's `processes`. mv records whether
 * something is at the place, then moves. sync records each file it is given that is there. sleep records how long it
 * was asked to wait, and returns. Written once: macOS checks each
 * new executable on its first run, which costs a quarter of a second per file.
 */
const bin = mkdtempSync(join(tmpdir(), "harness-device-install-bin-"));
const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stub("uname", `case "$1" in -s) echo "$STUB_OS" ;; -m) echo "$STUB_MACHINE" ;; *) exit 1 ;; esac`);
stub(
  "curl",
  `out= url= prev=
for arg; do
  if [ "$prev" = -o ]; then out="$arg"; else case "$arg" in -*) ;; *) url="$arg" ;; esac; fi
  prev="$arg"
done
printf '%s\\n' "$url" >> "$STUB_LOG/requested"
printf '%s\\0' "$@" >> "$STUB_LOG/curl" && printf '\\n' >> "$STUB_LOG/curl"
served=app && [ "$url" != "$STUB_MANIFEST_URL" ] || served=manifest
# A server that never stops, its size unnamed: curl before 8.4 (Ubuntu 22.04's 7.81) applies no --max-filesize to it.
[ "$STUB_ENDLESS" != "$served" ] || exec head -c 4194304 /dev/zero > "$out" 2>/dev/null
if [ "$served" = manifest ]; then cp "$STUB_SERVED/metadata.json" "$out"; else cp "$STUB_SERVED/app" "$out"; fi`,
);
stub(
  "pgrep",
  `printf '%s\\0' "$@" >> "$STUB_LOG/pgrep" && printf '\\n' >> "$STUB_LOG/pgrep"
for pattern; do :; done
[ -f "$STUB_LOG/processes" ] && grep -Eq -- "$pattern" "$STUB_LOG/processes"`,
);
stub("setsid", `printf '%s\\0' "$@" > "$STUB_LOG/setsid"\n[ "$1" = -f ] && shift\n"$@"`);
stub("mv", `if [ -e "$STUB_PLACE" ]; then echo there; else echo none; fi >> "$STUB_LOG/mv"\nexec /bin/mv "$@"`);
stub("sleep", `printf '%s\\n' "$*" >> "$STUB_LOG/sleep"`);
stub("sync", `for file; do [ ! -f "$file" ] || printf '%s\\n' "$file" >> "$STUB_LOG/sync"; done`);

/**
 * The AppImage: it takes its icon out for `--appimage-extract <member>`, as the runtime does with no FUSE. Started, it
 * runs on as its command, the place, as the runtime does, unless its start fails.
 */
const APP = `#!/bin/sh
if [ "$1" = --appimage-extract ]; then
  [ -z "$STUB_SIGNAL" ] || kill -"$STUB_SIGNAL" "$STUB_SCRIPT_PID"
  [ "$2" = '${MEMBER}' ] && [ -n "$STUB_ICON" ] || exit 1
  mkdir -p "squashfs-root/\${2%/*}" && printf '%s' '${ICON_BYTES}' > "squashfs-root/$2"
  exit
fi
printf '%s\\n' "$#" >> "$STUB_LOG/ran"
[ -n "$STUB_START_FAILS" ] || printf '%s\\n' "$0" >> "$STUB_LOG/processes"
`;
const APP_SUMS = { sha256: createHash("sha256").update(APP).digest("hex"), size: Buffer.byteLength(APP) };

const runs: string[] = [];
afterEach(() => {
  for (const dir of runs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

/** Every file under folder, relative to it. */
function files(folder: string): string[] {
  // Read as bytes, so a name that is not UTF-8 is listed too.
  const walk = (dir: Buffer, prefix: string): string[] =>
    readdirSync(dir, { encoding: "buffer", withFileTypes: true }).flatMap((entry) => {
      const name = prefix + entry.name.toString();
      if (entry.isDirectory()) return walk(Buffer.concat([dir, Buffer.from("/"), entry.name]), `${name}/`);
      return entry.isFile() ? [name] : [];
    });
  return existsSync(folder) ? walk(Buffer.from(folder), "").sort() : [];
}

/** Runs the installer in a folder of its own, its HOME in there too unless relative. */
function install(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-device-install-"));
  runs.push(dir);
  // The run's folder holds no character the Exec= rule quotes, so a vectors' path keeps its quoting under it.
  expect(dir).toMatch(/^[\w./-]+$/);
  const log = join(dir, "log");
  const served = join(dir, "served");
  for (const folder of [log, served]) mkdirSync(folder);
  const given = options.home === null ? "" : (options.home ?? "/home/p");
  const home = given.startsWith("/") ? dir + given : given;
  const homeAbsolute = home.startsWith("/") ? home : join(dir, home);
  const place = home + PLACE;

  writeFileSync(join(served, "app"), APP);
  const machine = options.machine ?? "x86_64";
  const arch = machine === "aarch64" ? "arm64" : "x64";
  const other = arch === "x64" ? "arm64" : "x64";
  const manifest = {
    version: VERSION,
    notes: "Harness Device 1.4.2",
    platforms: { "linux-x86_64": { url: releaseUrl("x64"), signature: "s" } },
    "device-macos": { version: VERSION, url: `${DEVICE_ASSET_PREFIXES[0]}${VERSION}/Harness-Device.app.tar.gz`, sha256: "a".repeat(64), size: 1 },
    [`device-linux-${other}-appimage`]: { version: "1.4.1", url: releaseUrl(other, undefined, "1.4.1"), sha256: "b".repeat(64), size: 2 },
    [`device-linux-${arch}-appimage`]: { version: VERSION, url: releaseUrl(arch), ...APP_SUMS, ...options.entry },
  };
  writeFileSync(join(served, "metadata.json"), JSON.stringify(manifest, null, 2));

  for (const [path, text] of Object.entries(options.before ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    STUB_OS: options.os ?? "Linux",
    STUB_MACHINE: machine,
    STUB_LOG: log,
    STUB_SERVED: served,
    STUB_MANIFEST_URL: DEVICE_MANIFEST_URL,
    STUB_ICON: options.icon === false ? "" : "1",
    STUB_START_FAILS: options.startFails ? "1" : "",
    STUB_ENDLESS: options.endless ?? "",
  };
  delete env.XDG_DATA_HOME;
  if (options.home === null) delete env.HOME;
  if (options.xdgDataHome !== undefined) {
    env.XDG_DATA_HOME = options.xdgDataHome.startsWith("/") ? dir + options.xdgDataHome : options.xdgDataHome;
  }
  Object.assign(env, options.env);
  const placed = join(homeAbsolute, PLACE);
  if (options.running) writeFileSync(join(log, "processes"), `${options.running(placed)}\n`);
  env.STUB_PLACE = placed;
  env.STUB_SIGNAL = options.signal ?? "";
  env.STUB_LATIN1 = options.latin1 ?? "";
  // exec keeps the pid: the script's own, for the stub that signals it.
  const wrapper = `export STUB_SCRIPT_PID=$$
case "$STUB_LATIN1" in
  HOME) HOME="$HOME$(printf '\\351')" ;;
  XDG_DATA_HOME) XDG_DATA_HOME="$XDG_DATA_HOME$(printf '\\351')" ;;
esac
exec sh "$0"`;
  const result = spawnSync("sh", ["-c", wrapper, installer], { cwd: dir, encoding: "utf8", env });
  const read = (name: string) => (existsSync(join(log, name)) ? readFileSync(join(log, name), "utf8") : "");
  return {
    result,
    dir,
    home,
    place,
    requested: read("requested").split("\n").filter(Boolean),
    /** Each curl call's arguments. */
    curl: read("curl").split("\0\n").filter(Boolean).map((call) => call.split("\0")),
    /** Each pgrep call's arguments. */
    pgrep: read("pgrep").split("\0\n").filter(Boolean).map((call) => call.split("\0")),
    setsid: read("setsid").split("\0").slice(0, -1),
    ran: read("ran").split("\n").filter(Boolean),
    sleep: read("sleep").split("\n").filter(Boolean),
    /** Each file flushed, while it was there. */
    synced: read("sync").split("\n").filter(Boolean),
    /** At each mv, whether something was at the place. */
    mv: read("mv").split("\n").filter(Boolean),
    opt: files(join(homeAbsolute, ".local", "opt")),
    placed: existsSync(placed) && statSync(placed).isFile() ? readFileSync(placed, "utf8") : null,
    mode: existsSync(placed) ? statSync(placed).mode & 0o777 : null,
    /** The entries and icons written anywhere in the run's folder. */
    listed: files(dir).filter((name) => /(^|\/)(applications\/harness-device\.desktop|icons\/harness-device\.png)$/.test(name)),
  };
}

/** A folder without the `/`s that end it, as every writer reads HOME and XDG_DATA_HOME. */
const folder = (path: string) => path.replace(/\/+$/, "");
const entryAt = (dataHome: string) => join(dataHome, "applications", "harness-device.desktop");
const iconAt = (dataHome: string) => join(dataHome, "icons", "harness-device.png");

// The first test runs each stub for the first time, which macOS checks: seconds, more on a loaded machine.
describe("device-install.sh", { timeout: 20_000 }, () => {
  it("parses as sh", () => {
    const result = spawnSync("sh", ["-n", installer], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("refuses a computer that is not Linux", () => {
    const run = install({ os: "Darwin" });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe("Harness Device installer: this installer is for Linux (found: Darwin).\n");
    expect(run.requested).toEqual([]);
  });

  it("refuses a Linux architecture it has no build for", () => {
    const run = install({ machine: "riscv64" });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(
      "Harness Device installer: Harness Device does not support this Linux architecture (riscv64).\n",
    );
    expect(run.requested).toEqual([]);
  });

  it.each([
    ["x86_64", "x64"],
    ["aarch64", "arm64"],
  ])("takes the AppImage of this arch from the device manifest (%s)", (machine, arch) => {
    const run = install({ machine });

    expect(run.result.stderr).toBe("");
    expect(run.result.status).toBe(0);
    expect(run.requested).toEqual([DEVICE_MANIFEST_URL, releaseUrl(arch)]);
  });

  // A pasted line naming another manifest could pin an older release: only the bucket decides.
  it("reads only its fixed manifest, whatever the environment names", () => {
    const run = install({ env: { HARNESS_DEVICE_METADATA_URL: "https://cdn.autonomous.ai/e2e/metadata.json" } });

    expect(run.result.status).toBe(0);
    expect(run.requested[0]).toBe(DEVICE_MANIFEST_URL);
  });

  // A stalled CDN would hang the line, and an endless one would fill the disk before the size check.
  it("downloads over https only, never stalls, and takes no more than the file's size", () => {
    const run = install();
    const flag = (call: string[], name: string) => call[call.indexOf(name) + 1];

    expect(run.result.status).toBe(0);
    expect(run.curl.length).toBe(2);
    for (const call of run.curl) {
      expect(flag(call, "--proto")).toBe("=https");
      expect(flag(call, "--proto-redir")).toBe("=https");
      expect(flag(call, "--speed-limit")).toBe("1024");
      expect(flag(call, "--speed-time")).toBe("60");
    }
    expect(flag(run.curl[0], "--max-filesize")).toBe("1048576");
    expect(flag(run.curl[1], "--max-filesize")).toBe(String(APP_SUMS.size));
  });

  // curl before 8.4 applies --max-filesize only to a size the server names: the shell's file size limit stops the rest.
  it.each([
    ["manifest", "could not download device metadata"],
    ["app", `could not download Harness Device ${VERSION}`],
  ] as const)("stops a %s download whose server never stops sending", (endless, reason) => {
    const run = install({ endless });

    expect(run.result.status).toBe(1);
    // The shell names the limit before it, as curl names its own failure.
    expect(run.result.stderr.trimEnd().split("\n").at(-1)).toBe(`Harness Device installer: ${reason}`);
    expect(run.opt).toEqual([]);
    expect(run.setsid).toEqual([]);
  });

  it.each(DEVICE_ASSET_PREFIXES)("takes the AppImage from %s", (prefix) => {
    const run = install({ entry: { url: releaseUrl("x64", prefix) } });

    expect(run.result.status).toBe(0);
    expect(run.requested).toEqual([DEVICE_MANIFEST_URL, releaseUrl("x64", prefix)]);
  });

  // curl collapses dot segments, so a glob's `*` matching `../..` would download from another folder.
  it.each([
    ["Desktop's folder", `https://cdn.autonomous.ai/harness/desktop/${VERSION}/Harness-Device-linux-x64.AppImage`],
    ["another version than the manifest's", releaseUrl("x64", undefined, "1.4.1")],
    ["..", `https://cdn.autonomous.ai/harness/device/${VERSION}/../../desktop/${VERSION}/Harness-Device-linux-x64.AppImage`],
    ["%2e%2e", `https://cdn.autonomous.ai/harness/device/${VERSION}/%2e%2e/Harness-Device-linux-x64.AppImage`],
    ["a query", `${releaseUrl("x64")}?x=1`],
    ["a fragment", `${releaseUrl("x64")}#x`],
    ["the other arch's file", releaseUrl("arm64")],
    ["http:", releaseUrl("x64").replace("https:", "http:")],
  ])("refuses a URL outside the device release folders: %s", (_, url) => {
    const run = install({ entry: { url } });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(
      "Harness Device installer: device metadata points outside the Harness Device release bucket\n",
    );
    expect(run.requested).toEqual([DEVICE_MANIFEST_URL]);
    expect(run.opt).toEqual([]);
  });

  it.each([
    ["size", { size: 1 }, "downloaded AppImage size does not match the release metadata"],
    ["sha256", { sha256: "0".repeat(64) }, "downloaded AppImage checksum does not match the release metadata"],
  ])("refuses a %s that does not match, and leaves nothing at the place", (_, entry, reason) => {
    const run = install({ entry });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(`Harness Device installer: ${reason}\n`);
    expect(run.opt).toEqual([]);
    expect(run.listed).toEqual([]);
    expect(run.ran).toEqual([]);
  });

  it("places the AppImage executable and starts it", () => {
    const run = install();

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toBe(
      "Fetching the latest Harness Device release…\n" +
        `Downloading Harness Device ${VERSION}…\n` +
        `Harness Device ${VERSION} installed at ${run.place}\n`,
    );
    expect(run.opt).toEqual(["Harness-Device.AppImage"]);
    expect(run.placed).toBe(APP);
    expect(run.mode).toBe(0o755);
    expect(run.setsid).toEqual(["-f", run.place]);
    expect(run.ran).toEqual(["0"]);
  });

  // A start that fails ends at once; the app, once up, runs on. So it has started when it still runs a moment later.
  it("checks the app still runs from the place a moment after its start", () => {
    const run = install();

    expect(run.result.status).toBe(0);
    expect(run.sleep).toHaveLength(1);
    expect(run.pgrep).toHaveLength(2);
    expect(run.pgrep[1]).toEqual(run.pgrep[0]);
  });

  it("says so, and what to run, when the app does not start", () => {
    const run = install({ startFails: true });

    expect(run.result.status).toBe(1);
    expect(run.result.stdout).toContain(`Harness Device ${VERSION} installed at ${run.place}\n`);
    expect(run.result.stderr).toBe(
      `Harness Device installer: Harness Device did not start: run "${run.place}" in a terminal to see why.\n`,
    );
    expect(run.ran).toEqual(["0"]);
  });

  it("replaces the AppImage in one move: something is always at the place", () => {
    const run = install({ before: { [`home/p${PLACE}`]: "the copy before" } });

    expect(run.result.status).toBe(0);
    expect(run.placed).toBe(APP);
    expect(run.mv.length).toBeGreaterThan(0);
    expect(run.mv.filter((state) => state !== "there")).toEqual([]);
  });

  it("refuses a folder at the place and leaves it", () => {
    const run = install({ before: { [`home/p${PLACE}/a file`]: "kept" } });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(
      `Harness Device installer: ${run.place} is a folder. Move it away, then run this installer again.\n`,
    );
    expect(run.requested).toEqual([DEVICE_MANIFEST_URL]);
    expect(readFileSync(join(run.dir, `home/p${PLACE}/a file`), "utf8")).toBe("kept");
  });

  // Ctrl-C, a closed terminal or a kill: the script stops there and starts nothing.
  it.each([
    ["INT", 130],
    ["HUP", 129],
    ["TERM", 143],
  ])("stops at %s and starts nothing", (signal, status) => {
    const run = install({ signal });

    expect(run.result.status).toBe(status);
    expect(run.result.stdout).not.toContain("installed at");
    expect(run.setsid).toEqual([]);
    expect(run.ran).toEqual([]);
  });

  it("refuses while the app runs from the place", () => {
    const run = install({ running: (place) => place, before: { [`home/p${PLACE}`]: "the copy that runs" } });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(
      `Harness Device installer: Harness Device is running from ${run.place}. Quit it, then run this installer again.\n`,
    );
    expect(run.pgrep).toEqual([["-u", String(process.getuid!()), "-f", commandPattern(run.place)]]);
    expect(run.requested).toEqual([DEVICE_MANIFEST_URL]);
    expect(run.placed).toBe("the copy that runs");
    expect(run.setsid).toEqual([]);
  });

  // pgrep -f reads an extended regex: unescaped, each of these paths fails to match itself, or is no regex at all.
  it.each(["/home/john+doe", "/home/a$b", "/home/p (old)", "/home/a[b"])(
    "refuses while the app runs from a home whose path a regex reads otherwise: %s",
    (home) => {
      const run = install({ home, running: (place) => place });

      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toBe(
        `Harness Device installer: Harness Device is running from ${run.place}. Quit it, then run this installer again.\n`,
      );
      expect(run.setsid).toEqual([]);
    },
  );

  it("installs while a process only names the place, as an editor does", () => {
    const run = install({ running: (place) => `vi ${place}` });

    expect(run.result.status).toBe(0);
    expect(run.placed).toBe(APP);
  });

  it.each(vectors.entries)("writes the entry the app writes: $appImage, $dataHome, icon $icon", (vector) => {
    const home = vector.appImage.slice(0, -PLACE.length);
    const run = install({ home, xdgDataHome: vector.dataHome, icon: vector.icon });
    const dataHome = run.dir + folder(vector.dataHome);

    expect(run.result.status).toBe(0);
    expect(readFileSync(entryAt(dataHome), "utf8")).toBe(vector.entry.replaceAll(home, run.home));
    expect(existsSync(iconAt(dataHome)) && readFileSync(iconAt(dataHome), "utf8")).toBe(vector.icon && ICON_BYTES);
    expect(run.listed.length).toBe(vector.icon ? 2 : 1);
    // Nothing of the work is left beside them.
    expect(files(dataHome)).toEqual(run.listed.map((name) => join(run.dir, name).slice(dataHome.length + 1)));
  });

  // The person's environment is theirs: a variable of the same name never lands in the entry.
  it("writes only the Icon= line it made, whatever the environment holds", () => {
    const run = install({ icon: false, env: { ICON_LINE: "Icon=/elsewhere.png\nExec=/elsewhere" } });
    const vector = vectors.entries.find((entry) => !entry.icon && entry.appImage === `/home/p${PLACE}`)!;

    expect(run.result.status).toBe(0);
    expect(readFileSync(entryAt(`${run.home}/.local/share`), "utf8")).toBe(vector.entry.replaceAll("/home/p", run.home));
  });

  // A key file is UTF-8: like the app, the script writes no entry for a path that is not. macOS keeps only UTF-8 names,
  // so there such a folder cannot exist.
  it.runIf(process.platform === "linux").each([
    ["HOME", { home: "/home/caf" }],
    ["XDG_DATA_HOME", { xdgDataHome: "/data/caf" }],
  ] as const)("writes no entry when %s is not UTF-8, and installs", (latin1, where) => {
    const run = install({ ...where, latin1 });

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("installed at");
    expect(run.listed).toEqual([]);
  });

  // Past the vectors: the rest of Unicode's White_Space, quoted; characters that look blank but are not White_Space,
  // left bare; C1's ends, control characters.
  const blank = (c: string, exec: (path: string) => string | null) => {
    const path = `/home/p/a${c}b/H.AppImage`;
    return { path, exec: exec(path) };
  };
  const execCases = [
    ...vectors.exec,
    ...[" ", " ", " ", " ", " ", " ", " "].map((c) => blank(c, (path) => `"${path}"`)),
    ...["᠎", "​", "⁠"].map((c) => blank(c, (path) => path)),
    ...["\u0080", "\u009f"].map((c) => blank(c, () => null)),
  ];

  // Each path stands for a home: its folder, under which the script installs to the place. The script's list is its own,
  // so under the C locale, where the shell reads a byte at a time as dash always does, it quotes the same.
  it.each(["", "C"].flatMap((locale) => execCases.map((vector) => ({ ...vector, locale }))))(
    "a home is quoted as the app quotes it: $path, locale '$locale'",
    (vector) => {
      const tail = vector.path.endsWith(PLACE) ? PLACE : vector.path.slice(vector.path.lastIndexOf("/"));
      const home = vector.path.slice(0, -tail.length);
      const run = install({ home, env: vector.locale ? { LC_ALL: vector.locale } : {} });
      const entry = entryAt(`${run.home}/.local/share`);

      expect(run.result.status).toBe(0);
      if (vector.exec === null) {
        // A control character would break the entry's lines: like the app, the script writes nothing.
        expect(run.listed).toEqual([]);
      } else {
        const exec = vector.exec.replace("/home", `${run.dir}/home`).replace(tail, PLACE);
        expect(readFileSync(entry, "utf8").split("\n")).toContain(`Exec=${exec}`);
      }
    },
  );

  // HOME is where the script installs: an AppImage and an Exec= line under a relative one are paths no launcher can run.
  it.each([
    ["relative", "home/p"],
    ["empty", ""],
    ["unset", null],
  ])("refuses a HOME that is %s, before any download", (_, home) => {
    const run = install({ home, xdgDataHome: "/data/p" });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe("Harness Device installer: HOME must be an absolute path\n");
    expect(run.requested).toEqual([]);
    expect(files(run.dir).filter((name) => !/^(log|served)\//.test(name))).toEqual([]);
  });

  // `/` alone, without the `/` that ends it, is no folder.
  it("refuses a HOME that is only /, before any download", () => {
    const run = install({ env: { HOME: "/" } });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe("Harness Device installer: HOME must be an absolute path\n");
    expect(run.requested).toEqual([]);
  });

  it("puts the entry under HOME when XDG_DATA_HOME is only /", () => {
    const run = install({ env: { XDG_DATA_HOME: "/" } });

    expect(run.result.status).toBe(0);
    expect(run.listed).toEqual([
      "home/p/.local/share/applications/harness-device.desktop",
      "home/p/.local/share/icons/harness-device.png",
    ]);
  });

  // The vectors whose HOME is unset, empty or relative are refused above.
  it.each(vectors.dataHome.filter((vector) => vector.env.HOME?.startsWith("/")))(
    "puts the entry in the data home the app uses: $env",
    (vector) => {
      const run = install({ home: vector.env.HOME, xdgDataHome: vector.env.XDG_DATA_HOME });
      const dataHome = run.dir + vector.dataHome!;

      expect(run.result.status).toBe(0);
      expect(run.listed).toEqual([
        `${vector.dataHome!.slice(1)}/applications/harness-device.desktop`,
        `${vector.dataHome!.slice(1)}/icons/harness-device.png`,
      ]);
      // No doubled `/` in its paths: the AppImage under HOME, the icon under the data home.
      const entry = readFileSync(entryAt(dataHome), "utf8").split("\n");
      expect(entry).toContain(`Exec=${run.dir}${folder(vector.env.HOME!)}${PLACE}`);
      expect(entry).toContain(`Icon=${iconAt(dataHome)}`);
    },
  );

  // The name the app and Desktop write to, so a run stopped mid-write leaves one file the next write replaces; flushed,
  // so a crash after the rename cannot leave it empty.
  it("writes each file to <file>.tmp, flushed, then renamed over it", () => {
    const share = "home/p/.local/share";
    const run = install({
      before: {
        [`${share}/applications/harness-device.desktop.tmp`]: "half",
        [`${share}/icons/harness-device.png.tmp`]: "half",
      },
    });

    expect(run.result.status).toBe(0);
    expect(files(join(run.dir, share))).toEqual(["applications/harness-device.desktop", "icons/harness-device.png"]);
    expect(run.synced).toEqual([`${iconAt(join(run.dir, share))}.tmp`, `${entryAt(join(run.dir, share))}.tmp`]);
  });

  it.each(vectors.decisions.filter((vector) => vector.existing !== null))(
    "an entry already there is left for the app: $name",
    (vector) => {
      const run = install({ before: { "home/p/.local/share/applications/harness-device.desktop": vector.existing! } });

      expect(run.result.status).toBe(0);
      expect(readFileSync(entryAt(`${run.home}/.local/share`), "utf8")).toBe(vector.existing);
      expect(run.listed).toEqual(["home/p/.local/share/applications/harness-device.desktop"]);
    },
  );
});
