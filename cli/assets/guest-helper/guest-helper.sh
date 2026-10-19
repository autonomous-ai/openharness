#!/bin/sh
# Harness guest helper: the one privileged step of sharing a machine with a guest
# (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
#
# Installed root-owned at /usr/local/libexec/harness/guest-helper by the owner's one-time admin
# prompt (cli/src/lib/guestHelperInstall.ts), and run by the owner's daemon through
# `sudo -n` (/etc/sudoers.d/harness-guests). A guest's harness runs as an OS user of its own, so
# it can read neither the owner's files nor another guest's.
#
#   ensure <email>                                        create the guest's user, home and workspace
#   run <user> --cwd <dir> [--pass KEY]... [--env KEY=VALUE]... -- <argv>
#                                                         run argv as that user, in <dir>
#   install <user> claude|codex|opencode                  install an engine into the guest's home
#   share <user> [--read DIR]... [--write DIR]...         give the guest exactly these of the owner's folders
#   shared <user>                                         the folders the guest has, one `read|write<TAB>DIR` a line
#   remove <user>                                         delete the user, its processes and its home
#   version                                               this helper's version
#
# Everything a caller passes is validated: users are hg_<12 hex> in the harnessguest group, a cwd
# resolves inside that user's home or a folder shared with it, a shared folder is the owner's own
# (never /, the owner's whole home or a guest's home), and only the keys in GUEST_ENV_KEYS reach the
# guest's process.
# `--pass KEY` hands over the value this helper was started with (the daemon sets it on the tmux
# pane, and the sudoers drop-in keeps exactly these keys): a token on the command line would be
# readable by every account on the machine in `ps`. `--env KEY=VALUE` is for values that are not
# secret.
# HARNESS_GUEST_HELPER_DRY_RUN=1 prints the commands instead of running them (tests); it, and the
# platform, home-root, state and owner-home overrides that go with it, are refused when running as root.
set -eu
# Wherever the caller stood, which a guest (and root's `cd` into a guest's folder) may not be able to read: every
# path here is absolute.
cd /

HELPER_VERSION=2
GROUP=harnessguest
# The variables a guest's harness may be given. Nothing of the owner's reaches it: `sudo -u ... env -i`.
GUEST_ENV_KEYS='TERM COLORTERM LANG ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL HARNESS_RELAY_TOKEN HARNESS_HOOK_TOKEN HARNESS_HOOK_URL HARNESS_AGENT_ID CODEX_HOME'
NODE_DIR=/usr/local/lib/harness/node

die() {
  printf 'guest-helper: %s\n' "$1" >&2
  exit "${2:-2}"
}

DRY=
if [ "${HARNESS_GUEST_HELPER_DRY_RUN:-}" = 1 ]; then
  [ "$(id -u)" != 0 ] || die 'dry run is refused as root'
  DRY=1
fi

PLATFORM=$(uname -s)
if [ -n "$DRY" ] && [ -n "${HARNESS_GUEST_HELPER_PLATFORM:-}" ]; then PLATFORM=$HARNESS_GUEST_HELPER_PLATFORM; fi
case $PLATFORM in
  Darwin) HOME_ROOT=/Users/Shared/HarnessGuests; GUEST_SHELL=/bin/zsh ;;
  Linux) HOME_ROOT=/home/harness-guests; GUEST_SHELL=/bin/bash ;;
  *) die "unsupported platform: $PLATFORM" ;;
esac
if [ -n "$DRY" ] && [ -n "${HARNESS_GUEST_HELPER_DRY_HOME_ROOT:-}" ]; then HOME_ROOT=$HARNESS_GUEST_HELPER_DRY_HOME_ROOT; fi
# Which of the owner's folders each guest has (`share`), one root-owned file per guest. The ACLs are the
# grant; this is what `run` and the next `share` read, so a share that has not changed changes nothing.
case $PLATFORM in
  Darwin) STATE_DIR=/var/db/harness-guests ;;
  Linux) STATE_DIR=/var/lib/harness-guests ;;
esac
if [ -n "$DRY" ] && [ -n "${HARNESS_GUEST_HELPER_DRY_STATE_DIR:-}" ]; then STATE_DIR=$HARNESS_GUEST_HELPER_DRY_STATE_DIR; fi
TAB=$(printf '\t')

# One shell word, quoted, for the dry-run transcript.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Runs its arguments, or (dry run) prints them on one line after `+ `.
do_cmd() {
  if [ -n "$DRY" ]; then
    printf '+'
    for word do printf ' %s' "$(quote "$word")"; done
    printf '\n'
    return 0
  fi
  "$@"
}

# Like do_cmd, for the last command: replaces this process.
exec_cmd() {
  if [ -n "$DRY" ]; then
    do_cmd "$@"
    exit 0
  fi
  exec "$@"
}

valid_user() {
  printf '%s' "$1" | grep -Eq '^hg_[0-9a-f]{12}$'
}

sha256_hex() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -c1-64
  else
    printf '%s' "$1" | sha256sum | cut -c1-64
  fi
}

# The owner this helper acts for: the account sudo ran it from (the dry run's own account).
owner_name() {
  if [ -n "$DRY" ]; then id -un; return; fi
  owner=${SUDO_USER:-}
  printf '%s' "$owner" | grep -Eq '^[A-Za-z_][A-Za-z0-9_.-]{0,31}$' || die 'run through sudo by the owner'
  [ "$owner" != root ] || die 'run through sudo by the owner'
  valid_user "$owner" && die 'a guest cannot run the guest helper'
  printf '%s' "$owner"
}

# The guest's existence and group, checked before anything runs as them. A dry run takes a home
# under its home root as the user existing.
require_guest() {
  valid_user "$1" || die "not a guest user: $1"
  if [ -n "$DRY" ]; then
    [ -d "$HOME_ROOT/$1" ] || die "no such guest: $1" 3
    return 0
  fi
  id "$1" >/dev/null 2>&1 || die "no such guest: $1" 3
  [ "$(id -gn "$1")" = "$GROUP" ] || die "not in $GROUP: $1"
}

env_allowed() {
  key=$1
  case $key in
    LC_*) printf '%s' "$key" | grep -Eq '^LC_[A-Z_]+$'; return ;;
  esac
  for allowed in $GUEST_ENV_KEYS; do
    [ "$key" = "$allowed" ] && return 0
  done
  return 1
}

# The first free id at or above 600 among the given dscl listing's numbers.
free_id() {
  used=$1
  candidate=600
  while printf '%s\n' "$used" | grep -qx "$candidate"; do candidate=$((candidate + 1)); done
  printf '%s' "$candidate"
}

ensure_group_darwin() {
  if [ -z "$DRY" ] && dscl . -read "/Groups/$GROUP" PrimaryGroupID >/dev/null 2>&1; then
    dscl . -read "/Groups/$GROUP" PrimaryGroupID | awk '{print $2}'
    return
  fi
  if [ -n "$DRY" ]; then gid=600; else gid=$(free_id "$(dscl . -list /Groups PrimaryGroupID | awk '{print $2}')"); fi
  do_cmd dscl . -create "/Groups/$GROUP" >&2
  do_cmd dscl . -create "/Groups/$GROUP" PrimaryGroupID "$gid" >&2
  do_cmd dscl . -create "/Groups/$GROUP" RealName 'Harness guests' >&2
  do_cmd dscl . -create "/Groups/$GROUP" Password '*' >&2
  printf '%s' "$gid"
}

# The owner may read a guest's files (it is the owner's machine, and the daemon lists a guest's
# workspace for them); other guests may not.
grant_owner_read() {
  owner=$1 path=$2
  if [ "$PLATFORM" = Darwin ]; then
    do_cmd chmod +a "$owner allow list,search,readattr,readextattr,readsecurity,read,file_inherit,directory_inherit" "$path"
  elif command -v setfacl >/dev/null 2>&1 || [ -n "$DRY" ]; then
    do_cmd setfacl -m "u:$owner:rX" "$path"
    do_cmd setfacl -d -m "u:$owner:rX" "$path"
  else
    printf 'guest-helper: setfacl is missing: the owner cannot read %s\n' "$path" >&2
  fi
}

# The owner's home: never shared whole, since its dotfiles hold every sign-in on the machine.
owner_home() {
  if [ -n "$DRY" ]; then printf '%s' "${HARNESS_GUEST_HELPER_DRY_OWNER_HOME:-$HOME}"; return; fi
  if [ "$PLATFORM" = Darwin ]; then
    dscl . -read "/Users/$1" NFSHomeDirectory | awk '{print $2}'
  else
    getent passwd "$1" | cut -d: -f6
  fi
}

# The account that owns [path], read the way this system's stat reads it.
path_owner() {
  case $(uname -s) in
    Darwin | *BSD) stat -f %Su "$1" ;;
    *) stat -c %U "$1" ;;
  esac
}

# A folder the owner may share, resolved; or the reason it may not be.
shareable() {
  dir=$1
  case $dir in /*) ;; *) die "not an absolute path: $dir" ;; esac
  case $dir in *"$TAB"* | *'
'*) die "not a folder that can be shared: $dir" ;; esac
  real=$(cd "$dir" 2>/dev/null && pwd -P) || die "no such folder: $dir"
  [ "$real" != / ] || die 'not a folder that can be shared: /'
  owner=$(owner_name)
  home=$(owner_home "$owner")
  real_home=$(cd "$home" 2>/dev/null && pwd -P) || real_home=$home
  [ "$real" != "$real_home" ] || die "the owner's whole home cannot be shared: choose a folder in it"
  real_root=$(cd "$HOME_ROOT" 2>/dev/null && pwd -P) || real_root=$HOME_ROOT
  case $real in "$real_root" | "$real_root"/*) die "a guest's home cannot be shared: $dir" ;; esac
  [ "$(path_owner "$real")" = "$owner" ] || die "not the owner's folder: $dir"
  printf '%s' "$real"
}

FOLDER_READ='list,search,readattr,readextattr,readsecurity,read,execute'
FOLDER_WRITE='write,append,add_file,add_subdirectory,delete_child,delete,writeattr,writeextattr'

# The macOS entry a guest has on a shared folder and everything in it, now and created later.
folder_ace() {
  if [ "$2" = write ]; then
    printf '%s allow %s,%s,file_inherit,directory_inherit' "$1" "$FOLDER_READ" "$FOLDER_WRITE"
  else
    printf '%s allow %s,file_inherit,directory_inherit' "$1" "$FOLDER_READ"
  fi
}

grant_folder() {
  user=$1 mode=$2 dir=$3
  if [ "$PLATFORM" = Darwin ]; then
    do_cmd chmod -R +a "$(folder_ace "$user" "$mode")" "$dir"
  else
    perm=rX
    [ "$mode" = write ] && perm=rwX
    do_cmd setfacl -R -m "u:$user:$perm" "$dir"
    do_cmd find "$dir" -type d -exec setfacl -d -m "u:$user:$perm" {} +
  fi
}

# Taken back, as it was given: on macOS `chmod -a` also takes the entries files made since inherited.
revoke_folder() {
  user=$1 mode=$2 dir=$3
  [ -n "$DRY" ] || [ -d "$dir" ] || return 0
  if [ "$PLATFORM" = Darwin ]; then
    do_cmd chmod -R -a "$(folder_ace "$user" "$mode")" "$dir" || true
  else
    do_cmd setfacl -R -x "u:$user" "$dir" || true
    do_cmd find "$dir" -type d -exec setfacl -d -x "u:$user" {} + || true
  fi
}

# Whether every account may pass through [dir] already (its mode's last digit is odd).
open_to_all() {
  case $(uname -s) in
    Darwin | *BSD) bits=$(stat -f %Lp "$1") ;;
    *) bits=$(stat -c %a "$1") ;;
  esac
  [ $(( ${bits#"${bits%?}"} % 2 )) = 1 ]
}

# The folders above each shared one that the guest must pass through (and only pass through: no listing) to
# reach it: not those anyone may pass through already (/, /Users, …), nor those shared themselves.
ancestors() {
  printf '%s\n' "$1" | while IFS="$TAB" read -r mode path; do
    [ -n "$path" ] || continue
    d=$(dirname "$path")
    while [ "$d" != / ]; do
      if ! printf '%s\n' "$1" | cut -f2 | grep -Fxq "$d" && ! open_to_all "$d"; then printf '%s\n' "$d"; fi
      d=$(dirname "$d")
    done
  done | sort -u
}

grant_search() {
  if [ "$PLATFORM" = Darwin ]; then do_cmd chmod +a "$1 allow search" "$2"; else do_cmd setfacl -m "u:$1:x" "$2"; fi
}

revoke_search() {
  [ -n "$DRY" ] || [ -d "$2" ] || return 0
  if [ "$PLATFORM" = Darwin ]; then do_cmd chmod -a "$1 allow search" "$2" || true; else do_cmd setfacl -x "u:$1" "$2" || true; fi
}

# What [user] has now: `mode<TAB>path` lines.
shares_of() {
  [ -f "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1" || true
}

# Gives [user] exactly the folders in [want] (`mode<TAB>path` lines): what changed, and nothing else.
apply_shares() {
  user=$1 want=$2
  have=$(shares_of "$user")
  printf '%s\n' "$have" | while IFS="$TAB" read -r mode path; do
    [ -n "$path" ] || continue
    printf '%s\n' "$want" | grep -Fxq "$mode$TAB$path" || revoke_folder "$user" "$mode" "$path"
  done
  printf '%s\n' "$want" | while IFS="$TAB" read -r mode path; do
    [ -n "$path" ] || continue
    printf '%s\n' "$have" | grep -Fxq "$mode$TAB$path" || grant_folder "$user" "$mode" "$path"
  done
  before=$(ancestors "$have")
  after=$(ancestors "$want")
  printf '%s\n' "$after" | while read -r dir; do
    [ -n "$dir" ] || continue
    printf '%s\n' "$before" | grep -Fxq "$dir" || grant_search "$user" "$dir"
  done
  printf '%s\n' "$before" | while read -r dir; do
    [ -n "$dir" ] || continue
    printf '%s\n' "$after" | grep -Fxq "$dir" || revoke_search "$user" "$dir"
  done
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [ -n "$want" ]; then
    printf '%s\n' "$want" > "$STATE_DIR/$user.tmp"
    chmod 600 "$STATE_DIR/$user.tmp"
    mv "$STATE_DIR/$user.tmp" "$STATE_DIR/$user"
  else
    rm -f "$STATE_DIR/$user"
  fi
}

cmd_share() {
  [ $# -ge 1 ] || die 'usage: share <user> [--read DIR]... [--write DIR]...'
  user=$1
  shift
  require_guest "$user"
  want=''
  while [ $# -gt 0 ]; do
    case $1 in
      --read | --write)
        [ $# -ge 2 ] || die 'usage: share <user> [--read DIR]... [--write DIR]...'
        mode=${1#--}
        path=$(shareable "$2")
        if [ -n "$want" ] && printf '%s\n' "$want" | cut -f2 | grep -Fxq "$path"; then die "shared twice: $path"; fi
        want="$want${want:+
}$mode$TAB$path"
        shift 2
        ;;
      *) die "unexpected argument: $1" ;;
    esac
  done
  apply_shares "$user" "$want"
}

cmd_shared() {
  [ $# -eq 1 ] || die 'usage: shared <user>'
  require_guest "$1"
  shares_of "$1"
}

# Whether [dir] is in one of the folders shared with [user].
in_shared() {
  [ -f "$STATE_DIR/$1" ] || return 1
  while IFS="$TAB" read -r mode path; do
    case $2 in "$path" | "$path"/*) return 0 ;; esac
  done < "$STATE_DIR/$1"
  return 1
}

cmd_ensure() {
  [ $# -eq 1 ] || die 'usage: ensure <email>'
  email=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  [ "${#email}" -le 254 ] || die 'not an email address'
  printf '%s' "$email" | grep -Eq "^[a-z0-9._%+'-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.[a-z]{2,}\$" \
    || die 'not an email address'
  user="hg_$(sha256_hex "$email" | cut -c1-12)"
  home="$HOME_ROOT/$user"
  owner=$(owner_name)
  exists=
  if [ -n "$DRY" ]; then
    [ -d "$home" ] && exists=1
  elif id "$user" >/dev/null 2>&1; then
    exists=1
  fi
  if [ -z "$exists" ]; then
    do_cmd mkdir -p "$HOME_ROOT" >&2
    do_cmd chmod 755 "$HOME_ROOT" >&2
    if [ "$PLATFORM" = Darwin ]; then
      gid=$(ensure_group_darwin)
      if [ -n "$DRY" ]; then uid=600; else uid=$(free_id "$(dscl . -list /Users UniqueID | awk '{print $2}')"); fi
      do_cmd dscl . -create "/Users/$user" >&2
      do_cmd dscl . -create "/Users/$user" UniqueID "$uid" >&2
      do_cmd dscl . -create "/Users/$user" PrimaryGroupID "$gid" >&2
      do_cmd dscl . -create "/Users/$user" UserShell "$GUEST_SHELL" >&2
      do_cmd dscl . -create "/Users/$user" RealName "Harness guest $email" >&2
      do_cmd dscl . -create "/Users/$user" NFSHomeDirectory "$home" >&2
      do_cmd dscl . -create "/Users/$user" IsHidden 1 >&2
      do_cmd dscl . -create "/Users/$user" Password '*' >&2
      do_cmd dscl . -append "/Groups/$GROUP" GroupMembership "$user" >&2
      do_cmd mkdir -p "$home" >&2
    else
      if [ -n "$DRY" ] || ! getent group "$GROUP" >/dev/null 2>&1; then do_cmd groupadd -r -f "$GROUP" >&2; fi
      do_cmd useradd -r -m -d "$home" -g "$GROUP" -s "$GUEST_SHELL" -c "Harness guest $email" "$user" >&2
    fi
    do_cmd chown "$user:$GROUP" "$home" >&2
    do_cmd chmod 700 "$home" >&2
    grant_owner_read "$owner" "$home" >&2
  fi
  if [ -n "$DRY" ] || [ ! -d "$home/work" ]; then
    do_cmd mkdir -p "$home/work" >&2
    do_cmd chown "$user:$GROUP" "$home/work" >&2
    do_cmd chmod 700 "$home/work" >&2
  fi
  printf '{"user":"%s","home":"%s","workspace":"%s"}\n' "$user" "$home" "$home/work"
}

cmd_run() {
  [ $# -ge 1 ] || die 'usage: run <user> --cwd <dir> [--pass KEY]... [--env KEY=VALUE]... -- <argv>'
  user=$1
  shift
  require_guest "$user"
  home="$HOME_ROOT/$user"

  # First pass: validate the options and find the command.
  cwd='' expect='' seen='' argc=0
  for arg do
    if [ -n "$seen" ]; then argc=$((argc + 1)); continue; fi
    case $expect in
      cwd) cwd=$arg; expect=; continue ;;
      env)
        key=${arg%%=*}
        [ "$key" != "$arg" ] || die "not KEY=VALUE: $arg"
        env_allowed "$key" || die "not allowed for a guest: $key"
        expect=
        continue
        ;;
      pass)
        env_allowed "$arg" || die "not allowed for a guest: $arg"
        expect=
        continue
        ;;
    esac
    case $arg in
      --cwd) expect='cwd' ;;
      --env) expect='env' ;;
      --pass) expect='pass' ;;
      --) seen=1 ;;
      *) die "unexpected argument: $arg" ;;
    esac
  done
  [ -z "$expect" ] && [ -n "$seen" ] || die 'usage: run <user> --cwd <dir> [--pass KEY]... [--env KEY=VALUE]... -- <argv>'
  [ "$argc" -gt 0 ] || die 'nothing to run'
  [ -n "$cwd" ] || die 'a --cwd is required'
  case $cwd in /*) ;; *) die "not an absolute path: $cwd" ;; esac
  real_home=$(cd "$home" && pwd -P) || die "no home for $user"
  real_cwd=$(cd "$cwd" 2>/dev/null && pwd -P) || die "no such folder: $cwd"
  case $real_cwd in
    "$real_home" | "$real_home"/*) ;;
    *) in_shared "$user" "$real_cwd" || die "outside the guest's home and shared folders: $cwd" ;;
  esac

  # Second pass: rebuild the arguments as the env pairs, the cd trampoline, then the command.
  count=$# expect='' seen=''
  # shellcheck disable=SC2016 # the trampoline's "$1" and "$@" are the guest shell's, not this one's
  for arg do
    if [ -n "$seen" ]; then set -- "$@" "$arg"; continue; fi
    case $expect in
      cwd) expect=; continue ;;
      env) set -- "$@" "$arg"; expect=; continue ;;
      pass)
        # (An unset key is left out, not passed empty.)
        if value=$(printenv "$arg"); then set -- "$@" "$arg=$value"; fi
        expect=
        continue
        ;;
    esac
    case $arg in
      --cwd) expect='cwd' ;;
      --env) expect='env' ;;
      --pass) expect='pass' ;;
      --) seen=1; set -- "$@" /bin/sh -c 'cd "$1" || exit 1; shift; exec "$@"' harness-guest "$real_cwd" ;;
    esac
  done
  shift "$count"
  exec_cmd sudo -u "$user" -H env -i "HOME=$home" "USER=$user" "LOGNAME=$user" "SHELL=$GUEST_SHELL" \
    "PATH=$home/.local/bin:$home/.opencode/bin:$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

cmd_install() {
  [ $# -eq 2 ] || die 'usage: install <user> claude|codex|opencode'
  user=$1 engine=$2
  require_guest "$user"
  home="$HOME_ROOT/$user"
  path="$home/.local/bin:$home/.opencode/bin:$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin"
  printf 'Installing %s for %s\n' "$engine" "$user"
  case $engine in
    claude)
      do_cmd sudo -u "$user" -H env -i "HOME=$home" "USER=$user" "PATH=$path" /bin/sh -c 'curl -fsSL https://claude.ai/install.sh | bash'
      ;;
    codex)
      [ -n "$DRY" ] || [ -x "$NODE_DIR/bin/npm" ] || die "no Node runtime at $NODE_DIR: install the guest helper again" 4
      do_cmd sudo -u "$user" -H env -i "HOME=$home" "USER=$user" "PATH=$path" "$NODE_DIR/bin/npm" install -g @openai/codex --prefix "$home/.local"
      ;;
    opencode)
      do_cmd sudo -u "$user" -H env -i "HOME=$home" "USER=$user" "PATH=$path" /bin/sh -c \
        "curl -fsSL https://opencode.ai/install | bash || '$NODE_DIR/bin/npm' install -g opencode-ai --prefix \"\$HOME/.local\""
      ;;
    *) die "not an engine a guest can install: $engine" ;;
  esac
  printf 'Installed %s for %s\n' "$engine" "$user"
}

cmd_remove() {
  [ $# -eq 1 ] || die 'usage: remove <user>'
  user=$1
  require_guest "$user"
  home="$HOME_ROOT/$user"
  do_cmd pkill -KILL -u "$user" || true
  # Its shares go first: an entry naming a deleted user would name whoever gets its id next.
  apply_shares "$user" ''
  if [ "$PLATFORM" = Darwin ]; then
    do_cmd dscl . -delete "/Groups/$GROUP" GroupMembership "$user" || true
    do_cmd dscl . -delete "/Users/$user"
    do_cmd rm -rf "$home"
    if [ -z "$DRY" ] && ! dscl . -list /Users | grep -Eq '^hg_[0-9a-f]{12}$'; then
      do_cmd dscl . -delete "/Groups/$GROUP" || true
    fi
  else
    do_cmd userdel -r "$user" || true
    do_cmd rm -rf "$home"
    if [ -z "$DRY" ] && ! getent passwd | cut -d: -f1 | grep -Eq '^hg_[0-9a-f]{12}$'; then
      do_cmd groupdel "$GROUP" || true
    fi
  fi
}

[ $# -ge 1 ] || die 'usage: guest-helper ensure|run|install|share|shared|remove|version ...'
command=$1
shift
case $command in
  ensure) cmd_ensure "$@" ;;
  run) cmd_run "$@" ;;
  install) cmd_install "$@" ;;
  share) cmd_share "$@" ;;
  shared) cmd_shared "$@" ;;
  remove) cmd_remove "$@" ;;
  version) printf '%s\n' "$HELPER_VERSION" ;;
  *) die "unknown command: $command" ;;
esac
