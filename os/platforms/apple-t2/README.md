# Apple T2 experimental image

This directory pins the maintained T2 kernel and its required modules. A separate
`apple-t2` build profile uses that kernel for both USB and installed boot. It is
not yet a physically validated Mac release. The ordinary PC image still refuses
T2 installation before any disk write.

`kernel.json` records the upstream recipe, patch commit and exact release archive.
`prepare-t2-kernel.py` verifies its checksum, package identity, kernel release and
input/radio/audio modules without extracting package paths or installing anything
on the build host. The resulting bundle retains the original package. It adds no
compiler, kernel headers, desktop or extra service to the generic image.

The **Harness OS laptop input** workflow accepts `probe=t2-boot` with image run
`37257481538`. It installs the original preview 14 in an encrypted VM, installs
the pinned kernel, checks early input modules in the generated initramfs and their
kernel compatibility, then cold boots and types through the graphical unlock and
Harness. Source, package hashes, boot output and screenshots are retained. A VM
cannot establish that physical T2 devices work.

The experimental installer preserves model-specific Apple wireless firmware in
RAM before erasing macOS, restores it with the installed image, and retains it
in root checkpoints. A pacman hook restores this board data after firmware
package updates. Kernel files, early input modules and GRUB parameters follow
the platform through offline recovery. Physical built-in input, Wi-Fi, audio,
graphics and suspend still require validation on real Macs. In particular,
iMac Pro firmware needs the macOS export route. Never add a moving unsigned
repository or copy Apple firmware into the public ISO as a shortcut.

## Preserve wireless firmware

`os/tools/prepare-t2-firmware.py` is a separate preparation tool. It reads the
Intel Mac's own `/usr/share/firmware` while macOS is running and creates a local
archive. It does not install Harness, mount or change a disk, or enable the T2
installer. The small validation helpers are also packaged for OS updates; no
Apple firmware or T2 kernel is added to the generic PC image.

From a checkout on the Intel Mac, with Python 3.10 or later already available:

```sh
python3 os/tools/prepare-t2-firmware.py export --output ~/Downloads/harness-apple-firmware.tar
```

Keep that archive with the computer. It contains Apple's firmware and should not
be committed or uploaded to a public release. The command never overwrites an
existing export. No macOS account files, serial numbers or network passwords are
collected. An iMac Pro export also reads its calibration filenames from IORegistry;
it stops if those files cannot be identified. Three BCM4377 models additionally
require the Bluetooth firmware available in macOS Monterey or later.

The experimental T2 installer validates the archive against the detected model
and stages it in a fresh RAM-backed directory before erasing the source disk. The
tool's `verify` and `stage` commands implement that data boundary; `--model` is
explicit for development, not an installer override. Archive checks reject links,
special files, unexpected paths, duplicate entries, excessive sizes and altered
inventories. Every staged file has a size and SHA-256 in the retained manifest.
These checks establish local copy integrity, not a signature from Apple or proof
that a physical radio works. The archive is retained privately under
`/var/lib/harness-os/apple-firmware.tar`, and the installation receipt records its
model and checksum. A second verified copy is written to the newly formatted
boot partition before encryption or root extraction, so a reinstall can recover
it after macOS is gone. A failed installation also retains its verified RAM copy
for the rest of the live session. Checkpoint creation and recovery recheck the
retained identity. The firmware itself is board data, not user credentials; the
boot partition copy is unencrypted, like the kernel and initramfs.

The naming rules derive from the MIT-licensed upstream conversion script at
`t2linux/wiki@11fc0a8d8cfb61affd0cb9d1ac245c1b6c16d3cd`; its full SHA-256 is
`c1c1d8aa25bb5f089e46ccd0d9738fc13bfbd784f499aa924466c690f059961e`.
The **Harness OS Apple firmware preservation** workflow checks local CLI round
trips and malformed-input refusal on Linux and macOS, then compares filenames and
bytes with that pinned converter. Fixtures contain invented bytes only. No
physical Mac's firmware is stored in CI. The ordinary PC image keeps its T2
installation refusal; only the separate profile running its T2 kernel can proceed.

## Private image acceptance

The **Harness OS T2 image** workflow builds only private artifacts. Its initial
candidate requires the exact public preview 14 `tui/`, `cli/` and `store/` source
trees while shared products are being refactored. The image checksum and full
payload are inspected before a native KVM journey. Synthetic Mac DMI and invented
firmware exercise refusal before erasure, an encrypted offline install, the real
firmware package hook, graphical unlock, keyboard input and offline checkpoint
recovery. These fixtures do not emulate T2 hardware or establish Mac support.

On the target Mac, an export named `harness-apple-firmware.tar` can be placed at
the root of its EFI partition before booting the experimental image. The installer
only mounts that partition read-only. Alternatively, it searches read-only APFS
volumes for the Mac's own `/usr/share/firmware`; FileVault or an inaccessible
volume may prevent this route. An iMac Pro requires the explicit macOS export.
Missing or invalid firmware stops installation before partitioning.

Build with `HARNESS_OS_PLATFORM=apple-t2` and `HARNESS_OS_T2_BUNDLE` pointing to a
fresh verified bundle from `prepare-t2-kernel.py`. The output is named
`harness-t2-<version>-x86_64.iso`. The default PC build and its NVIDIA/Broadcom
bundle selection are unchanged.

## Kernel updates and recovery

Ordinary Arch updates retain the pinned T2 kernel. A Harness update can advance
that pin through `t2_update.py`: it downloads and verifies both the old and new
immutable upstream archives before changing any packages. Corrupt or missing
inputs stop the update. The old archive is retained privately with the recovery
receipt, and one pacman transaction installs the new kernel and matching Harness
package. Verification reads back the installed kernel, required modules, early
unlock drivers, initramfs and GRUB parameters. Apple firmware is restored from
the computer's verified local copy. No headers, compiler or moving kernel
repository are added.

The running session stays alive; a restart activates the new kernel. Package
rollback uses the retained old archive without network access, regenerates the
matching boot files and verifies them. USB checkpoint recovery restores root and
its exact boot files together while keeping newer home/project files. A failed
transaction retains its original checkpoint and blocks another package update
until rollback completes.

An initial T2 installation must first receive an update that adds this capable
updater while keeping its kernel pin unchanged. Older updaters deliberately refuse
a changed pin. Do not publish a changed-pin update as that first migration or
bypass the platform checks. No T2 kernel update has been published yet.

The private **Harness OS T2 kernel update** workflow uses real pinned 7.2.7 and
7.2.8 kernel packages, an explicitly constructed older-version Harness fixture,
encrypted cold boots, interrupted transactions, offline rollback and USB recovery.
It verifies running terminal process preservation and retained project files.
Its synthetic Mac identity and firmware do not establish physical hardware support.

Upstream references: [maintained kernel](https://github.com/NoaHimesaka1873/linux-t2-arch),
[early input and kernel parameters](https://wiki.t2linux.org/guides/postinstall/),
[wireless firmware](https://wiki.t2linux.org/guides/wifi-bluetooth/), and
[hardware status](https://wiki.t2linux.org/state/).
