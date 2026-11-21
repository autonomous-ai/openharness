#!/usr/bin/env bash
# Sign one desktop release's Linux AppImages with Harness Device's Tauri key, in Tauri's form, so the Linux app's
# updater installs only what Harness signed (docs/plans/2026-11-21-linux-updates-verified-design.md).
#
# Usage: bash desktop/scripts/sign-desktop-linux.sh <X.Y.Z> <folder>
#   <folder> holds Harness-linux-<x64|arm64>.AppImage and its .sha256, as build-linux made them; each gets its .sig.
# Environment: TAURI_SIGNING_PRIVATE_KEY (Tauri's form: the minisign key file, base64-encoded) and
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
#
# release-desktop.yml's sign-linux job holds the key, so this runs nothing but minisign (pinned by release-setup.sh)
# and coreutils: no build code ever shares a runner with the key. The key reaches minisign as a 0600 file removed on
# exit, the password on its stdin, never an argument. It checks no signature: the workflow's next step does
# (verify-desktop-release.py --signed, against the key pinned in the repository), so this runs with a throwaway key too.
set -euo pipefail
set +x

VERSION="${1:-}"
DIR="${2:-}"
# The version goes into the trusted comment whole: anything but X.Y.Z could add a field.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ ! -d "$DIR" ] || [ "$#" -ne 2 ]; then
  echo "usage: $0 <X.Y.Z> <folder with Harness-linux-x64.AppImage, Harness-linux-arm64.AppImage and their .sha256>" >&2
  exit 2
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD are required; nothing was signed." >&2
  exit 2
fi

NAMES=(Harness-linux-x64.AppImage Harness-linux-arm64.AppImage)
# Every file is checked before any is signed. The sums are compared whole, so they must name this file:
# `sha256sum --check` alone would pass a list that names another one.
for name in "${NAMES[@]}"; do
  if [ ! -f "$DIR/$name" ] || [ ! -f "$DIR/$name.sha256" ]; then
    echo "error: $name or its .sha256 is missing; nothing was signed." >&2
    exit 1
  fi
  if [ "$(cd "$DIR" && sha256sum "$name")" != "$(<"$DIR/$name.sha256")" ]; then
    echo "error: $name does not match its .sha256; nothing was signed." >&2
    exit 1
  fi
done

WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sign-desktop-linux.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# printf is a builtin, so no process's argv holds the key or the password.
(umask 077 && printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" | base64 --decode >"$WORK/secret.key")
for name in "${NAMES[@]}"; do
  # No version: field: Harness Device's updater reads that one, and must never accept a Desktop AppImage.
  printf -v comment 'timestamp:%s\tfile:%s\tdesktop-version:%s' "$(date +%s)" "$name" "$VERSION"
  printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" |
    minisign -S -s "$WORK/secret.key" -m "$DIR/$name" -x "$WORK/$name.minisig" -t "$comment"
done
# Both signed before either is written, so a failure leaves the folder as it was.
for name in "${NAMES[@]}"; do
  # Tauri's form: the .minisig text base64-encoded on one line, as `cargo tauri signer sign` writes it.
  base64 <"$WORK/$name.minisig" | tr -d '\n' >"$DIR/$name.sig"
  echo ">> signed $name for Desktop $VERSION"
done
