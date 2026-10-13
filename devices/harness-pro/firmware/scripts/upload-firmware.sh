#!/usr/bin/env bash
# Publish the Harness Pro firmware OTA. MAINTAINER ONLY (needs gcloud auth + ESP-IDF 5.5.4).
#
#   scripts/upload-firmware.sh --check-only BIN   image checks only; exit 0 ok / 1 refused
#   scripts/upload-firmware.sh --dry-run          next version + build + checks; PRINT the gcloud commands
#   scripts/upload-firmware.sh                    the same, then upload for real
#
# Writes only data["harness-pro"] of the shared manifest; the round dial's key is never touched.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
BASE_URL="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${BUCKET}}"
METADATA_PATH="harness/esp32/ota/metadata.json"
OTA_KEY="harness-pro"
IDF_DIR="${IDF_DIR:-$HOME/esp/esp-idf-5.5.4}"
BUILD_DIR="build-release"
ESPTOOL="$HOME/.harness/flasher/esptool-v5.3.1-macos-amd64/esptool-macos-amd64/esptool"

DRY=0; CHECK_ONLY=""; MERGE_TEST=""; VERIFY_TEST=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift ;;
        --check-only) CHECK_ONLY="${2:?--check-only needs a BIN}"; shift 2 ;;
        --merge-test) MERGE_TEST="${2:?--merge-test needs SRC.json}"; shift 2 ;;   # hidden, offline tests
        --verify-test) VERIFY_TEST="${2:?need SRC.json DST.json}"; VERIFY_DST="${3:?need DST.json}"; shift 3 ;;
        *) echo "usage: $0 [--dry-run] [--check-only BIN]" >&2; exit 64 ;;
    esac
done

# MERGE_PY: SRC -> DST with only data[key] set. CHECK_PY: every other key of SRC must be unchanged in DST.
MERGE_PY='import json,sys
src,dst,key,version,url,sha,size=sys.argv[1:8]
try: data=json.load(open(src))
except (OSError,ValueError) as e: sys.exit("abort: manifest is not valid JSON: %s" % e)
if not isinstance(data,dict): sys.exit("abort: manifest is not a JSON object")
data[key]={"version":version,"url":url,"sha256":sha,"size":int(size)}
json.dump(data,open(dst,"w"),indent=2); open(dst,"a").write("\n")'
CHECK_PY='import json,sys
src,dst,key=sys.argv[1:4]
a,b=json.load(open(src)),json.load(open(dst))
if not isinstance(b,dict) or any(k != key and (k not in b or b[k] != v) for k,v in a.items()):
    sys.exit("abort: merge changed or dropped a key other than %s" % key)'
NOCACHE='--cache-control=no-cache, no-store, must-revalidate'
PANEL_TURN=${PANEL_TURN:-180}   # every Pro panel is mounted upside down (owner, 2026-10-11)

# gcs_generation gs://obj -> prints the generation, or 0 when the object does not exist; any other failure aborts.
gcs_generation() {
    local out
    if out="$(gcloud storage objects describe "$1" --format='value(generation)' 2>&1)"; then printf '%s' "$out"
    elif printf '%s' "$out" | grep -qiE 'not found|404|No URLs matched'; then echo 0
    else echo "abort: cannot describe $1: $out" >&2; return 1; fi
}

if [ -n "$MERGE_TEST" ]; then
    D="$(mktemp)"; python3 -I -c "$MERGE_PY" "$MERGE_TEST" "$D" "$OTA_KEY" 9.9.9 u s 1 || exit 1
    python3 -I -c "$CHECK_PY" "$MERGE_TEST" "$D" "$OTA_KEY" || exit 1
    cat "$D"; rm -f "$D"; exit 0
fi
if [ -n "$VERIFY_TEST" ]; then python3 -I -c "$CHECK_PY" "$VERIFY_TEST" "$VERIFY_DST" "$OTA_KEY"; exit $?; fi

# check_image BIN -> prints every reason it is refused; returns 1 if any.
check_image() {
    local bin="$1" info bad=0
    [ -f "$bin" ] || { echo "refused: $bin not found" >&2; return 1; }
    if [ -x "$ESPTOOL" ]; then info="$("$ESPTOOL" image-info "$bin" 2>&1)"
    else info="$(python3 -m esptool image-info "$bin" 2>&1)" || { echo "refused: no esptool (flasher or python -m esptool)" >&2; return 1; }
    fi
    printf '%s' "$info" | grep -q 'Chip ID: 18 (ESP32-P4)' || { echo "refused: chip is not esp32p4" >&2; bad=1; }
    printf '%s' "$info" | grep -q 'Minimal chip revision: v3\.0,' || { echo "refused: minimum chip revision is not v3.0" >&2; bad=1; }
    # esptool 5.3.1 does not print the app description, so read esp_app_desc_t directly:
    # version at 0x30, project_name at 0x50 (24-byte header + 8-byte segment header + 16 bytes), magic 0xABCD5432 at 0x20.
    local desc magic ver proj
    desc="$(python3 -I - "$bin" <<'PY'
import sys
d = open(sys.argv[1], "rb").read()[0x20:0x70]
f = lambda b: b.split(b"\0")[0].decode("ascii", "replace")
print(d[:4].hex(), f(d[0x10:0x30]) or "-", f(d[0x30:0x50]) or "-")
PY
)"
    read -r magic ver proj <<<"$desc"
    [ "$magic" = "3254cdab" ] || { echo "refused: no app description (bad magic $magic)" >&2; return 1; }
    [ "$proj" = "harness_pro" ] || { echo "refused: project name is '$proj', want harness_pro" >&2; bad=1; }
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "refused: version '$ver' is not plain X.Y.Z" >&2; bad=1; }
    [ "$bad" -eq 0 ] && echo "ok: $bin is harness_pro $ver, esp32p4 >= v3.0"
    return "$bad"
}

if [ -n "$CHECK_ONLY" ]; then check_image "$CHECK_ONLY" && exit 0 || exit 1; fi

# --- next version from the live manifest: patch+1, 0.1.0 when this key is absent ---
MANIFEST="$(curl -fsS -H 'Cache-Control: no-cache' "$BASE_URL/$METADATA_PATH")" \
    || { echo "error: cannot read $BASE_URL/$METADATA_PATH" >&2; exit 1; }
VER="$(printf '%s' "$MANIFEST" | python3 -I -c '
import json, re, sys
d = json.load(sys.stdin)
if not isinstance(d, dict): sys.exit("manifest is not a JSON object")
cur = (d.get("harness-pro") or {}).get("version")
if cur is None: print("0.1.0")
else:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", cur)
    if not m: sys.exit("manifest harness-pro version %r is not X.Y.Z" % cur)
    print("%s.%s.%d" % (m[1], m[2], int(m[3]) + 1))
')"
PREV="$(printf '%s' "$MANIFEST" | python3 -I -c 'import json,sys;print(((json.load(sys.stdin).get("harness-pro")) or {}).get("version",""))')"
echo ">> next version: $VER (public manifest has: ${PREV:-none})"

# --- build (fresh config each time: sdkconfig is gitignored and can be stale) ---
cd "$HERE"
# shellcheck disable=SC1091
[ -f "$IDF_DIR/export.sh" ] && . "$IDF_DIR/export.sh" >/dev/null
rm -rf "$BUILD_DIR"
# throwaway sdkconfig: only sdkconfig.defaults applies, never the local project-root sdkconfig
idf.py -B "$BUILD_DIR" -DSDKCONFIG="$BUILD_DIR/sdkconfig.release" -DPROJECT_VER="$VER" -DPOD_PANEL_TURN="$PANEL_TURN" build
BIN="$HERE/$BUILD_DIR/harness_pro.bin"
check_image "$BIN" || exit 1

SHA="$(shasum -a 256 "$BIN" | awk '{print $1}')"
SIZE="$(wc -c < "$BIN" | tr -d ' ')"
GCS_PATH="harness/esp32-pro/bin/${VER}.bin"
URL="${BASE_URL%/}/$GCS_PATH"


BIN_GS="gs://$BUCKET/$GCS_PATH"; META_GS="gs://$BUCKET/$METADATA_PATH"

if [ "$DRY" -eq 1 ]; then
    echo ">> DRY RUN: nothing is uploaded. Would run:"
    echo "gcloud storage objects describe $BIN_GS   # must be not-found, else abort"
    echo "gcloud storage cp --no-clobber '$NOCACHE' '$BIN' $BIN_GS"
    echo "GEN=\$(gcloud storage objects describe $META_GS --format='value(generation)')   # 0 only if not found; other errors abort"
    echo "gcloud storage cp $META_GS#\$GEN SRC.json   # {} only when GEN=0; aborts unless harness-pro version == '${PREV:-none}'"
    echo "python3 -I -c '<set data[\"$OTA_KEY\"]={version:$VER,url:$URL,sha256:$SHA,size:$SIZE}; abort if not an object>' SRC.json DST.json"
    echo "python3 -I -c '<abort if any other key of SRC.json is missing or changed in DST.json>' SRC.json DST.json"
    echo "gcloud storage cp --if-generation-match=\$GEN --content-type=application/json '$NOCACHE' DST.json $META_GS"
    exit 0
fi

echo ">> uploading $VER ($SIZE bytes, sha256=$SHA)"
[ "$(gcs_generation "$BIN_GS")" = 0 ] || { echo "abort: $BIN_GS already published" >&2; exit 1; }
SRC="$(mktemp)"; DST="$(mktemp)"; trap 'rm -f "$SRC" "$DST"' EXIT
GEN="$(gcs_generation "$META_GS")" || exit 1
if [ "$GEN" = 0 ]; then printf '{}' > "$SRC"
else gcloud storage cp "$META_GS#$GEN" "$SRC" || { echo "abort: cannot fetch $META_GS#$GEN" >&2; exit 1; }
fi
GOT="$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print((d.get("harness-pro") or {}).get("version","") if isinstance(d,dict) else "BAD")' "$SRC")" \
    || { echo "abort: fetched manifest is not valid JSON" >&2; exit 1; }
[ "$GOT" = "$PREV" ] || { echo "abort: harness-pro is '$GOT' in the bucket but '$PREV' publicly; someone published meanwhile" >&2; exit 1; }
python3 -I -c "$MERGE_PY" "$SRC" "$DST" "$OTA_KEY" "$VER" "$URL" "$SHA" "$SIZE" || exit 1
python3 -I -c "$CHECK_PY" "$SRC" "$DST" "$OTA_KEY" || exit 1
gcloud storage cp --no-clobber "$NOCACHE" "$BIN" "$BIN_GS"
gcloud storage cp --if-generation-match="$GEN" --content-type=application/json "$NOCACHE" "$DST" "$META_GS" \
    || { echo "abort: manifest changed since it was read (generation $GEN); someone else published. Re-run." >&2; exit 1; }
echo ">> published harness-pro $VER: $URL"
