#!/usr/bin/env bash
# Installs what release-build.sh and release-check.sh need on a fresh macOS, Linux or Windows runner (RELEASE.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

# It installs tools for the whole machine, so it never runs on a person's computer.
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  echo "release-setup: runs on GitHub Actions only (it installs tools)" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  # Git Bash, which runs a Windows job's bash steps.
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *)
    echo "release-setup: macOS, Linux or Windows only" >&2
    exit 1
    ;;
esac

rustup toolchain install stable --profile minimal
case "$os" in
  macos) rustup target add aarch64-apple-darwin x86_64-apple-darwin ;;
  # Tauri's Linux packages: the webview, the tray, SVG icons, and libxdo, which its menu crate links; `file`, which its
  # AppImage bundler runs.
  linux)
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      libxdo-dev file
    ;;
  # Both arches build on one x64 runner.
  windows) rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc ;;
esac
# The version that wrote Cargo.lock.
cargo install tauri-cli --version 2.12.4 --locked
(cd "$app/ui" && npm ci --no-audit --no-fund)
# release-check.sh verifies the update signature with it.
case "$os" in
  macos) brew install minisign ;;
  linux) sudo apt-get install -y --no-install-recommends minisign ;;
  # No package source on the runner has it: minisign's own release, pinned by its sha256. The x86_64 build: the jobs
  # that check run on x64.
  windows)
    tools="$(cygpath -u "$RUNNER_TEMP")/minisign"
    sha256=37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479
    mkdir -p "$tools"
    curl -fsSL --retry 3 -o "$tools/minisign.zip" \
      https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip
    if [[ "$(sha256sum <"$tools/minisign.zip")" != "$sha256  -" ]]; then
      echo "release-setup: minisign-0.12-win64.zip is not the file pinned here" >&2
      exit 1
    fi
    # The $ in single quotes is PowerShell's.
    # shellcheck disable=SC2016
    MINISIGN_ZIP="$(cygpath -w "$tools/minisign.zip")" MINISIGN_DIR="$(cygpath -w "$tools")" \
      pwsh -NoProfile -NonInteractive -Command '$ErrorActionPreference = "Stop"
        Expand-Archive -LiteralPath $env:MINISIGN_ZIP -DestinationPath $env:MINISIGN_DIR'
    cygpath -w "$tools/minisign-win64/x86_64" >>"$GITHUB_PATH"
    ;;
esac
