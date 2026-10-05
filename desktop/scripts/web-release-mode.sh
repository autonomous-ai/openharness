#!/usr/bin/env bash
# Read the remote annotated tag, even when actions/checkout replaced its local
# ref with the peeled commit. Never infer a full release from missing metadata.
set -euo pipefail
ref="${1:?release tag ref required}"
expected_sha="${2:?expected source commit required}"
[[ "$ref" =~ ^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+_web$ ]] || {
  echo 'Expected refs/tags/vX.Y.Z_web' >&2; exit 1;
}
git fetch --no-tags --depth=1 --force origin "$ref:$ref"
[ "$(git cat-file -t "$ref")" = tag ] || {
  echo 'Release tag must be annotated; use make release-web' >&2; exit 1;
}
[ "$(git rev-parse "$ref^{commit}")" = "$expected_sha" ] || {
  echo 'Release tag differs from the checked-out source' >&2; exit 1;
}
if git for-each-ref --format='%(contents)' "$ref" | grep -qx 'Website-Only: true'; then
  echo true
else
  echo false
fi
