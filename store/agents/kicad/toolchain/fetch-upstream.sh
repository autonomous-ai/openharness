#!/usr/bin/env bash
# Fetch the wrapped project into upstream/ at the commit VERSIONS pins — read-only, from its public
# repository, sparse and blob-less so only the folders a build needs come down. Idempotent: a matching
# upstream/.harness-commit means it is already there. Sourced by setup.sh; cwd = the package dir.
set -euo pipefail
. ./VERSIONS
if [ -f upstream/.harness-commit ] && [ "$(cat upstream/.harness-commit)" = "${UPSTREAM_COMMIT}" ]; then
  echo "ok   ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} already fetched"
  exit 0
fi
if ! command -v git >/dev/null 2>&1; then
  # A new Mac has no git until Xcode's command line tools are installed (a dialog, not a script).
  # GitHub serves the pinned commit as a tarball; the sparse patterns become tar excludes.
  echo "     no git on PATH — fetching ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} as a tarball"
  archive="${UPSTREAM_REPO%.git}/archive/${UPSTREAM_COMMIT}.tar.gz"
  rm -rf upstream.partial && mkdir upstream.partial
  curl -fsSL --retry 3 "$archive" | tar -xzf - -C upstream.partial --strip-components 1 \
    --exclude '*/products/*' --exclude '*/examples/*' \
    || { rm -rf upstream.partial; echo "miss could not fetch $archive"; exit 1; }
  echo "${UPSTREAM_COMMIT}" > upstream.partial/.harness-commit
  rm -rf upstream && mv upstream.partial upstream
  echo "ok   ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} fetched as a tarball ($(du -sh upstream | cut -f1))"
  exit 0
fi
echo "     fetching ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT:0:12} (${UPSTREAM_SPARSE_MODE} sparse: ${UPSTREAM_SPARSE})"
# The copy in upstream/ stays until the new one is complete: a fetch that fails (offline, a bad pin)
# leaves the install that worked.
rm -rf upstream.partial
git init -q upstream.partial
git -C upstream.partial remote add origin "${UPSTREAM_REPO}"
# Split the patterns on spaces WITHOUT globbing: `/*` is a sparse pattern, not the filesystem root.
read -r -a patterns <<<"${UPSTREAM_SPARSE}"
git -C upstream.partial sparse-checkout set --"${UPSTREAM_SPARSE_MODE}" -- "${patterns[@]}"
git -C upstream.partial fetch -q --depth 1 --filter=blob:none origin "${UPSTREAM_COMMIT}"
git -C upstream.partial checkout -q FETCH_HEAD
echo "${UPSTREAM_COMMIT}" > upstream.partial/.harness-commit
rm -rf upstream
mv upstream.partial upstream
echo "ok   ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} fetched ($(du -sh upstream | cut -f1))"
