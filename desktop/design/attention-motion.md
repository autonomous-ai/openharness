# Attention motion and branding

The pane frame, the spend ring, the fleet overview and the boot splash share one visual language.
They were designed and first built by Fred Nix ([@nixfred](https://github.com/nixfred)) in his fork,
[github.com/nixfred/openharness](https://github.com/nixfred/openharness) (MIT). His rule: a lot of
graphics are welcome, but never a graphic that carries no function. Every ring, arc or glow here
answers a question a person has at that moment; where a screen is only text, it stays text.

## The language

- **One ring per agent, everywhere.** Its colour and motion are the agent's attention state, as the
  daemon reports it (`cli/src/lib/attention.ts`, the local `attention` frame): working, waiting on
  you, needs permission, failed, done (unreviewed), idle, offline.
- **Arcs are quantities.** Spend runs from 0 to 100 percent of a cap, turns amber at 80 percent and
  holds red at the cap. Never a bare number where an arc can be read.
- **Glow is urgency.** Only what needs a person next glows.
- **Scanlines and grain** only on idle or transition screens, at 6 to 10 percent, never over text.
- **Colour is never the only signal.** Every state also has a glyph (`~ ? ! x * - .`) and a word.
- **Motion never moves the layout.** Every painter draws over or around its child at the child's
  size. Every animation sits behind one reduced-motion switch (`Motion` in `lib/fleet/neon.dart`):
  the platform's setting or `HARNESS_REDUCED_MOTION=1`. Loops stop while the window is unfocused
  and whenever nothing is live.
- **Neon follows the palette.** Accent comes from the app palette; with the Omarchy palette chosen,
  yellow, red and green come from the Omarchy theme file when they still read as those colours.

## Surfaces

- **Pane frame** (`lib/widgets/attention_glow.dart`): working sweeps an accent comet around the border
  (2.4 s a lap), waiting breathes yellow, permission and failed pulse red with a scan band down the
  side edges (inside the border, never over text; failed opens with a double flash), done draws its
  border once in green, then holds. Colours cross-fade over 280 ms. Idle and offline draw nothing.
- **Spend ring** (`lib/fleet/spend_ring.dart`): rings the engine mark in the pane header once a
  per-agent cap is set (`harness spend set`). While the agent waits on you, the mark becomes your
  avatar inside a ring in the state colour.
- **Fleet overview** (`lib/fleet/`, command bar "Fleet overview" or Ctrl+Shift+G): a hub, one hexagon
  per machine, agents as rings around it. Agents orbit only while one works there; packets flow out
  along a link while work runs and back in the state colour while an agent there waits on you.
  Click an agent to open it.
- **Boot splash** (`lib/branding/boot_splash.dart`): off by default. With a boot logo chosen in
  Settings ▸ Appearance it lights up once on a cold launch, 1.5 s, skippable by a click or any key;
  reduced motion shows a still logo. `HARNESS_NO_SPLASH=1` turns it off regardless.

## Settings keys (`state.json`, written by Settings ▸ Appearance)

| Key | Values | Default |
|---|---|---|
| `brand_boot_logo` | `omarchy`, `harness`, `custom`, `none` | unset: no splash |
| `brand_boot_logo_path` | copy of the chosen SVG or PNG under `~/.harness/desktop-app-v2/brand/` | unset |
| `brand_avatar` | `generic`, `initials`, `system`, `custom` | `generic` (a neutral person glyph) |
| `brand_avatar_path` | cached copy of the chosen image under the same `brand/` folder | unset |
| `brand_avatar_initials` | up to three letters, upper case | empty |

Custom files must be SVG or PNG, at most 2 MB, with real content (PNG signature, `<svg` tag). A
rejected file leaves the previous choice in place; a chosen file that has gone means no splash. The
Omarchy logo is offered only where `/usr/share/omarchy/logo.svg` exists, and `system` (the avatar from
`~/.face`) only where that file exists. Nothing of Omarchy's is bundled.
