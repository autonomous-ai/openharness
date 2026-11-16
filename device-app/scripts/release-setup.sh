#!/usr/bin/env bash
# Installs what release-build.sh and release-check.sh need on a fresh macOS runner (RELEASE.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

# It installs tools for the whole machine, so it never runs on a person's Mac.
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  echo "release-setup: runs on GitHub Actions only (it installs tools)" >&2
  exit 1
fi

rustup toolchain install stable --profile minimal
rustup target add aarch64-apple-darwin x86_64-apple-darwin
# The version that wrote Cargo.lock.
cargo install tauri-cli --version 2.12.4 --locked
(cd "$app/ui" && npm ci --no-audit --no-fund)
# release-check.sh verifies the update archive's signature with it.
brew install minisign
