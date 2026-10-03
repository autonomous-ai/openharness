# Harness

An operating system built around agents. Boot into `hn`, describe the work,
and let an agent use the tools it needs. Review its diffs, tests and output in
the terminal; open the browser when the work needs a visual surface.

Programmers are the first audience. Claude Code, Codex, OpenCode and pi are the
primary interface. Compilers, databases and other software are installed when
a task needs them. The product is Harness; “programmer OS” describes its initial
audience, not its name.

Product names and interface copy follow the [Naming System](../docs/naming-system.md).

**Preview 5:** the USB welcome offers **Install Harness** or **Try without installing**.
Install works offline. Try opens Wi-Fi setup when needed, then bundled OpenCode
with its upstream default settings. The installer has four fields and one Install
action; encrypted boot shows the Harness wordmark and a masked password prompt.
Both the live and installed system use `me@harness`.
`Super+U` opens Updates. Frequent hn/CLI releases download in the background;
you choose when to reconnect the screen. Running agents and terminals stay alive.

[Download preview 5](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.5)
· [Mac → USB → ThinkPad installation guide](INSTALL.md)
· [Standalone HTML/CSS landing page](../website/public/os/README.md)
· [Development feedback loop and Mac support targets](DEVELOPMENT.md)

Each published image includes its matching installation guide and exact validation
evidence. Preview 4 passed BIOS/plain and UEFI/encrypted USB installation, boot,
update retry and recovery at 1 GiB and 4 GiB RAM. Its first-use model conversations,
four programmer projects and three DSH exercises passed the checks described below;
those historical measurements are labeled separately from each new image's receipt.

The user confirmed preview 2 installation and boot from a physical ThinkPad's
internal disk with the USB removed. Its first-use feedback informed this revision.
The user also confirmed preview 4 installation, boot and use on a ThinkPad.
Physical Wi-Fi, suspend and NVIDIA validation remain outstanding. A working older
installation does not need reinstalling solely for the USB payload-location fix.

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
- `Ctrl+B`, then `N` opens the agent picker; `Ctrl+B`, then `T` opens a terminal directly. The normal session
  has no interactive parent shell to exit into. Shells remain available in hn panes. This is
  an interface policy, not confinement against someone with shell/admin access.
- NetworkManager, fonts, clipboard, audio, locking, firmware and zram provide
  the support needed by actual development machines. OpenCode is bundled. Compilers, IDEs, model weights, CUDA, containers and
  databases are installed when needed. Python and Node support the OS and Harness runtime.
- Btrfs root, separate home and snapshot subvolumes, BIOS and UEFI boot, and
  optional LUKS2 encryption (default on). The installer extracts its immutable
  payload locally instead of downloading and installing each package again.

The full installation owns the hardware, first boot, authentication, runtime,
updates and recovery. These are completion gates, not optional follow-up work.

## Build

The GitHub **Harness OS** workflow builds on an isolated x86 Linux runner.
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

To experiment with the PC image in a Mac window, install QEMU with
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
Earlier Mac checks rendered a project in Chromium, but subsequent background
reboots missed readiness deadlines with guest soft-lockup reports. Preview 4 has
not been validated interactively on this Mac. Use the native x86 VM evidence for
measured performance; Apple Silicon emulation is not yet a reliable performance
or full-experience demonstration.

Write the **whole ISO** to a USB stick using an image writer such as Etcher, then
boot an x86-64 PC with Secure Boot disabled. TPM can remain enabled. A 32-bit-only
ThinkPad cannot boot this image. Bundled OpenCode also requires SSE4.2: a Core 2
machine can reach Harness but is not supported for the bundled agent trial.
The [installation guide](INSTALL.md) covers the
Mac download, checksum, flashing and ThinkPad boot menu in full.

On the USB welcome, press **Enter** to install or **T** to try Harness. Installation
needs no network or terminal command. Trying a cloud agent requires a connection;
network setup opens when needed. Work in the live USB session is temporary and is
not copied during installation.

The installer uses `me@harness`. Choose **Disk**, leave **Encryption** enabled or
change it, then enter **Password** and **Repeat password**. **Install immediately
erases the selected disk**, as disclosed in the form. There is no second
confirmation screen. The live USB and mounted disks are excluded. Selecting a
disk alone does not write to it. Passwords must be nonempty; this preview uses a
US keyboard layout, including at disk unlock.

Completion stays visible until **Shut down** or **Back to Harness** is chosen.
Remove the USB after shutdown and boot the internal disk. An encrypted install
shows the Harness logo and **Enter your password**, then enters hn. An unencrypted
install requires login as `me`. The password initially protects both the account
and, when enabled, the disk. There is no first-boot account wizard.

The command equivalent is `sudo harness install`. Advanced overrides remain:
`--no-encryption`, `--username NAME`, and `--hostname NAME`. With an unattended
`--config` file, set `username`, `hostname` and `encrypt` in that file instead.
Ordinary hn on macOS or another Linux distribution does not expose OS installation.

On the installed system's empty home, Enter starts OpenCode. `Ctrl+B`, then `W`
opens network setup; `Ctrl+B`, then `T` opens a shell directly. Capital letters
in these prefix shortcuts mean Shift + letter. `Super+L` locks the session.
Recovery remains available through another console or the USB; the owner retains
normal Linux administrator control.

## Updates and recovery

Preview 5 prepares hn/CLI releases automatically and shows a small bottom-bar
notice. `Super+U` opens Updates; Enter activates an available runtime and
reconnects the screen without a computer reboot. **R** restores the previous
runtime. System updates use **S**, ask for the account password, retain a
checkpoint and offer a restart when ready. Neither channel automatically
interrupts working agents. See [update development](DEVELOPMENT.md#fast-hn-updates).

Preview 4 needs the matching bootstrap bundle from the
[preview 5 release](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.5)
once. Verify its `SHA256SUMS`, run `sudo python3 apply-update.py apply "$PWD"`
from the extracted folder, and reboot. Later updates use the installed screen;
routine updates do not require another USB flash.

`sudo hn-os update` saves a checkpoint and upgrades the whole system to yesterday's
complete Arch repository snapshot. Use `--snapshot YYYY/MM/DD` to choose a complete
snapshot at or after the current one. Packages remain signed by Arch; this full
system transaction runs only when requested.
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

OpenCode is bundled; other agent executables are installed through hn's existing
engine install recipes when selected. Accounts, API credentials and model downloads are supplied by the
owner. System guidance for agents lives at `/usr/share/harness-os/AGENTS.md`.

## Validation plan

1. Installer input/disk safety tests, shell/Python/XML/JSON syntax, workflow lint.
2. Build a real ISO; check checksums, package inventory and configuration in its
   actual SquashFS filesystem.
3. Boot the ISO under BIOS and UEFI; verify hn is visible and Chromium is absent
   until requested. Test browser toggle, clipboard, terminal input, reconnect,
   last-pane behavior and frontend restart without terminating agent work.
4. Operate the real installer form on a guest terminal: disk picker, encryption
   toggle, masked passwords, Back/Esc, a single explicit Install action and persistent completion.
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

These measurements cover preview 4 image `21aa5de0bd1a9a8a21cb4be06f83bf65c072a1b8`.
The ISO is 1,612,300,288 bytes (1.50 GiB), with 405 installed packages. Both test
environments have two virtual CPUs. [1 GiB USB tests](https://github.com/autonomous-ai/openharness/actions/runs/37119543543)
boot from the mounted medium; [4 GiB USB tests](https://github.com/autonomous-ai/openharness/actions/runs/37120135497)
exercise automatic copy-to-RAM. Idle samples are taken on the installed disk,
with agents and browser closed and the measurement process included.

| Measurement | 1 GiB VM | 4 GiB VM |
| --- | --- | --- |
| Installed root used, including home and snapshots | 2.03–2.07 GiB | 2.06–2.08 GiB |
| Settled RAM, six samples across both firmware modes | 396.02–399.43 MiB | 480.62–511.13 MiB |
| Settled CPU, six two-second samples | 0.25–1.74% | 0–1.5% |
| Offline BIOS/plain installation | 35.8 seconds | 30.0 seconds |
| Offline UEFI/encrypted installation | 57.8 seconds | 44.6 seconds |
| Installed BIOS boot through hn readiness, including automated login | 16.3 seconds | 17.3 seconds |
| Encrypted boot to password prompt | 4.9 seconds | 4.6 seconds |
| Password submission to hn readiness, including diagnostic login | 8.1 seconds | 8.3 seconds |

Encrypted tests also wait 100 seconds before attempting a wrong password and
then the correct one. The raw totals include that wait, retry and automated typing;
`boot-events.jsonl` records each stage so human interaction is not reported as OS
startup time. A previous instrumented run made the serial port the primary console
and delayed the graphical prompt; keeping the screen primary corrected the test
configuration. Ordinary installations do not add the diagnostic serial console.

The installer limits its extraction caches to 64 MiB. This fixed an actual
out-of-memory failure after trying OpenCode and Chromium in the 1 GiB live session.
The 1 GiB runs now pass installation, boot, recovery and the first model conversation.
Leave more memory for browser tabs, concurrent agents and local model weights.
These are native x86 VM observations, not physical laptop power-on benchmarks.
The BIOS agent checks use a Nehalem CPU profile without AVX2. Physical GPUs keep
hardware acceleration; software rendering is selected only for a detected 2D
virtio display.

## Real programmer exercises

[Four project checks](https://github.com/autonomous-ai/openharness/actions/runs/37120135497)
passed on this image: a Python log-analysis CLI, a keyboard-accessible conference
website, a canvas game and a Fastify/SQLite issue tracker. Three completed projects
from the earlier preview 4 validation were reused; the game agent ran again and
all 31 project unit tests and independent checks reran on this exact image.
The independent tester checks file/stdin behavior, keyboard navigation, mobile
layout, game controls and state, API validation, CRUD and persistence across a
server restart. A separate compiler check installs gcc/make and builds C.

[Three fresh DSH exercises](https://github.com/autonomous-ai/openharness/actions/runs/37120138348)
use the repository's Web Viewer and Game Viewer. They materialize managed agent
workspaces, edit and reload HTML, build a terminal CSV tool, and change/play/export
a game. Tests use the OS's sandboxed Chromium. OpenCode uses upstream model
defaults; availability can change. Project source, screenshots and receipts ship
in `harness-examples.zip` and `machine-evidence.zip`. Test projects and test tools
are separate from the minimal ISO.

To repeat these exercises, dispatch **Harness OS** with
`image_run_id=37119543543` and either `workloads=true` or `dsh=true`, using
`memory_mib=4096` and `live_transport=usb`. `memory_mib=1024` selects the constrained
base-machine journey. Model calls have deadlines; agent completion and independent
acceptance are recorded separately. The publisher rejects failed or mismatched
machine evidence and a guide that names a different ISO.
