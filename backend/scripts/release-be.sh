#!/usr/bin/env bash
# Cut a backend release: bump the version, tag HEAD `vX.Y.Z_backend`, push the tag.
#
#   ./scripts/release-be.sh              # patch bump  (v1.1.2_backend -> v1.1.3_backend, v1.1.99_backend -> v1.2.1_backend)
#   ./scripts/release-be.sh minor        # v1.1.2_backend -> v1.2.1_backend
#   ./scripts/release-be.sh major        # v1.1.2_backend -> v2.0.1_backend
#   ./scripts/release-be.sh 1.4.1        # exact version -> v1.4.1_backend (patch 1 to 99)
#   ./scripts/release-be.sh --dry-run    # print what it WOULD do, touch nothing
#   ./scripts/release-be.sh --allow-older  # a rollback: older code under a higher version
#
# Pushing the tag is the whole point: ../.github/workflows/production-be-build.yaml triggers on
# `vX.Y.Z_backend` tags and builds Dockerfile.k8s -> autonomous-code-be.
# The image ArgoCD deploys is named after this tag, so the tag must point at the commit you want live.
#
# The `_backend` suffix exists only so this tag never also fires the CLI's release workflow
# (../.github/workflows/release.yml, which reacts to `vX.Y.Z_cli`) now that both live in one repo.
# It is stripped below before anything treats it as a version. Releases before 2026-09-14 used the
# `_api` suffix (up to v1.2.15_api); the backend's version line was deliberately restarted at
# v0.0.1_backend, so those legacy tags are ignored here and nothing builds from them any more.
# Bash 3.2-compatible (macOS default).
set -euo pipefail

SERVICE="backend (autonomous-code-be)"
WORKFLOW=".github/workflows/production-be-build.yaml"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
ALLOW_OLDER=0
BUMP="patch"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-older) ALLOW_OLDER=1 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="exact"; EXACT="${arg#v}" ;;
    *) echo "usage: $0 [patch|minor|major|X.Y.Z] [--dry-run] [--allow-older]" >&2; exit 1 ;;
  esac
done

if [[ "$BUMP" == "exact" ]] &&
  ! [[ "$EXACT" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "ERROR exact version '$EXACT' is invalid; use SemVer X.Y.Z (for example 1.4.1)." >&2
  exit 1
fi
if [[ "$BUMP" == "exact" ]] && (( 10#${EXACT##*.} < 1 || 10#${EXACT##*.} > 99 )); then
  echo "ERROR exact version '$EXACT' needs a patch from 1 to 99, like every other release." >&2
  exit 1
fi

# --- preflight: the tag names a commit, so that commit must be the right one and must be on origin.
git fetch --tags --quiet origin

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR working tree is dirty — release tags must capture the tested source exactly:" >&2
  git status --short | sed 's/^/        /' >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$HEAD_SHA" "origin/$BRANCH" 2>/dev/null; then
  echo "ERROR HEAD is not on origin/$BRANCH — push the commit first, or CI will build a commit nobody else has." >&2
  exit 1
fi

# --- next version: highest valid SemVer release tag, then bump.
# Tags are "vX.Y.Z_backend" — strip "v" and "_backend" so LATEST is a bare X.Y.Z. No tag yet
# means 0.0.0, so the first release is v0.0.1_backend. `sort -V` handles numeric ordering while
# grep drops malformed tags.
LATEST="$(git tag -l 'v*_backend' \
  | { grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)_backend$' || true; } \
  | sed -E 's/^v//; s/_backend$//' \
  | sort -V | tail -1)"

# --- preflight: this release must contain the one before it.
# HEAD on origin is not enough: a checkout nobody updated is on it too, and a tag cut there deploys older
# code under a newer version. v0.3.82_cli was tagged that way on October 12, 2026, 27 minutes after
# v0.3.81_cli and three commits behind it. A rollback is the one release that means to do this.
if [[ -n "$LATEST" ]]; then
  LATEST_SHA="$(git rev-list -n1 "v${LATEST}_backend")"
  if ! git merge-base --is-ancestor "$LATEST_SHA" "$HEAD_SHA" 2>/dev/null; then
    if [[ "$ALLOW_OLDER" == "1" ]]; then
      echo ">> WARNING HEAD (${HEAD_SHA:0:12}) does not contain v${LATEST}_backend (${LATEST_SHA:0:12}) — releasing older code (--allow-older)" >&2
    else
      echo "ERROR HEAD (${HEAD_SHA:0:12}) does not contain v${LATEST}_backend (${LATEST_SHA:0:12})." >&2
      echo "      This release would deploy older code under a newer version, taking back" >&2
      echo "      $(git rev-list --count "$HEAD_SHA..$LATEST_SHA") commit(s) that v${LATEST}_backend already shipped." >&2
      echo "      Update this checkout first: git fetch origin && git checkout --detach origin/main" >&2
      echo "      Re-run with --allow-older only to roll back on purpose." >&2
      exit 1
    fi
  fi
fi
LATEST="${LATEST:-0.0.0}"

MAJOR="${LATEST%%.*}"
REST="${LATEST#*.}"
MINOR="${REST%%.*}"
PATCH="${REST#*.}"

# A patch runs from 1 to 99, then the next minor starts at .1: the convention Desktop and web already follow
# (desktop/scripts/release-desktop.sh next_patch_version). The backend lacked it, and v1.2.100_backend was cut
# on October 21, 2026; a patch past 99 also rolls over, so the release after it is v1.3.1_backend.
case "$BUMP" in
  patch) if (( PATCH >= 99 )); then NEXT="$MAJOR.$((MINOR + 1)).1"; else NEXT="$MAJOR.$MINOR.$((PATCH + 1))"; fi ;;
  minor) NEXT="$MAJOR.$((MINOR + 1)).1" ;;
  major) NEXT="$((MAJOR + 1)).0.1" ;;
  exact) NEXT="$EXACT" ;;
esac

TAG="v${NEXT}_backend"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR tag $TAG already exists. Re-tagging a released version breaks the image<->commit mapping." >&2
  exit 1
fi

echo "  service : $SERVICE"
echo "  branch  : $BRANCH @ $(git rev-parse --short HEAD)  $(git log -1 --format=%s | cut -c1-60)"
echo "  latest  : v${LATEST}_backend"
echo "  new tag : $TAG   [$BUMP]"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "  DRY RUN — nothing tagged or pushed."
  exit 0
fi

git tag -a "$TAG" -m "$SERVICE release $TAG"
git push origin "$TAG"

echo ""
echo "  pushed $TAG → CI builds autonomous-code-be and rolls it out. Nothing else to do."
echo "  watch : gh run list --workflow='Docker production backend build' --limit 3"
