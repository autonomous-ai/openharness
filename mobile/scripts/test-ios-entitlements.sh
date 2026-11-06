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

make_entitlements() {   # $1 = name, $2 = aps-environment value ("" leaves it out), $3 = hotspot yes|no
  local file="$WORK/$1.entitlements"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    [[ -n "$2" ]] && echo "<key>aps-environment</key><string>$2</string>"
    [[ "$3" == yes ]] && echo '<key>com.apple.developer.networking.HotspotConfiguration</key><true/>'
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

ASKED="$(make_entitlements asked development yes)"   # what Runner.entitlements asks for
STORE="$(make_entitlements store production yes)"    # what the export turns it into

unsigned="$(make_app unsigned)"
expect fails "an unsigned app lacks every entitlement asked for" \
  "signed without: aps-environment com.apple.developer.networking.HotspotConfiguration" \
  check_entitlements "$unsigned" "the app" any "$ASKED"

carried="$(make_app carried)"
carry_entitlements "$carried" "$ASKED" 2> /dev/null
expect passes "an app signed ad hoc with them carries them" "" \
  check_entitlements "$carried" "the app" any "$ASKED"
expect fails "a store build with a development aps-environment is refused" \
  "development aps-environment" \
  check_entitlements "$carried" "the app" production "$ASKED"

store="$(make_app store)"
carry_entitlements "$store" "$STORE" 2> /dev/null
expect passes "a store build with a production aps-environment passes" "" \
  check_entitlements "$store" "the app" production "$ASKED"

no_push="$(make_app no_push)"
carry_entitlements "$no_push" "$(make_entitlements hotspot_only "" yes)" 2> /dev/null
expect fails "an app without push names only that one" "signed without: aps-environment (" \
  check_entitlements "$no_push" "the app" any "$ASKED"

no_aps_asked="$(make_entitlements hotspot_asked "" yes)"
expect passes "an app that asks for no push is not held to production" "" \
  check_entitlements "$no_push" "the app" production "$no_aps_asked"

expect fails "a missing entitlements file is an error, not a pass" "no entitlements file" \
  check_entitlements "$carried" "the app" any "$WORK/nowhere.entitlements"

if [[ "$FAILED" == 0 ]]; then
  echo "all passed"
else
  exit 1
fi
