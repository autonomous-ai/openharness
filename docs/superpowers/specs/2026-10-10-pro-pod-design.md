# Harness Pro · Pod: design

Status: approved in conversation, 2026-10-10. Replaces the parked "Studio" redesign, which is dropped
entirely; nothing from it is reused.

## Goal

Give the Harness Pro (ESP32-P4, 720 × 720 ST7703 + GT911) a new UI. It borrows the look and feel of an iPod
on a white glass: covers in a grid, a numbered list you step through, one agent at a time shown like the
song that is playing, and ▶ to talk.

The words on the glass are Harness's own: **Tabs**, **panes**, **agents**, **Recap**, **Talking**.
"Album / song / lyrics" was only the design language and never appears on the device.

It replaces Harness Player 1 in the Pro build.

## Reference

- The interactive mockup is `devices/harness-device/firmware/mockup/pro-ipod.html`, which is gitignored and
  kept locally beside the main checkout. Its frames are in `mockup/pro-pod/`.
- Those frames are rebuilt with `pod_scenes.py`, which uses `scripts/gen_pets.py`'s own recipes.

Where this spec and the mockup disagree, this spec wins.

## Decisions (owner, 2026-10-10)

| Decision | Choice |
|---|---|
| Base | A new branch `feat/pro-pod` from `dev/firmware-pro` (other team's Pro firmware). Studio dropped. |
| Pets and marks | Port selectively from `main`: the dial's generated pet scenes (`pets.c`, `pets.h`), the renderer pieces they need, and the 28 px engine marks. No HPET custom pets, and no cable `0x05` change. |
| Pet drawing | Port the dial's own renderer primitives into Pod-owned files. Pod does not export flattened frames, and it does not edit the shared renderer. |
| Resources | One animated pet on the glass at any time. Everything else is rectangles, 28 px marks and text. |
| Asking | Show the question text only. It is answered in the Harness app; there are no answer buttons on the device. |
| Done | There is no "done" screen. An agent that has finished, with a recap, opens straight on its Recap. |
| Talking | There is no transcript on the glass. Engines with a listening scene show only the pet listening; engines without one show only the wave. |
| Live recap | Out of scope: a later phase. |

## Facts this design rests on (dev/firmware-pro at 07ea2fd55)

- **Renderer.** The Pro UI is the Habitat compositor, not LVGL. Scenes are up to `HT_RUNS` = 64 runs. They
  are diffed by `ht_damage` and rasterised in 24-line strips to a single PSRAM framebuffer
  (`main/ui/habitat/display_habitat.c`, `main/ui/pro_panel_bus.c:114`).
- **Player 1.** Player 1 lives in `ui_habitat.c` (7,570 lines) plus `pro_player*.inc/.h`. Navigation is one
  `s.view`. Hits are rebuilt with every render, up to 24 of them.
- **PSRAM held for nothing.** Player 1 allocates the Living and Daemon art caches at boot, about 6.4 MB of
  PSRAM (`ui_habitat.c:5175-5176`), although it never draws them.
- **Missing from this branch.** None of these exist yet: `ht_cell_frame_t`, `ht_cell_sprite(_zoom)`,
  `ht_ring_arc`, the pet shapes, pets, HPET, and Muse or Cursor marks. On `main`, `terminal.c/h` carry 15
  commits more, and the merge base is #93.
- **Cable data already on the branch** (the one gap, tab membership, is under Data flow):
  - `swarms {items[{id,name,agents,panes}], selected, tiles[{x1,y1,x2,y2,a}]}`
  - `agents.*`
  - `turn.started`, `turn.activity {text, elapsedSeconds}`, `turn.done`, `turn.error`
  - `summary {recap, restore, …}`
  - `question {questions}`
  - `player.library` (per-session status: idle, working, question, finished, failed, paused, offline)
  - the voice flow `voice.begin`, PCM `0x02`, `voice.end`, `voice.abort`
- **Fonts.** Helvetica `ht_pro_24/32/42/56` (Latin-1 plus Vietnamese) and Geist Mono.
- **Slot size.** The OTA app slot is 0x7E0000.

## Architecture

All new code lives in `devices/harness-device/firmware/main/ui/habitat/pod/`. The shared renderer files
(`terminal.c/h`, `display_habitat.c`) are not edited. The one exception is a narrowly scoped build switch,
where Player 1's entry is replaced.

| Unit | Responsibility | Depends on |
|---|---|---|
| `pod_model.c/h` | The Pod's state: tabs (names, agent ids, pane rects), agents (name, engine, machine, tab, pane index, state, elapsed, activity line, question text, recap lines, recap age), all fed from what `ui_habitat.c` already parses. Pure: no drawing, no I/O. | cable message structs |
| `pod_nav.c/h` | A real navigation stack: Tabs → Tab → Agent \| Recap \| Talking. Agent, Recap and Talking share one slot, so they replace each other. ⏮ ⏭ step through the list the stack came from. | `pod_model` |
| `pod_view_tabs.c`, `pod_view_tab.c`, `pod_view_agent.c`, `pod_view_recap.c`, `pod_view_talk.c` | One file per screen. Each builds an `ht_scene_t` and its hit list from the model, using a constant run count per screen. | `pod_draw`, `pod_pet`, `pod_model` |
| `pod_draw.c/h` | The primitives the dial's scenes need, ported from `main`'s `terminal.c`: cell frames, cell sprite and zoom, ring arc, shapes. Also Pod's own helpers: the pane diagram, the 28 px mark (on a dark chip for light marks), the equaliser, the live bar. | `terminal.h` |
| `pod_pet.c/h` | The dial's scene player, ported from `main`'s `focus.c`: step and frame per clock, dy, overlay, bars, waves, shapes, one-shot send. Picks the scene by agent state. | `pod_draw`, `pets.h` |
| `pets.c`, `pets.h`, `engine_marks.c` | Copied from `main` (`main/ui/habitat/pets.c`, and `engine28_*` from `lvgl_icons.c`), with `scripts/pod_sync_assets.sh` to refresh them. | none |

**Build.**
- The Pro build defines `DEVICE_POD=1`. With it, `habitat_scene_take` dispatches to Pod instead of the Player
  routes, and touch actions go to `pod_nav`.
- With it, the Living and Daemon caches are not allocated, and their packs are not linked.
- `POD_PANEL_TURN=180` turns the picture and the touch for the unit `E8:F6:0A:E7:63:7D`, whose panel is
  mounted upside down. It is off by default.

## Screens

Every screen has the status bar: ‹ back (or "▶ N" working on the root), the title, and the battery. The
glass is white (`#fff`), the selection a blue gradient (`#5ea2f2 → #1f63d1`), asking orange (`#ff9f0a`),
done green (`#34c759`) and recording red (`#ff3b30`). Panes are tinted: working `#e2edfd` with a blue foot,
asking `#fff1dc` with an orange foot, others `#f0f1f4`.

1. **Tabs (root).** A grid of three columns.
   - The first tile is **Working**. It has no picture: a gradient, the count, three bars and "working". Its
     orange flag shows how many agents are asking. The caption reads "N agents, every tab".
   - Then one tile per tab, drawn as its panes in the desktop's layout:
     - the selected tab uses its `tiles` rects;
     - the others use their pane count: 1, 2 side by side, 3 as one tall pane and two, or 4 as 2 × 2;
     - each pane holds its agent's 28 px mark;
     - the caption is the tab name and "N panes · ▮▮ W";
     - an orange flag shows how many agents in the tab ask.
   - The grid scrolls.
2. **Tab.**
   - The head holds the large pane diagram, "TAB", the name, and "N panes · W working · Q asking".
   - Then the agents in pane order. Each row has the pane number (or the equaliser while working), the
     mark, the name (blue while working), "engine · machine", and on the right the time, "Asks", "✓ m:ss"
     or "Idle".
   - **Working** is the same screen over every working or asking agent. Its rows add the tab name, and its
     head is the Working tile.
3. **Agent.** For an agent that is working, asking, or idle with nothing to recap.
   - The pet cover (270 px; 230 px when asking), the name, and "**Tab** · pane P · engine · machine".
   - Then by state:
     - **Working:** the live bar with m:ss and "working", and the activity line (2 lines at most).
     - **Asking:** a "Needs you" tag on the cover, and a box with the question (3 lines at most) and
       "Answer in the Harness app".
     - **Idle, no recap:** an empty bar, "idle", and "Press ▶ to talk".
4. **Recap.** An agent that is done, or idle with a recap, opens here.
   - The head has a 132 px cover with the **rest** scene (the **work** scene if the agent is working), the
     name, "Tab · pane · engine · machine", and "✓ Done · m:ss", "Idle" or "▮▮ Working · m:ss".
   - Then the recap, one sentence a line, large. The current line is ink and the others are grey. A tap
     goes to the next line and the list scrolls to keep it in view.
   - A working agent's Recap reads "The recap comes when this turn ends."
5. **Talking.**
   - The **listen** scene, large (260 px), or the red wave if the engine has no listening scene.
   - Then "Listening…" and "mark to **name** · press ■ to send".
   - ■ sends. The **send** scene plays once, then the agent is working, on the Agent screen.
   - ‹, ⏮ or ⏭ abort the recording.

**Transport** (Agent, Recap, Talking): PANES (back to the list) · ⏮ · ▶ TALK, which becomes red ■ SEND
while talking · ⏭ · RECAP. RECAP switches Agent ↔ Recap; for a finished agent, Recap is its screen. Each
hit is at least 80 px.

**Which scene, as the dial picks it:**

| Agent state | Scene |
|---|---|
| working | `working_scene` |
| asking | the engine's asking scene if it has one (Codex `waiting`), else rest |
| recap shown | rest (the small pet) |
| idle with no recap | `relaxing_scene` |
| talking | `listening_scene` |
| just sent | `sending_scene`, once |

An engine with no pet shows its mark on `#16171b`.

## Data flow

- The cable client already parses `swarms`, `agents.*`, `turn.*`, `summary`, `question` and
  `player.library`. Each parse calls one `pod_model_*` update. The model marks itself dirty and the display
  task renders as today.
- **State.** An agent's state is the newest of two sources: its `player.library` status, and the turn
  events seen since. Busy goes stale after 25 s, as today.
- **Recap.** The daemon already restores every listed agent's last recap once per link, as
  `summary {restore: true}` (`cableSession.ts` `restoreInBackground`, about :1745-1800). Pod keeps the
  newest recap per agent from those messages and from live `summary` messages. No request is added.
- **Which agents are in which tab: the one host change.** The window tells the daemon every tab's
  `agentIds` (`AppSwarms.swarms[].agentIds`, `cableSession.ts:210`). The cable only passes the count on
  (`items: {id, name, agents, panes}`, :1857).
  - Pod needs the members to draw every tab, so the daemon adds `agentIds` (in the window's order) to each
    `swarms` item.
  - Older firmware ignores the field.
  - Without it (an older daemon), Pod knows only the selected tab's agents, from `tiles`. It draws the other
    tabs as empty panes, each with a count.
  - The desktop app does not change.
- **Voice.**
  - ▶ calls the existing `A_VOICE` path for that agent id.
  - ■ calls `A_VOICE_STOP`, which sends.
  - Leaving the screen calls `A_VOICE_ABORT`.
  - The 600 s cap stays.

## Edge cases

- **No cable.** A text-only "Connecting…" with no pet. The stack is kept, and it returns there on
  reconnect.
- **The open agent disappears** (its pane closed): the screen pops to its Tab, or to Tabs if the tab is gone.
- **Empty tab:** "No panes in this tab".
- **Nothing working:** the Working tile shows "0" and "nothing working", and stays tappable.
- **Long strings** truncate with "…". The question is clamped to 3 lines, the activity to 2. A recap longer
  than the model keeps (8 sentences, 2 KB) ends with "…".
- **More than 4 panes.** The diagram draws the first four and adds a "+N" corner, and the list shows them
  all.
- **Run budget.** Every screen stays at 64 runs or fewer, with a constant count per screen. The Tabs grid
  shows at most 9 tiles per screen and scrolls for more.

## Testing

- **Host tests** under `test/run.sh`:
  - `pod_model` parsing of recorded `swarms`, `player.library`, `turn.*`, `summary` and `question` messages;
  - `pod_nav` transitions, including ⏮ ⏭ and recap-or-agent selection;
  - per-screen run counts, which are constant and at most 64;
  - an assert that one scene animates at most once per frame.
- **Reference renders.** Each screen in each state is rendered to PNG. The images are compared by eye with
  the mockup, then kept as goldens.
- **Touch tests** in `test/test_pro_touch_ui.py`: Tabs → Tab → Agent → Recap → Talking → send, ⏮ ⏭, back
  from every screen, and a recording aborted by leaving.
- **Build.** `idf.py` for the Pro with `DEVICE_POD=1`, recording the app size against the 0x7E0000 slot and
  the PSRAM free at boot (expected about 6 MB more than Player 1).
- **On the device.** Flash the unit `E8:F6:0A:E7:63:7D` with `POD_PANEL_TURN=180` and record `raster_max_us`
  on a screen change and with a pet playing. The owner checks it on the glass.

## Out of scope

- Live recap.
- Answering questions on the device.
- Stopping a running agent; the gesture is undecided, the proposal is to hold ▶.
- HPET custom pets on the Pro, and the cable `0x05` Pet/Speech collision.
- Dark glass.
- Settings, machines and models screens. Pod v1 has none; they are a later phase. The side button keeps its
  current behaviour: it aborts the voice, and a hold toggles the screen.
