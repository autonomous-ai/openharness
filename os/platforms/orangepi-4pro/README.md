# Orange Pi 4 Pro (Debian 12) image work

A Harness SD image for the Orange Pi 4 Pro (Allwinner A733, aarch64), built on Orange Pi's
official **Debian 12 server** image. It boots straight into the same session as the PC image:
autologin on tty1, labwc, `hn` full screen in foot, Chromium on Super+b, the agent runtime as
a lingering user service. The board can also be used over SSH alone.

This is private platform work, **not a public Harness release**. No installer metadata or
update feed is generated, and the board keeps Debian's own system updates.

## What differs from the PC image

| | PC image | Orange Pi 4 Pro |
|---|---|---|
| Base | Arch Linux, LTS kernel | Orange Pi Debian 12, vendor kernel 5.15 |
| Compositor | labwc 0.20.2 on Arch's wlroots 0.20 | the same labwc source and patch, built with wlroots 0.20.2 and newer Wayland libraries into `/opt/harness-wl` |
| Rendering | GPU | CPU (`WLR_RENDERER=pixman`): the PowerVR GPU has no open driver |
| OpenCode | Arch's 2.x at `/usr/bin/opencode` | the official 1.x ARM release pinned in `os/packaging/fedora/opencode.lock.json`, bundled as the Fedora package does (`opencode_payload.py`: `/usr/lib/harness-opencode`, `/usr/bin/opencode`, where first use starts it); the skel config is restated in OpenCode 1's `permission` form |
| Claude Code | installed by hn when first chosen | preinstalled with hn's recipe (`npm install -g @anthropic-ai/claude-code`); version recorded in `/etc/harness-image.json` |
| System profile | `arch` | `debian`: `hn-os` and `harness install/upgrade/rollback` refuse PC system operations, as on Fedora |
| Screen lock | gtklock | not available on Debian 12 (Super+l and the idle lock do nothing yet) |

The session files come from `os/tools/build-package.py`'s `stage()`, so the board runs the PC
package's tree. `install-session.sh` removes only the Arch-specific parts: pacman hooks, the
installer, system updates, PC drivers and boot splash.

## Build

The build has two phases, so a code change does not repeat the slow, rarely changing part:

| Phase | Script | Contents | Rebuilt when |
|---|---|---|---|
| 1. Base | `build-compositor.sh`, `build-base.sh` | Orange Pi's image grown by 3 GB, Debian's session packages, Node 22, the compositor in `/opt/harness-wl` | its key changes (`base-key.sh`: the base image's checksum and the phase-1 scripts, labwc source and patch) |
| 2. Harness | `build-runtime.sh`, `build-image.sh` | the session tree, runtime and agents on a copy of the base | every build |

With Docker, on any host:

```sh
bash os/platforms/orangepi-4pro/build-docker.sh \
  Orangepi4pro_1.0.6_debian_bookworm_server_linux5.15.147.img out/
```

`--base` runs only phase 1 (forcing a rebuild); `--harness` runs only phase 2 and needs the
base for the current key. It runs in a privileged arm64 Debian 12 container from the committed HEAD, and
writes `harness-orangepi4pro-debian12-<commit>.img.xz` with its `.sha256`. Named volumes
(`harness-orangepi4pro-*`) keep the base image under its key, the compositor build under its
own key, and cargo's target directory and npm's cache for incremental phase-2 builds. An
x86-64 host emulates arm64 with QEMU, so a first build there takes hours; an arm64 host
builds natively.

Or natively on the board, running Orange Pi's Debian 12 server image, with a clean checkout:

```sh
sudo apt install build-essential musl-tools cmake ninja-build pkg-config bison python3-venv parted \
  libffi-dev libexpat1-dev libxml2-dev libudev-dev libmtdev-dev libevdev-dev libseat-dev \
  libegl-dev libgles-dev libgbm-dev hwdata libglib2.0-dev libcairo2-dev libpango1.0-dev \
  libpng-dev librsvg2-dev libpciaccess-dev
# Node 22 (NodeSource) and Rust with the aarch64-unknown-linux-musl target, then:
HARNESS_OS_RUNTIME_DIR=os/work/runtime-arm bash os/tools/build-runtime.sh
sudo install -d -o "$USER" /opt/harness-wl
bash os/platforms/orangepi-4pro/build-compositor.sh
# Phase 1 once (again only when base-key.sh prints a new key), phase 2 per code change:
sudo bash os/platforms/orangepi-4pro/build-base.sh \
  Orangepi4pro_1.0.6_debian_bookworm_server_linux5.15.147.img harness-base.img
sudo bash os/platforms/orangepi-4pro/build-image.sh harness-base.img os/work/runtime-arm \
  harness-orangepi4pro.img
```

The base image is Orange Pi's download (Orange Pi 4 Pro → Official Images → Debian); check it
against its `.sha` file first. Orange Pi's own Debian 12 boots on the 4 GB and 6 GB boards;
the community Armbian image did not boot a 6 GB board.

## First boot

Write the image with balenaEtcher. The account is Orange Pi's default `orangepi` with password
`orangepi`; change it with `passwd`. Wi-Fi: Super+w, or `sudo nmcli --ask device wifi connect
NAME`. Sign in with `harness login --qr` and scan from Harness on a phone.

## Checked on hardware

Orange Pi 4 Pro over HDMI (1920×1080): autologin into labwc and `hn`, the daemon after a
reboot, Super+n (via `screen-action`) opening New Harness, `hn-browser` opening Chromium maximized, OpenCode answering on Muse Spark 1.3 Free,
`harness login --qr` rendering on the console. Other keyboard shortcuts, audio, suspend and
the screen lock remain unverified.

The vendor kernel has no `CONFIG_PROC_CHILDREN`, so `screen-action` (every Super shortcut that
reaches hn) falls back to scanning `/proc` when `/proc/PID/task/TID/children` is missing.
