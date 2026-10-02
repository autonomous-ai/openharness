# Programmer OS

Boot into `hn`. Talk to agents in their own terminal panes. Review their diffs,
tests and output there. The browser opens only when requested. Development
toolchains are installed by the agents as needed.

**Development status:** image construction and machine testing are in progress.
Source configuration and unit tests alone do not establish that an ISO boots or
is safe to recommend for installation. See the release's validation receipt.

## Design

- Arch Linux, glibc, systemd and the LTS kernel. User space is rolling; LTS here
  describes the kernel, not the distribution. Builds use a complete dated Arch
  repository snapshot and record the installed package inventory.
- labwc supplies Wayland, focus, input and display management. No panel, launcher,
  wallpaper process, desktop icons, or notification daemon.
- One fullscreen foot window displays the existing Rust `hn`. Agent/runtime
  processes are supervised separately from that window. The image does not fork
  foot or add a second graphical Harness client.
  If graphics initialization fails, the login session falls back to hn on the
  Linux console so drivers can be repaired without a working compositor.
- Chromium is installed but does not start at boot. `Super+B` opens/focuses it or
  returns to hn. `Super+Enter` focuses hn; `Alt+Tab` switches available windows.
  Browser sandboxing and hardware acceleration remain enabled.
- `Ctrl+B`, then `N` opens an existing hn agent/terminal entry. The normal session
  has no interactive parent shell to exit into. Shells remain available in hn panes. This is
  an interface policy, not confinement against someone with shell/admin access.
- NetworkManager, fonts, clipboard, audio, locking, firmware and zram provide
  the support needed by actual development machines. No IDEs, model weights,
  CUDA SDK, containers, databases or language stacks are preinstalled.
- Btrfs root, separate home and snapshot subvolumes, BIOS and UEFI boot, and
  optional LUKS2 encryption (default on). The installer extracts its immutable
  payload locally instead of downloading and installing each package again.

The full installation owns the hardware, first boot, authentication, runtime,
updates and recovery. These are completion gates, not optional follow-up work.

## Build

The GitHub **Programmer OS** workflow builds on an isolated x86 Linux runner.
Local equivalent on an x86 Arch build host:

```sh
sudo pacman -Syu archiso python git rustup musl nodejs-lts-jod npm
rustup default stable
rustup target add x86_64-unknown-linux-musl
make -C os check
make -C os runtime
make -C os build
```

Use a fresh `HARNESS_OS_BUILD_DIR` for every build. Outputs are in `os/dist`:
the hybrid USB ISO, its SHA-256 checksum, the package inventory, and a manifest
with the clean source commit, runtime toolchains and hashes. Commit source changes
before building; published client binaries do not contain the OS session mode.
The build independently reads the ISO's SquashFS payload and compares its runtime,
kernel, configuration and package inventory with the source. `inspection.json`
records that check; machine validation is still required afterward.
There is no publication to
the normal Harness CLI/TUI update channels.

## Try and install

After an image has passed the VM gates, write the **whole ISO** to a USB stick
using an image writer such as Etcher, boot the USB, and try hn before installing.
The initial image targets x86-64 PCs with Secure Boot disabled. TPM can remain
enabled. A 32-bit-only ThinkPad cannot boot this image.

Inside hn, open a Terminal pane and run:

```sh
sudo hn-os install
```

The installer lists disks, asks for an account/password and encryption choice,
and requires the exact target disk name before erasing it. It currently performs
a **whole-disk installation**; it does not resize another operating system.
The live USB and disks with mounted filesystems are rejected. Installation itself
works offline; agent installation and cloud authentication require networking.

Remove the USB after shutting down. An encrypted install asks for its disk
password and then enters hn. An unencrypted install requires console login.
`Super+L` locks the session. Recovery remains possible through another console
or the USB; the machine's owner retains normal Linux administrator control.

## Updates and recovery

`sudo hn-os update` saves a checkpoint and upgrades the whole system to yesterday's
complete Arch repository snapshot. Use `--snapshot YYYY/MM/DD` to choose a complete
snapshot at or after the current one. Packages remain signed by Arch; the OS does not
run an updater or download anything on a schedule.
The bundled hn and OS integration are pinned to this preview's source build;
this command updates Arch packages, not the bundled Harness runtime.

Every package transaction also saves a checkpoint. It contains Btrfs root and a
checksummed copy of `/boot`, so the package database, kernel, modules and initramfs
can be recovered together. Home and projects stay outside root rollback.
Checkpoints consume disk space and are retained until explicitly removed.

To recover, boot the USB, inspect `lsblk -f`, and run `sudo hn-os recover ROOT_DEVICE`
to list checkpoints. For an encrypted disk, first unlock it with
`sudo cryptsetup open ROOT_PARTITION hn-recovery`, then use
`/dev/mapper/hn-recovery` as `ROOT_DEVICE`. Run
`sudo hn-os recover ROOT_DEVICE CHECKPOINT` to restore. Recovery requires the
installed root and boot filesystems to be unmounted. The previous root is retained.
This initial recovery path requires the USB; it is not an automatic boot fallback.

## NVIDIA and local AI

The small base image carries Intel/AMD graphics and Linux firmware. NVIDIA's
compute driver is installed on demand with
`sudo pacman -S --needed nvidia-open-lts nvidia-utils`, followed by
`sudo mkinitcpio -P` and a reboot. These are the matching packages for the included
LTS kernel and supported Turing-or-newer GPUs, including the intended RTX targets.
See [Arch's package](https://archlinux.org/packages/extra/x86_64/nvidia-open-lts/)
and [NVIDIA's supported GPUs](https://github.com/NVIDIA/open-gpu-kernel-modules).
No NVIDIA hardware validation has been performed yet. Verify `nvidia-smi` and the
actual AI workload on each physical machine before treating it as supported.

Agent executables are installed through hn's existing engine install recipes
when selected. Accounts, API credentials and model downloads are supplied by the
owner. System guidance for agents lives at `/usr/share/harness-os/AGENTS.md`.

## Validation plan

1. Installer input/disk safety tests, shell/Python/XML/JSON syntax, workflow lint.
2. Build a real ISO; check checksums, package inventory and configuration in its
   actual SquashFS filesystem.
3. Boot the ISO under BIOS and UEFI; verify hn is visible and Chromium is absent
   until requested. Test browser toggle, clipboard, terminal input, reconnect,
   last-pane behavior and frontend restart without terminating agent work.
4. Install from the offline image to disposable VM disks, encrypted and plain;
   reboot from each disk, verify accounts/permissions/bootloaders and defaults.
5. Exercise real agent executables, dependency installation, parallel panes and
   ordinary development work. Report credential-dependent rows separately.
6. Exercise update failure and rollback with matching kernel/initramfs/modules,
   keeping user projects outside root rollback.
7. Record installation duration, kernel-to-hn readiness, idle RAM/CPU and image
   and installed sizes. VM firmware time is not physical power-on time.
8. Physical old ThinkPad and RTX GPU acceptance remains a separate evidence row.
   No VM test proves Wi-Fi, suspend, firmware or NVIDIA on the user's hardware.

No benchmark or hardware support claim is considered measured before these
checks produce artifacts. Build, validation, publication and waiting are tracked
separately in `progress.json`.
