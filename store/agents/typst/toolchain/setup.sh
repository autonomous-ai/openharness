#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Puts the pinned Typst release binary in bin/ — a
# single static executable from typst/typst's GitHub release for this machine, checked against the
# release's sha256 before anything is unpacked, nothing installed outside this directory.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat TYPST_VERSION)"
# GitHub's own digests for the release assets. They move with TYPST_VERSION: a bump pins them anew.
SUMS_FOR=v0.15.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET="typst-aarch64-apple-darwin.tar.xz" SUM=48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a ;;
  Darwin-x86_64) ASSET="typst-x86_64-apple-darwin.tar.xz" SUM=7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa ;;
  Linux-x86_64) ASSET="typst-x86_64-unknown-linux-musl.tar.xz" SUM=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c ;;
  Linux-aarch64) ASSET="typst-aarch64-unknown-linux-musl.tar.xz" SUM=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee ;;
  *) echo "miss no Typst release for $(uname -s)-$(uname -m)"; exit 1 ;;
esac
if [ -x bin/typst ] && bin/typst --version 2>/dev/null | grep -q "${VERSION#v}"; then echo "ok   typst ${VERSION} already here"; exit 0; fi
[ "$VERSION" = "$SUMS_FOR" ] || { echo "miss the checksums in toolchain/setup.sh are for typst ${SUMS_FOR}, not ${VERSION}"; exit 1; }
mkdir -p bin tmp
echo "     downloading typst ${VERSION} (${ASSET})"
URL="https://github.com/typst/typst/releases/download/${VERSION}/${ASSET}"
curl -fsSL --retry 3 -o "tmp/${ASSET}" "$URL" || { rm -rf tmp; echo "miss could not download $URL — check this machine's internet connection"; exit 1; }
if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "tmp/${ASSET}" | cut -d' ' -f1)"; else GOT="$(sha256sum "tmp/${ASSET}" | cut -d' ' -f1)"; fi
[ "$GOT" = "$SUM" ] || { rm -rf tmp; echo "miss ${ASSET} did not match its pinned checksum; nothing was installed"; exit 1; }
tar -xJf "tmp/${ASSET}" -C tmp
cp "tmp/${ASSET%.tar.xz}/typst" bin/typst && chmod +x bin/typst && rm -rf tmp
echo "ok   $(bin/typst --version)"
