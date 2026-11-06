# Entitlements on the iOS release build. Sourced by release-ios.sh; tested by
# test-ios-entitlements.sh (`bash mobile/scripts/test-ios-entitlements.sh`).
#
# The release archive is UNSIGNED (release-ios.sh says why), so its app carries no entitlements, and
# the export then signs it with only what the binary asks for. TestFlight 1.0.12 (80) to (82) went up
# like that: without the setup hotspot (`com.apple.developer.networking.HotspotConfiguration`) and
# without push (`aps-environment`), both of which fail on the phone without saying why. An ad-hoc
# signature, which needs no certificate, puts the entitlements on the app, and the export carries
# them over (aps-environment becomes production there).

# The top-level keys of what `plutil -p` printed: theirs are the lines indented by two spaces.
plist_keys() {
  sed -n 's/^  "\([^"]*\)" => .*/\1/p'
}

# carry_entitlements <.app> <entitlements plist>
carry_entitlements() {
  codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$2" "$1"
}

# check_entitlements <.app> <what it is> <any|production> <entitlements plist>
#
# Fails, naming them, when the app's signature lacks a key the plist asks for. With `production`, it
# also fails when the app's aps-environment is not production: its pushes would go to the APNs
# sandbox, which a TestFlight or App Store install never hears from.
check_entitlements() {
  local have key missing=""
  if [[ ! -f "$4" ]]; then
    echo "!! no entitlements file at $4" >&2
    return 1
  fi
  have="$(codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -p - 2>/dev/null || true)"
  for key in $(plutil -p "$4" | plist_keys); do
    printf '%s\n' "$have" | grep -q "^  \"$key\" => " || missing="$missing $key"
  done
  if [[ -n "$missing" ]]; then
    echo "!! $2 is signed without:$missing (asked for in $(basename "$4"))" >&2
    return 1
  fi
  if [[ "$3" == production ]] && printf '%s\n' "$have" | grep -q '^  "aps-environment" => ' &&
    ! printf '%s\n' "$have" | grep -q '^  "aps-environment" => "production"$'; then
    echo "!! $2 has a development aps-environment: its pushes would go to the APNs sandbox" >&2
    return 1
  fi
  echo "    $2 carries $(printf '%s\n' "$have" | plist_keys | tr '\n' ' ')"
}
