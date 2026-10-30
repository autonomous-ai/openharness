#!/usr/bin/env bash
# Windows desktop tooling. All private run state is under E2E_WORK (.work by default).
# Commands: preflight, user-add [user], push [user], driver [user], kilo [user],
# session-on/off [user], fetch version arch [--run id], put zip [user], put-admin file,
# run/ps/admin script.ps1 [Name=value ...], sh/sh-admin 'command', shot name,
# state, logs, procs, variant kind zip version, truncated zip, stamp label,
# cdn-ca/stage/serve/stop/status/on/off, cleanup [user]. See README.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
b=$root/cli/scripts/windows-cli-e2e
host=${VM_HOST:-192.168.65.3}
# The VM uses admin; the x64 dial PC's account/address come from the owner via the environment.
admin=${VM_ADMIN:-admin}
work=${E2E_WORK:-$here/.work}
ev=${EV:-$work/evidence}
cdn=${FAKE_CDN_DIR:-$work/fake-cdn}
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR)
vm_tools=(invoke.ps1 ownership.ps1 session-run.ps1 app-processes.ps1 test-app-processes.ps1 screenshot.ps1 input.ps1 uia.ps1 watch-windows.ps1
  start-app.ps1 clipboard.ps1 keep-awake.ps1 stage-zip.ps1 desktop-state.ps1 desktop-logs.ps1
  browser-link.ps1 parse-check.ps1 selftest.ps1 driver.cmd install-state.ps1
  dial-state.ps1 hold-port.ps1 install-build.ps1 harness-cli.ps1)
admin_tools=(invoke.ps1 ownership.ps1 session-run.ps1 winlogon.ps1 desktop-procs.ps1 cleanup.ps1 parse-check.ps1 serial-check.ps1)
umask 077
mkdir -p "$work/users" "$ev"
chmod 700 "$work"
tools() { python3 -I "$here/e2e_tools.py" "$@"; }
run_id=$(tools run-id "$work/run.json")
quiet() { grep -v -e 'post-quantum' -e 'store now, decrypt later' -e 'pq.html' -e 'may need to be upgraded' || true; }
scrub() { if [ "${E2E_RAW:-}" = 1 ]; then cat; else tools redact; fi; }
# shellcheck disable=SC2029 # The only callers supply a complete command; PowerShell source is encoded below.
vm() { ssh "${ssh_opts[@]}" "$1@$host" "$2" 2>&1 | quiet | scrub; }
# Only ASCII base64, not script/path/parameter text, is parsed by OpenSSH's remote cmd shell.
vm_ps() {
  local who=$1 encoded
  encoded=$({ printf '%s\n' "\$ErrorActionPreference='Stop'; \$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding(\$false)"; cat; } | tools ps-b64) || return
  vm "$who" "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
}
ps_quote() { python3 -I -c 'import sys; print("\x27" + sys.argv[1].replace("\x27", "\x27\x27") + "\x27")' "$1"; }
the_user() { printf '%s' "${1:-${E2E_USER:-hxe2e}}"; }
require_owner() { tools owner "$work/users/$1.json" "$1" "$run_id" >/dev/null; }
stamp() { echo "# $* $(date '+%Y-%m-%d %H:%M:%S %z')"; }

# The marker and the directory must agree before admin scripts can be copied or removed.
admin_root() {
  if [ ! -f "$work/vm-root.txt" ]; then
    local base=${E2E_VM_ROOT:-} encoded_base status=0
    encoded_base=$(tools args-b64 "Base=$base" "RunId=$run_id")
    E2E_RAW=1 vm_ps "$admin" > "$work/vm-root.txt.new" <<PS || status=$?
\$ErrorActionPreference = 'Stop'
\$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encoded_base')) | ConvertFrom-Json
\$base = if (\$p.Base) { \$p.Base } else { \$env:TEMP }
\$dir = Join-Path \$base ('harness-desktop-e2e-' + \$p.RunId)
if (Test-Path -LiteralPath \$dir) { throw 'admin scratch directory already exists without a local ownership receipt; inspect it, do not adopt it' }
New-Item -ItemType Directory -Path \$dir -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path (Join-Path \$dir 'users') | Out-Null
@{run_id=\$p.RunId} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path \$dir 'run.json') -Encoding ascii
Write-Output \$dir.Replace('\\', '/')
PS
    if [ "$status" -ne 0 ]; then
      scrub < "$work/vm-root.txt.new" >&2
      rm -f "$work/vm-root.txt.new"
      return "$status"
    fi
    tr -d '\r' < "$work/vm-root.txt.new" > "$work/vm-root.txt"
    rm -f "$work/vm-root.txt.new"
  fi
  local path
  path=$(cat "$work/vm-root.txt")
  if [[ "$path" != [A-Za-z]:/* || "$path" != */harness-desktop-e2e-"$run_id" || "$path" == *$'\n'* ]]; then
    echo 'invalid admin scratch receipt; inspect it before continuing' >&2
    return 2
  fi
  printf '%s\n' "$path"
}
put_files() {
  local who=$1 dir=$2
  shift 2
  printf '%s\n' "\$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path $(ps_quote "$dir") | Out-Null" | vm_ps "$who" >/dev/null
  scp -q "${ssh_opts[@]}" "$@" "$who@$host:$dir/"
}
push_admin() {
  local dir files=() f
  dir=$(admin_root)
  printf '%s\n' "\$r=Get-Content -Raw -LiteralPath $(ps_quote "$dir/run.json") | ConvertFrom-Json; if (\$r.run_id -cne '$run_id') { throw 'admin run ownership mismatch' }" | vm_ps "$admin" >/dev/null
  for f in "${admin_tools[@]}"; do files+=("$here/$f"); done
  put_files "$admin" "$dir" "${files[@]}" "$b/vm-cdn.ps1"
}
invoke() {
  local who=$1 dir=$2 script=$3 encoded
  shift 3
  [ -n "$dir" ] || { echo 'missing owned tool directory' >&2; return 2; }
  encoded=$(tools args-b64 "$@")
  printf '%s\n' "\$ErrorActionPreference='Stop'; & $(ps_quote "$dir/invoke.ps1") -Script $(ps_quote "$script") -RunId '$run_id' -ArgsB64 '$encoded'; exit \$LASTEXITCODE" | vm_ps "$who"
}
push() {
  local u files=() f
  u=$(the_user "${1:-}"); require_owner "$u"
  for f in "${vm_tools[@]}"; do files+=("$here/$f"); done
  put_files "$u" e2e "${files[@]}"
  scp -q "${ssh_opts[@]}" "$work/users/$u.json" "$u@$host:e2e/ownership.json"
  push_admin
  echo "tools copied to owned user $u and this run's admin scratch directory"
}
session() {
  local u=$1 script=$2 inner dir
  shift 2
  require_owner "$u"
  inner=$(tools args-b64 "$@"); dir=$(admin_root)
  if [ "${NO_WAIT:-}" = 1 ]; then
    invoke "$admin" "$dir" session-run.ps1 "User=$u" "RunId=$run_id" "Script=$script" "ArgsB64=$inner" "TimeoutSec=${RUN_TIMEOUT:-120}" NoWait=true
  else
    invoke "$admin" "$dir" session-run.ps1 "User=$u" "RunId=$run_id" "Script=$script" "ArgsB64=$inner" "TimeoutSec=${RUN_TIMEOUT:-120}"
  fi
}
# This is a baseline, not a demand to stop every shared listener/task.
preflight() {
  stamp preflight
  E2E_RAW=1 vm_ps "$admin" > "$work/preflight.json.new" <<'PS'
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(harness|harness-desktop|node|explorer)\.exe$' } | Select-Object ProcessId, SessionId, Name, CreationDate)
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like '*Harness*' -or $_.TaskName -like 'HxDesktopE2E-*' } | Select-Object TaskName, TaskPath)
@{os=(Get-CimInstance Win32_OperatingSystem).Caption; processes=$processes; tasks=$tasks; listeners=@(netstat -ano | Select-String 'LISTENING' | ForEach-Object { $_.Line.Trim() }); users=@(Get-LocalUser | Select-Object Name, SID, Enabled)} | ConvertTo-Json -Depth 8
PS
  mv "$work/preflight.json.new" "$work/preflight.json"
  if [ ! -f "$work/baseline.json" ]; then cp "$work/preflight.json" "$work/baseline.json"; fi
  scrub < "$work/preflight.json"
  echo 'Unrelated listeners/tasks are preserved. GUI requires a separate owned active unlocked test session.'
}
user_add() {
  local u pw dir encoded
  u=$(the_user "${1:-}")
  [[ "$u" =~ ^hx[a-z0-9]+$ ]] || { echo 'error: choose a new test account named hx followed by letters/digits' >&2; return 2; }
  [ ! -f "$work/users/$u.json" ] || { echo 'error: this run already has a receipt for that user' >&2; return 2; }
  [ -f "$work/baseline.json" ] || preflight
  push_admin; dir=$(admin_root)
  pw=$(openssl rand -base64 24 | tr -d '/+=\n')
  printf '%s %s\n' "$u" "$pw" >> "$work/users.txt"
  encoded=$(tools args-b64 "User=$u" "Password=$pw" "Root=$dir" "RunId=$run_id")
  # Account creation produces the positive SID receipt before first-login can start any process for it.
  E2E_RAW=1 vm_ps "$admin" > "$work/users/$u.json.new" <<PS
\$ErrorActionPreference='Stop'
\$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encoded')) | ConvertFrom-Json
if (Get-LocalUser -Name \$p.User -ErrorAction SilentlyContinue) { throw 'the account already exists; it is never adopted or removed by this run' }
\$profiles=[Environment]::ExpandEnvironmentVariables((Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList').ProfilesDirectory)
\$profile=Join-Path \$profiles \$p.User
if (Test-Path -LiteralPath \$profile) { throw 'profile directory already exists; choose a new test account' }
\$new=New-LocalUser -Name \$p.User -Password (ConvertTo-SecureString \$p.Password -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -Description ('Harness E2E ' + \$p.RunId)
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member \$new
\$owner=@{run_id=\$p.RunId;user=\$p.User;sid=\$new.SID.Value;profile=\$profile;created=\$true;created_at=[DateTime]::UtcNow.ToString('o');tasks=@();baseline_tasks=@(Get-ScheduledTask | ForEach-Object { \$_.TaskPath + \$_.TaskName })}
\$owner | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path \$p.Root ('users\\'+\$p.User+'.json')) -Encoding utf8
\$owner | ConvertTo-Json -Depth 8
PS
  mv "$work/users/$u.json.new" "$work/users/$u.json"
  require_owner "$u"
  VM_HOST=$host "$b/first-login.sh" "$u" "$pw" 2>&1 | quiet | scrub
  # Refuse a profile alias before copying tools. The account's recorded SID is authoritative.
  E2E_RAW=1 vm_ps "$admin" >/dev/null <<PS
\$ErrorActionPreference='Stop'
. $(ps_quote "$dir/ownership.ps1")
\$o=Read-Owner '$u' '$run_id'
\$actual=(Get-CimInstance Win32_UserProfile -Filter "SID='\$(\$o.sid)'").LocalPath
if (-not [string]::Equals(\$actual,\$o.profile,[StringComparison]::OrdinalIgnoreCase)) { throw 'actual profile differs from the new owned profile; inspect before proceeding' }
PS
  push "$u"
  echo "created owned standard user $u"
}
driver() {
  local u
  u=$(the_user "${1:-}"); require_owner "$u"
  "$root/cli/scripts/windows-pty-e2e/build.sh" "$work" >/dev/null
  put_files "$u" e2e "$work/e2e.mjs" "$b/run.cmd" "$here/driver.cmd" "$here/desktop-state.ps1"
  # desktop-state emits only this user's record. The CMD wrapper re-reads it on every later invocation too.
  E2E_RAW=1 invoke "$u" e2e desktop-state.ps1 DriverRecord=true | tools record-port >/dev/null
  vm "$u" 'e2e\driver.cmd list'
}
kilo() {
  local u
  u=$(the_user "${1:-}"); require_owner "$u"
  vm_ps "$u" <<'PS'
$ErrorActionPreference='Stop'
$key='HKCU:\Environment'
$raw=[string](Get-Item -LiteralPath $key).GetValue('Path','','DoNotExpandEnvironmentNames')
if ($raw -notmatch '(?i)%APPDATA%\\npm') {
  $new=if ($raw) { $raw.TrimEnd(';')+';%APPDATA%\npm' } else { '%APPDATA%\npm' }
  Set-ItemProperty -LiteralPath $key -Name Path -Value $new -Type ExpandString
}
& npm.cmd install -g --allow-scripts=@kilocode/cli @kilocode/cli
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:APPDATA\npm\kilo.cmd" --version
exit $LASTEXITCODE
PS
}
session_on() {
  local u
  u=$(the_user "${1:-}"); require_owner "$u"; push_admin
  # The task executes the unlocked/input-desktop check inside the target session.
  session "$u" ownership.ps1 Probe=true
  NO_WAIT=1 session "$u" keep-awake.ps1
  E2E_USER=$u shot session-on
}
session_off() {
  local u dir
  u=$(the_user "${1:-}"); require_owner "$u"; dir=$(admin_root)
  vm_ps "$admin" <<PS
\$ErrorActionPreference='Stop'
. $(ps_quote "$dir/ownership.ps1")
\$o=Read-Owner '$u' '$run_id'
foreach (\$item in @(\$o.tasks | Where-Object { \$_.script -eq 'keep-awake.ps1' })) {
  \$task=Get-ScheduledTask -TaskName \$item.name -ErrorAction SilentlyContinue
  if (\$task) {
    \$sid=\$task.Principal.UserId
    if (\$sid -notmatch '^S-1-') { \$sid=(New-Object Security.Principal.NTAccount(\$sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if (\$item.created -ne \$true -or \$sid -ne \$o.sid) { throw 'task creation/principal changed; left untouched' }
    Stop-ScheduledTask -InputObject \$task
    Unregister-ScheduledTask -InputObject \$task -Confirm:\$false
  }
}
'owned keep-awake tasks stopped; login/session/global settings preserved'
PS
}
fetch() {
  local version=${1:?usage: fetch version arch [--run id]} arch=${2:?usage: fetch version arch [--run id]} run='' out found
  local zip_name='' zip_url='' manifest_url=''
  if [ "${3:-}" = --run ]; then run=${4:?--run needs an id}; fi
  eval "$(tools layout "$version" "$arch")"
  mkdir -p "$work/zips"; out=$work/zips/$zip_name
  if [ -n "$run" ]; then
    [[ "$run" =~ ^[0-9]+$ ]] || { echo 'invalid workflow run id' >&2; return 2; }
    mkdir -p "$work/runs/$run"
    gh run download "$run" --pattern 'harness-desktop-*' --dir "$work/runs/$run"
    found=$(find "$work/runs/$run" -type f -name "$zip_name" | head -1)
    [ -n "$found" ] || { echo 'no matching desktop zip in that workflow run' >&2; return 1; }
    cp "$found" "$out"
    gh run view "$run" --json url,headSha,conclusion,displayTitle
  else
    curl -fsS -o "$out" "$zip_url"
    curl -fsS -o "$work/zips/metadata.json" "$manifest_url"
    tools verify "$work/zips/metadata.json" "$arch" "$out"
  fi
  shasum -a 256 "$out" | scrub
  tools zip-info "$out"
}
put() {
  local u
  u=$(the_user "${2:-}"); require_owner "$u"
  put_files "$u" Downloads "${1:?usage: put zip [user]}"
}
shot() {
  local name=${1:?usage: shot name [Window=process Mask=boxes]} u
  shift
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo 'invalid screenshot name' >&2; return 2; }
  u=$(the_user '')
  session "$u" screenshot.ps1 "Out=shots\\$name.png" "$@"
  scp -q "${ssh_opts[@]}" "$u@$host:e2e/shots/$name.png" "$ev/$name.png"
  echo "screenshot: $ev/$name.png (inspect before sharing)"
}
cdn_owned() {
  mkdir -p "$cdn"
  if [ -f "$cdn/run-id" ]; then
    [ "$(cat "$cdn/run-id")" = "$run_id" ] || { echo 'CDN directory belongs to another run' >&2; return 2; }
  else
    [ -z "$(find "$cdn" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo 'CDN directory already contains unowned files' >&2; return 2; }
    printf '%s\n' "$run_id" > "$cdn/run-id"
  fi
}
cdn_ca() { cdn_owned; FAKE_CDN_DIR=$cdn "$b/fake-cdn.sh" make-ca; }
cdn_stage() { cdn_owned; tools cdn-stage "$cdn/root" "$@"; }
cdn_serve() {
  cdn_owned
  [ -f "$cdn/ca/leaf.pem" ] && [ -d "$cdn/root" ] || { echo 'prepare the owned CDN CA/layout first' >&2; return 2; }
  [ ! -f "$cdn/serve.pid" ] || { echo 'server receipt exists; inspect/stop that owned server first' >&2; return 2; }
  nohup node "$b/fake-cdn.mjs" serve --root "$cdn/root" --cert "$cdn/ca/leaf.pem" --key "$cdn/ca/leaf.key" \
    --bind "${VM_BIND:-192.168.65.1}" --port 443 --http-port 0 > "$cdn/serve.log" 2>&1 &
  local pid=$!
  sleep 1
  kill -0 "$pid" 2>/dev/null || { scrub < "$cdn/serve.log"; return 1; }
  printf '%s\n' "$pid" > "$cdn/serve.pid"
  ps -p "$pid" -o lstart= -o command= > "$cdn/serve.identity"
  scrub < "$cdn/serve.log"
}
cdn_stop() {
  cdn_owned
  if [ -f "$cdn/serve.pid" ]; then
    local pid current
    pid=$(cat "$cdn/serve.pid")
    [[ "$pid" =~ ^[0-9]+$ ]] || { echo 'invalid server pid receipt' >&2; return 2; }
    current=$(ps -p "$pid" -o lstart= -o command= || true)
    if [ -n "$current" ]; then
      [ "$current" = "$(cat "$cdn/serve.identity")" ] || { echo 'server pid identity changed; leave it alone' >&2; return 2; }
      kill "$pid"
    fi
    rm -f "$cdn/serve.pid" "$cdn/serve.identity"
  fi
}
cdn_status() { push_admin; invoke "$admin" "$(admin_root)" vm-cdn.ps1 Status=true; }
cleanup() {
  local u dir
  u=$(the_user "${1:-}"); require_owner "$u"; dir=$(admin_root)
  invoke "$admin" "$dir" cleanup.ps1 "User=$u" "RunId=$run_id"
  # A failed/partial cleanup retains receipts/passwords for a root-owned recovery.
  mv "$work/users/$u.json" "$work/users/$u.cleaned.json"
  if [ -f "$work/users.txt" ]; then
    grep -v "^$u " "$work/users.txt" > "$work/users.txt.new" || true
    mv "$work/users.txt.new" "$work/users.txt"
    [ -s "$work/users.txt" ] || rm -f "$work/users.txt"
  fi
  preflight
  tools compare-baseline "$work/baseline.json" "$work/preflight.json"
  if ! find "$work/users" -name '*.json' ! -name '*.cleaned.json' -print -quit | grep -q .; then
    vm_ps "$admin" <<PS
\$ErrorActionPreference='Stop'
\$dir=$(ps_quote "$dir")
\$marker=Get-Content -LiteralPath (Join-Path \$dir 'run.json') -Raw | ConvertFrom-Json
if (\$marker.run_id -cne '$run_id' -or (Split-Path -Leaf \$dir) -cne 'harness-desktop-e2e-$run_id') { throw 'admin scratch ownership mismatch; left untouched' }
foreach (\$file in Get-ChildItem -LiteralPath (Join-Path \$dir 'users') -Filter '*.json') {
  \$owner=Get-Content -LiteralPath \$file.FullName -Raw | ConvertFrom-Json
  if (\$owner.cleaned -ne \$true) { throw 'another owned user is not cleaned; keep admin tools/receipts' }
}
Remove-Item -LiteralPath \$dir -Recurse -Force
'owned admin scratch directory removed'
PS
    rm -f "$work/vm-root.txt"
    if [ -f "$cdn/run-id" ] && [ "$(cat "$cdn/run-id")" = "$run_id" ]; then
      cdn_stop
      rm -rf "${cdn:?}/ca"
    fi
  fi
  echo 'Owned user cleanup finished; unrelated machine state is preserved.'
}
command=${1:-}; [ $# -gt 0 ] && shift
case "$command" in
  preflight) preflight ;;
  user-add) user_add "$@" ;;
  push) push "$@" ;;
  driver) driver "$@" ;;
  kilo) kilo "$@" ;;
  session-on) session_on "$@" ;;
  session-off) session_off "$@" ;;
  fetch) fetch "$@" ;;
  put) put "$@" ;;
  put-admin)
    f=${1:?file required}; [ -f "$f" ] || { echo "no file $f" >&2; exit 2; }
    dir=$(admin_root)
    put_files "$admin" "$dir" "$f" ;;
  run|ps)
    script=${1:?script.ps1 required}; shift
    u=$(the_user ''); require_owner "$u"
    [[ "$script" =~ ^[a-z][a-z0-9-]*\.ps1$ ]] || { echo 'invalid tool filename' >&2; exit 2; }
    put_files "$u" e2e "$here/$script"
    if [ "$command" = run ]; then session "$u" "$script" "$@"; else invoke "$u" e2e "$script" "$@"; fi ;;
  admin)
    script=${1:?script.ps1 required}; shift
    [[ "$script" =~ ^[a-z][a-z0-9-]*\.ps1$ ]] || { echo 'invalid tool filename' >&2; exit 2; }
    push_admin
    invoke "$admin" "$(admin_root)" "$script" "$@" ;;
  sh) u=$(the_user ''); require_owner "$u"; vm "$u" "${1:?command required}" ;;
  sh-admin) vm "$admin" "${1:?command required}" ;;
  shot) shot "$@" ;;
  state) u=$(the_user ''); require_owner "$u"; invoke "$u" e2e desktop-state.ps1 "$@" ;;
  logs) u=$(the_user ''); require_owner "$u"; invoke "$u" e2e desktop-logs.ps1 "$@" ;;
  procs) u=$(the_user ''); require_owner "$u"; invoke "$admin" "$(admin_root)" desktop-procs.ps1 "User=$u" "RunId=$run_id" ;;
  variant) tools zip-variant "${1:?kind}" "${2:?zip}" "${3:?version}" --out-dir "$work/zips" ;;
  truncated) tools truncate "${1:?zip}" --out-dir "$work/zips/truncated" ;;
  cdn-ca) cdn_ca ;;
  cdn-stage) cdn_stage "$@" ;;
  cdn-serve) cdn_serve ;;
  cdn-stop) cdn_stop ;;
  cdn-status) cdn_status ;;
  cdn-on|cdn-off) echo 'unavailable: shared-machine hosts/DNS/CA are preserved; root must schedule any separate owned environment transaction' >&2; exit 3 ;;
  stamp) stamp "$@" ;;
  cleanup) cleanup "$@" ;;
  *) sed -n '2,7p' "$0" >&2; exit 2 ;;
esac
