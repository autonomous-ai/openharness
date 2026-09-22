# New-tab wallpapers

Blank remains the default and uses the selected tab's workspace color. Choose artwork under Customize Harness → Wallpaper. It appears only on empty welcome/new-tab pages. The welcome text and wallpaper stay mounted at their original position while the New Harness and Open Harness panels overlay the page.

The four images below were created with the built-in image generation tool. The PNG outputs were copied into the app without retouching. They are bundled locally; changing wallpaper does not make a network request. The center is deliberately quiet so the terminal-font welcome message remains readable.

| Choice | Bundled asset | Direction |
| --- | --- | --- |
| Renaissance notebook | [PNG](../assets/swarm-wallpapers/renaissance-notebook.png) | Flight, mechanisms, nature and geometry on charcoal parchment |
| Atlas of connections | [PNG](../assets/swarm-wallpapers/atlas-of-connections.png) | Connections between astronomy, biology, music and engineering |
| Terminal workshop | [PNG](../assets/swarm-wallpapers/terminal-workshop.png) | Sparse green ASCII-style inventions at the edges |
| Terminal star atlas | [PNG](../assets/swarm-wallpapers/terminal-star-atlas.png) | ASCII-style space and geometry on a clear midnight field |

## Generation prompts

### Renaissance notebook

```text
Use case: stylized-concept. Asset type: a premium desktop wallpaper for Harness, a creative engineering tool for curious polymaths. Generate one finished landscape image, 16:9, ideally 2048x1152. A Leonardo da Vinci inspired inventor's notebook redrawn on deep charcoal parchment: exquisite delicate warm chalk and sepia ink studies of a bird's wing and flight machine, interlocking gears, geometric constructions, water vortices and a botanical spiral. Intellectual, humane, quietly optimistic. Museum-quality drawing, tactile paper grain, restrained amber and ivory accents, detailed yet spacious. Distribute the beautiful studies around the outer thirds and corners, with a broad very dark calm central region suitable for small light monospace welcome text. The images should gently emerge from darkness; no framed panels, no UI, no borders, no actual words, no branding, no letters or watermarks. The wallpaper celebrates following curiosity and building across disciplines.
```

### Atlas of connections

```text
Use case: stylized-concept. Asset type: a premium 16:9 landscape desktop wallpaper for Harness, ideally 2048x1152. Create an enchanting visual atlas of connections across disciplines, drawn like an exceptionally beautiful modern Renaissance scientific notebook on midnight blue paper. Fine cyan, desaturated gold and muted coral ink drawings flow from orbital geometry to a shell spiral, a sine-wave musical string, an elegant robotic hand, delicate botanical forms and tiny circuit traces. Precise hand-drafted construction lines, radiant restrained points of connection. The sketches are elegant and sparse, concentrated near the edges, not an all-over busy pattern. Keep the broad central half dark, quiet and unmarked so that small light welcome text can be read there. Rich subtle tactile paper, soft atmospheric depth; a sophisticated collectible print celebrating learning, discovery and making across disciplines. No text, no logos, no watermarks, no UI, no rectangular panels. One finished wallpaper, not a montage of wallpaper options.
```

### Terminal workshop

```text
Use case: stylized-concept. Asset type: minimalist 16:9 desktop wallpaper, ideally 2048x1152, for a terminal-inspired creative engineering app. Beautiful ASCII and block-character artwork on flat dark graphite gray. Sparse pale green phosphor characters form small Leonardo-like inventions in the extreme corners: a wireframe flying machine upper left, a mechanical gear lower left, a geometric hand upper right, an orbital diagram lower right. Precise monospaced character grid using + - | / backslash dots colons and light block glyphs, like a gorgeous old engineering terminal, restrained and minimal. No interface, no words. CRITICAL: the central rectangle from 25% to 75% width and 18% to 82% height remains solid empty charcoal with absolutely no marks, stars, texture, glow, text or art. Only sparse peripheral details outside that region. No neon haze, no gradients, no borders, no watermark. One finished wallpaper celebrating the polymath workshop.
```

### Terminal star atlas

```text
Use case: stylized-concept. Asset type: minimal full-bleed 16:9 desktop wallpaper, ideally 2048x1152. Dark terminal star atlas made entirely from delicate monospaced ASCII characters and tasteful chunky block glyphs: a small ringed planet upper left, orbital compass upper right, tiny satellite and stepped Fibonacci spiral in opposite bottom corners. Subdued ice blue, warm ivory and desaturated amber characters on solid deep midnight charcoal. Lovingly handcrafted generative terminal art: elegant, sparse, exploratory. No readable language, UI, code, logos or watermark. Essential composition: central 55 percent of width and central 70 percent of height completely empty uniform solid dark background; no stars, dots or artwork there. All art restricted to outermost corners and ends before the clear center. No borders, vignette or lighting effects. One finished wallpaper.
```

## Review

Rendered app previews: [welcome with terminal wallpaper](review/welcome-terminal-wallpaper.png) and [keyboard shortcut popup](review/keyboard-shortcuts-browser.png).

`test/welcome_wallpaper_shortcuts_test.dart` loads the actual bundled images and renders the welcome content with the terminal font. It checks selection persistence, the blank default, font changes and compact layouts. `test/workspace_start_guide_test.dart` checks that opening and closing both command panels preserves the welcome text and wallpaper bounds, and that Customize Harness opens the wallpaper picker.

To capture review images outside the repository:

```sh
HARNESS_REFINEMENT_CAPTURE_DIR=/private/tmp/harness-refinement-review \
  flutter test --no-pub --update-goldens test/welcome_wallpaper_shortcuts_test.dart
```
