# Login environment for the OS surface and ordinary terminal panes.
export PATH="$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"
export BROWSER=hn-browser
if [ -t 0 ] && [ "$(tty)" = /dev/tty1 ] && [ "$(id -u)" != 0 ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    exec /usr/lib/harness-os/session
fi
