import { fork, spawn, spawnSync } from "child_process";
import { dirname, join } from "path";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, expect, it, vi } from "vitest";

// vitest runs from cli/, so this is cli/scripts/install.sh — the file published to the CDN.
const installer = join(process.cwd(), "scripts", "install.sh");
// Its local twin, which installs this checkout's build.
const installCli = join(process.cwd(), "scripts", "install-cli.sh");

// Every test here runs the real installer under /bin/sh, with fake commands it writes fresh. On macOS the
// first run of a freshly written executable waits on the system's check of it: 220 ms at a load of 100,
// 600 ms with 12 busy loops more, against 16 ms for one already run (2026-10-06). A test runs up to a
// dozen of them, and vitest's 5 s timed out 11 of these tests in one loaded unit run. The tests that
// already set 20 s did so for the same reason.
vi.setConfig({ testTimeout: 20_000 });

describe('installer interrupted downloads', () => {
  it('recovers real truncated HTTP responses without mixing manifest or binary bytes', async () => {
    const { createServer } = await import('node:http');
    const scratch = mkdtempSync(join(tmpdir(), 'harness-download-http-'));
    const bytes = Buffer.from([0, 1, 255, 10, 2, 0, 42, 128]);
    const counts = new Map<string, number>();
    const server = createServer((req, res) => {
      const route = req.url!;
      const count = (counts.get(route) ?? 0) + 1;
      counts.set(route, count);
      const body = route === '/manifest' ? Buffer.from('{"version":"verified"}') : bytes;
      res.writeHead(200, { 'Content-Length': body.length, 'Connection': 'close' });
      res.end(count < 3 ? body.subarray(0, 3) : body);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const source = readFileSync(installer, 'utf8');
      const fn = source.slice(source.indexOf('download() {'), source.indexOf('# sha256 is'));
      const child = spawn('/bin/sh', ['-ec', fn + '\ndownload "$URL/manifest"\ndownload "$URL/binary" -o "$TARGET"'], {
        env: { ...process.env, URL: `http://127.0.0.1:${port}`, TARGET: join(scratch, 'binary') },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data });
      child.stderr.on('data', data => { stderr += data });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject); child.on('close', resolve);
      });
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ version: 'verified' });
      expect(readFileSync(join(scratch, 'binary'))).toEqual(bytes);
      // Only the two paths the installer asked for. A loopback server is open to every process on the
      // machine, and on a busy one something probed it with GET /v1/models mid-test (release check,
      // 2026-10-06), which is not the installer's doing.
      expect({ '/manifest': counts.get('/manifest'), '/binary': counts.get('/binary') }).toEqual({ '/manifest': 3, '/binary': 3 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([6, 7, 18, 28, 35, 52, 55, 56, 92])('retries curl error %i and discards partial manifest output', code => {
    const scratch = mkdtempSync(join(tmpdir(), 'harness-download-'));
    try {
      writeCommand(scratch, 'curl', [
        'n=0; [ ! -f "$COUNT" ] || n=$(cat "$COUNT")',
        'n=$((n + 1)); echo "$n" > "$COUNT"',
        `if [ "$n" -lt 3 ]; then printf 'broken partial JSON'; exit ${code}; fi`,
        'printf \'{"version":"test"}\\n\'',
      ]);
      writeCommand(scratch, 'sleep', ['exit 0']);
      const source = readFileSync(installer, 'utf8');
      const fn = source.slice(source.indexOf('download() {'), source.indexOf('# sha256 is'));
      const result = spawnSync('/bin/sh', ['-c', fn + '\ndownload https://example.invalid/manifest'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin`, COUNT: join(scratch, 'count') },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: 'test' });
      expect(readFileSync(join(scratch, 'count'), 'utf8').trim()).toBe('3');
      expect(result.stderr).toContain('retrying download (3/3)');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it.each([[35, 3], [22, 1], [60, 1], [23, 1]])('bounds failures and preserves curl status %i', (code, attempts) => {
    const scratch = mkdtempSync(join(tmpdir(), 'harness-download-fail-'));
    try {
      writeCommand(scratch, 'curl', [
        'echo "$*" >> "$CALLS"', `printf partial; exit ${code}`,
      ]);
      writeCommand(scratch, 'sleep', ['exit 0']);
      const source = readFileSync(installer, 'utf8');
      const fn = source.slice(source.indexOf('download() {'), source.indexOf('# sha256 is'));
      const result = spawnSync('/bin/sh', ['-c', fn + '\ndownload https://example.invalid/runtime -o "$TARGET"'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin`,
          CALLS: join(scratch, 'calls'), TARGET: join(scratch, 'download') },
      });
      expect(result.status).toBe(code);
      expect(result.stdout).toBe('');
      const calls = readFileSync(join(scratch, 'calls'), 'utf8').trim().split('\n');
      expect(calls).toHaveLength(attempts);
      expect(calls[0]).toContain('--connect-timeout 20 --max-time 600');
      expect(calls[0]).toContain(`-o ${join(scratch, 'download')}`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

const writeCommand = (directory: string, name: string, lines: string[]) => {
  const path = join(directory, name);
  writeFileSync(path, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(path, 0o700);
};

// The system name the scripts read to decide where Harness lives: only Linux runs the XDG rule.
const writeUname = (directory: string, os: string) =>
  writeCommand(directory, "uname", [`if [ "$1" = "-m" ]; then printf 'x86_64\\n'; else printf '${os}\\n'; fi`]);

// A managed Node where step 2 looks for one: in `runtime`, recorded in its current-node. It is this test's own Node.
const managedNode = (runtime: string) => {
  const bin = join(runtime, "node-v24.0.0-linux-x64", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(runtime, "current-node"), `${join(bin, "node")}\n`);
  return join(bin, "node");
};

// Where Harness goes, by the home it finds: the folders that exist, the system, the managed Node's runtime folder
// and the cli folder the launcher must name.
const LAYOUTS: { home: string; os: string; made: string[]; runtime: string; cli: string }[] = [
  { home: "a fresh Linux home", os: "Linux", made: [], runtime: ".local/state/harness/runtime", cli: ".local/share/harness/cli" },
  { home: "a Linux home still on ~/.harness", os: "Linux", made: [".harness"], runtime: ".harness/runtime", cli: ".harness/cli" },
  { home: "a Mac", os: "Darwin", made: [".local/share/harness"], runtime: ".harness/runtime", cli: ".harness/cli" },
];

// The constants, from the manifest URLs through the first-run check: every step reads them.
const constantsOf = (source: string) =>
  source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# Shared by every download"));

// A `brew` that writes down any call to it, so a test can say Homebrew was never run.
const writeRecordingBrew = (directory: string, record: string) =>
  writeCommand(directory, "brew", [`printf '%s\\n' "$*" >> '${record}'`, "exit 99"]);

// What the CLI runs on Linux besides tmux — the only other command step 1 asks about.
const writeLinuxHostCommands = (directory: string) => {
  writeCommand(directory, "ps", ["exit 0"]);
};

// Step 1 of the script — the host-requirements ladder — as one runnable unit.
// From the constants (RUNTIME_DIR, BIN_DIR, the manifest URLs) through the whole host step.
const hostSetupOf = (source: string) =>
  source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# 2. Resolve the Node"));

// The download-tools check that guards the Node download, with the helpers it calls.
const downloadToolsOf = (source: string) =>
  source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("tmux_runs()")) +
  source.slice(
    source.indexOf("  # Fetching, unpacking and verifying the runtime"),
    source.indexOf('  echo "▸ Installing the Harness Node runtime'),
  );

// Steps 5 and 6 — the verification, the wordmark and the guide, and the PATH reminder — as one
// runnable unit, from the constants down so BIN_DIR and LAUNCHER resolve the way they do in the script.
const finaleOf = (source: string) =>
  source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# Shared by every download")) +
  source.slice(source.indexOf("# 5. Final verification"));

// A fake's first line when it reads its stdin to the end, as `brew` read the piped script on
// 2026-11-17. By its full path: some tests' PATH holds only the fakes.
const DRAIN = "/bin/cat >/dev/null";
const drained = (drain: boolean, lines: string[]) => (drain ? [DRAIN, ...lines] : lines);

// A ~/.local/bin with a launcher that answers `version`, plus the node and tmux the verification runs.
const installedFixture = (scratch: string, drain = false) => {
  const home = join(scratch, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeCommand(bin, "harness", drained(drain, ['[ "$1" = version ] && echo 0.2.60', "exit 0"]));
  writeCommand(scratch, "node", drained(drain, ["exit 0"]));
  writeCommand(scratch, "tmux", drained(drain, ['echo "tmux 3.7"']));
  return { home, node: join(scratch, "node") };
};

// A fake CDN: `curl -o` writes the archive, plain `curl` prints the manifest. The archive wraps a
// fake tmux so the whole managed path — fetch, verify, unpack, record, link — runs for real.
const managedFixture = (scratch: string, tamperSha = false, drain = false) => {
  const home = join(scratch, "home");
  const root = "tmux-9.9-darwin-arm64";
  const stage = join(scratch, "stage", root, "bin");
  mkdirSync(stage, { recursive: true });
  writeCommand(stage, "tmux", drained(drain, ["printf 'tmux 9.9\\n'"]));
  const archive = join(scratch, `${root}.tar.gz`);
  spawnSync("tar", ["-czf", archive, "-C", join(scratch, "stage"), root]);
  const sha = spawnSync("shasum", ["-a", "256", archive], { encoding: "utf8" }).stdout.split(" ")[0];
  const manifest = JSON.stringify({
    tmux: {
      "darwin-arm64": {
        version: "9.9",
        url: "https://cdn.example/tmux.tar.gz",
        sha256: tamperSha ? "0".repeat(64) : sha,
        size: 1,
        archiveRoot: root,
      },
    },
  }, null, 2);
  writeFileSync(join(scratch, "manifest.json"), manifest);
  // The ladder's first rung is `command -v tmux && tmux -V`, and PATH below still includes /usr/bin
  // — where ubuntu-latest (CI) ships a real tmux 3.4, so on that runner the script found it, said
  // "tmux ready (tmux 3.4)" and never took the managed path these tests exist for. A broken tmux
  // in the fixture dir (first on PATH) fails that rung everywhere; once the managed build is
  // linked, the script puts BIN_DIR ahead of PATH, so the 9.9 fake wins from then on.
  writeCommand(scratch, "tmux", ["exit 127"]);
  writeCommand(scratch, "curl", [
    `printf '%s\\n' "$*" >> '${join(scratch, "curl-invocations")}'`,
    `case "$*" in *"-o "*) cp '${archive}' "$4" ;; *) cat '${join(scratch, "manifest.json")}' ;; esac`,
  ]);
  writeCommand(scratch, "uname", [`if [ "$1" = "-m" ]; then printf 'arm64\\n'; else printf 'Darwin\\n'; fi`]);
  mkdirSync(home, { recursive: true });
  return { home, root };
};

// The helpers plus the grid step alone, as one runnable unit.
const gridStepOf = (source: string) =>
  source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# 1. Host requirements")) +
  source.slice(source.indexOf("# 3b. The managed grid"), source.indexOf("# 3c. hn's binary"));

const gridFixture = (scratch: string, tamperSha = false, drain = false) => {
  const home = join(scratch, "home");
  const root = "grid-9.9-darwin-arm64";
  const stage = join(scratch, "stage", root, "bin");
  mkdirSync(stage, { recursive: true });
  writeCommand(stage, "grid", drained(drain, ["printf 'grid 9.9\\n'"]));
  const archive = join(scratch, `${root}.tar.gz`);
  spawnSync("tar", ["-czf", archive, "-C", join(scratch, "stage"), root]);
  const sha = spawnSync("shasum", ["-a", "256", archive], { encoding: "utf8" }).stdout.split(" ")[0];
  writeFileSync(join(scratch, "manifest.json"), JSON.stringify({
    grid: {
      "darwin-arm64": {
        version: "9.9",
        url: "https://cdn.example/grid.tar.gz",
        sha256: tamperSha ? "0".repeat(64) : sha,
        size: 1,
        archiveRoot: root,
      },
    },
  }, null, 2));
  writeCommand(scratch, "curl", [
    `printf '%s\\n' "$*" >> '${join(scratch, "curl-invocations")}'`,
    `case "$*" in *"-o "*) cp '${archive}' "$4" ;; *) cat '${join(scratch, "manifest.json")}' ;; esac`,
  ]);
  writeCommand(scratch, "uname", [`if [ "$1" = "-m" ]; then printf 'arm64\\n'; else printf 'Darwin\\n'; fi`]);
  mkdirSync(home, { recursive: true });
  return { home, root };
};

// The constants and helpers (install_hn among them), then step 3c alone.
const hnStepOf = (source: string) =>
  source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# 1. Host requirements")) +
  source.slice(source.indexOf("# 3c. hn's binary"), source.indexOf("# 4. Ensure ~/.local/bin"));

const hnFixture = (scratch: string, { tamper = false, runs = true, drain = false } = {}) => {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const binary = join(scratch, "harness-tui-darwin-arm64");
  writeFileSync(binary, ["#!/bin/sh", ...drained(drain, [runs ? "echo 'hn 0.1.0 (tmux 3.5a)'" : "exit 1"]), ""].join("\n"));
  chmodSync(binary, 0o755);
  const sha = spawnSync("shasum", ["-a", "256", binary], { encoding: "utf8" }).stdout.split(" ")[0];
  // As release-tui.yml writes it: jq's pretty print, one build per platform.
  writeFileSync(join(scratch, "manifest.json"), JSON.stringify({
    version: "0.1.0",
    builds: {
      "darwin-x64": { url: "https://cdn.example/harness-tui-darwin-x64", sha256: "1".repeat(64) },
      "darwin-arm64": { url: "https://cdn.example/harness-tui-darwin-arm64", sha256: tamper ? "0".repeat(64) : sha },
    },
  }, null, 2));
  writeCommand(scratch, "curl", [
    `printf '%s\\n' "$*" >> '${join(scratch, "curl-invocations")}'`,
    `case "$*" in *"-o "*) cp '${binary}' "$4" ;; *) cat '${join(scratch, "manifest.json")}' ;; esac`,
  ]);
  writeCommand(scratch, "uname", [`if [ "$1" = "-m" ]; then printf 'arm64\\n'; else printf 'Darwin\\n'; fi`]);
  return { home, tui: join(home, ".harness", "bin", "harness-tui") };
};

// Step 2's choice of a Node, up to the download, with RUNTIME_DIR at `runtime`.
const nodeSelectionOf = (source: string, runtime: string) =>
  `RUNTIME_DIR='${runtime}'; CURRENT_NODE_FILE="$RUNTIME_DIR/current-node"; ` +
  source.slice(source.indexOf("# Prints the major version"), source.indexOf('if [ -z "$NODE_BIN" ]; then\n  # Fetch'));

// The Node the desktop app hands over, at a path with a space in it: the launcher must quote it.
const handedNode = (scratch: string) => {
  const bin = join(scratch, "harness node", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  return join(bin, "node");
};

// Steps 2 and 3 for real, after the constants, with `uname` answering `os`: the Node step 2 settles on
// (`nodeBinary`, or the managed one the runtime folder records), then the Node that writes the launchers,
// against a local manifest server.
const runCliStep = async (scratch: string, home: string, { os = "Darwin", nodeBinary = "" } = {}) => {
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const files: Record<string, string> = { "/cli.js": "console.log('cli')\n", "/notify.mjs": "export {}\n" };
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.url === "/manifest.json") {
      res.end(JSON.stringify({ cli: { version: "9.9.9", cli: { url: `${base}/cli.js`, sha256: sha(files["/cli.js"]) }, notify: { url: `${base}/notify.mjs`, sha256: sha(files["/notify.mjs"]) } } }));
    } else if (files[req.url ?? ""]) res.end(files[req.url ?? ""]);
    else { res.statusCode = 404; res.end() }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const source = readFileSync(installer, "utf8");
  writeUname(scratch, os);
  const script = constantsOf(source) +
    source.slice(source.indexOf("# Prints the major version"), source.indexOf('if [ -z "$NODE_BIN" ]; then\n  # Fetch')) +
    source.slice(source.indexOf("# 3. Fetch manifest"), source.indexOf("# 3b. The managed grid"));
  const child = spawn("/bin/sh", ["-c", script], {
    env: { HOME: home, PATH: `${scratch}:/usr/bin:/bin`, HARNESS_METADATA_URL: `http://127.0.0.1:${port}/manifest.json`, HARNESS_NODE_BINARY: nodeBinary },
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d });
  child.stderr.on("data", (d) => { out += d });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  server.close();
  return { code, out };
};

/** What tells the installer an agent ran it: removed from this test's own environment, which may be an agent's. */
const AGENT_KEYS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AI_AGENT", "HARNESS_AGENT_SESSION"];

const runFinale = (mode: "standalone" | "desktop", pathHasBin: boolean, script = finaleOf, agent: Record<string, string> = {}) => {
  const source = readFileSync(installer, "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "harness-finale-"));
  try {
    const { home, node } = installedFixture(scratch);
    const bin = join(home, ".local", "bin");
    return spawnSync("/bin/sh", ["-c", script(source)], {
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !AGENT_KEYS.includes(key))),
        ...agent,
        HOME: home,
        INSTALL_MODE: mode,
        NODE_BIN: node,
        PATH: pathHasBin ? `${bin}:${scratch}:/usr/bin:/bin` : `${scratch}:/usr/bin:/bin`,
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const LOGO = [
  "    _",
  "   | |__   __ _ _ __ _ __   ___  ___ ___",
  "   | '_ \\ / _` | '__| '_ \\ / _ \\/ __/ __|",
  "   | | | | (_| | |  | | | |  __/\\__ \\__ \\",
  "   |_| |_|\\__,_|_|  |_| |_|\\___||___/___/",
];

describe("scripts/install.sh: what it says once it is done", () => {
  it("ends with the wordmark and the guide — login, start, remote password, then harness remote — in that order", () => {
    const result = runFinale("standalone", true);
    expect(result.status).toBe(0);
    const out = result.stdout;
    for (const line of LOGO) expect(out).toContain(line);
    expect(out).toContain("✓ harness 0.2.60 installed.");
    const order = ["harness login", "harness start", "harness remote-password set", "harness remote  ", "harness machines", "harness status", "harness --help"];
    const at = order.map((command) => out.indexOf(command));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(out.indexOf(LOGO[1])).toBeLessThan(out.indexOf("harness login"));
    // Every command is explained, and nothing is run: the fixture launcher only answered `version`.
    expect(out).toContain("# 1. sign in");
    expect(out).toContain("# 3. let your OTHER machines reach this one");
    expect(out).not.toContain("'harness' is installed in ~/.local/bin");
  }, 20_000);

  it("the PATH reminder still comes after the guide when ~/.local/bin is not on PATH", () => {
    const out = runFinale("standalone", false).stdout;
    expect(out.indexOf("harness --help")).toBeLessThan(out.indexOf("'harness' is installed in ~/.local/bin"));
  }, 20_000);

  // The installer puts ~/.local/bin on its own PATH while it runs (the tmux step): the advice is about
  // the terminal it runs in. Checked against its own, it never printed, and on a fresh Mac the `hn`
  // it said to type was "command not found" (macOS VM, 2026-10-09).
  const finaleAfterInstallOf = (source: string) =>
    source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# Shared by every download")) +
    'export PATH="$BIN_DIR:$PATH"\n' +
    source.slice(source.indexOf("# 5. Final verification"));

  it("starts with a command this terminal can run, and says how to get `hn` by name, whatever the install did to its own PATH", () => {
    const out = runFinale("standalone", false, finaleAfterInstallOf).stdout;
    expect(out).toMatch(/^ {6}~\/\.local\/bin\/hn +# start locally; no login required$/m);
    expect(out).toContain("'harness' is installed in ~/.local/bin");
    const onPath = runFinale("standalone", true, finaleAfterInstallOf).stdout;
    expect(onPath).toMatch(/^ {6}hn {29}# start locally; no login required$/m);
    expect(onPath).not.toContain("'harness' is installed in ~/.local/bin");
  }, 20_000);

  it("tells an agent what to run next and what only the person can do, after the person's guide", () => {
    const out = runFinale("standalone", true).stdout;
    expect(out).toMatch(/^ {6}Next: harness start +\(starts Harness here; no account is needed\)$/m);
    expect(out).toMatch(/^ {6}Then: harness whoami +\(whether you may start harnesses, and if not, what to ask the person\)$/m);
    expect(out).toContain("harness login");
    expect(out).toContain("harness settings agents-start-agents on");
    expect(out).toContain("https://harness.autonomous.ai/agents");
    // The person reads their guide first.
    expect(out.indexOf("harness --help")).toBeLessThan(out.indexOf("Next: harness start"));
  }, 20_000);

  it("puts that first when an agent ran it, before the person's guide", () => {
    for (const agent of [{ CLAUDECODE: "1" }, { CODEX_THREAD_ID: "t" }, { AI_AGENT: "cursor" }] as Array<Record<string, string>>) {
      const out = runFinale("standalone", true, finaleOf, agent).stdout;
      expect(out.indexOf("Next: harness start")).toBeGreaterThan(0);
      expect(out.indexOf("Next: harness start")).toBeLessThan(out.indexOf("harness login  "));
      // Said once.
      expect(out.split("Next: harness start")).toHaveLength(2);
    }
  }, 20_000);

  it("desktop mode gets the one line and no guide: the app takes the person through sign-in", () => {
    const out = runFinale("desktop", true).stdout;
    expect(out).toContain("harness 0.2.60 installed.");
    expect(out).not.toContain("Get started");
    expect(out).not.toContain(LOGO[1]);
    expect(out).not.toContain("Next: harness start");
  }, 20_000);
});

describe("scripts/install.sh command contract", () => {
  it("rejects a legacy machine-token argument before installing", () => {
    const result = spawnSync("sh", [installer, "legacy-token"], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no longer accepts a machine token");
    expect(result.stderr).toContain("harness login && harness start");
  });

  it("accepts only standalone default, explicit desktop mode or host mode", () => {
    const source = readFileSync(installer, "utf8");
    const parser = source.slice(0, source.indexOf('METADATA_URL='));

    const standalone = spawnSync("/bin/sh", ["-s"], {
      encoding: "utf8",
      input: parser,
    });
    const desktop = spawnSync("/bin/sh", ["-s", "--", "--desktop"], {
      encoding: "utf8",
      input: parser,
    });
    const host = spawnSync("/bin/sh", ["-s", "--", "--host"], {
      encoding: "utf8",
      input: parser,
    });
    const extra = spawnSync(
      "/bin/sh",
      ["-s", "--", "--desktop", "legacy-token"],
      { encoding: "utf8", input: parser },
    );

    expect(standalone.status).toBe(0);
    expect(desktop.status).toBe(0);
    expect(host.status).toBe(0);
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain("accepts no additional arguments");
  });

  it("accepts a desktop-supplied Node runtime and pins the launcher to it", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain('NODE_BIN="${HARNESS_NODE_BINARY:-}"');
    expect(source).toContain('HARNESS_NODE_BINARY="$NODE_BIN"');
    expect(source).toContain("const shellQuote");
    expect(source).toContain("exec ' + shellQuote(NODE)");
  });

  // The CLI runs on the runtime under ~/.harness/runtime, never on whatever `node` PATH happens to
  // resolve — the same rule the desktop app follows, so one cli.js is never driven by two Nodes.
  it("installs its own Node runtime rather than requiring one", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain("harness/runtime/metadata.json");
    expect(source).toContain('CURRENT_NODE_FILE="$RUNTIME_DIR/current-node"');
    // The runtime is recorded for the desktop app to find, and only after it has answered.
    expect(source).toContain('printf \'%s\\n\' "$NODE_BIN" > "$CURRENT_NODE_FILE"');
    // No Node yet at that point, so the checksum has to be taken with the platform's own tool.
    expect(source).toContain("shasum -a 256");
    expect(source).toContain("sha256sum");
    // The old behaviour — bail out and tell the user to go install Node — must not come back.
    expect(source).not.toContain("brew install node");
    expect(source).not.toContain("deb.nodesource.com");
  });

  // A fake `node` that only answers `-e` with a major version is enough: node_major reads nothing else.
  const nodeSelection = (major: string) => {
    const source = readFileSync(installer, "utf8");
    const scratch = mkdtempSync(join(tmpdir(), "harness-node-floor-"));
    try {
      const runtime = join(scratch, "runtime");
      const node = join(runtime, `node-v${major}`, "bin", "node");
      mkdirSync(join(runtime, `node-v${major}`, "bin"), { recursive: true });
      writeCommand(join(runtime, `node-v${major}`, "bin"), "node", [`printf ${major}`, "echo"]);
      writeFileSync(join(runtime, "current-node"), `${node}\n`);
      const out = spawnSync("/bin/sh", ["-c", `${nodeSelectionOf(source, runtime)}\nprintf '[%s]' "$NODE_BIN"`], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: scratch },
      });
      return { node, stdout: out.stdout };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  };

  // The CLI runs on 22 until the move is done, and its updater moves a managed 22 to 24 itself.
  it("replaces a managed Node below 22 and keeps 22 and 24", () => {
    expect(nodeSelection("20").stdout).toContain("[]");
    for (const major of ["22", "24"]) {
      const kept = nodeSelection(major);
      expect(kept.stdout).toContain(`[${kept.node}]`);
    }
  });

  it("names the floor an explicit Node override fails", () => {
    expect(readFileSync(installer, "utf8")).toContain("is older than Node 22");
  });

  it("refuses an unverified Node archive", () => {
    const source = readFileSync(installer, "utf8");

    expect(source).toContain('if [ "$node_got" != "$node_sha" ]; then');
    expect(source).toContain("failed checksum verification");
  });

  it("prepares and verifies required tmux before installing Node or Harness", () => {
    const source = readFileSync(installer, "utf8");
    const tmuxStep = source.indexOf("# 1. Host requirements");
    const nodeStep = source.indexOf("# 2. Resolve the Node");
    const cliStep = source.indexOf("# 3. Fetch manifest");

    expect(tmuxStep).toBeGreaterThan(-1);
    expect(nodeStep).toBeGreaterThan(tmuxStep);
    expect(cliStep).toBeGreaterThan(nodeStep);
    expect(source).toContain("install_managed_tmux");
    expect(source).toContain("install_with_apt $missing_host_packages");
    expect(source).toContain('if [ "$(id -u)" -eq 0 ]; then');
    expect(source).toContain('sudo apt-get "$@"');
    expect(source).not.toContain("sudo apt-get update &&");
    expect(source).toContain("tmux is required but did not pass verification");
    expect(source).toContain("exit 22");
    // Obtaining tmux never needs a compiler, Xcode or the Homebrew installer any more.
    expect(source).not.toContain("xcrun");
    expect(source).not.toContain("xcode-select");
    expect(source).not.toContain("Homebrew/install/HEAD/install.sh");
    expect(source).not.toContain("exit 20");
    expect(source).not.toContain("exit 21");
  });

  // The ladder, in source order: tmux is asked about first, a Homebrew prefix's bin only when tmux is
  // missing, the managed build for everything else. Homebrew itself is never run.
  it("looks in the Homebrew prefixes only without tmux, then downloads the managed build", () => {
    const source = readFileSync(installer, "utf8");
    const hostStep = source.slice(source.indexOf("# 1. Host requirements"));
    const darwin = hostStep.slice(hostStep.indexOf("  Darwin)"), hostStep.indexOf("  Linux)"));

    const tmuxCheck = darwin.indexOf("if tmux_runs; then");
    const prefixes = darwin.indexOf("for brew_prefix in ${HARNESS_HOMEBREW_PREFIXES:-/opt/homebrew /usr/local}; do");
    const managed = darwin.indexOf("install_managed_tmux");
    expect(tmuxCheck).toBeGreaterThan(-1);
    expect(prefixes).toBeGreaterThan(tmuxCheck);
    expect(managed).toBeGreaterThan(prefixes);
    for (const brewRun of ["command -v brew", "brew shellenv", "brew install --force-bottle", "Installing tmux via Homebrew"]) {
      expect(source).not.toContain(brewRun);
    }
    // The managed archive is checksum-pinned by the manifest and recorded for the daemon.
    expect(source).toContain("harness/runtime/tmux/metadata.json");
    expect(source).toContain('CURRENT_TMUX_FILE="$RUNTIME_DIR/current-tmux"');
    expect(source).toContain("tmux download failed checksum verification");
    expect(source).toContain('ln -sfn "$tmux_target/bin/tmux" "$BIN_DIR/tmux"');
  });

  it("does nothing on a Mac that already runs tmux", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-tmux-"));
    const invoked = join(scratch, "brew-invoked");

    try {
      writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
      writeCommand(scratch, "tmux", ["printf 'tmux 3.6\\n'"]);
      writeCommand(scratch, "brew", [`: > '${invoked}'`, "exit 99"]);
      writeCommand(scratch, "sudo", [`: > '${invoked}'`, "exit 99"]);
      writeCommand(scratch, "xcode-select", [`: > '${invoked}'`, "exit 99"]);

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: { ...process.env, INSTALL_MODE: "standalone", PATH: scratch },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("tmux ready");
      expect(result.stdout).not.toContain("Homebrew");
      expect(() => readFileSync(invoked, "utf8")).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // A Mac whose Homebrew is not on this shell's PATH (a Finder launch has launchd's bare one) and with
  // nothing to download from: only the prefixes can answer. The tmux first on PATH does not run,
  // because ubuntu-latest (CI) has a real one in /usr/bin.
  const prefixMac = (scratch: string) => {
    const home = join(scratch, "home");
    mkdirSync(home);
    writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
    writeCommand(scratch, "tmux", ["exit 127"]);
    writeCommand(scratch, "curl", [`: > '${join(scratch, "curl-invoked")}'`, "exit 99"]);
    return home;
  };
  const prefixWith = (scratch: string, name: string, tmux?: string) => {
    const bin = join(scratch, name, "bin");
    mkdirSync(bin, { recursive: true });
    writeRecordingBrew(bin, join(scratch, "brew-invocations"));
    if (tmux) writeCommand(bin, "tmux", [tmux]);
    return join(scratch, name);
  };

  it("uses a tmux in a Homebrew prefix that is not on PATH, downloads nothing and runs no Homebrew", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-prefix-"));
    try {
      const home = prefixMac(scratch);
      const prefix = prefixWith(scratch, "homebrew", "printf 'tmux 3.7c\\n'");
      const result = spawnSync("/bin/sh", ["-c", hostSetupOf(readFileSync(installer, "utf8"))], {
        encoding: "utf8",
        env: {
          ...process.env, HOME: home, INSTALL_MODE: "standalone",
          PATH: `${scratch}:/usr/bin:/bin`, HARNESS_HOMEBREW_PREFIXES: prefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("tmux ready (tmux 3.7c)");
      expect(existsSync(join(home, ".harness", "runtime", "current-tmux"))).toBe(false);
      expect(existsSync(join(home, ".local", "bin", "tmux"))).toBe(false);
      expect(existsSync(join(scratch, "curl-invoked"))).toBe(false);
      expect(existsSync(join(scratch, "brew-invocations"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("takes the first prefix whose tmux runs", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-prefixes-"));
    try {
      const home = prefixMac(scratch);
      const prefixes = [
        prefixWith(scratch, "no-tmux"),
        prefixWith(scratch, "homebrew", "printf 'tmux 3.7c\\n'"),
        prefixWith(scratch, "later", "printf 'tmux 3.8\\n'"),
      ];
      const result = spawnSync("/bin/sh", ["-c", hostSetupOf(readFileSync(installer, "utf8"))], {
        encoding: "utf8",
        env: {
          ...process.env, HOME: home, INSTALL_MODE: "standalone",
          PATH: `${scratch}:/usr/bin:/bin`, HARNESS_HOMEBREW_PREFIXES: prefixes.join(" "),
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("tmux ready (tmux 3.7c)");
      expect(existsSync(join(scratch, "curl-invoked"))).toBe(false);
      expect(existsSync(join(scratch, "brew-invocations"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("finds Homebrew tmux and creates the first pane without changing its worker PATH", async () => {
    const workerPath = process.env.PATH;
    const exercise = async () => {
      const scratch = mkdtempSync(join(tmpdir(), "harness-mac-brew-daemon-"));
      const home = join(scratch, "home");
      const prefix = join(scratch, "homebrew");
      const bin = join(prefix, "bin");
      mkdirSync(home);
      mkdirSync(bin, { recursive: true });
      try {
        writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
        writeRecordingBrew(bin, join(scratch, "brew-invocations"));
        writeCommand(bin, "tmux", [
          'case "$1" in -V) printf "tmux 3.7c\\n" ;; new-session) printf "%%0\\n" ;; esac',
        ]);
        const daemonEnv = { HOME: home, PATH: scratch, HARNESS_HOMEBREW_PREFIXES: prefix };
        const installed = spawnSync("/bin/sh", ["-c", hostSetupOf(readFileSync(installer, "utf8"))], {
          encoding: "utf8", env: { ...daemonEnv, INSTALL_MODE: "standalone" },
        });
        expect(installed.status, installed.stderr).toBe(0);
        expect(installed.stdout).toContain("tmux ready (tmux 3.7c)");
        expect(existsSync(join(home, ".harness/runtime/current-tmux"))).toBe(false);
        expect(existsSync(join(scratch, "brew-invocations"))).toBe(false);

        // Found by QA on a quiet machine: a timed-out probe must not change later fixtures' PATH.
        // This is the daemon's environment after the installer exits, so give it its own process.
        const probe = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const child = fork(join(process.cwd(), "src/testing/installerTmuxProbe.ts"), [], {
            execArgv: ["--import", "tsx"],
            env: { ...process.env, ...daemonEnv },
            silent: true,
            // A node with tsx compiling the backend's modules, then two tmux creates through fresh fakes:
            // seconds on a loaded machine (see the timeout above), never 5 s of a quiet one.
            timeout: 15_000,
          });
          let response: Record<string, unknown> | undefined;
          let stderr = "";
          child.stderr!.on("data", data => { stderr += data; });
          child.on("message", message => { response = message as Record<string, unknown>; });
          child.once("error", reject);
          child.once("close", (code, signal) => {
            if (code === 0 && response) resolve(response);
            else reject(new Error(`installer daemon probe exited ${code ?? signal}: ${stderr}`));
          });
        });
        expect(probe.before).toMatchObject({ state: "failed", reason: "tmux is unavailable" });
        expect(probe.adopted).toMatchObject({ state: "adopted" });
        expect(probe.after).toMatchObject({
          state: "succeeded", runtime: { backend: "tmux", paneId: "%0" },
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
    const pending = exercise();
    try {
      // Found by QA on a quiet machine: a timed-out probe poisoned PATH for later fixtures.
      expect(process.env.PATH).toBe(workerPath);
    } finally { await pending; }
  });

  it("downloads, verifies and links the managed tmux when there is no Homebrew", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-managed-"));

    try {
      const { home, root } = managedFixture(scratch);
      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          INSTALL_MODE: "standalone",
          // Only stock tools beyond the fakes: no brew, no tmux — and the fakes win.
          PATH: `${scratch}:/usr/bin:/bin`,
          HARNESS_TMUX_METADATA_URL: "https://cdn.example/manifest.json",
          HARNESS_HOMEBREW_PREFIXES: join(scratch, "no-homebrew"),
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("downloading tmux 9.9 (darwin-arm64)");
      expect(result.stdout).toContain("tmux ready (tmux 9.9)");
      const binary = join(home, ".harness", "runtime", root, "bin", "tmux");
      expect(readFileSync(join(home, ".harness", "runtime", "current-tmux"), "utf8").trim()).toBe(binary);
      expect(readlinkSync(join(home, ".local", "bin", "tmux"))).toBe(binary);
      expect(readFileSync(join(scratch, "curl-invocations"), "utf8")).toContain("https://cdn.example/manifest.json");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a managed tmux whose checksum does not match, and links nothing", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-managed-bad-"));

    try {
      const { home } = managedFixture(scratch, true);
      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          INSTALL_MODE: "standalone",
          PATH: `${scratch}:/usr/bin:/bin`,
          HARNESS_TMUX_METADATA_URL: "https://cdn.example/manifest.json",
          HARNESS_HOMEBREW_PREFIXES: join(scratch, "no-homebrew"),
        },
      });

      expect(result.status).toBe(22);
      expect(result.stderr).toContain("checksum verification");
      expect(() => readlinkSync(join(home, ".local", "bin", "tmux"))).toThrow();
      expect(() => readFileSync(join(home, ".harness", "runtime", "current-tmux"))).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("installs the managed tmux on a Mac with no tmux, and never runs Homebrew", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-no-brew-run-"));
    const invocations = join(scratch, "brew-invocations");

    try {
      const { home, root } = managedFixture(scratch);
      const prefix = join(scratch, "homebrew");
      mkdirSync(join(prefix, "bin"), { recursive: true });
      writeRecordingBrew(scratch, invocations);
      writeRecordingBrew(join(prefix, "bin"), invocations);
      const result = spawnSync("/bin/sh", ["-c", hostSetupOf(readFileSync(installer, "utf8"))], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          INSTALL_MODE: "standalone",
          PATH: `${scratch}:/usr/bin:/bin`,
          HARNESS_TMUX_METADATA_URL: "https://cdn.example/manifest.json",
          HARNESS_HOMEBREW_PREFIXES: prefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("downloading tmux 9.9 (darwin-arm64)");
      expect(result.stdout).toContain("tmux ready (tmux 9.9)");
      expect(result.stdout).not.toContain("Homebrew");
      expect(readlinkSync(join(home, ".local", "bin", "tmux"))).toBe(join(home, ".harness", "runtime", root, "bin", "tmux"));
      expect(existsSync(invocations)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("passes a Homebrew tmux that does not run and installs the managed build", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-brew-tmux-broken-"));
    const invocations = join(scratch, "brew-invocations");

    try {
      const { home, root } = managedFixture(scratch);
      const prefix = join(scratch, "homebrew");
      mkdirSync(join(prefix, "bin"), { recursive: true });
      writeCommand(join(prefix, "bin"), "tmux", ["exit 127"]);
      writeRecordingBrew(join(prefix, "bin"), invocations);
      const result = spawnSync("/bin/sh", ["-c", hostSetupOf(readFileSync(installer, "utf8"))], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          INSTALL_MODE: "standalone",
          PATH: `${scratch}:/usr/bin:/bin`,
          HARNESS_TMUX_METADATA_URL: "https://cdn.example/manifest.json",
          HARNESS_HOMEBREW_PREFIXES: prefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("tmux ready (tmux 9.9)");
      expect(readlinkSync(join(home, ".local", "bin", "tmux"))).toBe(join(home, ".harness", "runtime", root, "bin", "tmux"));
      expect(existsSync(invocations)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Harness Device turns these lines into its install step's copy by how they start (its fixed table in
  // the app's Rust): a change to one of them is a change there too.
  it("keeps the step lines Harness Device names", () => {
    const source = readFileSync(installer, "utf8");
    for (const line of [
      'echo "▸ Installing the managed tmux into',
      'echo "  ▸ downloading tmux ',
      'echo "▸ Installing the Harness Node runtime into',
      'echo "  ▸ downloading Node ',
      'echo "▸ Installing harness from',
    ]) {
      expect(source).toContain(line);
    }
  });

  it("host mode puts ~/.local/bin on PATH for new shells", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-host-rc-"));

    try {
      const { home } = managedFixture(scratch);
      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/zsh",
          INSTALL_MODE: "host",
          PATH: `${scratch}:/usr/bin:/bin`,
          HARNESS_TMUX_METADATA_URL: "https://cdn.example/manifest.json",
          HARNESS_HOMEBREW_PREFIXES: join(scratch, "no-homebrew"),
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Host requirements ready");
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("host mode stops after the host requirements", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-host-mode-"));

    try {
      writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
      writeCommand(scratch, "tmux", ["printf 'tmux 3.6\\n'"]);

      const result = spawnSync("/bin/sh", ["-c", `${hostSetup}\necho REACHED-NODE-STEP`], {
        encoding: "utf8",
        env: { ...process.env, INSTALL_MODE: "host", PATH: scratch },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Host requirements ready");
      expect(result.stdout).not.toContain("REACHED-NODE-STEP");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("installs nothing on a Linux host that already runs tmux and ps", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-linux-ready-"));
    const invoked = join(scratch, "apt-invoked");

    try {
      writeLinuxHostCommands(scratch);
      writeCommand(scratch, "id", ["printf '0\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "tmux", ["printf 'tmux 3.6\\n'"]);
      // curl is a download tool, not a host requirement: its absence is no business of step 1.
      writeCommand(scratch, "apt-get", [`: > '${invoked}'`, "exit 99"]);

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          DISPLAY: "",
          WAYLAND_DISPLAY: "",
          PATH: scratch,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("tmux ready");
      expect(() => readFileSync(invoked, "utf8")).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("installs the download tools only when the runtime is downloaded", () => {
    const source = readFileSync(installer, "utf8");
    // The check lives inside the download branch, after managed-runtime reuse is ruled out.
    const download = source.indexOf('if [ -z "$NODE_BIN" ]; then\n\n  # Fetching');
    const reuse = source.indexOf('if [ -z "$NODE_BIN" ] && [ -r "$CURRENT_NODE_FILE" ]');
    expect(reuse).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(reuse);
    expect(source.slice(0, download)).not.toContain("require_command curl");

    const downloadTools = downloadToolsOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-download-tools-"));
    const invocations = join(scratch, "apt-invocations");
    const fakeCurl = join(scratch, "curl");

    try {
      for (const command of ["tar", "sed", "awk", "sha256sum"]) {
        writeCommand(scratch, command, ["exit 0"]);
      }
      writeCommand(scratch, "id", ["printf '0\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "apt-get", [
        `printf '%s\\n' "$*" >> '${invocations}'`,
        `printf '%s\\n' '#!/bin/sh' 'exit 0' > '${fakeCurl}'`,
        `/bin/chmod 700 '${fakeCurl}'`,
      ]);

      const result = spawnSync("/bin/sh", ["-c", downloadTools], {
        encoding: "utf8",
        env: { ...process.env, PATH: scratch },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(invocations, "utf8")).toBe("install -y curl\n");
      expect(result.stdout).toContain("tools needed to download the runtime");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("installs tmux through sudo without refreshing usable package indexes", () => {
    const source = readFileSync(installer, "utf8");
    const tmuxStep = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-tmux-user-"));
    const invocation = join(scratch, "sudo-invocation");
    const fakeTmux = join(scratch, "tmux");

    try {
      writeLinuxHostCommands(scratch);
      writeCommand(scratch, "id", ["printf '1000\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "apt-get", ["exit 99"]);
      writeCommand(scratch, "sudo", [
        `printf '%s\\n' "$*" > '${invocation}'`,
        `printf '%s\\n' '#!/bin/sh' 'printf "tmux 3.6\\\\n"' > '${fakeTmux}'`,
        `/bin/chmod 700 '${fakeTmux}'`,
      ]);

      const result = spawnSync("/bin/sh", ["-c", tmuxStep], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          DISPLAY: "",
          WAYLAND_DISPLAY: "",
          PATH: scratch,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(invocation, "utf8")).toBe("apt-get install -y tmux\n");
      expect(result.stdout).toContain("tmux ready");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("installs as root without sudo and retries after a failed index refresh", () => {
    const source = readFileSync(installer, "utf8");
    const tmuxStep = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-tmux-root-"));
    const invocations = join(scratch, "apt-invocations");
    const firstAttempt = join(scratch, "first-attempt");
    const fakeTmux = join(scratch, "tmux");

    try {
      writeLinuxHostCommands(scratch);
      writeCommand(scratch, "id", ["printf '0\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "apt-get", [
        `printf '%s\\n' "$*" >> '${invocations}'`,
        `if [ "$1" = "update" ]; then exit 77; fi`,
        `if [ ! -f '${firstAttempt}' ]; then : > '${firstAttempt}'; exit 1; fi`,
        `printf '%s\\n' '#!/bin/sh' 'printf "tmux 3.6\\\\n"' > '${fakeTmux}'`,
        `/bin/chmod 700 '${fakeTmux}'`,
      ]);

      const result = spawnSync("/bin/sh", ["-c", tmuxStep], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          DISPLAY: "",
          WAYLAND_DISPLAY: "",
          PATH: scratch,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(invocations, "utf8")).toBe(
        "install -y tmux\nupdate\ninstall -y tmux\n",
      );
      expect(result.stdout).toContain("tmux ready");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("requires only the active Linux desktop clipboard helper before Node", () => {
    const source = readFileSync(installer, "utf8");
    const wayland = source.indexOf('clipboard_command="wl-copy"');
    const x11 = source.indexOf('clipboard_command="xclip"');
    const nodeStep = source.indexOf("# 2. Resolve the Node");

    expect(wayland).toBeGreaterThan(-1);
    expect(x11).toBeGreaterThan(wayland);
    expect(nodeStep).toBeGreaterThan(x11);
    expect(source).toContain('if [ -n "${WAYLAND_DISPLAY:-}" ]; then');
    expect(source).toContain('elif [ -n "${DISPLAY:-}" ]; then');
    expect(source).toContain('exit 23');
    expect(source).not.toContain("install_with_apt xclip wl-clipboard");
  });

  it("installs xclip for X11 and verifies it", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-xclip-root-"));
    const invocations = join(scratch, "apt-invocations");
    const fakeXclip = join(scratch, "xclip");

    try {
      writeLinuxHostCommands(scratch);
      writeCommand(scratch, "id", ["printf '0\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "tmux", ["printf 'tmux 3.6\\n'"]);
      writeCommand(scratch, "apt-get", [
        `printf '%s\\n' "$*" >> '${invocations}'`,
        `printf '%s\\n' '#!/bin/sh' 'exit 0' > '${fakeXclip}'`,
        `/bin/chmod 700 '${fakeXclip}'`,
      ]);

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          DISPLAY: ":0",
          WAYLAND_DISPLAY: "",
          PATH: scratch,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(invocations, "utf8")).toBe("install -y xclip\n");
      expect(result.stdout).toContain("Linux image clipboard ready (xclip)");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not install clipboard packages on a headless Linux host", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-headless-root-"));
    const invoked = join(scratch, "apt-invoked");

    try {
      writeLinuxHostCommands(scratch);
      writeCommand(scratch, "id", ["printf '0\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "tmux", ["printf 'tmux 3.6\\n'"]);
      writeCommand(scratch, "apt-get", [`: > '${invoked}'`, "exit 99"]);

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          DISPLAY: "",
          WAYLAND_DISPLAY: "",
          PATH: scratch,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("native image clipboard is not applicable");
      expect(() => readFileSync(invoked, "utf8")).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails before Node when the active Wayland helper cannot be installed", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-wayland-fail-"));

    try {
      writeLinuxHostCommands(scratch);
      writeCommand(scratch, "id", ["printf '0\\n'"]);
      writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
      writeCommand(scratch, "tmux", ["printf 'tmux 3.6\\n'"]);
      writeCommand(scratch, "apt-get", ["exit 88"]);

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          DISPLAY: ":0",
          WAYLAND_DISPLAY: "wayland-0",
          PATH: scratch,
        },
      });

      expect(result.status).toBe(23);
      expect(result.stderr).toContain("Could not install wl-clipboard");
      expect(result.stderr).not.toContain("xclip");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000); // Several real shell/package-manager processes, as in the other installer integration checks.

  // ── the managed grid ──────────────────────────────────────────────────────────────────────────
  //
  // The grid CLI the release PINS, laid down beside Node and tmux — but unlike them, optional: the
  // harness works without it, the daemon follows the pin on every start, so this step may fail and
  // the install still succeeds. And never linked into ~/.local/bin: that path is grid's own
  // installer's (uv's, on a Mac); the daemon puts the managed grid on an agent pane's PATH itself.

  it("installs the managed grid after the CLI and before PATH, as a step the install can survive", () => {
    const source = readFileSync(installer, "utf8");
    const cliStep = source.indexOf("# 3. Fetch manifest");
    const gridStep = source.indexOf("# 3b. The managed grid");
    const pathStep = source.indexOf("# 4. Ensure ~/.local/bin");
    expect(cliStep).toBeGreaterThan(0);
    expect(gridStep).toBeGreaterThan(cliStep);
    expect(pathStep).toBeGreaterThan(gridStep);
    expect(source).toContain('GRID_METADATA_URL="${HARNESS_GRID_METADATA_URL:-');
    expect(source).toContain('CURRENT_GRID_FILE="$RUNTIME_DIR/current-grid"');
    // Optional, by construction: the call is guarded, and the function returns instead of exiting.
    expect(source.slice(gridStep, pathStep)).toMatch(/install_managed_grid \|\|/);
    const fn = source.slice(source.indexOf("install_managed_grid() {"), source.indexOf("# 1. Host requirements"));
    expect(fn).not.toContain("exit ");
    expect(fn).not.toContain("ln -s");
  });

  const runGridStep = (scratch: string, home: string, mode: string) =>
    spawnSync("/bin/sh", ["-c", gridStepOf(readFileSync(installer, "utf8"))], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        INSTALL_MODE: mode,
        PATH: `${scratch}:/usr/bin:/bin`,
        HARNESS_GRID_METADATA_URL: "https://cdn.example/manifest.json",
      },
    });


  it("leaves grid to its first use on the desktop app's first run", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-grid-desktop-"));
    try {
      const { home } = gridFixture(scratch);
      const result = runGridStep(scratch, home, "desktop");
      expect(result.stdout).not.toContain("Installing the managed grid");
      expect(existsSync(join(home, ".harness", "runtime", "current-grid"))).toBe(false);
      expect(existsSync(join(scratch, "curl-invocations"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it("downloads, verifies and records the managed grid read-only, and links nothing", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-grid-managed-"));
    try {
      const { home, root } = gridFixture(scratch);
      const result = runGridStep(scratch, home, "standalone");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("downloading grid 9.9 (darwin-arm64)");
      expect(result.stdout).toContain(`installed grid 9.9 → ${join(home, ".harness", "runtime", root)}`);
      const binary = join(home, ".harness", "runtime", root, "bin", "grid");
      expect(readFileSync(join(home, ".harness", "runtime", "current-grid"), "utf8").trim()).toBe(binary);
      // `grid update` is a rename INTO bin/; a bin/ it cannot write to is what makes that fail loudly.
      expect(statSync(binary).mode & 0o777).toBe(0o555);
      expect(statSync(join(home, ".harness", "runtime", root, "bin")).mode & 0o777).toBe(0o555);
      expect(existsSync(join(home, ".local", "bin", "grid"))).toBe(false);
      expect(readFileSync(join(scratch, "curl-invocations"), "utf8")).toContain("https://cdn.example/manifest.json");
    } finally {
      // The read-only bin/ the step lays down cannot be emptied as it is; give it back before the sweep.
      try { chmodSync(join(scratch, "home", ".harness", "runtime", "grid-9.9-darwin-arm64", "bin"), 0o755); } catch { /* never laid down */ }
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("survives a grid whose checksum does not match: says so, records nothing, and the install goes on", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-grid-tampered-"));
    try {
      const { home } = gridFixture(scratch, true);
      const result = runGridStep(scratch, home, "standalone");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("checksum verification");
      expect(result.stdout).toContain("set up the first time a grid feature is used");
      expect(existsSync(join(home, ".harness", "runtime", "current-grid"))).toBe(false);
      expect(readdirSync(join(home, ".harness", "runtime")).filter((n) => n.startsWith(".grid-staging-"))).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("says which platform has no managed grid, fetches nothing, and the install goes on", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-grid-platform-"));
    try {
      const { home } = gridFixture(scratch);
      writeCommand(scratch, "uname", [`if [ "$1" = "-m" ]; then printf 'riscv64\\n'; else printf 'Linux\\n'; fi`]);
      const result = runGridStep(scratch, home, "standalone");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("No managed grid is published for Linux/riscv64");
      expect(existsSync(join(scratch, "curl-invocations"))).toBe(false);
      expect(existsSync(join(home, ".harness", "runtime", "current-grid"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("fetches no grid in host mode, which installs no CLI either", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-grid-host-"));
    try {
      const { home } = gridFixture(scratch);
      const result = runGridStep(scratch, home, "host");

      expect(result.status).toBe(0);
      expect(existsSync(join(scratch, "curl-invocations"))).toBe(false);
      expect(existsSync(join(home, ".harness", "runtime", "current-grid"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("desktop mode skips all host package and tmux work", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-desktop-mode-"));
    const invoked = join(scratch, "host-command-invoked");

    try {
      // uname answers: the constants ask it where Harness lives. On Linux, a host step that ran would reach tmux.
      writeUname(scratch, "Linux");
      for (const command of ["sudo", "apt-get", "tmux", "brew"]) {
        writeCommand(scratch, command, [`: > '${invoked}'`, "exit 99"]);
      }

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: { ...process.env, INSTALL_MODE: "desktop", PATH: scratch },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Desktop mode");
      expect(() => readFileSync(invoked, "utf8")).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("scripts/install.sh: hn", () => {
  it("installs hn after the grid and before PATH, as a step the install can survive", () => {
    const source = readFileSync(installer, "utf8");
    const grid = source.indexOf("# 3b. The managed grid");
    const hn = source.indexOf("# 3c. hn's binary");
    const path = source.indexOf("# 4. Ensure ~/.local/bin");
    expect(hn).toBeGreaterThan(grid);
    expect(path).toBeGreaterThan(hn);
    expect(source.slice(hn, path)).toMatch(/install_hn \|\|/);
    const fn = source.slice(source.indexOf("install_hn() {"), source.indexOf("install_managed_grid() {"));
    expect(fn).not.toContain("exit ");
    // release-tui.yml's manifest. Where the binary goes is the layout's test, below.
    expect(source).toContain("harness/tui/metadata.json");
  });

  const runHnStep = (scratch: string, home: string, mode: string) =>
    spawnSync("/bin/sh", ["-c", hnStepOf(readFileSync(installer, "utf8"))], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, INSTALL_MODE: mode, PATH: `${scratch}:/usr/bin:/bin`, HARNESS_TUI_MANIFEST_URL: "https://cdn.example/manifest.json" },
    });

  it("downloads this computer's build, verifies it and installs it where `harness tui` finds it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-"));
    try {
      const { home, tui } = hnFixture(scratch);
      const result = runHnStep(scratch, home, "standalone");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("downloading hn 0.1.0 (darwin-arm64)");
      expect(result.stdout).toContain(`installed hn 0.1.0 → ${tui}`);
      expect(statSync(tui).mode & 0o111).not.toBe(0);
      expect(spawnSync(tui, ["--version"], { encoding: "utf8" }).stdout).toContain("hn 0.1.0");
      expect(readFileSync(join(scratch, "curl-invocations"), "utf8")).toContain("harness-tui-darwin-arm64");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("survives a download whose checksum does not match: says so, installs nothing, and the install goes on", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-tampered-"));
    try {
      const { home, tui } = hnFixture(scratch, { tamper: true });
      const result = runHnStep(scratch, home, "standalone");
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("checksum verification");
      expect(result.stdout).toContain("hn will download itself the first time you run it");
      expect(existsSync(tui)).toBe(false);
      expect(readdirSync(join(home, ".harness", "bin")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps no binary that does not run on this computer", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-broken-"));
    try {
      const { home, tui } = hnFixture(scratch, { runs: false });
      const result = runHnStep(scratch, home, "standalone");
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("hn does not run on this computer");
      expect(existsSync(tui)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("fetches nothing in desktop mode (its first `hn` does) or host mode (no CLI)", () => {
    for (const mode of ["desktop", "host"]) {
      const scratch = mkdtempSync(join(tmpdir(), `harness-hn-${mode}-`));
      try {
        const { home, tui } = hnFixture(scratch);
        const result = runHnStep(scratch, home, mode);
        expect(result.status).toBe(0);
        expect(existsSync(join(scratch, "curl-invocations"))).toBe(false);
        expect(existsSync(tui)).toBe(false);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it("writes `hn` beside `harness`, following its runtime and update policy", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-launcher-"));
    try {
      const home = join(scratch, "home");
      mkdirSync(home, { recursive: true });
      const node = handedNode(scratch);
      const { code, out } = await runCliStep(scratch, home, { nodeBinary: node });
      expect(code, out).toBe(0);
      expect(out).toContain("installed harness 9.9.9");
      const cli = join(home, ".harness", "cli", "cli.js");
      expect(readFileSync(join(home, ".local", "bin", "hn"), "utf8")).toBe(`#!/bin/sh\nexec '${join(home, ".local", "bin", "harness")}' tui "$@"\n`);
      expect(readFileSync(join(home, ".local", "bin", "harness"), "utf8")).toBe(`#!/bin/sh\nexec '${node}' '${cli}' "$@"\n`);
      expect(statSync(join(home, ".local", "bin", "hn")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("leaves someone else's `hn` alone and says how to run Harness's", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-theirs-"));
    try {
      const home = join(scratch, "home");
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, ".local", "bin", "hn"), "#!/bin/sh\necho hacker news\n", { mode: 0o755 });
      const { code, out } = await runCliStep(scratch, home, { nodeBinary: handedNode(scratch) });
      expect(code).toBe(0);
      expect(readFileSync(join(home, ".local", "bin", "hn"), "utf8")).toBe("#!/bin/sh\necho hacker news\n");
      expect(out).toContain("Kept existing");
      expect(out).toContain("use harness tui");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(['native symlink', 'dangling symlink', 'unrelated wrapper'])("preserves an existing %s even when it contains .harness", async kind => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-preserved-"));
    try {
      const home = join(scratch, "home");
      const bin = join(home, ".local", "bin");
      const hn = join(bin, "hn");
      const target = join(scratch, "old-hn");
      mkdirSync(bin, { recursive: true });
      const bytes = kind === 'unrelated wrapper' ? Buffer.from('#!/bin/sh\necho "$HOME/.harness"\n') : Buffer.from('\x7fELF native .harness bytes');
      if (kind === 'unrelated wrapper') writeFileSync(hn, bytes);
      else {
        if (kind === 'native symlink') writeFileSync(target, bytes, { mode: 0o755 });
        symlinkSync(target, hn);
      }
      const { code, out } = await runCliStep(scratch, home, { nodeBinary: handedNode(scratch) });
      expect(code).toBe(0);
      expect(out).toContain('harness tui --install');
      if (kind === 'unrelated wrapper') expect(readFileSync(hn)).toEqual(bytes);
      else {
        expect(lstatSync(hn).isSymbolicLink()).toBe(true);
        expect(readlinkSync(hn)).toBe(target);
        if (kind === 'native symlink') expect(readFileSync(target)).toEqual(bytes);
        else expect(existsSync(target)).toBe(false);
      }
      expect(readdirSync(bin).sort()).toEqual(['harness', 'hn']);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 20_000);
});

describe("scripts/install.sh: OpenCode for hn's first window", () => {
  // The constants (NEW_COMPUTER among them), then step 3d alone.
  const openCodeStepOf = (source: string) =>
    source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# Shared by every download")) +
    source.slice(source.indexOf("# 4b. OpenCode"), source.indexOf("# 5. Final verification"));

  // OpenCode's own installer, as served: a script for bash that puts the binary in ~/.opencode/bin.
  const run = (mode: string, { agent = "", installs = true, attended = true, os = "Darwin" } = {}) => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-opencode-"));
    try {
      const home = join(scratch, "home");
      mkdirSync(home, { recursive: true });
      if (agent) mkdirSync(join(home, agent), { recursive: true });
      writeUname(scratch, os);
      writeCommand(scratch, "curl", [
        `printf '%s\\n' "$*" >> '${join(scratch, "curl-invocations")}'`,
        installs
          ? `printf '%s\\n' 'mkdir -p "$HOME/.opencode/bin"' 'printf "#!/bin/sh\\n" > "$HOME/.opencode/bin/opencode"' 'chmod +x "$HOME/.opencode/bin/opencode"'`
          : "exit 7",
      ]);
      const result = spawnSync("/bin/sh", ["-c", openCodeStepOf(readFileSync(installer, "utf8"))], {
        encoding: "utf8",
        env: {
          ...process.env, HOME: home, INSTALL_MODE: mode, PATH: `${scratch}:/usr/bin:/bin`, HARNESS_INSTALL_ATTENDED: attended ? "1" : "",
          XDG_DATA_HOME: "", XDG_STATE_HOME: "",
        },
      });
      let curl = "";
      try { curl = readFileSync(join(scratch, "curl-invocations"), "utf8"); } catch { /* never asked */ }
      // hn's first-run mark, wherever the step put it.
      const marks = [".harness/tui/first-run", ".local/share/harness/tui/first-run"].filter((mark) => existsSync(join(home, mark)));
      return { result, curl, marks, opencode: join(home, ".opencode", "bin", "opencode") };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it("downloads it on a computer with no agent and no Harness, with the CLI's recipe, into ~/.opencode/bin", () => {
    const { result, curl, marks } = run("standalone");
    expect(result.status).toBe(0);
    expect(curl).toContain("https://opencode.ai/install");
    expect(marks, "hn's first start opens OpenCode (tui/src/first_run.rs)").toEqual([".harness/tui/first-run"]);
    expect(result.stdout).toContain("✓ OpenCode ready");
    const source = readFileSync(installer, "utf8");
    const step = source.indexOf("# 4b. OpenCode");
    expect(source.slice(step, source.indexOf("# 5. Final verification"))).toContain("bash -s -- --no-modify-path");
    // After ~/.local/bin is on PATH: stopping a slow download leaves a working PATH.
    expect(step).toBeGreaterThan(source.indexOf("\nensure_path_rc\n"));
  }, 20_000);

  it("on a fresh Linux home, marks hn's first run in the data root", () => {
    const { result, marks } = run("standalone", { os: "Linux" });
    expect(result.status).toBe(0);
    expect(marks).toEqual([".local/share/harness/tui/first-run"]);
  }, 20_000);

  it("leaves it alone where there is an agent or Harness already, and to the app under --desktop", () => {
    for (const agent of [".claude", ".codex", ".harness/cli", ".config/opencode"]) {
      const { result, curl, marks } = run("standalone", { agent });
      expect(result.status, agent).toBe(0);
      expect(curl, agent).toBe("");
      expect(marks, agent).toEqual([]);
    }
    // On Linux, Harness is where the rule puts it: still in ~/.harness, or moved to the data root.
    for (const agent of [".harness/cli", ".local/share/harness/cli"]) {
      const { result, curl, marks } = run("standalone", { agent, os: "Linux" });
      expect(result.status, agent).toBe(0);
      expect(curl, agent).toBe("");
      expect(marks, agent).toEqual([]);
    }
    for (const mode of ["desktop", "host"]) {
      const { curl, marks } = run(mode);
      expect(curl, mode).toBe("");
      expect(marks, mode).toEqual([]);
    }
    // Nobody at a terminal (a Docker build, a provisioning script): no agent it did not ask for.
    const unattended = run("standalone", { attended: false });
    expect(unattended.curl).toBe("");
    expect(unattended.marks).toEqual([]);
  }, 20_000);

  it("survives a download that fails: says a pane will install it, and the install goes on", () => {
    const { result } = run("standalone", { installs: false });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenCode will be installed when hn first starts it");
  }, 20_000);
});

describe("scripts/install.sh: no child reads the script", () => {
  // Under `curl … | sh -s` the script is sh's stdin, and every program it starts inherits it: one that
  // reads its stdin eats the rest of the script, and the install stops there without a word.
  const sh = (input: string, env: NodeJS.ProcessEnv, args: string[] = []) => {
    const home = mkdtempSync(join(tmpdir(), "harness-piped-home-"));
    try {
      // Host mode, and step 4 of the others, write the PATH line into the shell's rc file.
      return spawnSync("/bin/sh", ["-s", ...args], { encoding: "utf8", input, env: { ...process.env, HOME: home, SHELL: "/bin/zsh", ...env } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  // 24 KiB of comments before the marker: CI's /bin/sh is dash, which reads 8 KiB ahead, so a marker
  // close behind the call would already be in its buffer, and a child that read the rest would miss it.
  const PADDING = `# ${"-".repeat(77)}\n`.repeat(320);
  const piped = (slice: string, env: NodeJS.ProcessEnv) => sh(`${slice}\n${PADDING}echo REACHED-THE-END\n`, env);
  const source = () => readFileSync(installer, "utf8");

  const withScratch = <T>(name: string, run: (scratch: string) => T): T => {
    const scratch = mkdtempSync(join(tmpdir(), `harness-piped-${name}-`));
    try {
      return run(scratch);
    } finally {
      // The managed grid's bin/ is laid down read-only.
      try { chmodSync(join(scratch, "home", ".harness", "runtime", "grid-9.9-darwin-arm64", "bin"), 0o755); } catch { /* none */ }
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it("tmux -V and the ready line (a Mac's tmux)", () => withScratch("tmux", (scratch) => {
    writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
    writeCommand(scratch, "tmux", [DRAIN, "printf 'tmux 3.6\\n'"]);
    const result = piped(hostSetupOf(source()), { INSTALL_MODE: "standalone", PATH: `${scratch}:/usr/bin:/bin` });
    expect(result.stdout, result.stderr).toContain("REACHED-THE-END");
  }));

  it("the managed tmux's -V", () => withScratch("managed-tmux", (scratch) => {
    const { home } = managedFixture(scratch, false, true);
    const result = piped(hostSetupOf(source()), {
      HOME: home, INSTALL_MODE: "standalone", PATH: `${scratch}:/usr/bin:/bin`,
      HARNESS_TMUX_METADATA_URL: "https://cdn.example/manifest.json", HARNESS_HOMEBREW_PREFIXES: join(scratch, "no-homebrew"),
    });
    expect(result.stdout, result.stderr).toContain("tmux ready (tmux 9.9)");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  // On Linux, apt-get as root and through sudo; sudo asks for a password on the tty, not on stdin.
  const linuxApt = (scratch: string, uid: string) => {
    writeLinuxHostCommands(scratch);
    writeCommand(scratch, "uname", ["printf 'Linux\\n'"]);
    writeCommand(scratch, "id", [`printf '${uid}\\n'`]);
    writeCommand(scratch, "sudo", ['exec "$@"']);
    writeCommand(scratch, "apt-get", [
      DRAIN,
      `printf '%s\\n' '#!/bin/sh' 'printf "tmux 3.6\\\\n"' > '${join(scratch, "tmux")}'`,
      `/bin/chmod 700 '${join(scratch, "tmux")}'`,
    ]);
    // Only the fakes on PATH: ubuntu-latest (CI) has a real tmux in /usr/bin.
    return piped(hostSetupOf(source()), { INSTALL_MODE: "standalone", DISPLAY: "", WAYLAND_DISPLAY: "", PATH: scratch });
  };

  it("apt-get as root", () => withScratch("apt-root", (scratch) => {
    const result = linuxApt(scratch, "0");
    expect(result.stdout, result.stderr).toContain("tmux ready (tmux 3.6)");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  it("apt-get through sudo", () => withScratch("apt-sudo", (scratch) => {
    const result = linuxApt(scratch, "1000");
    expect(result.stdout, result.stderr).toContain("tmux ready (tmux 3.6)");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  it("the managed Node's -e and -v", () => withScratch("node", (scratch) => {
    const runtime = join(scratch, "runtime");
    const bin = join(runtime, "node-v24", "bin");
    mkdirSync(bin, { recursive: true });
    writeCommand(bin, "node", [DRAIN, "printf 24"]);
    writeFileSync(join(runtime, "current-node"), `${join(bin, "node")}\n`);
    const result = piped(nodeSelectionOf(source(), runtime), { PATH: "/usr/bin:/bin", HARNESS_NODE_BINARY: "" });
    expect(result.stdout, result.stderr).toContain("Using the managed Node runtime already installed (24)");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  it("dsh builtins", () => withScratch("dsh", (scratch) => {
    writeCommand(scratch, "node", [DRAIN, "exit 0"]);
    const result = piped(gridStepOf(source()), { INSTALL_MODE: "desktop", NODE_BIN: join(scratch, "node"), PATH: `${scratch}:/usr/bin:/bin` });
    expect(result.stdout, result.stderr).toContain("REACHED-THE-END");
  }));

  it("the managed grid's --version", () => withScratch("grid", (scratch) => {
    const { home } = gridFixture(scratch, false, true);
    writeCommand(scratch, "node", ["exit 0"]);
    const result = piped(gridStepOf(source()), {
      HOME: home, INSTALL_MODE: "standalone", NODE_BIN: join(scratch, "node"), PATH: `${scratch}:/usr/bin:/bin`,
      HARNESS_GRID_METADATA_URL: "https://cdn.example/manifest.json",
    });
    expect(result.stdout, result.stderr).toContain("installed grid 9.9");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  it("hn's --version before it is installed", () => withScratch("hn", (scratch) => {
    const { home } = hnFixture(scratch, { drain: true });
    const result = piped(hnStepOf(source()), {
      HOME: home, INSTALL_MODE: "standalone", PATH: `${scratch}:/usr/bin:/bin`, HARNESS_TUI_MANIFEST_URL: "https://cdn.example/manifest.json",
    });
    expect(result.stdout, result.stderr).toContain("installed hn 0.1.0");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  it.each(["standalone", "desktop"])("the final checks and the versions it prints (%s)", (mode) => withScratch("finale", (scratch) => {
    const { home, node } = installedFixture(scratch, true);
    mkdirSync(join(home, ".harness", "bin"), { recursive: true });
    writeCommand(join(home, ".harness", "bin"), "harness-tui", [DRAIN, "echo 'hn 0.1.0 (tmux 3.5a)'"]);
    const result = piped(finaleOf(source()), { HOME: home, INSTALL_MODE: mode, NODE_BIN: node, PATH: `${scratch}:/usr/bin:/bin` });
    expect(result.stdout, result.stderr).toContain("harness 0.2.60 installed.");
    if (mode === "standalone") expect(result.stdout).toContain("✓ hn 0.1.0 installed.");
    expect(result.stdout).toContain("REACHED-THE-END");
  }));

  it("the whole script piped into sh -s -- --host still says it is ready", () => withScratch("host", (scratch) => {
    writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
    writeCommand(scratch, "tmux", [DRAIN, "printf 'tmux 3.6\\n'"]);
    const result = sh(source(), { PATH: `${scratch}:/usr/bin:/bin`, HARNESS_HOMEBREW_PREFIXES: join(scratch, "no-homebrew") }, ["--", "--host"]);
    expect(result.stdout, result.stderr).toMatch(/✓ Host requirements ready\.\n$/);
  }));

  it("the whole script piped into sh -s -- --desktop still says it is installed", () => withScratch("desktop", (scratch) => {
    // A Node that answers `-e` with 24, writes a launcher when it runs step 3 (no arguments, the code
    // on stdin), and does nothing otherwise; it and the launcher read their stdin to the end.
    const launcher = ["#!/bin/sh", DRAIN, '[ "$1" = version ] && echo 0.2.60', "exit 0", ""].join("\n");
    writeCommand(scratch, "node", [
      DRAIN,
      'case "$#:${1:-}" in',
      "  1:-e|2:-e) printf 24 ;;",
      `  0:) mkdir -p "$HOME/.local/bin" && printf '%s' '${launcher}' > "$HOME/.local/bin/harness" && chmod 755 "$HOME/.local/bin/harness" ;;`,
      "esac",
      "exit 0",
    ]);
    const result = sh(source(), { PATH: `${scratch}:/usr/bin:/bin`, HARNESS_NODE_BINARY: join(scratch, "node") }, ["--", "--desktop"]);
    expect(result.stdout, result.stderr).toContain("harness 0.2.60 installed.");
  }));

  // Rows 9 (the override's error, printed as the script exits) and 12 (a background list, which already
  // reads /dev/null) cannot be told apart by a run: the source says it for them, and for the rest.
  it("every call in the list carries the redirect", () => {
    const calls = [
      '"$tui_staging" --version', '"$grid_target/bin/grid" --version', 'apt-get "$@"', "tmux -V",
      '"$tmux_target/bin/tmux" -V', "-e 'process.stdout.write", '"$NODE_BIN" -v', "dsh builtins",
      "bash -s -- --no-modify-path", 'opencode" --version', '"$NODE_BIN" --version', '"$LAUNCHER" version',
      '"$TUI_BIN" --version',
    ];
    const lines = source().split("\n").filter((line) => !line.trimStart().startsWith("#"));
    const found = calls.flatMap((call) => {
      const at = lines.filter((line) => line.includes(call));
      expect(at, call).not.toEqual([]);
      return at;
    });
    expect(found).toHaveLength(18);
    expect(found.filter((line) => !line.includes("</dev/null"))).toEqual([]);
  });
});

describe.each([["install.sh", installer], ["install-cli.sh", installCli]])("scripts/%s: harness_roots", (_name, script) => {
  // The function alone, run by /bin/sh under a home holding `made`, with `uname` answering `os`. A `~` that starts
  // a variable's value, and the home in the answer, are that home.
  const roots = (os: string, made: string[], xdg: Record<string, string> = {}) => {
    const source = readFileSync(script, "utf8");
    const start = source.indexOf("harness_roots() {");
    expect(start, "harness_roots() is defined").toBeGreaterThan(-1);
    const fn = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const scratch = mkdtempSync(join(tmpdir(), "harness-roots-"));
    try {
      const home = join(scratch, "home");
      for (const folder of ["", ...made]) mkdirSync(join(home, folder), { recursive: true });
      writeUname(scratch, os);
      const vars = Object.fromEntries(Object.entries(xdg).map(([key, value]) => [key, value.replace(/^~/, home)]));
      const result = spawnSync("/bin/sh", ["-c", `${fn}harness_roots\nprintf '%s\\n' "$HARNESS_DATA_ROOT" "$HARNESS_STATE_ROOT"`], {
        encoding: "utf8",
        env: { HOME: home, PATH: `${scratch}:/usr/bin:/bin`, ...vars },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.split("\n").slice(0, 2).map((line) => line.replace(home, "~"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const XDG = ["~/.local/share/harness", "~/.local/state/harness"];
  const LEGACY = ["~/.harness", "~/.harness"];

  it("Linux, fresh → the XDG roots", () => {
    expect(roots("Linux", [])).toEqual(XDG);
  });

  it("Linux, ~/.harness only → ~/.harness", () => {
    expect(roots("Linux", [".harness"])).toEqual(LEGACY);
  });

  it("Linux, the data root exists → XDG, whatever is at ~/.harness", () => {
    expect(roots("Linux", [".harness", ".local/share/harness"])).toEqual(XDG);
  });

  it("Linux, the state root alone switches nothing", () => {
    expect(roots("Linux", [".harness", ".local/state/harness"])).toEqual(LEGACY);
  });

  it("Linux, an XDG variable that is empty or relative is ignored", () => {
    for (const value of ["", "share", "./share"]) {
      expect(roots("Linux", [], { XDG_DATA_HOME: value, XDG_STATE_HOME: value }), value).toEqual(XDG);
    }
  });

  // A trailing / kept would write `/d//harness` into the launcher and current-node, which the CLI, joining
  // the same folder with node:path, never reads as its own.
  it("Linux, an absolute XDG variable is used, a trailing / dropped", () => {
    expect(roots("Linux", [], { XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" })).toEqual(["/d/harness", "/s/harness"]);
    expect(roots("Linux", [], { XDG_DATA_HOME: "/d/", XDG_STATE_HOME: "/s/" })).toEqual(["/d/harness", "/s/harness"]);
  });

  it("Linux, a data root of the person's own XDG_DATA_HOME is the switch", () => {
    expect(roots("Linux", [".harness", "data/harness"], { XDG_DATA_HOME: "~/data" })).toEqual(["~/data/harness", "~/.local/state/harness"]);
  });

  it("Darwin → ~/.harness whatever exists", () => {
    expect(roots("Darwin", [])).toEqual(LEGACY);
    expect(roots("Darwin", [".local/share/harness", ".local/state/harness"], { XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" })).toEqual(LEGACY);
  });
});

describe("scripts/install.sh: where it lays Harness", () => {
  // The folders every step reads, from the constants, under a home holding `made`, with `uname` answering `os`.
  const layout = (os: string, made: string[]) => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-layout-"));
    try {
      const home = join(scratch, "home");
      for (const folder of ["", ...made]) mkdirSync(join(home, folder), { recursive: true });
      writeUname(scratch, os);
      const print = `printf '%s\\n' "$CLI_DIR" "$TUI_BIN" "$RUNTIME_DIR" "$CURRENT_NODE_FILE" "$CURRENT_TMUX_FILE" "$CURRENT_GRID_FILE"`;
      const result = spawnSync("/bin/sh", ["-c", `${constantsOf(readFileSync(installer, "utf8"))}\n${print}`], {
        encoding: "utf8",
        env: { HOME: home, PATH: `${scratch}:/usr/bin:/bin` },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split("\n").map((line) => line.replace(home, "~"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it("on a fresh Linux home, cli and bin go in the data root, runtime and its current-* files in the state root", () => {
    expect(layout("Linux", [])).toEqual([
      "~/.local/share/harness/cli",
      "~/.local/share/harness/bin/harness-tui",
      "~/.local/state/harness/runtime",
      "~/.local/state/harness/runtime/current-node",
      "~/.local/state/harness/runtime/current-tmux",
      "~/.local/state/harness/runtime/current-grid",
    ]);
  });

  it.each([
    { home: "a Mac", os: "Darwin", made: [".local/share/harness"] },
    { home: "a Linux home still on ~/.harness", os: "Linux", made: [".harness"] },
  ])("on $home, everything stays in ~/.harness", ({ os, made }) => {
    expect(layout(os, made)).toEqual([
      "~/.harness/cli",
      "~/.harness/bin/harness-tui",
      "~/.harness/runtime",
      "~/.harness/runtime/current-node",
      "~/.harness/runtime/current-tmux",
      "~/.harness/runtime/current-grid",
    ]);
  });

  it.each(LAYOUTS)("on $home, the launcher names the managed Node and the cli.js the roots give", async ({ os, made, runtime, cli }) => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-launcher-"));
    try {
      const home = join(scratch, "home");
      for (const folder of ["", ...made]) mkdirSync(join(home, folder), { recursive: true });
      const node = managedNode(join(home, runtime));
      const { code, out } = await runCliStep(scratch, home, { os });
      expect(code, out).toBe(0);
      expect(readFileSync(join(home, ".local", "bin", "harness"), "utf8")).toBe(`#!/bin/sh\nexec '${node}' '${join(home, cli, "cli.js")}' "$@"\n`);
      expect(readFileSync(join(home, cli, "cli.js"), "utf8")).toBe("console.log('cli')\n");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("prepares the core harnesses with the cli.js in the data root", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-dsh-builtins-"));
    try {
      const home = join(scratch, "home");
      mkdirSync(home);
      writeUname(scratch, "Linux");
      writeCommand(scratch, "node", [`printf '%s\\n' "$*" > '${join(scratch, "node-args")}'`]);
      const result = spawnSync("/bin/sh", ["-c", gridStepOf(readFileSync(installer, "utf8"))], {
        encoding: "utf8",
        env: { HOME: home, PATH: `${scratch}:/usr/bin:/bin`, INSTALL_MODE: "desktop", NODE_BIN: join(scratch, "node") },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(scratch, "node-args"), "utf8")).toBe(`${join(home, ".local", "share", "harness", "cli", "cli.js")} dsh builtins\n`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("scripts/install-cli.sh: where it lays Harness", () => {
  // The script where a checkout holds it, beside a built dist/, run with --no-build --no-restart under `home`,
  // `uname` answering `os` and this test's Node on PATH.
  const runInstallCli = (scratch: string, home: string, os: string, env: Record<string, string> = {}) => {
    const cli = join(scratch, "checkout", "cli");
    mkdirSync(join(cli, "scripts"), { recursive: true });
    mkdirSync(join(cli, "dist"), { recursive: true });
    writeFileSync(join(cli, "scripts", "install-cli.sh"), readFileSync(installCli));
    writeFileSync(join(cli, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('0.0.0-dev.test')\n");
    writeFileSync(join(cli, "dist", "notify.mjs"), "export {}\n");
    writeUname(scratch, os);
    return spawnSync("bash", [join(cli, "scripts", "install-cli.sh"), "--no-build", "--no-restart"], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${scratch}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    });
  };

  it.each(LAYOUTS)("on $home, the launcher names the managed Node and the cli.js the roots give", ({ os, made, runtime, cli }) => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-install-cli-"));
    try {
      const home = join(scratch, "home");
      for (const folder of ["", ...made]) mkdirSync(join(home, folder), { recursive: true });
      const node = managedNode(join(home, runtime));
      const result = runInstallCli(scratch, home, os);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(home, ".local", "bin", "harness"), "utf8")).toBe(`#!/bin/sh\nexec "${node}" "${join(home, cli, "cli.js")}" "$@"\n`);
      expect(readdirSync(join(home, cli)).sort()).toEqual(["cli.js", "notify.mjs", "package.json"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps ADAPTER_CLI_DIR, ADAPTER_DATA_DIR, HARNESS_RUNTIME_NODE and HARNESS_BIN_DIR first", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-install-cli-own-"));
    // A daemon whose pid is in the data folder the override names, left to init (its sh exits) so its end is seen.
    const daemon = Number(spawnSync("/bin/sh", ["-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
    try {
      const home = join(scratch, "home");
      const own = join(scratch, "own");
      mkdirSync(home);
      mkdirSync(join(own, "data"), { recursive: true });
      writeFileSync(join(own, "data", "adapter.pid"), `${daemon}\n`);
      const node = managedNode(join(own, "runtime"));
      const result = runInstallCli(scratch, home, "Linux", {
        ADAPTER_CLI_DIR: join(own, "cli"),
        ADAPTER_DATA_DIR: join(own, "data"),
        HARNESS_RUNTIME_NODE: join(own, "runtime", "current-node"),
        HARNESS_BIN_DIR: join(own, "bin"),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`stopping the running adapter (pid ${daemon})`);
      expect(existsSync(join(own, "data", "adapter.pid"))).toBe(false);
      expect(readFileSync(join(own, "bin", "harness"), "utf8")).toBe(`#!/bin/sh\nexec "${node}" "${join(own, "cli", "cli.js")}" "$@"\n`);
      expect(readdirSync(join(own, "cli")).sort()).toEqual(["cli.js", "notify.mjs", "package.json"]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      try { process.kill(daemon, "SIGKILL"); } catch { /* already stopped */ }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
