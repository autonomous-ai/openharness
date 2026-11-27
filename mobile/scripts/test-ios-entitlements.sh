#!/usr/bin/env bash
# Tests for ios-entitlements.sh: `bash mobile/scripts/test-ios-entitlements.sh` (macOS: codesign).
#
# Each case signs a tiny .app ad hoc, as release-ios.sh signs the archived Runner.app, and checks
# what check_entitlements makes of it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ios-entitlements.sh
source "$HERE/ios-entitlements.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0

# A bundle codesign accepts: an Info.plist and a Mach-O main executable.
make_app() {   # $1 = name; prints the .app path
  local app="$WORK/$1.app"
  mkdir -p "$app"
  cp /usr/bin/true "$app/Runner"
  cat > "$app/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Runner</string>
  <key>CFBundleIdentifier</key><string>test.entitlements.$1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict>
</plist>
EOF
  echo "$app"
}

make_entitlements() {   # $1 = name, $2 = hotspot yes|no
  local file="$WORK/$1.entitlements"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    [[ "$2" == yes ]] && echo '<key>com.apple.developer.networking.HotspotConfiguration</key><true/>'
    echo '</dict></plist>'
  } > "$file"
  echo "$file"
}

# expect <passes|fails> <name> <stderr must contain, or ""> <command...>
expect() {
  local want="$1" name="$2" needle="$3" got err
  shift 3
  if "$@" > "$WORK/out" 2> "$WORK/err"; then got=passes; else got=fails; fi
  err="$(cat "$WORK/err")"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $name: wanted it to $want, it $got. stderr: $err"
    FAILED=1
  elif [[ -n "$needle" && "$err" != *"$needle"* ]]; then
    echo "FAIL $name: stderr does not say '$needle': $err"
    FAILED=1
  else
    echo "ok   $name"
  fi
}

# Local notices and device setup need no remote-notification entitlement.
expect fails "Runner no longer requests remote notifications" "" \
  /usr/libexec/PlistBuddy -c 'Print :aps-environment' "$HERE/../ios/Runner/Runner.entitlements"

ASKED="$HERE/../ios/Runner/Runner.entitlements"

unsigned="$(make_app unsigned)"
expect fails "an unsigned app lacks the setup entitlement" \
  "signed without: com.apple.developer.networking.HotspotConfiguration" \
  check_entitlements "$unsigned" "the app" "$ASKED"

carried="$(make_app carried)"
carry_entitlements "$carried" "$ASKED" 2> /dev/null
expect passes "an app signed ad hoc with Runner's entitlements carries them" "" \
  check_entitlements "$carried" "the app" "$ASKED"

no_hotspot="$(make_app no_hotspot)"
carry_entitlements "$no_hotspot" "$(make_entitlements empty no)" 2> /dev/null
expect fails "a signed app without device setup names the missing entitlement" \
  "signed without: com.apple.developer.networking.HotspotConfiguration" \
  check_entitlements "$no_hotspot" "the app" "$ASKED"

expect fails "a missing entitlements file is an error, not a pass" "no entitlements file" \
  check_entitlements "$carried" "the app" "$WORK/nowhere.entitlements"

if [[ "$FAILED" == 0 ]]; then
  echo "all passed"
else
  exit 1
fi
