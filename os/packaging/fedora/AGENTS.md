# Harness

The user works in hn agent panes and ordinary terminals. Keep the system small.
Open `hn-browser URL` only when a browser helps. Add tools for the task at hand;
start extra services only when needed. Preserve the user's projects, instructions
and running agents. Read `guide.md` and the shipped TUI reference before advising.

## System operations

- This session runs on Fedora. Read `/etc/os-release` and
  `/usr/share/harness-os/runtime.json` for its system and package provenance.
- `harness updates` and Super+u update the per-user hn/CLI runtime. Verified
  downloads are prepared in the background; activation is explicit and preserves
  agent and terminal processes. The packaged runtime remains the fallback.
- This integration package does not implement Fedora base-system updates,
  installation, snapshots or recovery. Use Fedora/Asahi's maintained system
  tools and documentation. Do not use the PC USB installer or Arch commands.
- Fedora owns its RPM database, kernel, boot chain, firmware, device trees and
  platform services. Do not replace these with components from the PC image.
  Preserve Asahi's audio configuration, including asahi-audio and speakersafetyd.
- Do not replace `/usr/lib/harness` by hand. Package upgrades take effect on a
  later session; they must not kill the running agents or enable a second updater.
- `harness-session` starts the session explicitly from a logged-in local console.
  Installing the package does not create users, change passwords or enable
  autologin. The private `harness-session-setup enable --user USER --autologin`
  path explicitly selects an existing local account and Fedora's greetd/PAM
  login stack for the next boot. Read the setup section in `guide.md` first.
  Preserve its recovery receipt, existing account authentication and SELinux
  policy. `harness-session-setup disable` restores the previous login policy;
  disable before removing the session RPM. Never overwrite conflicting settings.

## Network, tools and diagnosis

- Fedora's NetworkManager owns networking. `hn-os wifi` opens the root-owned
  network form through sudo; passwords stay in its masked input. Explicit login
  setup grants only that form's two exact commands to the selected user. Do not
  add a global wheel grant or arbitrary sudo/polkit permission.
- PipeWire owns audio. Clipboard tools are `wl-copy` and `wl-paste`.
- Chromium is optional and remains sandboxed. Install ordinary task dependencies
  through Fedora's package manager; keep existing security policy enabled.
- OpenCode is bundled in this RPM with verified upstream bytes and its license.
  `/usr/share/harness-os/opencode.json` records its exact version and checksums.
  It uses upstream model defaults and normal provider authentication; preserve
  the user's credentials and instructions. Update the packaged binary through
  RPM, not by overwriting `/usr/lib/harness-opencode` or running npm as root.
- `hn-os status`, `hn-os measure`, and `systemctl --user status hn-screen
  harness-daemon` report session state. Use `journalctl --user -u hn-screen
  -u harness-daemon` for logs. Reconnect a failed screen before restarting agents.
- A VM result does not establish Apple hardware, suspend, audio, firmware,
  installation or recovery support. Report the actual test environment.
