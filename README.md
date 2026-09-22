<p align="center">
  <img src="desktop/assets/app_icon.png" width="88" alt="">
</p>

<h1 align="center">OpenHarness</h1>

<p align="center">
  <b>The terminal for coding agents.</b><br>
  Every agent. Every machine. One fast, keyboard-first window.
</p>

<p align="center">
  <a href="https://harness.autonomous.ai/desktop"><b>Download</b></a> ·
  <a href="#get-started">Get started</a> ·
  <a href="docs/keyboard.md">Keybindings</a> ·
  <a href="docs/architecture.md">How it works</a> ·
  <a href="#beyond-code">Beyond code</a>
</p>

### Every agent, side by side

Claude Code, Codex, Cursor, OpenCode, Devin, Amp, Copilot and seven more. Your subscriptions, your keys.

<p align="center"><img src=".github/assets/readme/agents.gif" width="960" alt="Four agents working at once in one window: Claude Code and Codex on a MacBook, Cursor on an office desktop, OpenCode on a GPU box. Each pane shows its machine, project and branch."></p>

### Every machine, no SSH

Laptop, home server, GPU box. Four commands on the new machine, one Enter in the app.
No SSH. No Tailscale. No open ports.

<p align="center"><img src=".github/assets/readme/machines.gif" width="960" alt="A new GPU box runs four setup commands and comes online. The app links it with its password, then starts Claude Code there with one Enter."></p>

### Keyboard first

⌘O finds any session on any machine. ⇧⌘I jumps to the agent waiting on you. ⌘D splits. Every key remaps.

<p align="center"><img src=".github/assets/readme/keyboard.gif" width="960" alt="Keyboard only: open a session by typing a few letters, zoom it, jump to the agent asking a question and answer it, then split a new pane below."></p>

### End-to-end encrypted

Code, keys and keystrokes are sealed on your machine. The relay forwards bytes it can't read.

<p align="center"><img src=".github/assets/readme/e2ee.gif" width="960" alt="On the left, an agent rotates a secret and redeploys. On the right, the same session as the relay sees it: numbered frames of ciphertext."></p>

### Fast and light

A native app, not Electron. Real terminals on tmux. Close the app and your agents keep working.

## Beyond code

**Coding agents can build far more than software.** Give one a harness and it models in Blender,
simulates robots in MuJoCo and performs music in Strudel. You steer in a live viewer.

<p align="center"><a href="docs/hands-on.md"><img src=".github/assets/readme/beyond-code.gif" width="960" alt="Eight real sessions, one after another: Blender, MuJoCo, Godogen, CircuitJS, RDKit, Strudel, Typst and Jev Sheets."></a></p>

Monday, a feature. Tuesday, an enclosure. Wednesday, the launch video.
For the curious engineer who wants to build beyond software. [Try one in ten minutes](docs/hands-on.md).

<details>
<summary><b>More things made with Harness</b></summary>

<!-- store-showcase:start -->
<p align="center">
  <a href=".github/assets/store/showcase.gif"><img src=".github/assets/store/showcase.gif" width="1280" alt="Six real harness outputs, shown one at a time with their harness name and complete prompt: Autonomous Circuit, text-to-cad, MuJoCo, Blender, Godogen, and Manim."></a>
</p>

Six real outputs, one at a time. Each slide includes the harness and the original prompt.
[Still preview](.github/assets/store/showcase-poster.png) · Individual images and prompts below.

<details>
<summary>Read the prompts and open individual images</summary>

**[Autonomous Circuit](store/showcase/autonomous-circuit/six-key-macropad.jpg)** · [Open harness](store/agents/autonomous-circuit/)

> Design a six-key USB macropad. Start with the schematic.

**[text-to-cad](store/showcase/text-to-cad/planetary-gear-set.jpg)** · [Open harness](store/agents/text-to-cad/)

> Design a 3D-printable planetary gear set: a 12-tooth sun, three 18-tooth planets and a 48-tooth ring gear with mounting lugs, module 1.5 and 8 mm thick, plus a carrier on steel pins. Give each part its own colour.

**[MuJoCo](store/showcase/mujoco/g1-humanoid-hello.jpg)** · [Open harness](store/agents/mujoco/)

> Make the Unitree G1 humanoid say hello: stand, raise its right hand and wave three times, then lower it and take a small bow. Record it.

**[Blender](store/showcase/blender/cozy-reading-nook.jpg)** · [Open harness](store/agents/blender/)

> Make a cozy isometric reading nook: a cut-away corner of a room with an armchair, a floor lamp glowing warm, a bookshelf full of colourful books, a round rug and a monstera, with evening sun through the window and a cat asleep on the rug.

**[Godogen](store/showcase/godogen/neon-drift.jpg)** · [Open harness](store/agents/godogen/)

> Make a synthwave hoverbike racer: ride down a neon grid canyon toward a striped setting sun, weave between glowing pylons, hop barriers and collect energy cores, with a boost and three shields.

**[Manim](store/showcase/manim/fourier-knight.jpg)** · [Open harness](store/agents/manim/)

> Draw a chess knight using nothing but spinning circles: a Fourier series of 120 epicycles, tip to tail, tracing its silhouette in gold.

</details>
<!-- store-showcase:end -->

</details>

<a id="run-it"></a>
## Get started

1. [Download the app](https://harness.autonomous.ai/desktop) for macOS or Linux.
2. Sign in to an agent you already use.
3. Press **⌘N**, type a task, press **Return**.

Add a machine. Run this on it, then **Machines → Link Machine** in the app:

```bash
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness login
harness remote-password set
harness start
```

macOS is the primary platform. Linux builds work with parity in progress; Windows is in progress. Live viewers need macOS.
The app needs a Harness account for now; [account-free local use is tracked](docs/development.md#account-free-local-use).

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

<details>
<summary><b>How it fits together</b></summary>

```mermaid
flowchart LR
  app["Harness app<br/>(Flutter)"] -- loopback --> daemon["harness daemon<br/>(TypeScript)"]
  daemon --> tmux["tmux"] --> agents["Claude Code · Codex · OpenCode · …"]
  daemon --> dsh["harness toolchain<br/>+ live viewer"]
  daemon <-- "E2EE · WebRTC" --> relay["Harness relay"]
  relay <--> remote["daemons on your<br/>other machines"]
```

Each daemon dials out to the relay, so no machine opens a port. Frames are sealed with
ChaCha20-Poly1305 under X25519 session keys and pinned Ed25519 identities. Terminal traffic goes
peer to peer over WebRTC when the network allows. Details in the [architecture guide](docs/architecture.md).

</details>

<a id="domain-specific-harnesses-dsh"></a>
## Build a harness

A harness turns a coding agent into a specialist: instructions, a pinned toolchain, a project
template and a live viewer, in one folder. Adding a craft never touches the app.

```bash
harness dsh install "$PWD/store/viewers/web-viewer" --link
cp -R store/examples/hello-world ../my-harness
harness dsh check ../my-harness
harness dsh install ../my-harness --link
```

Press **⌘N → Hello World** and say hello. The [authoring guide](store/README.md) covers the rest.

<details>
<summary><b>Browse every harness in the Store</b></summary>

<!-- store-catalog:start -->
### Coding and beyond

Start with a coding agent you already use. Explore 49 domain-specific harnesses when your
next idea takes you further.

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

These are the 49 harnesses currently listed in the Store catalog. They combine upstream
open-source tools and original workflows, with instructions, setup, checks, and live views for each craft.

The 10 [shared viewers](store/viewers/) cover CAD, 3D models, documents, games, film, video,
MuJoCo, web pages, isolated web previews, and studios. Viewer packages install alongside the
harnesses that need them. Experimental packages marked unlisted are not included above.
<!-- store-catalog:end -->

</details>

## Harness device

<p align="center"><img src=".github/assets/hardware/answer.jpg" width="720" alt="A finger taps the round Harness device to answer an agent"></p>

A round screen beside your keyboard. See who's working, who's done and who needs you. Answer with a tap
or your voice. Open hardware: [firmware](devices/harness-device/firmware/),
[PCB](devices/harness-device/hardware/pcb/), [enclosure](devices/harness-device/hardware/3d/).
[Get one](https://www.autonomous.ai/harness) or build your own.

## Contribute

Make a harness for a tool you love. Improve terminals, engines, the daemon or the relay. Port the
firmware. Start with the [contribution guide](CONTRIBUTING.md).

[Development](docs/development.md) · [Extending](docs/extending.md) · [CLI](docs/cli.md) ·
[Security](SECURITY.md) · [MIT license](LICENSE); upstream tools keep their own.
