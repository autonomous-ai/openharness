#!/bin/bash
# Starts the agent's browser: Xvnc (X server and VNC in one), openbox, a silent speaker, and Google Chrome on the
# agent's profile. The service reads its exit code: 3 is `profile_unwritable`, which it does not restart.
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

# No VNC password: nothing outside the container can reach port 5900, only `podman exec … socat`.
Xvnc :1 -geometry "$SCREEN" -depth 24 -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared > /tmp/xvnc.log 2>&1 &
XVNC=$!
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done

# Detached in a subshell, so neither is this script's child and neither ending stops the browser. Without a window
# manager a sign-in popup opens undecorated at 0,0 and cannot be moved or closed by hand.
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
( pulseaudio --daemonize=yes --exit-idle-time=-1 -n --load=module-native-protocol-unix --load="module-null-sink sink_name=speakers" > /tmp/pulse.log 2>&1 & )
( openbox > /tmp/openbox.log 2>&1 & )

# Never headless and never the automation switch: navigator.webdriver stays false. The browser's own sandbox cannot run in an
# unprivileged container; WebGL through SwiftShader, since a browser without WebGL looks automated.
google-chrome-stable --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$PROFILE" \
  --window-position=0,0 --window-size="${SCREEN/x/,}" --no-first-run --no-default-browser-check \
  --no-sandbox --disable-setuid-sandbox --no-zygote --renderer-process-limit=2 \
  --use-angle=swiftshader --enable-unsafe-swiftshader \
  --disable-breakpad --disable-crash-reporter --metrics-recording-only --disable-features=TranslateUI \
  --disable-extensions --disk-cache-size=524288000 --lang="$PRIMARY_LANG" --accept-lang="$ACCEPT_LANG" \
  about:blank > /tmp/chrome.log 2>&1 &
BROWSER=$!

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

# The container ends when the browser or Xvnc does, including a person closing Chrome's last window; the service
# restarts it.
wait -n "$XVNC" "$BROWSER"
exit $?
