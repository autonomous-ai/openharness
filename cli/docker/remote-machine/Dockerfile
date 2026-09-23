# A second harness machine, in a box.
#
# This exists to exercise the ONE path a single laptop cannot reach on its own: the app talking to a
# machine that is not the machine it is running on. Frames leave the desktop's local daemon, cross the
# backend relay (`cli/src/lib/remoteRelay.ts`), and are handled by the daemon in here. Nothing is
# stubbed — this container is a real machine on a real account, and the app cannot tell it apart from
# a second laptop.
#
# ## Two things about this image are load-bearing
#
# 1. **It carries the bundle from YOUR working tree, and self-update is off.** A container that
#    updated itself would pull the published release, and a feature that has not shipped yet — the
#    grid launch this rig was built to test, for one — would simply not be in it. The test would then
#    fail for a reason that has nothing to do with the code under test, which is the worst kind of
#    red. `ADAPTER_UPDATE_DISABLE=true` lives in the launcher, exactly as `install-cli.sh --no-updates`
#    writes it on a real box.
#
# 2. **Code and state are deliberately on opposite sides of the volume.** The CLI is baked at
#    `/opt/harness/cli`; the mutable state — computer id, SSO session, session registry — lives under
#    `$HOME/.harness`, which is where the volume mounts. Putting the code in its default home instead
#    would mean the volume SHADOWS `cli.js` on the second run, and the container would come up empty
#    with no obvious cause.
#
# Runs as the unprivileged `node` user (uid 1000, already in the base image) rather than root, because
# Claude Code refuses `--dangerously-skip-permissions` when it is root — and that flag is reachable
# from the app's New agent dialog, so a root container would quietly take a testable option away.
#
# ⚠️ **Debian 13 (trixie), not 12 (bookworm), because of the grid.** The managed `grid` the CLI
# downloads for linux-arm64 is linked against glibc 2.38; bookworm ships 2.36, so on this box grid
# never ran at all — `GLIBC_2.38 not found`, a `.unrunnable` marker, and "no grid after 5 attempts" in
# the daemon's log — and nothing grid-backed could be tested here. trixie ships 2.41.
FROM node:22-trixie-slim

# A UTF-8 locale, because the base image has none.
#
# `node:22-trixie-slim` sets no LANG, which leaves `LC_CTYPE=POSIX` — and a program that decides
# what it may draw from the locale rather than from the terminal takes its ASCII path there. tmux
# negotiates UTF-8 with the client either way (`client_utf8=1` on this box), so the damage is not the
# box-drawing a terminal shows; it is every engine, and every tool an agent runs inside one, that
# reads the locale first and quietly degrades. A real developer machine has a UTF-8 locale, and this
# container stands in for one.
#
# `C.UTF-8` rather than `en_US.UTF-8`: Debian ships it built in, so this needs no `locales` package
# and no `locale-gen` layer, and it imposes no language on an agent's output.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# tmux: the daemon discovers and drives agents through it, so there is no agent without it.
# procps: `ps` — the CLI reads a live engine's environment to answer "which grid is this agent on?"
#   (`lib/processEnv.ts`). On Linux it reads /proc directly, but ps is what makes the same question
#   answerable by hand when a test disagrees with the daemon.
# git + ca-certificates + curl: what an engine expects to find on a developer box.
# socat: the SSO callback listener binds the container's LOOPBACK (as it should — see
#   ADAPTER_LOGIN_CALLBACK_PORT), but Docker publishes a port to the container's eth0, so nothing
#   from the host can ever reach a loopback bind. socat bridges exactly that gap, on the container
#   side, for the duration of a sign-in. Doing it here rather than teaching the CLI to bind 0.0.0.0
#   keeps a real computer's SSO callback on its own loopback, where it belongs.
# tini: pid 1. Every engine a stopped agent leaves behind is orphaned to pid 1, and only a real init
#   reaps it — see the ENTRYPOINT below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       tmux procps git curl ca-certificates less socat tini \
  && rm -rf /var/lib/apt/lists/*

# The engine under test. Pinned by the build so a rebuild is reproducible; bump it deliberately.
ARG CLAUDE_CODE_VERSION=2.1.260
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# ── The CLI, in the same shape `install-cli.sh` produces on a real box ────────────────────────────
# Built from the working tree by scripts/remote-machine.sh; see that script for the version label.
ENV ADAPTER_CLI_DIR=/opt/harness/cli
RUN mkdir -p /opt/harness/cli && printf '{"type":"module"}\n' > /opt/harness/cli/package.json
COPY dist/cli.js dist/notify.mjs /opt/harness/cli/

# The launcher, copied from `install-cli.sh --no-updates`. The pin is the point: see note 1 above.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# Container install, PINNED. Self-update is off so this box keeps the bytes it was built with;' \
      '# see cli/docker/remote-machine/Dockerfile for why that is not optional here.' \
      'ADAPTER_UPDATE_DISABLE=true' \
      'export ADAPTER_UPDATE_DISABLE' \
      'exec node /opt/harness/cli/cli.js "$@"' \
    > /usr/local/bin/harness \
  && chmod 755 /usr/local/bin/harness

# State lives under the volume; code does not. Both halves of note 2.
ENV ADAPTER_DATA_DIR=/home/node/.harness/data
RUN mkdir -p /home/node/.harness/data && chown -R node:node /home/node/.harness

# Get Claude Code past the two first-run prompts, and nothing else.
#
# A box with no `~/.claude.json` opens on the theme picker, and then on "do you trust this folder?".
# Either one leaves the engine sitting at a prompt, which the daemon correctly reads as an agent that
# is BUSY — so `agent_retarget` refuses it and the rig cannot test the one thing it was built to test.
#
# This is the container standing in for a developer's already-used machine, not a decision being made
# on anyone's behalf. The trust entry covers exactly ONE directory: /home/node/work, which this image
# created and which only ever holds what a test puts there. That is deliberately narrower than what
# `gridLaunch.ts` refuses to do on a real computer — pre-trusting whatever folder a person happens to
# open an agent in — and the difference is the whole justification.
#
# It carries NO credential. An agent in here can reach a model only through the grid environment the
# daemon hands it at launch, which is precisely what makes this rig's answer trustworthy.
RUN mkdir -p /home/node/work \
  && printf '%s\n' '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"/home/node/work":{"hasTrustDialogAccepted":true}}}' \
     > /home/node/.claude.json \
  && chown -R node:node /home/node/.claude.json /home/node/work

# ── A global npm prefix the `node` user can actually write to ─────────────────────────────────────
#
# An engine the daemon cannot find is installed on the spot, in the agent's own terminal: see
# `lib/engineInstall.ts`, which shells out to `npm install -g <pkg>` for codex, opencode, pi, kilo,
# copilot and the rest. npm's prefix here is /usr/local, which belongs to root — and this image runs
# as `node` (see the header), so every one of those installs died with EACCES and left the agent
# staring at an npm stack trace instead of an engine. Pre-baking one package would fix codex and
# nothing else; a writable prefix fixes the mechanism, for every engine the CLI knows how to install.
#
# Deliberately NOT under /home/node/.harness: that volume outlives an image rebuild, so an engine
# cached there would survive the very rebuild meant to change it — the staleness note 1 exists to
# prevent. Re-fetching an engine when the box is recreated is the correct cost. Claude Code above
# stays in /usr/local, baked and pinned, untouched by this.
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:$PATH
RUN mkdir -p /home/node/.npm-global/bin && chown -R node:node /home/node/.npm-global

COPY --chown=node:node docker/remote-machine/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

USER node
WORKDIR /home/node
VOLUME ["/home/node/.harness"]

# ⚠️ **tini is pid 1, not the entrypoint, and a real computer's init is what it stands in for.** The
# entrypoint used to `exec tail -f /dev/null` as pid 1, and tail never calls wait(): every engine
# orphaned when its agent stopped stayed a zombie for the life of the box — with the pid, name and
# start time of the engine it had been. The daemon's identity check read that as the engine still
# running, and refused to resume the agent ("The previous process is still running"). tini reaps
# them, and forwards `docker stop`'s SIGTERM to the entrypoint as tail's pid-1 role did.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
