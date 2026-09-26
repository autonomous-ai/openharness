import { spawnSync } from "child_process";
import { join } from "path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";

// vitest runs from cli/, so this is cli/scripts/install.sh — the file published to the CDN.
const installer = join(process.cwd(), "scripts", "install.sh");

const writeCommand = (directory: string, name: string, lines: string[]) => {
  const path = join(directory, name);
  writeFileSync(path, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(path, 0o700);
};

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

// A ~/.local/bin with a launcher that answers `version`, plus the node and tmux the verification runs.
const installedFixture = (scratch: string) => {
  const home = join(scratch, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeCommand(bin, "harness", ['[ "$1" = version ] && echo 0.2.60', "exit 0"]);
  writeCommand(scratch, "node", ["exit 0"]);
  writeCommand(scratch, "tmux", ['echo "tmux 3.7"']);
  return { home, node: join(scratch, "node") };
};

const runFinale = (mode: "standalone" | "desktop", pathHasBin: boolean) => {
  const source = readFileSync(installer, "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "harness-finale-"));
  try {
    const { home, node } = installedFixture(scratch);
    const bin = join(home, ".local", "bin");
    return spawnSync("/bin/sh", ["-c", finaleOf(source)], {
      encoding: "utf8",
      env: {
        ...process.env,
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

  it("desktop mode gets the one line and no guide: the app takes the person through sign-in", () => {
    const out = runFinale("desktop", true).stdout;
    expect(out).toContain("harness 0.2.60 installed.");
    expect(out).not.toContain("Get started");
    expect(out).not.toContain(LOGO[1]);
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
    expect(source).toContain("brew install tmux");
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

  // The ladder, in source order: tmux is asked about first, Homebrew used only when tmux is missing
  // and Homebrew is already there, the managed build for everything else.
  it("asks about Homebrew only without tmux, and downloads the managed build without Homebrew", () => {
    const source = readFileSync(installer, "utf8");
    const hostStep = source.slice(source.indexOf("# 1. Host requirements"));
    const darwin = hostStep.slice(hostStep.indexOf("  Darwin)"), hostStep.indexOf("  Linux)"));

    const tmuxCheck = darwin.indexOf("if tmux_runs; then");
    const brewCheck = darwin.indexOf("if command -v brew >/dev/null 2>&1; then");
    const managed = darwin.indexOf("tmux_runs || install_managed_tmux");
    expect(tmuxCheck).toBeGreaterThan(-1);
    expect(brewCheck).toBeGreaterThan(tmuxCheck);
    expect(managed).toBeGreaterThan(brewCheck);
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

  it("installs tmux with an existing Homebrew and never fetches the managed build", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-brew-"));
    const invocations = join(scratch, "brew-invocations");
    const fetched = join(scratch, "curl-invoked");
    const fakeTmux = join(scratch, "tmux");

    try {
      writeCommand(scratch, "uname", ["printf 'Darwin\\n'"]);
      writeCommand(scratch, "brew", [
        `printf '%s\\n' "$*" >> '${invocations}'`,
        `if [ "$1" = "shellenv" ]; then exit 0; fi`,
        `printf '%s\\n' '#!/bin/sh' 'printf "tmux 3.7c\\\\n"' > '${fakeTmux}'`,
        `/bin/chmod 700 '${fakeTmux}'`,
      ]);
      writeCommand(scratch, "curl", [`: > '${fetched}'`, "exit 99"]);

      const result = spawnSync("/bin/sh", ["-c", hostSetup], {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_MODE: "standalone",
          PATH: scratch,
          HARNESS_HOMEBREW_PREFIXES: join(scratch, "no-homebrew"),
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(invocations, "utf8")).toContain("install --force-bottle tmux\n");
      expect(result.stdout).not.toContain("managed");
      expect(() => readFileSync(fetched, "utf8")).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // A fake CDN: `curl -o` writes the archive, plain `curl` prints the manifest. The archive wraps a
  // fake tmux so the whole managed path — fetch, verify, unpack, record, link — runs for real.
  const managedFixture = (scratch: string, tamperSha = false) => {
    const home = join(scratch, "home");
    const root = "tmux-9.9-darwin-arm64";
    const stage = join(scratch, "stage", root, "bin");
    mkdirSync(stage, { recursive: true });
    writeCommand(stage, "tmux", ["printf 'tmux 9.9\\n'"]);
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

  it("falls back to the managed build when Homebrew cannot install tmux", () => {
    const source = readFileSync(installer, "utf8");
    const hostSetup = hostSetupOf(source);
    const scratch = mkdtempSync(join(tmpdir(), "harness-mac-brew-broken-"));

    try {
      const { home, root } = managedFixture(scratch);
      writeCommand(scratch, "brew", [`if [ "$1" = "shellenv" ]; then exit 0; fi`, "exit 1"]);
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

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No Homebrew tmux bottle for this Mac; using the managed build instead.");
      expect(readlinkSync(join(home, ".local", "bin", "tmux"))).toContain(root);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

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
  });

  // ── the managed grid ──────────────────────────────────────────────────────────────────────────
  //
  // The grid CLI the release PINS, laid down beside Node and tmux — but unlike them, optional: the
  // harness works without it, the daemon follows the pin on every start, so this step may fail and
  // the install still succeeds. And never linked into ~/.local/bin: that path is grid's own
  // installer's (uv's, on a Mac); the daemon puts the managed grid on an agent pane's PATH itself.

  // The helpers plus the grid step alone, as one runnable unit.
  const gridStepOf = (source: string) =>
    source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# 1. Host requirements")) +
    source.slice(source.indexOf("# 3b. The managed grid"), source.indexOf("# 4. Ensure ~/.local/bin"));

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

  const gridFixture = (scratch: string, tamperSha = false) => {
    const home = join(scratch, "home");
    const root = "grid-9.9-darwin-arm64";
    const stage = join(scratch, "stage", root, "bin");
    mkdirSync(stage, { recursive: true });
    writeCommand(stage, "grid", ["printf 'grid 9.9\\n'"]);
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
      expect(result.stdout).toContain("fetched by the daemon");
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
      for (const command of ["uname", "sudo", "apt-get", "tmux", "brew"]) {
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
  // The constants and helpers (install_hn among them), then step 3c alone.
  const hnStepOf = (source: string) =>
    source.slice(source.indexOf('METADATA_URL="${HARNESS_METADATA_URL'), source.indexOf("# 1. Host requirements")) +
    source.slice(source.indexOf("# 3c. hn's binary"), source.indexOf("# 4. Ensure ~/.local/bin"));

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
    // Where `harness tui` looks for the binary (cli/src/tui/index.ts), and release-tui.yml's manifest.
    expect(source).toContain('TUI_BIN="$HOME/.harness/bin/harness-tui"');
    expect(source).toContain("harness/tui/metadata.json");
  });

  const hnFixture = (scratch: string, { tamper = false, runs = true } = {}) => {
    const home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    const binary = join(scratch, "harness-tui-darwin-arm64");
    writeFileSync(binary, runs ? "#!/bin/sh\necho 'hn 0.1.0 (tmux 3.5a)'\n" : "#!/bin/sh\nexit 1\n");
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

  // Step 3 for real: the Node that writes the launchers, against a local manifest server.
  const runCliStep = async (home: string) => {
    const { createServer } = await import("node:http");
    const { createHash } = await import("node:crypto");
    const { spawn } = await import("node:child_process");
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
    const js = source.slice(source.indexOf("<<'HARNESSJS'\n") + "<<'HARNESSJS'\n".length, source.indexOf("\nHARNESSJS\n"));
    const child = spawn(process.execPath, [], { env: { ...process.env, HOME: home, HARNESS_METADATA_URL: `http://127.0.0.1:${port}/manifest.json`, HARNESS_KEY: "cli", HARNESS_NODE_BINARY: "/opt/harness node/bin/node" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d });
    child.stderr.on("data", (d) => { out += d });
    child.stdin.end(js);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    server.close();
    return { code, out };
  };

  it("writes `hn` beside `harness` as `harness tui`, pinned to the same Node and cli.js", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-hn-launcher-"));
    try {
      const home = join(scratch, "home");
      mkdirSync(home, { recursive: true });
      const { code, out } = await runCliStep(home);
      expect(code).toBe(0);
      expect(out).toContain("installed harness 9.9.9");
      const cli = join(home, ".harness", "cli", "cli.js");
      expect(readFileSync(join(home, ".local", "bin", "hn"), "utf8")).toBe(`#!/bin/sh\nexec '/opt/harness node/bin/node' '${cli}' tui "$@"\n`);
      expect(readFileSync(join(home, ".local", "bin", "harness"), "utf8")).toBe(`#!/bin/sh\nexec '/opt/harness node/bin/node' '${cli}' "$@"\n`);
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
      const { code, out } = await runCliStep(home);
      expect(code).toBe(0);
      expect(readFileSync(join(home, ".local", "bin", "hn"), "utf8")).toBe("#!/bin/sh\necho hacker news\n");
      expect(out).toContain("is another program; run hn as: harness tui");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
