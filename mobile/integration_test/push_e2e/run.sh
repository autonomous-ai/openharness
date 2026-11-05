#!/usr/bin/env bash
# The phone push end to end on an iOS simulator (task #3248): a reply push reaches the app while it
# is closed, iOS draws it, its tap starts the app on the thread its link names, and the same push
# with the app in front is not drawn. Screenshots and logs land in OUT (default: a new mktemp -d).
#
#   mobile/integration_test/push_e2e/run.sh <simulator udid> [out dir]
#
# Simulators only: the udid must be one `xcrun simctl` lists. The app is uninstalled first, so its
# first launch asks for notices again. Nothing reaches an account or the backend
# (`push_e2e_app.dart`). Needs Xcode and the xcodeproj gem (CocoaPods bundles it; set
# XCODEPROJ_RUBY to a ruby that can `require "xcodeproj"` when the default one cannot).
set -euo pipefail

udid=${1:?usage: run.sh <simulator udid> [out dir]}
here=$(cd "$(dirname "$0")" && pwd)
mobile=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
out=${2:-$work/out}
mkdir -p "$out"
bundle=ai.autonomous.harness.ios

xcrun simctl list devices | grep -q "($udid)" || { echo "no simulator $udid" >&2; exit 2; }

ruby=${XCODEPROJ_RUBY:-}
if [[ -z $ruby ]]; then
  if ruby -e 'require "xcodeproj"' 2>/dev/null; then
    ruby=ruby
  else
    # CocoaPods' own gems, and the gems they need from Homebrew's ruby (rexml).
    pods=$(brew --prefix cocoapods 2>/dev/null)/libexec
    brewruby=$(brew --prefix ruby 2>/dev/null)/bin/ruby
    ruby="env GEM_HOME=$pods GEM_PATH=$pods:$($brewruby -e 'print Gem.default_dir') $brewruby"
  fi
fi

echo "build: the e2e app"
(cd "$mobile" && flutter build ios --simulator --debug --target=integration_test/push_e2e_app.dart)

echo "simulator: $udid"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl uninstall "$udid" "$bundle" 2>/dev/null || true
xcrun simctl install "$udid" "$mobile/build/ios/iphonesimulator/Runner.app"

echo "build: the runner"
$ruby "$here/gen.rb" "$work/runner" "$here/PushE2E.swift"
xcodebuild build-for-testing -project "$work/runner/PushE2E.xcodeproj" -scheme PushE2E \
  -destination "id=$udid" -derivedDataPath "$work/derived" CODE_SIGNING_ALLOWED=NO -quiet

# What the tapped push opened, as the app says it (`push-e2e:` lines).
xcrun simctl spawn "$udid" log stream --style compact --predicate 'eventMessage CONTAINS "push-e2e"' \
  > "$out/app.log" 2>&1 &
logger=$!
trap 'kill $logger 2>/dev/null || true' EXIT

echo "run: logs and screenshots in $out"
TEST_RUNNER_OUT="$out" xcodebuild test-without-building -project "$work/runner/PushE2E.xcodeproj" \
  -scheme PushE2E -destination "id=$udid" -derivedDataPath "$work/derived" \
  -only-testing:PushE2E/PushE2E/testDrive > "$out/xcodebuild.log" 2>&1 &
runner=$!

# Each push the runner asks for: the server's body for River's reply.
for push in push-1 push-2; do
  until [[ -e "$out/want-$push" ]]; do
    kill -0 $runner 2>/dev/null || break 2
    sleep 0.2
  done
  xcrun simctl push "$udid" "$bundle" "$here/reply_push.apns"
  touch "$out/sent-$push"
done

status=0
wait $runner || status=$?
sleep 1
grep -E "Test (Case|Suite).*(passed|failed)|error:" "$out/xcodebuild.log" | tail -5 || true
echo "runner:"; cat "$out/runner.log" 2>/dev/null || true
echo "app:"; grep "push-e2e:" "$out/app.log" || true
exit $status
