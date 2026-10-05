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
model access or change providers without a task reason. The full image supplies
the default agent independently of the session RPM.

Use New Harness for another agent and New terminal for an immediate shell.
Ctrl+b, then Shift+n opens New Harness; Ctrl+b, then Shift+t opens a terminal.
Ctrl+b is a prefix: release it before the next key. Verify customized keys with
`hn list-keys`. Closing a pane and stopping an agent are different actions.

The OS keys are in `labwc/rc.xml`: Super+n opens New Harness, Super+t a terminal,
Super+m the connection flow, Super+w Wi-Fi, Super+b the browser, Super+Enter hn,
and Super+l the lock screen. Super is Command on a Mac keyboard running Linux.
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
