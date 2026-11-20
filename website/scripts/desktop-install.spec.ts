import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

const installer = join(process.cwd(), "scripts", "desktop-install.sh");

const MANIFEST_URL = "https://example.test/harness/desktop/metadata.json";

/**
 * Runs the installer as `os` against a manifest whose `key` entry has `version` and `url`, with stub tools
 * on PATH: curl serves the manifest and records, then fails, every other download, so the run stops right
 * after the URL check. Returns the result and the URLs it tried to download.
 */
function runInstaller(os: "Darwin" | "Linux", key: string, version: string, url: string) {
  const dir = mkdtempSync(join(tmpdir(), "harness-install-"));
  try {
    const bin = join(dir, "bin");
    const manifest = join(dir, "metadata.json");
    const downloads = join(dir, "downloads");
    const sha256 = "a".repeat(64);
    mkdirSync(bin);
    writeFileSync(manifest, JSON.stringify({ [key]: { version, url, sha256, size: 1 } }, null, 2));
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("uname", `[ "$1" = -s ] && echo ${os} || echo x86_64`);
    stub(
      "curl",
      `out= url= prev=
for arg; do
  if [ "$prev" = -o ]; then out="$arg"; else case "$arg" in -*) ;; *) url="$arg" ;; esac; fi
  prev="$arg"
done
if [ "$url" = '${MANIFEST_URL}' ]; then cp '${manifest}' "$out"; exit 0; fi
printf '%s\\n' "$url" >> '${downloads}'
exit 22`,
    );
    stub(
      "plutil",
      `case "$2" in
  ${key}.version) printf '%s' '${version}' ;;
  ${key}.url) printf '%s' '${url}' ;;
  ${key}.sha256) printf '%s' '${sha256}' ;;
  ${key}.size) printf '%s' 1 ;;
  *) exit 1 ;;
esac`,
    );
    // Never reached before the download fails; present only so the installer's tool checks pass on any OS.
    for (const name of ["shasum", "sha256sum", "ditto", "lipo", "open", "pgrep"]) stub(name, "exit 1");

    const result = spawnSync("sh", [installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        HARNESS_DESKTOP_APP_DIR: join(dir, "app"),
        HARNESS_DESKTOP_METADATA_URL: MANIFEST_URL,
      },
    });
    const requested = existsSync(downloads) ? readFileSync(downloads, "utf8").split("\n").filter(Boolean) : [];
    return { result, requested };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it.each([
    ["Darwin", "desktop-macos", "https://cdn.autonomous.ai/harness/desktop/1.2.4/Harness-macos.zip"],
    [
      "Linux",
      "desktop-linux-x64",
      "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.2.4/Harness-linux-x64.AppImage",
    ],
  ] as const)("%s downloads the release's own file (%s): %s", (os, key, url) => {
    const { result, requested } = runInstaller(os, key, "1.2.4", url);

    expect(requested).toEqual([url]);
    expect(result.stderr).toContain("could not download Harness 1.2.4");
  });

  // curl collapses dot segments, so a glob's `*` matching `../..` would download from another bucket.
  it.each([
    ["Darwin", "desktop-macos", "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/../../../attacker-bucket/Harness-macos.zip"],
    ["Darwin", "desktop-macos", "https://cdn.autonomous.ai/harness/desktop/1.2.4/../../device/1.2.4/Harness-macos.zip"],
    ["Darwin", "desktop-macos", "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-macos.zip"],
    ["Linux", "desktop-linux-x64", "https://cdn.autonomous.ai/harness/desktop/../../../attacker-bucket/Harness-linux-x64.AppImage"],
  ] as const)("%s refuses a URL outside the release's own folder (%s): %s", (os, key, url) => {
    const { result, requested } = runInstaller(os, key, "1.2.4", url);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("desktop metadata points outside the Harness desktop release bucket");
    expect(requested).toEqual([]);
  });
});
