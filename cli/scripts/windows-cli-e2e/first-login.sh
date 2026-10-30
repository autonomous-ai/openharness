#!/usr/bin/env bash
# first-login.sh <user> <password>: the first SSH sign-in of a new local Windows account, by password, which creates its
# profile and installs this Mac's public key (VM_KEY, default ~/.ssh/id_ed25519.pub) for it, so every later command
# signs in by key. The account must not be an administrator: sshd reads administrators' keys from ProgramData.
set -euo pipefail
user=$1 password=$2 host=${VM_HOST:-192.168.65.3}
key=$(cat "${VM_KEY:-$HOME/.ssh/id_ed25519.pub}")
ps="\$d = Join-Path \$env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Force \$d | Out-Null
\$f = Join-Path \$d 'authorized_keys'
Set-Content -Path \$f -Value '$key' -Encoding ascii
icacls.exe \$f /inheritance:r /grant \"\${env:USERNAME}:F\" /grant 'SYSTEM:F' | Out-Null
whoami"
encoded=$(printf '%s' "$ps" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
SSH_PASSWORD=$password expect -c "
  set timeout 90
  spawn ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no $user@$host powershell -NoProfile -EncodedCommand $encoded
  expect {
    \"password:\" { send \"\$env(SSH_PASSWORD)\r\"; exp_continue }
    eof
  }
"
ssh -o BatchMode=yes "$user@$host" whoami
