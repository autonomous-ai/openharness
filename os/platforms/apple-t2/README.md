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

Upstream references: [maintained kernel](https://github.com/NoaHimesaka1873/linux-t2-arch),
[early input and kernel parameters](https://wiki.t2linux.org/guides/postinstall/),
[wireless firmware](https://wiki.t2linux.org/guides/wifi-bluetooth/), and
[hardware status](https://wiki.t2linux.org/state/).
