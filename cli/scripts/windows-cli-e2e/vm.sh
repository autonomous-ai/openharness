#!/usr/bin/env bash
# vm.sh <user> <script.ps1|file> [args…]: copy a script to the Windows VM as <user> (into %USERPROFILE%\e2e\) and, for a
# .ps1, run it there with Windows PowerShell and [args…]. Keeps the VM's cmd shell out of the quoting
# (docs/testing/windows-cli-e2e.md). VM_HOST names another machine (default 192.168.65.3).
set -euo pipefail
user=$1 file=$2
shift 2
host=${VM_HOST:-192.168.65.3}
ssh -o BatchMode=yes "$user@$host" "if not exist e2e mkdir e2e" >/dev/null
scp -q -o BatchMode=yes "$file" "$user@$host:e2e/"
case "$file" in
  *.ps1) exec ssh -o BatchMode=yes "$user@$host" "powershell -NoProfile -ExecutionPolicy Bypass -File e2e\\$(basename "$file") $*" ;;
esac
