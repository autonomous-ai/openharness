# Private Fedora recovery engine

[`recovery.py`](recovery.py) is an uninstalled development tool for the private
Fedora/Asahi installer layout. It does not enable system updates, change Super+u,
grant sudo access, or change a released image. Host tests exercise its journal and
file boundaries; they do not establish native or physical Apple recovery support.

The first adapter requires independent maintenance Linux and a cold target, both
when checkpointing and when recovering. The intended system update feature still
needs an automatic checkpoint at stock offline-DNF startup, before RPM changes,
and recovery from maintenance. A manually prepared checkpoint does not complete
that feature. The archive and journal core is separated from cold mount discovery
so a later offline-startup adapter can reuse it after its own acceptance tests.

## Supported target and trust boundary

Use a completed installation with its original `target.json`, `storage.json`, and
`startup.json` on the firmware-selected owned ESP. The engine binds those receipts,
image digest and source commit to the GPT disk/partition identities, LUKS UUID,
Btrfs UUID and ext4 UUID. Device names may change between boots; partition numbers,
extents and identities must still match. It writes no partition tables, formats no
filesystems, and never opens Apple/vendor partitions for writing.

The supported layout has single-device Btrfs with exactly the `root` and `home` subvolumes, `/var`
inside `root`, ext4 `/boot`, and the owned FAT ESP. Additional subvolumes, mounts,
top-level content, redirected state paths, and hardlinks across the system/workload
restore boundary are refused. Only the engine's recorded recovery subvolumes are
allowed alongside `root` and `home`. This prototype does not migrate layouts or
move `/var` into a new subvolume.
Every present Btrfs superblock copy must bind one device and the recorded UUID;
the no-replay kernel mount must select only the verified LUKS mapper.

The maintenance environment and source must be trusted and writable only by root.
Stage `recovery.py`, `storage.py`, and `target.py` together from the same reviewed
commit. The CLI requires Linux, root, an independent private mount namespace, and
the existing Asahi firmware handoff. It checks every visible mount namespace for
target mounts; run from the maintenance host, not a container or a restricted PID
namespace. Stop automounters and other privileged disk tools. The disk advisory
lock coordinates cooperating installer/recovery processes, not arbitrary root
programs.

Preflight mounts use Btrfs `nologreplay` and ext4 `noload` to inspect the supported
layout before filesystem recovery can write. The engine then remounts normally
and revalidates: kernel journal replay is needed to retain committed work after
a crash. A later refusal may therefore follow kernel journal replay; it must not
be described as an unconditional zero-write disk inspection. Restoration writes
remain fenced by the identity, layout, ownership and content checks.

Python 3.11 or later, Btrfs tools, util-linux, cryptsetup and rsync with ACL/xattr
support must already be available in the maintenance environment. All subprocesses
use fixed `/usr/bin` or `/usr/sbin` paths and a fixed environment. Nothing executes
from the installed or damaged root. Maintenance must expose raw SELinux xattrs:
either its kernel has no active SELinux policy, or the process has CAP_MAC_ADMIN
and its policy permits `mac_admin`. The engine refuses policy-translated label
reads. It does not disable SELinux or load a different policy.

The checkpoint profile requires Fedora, the packaged Fedora session marker,
RPMDB in `/usr/lib/sysimage/rpm` with the standard `/var/lib/rpm` symlink, the
default `/var/lib/alternatives`, and the local SELinux store in `/var/lib/selinux`.
RPM macro configuration is deliberately restricted: the database definition must
be literal at those standard locations, or Fedora's `%{_usr}/lib/sysimage/rpm`
with every `_usr` definition literally `/usr`. Parameterized definitions, arbitrary
expansion, redirected/nonregular files, and rpmrc macro-file/include directives
are refused. This is a conservative supported profile, not an interpreter or a
proof that arbitrary RPM macro programs are safe. It inspects system, vendor,
platform, host, and root's current/legacy macro locations; some otherwise harmless
custom settings may therefore require inspection instead of automatic recovery.
DNF5 main/drop-in configuration must retain the default `system_state_dir` and
`transaction_history_dir` in `/usr/lib/sysimage/libdnf5` and `persistdir` in
`/var/lib/dnf`. Configuration is read in the maintained distribution/user masking
and load order without executing target programs; redirected files are refused.
The private acceptance target uses these defaults. Custom DNF state paths,
other offline updaters, remote SELinux stores, and custom alternatives directories
are outside this adapter's supported scope.

## Maintenance invocation

In a root shell on independent maintenance Linux, enter a private mount namespace,
unlock the receipt-bound LUKS device, and mount only the owned ESP. Substitute the
verified installation's UUIDs and the root-owned reviewed source location:

```sh
/usr/bin/unshare --mount --propagation private /usr/bin/bash
/usr/sbin/cryptsetup open /dev/disk/by-uuid/LUKS_UUID harness-recovery
/usr/bin/mkdir -m 0700 /run/harness-recovery-esp
/usr/bin/mount -o rw,nosuid,nodev,noexec,umask=0077 \
  /dev/disk/by-partuuid/OWNED_ESP_PARTUUID /run/harness-recovery-esp
/usr/bin/python3 -I /root/reviewed-apple-silicon/recovery.py \
  --plan /run/harness-recovery-esp/asahi/harness-install/target.json \
  --mapper /dev/mapper/harness-recovery \
  checkpoint --id 0123456789abcdef0123456789abcdef
```

Choose a fresh 32-character lowercase hexadecimal checkpoint ID and retain it.
Supplying the same ID allows an interrupted checkpoint to resume only when its
recorded system and boot contents still match. Omitting `--id` generates an ID,
but an interruption before it is printed makes manual identification necessary.
The engine owns its temporary Btrfs and boot mounts and unmounts them on ordinary
exit; it never closes the caller's mapper or unmounts the caller's ESP.

After a failed update, return to independent maintenance, unlock and mount as
above, then select that exact checkpoint:

```sh
/usr/bin/python3 -I /root/reviewed-apple-silicon/recovery.py \
  --plan /run/harness-recovery-esp/asahi/harness-install/target.json \
  --mapper /dev/mapper/harness-recovery \
  recover 0123456789abcdef0123456789abcdef
/usr/bin/umount /run/harness-recovery-esp
/usr/sbin/cryptsetup close harness-recovery
```

Also unmount the ESP and close the mapper after successful checkpoint creation.
No password is recorded by the engine. These are maintenance commands, not a
normal user update flow or an authorization policy.

## Preservation and interruption contract

Each root-only `.harness-recovery/ID` directory on the top-level encrypted Btrfs
filesystem contains a read-only `root` checkpoint, copied `boot` and owned `efi`
files, and a durable `checkpoint.json`. Recovery first retains the failed root
as read-only `failed-root` plus `failed-boot` and `failed-efi` archives. It creates
a writable candidate from the failed root, then restores checkpoint system files
into that candidate. `/home` is never copied or replaced. `/var` remains from the
failed generation except for these paired system records:

- `/var/lib/selinux` and `/var/lib/alternatives` accompany restored policy,
  `/etc/alternatives`, RPMDB, modules, and packaged programs.
- `/var/lib/harness-os/session-setup.json`, `firstboot.json` and `firstboot.done`
  accompany the restored system login/setup configuration.
- The known root-owned DNF5 offline directories
  `/usr/lib/sysimage/libdnf5/offline` and `/var/lib/dnf/offline` and an exact
  `/system-update -> /usr/lib/sysimage/libdnf5/offline` trigger are removed from
  the candidate. Foreign triggers and insecure/redirected state stop recovery
  before deletion. The failed snapshot retains their original bytes.

The candidate must verify before boot restoration starts. `/boot` is restored
with numeric ownership, modes, ACLs and raw xattrs; its separate `efi` mountpoint
is excluded. Owned ESP paths are the `EFI/BOOT` and `EFI/fedora` trees and exactly
`m1n1/boot.bin`, `m1n1/boot.bin.old`, and `m1n1/boot.bin.new`. Other ESP files,
including other `m1n1` configuration, are preserved and checked. The engine
restores captured bytes; Fedora/Asahi still owns generating and updating the
kernel, boot chain, firmware, speaker safety services and SELinux policy.

`recovery.json` advances through `planned`, `evidence`, `candidate`, `boot`, `efi`,
`root-moved`, and `complete`, with an fsync/filesystem flush before each dependent
stage. Both original root and failed snapshot remain: the original becomes
`replaced-root` when the verified candidate becomes `root`. Interrupted copies
and either root rename can be retried from maintenance with the same ID. The
retry rejects changed workload data, archives, candidate identity/content, or
unowned ESP content. Completed recovery is a one-time operation; repeating it
returns the completion journal without rolling back later work.

An interrupted cross-filesystem restore is not guaranteed bootable. Keep the
maintenance environment and retry before normal boot. Abruptly killing only the
process can leave its private mounts alive if its namespace is still held; exit
that namespace or unmount those mounts before retrying. There is no automatic
archive deletion or disk-space reclamation. Exhausted storage may stop a stage;
retain its evidence and free unrelated space before retrying. Files copied into
an archive before its first durable manifest is written may require inspection;
unrecognized archives are never adopted or deleted automatically.

Preserving container/VM/database bytes and metadata does not guarantee an older
program can read a data format migrated by a newer program. Acceptance must cover
recovery before normal workloads resume after the failed offline update. Recovery
after arbitrary successful application or database migrations needs an explicit
compatibility plan. Per-user runtime and projects under home remain current;
packaged runtime and system account configuration revert with the checkpoint.

## Native acceptance before enablement

Run on disposable clones of the validated encrypted media installation, retaining
source/image provenance and disk/partition hashes. The native harness must use
the CLI or `with installation(plan, mapper) as engine`, with firmware substitution
restricted to its owned, serial-guarded QEMU fixture. It must not bypass target,
mount, metadata or content checks. `Engine.advance(folder, state, phase)` is a
stable test hook: call the original, then terminate the owned test process to
interrupt after a durable phase. Terminate before `advance(root-moved)` and
`advance(complete)` to cover each rename-before-journal window.

1. Seed committed SQLite data, container and VM files under `/var`, and a home
   project with hardlinks, sparse content, ACLs, and explicit SELinux labels.
   Checkpoint cold with a signed package's stock DNF5 transaction staged/armed.
2. Apply the real offline transaction, retain its package/history evidence, then
   add newer work while cold and damage owned system/boot/EFI fixture files.
   Recover and verify old RPMDB/modules/boot/EFI and paired state, current `/var`
   and home data/metadata, failed-generation evidence, and owned DNF cleanup.
3. Repeat with interruption at every durable phase, within boot/EFI copies, and
   both activation rename windows. Verify matching data after an independent
   reboot, enforcing SELinux, no failed units, and the visible session with two
   terminals and an active agent. Check protected partitions and unowned ESP
   bytes before and after each destructive fixture.
4. Refuse a wrong mapper/ESP/receipt, a mounted target (including another mount
   namespace), nested workload subvolume or mount, changed archive/candidate,
   foreign trigger, and insufficient space before boot writes when applicable.
   Record refusal and unchanged target/workload bytes.
5. Before updater integration, additionally prove a real interrupted kernel/RPM
   transaction, the offline-startup automatic checkpoint adapter, maintenance
   discovery, deliberate reboot handling, and relevant physical Apple boot-chain
   acceptance. The request adapter must reject a foreign update trigger before
   asking stock DNF5 to arm or reboot.

The state choices follow Fedora's [RPMDB relocation](https://fedoraproject.org/wiki/Changes/RelocateRPMToUsr),
[DNF5 system state](https://dnf5.readthedocs.io/en/latest/misc/system-state.7.html),
[Btrfs snapshot semantics](https://btrfs.readthedocs.io/en/latest/Subvolumes.html),
and [systemd's offline update protocol](https://www.freedesktop.org/software/systemd/man/latest/systemd.offline-updates.html).
The journal does not replace those maintained components.
