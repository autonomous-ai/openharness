# Entitlements on the iOS release build. Sourced by release-ios.sh; tested by
# test-ios-entitlements.sh (`bash mobile/scripts/test-ios-entitlements.sh`).
#
# The release archive is UNSIGNED (release-ios.sh says why), so its app carries no entitlements, and
# export signs it with only what the binary asks for. Without HotspotConfiguration, joining a new
# device's setup network fails on the phone. An ad-hoc signature, which needs no certificate, puts
# the requested entitlements on the app so export carries them over.

# The top-level keys of what `plutil -p` printed: theirs are the lines indented by two spaces.
plist_keys() {
  sed -n 's/^  "\([^"]*\)" => .*/\1/p'
}

# carry_entitlements <.app> <entitlements plist>
carry_entitlements() {
  codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$2" "$1"
}

# check_entitlements <.app> <what it is> <entitlements plist>
# Fails, naming them, when the app's signature lacks a key the plist asks for.
check_entitlements() {
  local have key missing=""
  if [[ ! -f "$3" ]]; then
    echo "!! no entitlements file at $3" >&2
    return 1
  fi
  have="$(codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -p - 2>/dev/null || true)"
  for key in $(plutil -p "$3" | plist_keys); do
    printf '%s\n' "$have" | grep -q "^  \"$key\" => " || missing="$missing $key"
  done
  if [[ -n "$missing" ]]; then
    echo "!! $2 is signed without:$missing (asked for in $(basename "$3"))" >&2
    return 1
  fi
  echo "    $2 carries $(printf '%s\n' "$have" | plist_keys | tr '\n' ' ')"
}
