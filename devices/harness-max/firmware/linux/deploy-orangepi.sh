#!/bin/sh
# Builds Harness Max for the Orange Pi 4 Pro's bar on the board itself, installs it and switches the bar to it. Runs on
# the Mac, from any directory.
#
#   deploy-orangepi.sh [--usb | --live | --demo | --story] [--no-build] [ssh-host]
#
# --usb (the default): the bar is a USB device on the board's Type-C port, which the Mac's daemon finds as it finds a
# Harness Max; the cable to the Mac also powers the board. --live: the bar waits for a daemon on TCP port 7531 (on the
# Mac: HARNESS_CABLE_TCP=<board address>:7531), which answers no permission prompt. --demo: the scripted demo daemon
# runs inside the program, no computer needed, and the person drives it. --story: the same demo plays its story by
# itself, in a loop. --no-build switches the bar that is installed to the mode, in seconds.
#
# Board: the ssh-host argument or HARNESS_MAX_BOARD / HARNESS_MAX_SSH_OPTS; when none is set, near-demo's board
# (NEAR_BOARD / NEAR_SSH_OPTS, else ~/.config/near/board.env); otherwise plain `opi`. Nothing about the board is kept in
# the repository. cJSON comes from ESP-IDF, as on the device: CJSON_DIR, else $IDF_PATH or ~/esp/esp-idf-5.5.4.
# The bar's clock shows this computer's time zone (the board keeps UTC); HARNESS_MAX_TZ names another.
#
# The first run asks for the board's sudo password once, to install orangepi/harness-max.service, the USB gadget's
# script and the sudoers rule that lets later runs switch without it. A run that changes the unit or the script asks
# again.
#
# The bar's other programs run under Near's near-app.service, which starts the Flutter bundle ~/near/mode.env names:
# Near (near-demo writes it) or Harness Max Demo V3 (../../flutter/deploy-orangepi.sh writes it). This leaves that file
# and V3's near-voice drop-in alone: harness-max.service conflicts with near-app and near-voice, so starting it stops
# whichever runs, and starting near-app stops it. Back: `near-demo` (Near) or V3's deploy-orangepi.sh (it stops this
# first); on the board `sudo systemctl start near-app` brings back what ~/near/mode.env names.
set -eu
LINUX=$(cd "$(dirname "$0")" && pwd)
DEVICES=$(cd "$LINUX/../../.." && pwd)

usage() {
    echo "usage: deploy-orangepi.sh [--usb | --live | --demo | --story] [--no-build] [ssh-host]"
}

ARGS=--usb
BUILD=1
while [ $# -gt 0 ]; do
    case $1 in
        --usb|--live|--demo|--story) ARGS=$1 ;;
        --no-build) BUILD=0 ;;
        -h|--help) usage; exit 0 ;;
        -*) usage >&2; exit 2 ;;
        *) break ;;
    esac
    shift
done
if [ $# -gt 1 ]; then
    usage >&2
    exit 2
fi

if [ -n "${1:-}${HARNESS_MAX_BOARD:-}" ] || [ -n "${HARNESS_MAX_SSH_OPTS+set}" ]; then
    HOST=${1:-${HARNESS_MAX_BOARD:-opi}}
    OPTS=${HARNESS_MAX_SSH_OPTS:-}
else
    # As near-demo: its variables for this run replace its config file as a whole.
    CONFIG=${NEAR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/near/board.env}
    if [ -z "${NEAR_BOARD:-}" ] && [ -z "${NEAR_SSH_OPTS+set}" ] && [ -f "$CONFIG" ]; then
        . "$CONFIG"
    fi
    HOST=${NEAR_BOARD:-opi}
    OPTS=${NEAR_SSH_OPTS:-}
fi
# The user's options come first: for ssh the first value of an option wins.
SSH="ssh $OPTS -o ConnectTimeout=10"
CJSON=${CJSON_DIR:-${IDF_PATH:-$HOME/esp/esp-idf-5.5.4}/components/json/cJSON}
UNIT_SRC=harness-max/src/devices/harness-max/firmware/linux/orangepi

say() { echo "deploy-orangepi: $*"; }

if [ ! -f "$CJSON/cJSON.c" ]; then
    echo "deploy-orangepi: no cJSON.c in $CJSON: set CJSON_DIR to ESP-IDF's components/json/cJSON" >&2
    exit 1
fi

# board <action> [arg]: runs the board-side script below over ssh, from the home directory.
board() {
    # shellcheck disable=SC2086  # $SSH is a command line on purpose
    $SSH "$HOST" sh -s -- "$@" <<'BOARD'
main() {
    set -eu
    cd
    case $1 in
        build) build ;;
        installed) [ -x harness-max/bin/harness-max ] ;;
        mode) mode "$2" "${3:-}" ;;
        check) check ;;
        switch) switch ;;
    esac
}

build() {
    # The glass height named every time: a build directory from before 480 became the default has 415 in its cache.
    cmake -S harness-max/src/devices/harness-max/firmware/linux -B harness-max/build -DMAX_LINUX_OUTPUT=drm \
        -DMAX_GLASS_H=480 -DCJSON_DIR="$HOME/harness-max/src/cJSON" > /dev/null
    cmake --build harness-max/build -j "$(nproc)" < /dev/null
    ctest --test-dir harness-max/build --output-on-failure < /dev/null
    mkdir -p harness-max/bin
    # A new file renamed over the old one: a running copy keeps its own until the restart.
    install -m 755 harness-max/build/harness-max harness-max/bin/harness-max.new
    mv harness-max/bin/harness-max.new harness-max/bin/harness-max
}

# The unit reads the mode from here (EnvironmentFile=), so switching it needs no sudo.
mode() {
    echo "HARNESS_MAX_ARGS=$1" > harness-max/mode.env
    # The board's system zone is UTC: the bar's clock takes the zone of the computer that deployed it.
    [ -z "$2" ] || echo "TZ=$2" >> harness-max/mode.env
}

# Exit 10 when the unit or the gadget's script is missing or not the one in the sources, the unit from before the
# rename is still there, or switching would need a password.
check() {
    cmp -s harness-max/src/devices/harness-max/firmware/linux/orangepi/harness-max.service \
        /etc/systemd/system/harness-max.service || exit 10
    cmp -s harness-max/src/devices/harness-max/firmware/linux/orangepi/harness-max-usb \
        /usr/local/sbin/harness-max-usb || exit 10
    [ ! -e /etc/systemd/system/harness-max-demo.service ] || exit 10
    sudo -n -l 2>/dev/null < /dev/null | grep -qE "NOPASSWD:.*/usr/bin/systemctl restart harness-max(,|$)" || exit 10
}

switch() {
    t0=$(date +%s)
    sudo -n systemctl restart harness-max < /dev/null
    for _ in $(seq 30); do
        sleep 1
        if journalctl -u harness-max --since "@$t0" --no-pager -o cat < /dev/null | grep -q "app: first frame at"
        then
            journalctl -u harness-max --since "@$t0" --no-pager -o cat < /dev/null \
                | grep -E "board: |drm: |audio: |cable: link up|app: first frame" || true
            return 0
        fi
        systemctl is-active -q harness-max || break
    done
    echo "harness-max shows no first frame; its log:" >&2
    journalctl -u harness-max --since "@$t0" --no-pager -n 40 < /dev/null >&2
    exit 6
}

main "$@"
BOARD
}

say "board $HOST${OPTS:+ ($OPTS)}"
if [ "$BUILD" = 1 ]; then
    say "copying the sources to $HOST:harness-max/src"
    $SSH "$HOST" mkdir -p harness-max/src/devices harness-max/src/cJSON
    # By content, not by time (--checksum, no -t): a file copied takes the board's clock, so make rebuilds what
    # changed even when the board built another tree after these edits were made (that build's objects are newer).
    (
        cd "$DEVICES"
        rsync -rlpR --checksum --delete --exclude __pycache__ --exclude .DS_Store -e "$SSH" \
            harness-max/firmware/sources.cmake harness-max/firmware/main harness-max/firmware/linux \
            harness-pro/firmware/main harness-pro/firmware/scripts/gen_fonts.py harness-pro/firmware/fonts \
            "$HOST:harness-max/src/devices/"
    )
    rsync -rlp --checksum -e "$SSH" "$CJSON/cJSON.c" "$CJSON/cJSON.h" "$HOST:harness-max/src/cJSON/"

    say "building on the board (about two minutes from clean) and running its host tests"
    board build
elif ! board installed; then
    echo "deploy-orangepi: Harness Max is not installed on $HOST: run without --no-build first" >&2
    exit 1
fi
# The bar's clock is the person's: this computer's time zone (HARNESS_MAX_TZ overrides), a zoneinfo name only.
ZONE=${HARNESS_MAX_TZ:-$(readlink /etc/localtime 2>/dev/null | sed -n 's|.*/zoneinfo/||p')}
case $ZONE in
    *[!A-Za-z0-9_+/-]*) ZONE= ;;
esac
board mode "$ARGS" "$ZONE"

set +e
board check
rc=$?
set -e
if [ "$rc" = 10 ]; then
    say "installing the unit, the USB gadget's script and the switching rule: the board's sudo password, once"
    # The unit from before the rename (harness-max-demo) goes, with its rule.
    $SSH -t "$HOST" "sudo install -m 644 $UNIT_SRC/harness-max.service /etc/systemd/system/harness-max.service" \
        "&& sudo install -m 755 $UNIT_SRC/harness-max-usb /usr/local/sbin/harness-max-usb" \
        "&& sudo visudo -cqf $UNIT_SRC/harness-max.sudoers" \
        "&& sudo install -m 440 $UNIT_SRC/harness-max.sudoers /etc/sudoers.d/harness-max" \
        "&& { sudo systemctl stop harness-max-demo 2>/dev/null || true; }" \
        "&& sudo rm -f /etc/systemd/system/harness-max-demo.service /etc/sudoers.d/harness-max-demo" \
        "&& sudo systemctl daemon-reload"
elif [ "$rc" != 0 ]; then
    exit "$rc"
fi

say "switching the bar to Harness Max ($ARGS)"
board switch
say "done: Harness Max ($ARGS) is on $HOST's bar. Back: near-demo for Near, flutter/deploy-orangepi.sh for V3"
case $ARGS in
    --usb) say "the board's USB-C port to the Mac (it powers the board): the daemon there finds the bar" ;;
    --live) say "a daemon on this Mac drives it: HARNESS_CABLE_TCP=<board address>:7531 harness start --restart" ;;
esac
