#!/usr/bin/env bash
# Cut a Harness Device release: work out the next version, tag this commit vX.Y.Z_device, push the tag and start
# release-device.yml on it. CI builds one universal macOS app, signs and notarizes it, publishes it to GCS and verifies
# the downloads. The tag is the version; "_device" only keeps it apart from the other products' tags.
#
# Usage (from the repository root; `make release-device ARGS=...` runs the same):
#   bash device-app/scripts/release-device.sh                      # bump the patch and release
#   bash device-app/scripts/release-device.sh --dry-run            # print everything; tag, push and start nothing
#   bash device-app/scripts/release-device.sh --prepare            # build, sign and check main's tip; publish nothing
#   bash device-app/scripts/release-device.sh --minor              # X.(Y+1).1
#   bash device-app/scripts/release-device.sh 0.2.0                # an explicit version
#   bash device-app/scripts/release-device.sh --notes-file f.md    # hand-written notes instead of the commit list
#   bash device-app/scripts/release-device.sh --wait               # follow the run it started to its end
#   bash device-app/scripts/release-device.sh --allow-older        # a rollback: older code under a higher version
#   bash device-app/scripts/release-device.sh --allow-no-manifest  # the first release only: nothing is live yet
#
# The next version is the patch bump of max(highest v*_device tag, the live manifest's version), .99 rolling to the
# next minor at .1. device-manifest.py holds that rule and its refusals; this script does the Git work, the one HTTPS
# read and gh.
#
# Requires: git, curl, python3 and push access to origin; gh, signed in, unless --dry-run. No GCS credential: the
# manifest is read over public HTTPS.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# From the bucket, never through the CDN, which may still serve an older copy.
manifest_url="https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"
workflow="release-device.yml"

die() { echo "ERROR $*" >&2; exit 1; }

dry_run=0 prepare=0 follow=0 allow_older=0 notes_file=""
# device-manifest.py checks the version and refuses a second one.
next_args=(next)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --prepare) prepare=1 ;;
    --wait) follow=1 ;;
    --allow-older) allow_older=1 ;;
    --minor|--allow-no-manifest) next_args+=("$1") ;;
    --notes-file) [ "$#" -ge 2 ] || die "--notes-file needs a path"; notes_file="$2"; shift ;;
    -*) die "unknown flag: $1" ;;
    *) next_args+=("$1") ;;
  esac
  shift
done

for tool in git curl python3; do
  command -v "$tool" >/dev/null || die "$tool not found: it is needed to cut a release"
done
[ "$dry_run" -eq 1 ] || command -v gh >/dev/null || die "gh not found: it starts the release run"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -n "$notes_file" ]; then
  # Read before the cd below, so a path relative to where the script was started works.
  [ -f "$notes_file" ] || die "notes file not found: $notes_file"
  cp -- "$notes_file" "$work/notes"
fi
cd "$(git -C "$here" rev-parse --show-toplevel)"

# A stalled fetch or push over HTTPS gives up after 30 s below 1000 bytes/s instead of hanging.
export GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=30
# The tag must hold exactly the reviewed source, and CI must be able to fetch it.
git fetch --tags --quiet origin
[ -z "$(git status --porcelain)" ] || die "the working tree is dirty: a release tag must hold exactly the tested source"
head="$(git rev-parse HEAD)"
main="$(git rev-parse -q --verify refs/remotes/origin/main)" || die "origin has no main branch"
git merge-base --is-ancestor "$head" "$main" || die "HEAD (${head:0:12}) is not on origin/main: CI would build a commit nobody reviewed"
if [ "$prepare" -eq 1 ] && [ "$head" != "$main" ]; then
  die "--prepare runs only at origin/main's tip (${main:0:12}), not at ${head:0:12}: the workflow builds main"
fi

git tag -l 'v*_device' > "$work/tags"
next_args+=(--tags "$work/tags")
# A failed read passes no manifest: device-manifest.py then refuses, unless this is the first release.
if curl -fsSL --connect-timeout 10 --max-time 30 "$manifest_url" > "$work/manifest"; then
  next_args+=(--manifest "$work/manifest")
fi
next="$(python3 "$here/device-manifest.py" "${next_args[@]}")"
version="" last_tag="" live=""
while IFS='=' read -r key value; do
  case "$key" in
    version) version="$value" ;;
    last_tag) last_tag="$value" ;;
    live) live="$value" ;;
  esac
done <<<"$next"
tag="v${version}_device"

# A checkout nobody updated is on origin/main too, and a tag cut there ships older code under a newer version, which
# every app installs. Checked against the highest tag and the live version's tag, which differ when a release never
# published. Not for --prepare: it builds main's tip and publishes nothing.
contains() {
  local sha
  sha="$(git rev-parse -q --verify "refs/tags/$1^{commit}")" || return 0
  if git merge-base --is-ancestor "$sha" "$head"; then
    return 0
  fi
  if [ "$allow_older" -eq 0 ]; then
    die "HEAD (${head:0:12}) does not contain $1 (${sha:0:12}): this release would take back what $1 shipped. Update this checkout to origin/main, or pass --allow-older to roll back on purpose"
  fi
  echo "WARNING HEAD (${head:0:12}) does not contain $1: releasing older code (--allow-older)" >&2
}
if [ "$prepare" -eq 0 ]; then
  if [ -n "$last_tag" ]; then
    contains "$last_tag"
  fi
  contains "v${live}_device"
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  die "$tag exists: re-tagging a version breaks the link between a version and its build"
fi

# The tag message is the manifest's notes, and the workflow refuses a tag without one.
if [ -z "$notes_file" ]; then
  {
    printf 'Harness Device %s\n\n' "$version"
    # Only the device app's commits, of a monorepo: the notes are what its users read.
    if [ -n "$last_tag" ]; then
      git log --no-merges --pretty='- %s' -n 100 "$last_tag..HEAD" -- device-app
    else
      git log --no-merges --pretty='- %s' -n 20 -- device-app
    fi
  } > "$work/notes"
fi
grep -q '[^[:space:]]' "$work/notes" || die "the release notes are empty"

if [ "$prepare" -eq 1 ]; then
  dispatch=(gh workflow run "$workflow" --ref main -f "version=$version" -f publish=false)
else
  dispatch=(gh workflow run "$workflow" --ref "$tag" -f "version=$version" -f publish=true)
fi

echo "  last tag   ${last_tag:-none}"
echo "  live       $live"
echo "  version    $version"
echo "  commit     $head"
echo "  notes"
sed 's/^/    /' "$work/notes"
echo "  runs"
if [ "$prepare" -eq 0 ]; then
  echo "    git tag -a --no-sign $tag --cleanup=verbatim -F <the notes>"
  echo "    git push origin $tag"
fi
echo "    ${dispatch[*]}"
if [ "$follow" -eq 1 ]; then
  echo "    gh run watch <the run it starts> --exit-status"
fi
if [ "$dry_run" -eq 1 ]; then
  echo "  dry run: nothing tagged, pushed or started"
  exit 0
fi

# gh workflow run prints no run id, and this machine's clock need not agree with GitHub's: the run --wait follows is
# the one listed after the start that was not listed before it. Listed before anything is tagged, so a failed list
# leaves nothing behind.
runs=(gh run list --workflow "$workflow" --event workflow_dispatch --json databaseId)
if [ "$prepare" -eq 1 ]; then
  runs+=(--branch main)
else
  runs+=(--commit "$head")
fi
if [ "$follow" -eq 1 ]; then
  "${runs[@]}" > "$work/runs" || die "could not list the $workflow runs to tell the new one: nothing started"
fi
if [ "$prepare" -eq 1 ]; then
  "${dispatch[@]}"
  echo "  started $workflow on main for $version: nothing is tagged or published"
else
  # Unsigned whatever tag.gpgSign says: the workflow reads the whole tag message, a signature too, into the notes.
  git tag -a --no-sign "$tag" --cleanup=verbatim -F "$work/notes"
  # A tag left only here would pass for a release: it blocks the first one and changes the next one's notes.
  git push origin "$tag" || {
    git tag -d "$tag" >/dev/null
    die "could not push $tag: removed it here, nothing started. Fix the push and run this again"
  }
  # The tag stays: the run can still start on it by hand, and a second run without a version releases the next version.
  if ! "${dispatch[@]}"; then
    echo "ERROR $tag is pushed, but the release run did not start. Start it by hand with the line below," \
      "or run make release-device again to release the next version:" >&2
    echo "  ${dispatch[*]}" >&2
    exit 1
  fi
  echo "  pushed $tag and started $workflow on it"
fi

if [ "$follow" -eq 0 ]; then
  exit 0
fi
# gh lists the newest first.
run_id=""
for try in $(seq 1 12); do
  run_id="$("${runs[@]}" | python3 -c '
import json, sys
with open(sys.argv[1]) as before:
    listed = {run["databaseId"] for run in json.load(before)}
runs = [run["databaseId"] for run in json.load(sys.stdin) if run["databaseId"] not in listed]
if runs:
    print(runs[0])
' "$work/runs")" || run_id=""
  [ -z "$run_id" ] || break
  [ "$try" -eq 12 ] || sleep 5
done
[ -n "$run_id" ] || die "no $workflow run of ${head:0:12} appeared within a minute: gh run list --workflow $workflow"
gh run watch "$run_id" --exit-status
