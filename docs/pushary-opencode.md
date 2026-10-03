# Phone approvals for OpenCode with Pushary

Use [Pushary](https://pushary.com) alongside Harness to answer an OpenCode permission request
from your phone. Harness keeps its discovery plugin; Pushary installs a separate plugin that
replies to OpenCode's native permission request. This is optional: Harness already has its own
browser, mobile and physical-device interfaces.

## Before starting

- Install Harness and OpenCode, and configure the model provider you normally use.
- Use the same machine and OS user for Harness, OpenCode and Pushary.
- Have a Pushary operator account with an active trial or subscription and a connected phone.
  Pushary is a separate hosted service. See its [setup and billing information](https://pushary.com).
- Use a disposable workspace. `pushary@1.9.4` uses OpenCode's active directory for
  approval context, including non-Git workspaces and nested repository folders.
  Keep your existing configuration and permissions.

## Connect the existing integration

On a machine already connected to Pushary, check it first:

```sh
npx pushary@1.9.4 status --json
npx pushary@1.9.4 doctor
```

If OpenCode is not connected, or you installed its Pushary plugin before 1.9.4, run setup
to generate the current plugin and select OpenCode:

```sh
npx pushary@1.9.4 setup --agents opencode
```

Setup can install the CLI globally and create a per-user service. Run it explicitly as the
operator; do not hide it inside a Store package's toolchain. Pair through the normal setup
flow if necessary. Restart OpenCode after installation.

Keep both plugin files. In the default config directory they are:

```text
~/.config/opencode/plugin/launcher-register.js
~/.config/opencode/plugins/pushary.js
```

Harness also installs a separate OpenCode 2 TUI discovery file. Do not delete another plugin
or replace the whole config directory. Custom OpenCode config locations need both installers
to target the same directory; check their actual paths instead of assuming these defaults.

## Launch in Ask mode

Harness defaults OpenCode to Auto mode, which adds `--auto`. For this workflow, choose
**Ask first** under New Harness → Advanced, or launch from the CLI with an explicit mode:

```sh
cd /path/to/disposable-workspace
harness new opencode --mode ask
```

Ask mode leaves OpenCode's own permission configuration in charge. For a selected shell
operation to produce a native request, merge this rule into the disposable workspace's
`opencode.json`, preserving other settings:

```json
{
  "permission": {
    "bash": "ask"
  }
}
```

Pushary's existing delivery policy still determines whether a phone question, notification,
or terminal handoff is used. Auto-allow rules remain effective. Connecting a server or seeing
a notification does not establish that an operation waited for a human.

## Try one harmless operation

Use a new disposable workspace with no `phone-approval.txt`. Ask OpenCode:

```text
Run printf 'approved\n' >> phone-approval.txt once using the bash tool.
```

While the native request is pending, the file should not exist. Approve the specific request
on the configured answer surface; the expected result is one line in the file. In a second
new workspace, repeat and deny: the file should remain absent. Unanswered requests follow
the configured timeout/handoff policy; they must not be reported as human approvals.

Confirm that Harness still sees the same session. Answering a request in OpenCode first
should withdraw its phone question; an old phone reply must not execute another command.
Repeat from a new OpenCode process to check that both installed plugins remain available.

## Verification boundary

On October 2, 2026 (UTC), a disposable macOS ARM64 check used OpenCode 1.18.34, published
`pushary@1.9.4`, and the Harness installer at
`e1e9e2fa02d18dc50c2b9ce996417614d42f9cef`. The Pushary plugin and hook came from the
registry-installed package, without source injection. A real OpenCode server ran a
deterministic local model and decision fixture in both a non-Git workspace and a nested Git
repository folder. The active workspace name appeared in each approval. Approval
created one harmless receipt in each workspace; denial, cancellation, expiry, unanswered timeout and a terminal
withdrawal created none. Settled native requests rejected replay. A new process loaded both
plugins, and the Harness discovery plugin sent the same session id to a recording local
endpoint. This does not certify an authenticated Harness daemon, relay or mobile UI session.

The hosted Pushary MCP endpoint passed authenticated initialization and tool discovery. A
separate live native approval attempt did not settle within a 115-second test window and made
no file change; it did not establish a completed phone round trip. No Autonomous hardware
was tested. Device support, shipping consumer images and OS-level approval settings need
their own checks. Pushary's separate network delivery does not inherit Harness's E2EE.

For the native event and server APIs, see [OpenCode plugins](https://opencode.ai/docs/plugins/)
and [OpenCode server](https://opencode.ai/docs/server/).
