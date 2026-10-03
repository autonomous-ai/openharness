# Programmer OS

Boot into `hn`. Talk to agents in their own terminal panes. Review their diffs,
tests and output there. The browser opens only when requested. Development
toolchains are installed by the agents as needed.

**Preview 2:** the keyboard installer passes real BIOS/plain and UEFI/encrypted
installation, reboot, update retry and recovery checks. The form has a disk picker,
encryption on by default, password twice, and a separate erase confirmation.
The installed account is `me@harness`.

[Download preview 2](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.2)
· [Mac → USB → ThinkPad installation guide](INSTALL.md)
· [Standalone HTML/CSS landing page](site/README.md)

Physical ThinkPad, Wi-Fi, suspend and NVIDIA hardware remain unverified.
The release's `validation.json` identifies the exact image and coverage. Real
OpenCode project and DSH exercises were validated separately on preview 1.

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

For the full installation experience in a Mac window, install QEMU with
`brew install qemu`, download the ISO and its `manifest.json` into `os/dist/`,
then run from the repository root:

```sh
python3 os/tools/run-vm.py
```

The VM has 2 GiB RAM and its own sparse 24 GiB virtual disk in
`os/work/interactive-vm/`. That disk consumes only the space actually written.
Budget 6–8 GB total for the ISO, QEMU and an initial installation; agent downloads
and projects add more. Run the same installer described below, selecting
`/dev/vda`. After shutdown, use `python3 os/tools/run-vm.py --installed` to boot
from the virtual disk. The left Command key supplies the Super shortcuts.
Apple Silicon uses x86 emulation: this tests the PC image's behavior, while boot
and application timings need separate native x86 measurements.
The current Mac check is partial: the installed VM rendered a project in Chromium,
and the refreshed hn/CLI binaries match the published hashes, but subsequent
background reboot checks missed readiness deadlines with guest soft-lockup reports.
Use the native x86 VM results for the preview's measured performance. Mac emulation
is not yet a reliably validated demonstration environment.

After an image has passed the VM gates, write the **whole ISO** to a USB stick
using an image writer such as Etcher, boot the USB, and try hn before installing.
The initial image targets x86-64 PCs with Secure Boot disabled. TPM can remain
enabled. A 32-bit-only ThinkPad cannot boot this image.

Inside hn, open a Terminal pane and run:

```sh
sudo hn-os install
```

The installer uses `me@harness`. Select the disk from a keyboard list;
the encryption checkbox sits directly underneath and starts checked. Enter your
password twice, then choose **Continue** to review the disk. **Back** is selected
initially; choose **Erase and install** to begin. Selecting a disk or continuing
does not write to it. Tab moves between fields, Space toggles encryption, and
Esc returns from the picker or confirmation (or cancels from the main form).
No username, computer-name or disk-path typing is needed.
The installer performs a **whole-disk installation**;
it does not resize another operating system.
The live USB and disks with mounted filesystems are rejected. Installation itself
works offline; agent installation and cloud authentication require networking.

You can uncheck encryption for a disposable VM or unattended machine.
`sudo hn-os install --no-encryption` starts the form with that choice unchecked.
`--username NAME` and `--hostname NAME` override the defaults. With an unattended
`--config` file, set `username`, `hostname` and `encrypt` there instead.

Remove the USB after shutting down. An encrypted install asks for its disk
password and then enters hn. An unencrypted install requires console login.
The installation password initially protects both the account and, when enabled,
the encrypted disk. There is no first-boot account wizard.
`Super+L` locks the session. Recovery remains possible through another console
or the USB; the machine's owner retains normal Linux administrator control.

## Updates and recovery

`sudo hn-os update` saves a checkpoint and upgrades the whole system to yesterday's
complete Arch repository snapshot. Use `--snapshot YYYY/MM/DD` to choose a complete
snapshot at or after the current one. Packages remain signed by Arch; the OS does not
run an updater or download anything on a schedule.
The bundled hn and OS integration are pinned to this preview's source build;
this command updates Arch packages, not the bundled Harness runtime.

A failed or interrupted update blocks ordinary package transactions until
`sudo hn-os update` completes successfully. Fix the reported
cause and retry; it keeps the original recovery checkpoint, including across
reboots. If the installed system cannot complete the update, recover that
checkpoint from the live USB. This guard applies to updates run through `hn-os`;
custom package-manager workflows remain the owner's responsibility.

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
4. Operate the real installer form on a guest terminal: disk picker, encryption
   toggle, masked passwords, Back/Esc, and explicit erase confirmation.
   Install from the offline image to disposable VM disks, encrypted and plain;
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

## Measured preview footprint

These measurements cover preview 2 image `a155a16850438e04315a1959b1bfd1c387d8bf99`,
tested in [the complete image run](https://github.com/autonomous-ai/openharness/actions/runs/37101103529).
The guests have two virtual CPUs and 2 GiB RAM. Browser and agents are closed
for idle measurements; the measurement process is included.

| Measurement | Result |
| --- | --- |
| Hybrid ISO | 1,525,678,080 bytes (1.42 GiB) |
| Installed root filesystem used, including home and snapshots | 1.90–1.97 GiB |
| Settled RAM, six samples across both firmware modes | 395.05–404.37 MiB |
| Settled CPU, six two-second samples | 0–1.25% |
| Offline BIOS/plain installation | 30.4 seconds |
| Offline UEFI/encrypted installation | 49.3 seconds |
| Installed BIOS boot through hn process readiness, including test login | 17.8 seconds |

The encrypted boot check deliberately waits 100 seconds before entering the disk
password; its total is 111.7 seconds (11.7 excluding that deliberate wait). These
are VM observations, not laptop power-on benchmarks. The Mac's x86 emulation is
substantially slower and is for trying the
installation and interface. The image shrank by 304 MiB (17%) during testing by
removing duplicated live-initramfs graphics payload, while retaining the installed
firmware and drivers. Software rendering is selected only for a detected 2D
virtio display; physical GPUs retain their normal acceleration path.

The earlier preview 1 image also passed complete BIOS/plain and UEFI/encrypted
machine checks with [1 GiB RAM](https://github.com/autonomous-ai/openharness/actions/runs/37086919917),
including browser switching, a compiler build and the four agent executables.
Concurrent live model workloads were tested at 2 GiB, not 1 GiB. Leave additional
memory for projects, browser tabs and local model weights.

## Real programmer exercises

These real-model project and DSH results cover preview 1. Preview 2 reran OS,
compiler and agent executable checks, without new model turns.

Opt-in tests use free OpenCode model turns inside a freshly installed OS. They
create a Python log-analysis CLI, a keyboard-accessible conference website, a
canvas game, and a Fastify/SQLite issue tracker. The independent tester checks
file/stdin behavior, keyboard navigation, mobile layout, game controls and state,
API validation, CRUD, and persistence across a server restart. Compiler and
package checks separately build a C program after installing gcc/make on demand.

The DSH exercises use the repository's existing Web Viewer and Game Viewer. They
materialize real managed agent workspaces, edit and reload HTML, build a
terminal-only CSV tool, and change/play/export a game. Playwright uses the OS's
system Chromium with its sandbox enabled. Project source, screenshots and
receipts are retained as workflow artifacts; none of these projects, testing
tools, or downloaded agent binaries is preinstalled in the ISO.

Dispatch the **Programmer OS** workflow with `image_run_id=37083780202` and either
`workloads=true` or `dsh=true` to repeat the corresponding exercise. These use
network-accessible free models and may fail or exceed their bounded deadline;
agent exits and independent checks are reported separately. `memory_mib=1024`
selects the additional constrained-memory machine check.
