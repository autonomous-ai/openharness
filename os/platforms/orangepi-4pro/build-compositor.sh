#!/usr/bin/env bash
# Build the Harness OS compositor (os/packaging/labwc) for Debian 12 on aarch64.
# Debian 12 ships wlroots 0.15 and no labwc, so wlroots 0.20 and the newer libraries it needs
# are built into a private prefix. Debian's own libraries are left untouched.
# Run natively on the board as an ordinary user; PREFIX must already be writable:
#   sudo install -d -o "$USER" /opt/harness-wl
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
PREFIX=${HARNESS_WL_PREFIX:-/opt/harness-wl}
WORK=${HARNESS_WL_WORK:-$HOME/.cache/harness-wl}
[[ $(uname -m) == aarch64 ]] || { echo 'Build natively on aarch64.' >&2; exit 1; }
[[ -w $PREFIX ]] || { echo "Make $PREFIX writable first: sudo install -d -o \"\$USER\" $PREFIX" >&2; exit 1; }
mkdir -p "$WORK"
cd "$WORK"
# Debian 12's meson is older than wlroots requires.
[[ -x venv/bin/meson ]] || { python3 -m venv venv && venv/bin/pip -q install 'meson>=1.3'; }
LIBDIR=$PREFIX/lib/aarch64-linux-gnu
export PKG_CONFIG_PATH=$LIBDIR/pkgconfig:$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig
export PATH=$PREFIX/bin:$WORK/venv/bin:$PATH
export LDFLAGS="-Wl,-rpath,$LIBDIR"

fetch() {  # directory url
    [[ -n $(ls -A "$1" 2>/dev/null) ]] && return
    mkdir -p "$1"
    curl -fsSL --retry 3 --retry-all-errors -o "$1.tar" "$2"
    tar xf "$1.tar" --strip-components=1 -C "$1"
    rm "$1.tar"
}
build() {  # directory meson-options...
    local name=$1; shift
    [[ -f .done-$name ]] && return
    echo "== $name"
    rm -rf "$name/build"
    { meson setup "$name/build" "$name" --prefix="$PREFIX" --buildtype=release -Dwerror=false "$@" &&
      ninja -C "$name/build" && ninja -C "$name/build" install; } >"$name.log" 2>&1 || { tail -30 "$name.log"; exit 1; }
    touch ".done-$name"
}

FD=https://gitlab.freedesktop.org
fetch wayland           $FD/wayland/wayland/-/archive/1.24.0/wayland-1.24.0.tar.gz
fetch wayland-protocols $FD/wayland/wayland-protocols/-/archive/1.47/wayland-protocols-1.47.tar.gz
fetch libdrm            $FD/mesa/libdrm/-/archive/libdrm-2.4.131/libdrm-libdrm-2.4.131.tar.gz
fetch pixman            $FD/pixman/pixman/-/archive/pixman-0.46.4/pixman-pixman-0.46.4.tar.gz
fetch libxkbcommon      https://github.com/xkbcommon/libxkbcommon/archive/refs/tags/xkbcommon-1.11.0.tar.gz
fetch libdisplay-info   $FD/emersion/libdisplay-info/-/releases/0.3.0/downloads/libdisplay-info-0.3.0.tar.xz
fetch libsfdo           $FD/vyivel/libsfdo/-/archive/v0.1.4/libsfdo-v0.1.4.tar.gz
fetch libinput          $FD/libinput/libinput/-/archive/1.29.1/libinput-1.29.1.tar.gz
fetch wlroots           $FD/wlroots/wlroots/-/archive/0.20.2/wlroots-0.20.2.tar.gz
# labwc itself: the exact source and patch the PC compositor uses.
fetch labwc "$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['url'])" "$SOURCE/os/packaging/labwc/source.json")"
if [[ ! -f .patched-labwc ]]; then
    patch -d labwc -p1 < "$SOURCE/os/packaging/labwc/session-lock-presentation.patch"
    touch .patched-labwc
fi

build wayland -Ddocumentation=false -Dtests=false -Ddtd_validation=false
build wayland-protocols -Dtests=false
build libdrm -Dtests=false -Dman-pages=disabled -Dvalgrind=disabled -Dcairo-tests=disabled \
    -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled -Dnouveau=disabled -Dvmwgfx=disabled
build pixman -Dtests=disabled -Ddemos=disabled -Dgtk=disabled -Dlibpng=disabled
build libxkbcommon -Denable-docs=false -Denable-x11=false -Denable-tools=false -Denable-wayland=false \
    -Dxkb-config-root=/usr/share/X11/xkb -Dx-locale-root=/usr/share/X11/locale
build libdisplay-info
build libsfdo -Dexamples=false -Dtests=false
build libinput -Dlibwacom=false -Ddebug-gui=false -Dtests=false -Ddocumentation=false
build wlroots -Dxwayland=disabled -Dexamples=false -Drenderers=gles2 -Dbackends=drm,libinput \
    -Dallocators=gbm -Dcolor-management=disabled -Dlibliftoff=disabled
# labwc's install also writes a systemd target outside the prefix; the session does not use it.
if [[ ! -f .done-labwc ]]; then
    echo "== labwc"
    rm -rf labwc/build
    { meson setup labwc/build labwc --prefix="$PREFIX" --buildtype=release --wrap-mode=nofallback -Dwerror=false \
        -Dxwayland=disabled -Dman-pages=disabled -Dsvg=enabled -Dnls=disabled &&
      ninja -C labwc/build; } >labwc.log 2>&1 || { tail -30 labwc.log; exit 1; }
    install -Dm755 labwc/build/labwc "$PREFIX/bin/labwc"
    touch .done-labwc
fi
"$PREFIX/bin/labwc" --version
! ldd "$PREFIX/bin/labwc" | grep 'not found'
