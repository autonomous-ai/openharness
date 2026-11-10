#!/bin/bash
# Starts the agent's browser: Xvnc (X server and VNC in one), openbox, a silent speaker, and Google Chrome on the
# agent's profile. The service reads its exit code: 3 is `profile_unwritable` and 4 is `proxy_failed`, which it does not
# restart.
set -uo pipefail

SCREEN="${SCREEN:-1920x1080}"
ACCEPT_LANG="${ACCEPT_LANG:-en-US}"
PRIMARY_LANG="${ACCEPT_LANG%%,*}"
PROFILE=/var/lib/harness-browser-profile
# C.UTF-8 is the only UTF-8 locale the image has. Chrome on Linux takes its interface language from LANGUAGE,
# and pages read navigator.languages and Accept-Language from --accept-lang.
export DISPLAY=:1 HOME=/home/browser LANG=C.UTF-8 LANGUAGE="${PRIMARY_LANG//-/_}"

# The prior art fell back to a throwaway profile here, which silently loses the login. Fail with a name instead.
if ! touch "$PROFILE/.harness-probe" 2>/dev/null; then echo "profile not writable" >&2; exit 3; fi
# A lock left by an earlier container makes Chrome refuse the profile.
rm -f "$PROFILE/.harness-probe" "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"

# The proxy relay first, so a proxy that cannot be used stops everything before the browser could go out without it.
# It listens only once its probe through the proxy passed (at most 15 s), so no port means exit 4. It stays this
# script's child: a relay that dies ends the container, and pages never fall back to a direct connection.
PROXY_FLAGS=()
if [ "${PROXY:-}" = 1 ]; then
  node /opt/harness-browser/proxy-relay.mjs > /tmp/proxy-relay.log 2>&1 &
  RELAY=$!
  for _ in $(seq 1 100); do
    (exec 3<> /dev/tcp/127.0.0.1/3128) 2> /dev/null && break
    kill -0 "$RELAY" 2> /dev/null || break
    sleep 0.2
  done
  if ! (exec 3<> /dev/tcp/127.0.0.1/3128) 2> /dev/null; then echo "proxy cannot be used" >&2; exit 4; fi
  PROXY_FLAGS=(--proxy-server=http://127.0.0.1:3128 --force-webrtc-ip-handling-policy=disable_non_proxied_udp)
fi

# No VNC password: nothing outside the container can reach port 5900, only `podman exec … socat`.
Xvnc :1 -geometry "$SCREEN" -depth 24 -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared > /tmp/xvnc.log 2>&1 &
XVNC=$!
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done

# Detached in a subshell, so neither is this script's child and neither ending stops the browser. Without a window
# manager a sign-in popup opens undecorated at 0,0 and cannot be moved or closed by hand. openbox runs before the
# browser maps its window, so that window gets X focus: in the spike keys reached nothing until it had it.
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
( pulseaudio --daemonize=yes --exit-idle-time=-1 -n --load=module-native-protocol-unix --load="module-null-sink sink_name=speakers" > /tmp/pulse.log 2>&1 & )
( openbox --startup "touch /tmp/openbox-ready" > /tmp/openbox.log 2>&1 & )
for _ in $(seq 1 50); do [ -e /tmp/openbox-ready ] && break; sleep 0.1; done

# Never headless and never the automation switch: navigator.webdriver stays false. The browser's own sandbox cannot run in an
# unprivileged container; WebGL through SwiftShader, since a browser without WebGL looks automated.
google-chrome-stable --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$PROFILE" \
  --window-position=0,0 --window-size="${SCREEN/x/,}" --no-first-run --no-default-browser-check \
  --no-sandbox --disable-setuid-sandbox --no-zygote --renderer-process-limit=2 \
  --use-angle=swiftshader --enable-unsafe-swiftshader \
  --disable-breakpad --disable-crash-reporter --metrics-recording-only --disable-features=TranslateUI \
  --disable-extensions --disk-cache-size=524288000 --lang="$PRIMARY_LANG" --accept-lang="$ACCEPT_LANG" \
  "${PROXY_FLAGS[@]}" about:blank > /tmp/chrome.log 2>&1 &
BROWSER=$!

# Detached, like openbox: it waits for CDP itself, and its end must not end the browser.
if [ -n "${DEVICE:-}" ]; then ( node /opt/harness-browser/device-inject.mjs > /tmp/device.log 2>&1 & ); fi

# Bash as PID 1 ignores SIGTERM unless trapped: without this, `podman stop` waits its 10 s and kills Chrome before it
# writes the profile, which can lose the login.
trap 'kill -TERM "$BROWSER" "$XVNC" 2>/dev/null; wait "$BROWSER"; exit 0' TERM INT

# Ready is CDP answering and VNC accepting, checked for at most 60 s; the service looks for the marker as long.
for _ in $(seq 1 300); do
  if curl -sf --max-time 1 http://127.0.0.1:9222/json/version > /dev/null && (exec 3<> /dev/tcp/127.0.0.1/5900) 2> /dev/null; then
    touch /tmp/harness-ready
    break
  fi
  sleep 0.2
done

# The container ends when the browser, Xvnc or the relay does, including a person closing Chrome's last window; the
# service restarts it. Plain: with process ids the spike's missed a browser that had already exited, and the container
# stayed up without one.
wait -n
exit $?
