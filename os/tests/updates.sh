#!/bin/bash
# Run only inside the disposable installed OS used by vm.py.
set -euo pipefail
test -s /var/lib/harness-os/install.json
work=$(mktemp -d /tmp/hn-os-update-check.XXXXXX)
cp /etc/pacman.conf "$work/pacman.conf.before"
snapshot=$(python3 -c 'import json; print(json.load(open("/usr/share/harness-os/lock.json"))["arch_snapshot"])')
mkdir -p "$work/package/usr/share/hn-os-update-probe" "$work/repo"
for version in 1 2; do
    printf '%s\n' "$version" > "$work/package/usr/share/hn-os-update-probe/value"
    printf 'pkgname = hn-os-update-probe\npkgver = %s-1\npkgdesc = Disposable full-update fixture\narch = any\nsize = 2\n' "$version" > "$work/package/.PKGINFO"
    bsdtar --zstd -cf "$work/repo/hn-os-update-probe-$version-1-any.pkg.tar.zst" -C "$work/package" .PKGINFO usr
done
pacman --noconfirm -U "$work/repo/hn-os-update-probe-1-1-any.pkg.tar.zst"
repo-add "$work/repo/hn-update-test.db.tar.gz" "$work/repo/hn-os-update-probe-2-1-any.pkg.tar.zst"
# Pacman stops at the first unavailable repository. Sync the local fixture
# before hitting the disconnected Arch mirror, leaving a real mixed DB state.
python3 - "$work" <<'PY'
from pathlib import Path
import sys
config = Path('/etc/pacman.conf')
text = config.read_text()
assert '[core]\n' in text
repo = f'[hn-update-test]\nSigLevel = Never\nServer = file://{sys.argv[1]}/repo\n\n'
config.write_text(text.replace('[core]\n', repo + '[core]\n', 1))
PY
before=$(find /.snapshots -mindepth 1 -maxdepth 1 -type d | wc -l)
# The local repository can sync v2, but the full Arch refresh fails. A later
# ordinary install would otherwise upgrade against this partially synced state.
if env https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 no_proxy= NO_PROXY= hn-os update --snapshot "$snapshot"; then
    echo 'Expected the deliberately disconnected full update to fail.' >&2
    exit 1
fi
checkpoint=$(python3 -c 'import json; r=json.load(open("/var/lib/harness-os/update.json")); assert r["exit_status"] != 0; print(r["checkpoint"])')
test "$(cat /usr/share/hn-os-update-probe/value)" = 1
pacman -Si hn-os-update-probe | grep -E '^Version *: 2-1$'
if pacman --noconfirm -S hn-os-update-probe > "$work/blocked-package.log" 2>&1; then
    echo 'Package mutation was allowed after an incomplete full update.' >&2
    exit 1
fi
cat "$work/blocked-package.log"
grep -F 'full system update did not finish' "$work/blocked-package.log"
test "$(cat /usr/share/hn-os-update-probe/value)" = 1
test "$(find /.snapshots -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq "$((before + 1))"
# A real full upgrade must pass its own pre-transaction hook while holding the
# system lock, reuse the original checkpoint, and clear the incomplete state.
printf 'y\n' | hn-os update --snapshot "$snapshot"
python3 - "$checkpoint" <<'PY'
import json, sys
r = json.load(open('/var/lib/harness-os/update.json'))
assert r['exit_status'] == 0 and r['checkpoint'] == sys.argv[1], r
PY
test "$(cat /usr/share/hn-os-update-probe/value)" = 2
test "$(cat "/.snapshots/$checkpoint/root/usr/share/hn-os-update-probe/value")" = 1
test "$(find /.snapshots -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq "$((before + 1))"
pacman --noconfirm -R hn-os-update-probe
test ! -e /usr/share/hn-os-update-probe/value
cp "$work/pacman.conf.before" /etc/pacman.conf
rm -f /var/lib/pacman/sync/hn-update-test.db /var/lib/pacman/sync/hn-update-test.db.sig
rm -rf "$work"
echo 'Failed full update blocked packages; retry upgraded successfully and retained the original checkpoint.'
