#!/usr/bin/env bash
# Ship the browser app to harness.autonomous.ai from THIS repo:
#
#   1. tag this commit vX.Y.Z_web and push it;
#   2. ../.github/workflows/release-web.yml builds the Flutter bundle, bakes it into website/'s image,
#      pushes gcr.io/autonomous-ecm/autonomous-code-website:<tag> and :latest — ArgoCD rolls it out —
#      and publishes the bundle as a GitHub Release;
#   3. this script waits for that run and checks the release's manifest.
#
# The website used to live in autonomous-ai/autonomous-code, and this script then opened a PR there
# and ran that repo's own release. It lives in website/ now, so one tag ships both.
#
# Usage (from the repo root, `make release-web ARGS=...` runs the same thing):
#   bash desktop/scripts/release-web.sh              # bump the patch of the last v*_web tag and ship
#   bash desktop/scripts/release-web.sh --dry-run    # print the plan, tag/push nothing
#   bash desktop/scripts/release-web.sh --minor      # bump the MINOR version
#   bash desktop/scripts/release-web.sh --website-only # preserve the deployed Flutter bundle
#   bash desktop/scripts/release-web.sh 1.3.0        # an explicit version
#
# RESUMING: after a failure, re-run with the SAME explicit version — an existing tag is reused rather
# than moved, and the script only waits for its run. A tag whose build failed is not retried by moving
# it: fix forward and cut the next version.
#
# Requires: git, gh (signed in, with push access to both repos).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# --- config (all overridable via env) ---
BRANCH="${BRANCH:-main}"
WORKFLOW="${WORKFLOW:-release-web.yml}"
# The image's tag line predates this repo's: autonomous-code pushed v1.1.x–v1.2.x_web (v1.2.24_web
# last, on 2026-09-28) before the website moved here, while this repo's own v*_web tags (bundle-only
# then) were on 0.1.x. ArgoCD's image updater only rolls out a tag newer than the one it runs, so
# versions never go below the floor: the first release from here bumps the MINOR, to 1.3.1, clear of
# anything that line pushed. Raise the floor if a higher tag ever lands in the registry some other way.
VERSION_FLOOR="${VERSION_FLOOR:-1.3.0}"
RUN_APPEAR_TIMEOUT="${RUN_APPEAR_TIMEOUT:-180}"   # seconds for the tag's workflow run to show up

DRY_RUN=0
DO_MINOR=0
WEBSITE_ONLY=0
NEW_VER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --minor) DO_MINOR=1 ;;
    --website-only) WEBSITE_ONLY=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "ERROR unknown flag: $arg" >&2; exit 1 ;;
    *) NEW_VER="${arg#v}" ;;
  esac
done

say() { echo ">> $*"; }
die() { echo "ERROR $*" >&2; exit 1; }

# Same rollover as release-desktop.sh: .99 goes to the next MINOR at .1.
next_version() {
  local current="$1" minor_bump="$2"
  [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "version '$current' must look like X.Y.Z"
  local major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]})) patch=$((10#${BASH_REMATCH[3]}))
  if [ "$minor_bump" -eq 1 ] || (( patch >= 99 )); then
    printf '%d.%d.1\n' "$major" "$((minor + 1))"
  else
    printf '%d.%d.%d\n' "$major" "$minor" "$((patch + 1))"
  fi
}

# --- preflight ---
for tool in git gh; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found — it is needed to ship the web app"
done
gh auth status >/dev/null 2>&1 || die "gh is not signed in — run: gh auth login"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
git fetch --tags --quiet origin

# --- the version: an explicit one (possibly resuming), or a bump of the last v*_web tag ---
LAST_VER="$(git tag -l 'v*_web' \
  | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+_web$' || true; } \
  | sed -E 's/^v//; s/_web$//' | sort -V | tail -1)"
LAST_VER="$(printf '%s\n%s\n' "${LAST_VER:-0.0.0}" "$VERSION_FLOOR" | sort -V | tail -1)"
if [ -n "$NEW_VER" ]; then
  VER="$NEW_VER"
else
  VER="$(next_version "$LAST_VER" "$DO_MINOR")"
fi
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version '$VER' must look like X.Y.Z — release-web.yml rejects anything else"
TAG="v${VER}_web"

# An existing tag is a resume: reuse it wherever it points. A new one must capture tested, pushed source.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG_EXISTS=1
  SHA="$(git rev-list -n1 "$TAG")"
  # A resume follows the immutable tag's mode, not new command-line flags.
  if git for-each-ref --format='%(contents)' "refs/tags/$TAG" | grep -qx 'Website-Only: true'; then
    WEBSITE_ONLY=1
  else
    [ "$WEBSITE_ONLY" -eq 0 ] || die "$TAG is a full web release; it cannot become website-only"
  fi
else
  TAG_EXISTS=0
  [ -z "$(git status --porcelain)" ] || { git status --short >&2; die "working tree is dirty — the tag must capture the tested source exactly"; }
  SHA="$(git rev-parse HEAD)"
  git merge-base --is-ancestor "$SHA" "origin/$BRANCH" 2>/dev/null \
    || die "HEAD is not on origin/$BRANCH — merge and push it first; the web ships from $BRANCH"
  [ "$(printf '%s\n%s\n' "$VER" "$LAST_VER" | sort -V | tail -1)" = "$VER" ] && [ "$VER" != "$LAST_VER" ] \
    || die "$VER is not higher than the last web release $LAST_VER"
fi

EXPECTED_BUNDLE_VERSION="$VER"
if [ "$WEBSITE_ONLY" -eq 1 ]; then
  command -v python3 >/dev/null 2>&1 || die "python3 is required for website-only release verification"
  EXPECTED_BUNDLE_VERSION="$(python3 desktop/scripts/verify-website-only-release.py "$SHA" "$([ "$TAG_EXISTS" -eq 0 ] && echo live || echo manifest)")"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say "release : $TAG @ ${SHA:0:8}  $(git log -1 --format=%s "$SHA" | cut -c1-60)$([ "$TAG_EXISTS" -eq 1 ] && echo '  (tag exists — resuming)')"
say "image   : gcr.io/autonomous-ecm/autonomous-code-website:$TAG (+ :latest)"
[ "$WEBSITE_ONLY" -eq 0 ] || say "bundle  : retain verified Harness Web $EXPECTED_BUNDLE_VERSION"

if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY RUN — nothing tagged or pushed."
  exit 0
fi

# --- 1. the tag ---
if [ "$TAG_EXISTS" -eq 0 ]; then
  if [ "$WEBSITE_ONLY" -eq 1 ]; then
    git tag -a "$TAG" -m "Harness website $VER" -m 'Website-Only: true' "$SHA"
  else
    git tag -a "$TAG" -m "Harness web $VER" "$SHA"
  fi
  git push origin "$TAG"
  say "pushed $TAG"
fi

# --- 2. the build: wait for CI unless its release (its last step) already exists ---
if ! gh release view "$TAG" --json assets -q '.assets[].name' 2>/dev/null | grep -qx 'harness-web-release.json'; then
  RUN_ID=""
  for _ in $(seq 1 $((RUN_APPEAR_TIMEOUT / 5))); do
    RUN_ID="$(gh run list --workflow "$WORKFLOW" --limit 20 --json databaseId,headBranch \
      -q ".[] | select(.headBranch == \"$TAG\") | .databaseId" | head -1)"
    [ -n "$RUN_ID" ] && break
    sleep 5
  done
  [ -n "$RUN_ID" ] || die "no $WORKFLOW run appeared for $TAG — check: gh run list --workflow $WORKFLOW"
  say "waiting for the image build: https://github.com/$REPO/actions/runs/$RUN_ID"
  gh run watch "$RUN_ID" --exit-status >/dev/null \
    || die "build failed — fix it and cut the next version: gh run view $RUN_ID --log-failed"
fi
gh release download "$TAG" -p harness-web-release.json -D "$WORK" --clobber
grep -q "\"version\": \"$EXPECTED_BUNDLE_VERSION\"" "$WORK/harness-web-release.json" \
  || die "the release's manifest is not for $EXPECTED_BUNDLE_VERSION"
say "image pushed, bundle published: https://github.com/$REPO/releases/tag/$TAG"

say "done — once ArgoCD rolls $TAG out, verify the changed routes; the web bundle reports $EXPECTED_BUNDLE_VERSION"
