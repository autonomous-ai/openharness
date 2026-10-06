# Apple Silicon image work

The private image builder combines the pinned **Fedora Asahi Remix Minimal**
KIWI description with a separately verified Harness session RPM. It includes
hn, OpenCode with upstream defaults, terminal panes and the optional Chromium
browser. It selects no GNOME or KDE desktop profile.

This is image construction work, **not an installable Harness release**. Encryption,
Fedora base-system updates/recovery and physical Apple hardware acceptance remain
required. The image contains no pre-created user or known login password. Never
flash this raw disk over a Mac's disk or use the PC whole-disk installer on Apple
Silicon. No public installer metadata or download feed is generated.

## Maintained platform foundation

`source.lock.json` pins the upstream description commit/tree and native Fedora
builder image. Our `Harness` profile extends `Minimal`; it keeps Asahi's existing
4096-byte-sector EFI/ext4/Btrfs layout, kernel, m1n1, U-Boot, firmware integration,
first-boot platform services and SELinux policy. The small graphical session also
includes Asahi's audio configuration and speaker protection. Fedora package
signatures stay enabled. No Apple firmware is copied from a developer's Mac.

The Harness RPM is selected from a successful private package workflow by exact
source commit and SHA-256. Its dependencies are installed by KIWI from the signed
Fedora/Asahi repositories. A later, repository-disabled transaction installs only
that exact unsigned private RPM. No Desktop, TUI, CLI or daemon is built or
published by this workflow; the package carries its original runtime provenance.

Upstream image descriptions are GPL-3.0-or-later. Their `COPYING`, author metadata
and original platform files are retained in the generated recipe. The image keeps
Fedora's package identity for platform maintenance; this does not imply Fedora or
Asahi endorsement of Harness.

## Private build and evidence

Run **Harness OS private Apple Silicon image** with an existing successful
**Harness OS private Fedora package** run and its full producer commit. It builds
on native AArch64 Linux using Podman, then inspects the produced raw disk through
read-only loop mounts. Evidence includes the actual partition table, boot object
hashes, complete RPM inventory, exact Harness/OpenCode files, locked root account,
absence of fixture credentials/machine keys, and enforcing SELinux configuration.

The workflow retains a compressed private disk only after inspection passes.
That evidence proves image contents, not Apple boot, firmware extraction,
encryption, suspend, audio, Wi-Fi or recovery. Platform acceptance must use actual
hardware before a supported install is offered.

The intended installation must preserve macOS and Apple recovery, using the
space prepared by Asahi. The upstream prebuilt-image and UEFI-media paths are
described in the [distribution guidelines](https://asahilinux.org/docs/alt/policy/).
This build is the image foundation for that work; it does not invoke either
installer on the host.

## First boot

The image's first screen asks for **Password** and **Repeat password**, then
**Start Harness**. It creates `me@harness` through Fedora's account tools and
enables the existing Harness session through greetd. The new account belongs to
Fedora's `wheel` group; administrative commands and recovery-console login use
the chosen password. Root stays locked. No password or password hash is saved in
the setup receipt, command arguments or temporary files.

Account creation belongs only to this private image, not to installing or updating
the session RPM on an existing Fedora system. First boot refuses existing accounts,
homes and conflicting login settings. A private receipt lets interrupted account
creation or login configuration resume; it does not overwrite another account.
After setup, the normal OS networking page runs when needed, followed by the
existing agent workspace. Subsequent boots enter Harness directly.

This step does not encrypt the disk. It keeps the maintained Fedora/Asahi boot,
swap, extras, authentication and SELinux configuration. The stock account wizard
remains installed but is disabled in the Harness image.

## Private encrypted-root acceptance

`os/tests/asahi_encryption_vm.py` tests LUKS2 around a disposable copy of the
produced image on an Apple Silicon host. It requires that image's full source
commit and SHA-256, plus a verified native ARM maintenance fixture. It never
opens a host disk. The maintenance VM sees only its own root and the cloned
image, identified by a test-only device serial.

```sh
python3 os/tests/asahi_encryption_vm.py \
  --image /path/to/harness-asahi-private.raw --sha256 IMAGE_SHA256 \
  --image-source FULL_IMAGE_COMMIT \
  --fixture /path/to/verified-arm-fixture --fixture-source FULL_FIXTURE_COMMIT \
  --output os/test-results/asahi-encryption
```

The test shrinks the pristine Btrfs root and encrypts it with Fedora cryptsetup,
checks that every decrypted filesystem byte matches its baseline, and regenerates
the Fedora initramfs and boot entries. Mounts stay in a private namespace so
background services cannot retain the target after cleanup. The partition table,
EFI partition, Harness payload and Asahi keyboard modules must remain intact.
Only the clone gains QEMU console arguments and its virtio keyboard driver.

Acceptance covers graphical wrong/correct password entry, first account setup,
the initial OpenCode and two terminal panes, subsequent unlock, and offline
read-only recovery of a project. Each boot must have enforcing SELinux and no
failed system services. Receipts retain input hashes, screenshots, boot journals,
clean shutdown events, and a final check that the original image is unchanged.

This establishes encrypted-root compatibility, not an installation or encryption
enrollment flow. The test uses a public fixture password: **never publish its disk
copies**. A user installer still needs to create a unique encryption key, preserve
macOS and recovery, and handle interruption before it can offer encrypted installs.
Physical Apple keyboard, storage and recovery acceptance remain separate.
