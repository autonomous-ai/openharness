import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const installer = join(process.cwd(), "scripts", "desktop-install.sh");

const MANIFEST_URL = "https://example.test/harness/desktop/metadata.json";
const VERSION = "1.2.4";
const KEYS = { Darwin: "desktop-macos", Linux: "desktop-linux-x64" } as const;
const RELEASE_URLS = {
  Darwin: `https://cdn.autonomous.ai/harness/desktop/${VERSION}/Harness-macos.zip`,
  Linux: `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/${VERSION}/Harness-linux-x64.AppImage`,
};
/** Where each OS's app goes, under the run's app folder. */
const APP_NAMES = { Darwin: "Harness.app", Linux: "Harness.AppImage" };

/** The macOS archive, which the ditto stub unpacks as the app's executable. */
const ARCHIVE = "the Harness archive";
/** The AppImage: it takes its icon out for `--appimage-extract`, and records each start. */
const APPIMAGE = `#!/bin/sh
if [ "$1" = --appimage-extract ]; then
  [ -z "$STUB_SIGNAL" ] || kill -"$STUB_SIGNAL" "$STUB_SCRIPT_PID"
  mkdir -p squashfs-root && printf icon > "squashfs-root/$2"
  exit
fi
printf '%s\\n' "$#" >> "$STUB_LOG/ran"
`;
const sums = (text: string) => ({ sha256: createHash("sha256").update(text).digest("hex"), size: Buffer.byteLength(text) });
/** The pattern that finds a process whose command is `path`: its regex characters escaped, anchored at the start. */
const commandPattern = (path: string) => `^${path.replace(/[\][\\.*^$+?(){}|]/g, "\\$&")}( |$)`;

/**
 * Stub uname, curl, plutil, ditto, lipo, open, pgrep, mv and sleep, first on PATH, steered by STUB_* variables; shasum,
 * sha256sum, sed and the rest are real. curl serves the manifest at its URL and the release file at any other,
 * recording each URL. plutil answers the manifest's desktop-macos fields from files and an app's version from its
 * Info.plist, which ditto writes beside the executable it unpacks. pgrep matches its pattern as the extended regex it is
 * against the command lines in the log's `processes`. mv records whether something is at the place, moves,
 * then, the first time, sends STUB_MV_SIGNAL to the script. sleep returns at once. Written once: macOS checks each
 * new executable on its first run.
 */
const bin = mkdtempSync(join(tmpdir(), "harness-install-bin-"));
const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stub("uname", `case "$1" in -s) echo "$STUB_OS" ;; -m) echo x86_64 ;; *) exit 1 ;; esac`);
stub(
  "curl",
  `out=/dev/stdout url= prev=
for arg; do
  if [ "$prev" = -o ]; then out="$arg"; else case "$arg" in -*) ;; *) url="$arg" ;; esac; fi
  prev="$arg"
done
printf '%s\\n' "$url" >> "$STUB_LOG/requested"
printf '%s\\0' "$@" >> "$STUB_LOG/curl" && printf '\\n' >> "$STUB_LOG/curl"
served=release && [ "$url" != "$STUB_MANIFEST_URL" ] || served=manifest
# A transfer that breaks, its first STUB_BREAKS times: some bytes, then curl's STUB_BREAK_STATUS.
broken="$(cat "$STUB_LOG/broken" 2>/dev/null || echo 0)"
if [ "$STUB_BREAK" = "$served" ] && [ "$broken" -lt "$STUB_BREAKS" ]; then
  echo "$((broken + 1))" > "$STUB_LOG/broken" && printf 'part of it' > "$out" && exit "$STUB_BREAK_STATUS"
fi
# A server that never stops, its size unnamed: curl before 8.4 (Ubuntu 22.04's 7.81) applies no --max-filesize to it.
[ "$STUB_ENDLESS" != "$served" ] || exec head -c 4194304 /dev/zero > "$out" 2>/dev/null
# A file of curl's own, larger than the download, as its errors written to a log file.
[ -z "$STUB_CURL_WRITES" ] || head -c 65536 /dev/zero > "$STUB_LOG/curl-own"
if [ "$served" = manifest ]; then cat "$STUB_SERVED/metadata.json" > "$out"; else cat "$STUB_SERVED/release" > "$out"; fi`,
);
stub("plutil", `case "$2" in CFBundleShortVersionString) cat "$4" ;; *) cat "$STUB_SERVED/plutil/$2" ;; esac`);
stub(
  "ditto",
  `app="$4/Harness.app/Contents"
mkdir -p "$app/MacOS" && cp "$3" "$app/MacOS/Harness" && chmod 755 "$app/MacOS/Harness" \\
  && cp "$STUB_SERVED/plutil/desktop-macos.version" "$app/Info.plist"`,
);
stub("lipo", "echo x86_64 arm64");
stub("sleep", ":");
stub("open", `printf '%s\\n' "$@" >> "$STUB_LOG/open"`);
stub(
  "pgrep",
  `printf '%s\\0' "$@" >> "$STUB_LOG/pgrep" && printf '\\n' >> "$STUB_LOG/pgrep"
for pattern; do :; done
[ -f "$STUB_LOG/processes" ] && grep -Eq -- "$pattern" "$STUB_LOG/processes"`,
);
stub(
  "mv",
  `if [ -e "$STUB_PLACE" ]; then echo there; else echo none; fi >> "$STUB_LOG/mv"
/bin/mv "$@" || exit
[ -z "$STUB_MV_SIGNAL" ] || [ -e "$STUB_LOG/signalled" ] || { : > "$STUB_LOG/signalled" && kill -"$STUB_MV_SIGNAL" "$STUB_SCRIPT_PID"; }`,
);

const runs: string[] = [];
afterEach(() => {
  for (const dir of runs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

interface Options {
  /** The URL the manifest names, over the release's own. */
  url?: string;
  /** The app folder, under the run's folder. */
  appDir?: string;
  /** A process's command line, made from the app's executable, which runs before the script does. */
  running?: (executable: string) => string;
  /** Files written before the run, by path under the run's folder. */
  before?: Record<string, string>;
  /** A signal `--appimage-extract` sends the script, as a Ctrl-C or a closed terminal does. */
  signal?: string;
  /** A signal the first move sends the script once it has moved. */
  mvSignal?: string;
  /** The download whose transfer breaks, how many times, and curl's status for it: 18, a partial file, unless named. */
  breaks?: { download: "manifest" | "release"; times: number; status?: number };
  /** Whether curl writes a file of its own, larger than the download. */
  curlWrites?: boolean;
  /** The download whose server sends without end, never naming its size. */
  endless?: "manifest" | "release";
  /** Whether the shell ends the app folder with byte 0xE9, Latin-1's é: Node's environment holds only UTF-8. */
  latin1?: boolean;
}

/** Runs the installer as `os` in a folder of its own: HOME is its home/, the app folder its app/. */
function install(os: "Darwin" | "Linux", options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-install-"));
  runs.push(dir);
  const log = join(dir, "log");
  const served = join(dir, "served");
  for (const folder of [log, join(served, "plutil")]) mkdirSync(folder, { recursive: true });
  const release = os === "Darwin" ? ARCHIVE : APPIMAGE;
  writeFileSync(join(served, "release"), release);
  const entry = { version: VERSION, url: options.url ?? RELEASE_URLS[os], ...sums(release) };
  writeFileSync(join(served, "metadata.json"), JSON.stringify({ [KEYS[os]]: entry }, null, 2));
  for (const [field, value] of Object.entries(entry)) {
    writeFileSync(join(served, "plutil", `${KEYS[os]}.${field}`), String(value));
  }
  for (const [path, text] of Object.entries(options.before ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  const appDir = join(dir, options.appDir ?? "app");
  const place = join(appDir, APP_NAMES[os]);
  const executable = os === "Darwin" ? join(place, "Contents", "MacOS", "Harness") : place;
  if (options.running) writeFileSync(join(log, "processes"), `${options.running(executable)}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, "home"),
    HARNESS_DESKTOP_APP_DIR: appDir,
    HARNESS_DESKTOP_METADATA_URL: MANIFEST_URL,
    STUB_OS: os,
    STUB_LOG: log,
    STUB_SERVED: served,
    STUB_MANIFEST_URL: MANIFEST_URL,
    STUB_PLACE: place,
    STUB_SIGNAL: options.signal ?? "",
    STUB_MV_SIGNAL: options.mvSignal ?? "",
    STUB_ENDLESS: options.endless ?? "",
    STUB_CURL_WRITES: options.curlWrites ? "1" : "",
    STUB_BREAK: options.breaks?.download ?? "",
    STUB_BREAKS: String(options.breaks?.times ?? 0),
    STUB_BREAK_STATUS: String(options.breaks?.status ?? 18),
    STUB_LATIN1: options.latin1 ? "1" : "",
  };
  // exec keeps the pid: the script's own, for the stubs that signal it.
  const wrapper = `export STUB_SCRIPT_PID=$$
[ -z "$STUB_LATIN1" ] || HARNESS_DESKTOP_APP_DIR="$HARNESS_DESKTOP_APP_DIR$(printf '\\351')"
exec sh "$0"`;
  const result = spawnSync("sh", ["-c", wrapper, installer], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  const read = (name: string) => (existsSync(join(log, name)) ? readFileSync(join(log, name), "utf8") : "");
  return {
    result,
    dir,
    place,
    executable,
    /** Each pgrep call's arguments. */
    pgrep: read("pgrep").split("\0\n").filter(Boolean).map((call) => call.split("\0")),
    requested: read("requested").split("\n").filter(Boolean),
    /** Each curl call's arguments. */
    curl: read("curl").split("\0\n").filter(Boolean).map((call) => call.split("\0")),
    /** At each mv, whether something was at the place. */
    mv: read("mv").split("\n").filter(Boolean),
    opened: read("open").split("\n").filter(Boolean),
    ran: read("ran").split("\n").filter(Boolean),
    placed: existsSync(executable) && statSync(executable).isFile() ? readFileSync(executable, "utf8") : null,
  };
}

// The first test runs each stub for the first time, which macOS checks: seconds, more on a loaded machine.
describe("desktop-install.sh", { timeout: 20_000 }, () => {
  it("parses as sh", () => {
    const result = spawnSync("sh", ["-n", installer], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("uses the desktop manifest and verifies the downloaded app before replacement", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain("harness/desktop/metadata.json");
    expect(source).toContain('APP_DIR="${HARNESS_DESKTOP_APP_DIR:-/Applications}"');
    expect(source).toContain("plutil -extract \"desktop-macos.$1\"");
    expect(source).toContain("shasum -a 256");
    expect(source).toContain("downloaded archive size does not match");
    expect(source).toContain("lipo -archs");
    expect(source).toContain("Harness is running from");
    expect(source).toContain('"Downloading Harness ${VERSION}…"');
    expect(source).not.toContain('"Downloading Harness $VERSION…"');
  });

  it("selects and verifies the matching Linux architecture alongside macOS", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain('case "$PLATFORM" in');
    expect(source).toContain("Darwin");
    expect(source).toContain("Linux");
    expect(source).toContain('aarch64 | arm64)');
    expect(source).toContain('RELEASE_ARCH="arm64"');
    expect(source).toContain('x86_64 | amd64)');
    expect(source).toContain('RELEASE_ARCH="x64"');
    expect(source).toContain('OTA_KEY="desktop-linux-$RELEASE_ARCH"');
    expect(source).toContain('APP_DIR="${HARNESS_DESKTOP_APP_DIR:-$HOME/.local/opt}"');
    expect(source).toContain("sha256sum");
    expect(source).toContain("Harness-linux-$RELEASE_ARCH.AppImage");
    expect(source).toContain("Harness-linux-${RELEASE_ARCH}.AppImage");
    expect(source).toContain("chmod +x");
    expect(source).not.toContain("tar -xzf");
    expect(source).not.toContain("currently ships x86_64 builds only");
    // No jq/python3/plutil dependency for the Linux branch's `require_command` list — the sed/grep
    // extraction test below proves those tools aren't actually needed to parse the manifest.
    const linuxRequireCommands = source
      .slice(source.indexOf('OTA_KEY="desktop-linux-$RELEASE_ARCH"'))
      .match(/for command_name in ([^;]+);/)?.[1];
    expect(linuxRequireCommands).toBeDefined();
    expect(linuxRequireCommands).not.toMatch(/\b(jq|python3|plutil)\b/);
  });

  it.each([
    [
      "x64",
      "1.2.5",
      "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
      41230011,
    ],
    [
      "arm64",
      "1.0.1",
      "b07ed4329bb2d83afaa9a1cdb89c2d9125d06972e10fea68e29c8308e41ea3a8",
      11879266,
    ],
  ])(
    "extracts the desktop-linux-%s manifest entry with sed/grep only",
    (architecture, expectedVersion, expectedSha256, expectedSize) => {
      const metadataPath = join(process.cwd(), "harness-desktop-metadata-test.json");
      writeFileSync(
        metadataPath,
        JSON.stringify(
          {
            "desktop-macos": {
              version: "1.2.4",
              url: "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.2.4/Harness-macos.zip",
              sha256: "a".repeat(64),
              size: 45231920,
            },
            "desktop-linux-x64": {
              version: "1.2.5",
              url: "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.2.5/Harness-linux-x64.AppImage",
              sha256: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
              size: 41230011,
            },
            "desktop-linux-arm64": {
              version: "1.0.1",
              url: "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.1/Harness-linux-arm64.AppImage",
              sha256: "b07ed4329bb2d83afaa9a1cdb89c2d9125d06972e10fea68e29c8308e41ea3a8",
              size: 11879266,
            },
          },
          null,
          2,
        ),
      );

      const script = `
      OTA_KEY="desktop-linux-${architecture}"
      METADATA_BLOCK="$(sed -n "/\\"\${OTA_KEY}\\": {/,/^  }/p" "${metadataPath}")"
      metadata_value() {
        printf '%s\\n' "$METADATA_BLOCK" | grep "\\"$1\\":" | head -n1 \\
          | sed -E 's/.*"'"$1"'": *"?([^",]*)"?,?$/\\1/' \\
          | tr -d '[:space:]'
      }
      printf 'version=%s\\n' "$(metadata_value version)"
      printf 'url=%s\\n' "$(metadata_value url)"
      printf 'sha256=%s\\n' "$(metadata_value sha256)"
      printf 'size=%s\\n' "$(metadata_value size)"
    `;
      const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`version=${expectedVersion}`);
      expect(result.stdout).toContain(
        `url=https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/${expectedVersion}/Harness-linux-${architecture}.AppImage`,
      );
      expect(result.stdout).toContain(`sha256=${expectedSha256}`);
      expect(result.stdout).toContain(`size=${expectedSize}`);

      unlinkSync(metadataPath);
    },
  );

  it.each(["Darwin", "Linux"] as const)("%s installs the release's own file and starts it", (os) => {
    const run = install(os);

    expect(run.result.stderr).toBe("");
    expect(run.result.status).toBe(0);
    expect(run.requested).toEqual([MANIFEST_URL, RELEASE_URLS[os]]);
    expect(run.placed).toBe(os === "Darwin" ? ARCHIVE : APPIMAGE);
    expect(run.result.stdout).toContain(`Harness ${VERSION} installed at ${run.place}\n`);
    if (os === "Darwin") expect(run.opened).toEqual([run.place]);
  });

  // A stalled CDN would hang the line, and an endless one would fill the disk before the size check.
  it.each(["Darwin", "Linux"] as const)(
    "%s downloads over https only, never stalls, and takes no more than the file's size",
    (os) => {
      const run = install(os);
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
      expect(flag(run.curl[1], "--max-filesize")).toBe(String(sums(os === "Darwin" ? ARCHIVE : APPIMAGE).size));
    },
  );

  // curl before 8.4 applies --max-filesize only to a size the server names: the download stops the rest itself.
  it.each([
    ["Darwin", "manifest", "could not download desktop metadata"],
    ["Darwin", "release", `could not download Harness ${VERSION}`],
    ["Linux", "manifest", "could not download desktop metadata"],
    ["Linux", "release", `could not download Harness ${VERSION}`],
  ] as const)("%s stops a %s download whose server never stops sending", (os, endless, reason) => {
    const run = install(os, { endless });

    expect(run.result.status).toBe(1);
    // curl names its own failure before it.
    expect(run.result.stderr.trimEnd().split("\n").at(-1)).toBe(`Harness desktop installer: ${reason}`);
    // A body past its size is no transport failure: it is never fetched again.
    expect(new Set(run.requested).size).toBe(run.requested.length);
    expect(run.placed).toBeNull();
    expect(run.ran).toEqual([]);
  });

  // A transfer can break midway: the download starts again from an empty file, a bounded number of times.
  it.each([
    ["Darwin", "manifest"],
    ["Darwin", "release"],
    ["Linux", "manifest"],
    ["Linux", "release"],
  ] as const)("%s downloads the %s again from the start when its transfer breaks", (os, download) => {
    const run = install(os, { breaks: { download, times: 2 } });

    expect(run.result.stderr).toBe("");
    expect(run.result.status).toBe(0);
    expect(run.requested).toHaveLength(4);
    expect(run.placed).toBe(os === "Darwin" ? ARCHIVE : APPIMAGE);
  });

  // curl -f names every HTTP error 22: a CDN's 5xx or 429 is likelier than a 404, which costs a few seconds retried.
  it.each(["Darwin", "Linux"] as const)("%s downloads the release again when the server answers an HTTP error", (os) => {
    const run = install(os, { breaks: { download: "release", times: 1, status: 22 } });

    expect(run.result.stderr).toBe("");
    expect(run.result.status).toBe(0);
    expect(run.requested).toHaveLength(3);
    expect(run.placed).toBe(os === "Darwin" ? ARCHIVE : APPIMAGE);
  });

  it.each(["Darwin", "Linux"] as const)("%s gives up on a download whose transfer keeps breaking", (os) => {
    const run = install(os, { breaks: { download: "release", times: 3 } });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(`Harness desktop installer: could not download Harness ${VERSION}\n`);
    expect(run.requested).toEqual([MANIFEST_URL, ...Array(3).fill(RELEASE_URLS[os])]);
    expect(run.placed).toBeNull();
  });

  // The cap binds the download's write alone: a limit on curl would stop its other writes, and on Linux even an append.
  it.each(["Darwin", "Linux"] as const)("%s caps only the download, never curl's other writes", (os) => {
    const run = install(os, { curlWrites: true });

    expect(run.result.stderr).toBe("");
    expect(run.result.status).toBe(0);
    expect(statSync(join(run.dir, "log", "curl-own")).size).toBe(65536);
  });

  // curl collapses dot segments, so a glob's `*` matching `../..` would download from another bucket.
  it.each([
    ["Darwin", "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/../../../attacker-bucket/Harness-macos.zip"],
    ["Darwin", "https://cdn.autonomous.ai/harness/desktop/1.2.4/../../device/1.2.4/Harness-macos.zip"],
    ["Darwin", "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-macos.zip"],
    ["Linux", "https://cdn.autonomous.ai/harness/desktop/../../../attacker-bucket/Harness-linux-x64.AppImage"],
  ] as const)("%s refuses a URL outside the release's own folder: %s", (os, url) => {
    const run = install(os, { url });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("desktop metadata points outside the Harness desktop release bucket");
    expect(run.requested).toEqual([MANIFEST_URL]);
  });

  // pgrep -f reads an extended regex: unescaped, each of these paths fails to match itself, or is no regex at all.
  it.each([
    ["Darwin", "Apps+x"],
    ["Darwin", "Apps (old)"],
    ["Linux", "opt+x"],
    ["Linux", "a$b"],
    ["Linux", "a[b"],
  ] as const)("%s refuses while Harness runs from an app folder a regex reads otherwise: %s", (os, appDir) => {
    const run = install(os, { appDir, running: (executable) => executable });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(
      `Harness desktop installer: Harness is running from ${run.place}. Quit it, then run this installer again.\n`,
    );
    // On Linux the place is this user's own: another user's process naming it is not Harness here. A Mac's
    // /Applications is everyone's.
    expect(run.pgrep).toEqual([
      os === "Linux"
        ? ["-u", String(process.getuid!()), "-f", commandPattern(run.executable)]
        : ["-f", commandPattern(run.executable)],
    ]);
  });

  // A Linux folder name is any bytes, and Ubuntu 26.04's mktemp (uutils) refuses a template that is not UTF-8. macOS
  // keeps only UTF-8 names, so there such a folder cannot exist.
  it.runIf(process.platform === "linux")("Linux installs when the app folder is not UTF-8", () => {
    const run = install("Linux", { latin1: true });

    expect(run.result.stderr).toBe("");
    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("installed at");
  });

  it.each(["Darwin", "Linux"] as const)("%s installs while a process only names the app, as an editor does", (os) => {
    const run = install(os, { running: (executable) => `vi ${executable}` });

    expect(run.result.status).toBe(0);
    expect(run.placed).toBe(os === "Darwin" ? ARCHIVE : APPIMAGE);
  });

  it("Linux replaces the AppImage in one move: something is always at the place", () => {
    const run = install("Linux", { before: { "app/Harness.AppImage": "the copy before" } });

    expect(run.result.status).toBe(0);
    expect(run.placed).toBe(APPIMAGE);
    expect(run.mv.length).toBeGreaterThan(0);
    expect(run.mv.filter((state) => state !== "there")).toEqual([]);
  });

  it("Linux refuses a folder at the place and leaves it", () => {
    const run = install("Linux", { before: { "app/Harness.AppImage/a file": "kept" } });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toBe(
      `Harness desktop installer: ${run.place} is a folder. Move it away, then run this installer again.\n`,
    );
    expect(run.requested).toEqual([MANIFEST_URL]);
    expect(readFileSync(join(run.place, "a file"), "utf8")).toBe("kept");
  });

  // Ctrl-C, a closed terminal or a kill: the script stops there and starts nothing.
  it.each([
    ["INT", 130],
    ["HUP", 129],
    ["TERM", 143],
  ])("Linux stops at %s and starts nothing", (signal, status) => {
    const run = install("Linux", { signal });

    expect(run.result.status).toBe(status);
    expect(run.result.stdout).not.toContain("installed at");
    expect(run.ran).toEqual([]);
  });

  // A folder cannot replace another in one move: stopped between the two, the script puts the previous app back.
  it.each([
    ["INT", 130],
    ["HUP", 129],
    ["TERM", 143],
  ])("Darwin stopped at %s between its moves keeps the previous app and opens nothing", (mvSignal, status) => {
    const run = install("Darwin", {
      mvSignal,
      before: { "app/Harness.app/Contents/MacOS/Harness": "the app before" },
    });

    expect(run.result.status).toBe(status);
    expect(run.placed).toBe("the app before");
    expect(run.opened).toEqual([]);
    expect(readdirSync(join(run.dir, "app"))).toEqual(["Harness.app"]);
  });
});
