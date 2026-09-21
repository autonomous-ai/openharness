#!/usr/bin/env bash
# KiCad itself, vendored into this package — the one thing a KiCad harness cannot run without.
#
# The store's rule is "pin versions and vendor them there, never into the user's machine", and
# KiCad is not on PyPI or conda-forge, so on macOS this fetches the official unified DMG at the
# version and checksum VERSIONS pins (the same artifact Homebrew's cask installs), mounts it, and
# copies `KiCad.app` into `<install>/kicad/` — without the 3D models (3.1 GB, nothing in the
# pipeline reads them) and the offline help (376 MB). What stays is what a board needs: kicad-cli,
# KiCad's own Python with `pcbnew`, the symbol and footprint libraries, the templates — about
# 1.3 GB on disk after a 1.4 GB download. A KiCad already at that version under `<install>/kicad`
# is kept. The machine's own /Applications/KiCad is never touched or required.
#
# Linux has no relocatable KiCad artifact to pin (distributions and flatpak install system-wide),
# so there this reports a miss and names the package; the doctor then says the same.
#
# Sourced by setup.sh and doctor.sh; cwd = the install dir; needs runtimes.sh loaded (for
# `_harness_fetch`) and VERSIONS (for KICAD_*).
set -u

KICAD_APP="$PWD/kicad/KiCad.app"
KICAD_CLI="$KICAD_APP/Contents/MacOS/kicad-cli"
KICAD_PYTHON="$KICAD_APP/Contents/Frameworks/Python.framework/Versions/Current/bin/python3"
KICAD_SHARE="$KICAD_APP/Contents/SharedSupport"

# The version string kicad-cli prints, e.g. "10.0.6", or nothing.
harness_kicad_version() {
  [ -x "$KICAD_CLI" ] || return 1
  "$KICAD_CLI" version 2>/dev/null | head -1 | tr -d '[:space:]'
}

# harness_kicad — make <install>/kicad/KiCad.app exist at the pinned version. Prints ok/miss lines.
harness_kicad() {
  local have url dmg mount
  have="$(harness_kicad_version || true)"
  if [ "$have" = "$KICAD_VERSION" ] && "$KICAD_PYTHON" -c 'import pcbnew' >/dev/null 2>&1; then
    echo "ok   KiCad $have vendored (kicad-cli + pcbnew)"
    return 0
  fi
  case "$(uname -s)" in
    Darwin) ;;
    *) echo "miss KiCad $KICAD_VERSION is not vendored on $(uname -s): install it system-wide (apt/dnf/flatpak org.kicad.KiCad) and set KICADPY_CLI / KICADPY_PYTHON"; return 1 ;;
  esac
  url="$KICAD_DMG_URL"
  dmg="${HARNESS_RUNTIME:-$HOME/.harness/runtime}/downloads/$(basename "$url")"
  mkdir -p "$(dirname "$dmg")" || { echo "miss cannot write $(dirname "$dmg")"; return 1; }
  if [ ! -f "$dmg" ]; then
    echo "     fetching KiCad $KICAD_VERSION ($(( KICAD_DMG_BYTES / 1000000 )) MB) — the official macOS build, checksum pinned"
    _harness_fetch "$url" "$dmg" "$KICAD_DMG_SHA256" || return 1
  fi
  mount="$(mktemp -d "${TMPDIR:-/tmp}/harness-kicad.XXXXXX")"
  if ! hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount" "$dmg"; then
    echo "miss could not mount $dmg"; rmdir "$mount" 2>/dev/null; return 1
  fi
  rm -rf "$PWD/kicad.partial"
  mkdir -p "$PWD/kicad.partial"
  echo "     copying KiCad.app without 3dmodels and help (about 1.3 GB)"
  if rsync -a --exclude 'Contents/SharedSupport/3dmodels' --exclude 'Contents/SharedSupport/help' \
       "$mount/KiCad/KiCad.app" "$PWD/kicad.partial/"; then
    hdiutil detach -quiet "$mount"; rmdir "$mount" 2>/dev/null
    rm -rf "$PWD/kicad"
    mv "$PWD/kicad.partial" "$PWD/kicad"
  else
    hdiutil detach -quiet "$mount"; rmdir "$mount" 2>/dev/null
    rm -rf "$PWD/kicad.partial"
    echo "miss copying KiCad.app failed"; return 1
  fi
  rm -f "$dmg"   # 1.4 GB the cache does not need once the app is in place
  have="$(harness_kicad_version || true)"
  if [ "$have" != "$KICAD_VERSION" ]; then echo "miss vendored kicad-cli reports '$have', expected $KICAD_VERSION"; return 1; fi
  "$KICAD_PYTHON" -c 'import pcbnew' >/dev/null 2>&1 || { echo "miss vendored KiCad Python cannot import pcbnew"; return 1; }
  echo "ok   KiCad $have vendored (kicad-cli + pcbnew)"
}
