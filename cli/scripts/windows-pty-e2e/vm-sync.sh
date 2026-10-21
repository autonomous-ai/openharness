#!/usr/bin/env bash
# Copy this tree's pty/, term/ and the TUI's vendored terminal (minus build output), and with --cli also cli/
# (minus node_modules, dist and coverage), to a Windows machine over SSH, for building and testing there.
#
#   VM_SSH=admin@192.168.65.3 VM_DIR=C:/work/oh cli/scripts/windows-pty-e2e/vm-sync.sh [--cli]
#   ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && cargo test"
#
# VM_SSH is the SSH destination (default admin@192.168.65.3, the UTM VM of docs/testing/windows-pty-e2e.md);
# VM_DIR the folder on it (default C:/work/oh, forward slashes). The target must have OpenSSH's tar (Windows 10+).
# It only adds and overwrites files: a file deleted here stays there.
set -euo pipefail
vm_ssh=${VM_SSH:-admin@192.168.65.3}
vm_dir=${VM_DIR:-C:/work/oh}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
dirs=(pty term tui/vendor tui/Cargo.toml tui/Cargo.lock tui/src tui/tests tui/scripts tui/THIRD_PARTY_NOTICES.md)
[ "${1:-}" = "--cli" ] && dirs+=(cli)
cd "$root"
win_dir=${vm_dir//\//\\}
ssh -o BatchMode=yes "$vm_ssh" "if not exist $win_dir mkdir $win_dir" >/dev/null 2>&1 || true
# COPYFILE_DISABLE: no macOS ._ resource files in the archive. OpenSSH's post-quantum notice is
# dropped from what ssh says; a failed tar on either side, or a failed ssh, still fails the sync.
messages=$(mktemp)
trap 'rm -f "$messages"' EXIT
status=0
COPYFILE_DISABLE=1 tar --exclude='*/target' --exclude='cli/node_modules' --exclude='cli/dist' --exclude='cli/coverage' \
    --exclude='cli/scripts/windows-pty-e2e/evidence' -cf - "${dirs[@]}" \
  | ssh -o BatchMode=yes "$vm_ssh" "tar -xf - -C $vm_dir" 2>"$messages" || status=$?
grep -v "pq.html\|post-quantum\|store now\|upgraded" "$messages" >&2 || true
if [ "$status" -ne 0 ]; then
  echo "sync to $vm_ssh:$vm_dir failed (exit $status)" >&2
  exit "$status"
fi
echo "synced to $vm_ssh:$vm_dir: ${dirs[*]}"
