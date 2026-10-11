#!/usr/bin/env bash
# upload-firmware.sh --check-only must refuse images that must never reach the OTA bucket.
set -u
cd "$(dirname "$0")/.." || exit 1
S=scripts/upload-firmware.sh
BIN=build/harness_pro.bin
fail=0
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

expect_refused() { # name bin needle
    out="$(bash "$S" --check-only "$2" 2>&1)"; rc=$?
    if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "$3"; then echo "ok   $1"
    else echo "FAIL $1 (rc=$rc): $out"; fail=1; fi
}

expect_refused "dev version 0.0.99-pod refused" "$BIN" "not plain X.Y.Z"

# Patched project name (app description is at 0x50, 32 bytes) -> refused for project.
cp "$BIN" "$T/other.bin"
printf 'other_app\0' | dd of="$T/other.bin" bs=1 seek=$((0x50)) conv=notrunc 2>/dev/null
expect_refused "wrong project refused" "$T/other.bin" "project"

# --- manifest merge (offline): --merge-test SRC merges + verifies; --verify-test SRC DST only verifies ---
echo '{"commander":{"version":"1.0.0"},"flasher":{"version":"2.0.0"},"harness-pro":{"version":"0.1.0"}}' > "$T/ok.json"
out="$(bash "$S" --merge-test "$T/ok.json" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && python3 -I -c 'import json,sys;d=json.loads(sys.argv[1]);assert d["commander"]=={"version":"1.0.0"} and d["flasher"]=={"version":"2.0.0"} and d["harness-pro"]["version"]=="9.9.9",d' "$out"
then echo "ok   merge keeps commander+flasher, sets harness-pro"; else echo "FAIL merge keeps keys (rc=$rc): $out"; fail=1; fi

echo '[1,2]' > "$T/arr.json"
out="$(bash "$S" --merge-test "$T/arr.json" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "not a JSON object"; then echo "ok   non-object manifest aborts"; else echo "FAIL non-object (rc=$rc): $out"; fail=1; fi

echo 'not json' > "$T/bad.json"
out="$(bash "$S" --merge-test "$T/bad.json" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   unparseable manifest aborts"; else echo "FAIL unparseable (rc=$rc): $out"; fail=1; fi

echo '{"commander":{"version":"1.0.1"},"harness-pro":{"version":"9.9.9"}}' > "$T/dropped.json"
out="$(bash "$S" --verify-test "$T/ok.json" "$T/dropped.json" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "changed or dropped"; then echo "ok   merge that drops/changes a key aborts"; else echo "FAIL drop (rc=$rc): $out"; fail=1; fi

exit $fail
