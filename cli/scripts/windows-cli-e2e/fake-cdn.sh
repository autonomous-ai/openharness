#!/usr/bin/env bash
# The fake HTTPS CDN the Windows end to end installs from (docs/testing/windows-cli-e2e.md, step 1): this Mac answers
# as cdn.autonomous.ai and storage.googleapis.com for the VM, once vm-cdn.ps1 -Enable points the VM's hosts file here,
# so the real `irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex` installs this tree's build.
#   fake-cdn.sh make-ca            a throwaway CA (30 days, both names only) and its leaf in $FAKE_CDN_DIR/ca; kept if present
#   fake-cdn.sh pty-from-vm        copy the VM's own pty build (C:\work\oh\pty, arm64) into $FAKE_CDN_DIR/pty/win32-arm64
#   fake-cdn.sh stage <version>    lay out harness/staging/ as the staging publish would, from this tree (B1 scripts)
#   fake-cdn.sh serve              serve $FAKE_CDN_DIR/root on https://$VM_BIND:443 until stopped
# FAKE_CDN_DIR defaults to .fake-cdn beside this script (git-ignored: it holds the CA key). VM_BIND is the Mac's
# address on the VM's network (default 192.168.65.1). <version> is the CLI's, a prerelease such as 0.4.18-staging.1;
# the pty's is PTY_VERSION, else the one the payload's host reports (pty-from-vm), else the CLI's X.Y.Z. NODE_VERSION (default 22.23.2) is the Windows Node staged. PTY_X64_DIR / PTY_ARM64_DIR name
# payload folders (default $FAKE_CDN_DIR/pty/win32-<arch>); a platform without one is left out of the pty manifest.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cli=$(cd "$here/../.." && pwd)
dir=${FAKE_CDN_DIR:-$here/.fake-cdn}
root=$dir/root
bind=${VM_BIND:-192.168.65.1}
prefix=harness/staging
node_bin=${FAKE_CDN_NODE:-node}
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
size() { wc -c < "$1" | tr -d ' '; }
place() { mkdir -p "$(dirname "$root/$2")"; cp "$1" "$root/$2"; }

make_ca() {
  local ca=$dir/ca
  if [ -f "$ca/fake-cdn-ca.pem" ] && [ -f "$ca/leaf.pem" ]; then
    echo "CA kept: $ca/fake-cdn-ca.pem"
  else
    mkdir -p "$ca" && chmod 700 "$ca"
    ( umask 077
      # Name-constrained: a leaked key can vouch for these two names only, never for any other site the VM (or a
      # machine that kept the CA by mistake) visits. 30 days, so a CA nobody removed stops being trusted soon.
      openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -keyout "$ca/fake-cdn-ca.key" -out "$ca/fake-cdn-ca.pem" \
        -subj "/CN=Harness fake CDN test CA $(date +%Y-%m-%d)" \
        -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
        -addext 'nameConstraints=critical,permitted;DNS:cdn.autonomous.ai,permitted;DNS:storage.googleapis.com' 2>/dev/null
      openssl req -newkey rsa:2048 -nodes -sha256 -keyout "$ca/leaf.key" -out "$ca/leaf.csr" -subj '/CN=cdn.autonomous.ai' 2>/dev/null
      printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
        'extendedKeyUsage=serverAuth' 'subjectAltName=DNS:cdn.autonomous.ai,DNS:storage.googleapis.com' > "$ca/leaf.ext"
      openssl x509 -req -in "$ca/leaf.csr" -CA "$ca/fake-cdn-ca.pem" -CAkey "$ca/fake-cdn-ca.key" -CAcreateserial \
        -days 30 -sha256 -extfile "$ca/leaf.ext" -out "$ca/leaf.pem" 2>/dev/null )
    rm -f "$ca/leaf.csr" "$ca/leaf.ext"
    echo "CA made: $ca/fake-cdn-ca.pem"
  fi
  openssl x509 -in "$ca/fake-cdn-ca.pem" -noout -subject -enddate -fingerprint -sha1
  openssl verify -CAfile "$ca/fake-cdn-ca.pem" "$ca/leaf.pem"
}

pty_from_vm() {
  local vm=${VM_SSH:-admin@192.168.65.3} out=$dir/pty/win32-arm64 file
  mkdir -p "$out"
  for file in harness-pty.exe harness-launch.exe harness.exe; do scp -q -o BatchMode=yes "$vm:C:/work/oh/pty/target/release/$file" "$out/"; done
  for file in conpty.dll OpenConsole.exe; do scp -q -o BatchMode=yes "$vm:C:/work/oh/pty/vendor/conpty/arm64/$file" "$out/"; done
  # The version the host reports names its folder (runtime\pty\<version>\, windows.yml): a build without
  # HARNESS_PTY_VERSION reports the crate's. stage reads it from here.
  ssh -o BatchMode=yes "$vm" 'C:\work\oh\pty\target\release\harness-pty.exe version' | tr -d '\r' |
    "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))' > "$out/.version"
  echo "the host reports version $(cat "$out/.version")"
  shasum -a 256 "$out"/*.exe "$out"/*.dll
}

# shellcheck disable=SC2154 # the L_* names are read from fake-cdn.mjs layout, a line at a time
stage() {
  local version=${1:?usage: fake-cdn.sh stage <version>} node_version=${NODE_VERSION:-22.23.2}
  # install.ps1's $HarnessCliVersionPattern, and the pty's X.Y.Z (publish-pty-payload.sh accepts only that).
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] || { echo "error: $version is not a CLI version" >&2; exit 2; }
  local arm64_dir=${PTY_ARM64_DIR:-$dir/pty/win32-arm64} build=$dir/build/$version pty_version
  # The pty's version is the one its host reports (pty-from-vm records it), else the CLI's X.Y.Z as a release stamps.
  pty_version=${PTY_VERSION:-$(cat "$arm64_dir/.version" 2>/dev/null || echo "${version%%-*}")}
  [[ "$pty_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: pty version $pty_version is not X.Y.Z" >&2; exit 2; }
  # Every object path and address, from fake-cdn.mjs stagingLayout (unit-tested): cli_cli_js_object, pty_win32_arm64_url, ...
  local name value
  while IFS='=' read -r name value; do printf -v "L_$name" '%s' "$value"; done < <("$node_bin" "$here/fake-cdn.mjs" layout "$version" "$pty_version" "$node_version" "$prefix")
  rm -rf "${root:?}/$prefix" "${build:?}" && mkdir -p "$build"

  echo ">> CLI $version: bundled from this tree"
  (cd "$cli" && ADAPTER_VERSION="$version" BUNDLE_OUT_DIR="$build" npm run --silent bundle >/dev/null 2>&1)
  [ "$("$node_bin" "$build/cli.js" version)" = "$version" ] || { echo "error: the bundle does not answer $version" >&2; exit 1; }
  place "$build/cli.js" "$L_cli_cli_js_object"
  place "$build/notify.mjs" "$L_cli_notify_mjs_object"
  # The cli entry as upload-cli.sh writes it (merge-manifest.mjs), keyed `cli` as release.yml's staging step merges it.
  "$node_bin" "$cli/scripts/merge-manifest.mjs" /dev/null "$build/cli-metadata.json" cli "$version" \
    "$L_cli_cli_js_url" "$(sha "$build/cli.js")" "$(size "$build/cli.js")" \
    "$L_cli_notify_mjs_url" "$(sha "$build/notify.mjs")" "$(size "$build/notify.mjs")"
  place "$build/cli-metadata.json" "$L_manifests_cli"

  echo ">> terminal host $pty_version: publish-pty-payload.sh, dry run"
  local x64=${PTY_X64_DIR:-$dir/pty/win32-x64} arm64=$arm64_dir platforms=()
  [ -f "$x64/harness-pty.exe" ] && platforms+=(win32-x64)
  [ -f "$arm64/harness-pty.exe" ] && platforms+=(win32-arm64)
  [ ${#platforms[@]} -gt 0 ] || { echo "error: no pty payload in $x64 or $arm64 (run: fake-cdn.sh pty-from-vm)" >&2; exit 1; }
  # The script zips both; a platform without a payload borrows the other's folder and is then left out.
  [ -f "$x64/harness-pty.exe" ] || x64=$arm64
  [ -f "$arm64/harness-pty.exe" ] || arm64=$x64
  DRY_RUN=1 DRY_RUN_OUT="$build/pty" bash "$cli/scripts/publish-pty-payload.sh" "$pty_version" "$x64" "$arm64" >/dev/null
  "$node_bin" "$here/fake-cdn.mjs" pty-manifest "$build/pty/metadata.json" "$build/pty-metadata.json" "$prefix" "${platforms[@]}"
  local platform
  for platform in "${platforms[@]}"; do
    object_var=L_pty_${platform//-/_}_object
    place "$build/pty/harness-pty-$pty_version-$platform.zip" "${!object_var}"
  done
  place "$build/pty-metadata.json" "$L_manifests_pty"

  echo ">> Node v$node_version for Windows: publish-node-runtime-windows.sh, dry run (signed SHASUMS256.txt)"
  DRY_RUN=1 DRY_RUN_OUT="$build/runtime" bash "$cli/scripts/publish-node-runtime-windows.sh" "$node_version" >/dev/null
  local arch zip object object_var
  for arch in x64 arm64; do
    object_var=L_node_win32_${arch}_object
    object=${!object_var} zip=${object##*/}
    # Kept between stages (the official versioned path is immutable), fetched again only when it is not the
    # manifest's bytes.
    if [ ! -f "$root/$object" ] || [ "$(sha "$root/$object")" != "$("$node_bin" -e 'console.log(require(process.argv[1]).node[process.argv[2]].sha256)' "$build/runtime/metadata.json" "win32-$arch")" ]; then
      mkdir -p "$(dirname "$root/$object")"
      curl -fsSL "${NODE_DIST_BASE:-https://nodejs.org/dist}/v$node_version/$zip" -o "$root/$object"
    fi
  done
  "$node_bin" -e '
    const fs = require("fs"), crypto = require("crypto"), [file, root] = process.argv.slice(1)
    for (const [platform, entry] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).node)) {
      const object = new URL(entry.url).pathname.split("/").slice(2).join("/"), bytes = fs.readFileSync(`${root}/${object}`)
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256 || bytes.length !== entry.size) throw new Error(`${object} does not match the runtime manifest entry ${platform}`)
    }
  ' "$build/runtime/metadata.json" "$root"
  place "$build/runtime/metadata.json" "$L_manifests_runtime"

  echo ">> install.ps1: upload-install-ps1.sh --print (staging)"
  mkdir -p "$(dirname "$root/$L_installScript_object")"
  STAGING_PREFIX=$prefix bash "$cli/scripts/upload-install-ps1.sh" --print > "$root/$L_installScript_object"
  grep -qxF "\$HarnessManifestBase = '$L_manifestBase'" "$root/$L_installScript_object" || { echo "error: install.ps1 does not read $L_manifestBase" >&2; exit 1; }
  echo "   $L_installScript_url reads $L_manifestBase"

  echo ">> staged under $root"
  (cd "$root" && find harness -type f | sort | while read -r f; do printf '%10s  %s  %s\n' "$(size "$f")" "$(sha "$f" | cut -c1-12)" "$f"; done)
}

case "${1:-}" in
  make-ca) make_ca ;;
  pty-from-vm) pty_from_vm ;;
  stage) shift; stage "$@" ;;
  serve)
    [ -f "$dir/ca/leaf.pem" ] || { echo "error: no certificate; run fake-cdn.sh make-ca" >&2; exit 1; }
    [ -f "$root/$prefix/cli/install.ps1" ] || { echo "error: nothing staged; run fake-cdn.sh stage <version>" >&2; exit 1; }
    exec "$node_bin" "$here/fake-cdn.mjs" serve --root "$root" --cert "$dir/ca/leaf.pem" --key "$dir/ca/leaf.key" \
      --bind "$bind" --port "${FAKE_CDN_PORT:-443}" --http-port "${FAKE_CDN_HTTP_PORT:-80}" ;;
  *) sed -n '2,13p' "$0" >&2; exit 2 ;;
esac
