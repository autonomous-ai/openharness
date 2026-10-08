# Harness

A Linux operating system built by agents, for agents. Boot into `hn`, describe the work,
and let an agent use the tools it needs. Review its diffs, tests and output in
the terminal; open the browser when the work needs a visual surface.

Programmers are the first audience. Claude Code, Codex, OpenCode and pi are the
primary interface. Compilers, databases and other software are installed when
a task needs them. The product is Harness; “programmer OS” describes its initial
audience, not its name.

Product names and interface copy follow the [Naming System](../docs/naming-system.md).

**Harness 0.1.2:** the USB opens the installer directly. Installation works offline.
After shutdown, remove the USB and boot the installed disk. If disconnected,
the Wi-Fi page opens first and advances automatically when connected; Ethernet
skips that step. OpenCode starts on the left with two real terminals on the right.
There is no trial choice or installation dock.

Later launches restore existing work. The installed system keeps hn’s standard
status bar. Ctrl+b, then c opens a terminal in a new tab. Projects live under
`~/projects`. The full TUI reference and OS guide are bundled for agent questions.
**Super+n/t/m/w** require no Shift; Ctrl+b bindings still work.

The installer selects a disk, focuses Password, and has one full-width
**Install Harness** action, one row tall and aligned with the fields. Progress shows the Harness wordmark above the current step; encrypted boot shows the
Harness wordmark and a masked password prompt.
Both the live and installed system use `me@harness`.
`Super+u` starts the update. Frequent hn/CLI releases download in the background;
the shortcut or clickable **Update** button applies available updates without
a confirmation or password prompt. Running agents and terminals stay alive.
The update checker records release ancestry so a source-built runtime cannot be
replaced by an older public CLI with a higher development version number.

[Download Harness](https://github.com/autonomous-ai/openharness/releases/tag/os-latest)
· [Mac → USB → ThinkPad installation guide](INSTALL.md)
· [Standalone HTML/CSS landing page](../website/public/os/README.md)
· [Development feedback loop and Mac support targets](DEVELOPMENT.md)

Preview 10 removes a second connection check that reopened Wi-Fi after successful
setup. Encrypted installation now requests deferred device removal after syncing
and unmounting the disk. A remaining device reader can finish without making a
completed installation appear to fail; a slow udev wait has a bounded fallback.
Write, sync and unmount failures still stop installation and remain visible.

Preview 8 introduced stronger USB payload compression and fixed a startup race: opening
a terminal immediately can no longer send the USB welcome into that new window.
Encrypted installation also budgets key derivation against available RAM,
without treating RAM-backed swap as extra capacity after the agent trial.
These changes concern the live USB; existing installations do not need updating or
reflashing for them. The installed system update feed remains independent from
ISO packaging.

The [preview 14 release](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.14)
includes its installation guide, package inventory and exact validation evidence.
Native x86 VM checks passed BIOS/plain and UEFI/encrypted installation, first-use
agent conversations, graphical keyboard input, browser switching, update retry
and checkpoint recovery. The matching OS update bundle also passed runtime
activation with running work preserved, rollback and an encrypted system reboot.
The four programmer projects and three harness/viewer exercises described below
are earlier preview 6 evidence, not a claim that each was repeated on preview 14.

The user confirmed preview 2 installation and boot from a physical ThinkPad's
internal disk with the USB removed. Its first-use feedback informed this revision.
The user also confirmed preview 4 installation, boot and use on a ThinkPad.
Broader physical Wi-Fi, suspend and NVIDIA workload validation remain outstanding.
A working older installation does not need reinstalling solely for the USB
payload-location fix.

**Mac support:** suitable older Intel Macs without T2 can test this x86-64 preview,
but no Mac model family has completed physical validation. Selected Broadcom
drivers are available offline, and supported SPI keyboard controllers are included
for encrypted unlock; VM checks do not prove physical Wi-Fi or keyboard support.
T2 Macs have a separate [experimental image](platforms/apple-t2/README.md) with
VM-verified installation, firmware preservation and offline recovery; physical
hardware and automatic T2 kernel upgrades remain unverified. Apple Silicon and Raspberry Pi do not have
installable Harness images yet. See the [hardware targets](DEVELOPMENT.md#mac-support-targets)
for requirements and remaining work.

## Connected accounts

Open **Connections** from the browser's New Tab page, or run `harness connections`.
The local start page is removable in Chromium's extension settings and preserves
existing New Tab customizations. Sign in to a service on the local Connectors page.
21 services (Linear, Notion, Canva, Atlassian, GitLab,
Figma…) sign in directly from this computer; GitHub, Slack, Google, Microsoft
365 and a few others sign in through the Harness account. Claude Code, Codex
and OpenCode then get each service as an MCP server on a local bridge, which
adds the credential and renews it before it expires. Tokens stay outside
projects and agent configuration. See [Connections](connectors/README.md).

## Design

- Arch Linux, glibc, systemd and the LTS kernel. User space is rolling; LTS here
  describes the kernel, not the distribution. Builds use a complete dated Arch
  repository snapshot and record the installed package inventory.
- labwc supplies Wayland, focus, input and display management. No panel, launcher,
  wallpaper process, desktop icons, or notification daemon.
  On PC and Intel Mac builds, the OS package owns its pinned compositor at
  `/usr/lib/harness-os/labwc`. Its lock acknowledgement waits until every active
  display presents a covered frame. Updating or rolling back that package moves
  the session and compositor together; the running session is left alone until
  restart. Corresponding GPL source, the patch and rebuild instructions are in
  `/usr/share/licenses/harness-os/labwc/`. Fresh images do not install a second
  compositor. The experimental Fedora session still uses Fedora's labwc.
- One fullscreen foot window displays the existing Rust `hn`. Agent/runtime
  processes are supervised separately from that window. The image does not fork
  foot or add a second graphical Harness client.
  If graphics initialization fails, the login session falls back to hn on the
  Linux console so drivers can be repaired without a working compositor.
- Chromium is installed but does not start at boot. `Super+b` opens/focuses it or
  returns to hn. `Super+Enter` focuses hn; `Alt+Tab` switches available windows.
  Browser sandboxing and hardware acceleration remain enabled.
- `Ctrl+b`, then `Shift+n` opens the agent picker; `Ctrl+b`, then `Shift+t` opens a terminal directly. The normal session
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
make -C os compositor
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

## Install

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
machine can reach Harness but is not supported for the bundled agent.
The [installation guide](INSTALL.md) covers the
Mac download, checksum, flashing and ThinkPad boot menu in full.

The USB opens the installer directly. There is no trial screen or network step
before installation. It uses the image on the USB and works offline.

The installer uses `me@harness`. Choose **Disk**, leave **Encryption** enabled or
change it, then enter **Password** and **Repeat password**. **Install immediately
erases the selected disk**, when you activate Install Harness. There is no second
confirmation screen. The live USB and mounted disks are excluded. Selecting a
disk alone does not write to it. Passwords must be nonempty; this preview uses a
US keyboard layout, including at disk unlock.

Completion stays visible until **Shut down** is chosen.
Remove the USB after shutdown and boot the internal disk. An encrypted install
shows the Harness logo and **Enter your password**, then enters hn. An unencrypted
install requires login as `me`. The password initially protects both the account
and, when enabled, the disk. There is no first-boot account wizard.

`harness install` opens the same form from an agent or terminal on the USB;
`sudo harness install` runs it directly. Advanced overrides remain:
`--no-encryption`, `--username NAME`, and `--hostname NAME`. With an unattended
`--config` file, set `username`, `hostname` and `encrypt` in that file instead.
Ordinary hn on macOS or another Linux distribution does not expose OS installation.

On the installed system's first boot, the existing Wi-Fi page opens when there
is no connection. Connecting advances automatically to OpenCode on the left and
two terminal panes on the right. Working Ethernet skips Wi-Fi setup. Later boots
reconnect to saved Wi-Fi and restore existing work. Super+n starts New Harness,
Super+t opens a shell directly, Super+m connects a computer, Super+w opens Wi-Fi
and Super+l locks the session behind the same wordmark and "Enter your password"
as disk unlock. Super+e opens the file manager in its own window, a folder
tree on the left and the folder on the right; pressing it again returns to hn.
Super+o asks for a folder, opened in that window, or a text file, opened in
its editor.
Print or Super+p captures the screen, Shift+Print or Super+r a
dragged region; each picture is saved under `~/Pictures/Screenshots` and copied
to the clipboard. The Super keys require no Shift or prefix. The shared TUI
shortcuts still work; ordinary hn on macOS and other Linux distributions retains
its usual UI.
Recovery remains available through another console or the USB; the owner retains
normal Linux administrator control.

## Updates and recovery

The installed system prepares hn/CLI releases automatically and keeps hn's standard
status bar. **Super+u** checks and applies available updates. The **Update** button
in `harness updates` is also clickable. Neither path asks for confirmation or a
password. Running agents and terminals stay alive; a runtime update reconnects
the screen without rebooting the computer.

System updates keep a recovery checkpoint. When one needs a restart, the screen
says **Updated. Restart when ready.** Its default action is **Done**; restarting
is always deliberate. After that reboot, the same update request finishes any
remaining hn/CLI release against the new OS base. Later background checks return
to downloading only. See [update development](DEVELOPMENT.md#fast-hn-updates).

Previews 5 through 11 retain their existing controls until this update is installed:
**Super+u**, then **s**, then the account password. No new USB flash is needed.

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

The base package set carries Intel/AMD graphics and Linux firmware. Image builds
with the `nvidia-offline` capability also carry signed, snapshot-matched NVIDIA
packages on the USB. During installation, exact PCI IDs from the packaged current
support table select `nvidia-open-lts` and `nvidia-utils` for supported GPUs.
The installer configures early display modules and firmware for encrypted boot.
The compressed cache is excluded from the disk copy; generic installations gain
no NVIDIA packages, boot settings or package cache. No compiler or DKMS is needed.

If any NVIDIA display needs a legacy driver, or is already assigned to VFIO, the
installer leaves the GPU configuration alone. Existing installations made with
older images can install `nvidia-open-lts nvidia-utils` from the same repository
snapshot, regenerate initramfs with `sudo mkinitcpio -P`, and reboot. Updating the
OS does not silently change their GPU driver. The current open modules support
Turing and newer; older GPUs need a separate driver assessment.
See [Arch's package](https://archlinux.org/packages/extra/x86_64/nvidia-open-lts/)
and [NVIDIA's supported GPUs](https://github.com/NVIDIA/open-gpu-kernel-modules).
No NVIDIA hardware validation has been performed yet. Verify `nvidia-smi` and the
actual AI workload on each physical machine before treating it as supported.

`os/tests/nvidia_install_vm.py` exercises offline installation, damaged archive
and signature rejection, unchanged base packages, early modules/GSP firmware,
encrypted reboot, keyboard input and a browser on a virtual GPU. PCI discovery
uses explicit fixtures; none of those checks establishes physical rendering,
CUDA, sleep/wake or local-agent performance. The publication gate requires this
evidence from the exact ISO and separate generic-install exclusion checks.

OpenCode is bundled; other agent executables are installed through hn's existing
engine install recipes when selected. Accounts, API credentials and model downloads are supplied by the
owner. System guidance for agents lives at `/usr/share/harness-os/AGENTS.md`.

## Validation plan

1. Installer input/disk safety tests, shell/Python/XML/JSON syntax, workflow lint.
2. Build a real ISO; check checksums, package inventory and configuration in its
   actual SquashFS filesystem.
3. Boot the ISO under BIOS and UEFI; verify the installer opens directly and no
   agent or browser starts. On the installed disk, test browser focus and keyboard
   routing, clipboard, terminal input, reconnect, last-pane behavior and screen
   restart without terminating agent work.
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

Preview 10's ISO is 1,668,448,256 bytes (1.55 GiB). Its
[installed footprint assessment](https://github.com/autonomous-ai/openharness/actions/runs/37212080839)
used the published image `2eee2748c2290f5700695922d7e12589033ee3c3` in fresh
two-vCPU, encrypted UEFI VMs. Installed root usage, including home and snapshots,
was 2.04 GiB. Ten samples per state give these medians:

| Installed state | RAM used, 1 GiB VM | Swap used, 1 GiB VM | RAM used, 4 GiB VM |
| --- | --- | --- | --- |
| OpenCode and two terminal panes | 678.7 MiB | 30.4 MiB | 827.8 MiB |
| Terminal, agent and browser closed | 392.3 MiB | 23.9 MiB | 525.4 MiB |
| Local browser page, agent closed | 476.5 MiB | 170.7 MiB | 828.8 MiB |

The 4 GiB VM used no swap. RAM means `MemTotal - MemAvailable`; diagnostic login
and the observer remain included. The browser's low resident usage in the 1 GiB
VM comes with substantially more swap. Each VM runs one ordered sequence, so
these figures describe those states rather than proving a causal difference.
OpenCode is idle; this does not measure active agent work or local inference.
Both VMs rendered the browser page and accepted keyboard input on return to hn.

### Earlier installation and boot measurements

These measurements cover preview 6 image `3c15fe540de02db8a3b37d565ce8b4001b872779`.
The ISO is 1,748,402,176 bytes (1.63 GiB). The table records two-vCPU, 1 GiB VMs.
[1 GiB USB tests](https://github.com/autonomous-ai/openharness/actions/runs/37149350400)
boot from the mounted medium; [4 GiB USB tests](https://github.com/autonomous-ai/openharness/actions/runs/37150118908)
exercise automatic copy-to-RAM. Idle samples are taken on the installed disk,
with agents and browser closed and the measurement process included.

| Measurement | 1 GiB VM |
| --- | --- |
| Installed root used, including home and snapshots | 2.03–2.04 GiB |
| Settled RAM, six samples across both firmware modes | 367.90–395.57 MiB |
| Offline BIOS/plain installation | 36.290 seconds |
| Offline UEFI/encrypted installation | 69.347 seconds |
| Installed BIOS boot through hn readiness, including automated login | 16.228 seconds |
| Encrypted boot to password prompt | 6.046 seconds |
| Password submission to hn readiness, including diagnostic login | 8.436 seconds |

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

[Four projects](https://github.com/autonomous-ai/openharness/actions/runs/37154010202)
were built by fresh OpenCode runs inside preview 6: a Python log-analysis CLI,
a keyboard-accessible conference website, a canvas game and a Fastify/SQLite
issue tracker. All 33 project unit tests passed. The first independent checker
incorrectly required the game's canvas-drawn controls to be HTML text; that run
remains failed. [Corrected acceptance](https://github.com/autonomous-ai/openharness/actions/runs/37155632007)
passed on the same retained projects without further model calls, checking the
actual rendered controls at 1024×768 and 1280×800 with host-side OCR.
A [final agent pass](https://github.com/autonomous-ai/openharness/actions/runs/37156180888)
fixed a clipped help sentence; all checks passed again. That run retried only the
BIOS job after a GitHub artifact download timed out before boot.
The independent tester checks file/stdin behavior, keyboard navigation, mobile
layout, game controls and state, API validation, CRUD and persistence across a
server restart. A separate compiler check installs gcc/make and builds C.

[Three fresh harness/viewer exercises](https://github.com/autonomous-ai/openharness/actions/runs/37154011980)
use the repository's Web Viewer and Game Viewer. They materialize managed agent
workspaces, edit and reload HTML, build a terminal CSV tool, and change/play/export
a game. Tests use the OS's sandboxed Chromium. OpenCode uses upstream model
defaults; availability can change. Project source, screenshots and receipts are
available in the release's supplementary `harness-examples-preview6.zip` download.
Test projects and test tools are separate from the minimal ISO.

To repeat these exercises, dispatch **Harness OS** with
`image_run_id=37149350400` and either `workloads=true` or `dsh=true`, using
`memory_mib=4096` and `live_transport=usb`. `memory_mib=1024` selects the constrained
base-machine journey. Model calls have deadlines; agent completion and independent
acceptance are recorded separately. The publisher rejects failed or mismatched
machine evidence and a guide that names a different ISO.
