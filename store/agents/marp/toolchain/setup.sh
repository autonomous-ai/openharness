#!/usr/bin/env bash
# Harness DSH setup — install the pinned Marp toolchain into ./toolchain/node_modules. cwd = the
# install dir. Idempotent: a second run with the same lockfile is a no-op.
#
# PDF and PPTX export render through a Chromium-family browser. A machine with none (a new Mac has only
# Safari) gets Chrome for Testing's headless shell in toolchain/browser/, pinned and checksummed; the
# `marp` wrapper points marp-cli at it. Without it the deck still shows live and exports to HTML, so a
# failed fetch is a warning, not a failed install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/toolchain"
# shellcheck source=runtimes.sh
. ./runtimes.sh
# shellcheck source=browser.sh
. ./browser.sh
# This machine's node when it has one, else the Node Harness itself runs on (npm is beside it).
harness_node 18 || exit 1
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
else
  npm install --no-audit --no-fund --no-update-notifier --loglevel=error
fi
echo "ok   marp toolchain $(node -p "require('@marp-team/marp-core/package.json').version")"

# fetch_headless_shell — toolchain/browser/chrome-headless-shell-<platform>/, or a warn line and no change.
fetch_headless_shell() {
  local platform sum url
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=mac-arm64 sum=f3747ddcb6caba3972ea064878f338ea5a9a2505c7595e68506d394d44baacc8 ;;
    Darwin-x86_64) platform=mac-x64 sum=1f547b3f4e3cad27366871be2bc22f93e433535ed924638d8a72367bccab6560 ;;
    Linux-x86_64) platform=linux64 sum=e122f8722a0cbd15c954fb02220db761eb2fda0a466618b03e3e31406f2b0167 ;;
    *) echo "warn no Chrome/Chromium/Edge, and Chrome has no headless build for $(uname -s) $(uname -m) — HTML export only"; return 0 ;;
  esac
  url="https://storage.googleapis.com/chrome-for-testing-public/$MARP_HEADLESS_SHELL_VERSION/$platform/chrome-headless-shell-$platform.zip"
  echo "     no Chrome/Chromium/Edge here: fetching Chrome's headless shell $MARP_HEADLESS_SHELL_VERSION for PDF and PPTX (~100 MB)"
  rm -rf browser.partial
  mkdir browser.partial
  if ! curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 -o browser.partial/shell.zip "$url"; then
    rm -rf browser.partial; echo "warn could not download $url — HTML export only until toolchain/setup.sh runs again"; return 0
  fi
  if [ "$(shasum -a 256 browser.partial/shell.zip 2>/dev/null || sha256sum browser.partial/shell.zip)" != "$sum  browser.partial/shell.zip" ]; then
    rm -rf browser.partial; echo "warn $url did not match its pinned checksum — HTML export only"; return 0
  fi
  # extract-zip (marp-cli's own dependency, pinned by the lockfile) keeps the executable bit, and not
  # every Linux has unzip. It wants an absolute destination.
  if ! node_modules/.bin/extract-zip browser.partial/shell.zip "$PWD/browser.partial"; then
    rm -rf browser.partial; echo "warn the headless shell would not unpack — HTML export only until toolchain/setup.sh runs again"; return 0
  fi
  rm -f browser.partial/shell.zip
  echo "$MARP_HEADLESS_SHELL_VERSION" > browser.partial/.version
  rm -rf browser
  mv browser.partial browser
  echo "ok   browser for PDF/PPTX export: chrome-headless-shell $MARP_HEADLESS_SHELL_VERSION"
}

if browser="$(marp_browser)"; then
  echo "ok   browser for PDF/PPTX export: $(basename "$browser")"
else
  fetch_headless_shell
fi
