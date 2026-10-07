# Helping someone use Harness

The user works in hn, with an agent or terminal in each pane. A browser is
available when graphical work helps. This Fedora session package is a component
of the future Apple Silicon Harness OS image; it is not an installer or a claim
of hardware support.

Read `/usr/share/harness-os/runtime.json` for the runtime and package source
commits, `/etc/os-release` for Fedora identity, and `AGENTS.md` beside this guide
before changing the system. The complete shipped TUI reference is `guide/tui.md`;
`guide/source.json` identifies its source. `hn list-keys` and `hn list-commands`
describe the actual running version. Preserve the user's existing instructions.

Help the user accomplish their task directly. Create projects under `~/projects`.
Agents use their normal model selection and authentication; do not promise free
model access or change providers without a task reason. The session RPM includes
OpenCode and its upstream license. Its pinned binary and package checksums are
recorded in `/usr/share/harness-os/opencode.json`; no agent download is needed to
open the first pane. Conversations with remote models still need a connection.

Use New Harness for another agent and New terminal for an immediate shell.
Ctrl+b, then Shift+n opens New Harness; Ctrl+b, then Shift+t opens a terminal.
Ctrl+b is a prefix: release it before the next key. Verify customized keys with
`hn list-keys`. Closing a pane and stopping an agent are different actions.

The OS keys are in `labwc/rc.xml`: Super+n opens New Harness, Super+t a terminal,
Super+m the connection flow, Super+w Wi-Fi, Super+b the browser, Super+e the file manager, Super+o opens a folder or file, Super+Enter hn,
and Super+l the lock screen. Print or Super+p saves a screenshot, Shift+Print or
Super+r a region, to `~/Pictures/Screenshots` and the clipboard. Super is Command
on a Mac keyboard running Linux.
Brightness and audio keys operate supported hardware. These are Linux session
bindings, not macOS shortcuts.

Super+u and `harness updates` activate verified per-user hn/CLI updates while
keeping the agents and terminals alive. Fedora base-system updates and recovery
are outside this package. Do not suggest the PC whole-disk USB flow, Arch package
commands or PC recovery helpers on Fedora. Follow Fedora/Asahi guidance for the
base system; do not describe a private VM as physically tested hardware support.

Use `hn-browser URL` when a browser helps. Chromium is optional and sandboxed.
Use `hn-os wifi` for networking and keep passwords in its masked form. Package
installation does not change accounts, start a session or replace system policy.

## Private Fedora login setup

This development path starts from an existing Fedora Asahi Remix Minimal install
made with [Asahi's installer](https://asahilinux.org/fedora/). It does not install
Fedora or establish physical Mac support. Fedora/Asahi continues to own the boot
chain, firmware, kernel, device trees, audio safety, base updates and recovery.
Keep macOS and Apple recovery available; do not use the PC installer on this path.

Install the verified private session RPM, then install Fedora's `greetd` package
with `sudo dnf install greetd`. Fedora supplies its PAM configuration and, on a
system with the targeted SELinux policy, its matching `greetd-selinux` dependency.
Keep those policies enabled and unchanged. OpenCode is included; Chromium is a
separate prerequisite for the optional browser.

Choose an existing local account with a usable password and existing permission
to run setup through sudo. First verify its password login and sudo from another
console, such as Ctrl+Alt+F2. Then explicitly enable next-boot autologin:

```sh
sudo harness-session-setup enable --user EXISTING_USER --autologin
sudo harness-session-setup status
```

This allows console access to that account after Fedora boots. Existing disk
encryption remains separate. The command does not create users, change passwords,
edit home directories or shell profiles, or interrupt the current session. It
uses Fedora's greetd service, display-manager alias and graphical target. It
refuses conflicting login configuration and saves the previous target. The
initial login happens once per boot; signing out returns to password login.

The selected account receives permission for only the two fixed invocations of
the root-owned Harness Wi-Fi form, including first use. No other sudo permission,
NetworkManager setting, DNS policy or audio configuration is changed.

To restore the previous login setup, use an authenticated console:

```sh
sudo harness-session-setup disable
```

The change takes effect at the next boot. This also removes the selected account's
managed Wi-Fi permission. The package itself remains installed. Disable before
removing the session RPM. If setup was interrupted, the same command restores the
recorded state. If an administrator edited a managed file, setup preserves it and
stops; inspect the named file and `/var/lib/harness-os/session-setup.json` before
resolving the difference. Never discard that receipt to force a reconfiguration.
