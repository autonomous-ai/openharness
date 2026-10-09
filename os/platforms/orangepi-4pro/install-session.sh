#!/usr/bin/env bash
# Install the Harness OS session (labwc, foot, hn, Chromium) into a Debian 12 root for
# Orange Pi 4 Pro. The files come from os/tools/build-package.py's stage(): the same tree the
# PC package ships. Arch-only parts (pacman, installer, system updates, PC drivers) are left out.
# Usage (as root): install-session.sh ROOT RUNTIME_DIR [USER]
#   ROOT         / for the running board, or a mounted image
#   RUNTIME_DIR  output of os/tools/build-runtime.sh on aarch64
set -euo pipefail
ROOT=${1:?root directory}
RUNTIME=${2:?runtime directory}
ACCOUNT=${3:-orangepi}
SOURCE=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
PREFIX=${HARNESS_WL_PREFIX:-/opt/harness-wl}
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# 1. Stage the PC package tree from this source, accepting the aarch64 runtime.
python3 - "$SOURCE" "$RUNTIME" "$STAGE/tree" <<'PY'
import importlib.util, json, subprocess, sys
from pathlib import Path
source, runtime, destination = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('build_package', source / 'os/tools/build-package.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
info = json.loads((runtime / 'source.json').read_text())
if info.get('architecture') != 'aarch64' or info.get('dirty') is not False:
    raise SystemExit('Use a clean aarch64 runtime from os/tools/build-runtime.sh.')
module.validate_runtime = lambda runtime, commit: info
commit = subprocess.check_output(['git', '-c', f'safe.directory={source}', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
module.stage(source, runtime, destination, commit)
# OpenCode as the Fedora package bundles it: the locked ARM release, checksum- and ELF-checked,
# at /usr/lib/harness-opencode with /usr/bin/opencode, where first use (`hn-os try`) starts it.
payload_spec = importlib.util.spec_from_file_location('opencode_payload', source / 'os/tools/opencode_payload.py')
payload = importlib.util.module_from_spec(payload_spec)
payload_spec.loader.exec_module(payload)
lock = payload.read_lock(source / 'os/packaging/fedora/opencode.lock.json')
prepared = destination.parent / 'opencode'
payload.prepare(lock, destination.parent / 'archives', prepared)
payload.stage(prepared, destination, lock)
# A non-arch profile makes hn-os and `harness install|upgrade|rollback` refuse the PC system
# operations, as the Fedora package does. Debian keeps its own system updates.
path = destination / 'usr/share/harness-os/runtime.json'
runtime_info = json.loads(path.read_text())
runtime_info['system_profile'] = 'debian'
path.write_text(json.dumps(runtime_info, indent=2) + '\n')
PY
T=$STAGE/tree

# 2. Leave out what belongs to the Arch PC image.
rm -rf "$T/etc/pacman.d" "$T/etc/mkinitcpio.conf.d" "$T/etc/modprobe.d" "$T/usr/lib/modprobe.d" \
       "$T/etc/systemd/zram-generator.conf" "$T/etc/tmux.conf" "$T/etc/NetworkManager" \
       "$T/usr/lib/NetworkManager" "$T/usr/lib/udev/rules.d/81-harness-broadcom.rules" \
       "$T/usr/lib/systemd/system" "$T/usr/share/plymouth" \
       "$T/etc/sudoers.d/30-harness-updates" "$T/usr/lib/harness-os/init-keyring"
for unit in harness-update.service harness-update.timer harness-gpu-check.service \
            harness-gpu-check.timer harness-install.service; do
    rm -f "$T/usr/lib/systemd/user/$unit"
done
# The PC skel targets Arch's OpenCode 2 ("permissions" list). ARM has only the official 1.x
# release (as the Fedora package), so state the same rules in OpenCode 1's "permission" form.
cat > "$T/etc/skel/.config/opencode/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "model": "opencode/muse-spark-1.3-contributor-free",
  "permission": {
    "external_directory": { "/usr/share/harness-os/*": "allow" },
    "read": { "/usr/share/harness-os/*": "allow" },
    "edit": { "/usr/share/harness-os/*": "deny" }
  }
}
EOF
# Debian's administrators are the sudo group, not wheel.
sed -i 's/^%wheel/%sudo/' "$T/etc/sudoers.d/20-harness-network"

# 3. Install the tree. Replace rather than overwrite files a running session may hold open.
# Connections now live in the CLI; remove the former Python copy from an earlier install.
rm -rf "$ROOT/usr/lib/harness-os/connections" "$ROOT/usr/share/licenses/harness-os-connections" \
       "$ROOT/usr/lib/systemd/user/harness-connections.service" "$ROOT/usr/lib/systemd/user/harness-connections.socket"
cp -a --remove-destination "$T/." "$ROOT/"
chmod 440 "$ROOT/etc/sudoers.d/20-harness-network"
# The compositor from build-compositor.sh, at the path the session starts.
ln -sfn "$PREFIX/bin/labwc" "$ROOT/usr/lib/harness-os/labwc"
# This board has a display controller and no GPU driver: render on the CPU.
printf 'export WLR_RENDERER=pixman\n' > "$ROOT/etc/profile.d/harness-os-board.sh"
# Block glyphs on the HDMI console, so a sign-in QR drawn there scans.
sed -i 's/^CODESET=.*/CODESET="Uni2"/; s/^FONTFACE=.*/FONTFACE="Terminus"/; s/^FONTSIZE=.*/FONTSIZE="8x16"/' \
    "$ROOT/etc/default/console-setup"

# 4. The account: skel files, the daemon enabled and lingering, autologin on tty1.
H=$ROOT/home/$ACCOUNT
cp -an "$T/etc/skel/." "$H/"
cp -a "$T/etc/skel/.config/opencode/opencode.json" "$H/.config/opencode/opencode.json"
mkdir -p "$H/.local/bin" "$H/.local/state/harness-os" "$H/projects" \
         "$H/.config/systemd/user/default.target.wants"
ln -sfn /usr/lib/systemd/user/harness-daemon.service \
        "$H/.config/systemd/user/default.target.wants/harness-daemon.service"
chroot "$ROOT" chown -R "$ACCOUNT:$ACCOUNT" "/home/$ACCOUNT"
mkdir -p "$ROOT/var/lib/systemd/linger"
touch "$ROOT/var/lib/systemd/linger/$ACCOUNT"
mkdir -p "$ROOT/etc/systemd/system/getty@tty1.service.d"
printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin %s --noclear %%I $TERM\n' "$ACCOUNT" \
    > "$ROOT/etc/systemd/system/getty@tty1.service.d/autologin.conf"
