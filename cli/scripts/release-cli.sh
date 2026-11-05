#!/usr/bin/env bash
# Cut a CLI release: work out the next version, tag it, push the tag. CI does everything else —
# .github/workflows/release.yml bundles the CLI, publishes it to GCS, and creates the GitHub Release.
# The tag IS the version; CI never bumps on its own. Tags are "vX.Y.Z_cli" — the "_cli" suffix is
# stripped by release.yml before anything treats it as a version; it exists only so this tag never
# also triggers the backend's "vX.Y.Z_backend" release (.github/workflows/production-be-build.yaml).
#
# Usage:
#   bash cli/scripts/release-cli.sh                    # bump the patch and release
#   bash cli/scripts/release-cli.sh --dry-run          # print everything, tag nothing, push nothing
#   bash cli/scripts/release-cli.sh 0.2.0              # release an explicit version
#   bash cli/scripts/release-cli.sh --notes-file f.md  # hand-written release notes instead of the
#                                                      # generated commit list
#   bash cli/scripts/release-cli.sh --allow-older      # a rollback: older code under a higher version
#   bash cli/scripts/release-cli.sh --urgent "P0: why" # a P0 outside the 09:00-18:00 VN release window
#
# THE NEXT VERSION COMES FROM TWO SOURCES, AND BOTH MATTER — same reasoning as
# autonomous-harness-desktop/scripts/release-desktop.sh. Git tags alone are not enough:
# `cli/scripts/upload-cli.sh` bumps from the live metadata.json and tags nothing, so a maintainer who
# publishes by hand (or a scratch/dry-run publish that slipped) can leave the manifest ahead of the
# last tag. Bumping from tags alone there would produce a version LOWER than what's already served,
# which every daemon refuses (`semverGt` in cli/src/lib/selfUpdate.ts) while the release still looks
# successful. So the current version is max(highest git tag, the manifest's `cli` key version).
#
# Unlike the desktop, there is no --minor flag here: `shouldUpdate` in selfUpdate.ts is a plain
# semverGt with no major/minor-triggers-a-forced-update concept, so a "MANDATORY UPDATE" framing would
# invent semantics this CLI doesn't have. Every release just needs to be strictly newer.
#
# Requires: git, curl, python3, and push access to origin. No GCS credentials — the manifest is read
# over public HTTPS, exactly as cli/scripts/upload-cli.sh reads it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# --- config (all overridable via env) ---
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PUBLIC_BASE_URL="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/cli/metadata.json}"
OTA_KEY="${OTA_KEY:-cli}"   # must match ADAPTER_UPDATE_KEY in cli/src/config/env.ts
META_URL="${META_URL:-${GCS_PUBLIC_BASE_URL%/}/${METADATA_PATH#/}}"
BRANCH="${BRANCH:-main}"

DRY_RUN=0
ALLOW_NO_MANIFEST=0
ALLOW_OLDER=0
NEW_VER=""
NOTES_FILE=""
URGENT_SET=0
URGENT=""

want_notes_file=0
want_urgent=0
for arg in "$@"; do
  if [ "$want_notes_file" -eq 1 ]; then NOTES_FILE="$arg"; want_notes_file=0; continue; fi
  if [ "$want_urgent" -eq 1 ]; then URGENT="$arg"; want_urgent=0; continue; fi
  case "$arg" in
    --urgent) URGENT_SET=1; want_urgent=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --allow-no-manifest) ALLOW_NO_MANIFEST=1 ;;
    --allow-older) ALLOW_OLDER=1 ;;
    --notes-file) want_notes_file=1 ;;
    --notes-file=*) NOTES_FILE="${arg#*=}" ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "ERROR unknown flag: $arg" >&2; exit 1 ;;
    *) NEW_VER="$arg" ;;
  esac
done
[ "$want_notes_file" -eq 0 ] || { echo "ERROR --notes-file needs a path" >&2; exit 1; }

# --- the release window: refused with RELEASE_WINDOW outside 09:00-18:00 Asia/Ho_Chi_Minh, naming the next allowed
# time (scripts/release-window.py). A P0 passes --urgent "<reason>"; the reason goes on the tag.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/release-window.sh"
release_window_guard cli

# Same rule as next_adapter_version() in cli/scripts/upload-cli.sh:28-42, which is where this
# convention is defined. Note the rollover: .99 goes to the next MINOR at .1, not .0.
next_patch_version() {
  local current="$1" major minor patch
  if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "ERROR version '$current' must look like X.Y.Z" >&2
    return 1
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  patch=$((10#${BASH_REMATCH[3]}))
  if (( patch >= 99 )); then
    printf '%d.%d.1\n' "$major" "$((minor + 1))"
  else
    printf '%d.%d.%d\n' "$major" "$minor" "$((patch + 1))"
  fi
}

# Strictly greater, comparing X.Y.Z numerically — the same test the daemon applies before it will
# install anything (semverGt, cli/src/lib/selfUpdate.ts).
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# --- preflight: tooling ---
for tool in git curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR $tool not found — it is needed to cut a release" >&2; exit 1; }
done

# --- preflight: the tag must capture exactly what was tested, and CI must be able to fetch it ---
git rev-parse --git-dir >/dev/null 2>&1 || { echo "ERROR not a git repository: $ROOT" >&2; exit 1; }
git fetch --tags --quiet origin

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR working tree is dirty — a release tag must capture the tested source exactly:" >&2
  git status --short | sed 's/^/        /' >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$HEAD_SHA" "origin/$BRANCH" 2>/dev/null; then
  echo "ERROR HEAD is not on origin/$BRANCH — push the commit first, or CI will build a commit nobody else has." >&2
  exit 1
fi

# --- current version, source 1: the highest release tag in git ---
# The brace group keeps `set -e` from killing the script when grep legitimately matches nothing.
# Tags are "vX.Y.Z_cli" — the suffix only exists so release.yml's tag trigger never collides with
# the backend's "vX.Y.Z_backend" tags now that both live in one repo. Strip "v" and "_cli" so TAG_VER
# is always a bare X.Y.Z for the version-comparison logic below.
TAG_VER="$(git tag -l 'v*_cli' \
  | { grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)_cli$' || true; } \
  | sed -E 's/^v//; s/_cli$//' \
  | sort -V | tail -1)"
LAST_TAG=""
[ -z "$TAG_VER" ] || LAST_TAG="v${TAG_VER}_cli"
TAG_VER="${TAG_VER:-0.0.0}"

# --- current version, source 2: the version actually being served ---
GCS_VER="$(curl -fsSL "$META_URL" 2>/dev/null | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
entry = data.get(sys.argv[1])
if not isinstance(entry, dict):
    sys.exit(0)
version = entry.get("version")
if not isinstance(version, str) or not re.match(r"^\d+\.\d+\.\d+$", version.strip()):
    sys.exit(0)
print(version.strip())
' "$OTA_KEY" 2>/dev/null || true)"

if [ -z "$GCS_VER" ]; then
  if [ "$ALLOW_NO_MANIFEST" -eq 1 ]; then
    echo ">> WARNING could not read $META_URL — continuing on git tags alone (--allow-no-manifest)" >&2
    GCS_VER="0.0.0"
  else
    echo "ERROR could not read the live manifest at $META_URL" >&2
    echo "      It is the only record of what daemons are actually running, and releasing without it" >&2
    echo "      risks publishing a version LOWER than the one already being served." >&2
    echo "      Re-run with --allow-no-manifest only if the bucket is genuinely down." >&2
    exit 1
  fi
fi

# --- preflight: this release must contain the one before it ---
# HEAD on origin/$BRANCH is not enough: a checkout nobody updated is on it too, and a tag cut there ships
# older code under a newer version, which every daemon installs. v0.3.82_cli was tagged that way on
# October 12, 2026 (on fae1ca5766, 27 minutes after v0.3.81_cli on d96c270493 and three commits behind
# it; its run was cancelled before it published). Checked against the highest tag and against the tag of
# the version being served: they differ when a tag's release never published. A rollback is the one
# release that means to do this. The one check: #1246 and #1249 each added one the same hour, and the
# first, with no way past it, refused the rollback the second allows.
contains_release() {
  local tag="$1" sha
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || return 0
  sha="$(git rev-list -n1 "$tag")"
  git merge-base --is-ancestor "$sha" "$HEAD_SHA" 2>/dev/null && return 0
  if [ "$ALLOW_OLDER" -eq 1 ]; then
    echo ">> WARNING HEAD (${HEAD_SHA:0:12}) does not contain $tag (${sha:0:12}) — releasing older code (--allow-older)" >&2
    return 0
  fi
  echo "ERROR HEAD (${HEAD_SHA:0:12}) does not contain $tag (${sha:0:12})." >&2
  echo "      This release would ship older code under a newer version, taking back" >&2
  echo "      $(git rev-list --count "$HEAD_SHA..$sha") commit(s) that $tag already shipped." >&2
  echo "      Update this checkout first: git fetch origin && git checkout --detach origin/$BRANCH" >&2
  echo "      Re-run with --allow-older only to roll back on purpose." >&2
  exit 1
}
[ -z "$LAST_TAG" ] || contains_release "$LAST_TAG"
contains_release "v${GCS_VER}_cli"

# --- the next version ---
CUR="$TAG_VER"
version_gt "$GCS_VER" "$CUR" && CUR="$GCS_VER"

if [ -n "$NEW_VER" ]; then
  VER="$NEW_VER"
else
  VER="$(next_patch_version "$CUR")"
fi

if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR version '$VER' must look like X.Y.Z — release.yml rejects anything else" >&2
  exit 1
fi

TAG="v${VER}_cli"

# The last gate against a release no daemon can install.
if ! version_gt "$VER" "$GCS_VER"; then
  echo "ERROR $VER is not higher than $GCS_VER, which is already published." >&2
  echo "      Every running daemon would refuse it and the release would still look successful." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR tag $TAG already exists. Re-tagging a released version breaks the tag<->build mapping." >&2
  exit 1
fi

# --- release notes: the tag message IS the GitHub Release body ---
# release.yml's github-release job hard-fails on a lightweight tag or an empty message — and it runs
# AFTER the manifest is already live, so a missing message means a half-done release: daemons are
# already running a build that has no Release page. Refuse to tag without notes rather than find out
# then.
NOTES="$(mktemp)"
trap 'rm -f "${NOTES:-}"' EXIT
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || { echo "ERROR notes file not found: $NOTES_FILE" >&2; exit 1; }
  cat "$NOTES_FILE" > "$NOTES"
else
  {
    printf 'Harness CLI %s\n\n' "$VER"
    if [ -n "$LAST_TAG" ]; then
      git log --no-merges --pretty='- %s' "${LAST_TAG}..HEAD"
    else
      git log --no-merges --pretty='- %s' -20
    fi
  } > "$NOTES"
fi
[ -s "$NOTES" ] || { echo "ERROR release notes are empty — CI would fail after publishing" >&2; exit 1; }

# --- summary (shared by dry runs and real ones) ---
echo ""
echo "  last git tag       ${LAST_TAG:-（none）} ($TAG_VER)"
echo "  live on GCS        $GCS_VER ($OTA_KEY key)"
if version_gt "$GCS_VER" "$TAG_VER"; then
  echo "  NOTE               the manifest is ahead of git — versions were published without a tag."
  echo "                     Bumping from tags alone here would publish a downgrade."
fi
echo "  releasing          $VER   (tag $TAG on ${HEAD_SHA:0:12})"
echo ""
echo "  release notes:"
sed 's/^/      /' "$NOTES"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "  dry run — nothing tagged, nothing pushed."
  exit 0
fi

# --- tag and push ---
[ -z "$URGENT_TAG_LINE" ] || printf '\n%s\n' "$URGENT_TAG_LINE" >> "$NOTES"
git tag -a "$TAG" --cleanup=verbatim -F "$NOTES"
git push origin "$TAG"

echo ""
echo "  pushed $TAG → CI bundles the CLI, publishes to GCS, and cuts the GitHub Release."
echo "  running daemons self-update within ~1 min of the manifest moving."
echo "  watch : gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
echo ""
