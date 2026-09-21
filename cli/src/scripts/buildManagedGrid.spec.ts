/**
 * `cli/scripts/build-managed-grid.sh` — the grid CLI as a managed runtime archive, one per platform.
 *
 * Linux is a DOWNLOAD of autonomous-grid's own release binary, verified against the SHA256SUMS the
 * release ships, then wrapped in the archive shape every managed runtime has
 * (`grid-<ver>-<platform>/bin/grid`). That path is driven here end to end through a fake `curl`.
 * The macOS path builds with Nuitka from a checkout and is not run here — only its refusals are.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "build-managed-grid.sh");

const writeCommand = (directory: string, name: string, lines: string[]) => {
  const path = join(directory, name);
  writeFileSync(path, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(path, 0o700);
};

/** A fake release: the Linux binary, its SHA256SUMS and a LICENSE, served by a `curl` that reads
 *  the URL and the `-o` target off its own argv, whatever flags come before them. */
const releaseFixture = (scratch: string, tamperSums = false) => {
  const binary = join(scratch, "release", "grid-linux-x86_64");
  mkdirSync(join(scratch, "release"), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nprintf 'grid 9.9.9\\n'\n");
  const sha = createHash("sha256").update(readFileSync(binary)).digest("hex");
  writeFileSync(join(scratch, "release", "SHA256SUMS"), `${tamperSums ? "0".repeat(64) : sha}  grid-linux-x86_64\n${"1".repeat(64)}  grid-linux-arm64\n`);
  writeFileSync(join(scratch, "release", "LICENSE"), "MIT\n");
  writeCommand(scratch, "curl", [
    `printf '%s\\n' "$*" >> '${join(scratch, "curl-invocations")}'`,
    'url=""; out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done',
    `case "$url" in *SHA256SUMS) cp '${join(scratch, "release", "SHA256SUMS")}' "$out" ;; *LICENSE) cp '${join(scratch, "release", "LICENSE")}' "$out" ;; *grid-linux-x86_64) cp '${binary}' "$out" ;; *) exit 22 ;; esac`,
  ]);
};

const run = (scratch: string, args: string[]) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${scratch}:/usr/bin:/bin`,
      GRID_RELEASE_BASE: "https://cdn.example/v9.9.9",
      GRID_RAW_BASE: "https://raw.example/v9.9.9",
    },
  });

describe("scripts/build-managed-grid.sh", () => {
  it("wraps grid's Linux release binary, verified against its SHA256SUMS, in the managed-runtime shape", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-build-grid-"));
    try {
      releaseFixture(scratch);
      const out = join(scratch, "out");
      const result = run(scratch, ["linux-x64", "9.9.9", out]);

      expect(result.status, result.stderr).toBe(0);
      const archive = join(out, "grid-9.9.9-linux-x64.tar.gz");
      expect(existsSync(archive)).toBe(true);
      const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout.split("\n");
      expect(listing).toContain("grid-9.9.9-linux-x64/bin/grid");
      expect(listing).toContain("grid-9.9.9-linux-x64/LICENSE.grid");
      // The archive carries the mode the runtime is laid down with: runnable as unpacked.
      const unpack = join(scratch, "unpack");
      mkdirSync(unpack);
      spawnSync("tar", ["-xzf", archive, "-C", unpack]);
      expect(statSync(join(unpack, "grid-9.9.9-linux-x64", "bin", "grid")).mode & 0o111).not.toBe(0);
      expect(readFileSync(join(scratch, "curl-invocations"), "utf8")).toContain("https://cdn.example/v9.9.9/SHA256SUMS");
      expect(result.stdout).toContain("built ");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a binary whose checksum is not the one SHA256SUMS names, and builds nothing", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-build-grid-tampered-"));
    try {
      releaseFixture(scratch, true);
      const out = join(scratch, "out");
      const result = run(scratch, ["linux-x64", "9.9.9", out]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum");
      expect(existsSync(join(out, "grid-9.9.9-linux-x64.tar.gz"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a platform it does not publish for, and a version that is not a release tag", () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-build-grid-args-"));
    try {
      expect(run(scratch, ["windows-x64", "9.9.9", scratch]).status).toBe(2);
      expect(run(scratch, ["linux-x64", "v9.9.9", scratch]).status).toBe(2);
      expect(run(scratch, ["linux-x64", "", scratch]).status).toBe(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
