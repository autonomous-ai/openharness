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

/**
 * Stub uname, curl, plutil, ditto, lipo, open, pgrep and mv, first on PATH, steered by STUB_* variables; shasum,
 * sha256sum, sed and the rest are real. curl serves the manifest at its URL and the release file at any other,
 * recording each URL. plutil answers the manifest's desktop-macos fields from files and an app's version from its
 * Info.plist, which ditto writes beside the executable it unpacks. mv records whether something is at the place, moves,
 * then, the first time, sends STUB_MV_SIGNAL to the script. Written once: macOS checks each new executable on its first
 * run.
 */
const bin = mkdtempSync(join(tmpdir(), "harness-install-bin-"));
const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stub("uname", `case "$1" in -s) echo "$STUB_OS" ;; -m) echo x86_64 ;; *) exit 1 ;; esac`);
stub(
  "curl",
  `out= url= prev=
for arg; do
  if [ "$prev" = -o ]; then out="$arg"; else case "$arg" in -*) ;; *) url="$arg" ;; esac; fi
  prev="$arg"
done
printf '%s\\n' "$url" >> "$STUB_LOG/requested"
if [ "$url" = "$STUB_MANIFEST_URL" ]; then cp "$STUB_SERVED/metadata.json" "$out"; else cp "$STUB_SERVED/release" "$out"; fi`,
);
stub("plutil", `case "$2" in CFBundleShortVersionString) cat "$4" ;; *) cat "$STUB_SERVED/plutil/$2" ;; esac`);
stub(
  "ditto",
  `app="$4/Harness.app/Contents"
mkdir -p "$app/MacOS" && cp "$3" "$app/MacOS/Harness" && chmod 755 "$app/MacOS/Harness" \\
  && cp "$STUB_SERVED/plutil/desktop-macos.version" "$app/Info.plist"`,
);
stub("lipo", "echo x86_64 arm64");
stub("open", `printf '%s\\n' "$@" >> "$STUB_LOG/open"`);
stub("pgrep", "exit 1");
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
  /** Files written before the run, by path under the run's folder. */
  before?: Record<string, string>;
  /** A signal `--appimage-extract` sends the script, as a Ctrl-C or a closed terminal does. */
  signal?: string;
  /** A signal the first move sends the script once it has moved. */
  mvSignal?: string;
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

  const place = join(dir, "app", APP_NAMES[os]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, "home"),
    HARNESS_DESKTOP_APP_DIR: join(dir, "app"),
    HARNESS_DESKTOP_METADATA_URL: MANIFEST_URL,
    STUB_OS: os,
    STUB_LOG: log,
    STUB_SERVED: served,
    STUB_MANIFEST_URL: MANIFEST_URL,
    STUB_PLACE: place,
    STUB_SIGNAL: options.signal ?? "",
    STUB_MV_SIGNAL: options.mvSignal ?? "",
  };
  // exec keeps the pid: the script's own, for the stubs that signal it.
  const result = spawnSync("sh", ["-c", 'export STUB_SCRIPT_PID=$$; exec sh "$0"', installer], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  const read = (name: string) => (existsSync(join(log, name)) ? readFileSync(join(log, name), "utf8") : "");
  const executable = os === "Darwin" ? join(place, "Contents", "MacOS", "Harness") : place;
  return {
    result,
    dir,
    place,
    requested: read("requested").split("\n").filter(Boolean),
    /** At each mv, whether something was at the place. */
    mv: read("mv").split("\n").filter(Boolean),
    opened: read("open").split("\n").filter(Boolean),
    ran: read("ran").split("\n").filter(Boolean),
    placed: existsSync(executable) && statSync(executable).isFile() ? readFileSync(executable, "utf8") : null,
  };
}

describe("desktop-install.sh", () => {
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
