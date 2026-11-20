#!/usr/bin/env bash
# Installs what release-build.sh and release-check.sh need on a fresh macOS, Linux or Windows runner (RELEASE.md).
# Two jobs need only part of it:
# - `release-setup.sh tauri-cli`: Rust and the Tauri CLI, for the job that makes the CLI the Windows signing job runs,
#   where no app code may run.
# - `release-setup.sh minisign`: minisign, for the job that checks the signed Windows installers.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

# It installs tools for the whole machine, so it never runs on a person's computer.
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  echo "release-setup: runs on GitHub Actions only (it installs tools)" >&2
  exit 1
fi

mode="${1:-}"
if ! [[ $# -le 1 && ("$mode" == "" || "$mode" == tauri-cli || "$mode" == minisign) ]]; then
  echo "usage: release-setup.sh [tauri-cli | minisign]" >&2
  exit 2
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

# release-check.sh verifies the update signature with it. Neither Ubuntu 22.04's apt nor any package source on the
# Windows runner has it: there it is minisign's own release, pinned by its sha256. Each pin is the sha256 of an asset
# that `minisign -Vm <asset> -P RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3` verified against the
# release's <asset>.minisig, with the release key minisign's README publishes.
# Downloads minisign 0.12's asset $2 into the folder $1 and stops unless its sha256 is $3.
fetch_minisign() {
  mkdir -p "$1"
  curl -fsSL --retry 3 -o "$1/$2" "https://github.com/jedisct1/minisign/releases/download/0.12/$2"
  local sum
  sum="$(sha256sum <"$1/$2")"
  # Only the hash: Git Bash's sha256sum marks its input binary, "<hash> *-".
  if [[ "${sum%% *}" != "$3" ]]; then
    echo "release-setup: $2 is not the file pinned here" >&2
    exit 1
  fi
}
install_minisign() {
  case "$os" in
    macos) brew install minisign ;;
    # Static binaries, one folder per arch, named as `uname -m` names it.
    linux)
      local tools="$RUNNER_TEMP/minisign"
      fetch_minisign "$tools" minisign-0.12-linux.tar.gz \
        9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73
      tar -xzf "$tools/minisign-0.12-linux.tar.gz" -C "$tools"
      echo "$tools/minisign-linux/$(uname -m)" >>"$GITHUB_PATH"
      ;;
    # The x86_64 build: the jobs that check run on x64.
    windows)
      local tools
      tools="$(cygpath -u "$RUNNER_TEMP")/minisign"
      fetch_minisign "$tools" minisign-0.12-win64.zip \
        37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479
      # The $ in single quotes is PowerShell's.
      # shellcheck disable=SC2016
      MINISIGN_ZIP="$(cygpath -w "$tools/minisign-0.12-win64.zip")" MINISIGN_DIR="$(cygpath -w "$tools")" \
        pwsh -NoProfile -NonInteractive -Command '$ErrorActionPreference = "Stop"
          Expand-Archive -LiteralPath $env:MINISIGN_ZIP -DestinationPath $env:MINISIGN_DIR'
      cygpath -w "$tools/minisign-win64/x86_64" >>"$GITHUB_PATH"
      ;;
  esac
}

if [[ "$mode" == minisign ]]; then
  install_minisign
  exit 0
fi
# The version that wrote Cargo.lock.
tauri_cli_version=2.12.4
# CI restores the CLI from a cache keyed on this file: one already at the pin is kept, not compiled again.
install_tauri_cli() {
  if [[ "$(cargo tauri --version 2>/dev/null)" != "tauri-cli $tauri_cli_version" ]]; then
    cargo install tauri-cli --version "$tauri_cli_version" --locked
  fi
}
rustup toolchain install stable --profile minimal
if [[ "$mode" == tauri-cli ]]; then
  install_tauri_cli
  exit 0
fi
case "$os" in
  macos) rustup target add aarch64-apple-darwin x86_64-apple-darwin ;;
  # Tauri's Linux packages: the webview, the tray, SVG icons, and libxdo, which its menu crate links; `file`, which its
  # AppImage bundler runs. Through PR CI's installer, which rides out an outage of the runner's Ubuntu mirrors.
  linux)
    sudo bash "$(dirname "$app")/scripts/apt-install.sh" libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
      librsvg2-dev libxdo-dev file
    ;;
  # Both arches build on one x64 runner.
  windows) rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc ;;
esac
install_tauri_cli
(cd "$app/ui" && npm ci --no-audit --no-fund)
install_minisign
