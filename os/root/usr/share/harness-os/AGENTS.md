# Harness

The user works in hn agent panes. Keep the system small. Install the tools needed
for the current task, and use terminal output, diffs and tests to review the work.
Open `hn-browser URL` only when a browser helps. Add tools and services when the
current task needs them; run extra services on demand unless the task needs them
persistently. Keep the desktop shell, launcher and panels absent unless the user
requests that interface. Open a new terminal immediately with Ctrl+B, then T. No agent or project setup
is required.

## System operations

- `Super+U` opens Updates inside hn; `harness updates` is the shell equivalent.
  The user timer checks hn and CLI releases and prepares verified downloads.
  Activation is explicit. An hn-only change restarts its screen, keeping terminal
  owners and agents alive. System packages use the separate checkpointed action.
  Do not replace `/usr/lib/harness` manually or enable the CLI's independent
  daemon handoff updater: this OS supervises activation with systemd.
- This is Arch Linux with systemd, the LTS kernel, labwc, foot and Chromium.
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
- The user's account has password-protected sudo. Do not disable authentication,
  browser sandboxing, disk encryption or the session lock to make a task easier.

## Network and hardware

- `harness hardware` reports the model, CPU baseline, PCI devices, bound drivers
  and backlights. It does not collect serial numbers, Wi-Fi names, MAC addresses
  or passwords. Use actual device IDs when diagnosing hardware.
- The USB carries a prebuilt wl module and signed offline packages for selected
  BCM4331/BCM4360 radios. The installer adds DKMS and matching LTS headers only
  where needed, so future kernel upgrades can rebuild the driver. Other Broadcom
  families keep their native drivers. Do not apply a blanket Broadcom blacklist.
  Driver build/load checks are not evidence of physical radio or suspend support.
- Ethernet uses NetworkManager automatically. For Wi-Fi, use
  `hn-os wifi`, which opens NetworkManager’s keyboard interface.
  Keep passwords out of shell arguments and transcripts.
- Audio uses PipeWire. Clipboard uses `wl-copy` and `wl-paste`.
- npm installs into `~/.local`. The initial npm configuration permits the vendor
  install scripts for Claude Code, Codex and OpenCode. When another package needs
  an install script, approve that package explicitly; keep npm's other defaults.
- `Super+B` opens/focuses Chromium or returns to hn; `Super+Enter` focuses hn;
  `Super+L` locks the screen. `sudo systemctl poweroff` shuts down cleanly.
- On supported NVIDIA Turing and newer GPUs, including RTX 4090/5090 and RTX 6000
  generations, the LTS-kernel packages are `nvidia-open-lts nvidia-utils`.
  Install both from the same repository snapshot, regenerate initramfs with
  `sudo mkinitcpio -P`, reboot, and verify `nvidia-smi` before claiming GPU compute
  works. Older NVIDIA GPUs need a different driver assessment.
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
