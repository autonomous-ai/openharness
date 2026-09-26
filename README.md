<p align="center">
  <img src="desktop/assets/app_icon.png" width="88" alt="">
</p>

<h1 align="center">Harness like a boss.</h1>

<p align="center">
  <b>The ultimate harness for coding agents and beyond.</b><br>
  Claude Code at work. Codex at home. Hermes in the cloud. One command center.<br>
  Start with code. Then follow your curiosity and build across disciplines: CAD, circuits, robots, games and music.
</p>

<p align="center">
  <a href="https://harness.autonomous.ai/desktop"><b>Download</b></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#beyond-code">Beyond code</a> ·
  <a href="#domain-specific-harnesses-dsh">Harnesses</a> ·
  <a href="#harness-device">Device</a>
</p>

### Every agent, side by side

Claude Code, Codex, Cursor, OpenCode, Devin, Amp, Copilot and seven more.

<p align="center"><img src=".github/assets/readme/agents.gif" width="960" alt="Four agents working at once in one window: Claude Code and Codex on a MacBook, Cursor on an office desktop, OpenCode on a GPU box. Each pane shows its machine, project and branch."></p>

### Every machine, side by side

Your laptop, home server and GPU box in one window. Link each one with a password.
No SSH keys. No Tailscale. No port forwarding.

<p align="center"><img src=".github/assets/readme/machines.gif" width="960" alt="A new GPU box runs four setup commands and comes online. The app links it with its password, then starts Claude Code there."></p>

### Keyboard first

⌘O finds any session on any machine. ⇧⌘I jumps to the agent waiting on you. ⌘D splits. Every key remaps.

<p align="center"><img src=".github/assets/readme/keyboard.gif" width="960" alt="Keyboard only: open a session by typing a few letters, zoom it, jump to the agent asking a question and answer it, then split a new pane below."></p>

### End-to-end encrypted

Code, keys and keystrokes are sealed on your machine. The relay forwards bytes it can't read.

<p align="center"><img src=".github/assets/readme/e2ee.gif" width="960" alt="On the left, an agent rotates a secret and redeploys. On the right, the same session as the relay sees it: numbered frames of ciphertext."></p>

### Fast and light

A native app, not Electron. Close it and your agents keep working.

Idle measurements on an M2 Max:

- **⌘N, ⌘O, ⌘T UI:** 11–13 ms median, 15–18 ms p95.
- **Local terminal echo:** 1.1 ms median, 7.2 ms p95, excluding UI rendering.
- **Desktop resources:** ~0.1% of one CPU core and 304 MiB, including terminal rendering and scrollback; agent CLIs and the daemon are excluded.

Desktop results use a Release fixture with 16 terminals and 1,000 scrollback lines each.
See the [workflow and resource benchmarks](docs/performance/2026-09-23-core-experiences.md)
and [remote P2P, TURN and relay results](docs/performance/2026-09-23-transport-routes.md)
for workloads, slow tails, connection failures and raw data.

### Built the way developers work

- **Real terminals.** Every agent runs in its own tmux pane. Scrollback, colors and keys just work.
- **Your CLIs, as they are.** Harness never wraps an agent. It reads transcripts and uses the vendor's own hooks.
- **A worktree per harness.** Start an agent on its own branch. Your working copy stays clean.
- **Remap every key.** One JSONC file, reloaded on save. Chords up to four strokes.
- **Local models.** Run open-weight models on your own machines with Grid, Ollama, MLX-LM and vLLM.
- **Bytes, not pixels.** Remote terminals stream text peer to peer. No remote desktop.
- **Open source, all of it.** App, CLI, daemon, relay and device, in this repo.

## How it works

One daemon per machine runs your agents in tmux. It dials out, so no machine opens a port.

```mermaid
flowchart LR
  subgraph laptop["Your laptop"]
    app["Harness app"] -- loopback --> d1["daemon"]
    d1 --> a1["tmux · Claude Code · Codex"]
  end
  subgraph box["Your GPU box"]
    d2["daemon"] --> a2["tmux · OpenCode · Hermes"]
  end
  device["Harness device"] -- USB --> d1
  d1 <-. "direct WebRTC" .-> d2
  d1 <-- "ciphertext" --> relay["Harness relay · no keys"]
  relay <-- "ciphertext" --> d2
```

Every path is sealed end to end: ChaCha20-Poly1305, X25519 session keys, pinned Ed25519 identities.
Harness picks the best path on its own.

**Direct.** A WebRTC channel between your machines. No server in the path.

<p align="center"><img src=".github/assets/readme/connect/direct.gif" width="800" alt="The Harness window connects straight to home-server, office-desktop, cloud-server and mac-mini over WebRTC, with no server in the path."></p>

**Through Cloudflare.** When a firewall blocks the direct path, the same encrypted channel runs over
Cloudflare's TURN network. Harness keeps trying for a direct path.

<p align="center"><img src=".github/assets/readme/connect/cloudflare.gif" width="800" alt="The encrypted WebRTC channel passes through the nearest Cloudflare edge when a firewall blocks the direct path."></p>

**Through our relay.** A fallback while WebRTC negotiates. The relay holds no keys and forwards ciphertext.

<p align="center"><img src=".github/assets/readme/connect/relay.gif" width="800" alt="The Harness relay keeps the session reachable over its WebSocket while WebRTC negotiates. It holds no keys."></p>

The [architecture guide](docs/architecture.md) has the details.

<a id="run-it"></a>
## Get started

**[Download the app](https://harness.autonomous.ai/desktop)** for macOS or Linux.

Add a machine. Run this on it, then **Machines → Link Machine** in the app:

```bash
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness login
harness remote-password set
harness start
```

<details>
<summary><b>Build from source</b></summary>

Needs Node.js 20+, tmux, Xcode and Flutter 3.47+ / Dart 3.13+:

```bash
git clone https://github.com/autonomous-ai/openharness.git
cd openharness
(cd cli && npm ci)
make install-cli
cd desktop
flutter config --enable-swift-package-manager
flutter pub get
flutter run -d macos
```

`make install-cli` installs this checkout's CLI and restarts the local daemon. See the
[development guide](docs/development.md).

</details>

<a id="beyond-code"></a>
## Beyond code: Build across disciplines

> “World-class entrepreneurs are polymaths.” — [Peter Thiel](https://www.youtube.com/watch?v=h10kXgTdhNU&t=811s)

Coding agents can build far more than software. Give one a harness and it works with the real
tools of a craft. You steer in a live viewer. Every clip below is a real session.

### Beyond code: Design

**[Blender](store/agents/blender/).** Ask for a lamp and the sliders that matter. Turn them and Blender rebuilds the geometry. Keep the versions you love.

<p align="center"><img src=".github/assets/readme/beyond/blender.gif" width="800" alt="Shape Lab in Blender: dragging height and twist sliders rebuilds a ribbon lamp, and chosen designs are kept."></p>

### Beyond code: Circuits

**[CircuitJS](store/agents/circuitjs/).** Build a filter. Change one resistor. Overlay the new trace, measure the difference and keep both.

<p align="center"><img src=".github/assets/readme/beyond/circuitjs.gif" width="800" alt="Scope Lab in CircuitJS: an RC filter captured at 1 kΩ and 2 kΩ, traces overlaid and measured with cursors."></p>

### Beyond code: Robotics

**[MuJoCo](store/agents/mujoco/).** Pin a moment in a robot's run. Shove it with 100 N. Watch two futures split.

<p align="center"><img src=".github/assets/readme/beyond/mujoco.gif" width="800" alt="A Unitree Go2 in MuJoCo: the original and shoved futures play together with a height chart."></p>

### Beyond code: Games

**[Godogen](store/agents/godogen/).** Your agent makes a playable game. Miss a jump, rewind, try again. Pin the moment so the agent sees what you mean.

<p align="center"><img src=".github/assets/readme/beyond/godogen.gif" width="800" alt="Alpine Drift, a game made with Godogen: a run is rewound, retried and a moment is pinned with feedback."></p>

### Beyond code: Music

**[Strudel](store/agents/strudel/).** The track is code you can perform. Bring voices in and out, mark the good parts, keep the WAV. [Hear it](https://github.com/user-attachments/assets/a3d4381b-5f55-406c-9d68-330cd8792fc5).

<p align="center"><img src=".github/assets/readme/beyond/strudel.gif" width="800" alt="A live Strudel performance: voice lanes play beside the code, and the take is kept with markers."></p>

### Beyond code: Chemistry

**[RDKit](store/agents/rdkit/).** Turn a bond and watch the molecule move. Follow the real energy curve. Keep the pose worth a closer look.

<p align="center"><img src=".github/assets/readme/beyond/rdkit.gif" width="800" alt="A bond scan in RDKit: the molecule rotates through sampled poses along an MMFF94 energy curve."></p>

### Beyond code: Documents

**[Typst](store/agents/typst/).** Your agent writes a real PDF. Circle a detail, quote a line, leave a note. The next draft answers it.

<p align="center"><img src=".github/assets/readme/beyond/typst.gif" width="800" alt="A Typst PDF under review: notes are pinned to an area and a sentence, then carried to the next draft."></p>

### Beyond code: Data

**[Jev Sheets](store/agents/jev-sheets/).** Test a question on a few frozen rows before you ask the whole sheet. Compare two wordings side by side.

<p align="center"><img src=".github/assets/readme/beyond/jev-sheets.gif" width="800" alt="Question Lab in Jev Sheets: two wordings of a question are compared on frozen rows, recorded with practice data."></p>

## Domain-specific harnesses (DSH)

Code is the common medium. Geometry scripts make parts. Netlists make boards. Animation code makes film.

A **domain-specific harness** turns a coding agent into a specialist. It brings the craft's
instructions and skills, a pinned toolchain, a project template, checks and a **live viewer**.
You chat on one side. The board, the part or the game takes shape on the other.

The agent does the reasoning. The harness brings the tools and the view. It's a folder with a
`harness.json`, so adding a craft never touches the app.

<!-- store-catalog:start -->
### 49 harnesses in the Store

| Category | Agents and harnesses |
|---|---|
| **Coding** | [Claude Code, Codex, Cursor, OpenCode, Pi, Hermes, Command Code, Devin, Muse Code, Amp, Antigravity, GitHub Copilot, Grok Build, Kilo Code](docs/engines.md), [Harness Monitor](store/agents/harness-monitor/), [Machine Monitor](store/agents/machine-monitor/) |
| Design | [Autonomous Workshop](store/agents/autonomous-workshop/), [Blender](store/agents/blender/), [Bonsai MCP](store/agents/bonsai-mcp/), [Creative Direction](store/agents/creative-direction/), [Excalidraw](store/agents/excalidraw/), [FreeCAD](store/agents/freecad/), [Generative Art](store/agents/generative-art/), [OpenSCAD](store/agents/openscad/), [text-to-cad](store/agents/text-to-cad/) |
| Engineering | [Autonomous Circuit](store/agents/autonomous-circuit/), [CircuitJS](store/agents/circuitjs/), [Home Assistant](store/agents/home-assistant/), [KiCad](store/agents/kicad/), [Orca Slicer](store/agents/orca-slicer/), [Yosys](store/agents/yosys/) |
| Media | [Comfy MCP](store/agents/comfy-mcp/), [Manim](store/agents/manim/), [OpenMontage](store/agents/openmontage/), [Remotion](store/agents/remotion/) |
| Music | [Ableton AI](store/agents/ableton-ai/), [JUCE Agent Toolkit](store/agents/juce-agent-toolkit/), [Music Studio](store/agents/music-studio/), [Score](store/agents/score/), [Strudel](store/agents/strudel/) |
| Productivity | [Jev Sheets](store/agents/jev-sheets/), [Marp](store/agents/marp/), [Typst](store/agents/typst/) |
| Science & Data | [autoresearch-mlx](store/agents/autoresearch-mlx/), [Data Studio](store/agents/data-studio/), [Lab Bench](store/agents/lab-bench/), [marimo](store/agents/marimo/), [RDKit](store/agents/rdkit/) |
| Simulation | [DimOS](store/agents/dimos/), [Drone Pilot](store/agents/drone-pilot/), [Foam-Agent](store/agents/foam-agent/), [MuJoCo](store/agents/mujoco/), [SimSkill](store/agents/simskill/) |
| Games | [Game Master](store/agents/game-master/), [Godogen](store/agents/godogen/), [Phaser](store/agents/phaser/), [Voxel Worlds](store/agents/voxel-worlds/) |
| Research | [Jev Browser](store/agents/jev-browser/), [Roundtable](store/agents/roundtable/) |
| Local AI | [Grid](store/agents/autonomous-grid/), [MLX-LM](store/agents/mlx-lm/), [Ollama](store/agents/ollama/), [vLLM](store/agents/vllm/) |

Upstream open-source tools and original workflows. 10 [shared viewers](store/viewers/) install alongside
the harnesses that need them. Unlisted experiments are not shown.
<!-- store-catalog:end -->

### Build your own

The next harness is the one for your craft. Wrap a tool you love or your team's toolchain.
It can live here or in your own repo. From this repo:

```json
{
  "spec": 1,
  "id": "examples/hello-world",
  "name": "Hello World",
  "engine": "codex",
  "workspace": { "template": "template", "marker": "index.html" },
  "agent": { "instructions": "AGENTS.md" },
  "viewer": { "use": "autonomous/web-viewer" }
}
```

```bash
harness dsh install "$PWD/store/viewers/web-viewer" --link
cp -R store/examples/hello-world ../my-harness
harness dsh check ../my-harness
harness dsh install ../my-harness --link
```

Press **⌘N → Hello World** and say hello. The [authoring guide](store/README.md) covers the rest.

## Harness device

[**Get a Harness device**](https://www.autonomous.ai/harness-device), or build your own from the files below. The
[firmware guide](devices/harness-device/firmware/README.md) lists the supported boards and build
commands, and the [hardware guide](devices/harness-device/hardware/README.md) covers the design files.

<p align="center"><img src=".github/assets/readme/device.gif" width="960" alt="A finger taps the round Harness device, speaks a task to fix the login flow, and the device shows the agent deploying, then a summary of the shipped fix."></p>

The optional **Harness device** is a round, always-on display that sits beside
your keyboard and shows your agents at a glance: what each one is doing, which one has finished, and
which one is waiting on you. Read a question and answer it on the screen, or tap and speak a new task,
without switching windows.

It is open hardware, all the way down. This repository has everything it takes to build one:

| Layer | What's here |
|---|---|
| [Firmware](devices/harness-device/firmware/) | ESP32-S3, ESP-IDF, a 466 × 466 round AMOLED with touch, microphones and audio. Connects to the host's daemon over USB — no Wi-Fi setup, no account on the device. |
| [PCB](devices/harness-device/hardware/pcb/) | The EasyEDA Pro project, the schematic, Gerbers, the bill of materials, and pick-and-place data for assembly. |
| [Enclosure](devices/harness-device/hardware/3d/) | STEP for editing and STL for printing: the housing, an iron counterweight base, the USB clamp, and the button. |

## Contribute

Make a harness for a tool you love. Improve terminals, engines, the daemon or the relay. Port the
firmware. Start with the [contribution guide](CONTRIBUTING.md).

[Development](docs/development.md) · [Extending](docs/extending.md) · [CLI](docs/cli.md) ·
[Security](SECURITY.md) · [MIT license](LICENSE); upstream tools keep their own.
