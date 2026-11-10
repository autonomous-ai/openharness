/**
 * The root scripts that remove an old Harness Team account from a Mac and from Linux (./remove.ts runs them once,
 * behind the system's administrator prompt). They are the removal `harness team remove` ran until the command went
 * (anh Dee, 2026-11-10); the owner then asked for every old account to be removed, with the person's approval.
 *
 * Rules every line follows:
 * - Every value is checked against a strict pattern first (./layout.ts) and goes into the script single-quoted.
 * - The account goes first, before anything that cannot be undone. When the system keeps it, the script ends with
 *   [REMOVE_REFUSED] and nothing else has changed, so a second run, once the person has deleted the account in the
 *   system's own settings, finishes the rest.
 * - A home that belongs to anyone but the Team account, or to an account that no longer exists, is never deleted.
 */
import { basename } from 'node:path'
import { TEAM_CONFIG_FILES, checkPath, checkUser } from './layout.js'

/** POSIX single quotes: the one quoting with no special characters inside. */
export function sh(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** The exit status of a removal that deleted nothing because the system kept the account. */
export const REMOVE_REFUSED = 9

/** A file setup left in the owner's home, readable by everyone, to prove the home's own mode kept it from the account. */
export const SENTINEL_NAME = '.harness-team-privacy'

/** Where setup put what it made on a Mac. */
export const MAC_TEAM = {
  label: 'ai.autonomous.harness.team',
  plist: '/Library/LaunchDaemons/ai.autonomous.harness.team.plist',
  statusDir: '/Library/Application Support/Harness/Team',
  sharedDir: '/Library/Application Support/Harness',
  sharedMark: '/Library/Application Support/Harness/.made-by-harness-team-setup',
} as const

/** Where setup put what it made on Linux. */
export const LINUX_TEAM = {
  unitName: 'harness-team.service',
  unit: '/etc/systemd/system/harness-team.service',
  statusDir: '/var/lib/harness/team',
  sharedDir: '/etc/harness',
  sharedMark: '/etc/harness/.made-by-harness-team-setup',
  relayDir: (owner: string) => `/var/lib/harness/team-relay-${owner}`,
} as const

export interface RemoveScriptInput {
  /** The Team account and its home, as the root-owned config names them (./config.ts). */
  user: string
  home: string
  /** The computer's owner, and their home, which holds the sentinel. */
  owner: string
  ownerHome: string
}

export function buildRemoveScript(input: RemoveScriptInput): string {
  const user = checkUser(input.user, 'team account')
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  return [
    '#!/bin/sh',
    '# Harness Team account removal (cli/src/team/removeScript.ts), run once as root behind the macOS administrator prompt.',
    '# It leaves the owner\'s home folder private, as setup made it.',
    '#',
    '# The account goes first, before anything that cannot be undone. macOS 26 deletes an account only for an app the',
    '# person allowed to administer the computer, and may refuse the administrator prompt (eDSPermissionError). When it',
    '# refuses, the team daemon runs again and nothing else has changed.',
    'set -eu',
    // A tool ahead of the system's in PATH would run as root, or a GNU stat would hand pkill a wrong user id (security review 2 of #2765).
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'cd /',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_HOME=${sh(home)}`,
    `LABEL=${sh(MAC_TEAM.label)}`,
    `PLIST=${sh(MAC_TEAM.plist)}`,
    `CONFIG=${sh(TEAM_CONFIG_FILES.darwin)}`,
    `STATUS_DIR=${sh(MAC_TEAM.statusDir)}`,
    `SHARED=${sh(MAC_TEAM.sharedDir)}`,
    `SHARED_MARK=${sh(MAC_TEAM.sharedMark)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    // What Users & Groups leaves when the account is deleted there with "Don't change the home folder".
    `DELETED_HOME=${sh(`${home} (Deleted)`)}`,
    '[ "$(id -u)" = 0 ] || die "run as root"',
    'exists=',
    'team_uid=',
    'if dscl . -read "/Users/$TEAM" UniqueID >/dev/null 2>&1; then',
    '  exists=1',
    "  existing=$(dscl . -read \"/Users/$TEAM\" NFSHomeDirectory 2>/dev/null | awk '{print $2}')",
    '  [ "$existing" = "$TEAM_HOME" ] || die "the account $TEAM is not the Harness Team account (its home is $existing); nothing was removed" 4',
    '  team_uid=$(id -u "$TEAM")',
    'fi',
    // A home left by a team account deleted earlier (in Users & Groups, say) is owned by a bare user id; anyone else's is
    // not ours to delete. That id has no account, so whatever still runs under it was the team account's. By number:
    // `stat -f %Su` prints such an owner as "(600)" on macOS 26.
    'for left in "$TEAM_HOME" "$DELETED_HOME"; do',
    '  [ -e "$left" ] && [ ! -L "$left" ] || continue',
    '  holder_uid=$(stat -f %u "$left")',
    '  holder=$(id -un "$holder_uid" 2>/dev/null) || holder=',
    '  case $holder in',
    '    "$TEAM"|root) ;;',
    '    \'\') [ -n "$team_uid" ] || team_uid=$holder_uid ;;',
    '    *) die "$left belongs to $holder; nothing was removed" 4 ;;',
    '  esac',
    'done',
    '',
    '# 1. The team daemon stops, so it starts nothing while the account goes.',
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    '',
    '# 2. The account. When macOS keeps it, the daemon starts again, as setup starts it, and nothing else was changed.',
    'if [ -n "$exists" ]; then',
    '  if ! why=$(dscl . -delete "/Users/$TEAM" 2>&1); then',
    '    why=$(printf \'%s\\n\' "$why" | tail -n 1)',
    '    if [ -f "$PLIST" ]; then',
    '      tries=0',
    '      until launchctl bootstrap system "$PLIST" >/dev/null 2>&1; do',
    '        tries=$((tries + 1)); [ "$tries" -lt 5 ] || break',
    '        launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true; sleep 1',
    '      done',
    '    fi',
    '    case $why in *eDSPermissionError*) why="macOS did not allow it (eDSPermissionError)" ;; esac',
    `    die "could not delete the account $TEAM: $why. Nothing was removed" ${REMOVE_REFUSED}`,
    '  fi',
    '  say "deleted the account $TEAM"',
    'fi',
    '',
    '# 3. What it left: its processes, its daemon\'s definition, its home, what setup made and the privacy sentinel.',
    'if [ -n "$team_uid" ] && [ "$team_uid" -gt 500 ]; then pkill -KILL -u "$team_uid" >/dev/null 2>&1 || true; sleep 1; fi',
    'rm -f "$PLIST"',
    'rm -rf "$TEAM_HOME" "$STATUS_DIR"',
    '[ ! -e "$DELETED_HOME" ] || [ -L "$DELETED_HOME" ] || rm -rf "$DELETED_HOME"',
    'rm -f "$CONFIG" "$SENTINEL"',
    // The shared folder, only when setup made it and nothing else has been put in it since.
    `if [ -f "$SHARED_MARK" ] && [ ! -L "$SHARED" ] && [ -z "$(ls -A "$SHARED" | grep -vx ${sh(basename(MAC_TEAM.sharedMark))} || true)" ]; then`,
    '  rm -f "$SHARED_MARK"',
    '  rmdir "$SHARED" 2>/dev/null || true',
    'fi',
    'say "removed the Harness Team account, its home folder and its daemon"',
    '',
  ].join('\n')
}

export function buildLinuxRemoveScript(input: RemoveScriptInput): string {
  const user = checkUser(input.user, 'team account')
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  const owner = checkUser(input.owner, 'owner account')
  const state = LINUX_TEAM.statusDir.slice(0, LINUX_TEAM.statusDir.lastIndexOf('/'))
  const mark = basename(LINUX_TEAM.sharedMark)
  /** A folder setup made, removed only when nothing but its mark is left in it. */
  const removeMarked = (dir: string, markVar: string) => [
    `if [ -f "$${markVar}" ] && [ ! -L "$${dir}" ] && [ -z "$(ls -A "$${dir}" | grep -vx ${sh(mark)} || true)" ]; then`,
    `  rm -f "$${markVar}"`,
    `  rmdir "$${dir}" 2>/dev/null || true`,
    'fi',
  ]
  return [
    '#!/bin/sh',
    '# Harness Team account removal for Linux (cli/src/team/removeScript.ts), run once as root through pkexec.',
    '# It leaves the owner\'s home folder private, as setup made it.',
    '#',
    '# The daemon and every process of the account stop first: userdel refuses a user that still runs something. When it',
    '# refuses all the same, the team daemon runs again and nothing else has changed.',
    'set -eu',
    'cd /',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    // useradd made the account's own group, of its name.
    `TEAM_GROUP=${sh(user)}`,
    `TEAM_HOME=${sh(home)}`,
    `UNIT_NAME=${sh(LINUX_TEAM.unitName)}`,
    `UNIT=${sh(LINUX_TEAM.unit)}`,
    `CONFIG=${sh(TEAM_CONFIG_FILES.linux)}`,
    `STATUS_DIR=${sh(LINUX_TEAM.statusDir)}`,
    `RELAY_DIR=${sh(LINUX_TEAM.relayDir(owner))}`,
    `SHARED=${sh(LINUX_TEAM.sharedDir)}`,
    `SHARED_MARK=${sh(LINUX_TEAM.sharedMark)}`,
    `STATE=${sh(state)}`,
    `STATE_MARK=${sh(`${state}/${mark}`)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    '[ "$(id -u)" = 0 ] || die "run as root"',
    'exists=',
    'team_uid=',
    'if entry=$(getent passwd "$TEAM"); then',
    '  exists=1',
    '  existing=$(printf \'%s\\n\' "$entry" | cut -d: -f6)',
    '  [ "$existing" = "$TEAM_HOME" ] || die "the account $TEAM is not the Harness Team account (its home is $existing); nothing was removed" 4',
    '  team_uid=$(id -u "$TEAM")',
    'fi',
    // A home left by a team account deleted earlier is owned by a bare user id; anyone else's is not ours to delete.
    'if [ -e "$TEAM_HOME" ] && [ ! -L "$TEAM_HOME" ]; then',
    '  holder_uid=$(stat -c %u "$TEAM_HOME")',
    '  holder=$(id -un "$holder_uid" 2>/dev/null) || holder=',
    '  case $holder in',
    '    "$TEAM"|root) ;;',
    '    \'\') [ -n "$team_uid" ] || team_uid=$holder_uid ;;',
    '    *) die "$TEAM_HOME belongs to $holder; nothing was removed" 4 ;;',
    '  esac',
    'fi',
    '',
    '# 1. The team daemon stops and stays off, so it starts nothing while the account goes.',
    'systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true',
    '',
    '# 2. Everything the account still runs.',
    'if [ -n "$team_uid" ] && [ "$team_uid" -ge 1000 ]; then pkill -KILL -u "$team_uid" >/dev/null 2>&1 || true; sleep 1; fi',
    '',
    '# 3. The account and its home. When userdel keeps the user, the daemon starts again, as setup starts it.',
    'if [ -n "$exists" ]; then',
    // userdel -r exits 12 when it removed the user but not all of its home: that is not a refusal.
    '  if ! why=$(userdel -r "$TEAM" 2>&1) && getent passwd "$TEAM" >/dev/null; then',
    '    why=$(printf \'%s\\n\' "$why" | tail -n 1)',
    '    if [ -f "$UNIT" ]; then',
    '      tries=0',
    '      until systemctl enable --now "$UNIT_NAME" >/dev/null 2>&1; do',
    '        tries=$((tries + 1)); [ "$tries" -lt 5 ] || break',
    '        systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true; sleep 1',
    '      done',
    '    fi',
    `    die "could not delete the account $TEAM: $why. Nothing was removed" ${REMOVE_REFUSED}`,
    '  fi',
    '  say "deleted the account $TEAM"',
    'fi',
    // useradd made the group for the account alone; userdel removes it on most systems, and here on the others.
    'if getent group "$TEAM_GROUP" >/dev/null && [ -z "$(getent group "$TEAM_GROUP" | cut -d: -f4)" ]; then groupdel "$TEAM_GROUP" >/dev/null 2>&1 || true; fi',
    '',
    '# 4. What it left: its home when the account was deleted elsewhere, its unit, what setup made and the sentinel.',
    'rm -f "$UNIT"',
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    'systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true',
    'rm -rf "$TEAM_HOME" "$STATUS_DIR" "$RELAY_DIR"',
    'rm -f "$CONFIG" "$SENTINEL"',
    // The shared folders, only when setup made them and nothing else has been put in them since.
    ...removeMarked('SHARED', 'SHARED_MARK'),
    ...removeMarked('STATE', 'STATE_MARK'),
    'say "removed the Harness Team account, its home folder and its daemon"',
    '',
  ].join('\n')
}
