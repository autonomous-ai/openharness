#!/bin/sh
# Rebuild from the corresponding source shipped with Harness (GPL-2.0-only).
# Use an x86-64 Arch build environment at the snapshot in source.json. Install
# base-devel labwc meson cmocka wayland-protocols glib2-devel xorg-xwayland python.
# Run this script in this source directory; it never installs into the system.
set -eu
test ! -e rebuild
mkdir rebuild
tar -xzf source.tar.gz -C rebuild
cd rebuild/labwc-*
patch --batch --fuzz=0 -p1 -i ../../session-lock-presentation.patch
cp ../../lock_presentation_policy.c t/harness-lock-presentation.c
cat >> t/meson.build <<'EOF'
test('harness_lock_presentation', executable('test_harness_lock_presentation',
  sources: 'harness-lock-presentation.c', include_directories: [labwc_inc],
  dependencies: labwc_deps,
  c_args: ['-UNDEBUG', '-ffunction-sections', '-fdata-sections'],
  link_args: ['-Wl,--gc-sections']), is_parallel: false)
EOF
export GIT_CEILING_DIRECTORIES="$(cd .. && pwd)"
meson setup build --prefix=/usr --buildtype=release --wrap-mode=nodownload \
    -Dtest=enabled -Dman-pages=disabled -Dxwayland=enabled \
    -Dlabnag=disabled -Dsystemd-session=disabled
meson compile -C build -j 2
meson test -C build --print-errorlogs
strip --strip-unneeded build/labwc
