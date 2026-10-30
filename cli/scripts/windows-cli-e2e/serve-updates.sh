#!/usr/bin/env bash
# The update server the Windows end to end updates from (docs/testing/windows-cli-e2e.md, scenarios 3 and 4): this
# Mac, at http://$VM_BIND:$VM_PORT/ (default 192.168.65.1:8799, the VM's way to the Mac), serving $SITE.
#   serve-updates.sh build <version>         bundle this tree as <version> into $SITE/<version>/
#   serve-updates.sh break-canary <version>  the same, made to fail `node cli.js version`: the canary rejects it
#   serve-updates.sh break-core <version>    the same, made to fail only as the core (`__run`): it passes the canary
#                                            and dies on probation, so the master rolls back
#   serve-updates.sh offer <version>         point $SITE/cli/metadata.json (key `cli`) at <version>
#   serve-updates.sh serve                   serve $SITE until stopped
set -euo pipefail
site=${SITE:?set SITE to a folder for the update server}
bind=${VM_BIND:-192.168.65.1}
port=${VM_PORT:-8799}
cli="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/cli"
# A statement at the top of a bundle, after its `#!/usr/bin/env node` line: before it, the shebang would be line 2,
# a SyntaxError, and break-core would fail the canary instead of dying on probation.
prepend() { node -e 'const [f, s] = process.argv.slice(1); const fs = require("fs"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^(#![^\n]*\n)?/, (m) => m + s + "\n"))' "$1" "$2"; }
case "${1:-}" in
  build|break-canary|break-core)
    version=$2 out="$site/$2"
    mkdir -p "$out"
    (cd "$cli" && ADAPTER_VERSION="$version" BUNDLE_OUT_DIR="$out" npm run --silent bundle >/dev/null)
    [ "$1" = break-canary ] && prepend "$out/cli.js" 'process.exit(3);'
    [ "$1" = break-core ] && prepend "$out/cli.js" 'if (process.argv[2] === "__run") process.exit(1);'
    shasum -a 256 "$out/cli.js" "$out/notify.mjs" ;;
  offer)
    version=$2 out="$site/$2"
    mkdir -p "$site/cli"
    node -e '
      const [dir, version, base] = process.argv.slice(1), fs = require("fs"), crypto = require("crypto")
      const ref = (name) => { const b = fs.readFileSync(`${dir}/${name}`); return { url: `${base}/${name}`, sha256: crypto.createHash("sha256").update(b).digest("hex"), size: b.length } }
      console.log(JSON.stringify({ cli: { version, cli: ref("cli.js"), notify: ref("notify.mjs") } }, null, 2))
    ' "$out" "$version" "http://$bind:$port/$version" > "$site/cli/metadata.json"
    cat "$site/cli/metadata.json" ;;
  serve)
    exec python3 -m http.server "$port" --bind "$bind" --directory "$site" ;;
  *)
    sed -n '2,9p' "$0" >&2; exit 2 ;;
esac
