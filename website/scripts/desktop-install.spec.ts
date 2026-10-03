import { spawnSync } from "child_process";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const installer = join(process.cwd(), "scripts", "desktop-install.sh");

describe("desktop-install.sh", () => {
  it("is valid POSIX shell", () => {
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
});
