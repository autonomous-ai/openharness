# shellcheck shell=bash
# browser.sh — sourced by setup.sh, doctor.sh and marp: the Chromium-family browser marp-cli renders PDF
# and PPTX through. `marp_browser` prints this machine's (an app in /Applications, or a Chromium or
# Chrome on PATH under a Linux package's name), else the headless shell setup.sh fetched into
# toolchain/browser/, and fails when there is neither. MARP_APPLICATIONS_DIR stands in for
# /Applications in the tests.
#
# The headless shell is Chrome for Testing's, at the version marp-cli's puppeteer-core is pinned to; one
# fetched for another version does not count, so a bump here fetches again.
MARP_HEADLESS_SHELL_VERSION=148.0.7778.97

marp_browser() {
  local apps="${MARP_APPLICATIONS_DIR:-/Applications}" app shell here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for app in "Google Chrome" Chromium "Microsoft Edge" "Brave Browser"; do
    if [ -d "$apps/$app.app" ]; then echo "$apps/$app.app"; return 0; fi
  done
  for app in chromium chromium-browser google-chrome google-chrome-stable; do
    command -v "$app" 2>/dev/null && return 0
  done
  [ "$(cat "$here/browser/.version" 2>/dev/null)" = "$MARP_HEADLESS_SHELL_VERSION" ] || return 1
  for shell in "$here"/browser/chrome-headless-shell-*/chrome-headless-shell; do
    if [ -x "$shell" ]; then echo "$shell"; return 0; fi
  done
  return 1
}
