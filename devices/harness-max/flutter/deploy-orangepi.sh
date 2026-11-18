#!/bin/sh
# Builds Harness Max Demo V3 (Flutter) for the Orange Pi 4 Pro's bar, installs it beside Near's bundles and switches
# the bar to it. Runs on the Mac, from any directory.
#
#   deploy-orangepi.sh [--demo | --story | --usb | --tcp | --fixture] [--no-build] [ssh-host]
#
# --demo (the default): the scripted computer runs inside the app, and the person drives it: it opens all quiet on
# Ambient, whose first tap opens Apps; nothing happens by itself, and each case comes from talking to an agent. --story: the same computer plays max_demo.c's story by itself, in a loop. --usb / --tcp: a real daemon on the cable (see
# lib/link/cable/). --fixture: a still page from the mockup's data (HARNESS_MAX_FIXTURE_APP=harness for the Harness
# ring). --no-build installs the bundle built last.
#
# The bar runs under Near's near-app service, which starts the bundle that ~/near/mode.env names (NEAR_BUNDLE) with
# Near's patched flutter-pi; this script writes that file. Back to Near: `near-demo` on the Mac (it rewrites the file).
# The C build (harness-max.service) is stopped first: the two cannot share the glass.
#
# Board: the ssh-host argument or HARNESS_MAX_BOARD / HARNESS_MAX_SSH_OPTS; when none is set, near-demo's board
# (NEAR_BOARD / NEAR_SSH_OPTS, else ~/.config/near/board.env); otherwise plain `opi`. Nothing about the board is kept in
# the repository.
set -eu
APP=$(cd "$(dirname "$0")" && pwd)

usage() {
    echo "usage: deploy-orangepi.sh [--demo | --story | --usb | --tcp | --fixture] [--no-build] [ssh-host]"
}

MODE=demo
DEMO=manual
BUILD=1
while [ $# -gt 0 ]; do
    case $1 in
        --demo|--usb|--tcp|--fixture) MODE=${1#--} ;;
        --story) MODE=demo; DEMO=story ;;
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

BUNDLE=$APP/build/flutter-pi/aarch64-generic
if [ "$BUILD" = 1 ]; then
    TOOL=${FLUTTERPI_TOOL:-}
    if [ -z "$TOOL" ]; then
        if command -v flutterpi_tool >/dev/null 2>&1; then TOOL=flutterpi_tool; else TOOL=$HOME/.pub-cache/bin/flutterpi_tool; fi
    fi
    (cd "$APP" && "$TOOL" build --arch=arm64 --release)
fi
if [ ! -f "$BUNDLE/app.so" ]; then
    echo "no bundle at $BUNDLE: build it first (drop --no-build)" >&2
    exit 1
fi

# Once per board (asks its sudo password): Near's voice service keeps the mic open for its wake word, so it stays down
# while mode.env names this bundle; and the rules that let this script stop it and raise the USB gadget unasked.
if ! $SSH "$HOST" "test -f /etc/systemd/system/near-voice.service.d/harness-max-v3.conf && sudo -n -l /usr/local/sbin/harness-max-usb >/dev/null 2>&1"; then
    $SSH "$HOST" "cat > /tmp/harness-max-v3-setup.sh" <<'EOF'
set -eu
mkdir -p /etc/systemd/system/near-voice.service.d
cat > /etc/systemd/system/near-voice.service.d/harness-max-v3.conf <<'UNIT'
# Installed by Harness Max's flutter/deploy-orangepi.sh. Harness Max V3 records through its own arecord, and this service
# holds the mic for its wake word, so it does not start while near-app runs V3 (mode.env names near/app-max).
[Service]
ExecCondition=/bin/sh -c '! grep -qs "^NEAR_BUNDLE=.*/near/app-max$" /home/orangepi/near/mode.env'
UNIT
cat > /tmp/harness-max-v3.sudoers <<'RULE'
# Lets Harness Max's flutter/deploy-orangepi.sh put V3 on the bar without a password: Near's voice service off and on,
# and the USB gadget (CDC-ACM) up and down for the cable. Installed as /etc/sudoers.d/harness-max-v3 (mode 440).
orangepi ALL=(root) NOPASSWD: /usr/bin/systemctl stop near-voice, /usr/bin/systemctl start near-voice, /usr/local/sbin/harness-max-usb
RULE
visudo -cf /tmp/harness-max-v3.sudoers
install -m 440 /tmp/harness-max-v3.sudoers /etc/sudoers.d/harness-max-v3
rm -f /tmp/harness-max-v3.sudoers
systemctl daemon-reload
EOF
    echo "First V3 deploy on this board: the board's sudo password, once"
    $SSH -t "$HOST" "sudo sh /tmp/harness-max-v3-setup.sh; rm -f /tmp/harness-max-v3-setup.sh"
fi

# Near's flutter-pi is patched for this board; the bundle's own one is replaced by it after the copy.
rsync -az --delete -e "$SSH" "$BUNDLE/" "$HOST:near/app-max/"
FIXTURE_APP=${HARNESS_MAX_FIXTURE_APP:-orca}
$SSH "$HOST" sh -s "$MODE" "$FIXTURE_APP" "$DEMO" <<'EOF'
set -eu
MODE=$1
FIXTURE_APP=$2
DEMO=$3
if [ -x "$HOME/near/app/flutter-pi" ]; then cp "$HOME/near/app/flutter-pi" "$HOME/near/app-max/flutter-pi"; fi
cat > "$HOME/near/mode.env.new" <<ENV
# Written by Harness Max's flutter/deploy-orangepi.sh: near-app runs Harness Max Demo V3. near-demo rewrites this file.
NEAR_BUNDLE=$HOME/near/app-max
HARNESS_MAX_MODE=$MODE
HARNESS_MAX_DEMO=$DEMO
HARNESS_MAX_FIXTURE_APP=$FIXTURE_APP
ENV
mv "$HOME/near/mode.env.new" "$HOME/near/mode.env"
sudo -n systemctl stop harness-max 2>/dev/null || true
sudo -n systemctl stop near-voice
# The cable's USB side: the board a CDC-ACM device on its Type-C port, as the C build's harness-max.service does.
if [ "$MODE" = usb ]; then sudo -n /usr/local/sbin/harness-max-usb --usb; fi
sudo -n systemctl restart near-app
sleep 4
systemctl is-active near-app
EOF
if [ "$MODE" = demo ]; then echo "Harness Max Demo V3 (demo, $DEMO) is on the bar"; else echo "Harness Max Demo V3 ($MODE) is on the bar"; fi
