#!/usr/bin/env bash
# flash-circle — download the published CIRCLE firmware from GCS and flash it over USB.
#
# Written for operations, not for developers: no repo, no ESP-IDF, no Python, no build. It fetches a
# standalone esptool binary and the firmware from the same public bucket, checks both against their
# published sha256, finds the board itself, and refuses to write to anything that is not an ESP32-S3.
#
#   curl -fsSL https://harness.autonomous.ai/flash-circle.sh -o flash-circle.sh
#   bash flash-circle.sh
#
# Requires only curl, tar and bash — every macOS and Linux ships all three.
#
#   --detect-only     find the board and print what it is; write nothing
#   --no-flash        download + verify the firmware, then stop (prints the cached path)
#   --version X.Y.Z   flash a specific published version instead of the newest
#   --port /dev/...   skip auto-detection (needed when two boards are plugged in)
#   --yes             don't ask for confirmation (required when stdin is not a terminal; `harness
#                     flash` always passes it — the ESP32-S3 check below is the real guard, and a
#                     prompt in front of a customer converting their own device is friction, not safety)
#   --erase-nvs       ALSO wipe pairing + saved WiFi. Off by default: a normal flash keeps them
#   --no-verify       don't reopen the port afterwards to confirm the running version
#   --version-info    print this tool's version and exit
#
# SCOPE — this UPDATES a board that already works. The published artifact is the app image only; it
# carries no bootloader or partition table, so a virgin board still needs a one-time `idf.py flash`
# from the repo. If this tool ever reports the board as anything other than ESP32-S3, stop: that is
# the square board (ESP32-P4) or someone else's device, and writing to it would take a USB cable and
# a person to undo.
# Started with `sh flash-circle.sh`? That is what people type, and on Linux /bin/sh is dash: this
# script uses bash arrays and `set -o pipefail`, so it would die on the very next line. Re-exec under
# bash before anything else runs. (On macOS /bin/sh IS bash, so BASH_VERSION is already set there.)
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

FLASHER_VERSION="1.2.0"

# --- Where things live (all overridable; names match scripts/upload-firmware.sh) ---
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PUBLIC_BASE_URL="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/esp32/ota/metadata.json}"
OTA_KEY="${OTA_KEY:-commander}"                 # must match DEVICE_OTA_KEY in main/config_store.h
FIRMWARE_PATH_PREFIX="${FIRMWARE_PATH_PREFIX:-harness/esp32/bin}"   # <prefix>/<ver>.bin
FLASHER_BASE="${FLASHER_BASE:-${GCS_PUBLIC_BASE_URL%/}/harness/flasher}"
ESPTOOL_VERSION="${ESPTOOL_VERSION:-5.3.1}"
ESPTOOL_RELEASE_BASE="${ESPTOOL_RELEASE_BASE:-https://github.com/espressif/esptool/releases/download}"
CACHE_DIR="${HARNESS_FLASHER_CACHE:-$HOME/.harness/flasher}"

# --- Flash geometry. Source of truth: apps/esp32-circle/partitions.csv ---
# Deliberately hardcoded rather than read from build/flash_args: an operations machine has no build
# directory. The values are asserted against flash_args in CI-adjacent use (see RELEASE.md).
CHIP="esp32s3"                 # circle. The square board is esp32p4 — that mismatch is a hard stop.
APP_OFFSET="0x20000"           # ota_0
OTADATA_OFFSET="0xf000"        # otadata
OTADATA_SIZE="0x2000"
NVS_OFFSET="0x9000"            # pairing token + saved WiFi live here — never touched unless --erase-nvs
NVS_SIZE="0x6000"
FLASH_MODE="dio"; FLASH_FREQ="80m"; FLASH_SIZE="16MB"

DETECT_ONLY=0; NO_FLASH=0; ASSUME_YES=0; ERASE_NVS=0; NO_VERIFY=0
WANT_VERSION=""; PORT=""

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --detect-only)  DETECT_ONLY=1 ;;
    --no-flash)     NO_FLASH=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --erase-nvs)    ERASE_NVS=1 ;;
    --no-verify)    NO_VERIFY=1 ;;
    --version-info) say "flash-circle $FLASHER_VERSION"; exit 0 ;;
    --version=*)    WANT_VERSION="${1#*=}" ;;
    --port=*)       PORT="${1#*=}" ;;
    --version)      shift; [ $# -gt 0 ] || die "--version needs X.Y.Z"; WANT_VERSION="$1" ;;
    --port)         shift; [ $# -gt 0 ] || die "--port needs a device path"; PORT="$1" ;;
    --help|-h)      usage ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
  shift
done
[ -z "$WANT_VERSION" ] || [[ "$WANT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must look like X.Y.Z"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"
mkdir -p "$CACHE_DIR"

# sha256 of a file. macOS ships shasum, most Linux ships sha256sum — accept either.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else die "need shasum or sha256sum to verify downloads"
  fi
}

# One field out of the published manifest. Uses python3 when present (exact), else flattens the JSON
# and cuts the value out — the file is machine-generated by upload-firmware.sh with a fixed shape, so
# the fallback is reliable for it and NOT a general-purpose parser.
json_field() {  # <json-file> <key> <field>
  local file="$1" key="$2" field="$3"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$key" "$field" <<'PY'
import json, sys
path, key, field = sys.argv[1:4]
try:
    with open(path) as f:
        entry = json.load(f).get(key) or {}
except Exception:
    entry = {}
value = entry.get(field, "")
sys.stdout.write("" if value is None else str(value))
PY
    return
  fi
  tr -d ' \n\t\r' < "$file" \
    | sed -n "s/.*\"${key}\":{\([^}]*\)}.*/\1/p" \
    | sed -n "s/.*\"${field}\":\"\{0,1\}\([^,\"]*\)\"\{0,1\}.*/\1/p"
}

# --- esptool: prefer the pinned mirror, fall back to whatever the machine already has --------------
# The mirror is what makes this work on a bare operations laptop; the fallback is what makes it work
# for a developer whose ESP-IDF is already on PATH (and before the mirror is first populated).
esptool_asset() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Darwin) os="macos" ;;
    Linux)  os="linux" ;;
    *) die "unsupported OS '$os' — this tool runs on macOS and Linux" ;;
  esac
  case "$arch" in
    arm64|aarch64) [ "$os" = macos ] && arch="arm64" || arch="aarch64" ;;
    x86_64|amd64)  arch="amd64" ;;
    armv7l)        arch="armv7" ;;
    *) die "unsupported CPU '$arch'" ;;
  esac
  printf 'esptool-v%s-%s-%s.tar.gz' "$ESPTOOL_VERSION" "$os" "$arch"
}

# sha256 of each esptool asset, taken from the vendor's own release digests. Pinned rather than
# fetched so an auto-install is verified against something this script carries, not against whatever
# the download server chooses to say today. Bumping ESPTOOL_VERSION means replacing this block —
# `upload-flasher.sh --mirror-esptool` prints the new one, so it is a copy-paste, not arithmetic.
esptool_pinned_sha() {
  case "$1" in
    esptool-v5.3.1-macos-arm64.tar.gz)   echo f63f7203d88cfe4c17aea34d6cf82769458ce204e49a05816c6384c2d299e6ca ;;
    esptool-v5.3.1-macos-amd64.tar.gz)   echo f8ec4fcaf7d79845a0e8ad60b24be9f584d8fe03f341b5ad4ec0df0ec855e670 ;;
    esptool-v5.3.1-linux-amd64.tar.gz)   echo e9cc641f8e4a0b644b52836d7a6b59f3c6d3261213c5ccc41f8f3c3035d06aa4 ;;
    esptool-v5.3.1-linux-aarch64.tar.gz) echo dd2613cdc8e73d1200a3daff2025ff51daa5bbdb3a352fe35d6b7377891aecc8 ;;
    esptool-v5.3.1-linux-armv7.tar.gz)   echo 54a2f902acf47dd4542c1ed6958eb9442fe818a16a7ecfaeaab57b872e7e8460 ;;
    *) echo "" ;;
  esac
}

# Download <url> into the cache, check it against <want-sha> (empty = unverified, allowed only for the
# mirror, which serves its own .sha256), unpack it, and hand back the binary. Returns 1 on any miss so
# the caller can try the next source.
esptool_install_from() {  # <url> <want-sha> <asset> <dir>
  local url="$1" want="$2" asset="$3" dir="$4" tgz got found
  tgz="$CACHE_DIR/$asset"
  curl -fsL --retry 2 -o "$tgz" "$url" || { rm -f "$tgz"; return 1; }
  if [ -n "$want" ]; then
    got="$(sha256_of "$tgz")"
    if [ "$got" != "$want" ]; then
      rm -f "$tgz"
      warn "   sha256 mismatch from $url (expected $want, got $got) — not installing"
      return 1
    fi
  fi
  mkdir -p "$dir"
  tar -xzf "$tgz" -C "$dir" || { rm -f "$tgz"; return 1; }
  rm -f "$tgz"
  # A browser download tags files with com.apple.quarantine and Gatekeeper then refuses to run the
  # binary with a message operations cannot act on. curl does not set it; strip it anyway.
  [ "$(uname -s)" = Darwin ] && xattr -dr com.apple.quarantine "$dir" 2>/dev/null || true
  found="$(find "$dir" -maxdepth 2 -name esptool -type f 2>/dev/null | head -1 || true)"
  [ -n "$found" ] || return 1
  chmod +x "$found"
  ESPTOOL="$found"
  return 0
}

ESPTOOL=""
ensure_esptool() {
  local asset dir url tgz want got found
  asset="$(esptool_asset)"
  dir="$CACHE_DIR/${asset%.tar.gz}"
  found="$(find "$dir" -maxdepth 2 -name esptool -type f -perm -u+x 2>/dev/null | head -1 || true)"
  if [ -n "$found" ]; then ESPTOOL="$found"; return; fi

  local pinned mirror_url mirror_sha
  pinned="$(esptool_pinned_sha "$asset")"
  say ">> installing esptool $ESPTOOL_VERSION ($asset)"

  # 1. Our mirror first: it is reachable from networks that block GitHub, and it serves its own
  #    .sha256 so it stays verifiable even for a version this script has no pin for.
  mirror_url="${FLASHER_BASE%/}/esptool/${ESPTOOL_VERSION}/${asset}"
  mirror_sha="$(curl -fsL --retry 1 "${mirror_url}.sha256" 2>/dev/null | awk '{print $1}' || true)"
  [ -z "$mirror_sha" ] && mirror_sha="$pinned"
  if [ -n "$mirror_sha" ] && esptool_install_from "$mirror_url" "$mirror_sha" "$asset" "$dir"; then
    say "   installed from the mirror ✓"; return
  fi

  # 2. Vendor release, checked against the pin above. This is what makes the tool self-sufficient
  #    before the mirror exists — no pip, no Python, no toolchain.
  if [ -n "$pinned" ]; then
    if esptool_install_from "${ESPTOOL_RELEASE_BASE}/v${ESPTOOL_VERSION}/${asset}" "$pinned" "$asset" "$dir"; then
      say "   installed from the esptool release ✓ (sha256 pinned)"; return
    fi
  else
    warn "   (no pinned sha256 for esptool $ESPTOOL_VERSION — refusing to install an unverified binary)"
  fi

  warn "   (mirror unavailable at $url — falling back to a local esptool)"
  if command -v esptool.py >/dev/null 2>&1; then ESPTOOL="esptool.py"; return; fi
  if command -v esptool >/dev/null 2>&1; then ESPTOOL="esptool"; return; fi
  if command -v python3 >/dev/null 2>&1 && python3 -m esptool version >/dev/null 2>&1; then
    ESPTOOL="python3 -m esptool"; return
  fi
  # A developer box usually has esptool inside ESP-IDF but NOT on PATH unless export.sh was sourced.
  # Source it in a subshell-safe way and look again, so the tool works from a plain terminal.
  local idf
  for idf in "${IDF_PATH:-}" "$HOME/esp/esp-idf" "$HOME/esp/v5.5/esp-idf"; do
    [ -n "$idf" ] && [ -f "$idf/export.sh" ] || continue
    say "   (trying ESP-IDF at $idf)"
    # shellcheck disable=SC1091
    if . "$idf/export.sh" >/dev/null 2>&1; then
      if command -v esptool.py >/dev/null 2>&1; then ESPTOOL="esptool.py"; return; fi
      if command -v esptool >/dev/null 2>&1; then ESPTOOL="esptool"; return; fi
    fi
  done
  die "no esptool available.
  This should not happen: the tool installs a pinned esptool by itself. It means both the
  mirror and the vendor release were unreachable. Check the network, or install esptool
  manually (pip install esptool) and re-run."
}

esp() { $ESPTOOL "$@"; }   # keeps the invocation in ONE place if esptool renames its flags again

# The child this script is currently waiting on, so it can be cleaned up on the way out.
#
# ⚠️ WITHOUT THIS, CANCELLING LEAKS. A TERM to this script runs its traps and exits, and esptool —
# a GRANDCHILD, blocked on a serial read — is reparented to init and keeps the port. Cancelled probes
# were seen stacking up three at a time on one port, each making the next one slower, so pressing the
# button again made things worse rather than better.
CHILD_PID=""

kill_child() {
  [ -n "$CHILD_PID" ] || return 0
  # ⚠️ THE WHOLE GROUP, NOT THE PID. esptool runs a child of its own, so killing the process we
  # started leaves that grandchild holding the serial port — which is exactly the shape of the
  # orphans found stacked on one port. `run_bounded` puts the job in its own process group so the
  # negative pid below can reach all of it; the plain-pid form is the fallback if it did not.
  #
  # TERM, then KILL, because an esptool blocked in a serial read does not answer TERM at all.
  # `-s SIG -- -PID`, and the punctuation is load-bearing: written as `kill -TERM -1234`, bash reads
  # `-1234` as a SIGNAL NAME, reports success, and signals nothing. That form was tried and the
  # process survived it.
  kill -s TERM -- "-$CHILD_PID" 2>/dev/null || kill -s TERM -- "$CHILD_PID" 2>/dev/null || true
  local waited=0
  while kill -0 "$CHILD_PID" 2>/dev/null && [ "$waited" -lt 3 ]; do sleep 1; waited=$((waited + 1)); done
  kill -s KILL -- "-$CHILD_PID" 2>/dev/null || kill -s KILL -- "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""
}

# Run a command with a hard time limit, portably.
#
# macOS ships no `timeout`(1) — that is why this is hand-rolled rather than a one-liner, and why the
# probe below had no bound at all until now.
run_bounded() {  # <seconds> <command…>
  local secs="$1"; shift
  # Job control on for the spawn only, so the child leads its OWN process group and `kill -- -PID`
  # reaches the whole tree. Without it every job shares this shell's group and killing "the group"
  # would take this script down with it.
  set -m
  "$@" &
  CHILD_PID=$!
  set +m
  local waited=0 rc=0
  while kill -0 "$CHILD_PID" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill_child
      return 124
    fi
    sleep 1; waited=$((waited + 1))
  done
  wait "$CHILD_PID" 2>/dev/null || rc=$?
  CHILD_PID=""
  return "$rc"
}

# --- find the board -------------------------------------------------------------------------------
candidate_ports() {
  case "$(uname -s)" in
    Darwin) ls /dev/cu.usbmodem* /dev/cu.wchusbserial* /dev/cu.SLAB_USBtoUART* 2>/dev/null || true ;;
    Linux)  ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true ;;
  esac
}

# Ask a port what it is. Read-only: chip_id neither erases nor writes. It does pulse DTR/RTS, which
# resets whatever is on the other end — harmless, but it is why we report what we found rather than
# silently probing a stranger's board.
# How long one port is given to answer. Generous — a real board syncs in a second or two — and
# BOUNDED, which is the part that was missing: a port that never answers used to hang the probe for
# ever, and the dialog just span.
PROBE_TIMEOUT="${HARNESS_PROBE_TIMEOUT:-25}"

probe_port() {  # <port> → echoes the detected chip name, or nothing
  local out log; log="$(mktemp)"
  # `--connect-attempts 1`: esptool retries the sync handshake several times by default, and every
  # one of those attempts resets the board. Once is enough to answer "is there an ESP32-S3 here", and
  # it keeps the whole probe inside the bound above.
  run_bounded "$PROBE_TIMEOUT" \
    esp --port "$1" --before default_reset --after hard_reset --connect-attempts 1 --no-stub chip_id \
    > "$log" 2>&1 || true
  out="$(cat "$log" 2>/dev/null || true)"; rm -f "$log"
  if printf '%s' "$out" | grep -qi "esp32-s3"; then printf 'ESP32-S3'; return; fi
  printf '%s' "$out" | sed -n 's/.*Detecting chip type\.\.\.* *//p' | head -1 | tr -d '\r'
}

pick_port() {
  [ -n "$PORT" ] && { say ">> using port $PORT (given)"; return; }
  local ports=() p chip matches=()
  while IFS= read -r p; do [ -n "$p" ] && ports+=("$p"); done <<< "$(candidate_ports)"
  [ "${#ports[@]}" -gt 0 ] || die "no USB serial device found. Plug the board in and check the cable carries data (some are charge-only)."
  say ">> probing ${#ports[@]} serial port(s)…"
  for p in "${ports[@]}"; do
    if [ ! -r "$p" ] || [ ! -w "$p" ]; then
      warn "   $p — no permission"
      [ "$(uname -s)" = Linux ] && warn "     fix: sudo usermod -aG dialout \$USER   (then log out and back in)"
      continue
    fi
    chip="$(probe_port "$p")"
    case "$chip" in
      *ESP32-S3*) say "   $p → ESP32-S3 ✓"; matches+=("$p") ;;
      "")         say "   $p → no ESP chip answered — skipped" ;;
      *)          say "   $p → $chip — NOT a circle board, skipped" ;;
    esac
  done
  [ "${#matches[@]}" -gt 0 ] || die "found no ESP32-S3. The circle board is esp32s3; the square board is esp32p4 and must NOT be flashed with this image."
  if [ "${#matches[@]}" -gt 1 ]; then
    warn "more than one ESP32-S3 is connected:"; for p in "${matches[@]}"; do warn "  $p"; done
    die "pass --port <one of the above> so the right board is written"
  fi
  PORT="${matches[0]}"
  say ">> board: $PORT"
}

# --- resolve + fetch the firmware -----------------------------------------------------------------
FW_VER=""; FW_URL=""; FW_SHA=""; FW_SIZE=""; FW_FILE=""
resolve_release() {
  local meta; meta="$(mktemp)"
  curl -fsSL --retry 2 "${GCS_PUBLIC_BASE_URL%/}/${METADATA_PATH#/}" -o "$meta" \
    || die "cannot read the release manifest (network? bucket?)"
  if [ -n "$WANT_VERSION" ]; then
    FW_VER="$WANT_VERSION"
    FW_URL="${GCS_PUBLIC_BASE_URL%/}/${FIRMWARE_PATH_PREFIX#/}/${FW_VER}.bin"
    FW_SHA=""; FW_SIZE=""
    warn "note: --version bypasses the manifest, which is the only place a sha256 is published."
    warn "      The download can be checked for shape but NOT for authenticity."
  else
    FW_VER="$(json_field "$meta" "$OTA_KEY" version)"
    FW_URL="$(json_field "$meta" "$OTA_KEY" url)"
    FW_SHA="$(json_field "$meta" "$OTA_KEY" sha256)"
    FW_SIZE="$(json_field "$meta" "$OTA_KEY" size)"
    [ -n "$FW_VER" ] && [ -n "$FW_URL" ] || die "manifest has no usable '$OTA_KEY' entry"
  fi
  rm -f "$meta"
  say ">> release: $OTA_KEY $FW_VER"
  say "   $FW_URL"
}

fetch_firmware() {
  local dir got magic
  dir="$CACHE_DIR/firmware/$OTA_KEY"; mkdir -p "$dir"
  FW_FILE="$dir/${FW_VER}.bin"
  if [ -f "$FW_FILE" ] && [ -n "$FW_SHA" ] && [ "$(sha256_of "$FW_FILE")" = "$FW_SHA" ]; then
    say ">> cached: $FW_FILE"
  else
    say ">> downloading…"
    curl -fL --retry 2 --progress-bar -o "$FW_FILE.part" "$FW_URL" || { rm -f "$FW_FILE.part"; die "download failed"; }
    mv -f "$FW_FILE.part" "$FW_FILE"
  fi
  if [ -n "$FW_SHA" ]; then
    got="$(sha256_of "$FW_FILE")"
    [ "$got" = "$FW_SHA" ] || { rm -f "$FW_FILE"; die "firmware sha256 mismatch (expected $FW_SHA, got $got) — refusing to flash"; }
    say "   sha256 ✓"
  fi
  if [ -n "$FW_SIZE" ]; then
    got="$(wc -c < "$FW_FILE" | tr -d ' ')"
    [ "$got" = "$FW_SIZE" ] || die "firmware size mismatch (expected $FW_SIZE, got $got)"
  fi
  # An ESP app image starts with magic 0xE9. Cheap shape check that catches an HTML error page saved
  # as a .bin — the failure mode when a bucket path is wrong and the CDN returns 404 HTML with 200.
  magic="$(od -An -tx1 -N1 "$FW_FILE" | tr -d ' \n')"
  [ "$magic" = "e9" ] || die "'$FW_FILE' is not an ESP firmware image (first byte 0x$magic, expected 0xe9)"
  [ -z "$FW_SHA" ] && say "   shape ✓ (unverified: no published sha256 for this version)"
  say "   $(wc -c < "$FW_FILE" | tr -d ' ') bytes"
}

# --- write ----------------------------------------------------------------------------------------
confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  # Under `curl … | bash` stdin IS the script, so a plain `read` would consume the script or return
  # instantly. Ask the terminal directly; with no terminal, demand --yes rather than assume consent.
  [ -e /dev/tty ] || die "not a terminal — re-run with --yes if this is intentional"
  local reply=""
  printf 'Flash %s %s to %s? [y/N] ' "$OTA_KEY" "$FW_VER" "$PORT" > /dev/tty
  read -r reply < /dev/tty || true
  case "$reply" in y|Y|yes|YES) return 0 ;; *) die "cancelled" ;; esac
}

# The Harness adapter watches USB devices and can keep the board's serial port open. harness flash
# runs this script as a child of the one-shot CLI command, so stopping the background adapter here does
# not interrupt this flasher. It also makes the direct curl script safe on a computer with Harness
# installed. Do not do this for read-only modes.
HARNESS_STOPPED=0

stop_harness_for_flash() {
  command -v harness >/dev/null 2>&1 || return 0
  say ">> stopping Harness to release USB serial ports…"
  # ⚠️ THE FLAG GOES DOWN BEFORE THE STOP, and that order is the point: the desktop app supervises the
  # daemon on a five-second timer and starts anything it finds missing. Stop the daemon without saying
  # why and the app puts it straight back, it reopens the dial, and esptool loses the port mid-write —
  # the flash then fails with "No more data to read from the serial port", which reads like broken
  # hardware. The app reads this file and leaves the daemon alone while it is fresh.
  #
  # A timestamp, not a lock: a script killed with -9 cannot clean up after itself, and a stale flag
  # that switched supervision off for ever would be a worse fault than the one it prevents.
  printf '%s\n' "$(date +%s)" > "$CACHE_DIR/flashing" 2>/dev/null || true
  harness stop >/dev/null || die "could not stop Harness. Run 'harness stop', then retry the flash."
  HARNESS_STOPPED=1
  # ⚠️ ARMED AS A TRAP, NOT AS A LINE AT THE END, because there are several ways out of this script after
  # the daemon is already down: --no-flash exits early, `die` aborts on any failure from here on, and the
  # user can interrupt a two-minute write. Every one of those used to leave Harness stopped — the dial
  # then sits dark and the computer has no idea it exists, which is a worse outcome than never having
  # flashed at all, and it does not look like a flasher problem when someone reports it later.
  trap flash_cleanup EXIT INT TERM
  # Give macOS/Linux a moment to release the serial file descriptor before esptool probes it.
  sleep 1
}

# Everything this script must undo on the way out, in the order it must be undone: let go of the
# board first, then give the daemon its port back.
flash_cleanup() {
  kill_child
  start_harness_after_flash
}

start_harness_after_flash() {
  [ "$HARNESS_STOPPED" -eq 1 ] || return 0
  HARNESS_STOPPED=0   # idempotent: EXIT still fires after an INT that already ran this
  rm -f "$CACHE_DIR/flashing" 2>/dev/null || true
  say ">> starting Harness again…"
  harness start >/dev/null 2>&1 || warn "could not start Harness — run 'harness start' yourself."
}

do_flash() {
  say ""
  say ">> flashing $FW_VER → $PORT"
  # Erase otadata FIRST. Without this a board that has taken an OTA is running from ota_1, and writing
  # ota_0 changes nothing it will ever boot: the flash "succeeds" and the old firmware keeps running.
  # A blank otadata makes the bootloader fall back to ota_0, which is exactly what we just wrote.
  say "   erase otadata ($OTADATA_OFFSET +$OTADATA_SIZE)"
  esp --chip "$CHIP" --port "$PORT" --before default_reset --after no_reset \
      erase_region "$OTADATA_OFFSET" "$OTADATA_SIZE" >/dev/null
  if [ "$ERASE_NVS" -eq 1 ]; then
    warn "   erase NVS ($NVS_OFFSET +$NVS_SIZE) — pairing and saved WiFi will be gone"
    esp --chip "$CHIP" --port "$PORT" --before default_reset --after no_reset \
        erase_region "$NVS_OFFSET" "$NVS_SIZE" >/dev/null
  fi
  say "   write app ($APP_OFFSET)"
  esp --chip "$CHIP" --port "$PORT" -b 460800 --before default_reset --after hard_reset \
      write_flash --flash_mode "$FLASH_MODE" --flash_size "$FLASH_SIZE" --flash_freq "$FLASH_FREQ" \
      "$APP_OFFSET" "$FW_FILE"
  say ">> flashed."
}

# Reopen the port and read the boot banner. ESP-IDF prints `App version: X.Y.Z` from the app
# descriptor before any network exists, so this confirms what is RUNNING, not what we think we sent.
verify_running() {
  [ "$NO_VERIFY" -eq 1 ] && return 0
  command -v stty >/dev/null 2>&1 || return 0
  local log seen; log="$(mktemp)"
  say ">> confirming the running version…"
  case "$(uname -s)" in
    Darwin) stty -f "$PORT" 115200 raw -echo 2>/dev/null || true ;;
    Linux)  stty -F "$PORT" 115200 raw -echo 2>/dev/null || true ;;
  esac
  cat "$PORT" > "$log" 2>/dev/null &
  local pid=$!
  sleep 15
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  # The serial boot stream can contain invalid UTF-8 bytes before the ESP-IDF banner. BSD sed uses
  # the current UTF-8 locale by default and aborts on those bytes, even though the version line is
  # plain ASCII. Parse this one binary log in the C byte locale instead.
  seen="$(LC_ALL=C sed -n 's/.*App version: *//p' "$log" | head -1 | tr -d '\r')"
  rm -f "$log"
  if [ -z "$seen" ]; then
    warn "   could not read a version from the boot log (not fatal — power-cycle and check the screen)"
  elif [ "$seen" = "$FW_VER" ]; then
    say "   running $seen ✓"
  else
    warn "   running $seen but $FW_VER was flashed — the board did not boot what we wrote"
    warn "   (if this repeats, the app may be rolling back; report it with this output)"
  fi
}

# --- run ------------------------------------------------------------------------------------------
# esptool is only needed to TALK to a board; --no-flash is a pure download + verify and must work on
# a machine that has none.
if [ "$NO_FLASH" -eq 0 ]; then
  # Armed BEFORE anything can spawn esptool, and unconditionally.
  #
  # The daemon-restart trap below is armed inside stop_harness_for_flash, which --detect-only skips
  # entirely — so a cancelled detection had no trap at all, and its esptool was reparented to init
  # still holding the port. Three of those were seen stacked on one port at once, each making the
  # next attempt slower. stop_harness_for_flash replaces this with a trap that does both.
  trap kill_child EXIT INT TERM
  [ "$DETECT_ONLY" -eq 1 ] || stop_harness_for_flash
  ensure_esptool
  pick_port
fi
if [ "$DETECT_ONLY" -eq 1 ]; then say ">> detect-only: nothing was written."; exit 0; fi

resolve_release
fetch_firmware
if [ "$NO_FLASH" -eq 1 ]; then say ">> --no-flash: stopping. Image at $FW_FILE"; exit 0; fi

confirm
do_flash
verify_running
say ""
say "Done. $OTA_KEY $FW_VER is on $PORT."
[ "$ERASE_NVS" -eq 1 ] && say "NVS was erased — the device will ask to be set up again."
exit 0
