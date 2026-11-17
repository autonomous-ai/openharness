#!/bin/sh
# Builds Harness Max for the Orange Pi 4 Pro's bar on the board itself, installs it and switches the bar to it. Runs on
# the Mac, from any directory.
#
#   deploy-orangepi.sh [--demo | --live] [ssh-host]
#
# --demo (the default): the scripted demo daemon runs inside the program. --live: the bar waits for a real daemon on
# TCP port 7531 (on the Mac: HARNESS_CABLE_TCP=<board address>:7531).
#
# Board: the ssh-host argument or HARNESS_MAX_BOARD / HARNESS_MAX_SSH_OPTS; when none is set, near-demo's board
# (NEAR_BOARD / NEAR_SSH_OPTS, else ~/.config/near/board.env); otherwise plain `opi`. Nothing about the board is kept in
# the repository. cJSON comes from ESP-IDF, as on the device: CJSON_DIR, else $IDF_PATH or ~/esp/esp-idf-5.5.4.
#
# The first run asks for the board's sudo password once, to install orangepi/harness-max-demo.service and the sudoers
# rule that lets later runs switch without it. A run that changes the unit asks again.
#
# Back to Near: `near-demo` on the Mac, or on the board `sudo systemctl start near-app` (each stops the other).
set -eu
LINUX=$(cd "$(dirname "$0")" && pwd)
DEVICES=$(cd "$LINUX/../../.." && pwd)

usage() {
    echo "usage: deploy-orangepi.sh [--demo | --live] [ssh-host]"
}

ARGS=--demo
case ${1:-} in
    --demo) shift ;;
    --live) ARGS=--live; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
esac
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
        build) build "$2" ;;
        check) check ;;
        switch) switch ;;
    esac
}

build() {
    cmake -S harness-max/src/devices/harness-max/firmware/linux -B harness-max/build -DMAX_LINUX_OUTPUT=drm \
        -DCJSON_DIR="$HOME/harness-max/src/cJSON" > /dev/null
    cmake --build harness-max/build -j "$(nproc)" < /dev/null
    ctest --test-dir harness-max/build --output-on-failure < /dev/null
    mkdir -p harness-max/bin
    # A new file renamed over the old one: a running copy keeps its own until the restart.
    install -m 755 harness-max/build/harness-max harness-max/bin/harness-max.new
    mv harness-max/bin/harness-max.new harness-max/bin/harness-max
    # The unit reads the mode from here (EnvironmentFile=), so switching it needs no sudo.
    if [ "$1" = --demo ]; then
        rm -f harness-max/mode.env
    else
        echo "HARNESS_MAX_ARGS=$1" > harness-max/mode.env
    fi
}

# Exit 10 when the unit is missing or not the one in the sources, or switching would need a password.
check() {
    cmp -s harness-max/src/devices/harness-max/firmware/linux/orangepi/harness-max-demo.service \
        /etc/systemd/system/harness-max-demo.service || exit 10
    sudo -n -l 2>/dev/null < /dev/null | grep -q "NOPASSWD:.*/usr/bin/systemctl restart harness-max-demo" || exit 10
}

switch() {
    t0=$(date +%s)
    sudo -n systemctl restart harness-max-demo < /dev/null
    for _ in $(seq 30); do
        sleep 1
        if journalctl -u harness-max-demo --since "@$t0" --no-pager -o cat < /dev/null | grep -q "app: first frame at"
        then
            journalctl -u harness-max-demo --since "@$t0" --no-pager -o cat < /dev/null \
                | grep -E "board: |drm: |cable: link up|app: first frame" || true
            return 0
        fi
        systemctl is-active -q harness-max-demo || break
    done
    echo "harness-max-demo shows no first frame; its log:" >&2
    journalctl -u harness-max-demo --since "@$t0" --no-pager -n 40 < /dev/null >&2
    exit 6
}

main "$@"
BOARD
}

say "board $HOST${OPTS:+ ($OPTS)}"
say "copying the sources to $HOST:harness-max/src"
$SSH "$HOST" mkdir -p harness-max/src/devices harness-max/src/cJSON
(
    cd "$DEVICES"
    rsync -aR --delete --exclude __pycache__ --exclude .DS_Store -e "$SSH" \
        harness-max/firmware/sources.cmake harness-max/firmware/main harness-max/firmware/linux \
        harness-pro/firmware/main harness-pro/firmware/scripts/gen_fonts.py harness-pro/firmware/fonts \
        "$HOST:harness-max/src/devices/"
)
rsync -a -e "$SSH" "$CJSON/cJSON.c" "$CJSON/cJSON.h" "$HOST:harness-max/src/cJSON/"

say "building on the board (about two minutes from clean) and running its host tests"
board build "$ARGS"

set +e
board check
rc=$?
set -e
if [ "$rc" = 10 ]; then
    say "installing the unit and the switching rule: the board's sudo password, once"
    $SSH -t "$HOST" "sudo install -m 644 $UNIT_SRC/harness-max-demo.service /etc/systemd/system/harness-max-demo.service" \
        "&& sudo visudo -cqf $UNIT_SRC/harness-max-demo.sudoers" \
        "&& sudo install -m 440 $UNIT_SRC/harness-max-demo.sudoers /etc/sudoers.d/harness-max-demo" \
        "&& sudo systemctl daemon-reload"
elif [ "$rc" != 0 ]; then
    exit "$rc"
fi

say "switching the bar to Harness Max ($ARGS)"
board switch
say "done: Harness Max ($ARGS) is on $HOST's bar. Back to Near: near-demo (on the board: sudo systemctl start near-app)"
if [ "$ARGS" = --live ]; then
    say "a daemon on this Mac drives it with HARNESS_CABLE_TCP=<board address>:7531"
fi
