# Apple T2 platform preparation

This directory pins the maintained T2 kernel and its required modules. It is
preparation for a separate Intel Mac boot profile, not a supported T2 installer.
The ordinary image still refuses T2 installation before any disk write.

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

Before enabling T2 installation, integrate the same kernel into both USB and
installed boot, preserve model-specific Apple wireless firmware before erasing
macOS, and make updates/recovery preserve the selected platform. Then validate
built-in input, Wi-Fi, audio, graphics and suspend on real Macs. In particular,
iMac Pro firmware needs the macOS export route. Never add a moving unsigned
repository or copy Apple firmware into the public ISO as a shortcut.

## Preserve wireless firmware

`os/tools/prepare-t2-firmware.py` is a separate preparation tool. It reads the
Intel Mac's own `/usr/share/firmware` while macOS is running and creates a local
archive. It does not install Harness, mount or change a disk, or enable the T2
installer. It is not added to the generic PC image.

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

The future T2 installer can validate the archive against the detected model and
stage it in a fresh RAM-backed directory before erasing the source disk. The
tool's `verify` and `stage` commands implement that data boundary; `--model` is
explicit for development, not an installer override. Archive checks reject links,
special files, unexpected paths, duplicate entries, excessive sizes and altered
inventories. Every staged file has a size and SHA-256 in the retained manifest.
These checks establish local copy integrity, not a signature from Apple or proof
that a physical radio works. Restoring into the installed system and preserving
the firmware through updates/recovery remain part of the T2 installer integration.

The naming rules derive from the MIT-licensed upstream conversion script at
`t2linux/wiki@11fc0a8d8cfb61affd0cb9d1ac245c1b6c16d3cd`; its full SHA-256 is
`c1c1d8aa25bb5f089e46ccd0d9738fc13bfbd784f499aa924466c690f059961e`.
The **Harness OS Apple firmware preservation** workflow checks local CLI round
trips and malformed-input refusal on Linux and macOS, then compares filenames and
bytes with that pinned converter. Fixtures contain invented bytes only. No
physical Mac's firmware is stored in CI. The existing T2 installation refusal
remains in place until the USB kernel, installer and recovery path are complete.

Upstream references: [maintained kernel](https://github.com/NoaHimesaka1873/linux-t2-arch),
[early input and kernel parameters](https://wiki.t2linux.org/guides/postinstall/),
[wireless firmware](https://wiki.t2linux.org/guides/wifi-bluetooth/), and
[hardware status](https://wiki.t2linux.org/state/).
