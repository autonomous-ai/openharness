# Harness

The user works in hn agent panes. Keep the system small. Install the tools needed
for the current task, and use terminal output, diffs and tests to review the work.
Open `hn-browser URL` only when a browser helps. Add tools and services when the
current task needs them; run extra services on demand unless the task needs them
persistently. Keep the desktop shell, launcher and panels absent unless the user
requests that interface. Open a new terminal immediately with Ctrl+b, then Shift+t. No agent or project setup
is required.

## System operations

- For connected services, read `/usr/share/harness-os/connections.md`.
  `harness connections list --json` discovers this user's connected accounts.
  They appear as MCP servers in Claude Code, Codex and OpenCode; keep
  credentials out of conversations.

- `Super+u` starts the update inside hn. `harness updates` opens its screen;
  click Update to start the same action. No confirmation or password is needed.
  The user timer checks hn and CLI releases and prepares verified downloads.
  Activation is explicit. An hn-only change restarts its screen, keeping terminal
  owners and agents alive. The same action handles checkpointed system packages. A restart is always
  deferred until the user chooses it; Done keeps working processes alive.
  Do not replace `/usr/lib/harness` manually or enable the CLI's independent
  daemon handoff updater: this OS supervises activation with systemd.
- This is Arch Linux with systemd, labwc, foot and Chromium. Read
  `/etc/harness-platform.json` before choosing kernel or driver packages: `pc`
  uses `linux-lts`; the experimental `apple-t2` image uses the pinned `linux-t2`.
  Older PC installations have no platform file. Confirm the running kernel with
  `uname -r` and `/usr/lib/modules/$(uname -r)/pkgbase`.
- Use the ordinary package manager; no private package ecosystem is required.
  On the live USB, `sudo systemctl start harness-keyring` waits for its one-time
  key setup before the first package installation. Installed systems finish that
  setup during installation. The hn screen does not wait for it at live boot.
  `sudo pacman -S --needed PACKAGE` installs from the system's complete dated
  repository snapshot. Never run `pacman -Sy` followed by individual installs.
- `sudo hn-os update` makes a checkpoint, advances all Arch repositories to
  yesterday's complete snapshot, and performs a full upgrade. It asks through
  pacman before the package transaction. Reboot after kernel/driver upgrades.
  If it fails or is interrupted, resolve the reported cause and rerun
  `sudo hn-os update` before changing individual packages. Ordinary package
  transactions are blocked until that full update succeeds; retry preserves
  the original recovery checkpoint. Use the live USB to recover if needed.
- Package transactions also create checkpoints automatically. A checkpoint
  includes the root filesystem, package database, kernel, initramfs and bootloader
  files. `/home` and its projects are separate and are not rolled back.
- `sudo hn-os checkpoint` explicitly saves the current system. Checkpoints use
  disk space; list them with `sudo ls /.snapshots`. Do not delete them blindly.
- Recovery runs from the live USB against an unmounted installed root device:
  `sudo hn-os recover /dev/sda3` lists checkpoints;
  `sudo hn-os recover /dev/sda3 CHECKPOINT` restores one. For encrypted installs,
  first use `sudo cryptsetup open /dev/sda3 hn-recovery`, then use
  `/dev/mapper/hn-recovery` in the recovery command. Device names vary; inspect
  `lsblk -f` first. Recovery changes the installed system, not user projects.
- The user's account has password-protected sudo, with narrow exceptions for
  the root-owned network form and official update/recovery commands. Do not disable authentication,
  browser sandboxing, disk encryption or the session lock to make a task easier.

## Network and hardware

- GPU verification runs briefly after the installed workspace starts. Success
  is quiet. Read `harness hardware` → `gpu_health` before changing NVIDIA drivers;
  `harness hardware --check-gpu` repeats the checks as the current user. Do not run
  it with sudo: ordinary session device access is part of the check. Each PCI GPU
  has separate binding, memory, computation and offscreen graphics results, with
  the exact failed API and error. `stale: true` means the saved result no longer
  describes this boot/driver. Unavailable or skipped checks are not passes.
- These are small readiness checks, not full VRAM, display, browser, sleep or
  model-workload validation. A headless GPU can pass compute while graphics stays
  explicitly unverified. Passthrough devices are never touched. Reports stay in
  `~/.local/state/harness-os/gpu/`; no hardware data is uploaded.
- Updates retain the original Btrfs root and matching boot checkpoint. GPU
  diagnostics run again after reboot, never by resetting a GPU used by agents.
  A failure does not automatically roll back or reboot. Use the reported update
  checkpoint with the existing offline recovery procedure when appropriate;
  projects remain in the separate home subvolume. Local models belong to the
  TUI's existing local-model workflow, not this hardware check.

- `harness hardware` reports the model, CPU baseline, PCI devices, bound drivers
  and backlights. It does not collect serial numbers, Wi-Fi names, MAC addresses
  or passwords. Use actual device IDs when diagnosing hardware.
- The PC USB carries a prebuilt wl module and signed offline packages for selected
  BCM4331/BCM4360 radios. The installer adds DKMS and matching LTS headers only
  where needed, so future kernel upgrades can rebuild the driver. Other Broadcom
  families keep their native drivers. Do not apply a blanket Broadcom blacklist.
  Driver build/load checks are not evidence of physical radio or suspend support.
- The experimental T2 image uses its own kernel and early input modules. Do not
  replace them with `linux-lts`, `broadcom-wl-dkms` or PC kernel modules. Its
  required kernel and module identities are in
  `/usr/share/harness-os/apple-t2/kernel.json`; actual installed packages and
  `modinfo` must agree. A VM boot does not establish physical Mac support.
- T2 Wi-Fi and Bluetooth need that Mac's Apple firmware. Installation preserves
  a verified local export before erasing the disk and stops if it cannot do so.
  The private copy is `/var/lib/harness-os/apple-firmware.tar`, with its model
  and checksum in `/var/lib/harness-os/install.json`; the reinstall copy is
  `/boot/harness-apple-firmware.tar`. Firmware package hooks restore this data
  automatically. Retain both copies; never upload them as diagnostic attachments.
  Use the T2 USB for offline recovery. The current T2 kernel stays pinned during
  ordinary Arch updates. Harness updates that change the pin stage and verify
  both kernel archives before mutation and retain the old one for offline
  rollback. The update receipt records both identities and the checkpoint.
  Older updaters refuse a changed pin and first need an update with the same
  pin that adds this capability. Do not bypass these checks or add a moving
  kernel repository to work around a refused update.
- Ethernet uses NetworkManager automatically. For Wi-Fi, use
  `Super+w` or `hn-os wifi`, which opens the Harness Wi-Fi form.
  Keep passwords out of shell arguments and transcripts.
- Audio uses PipeWire. Clipboard uses `wl-copy` and `wl-paste`.
- npm installs into `~/.local`. The initial npm configuration permits the vendor
  install scripts for Claude Code, Codex and OpenCode. When another package needs
  an install script, approve that package explicitly; keep npm's other defaults.
- `Super+b` opens/focuses Chromium or returns to hn; `Super+e` does the same for
  the file manager window (`hn files DIR`); `Super+o` asks for a folder or text
  file to open there; `Super+Enter` focuses hn;
  `Super+l` locks the screen. `sudo systemctl poweroff` shuts down cleanly.
- Print/`Super+p` saves a full screenshot and Shift+Print/`Super+r` a region to
  `~/Pictures/Screenshots`, also copied to the clipboard. When the user mentions
  "the screenshot", read the newest file there. `grim` and `slurp` are installed.
- On the PC image, the packages for supported NVIDIA Turing and newer GPUs are
  `nvidia-open-lts nvidia-utils`, including RTX 4090/5090 and RTX 6000 generations.
  New USB images carrying the NVIDIA bundle install them offline when the exact
  GPU IDs match the bundled support table. Check `pacman -Q` and
  `/var/lib/harness-os/hardware.json` before installing anything. Other machines
  receive no NVIDIA packages. Mixed legacy GPUs and passthrough assignments are
  left alone. On older installations, install both from the same repository
  snapshot, regenerate initramfs with `sudo mkinitcpio -P`, and reboot. Verify
  `nvidia-smi` and the actual workload before claiming GPU compute works.
  Older NVIDIA GPUs need a different driver assessment.
- CUDA SDKs, model weights and model servers are installed only when a task needs
  them. A driver working is not evidence that a particular AI framework supports
  the GPU; test the actual framework and workload.

## Diagnosis

`hn-os status`, `hn-os measure`, `systemctl --user status hn-screen harness-daemon`
and `journalctl --user -u hn-screen -u harness-daemon` show the session state.
Restarting `hn-screen` should reconnect to existing work. Do not restart or kill
the agent runtime as the first response to a display problem.

Source: https://github.com/autonomous-ai/openharness (exact source commit in
`/usr/share/harness-os/runtime.json`).
NVIDIA package: https://archlinux.org/packages/extra/x86_64/nvidia-open-lts/
NVIDIA support: https://github.com/NVIDIA/open-gpu-kernel-modules
