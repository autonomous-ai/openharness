# App icons

Third-party app icons, vendored so the Harness Pro's Apps screen can show each app as people know it from their Dock.
They identify which apps Harness works with: nominative use, no endorsement implied or claimed.

**Do not recolor or redraw these.** If an icon is wrong or its owner wants it changed or removed, open an issue and it
comes out.

`devices/harness-pro/firmware/scripts/gen_app_icons.py` bakes them into the firmware at 72 and 44 px and measures each
card's colour from them. Each file is named by its app id in `cli/src/cable/hosts/hostDetect.ts`; `codex.png` is the
ChatGPT app's icon.

## Sources

**The SHA-256 column is the *upstream* file each was made from (the `.icns`, or the downloaded file), not the file in
this directory.** All were read on 2026-11-20.

| File | Source | Date | Source px | Upstream SHA-256 |
|---|---|---|---|---|
| `codex.png` | ChatGPT macOS app, `com.openai.codex` 26.1111.21308, `icon-chatgpt.icns` (not `app.icns`, which is Codex's icon) | 2026-11-20 | 1024 | `8ee5a24e1e32e33f976bc56943c2e8ad0a700449e6857741e543dc738648a2fb` |
| `claude.png` | Claude macOS app, `com.anthropic.claudefordesktop` 6.6395.1, `electron.icns` | 2026-11-20 | 1024 | `7d0ffbc29b82d47ec63962f60d6dcb8c0659c62959a19d650191006e0d84cc27` |
| `cursor.png` | Cursor macOS app, `com.todesktop.230313mzl4w4u92` 3.20.21, `Cursor.icns` | 2026-11-20 | 512 | `69257574472105aaae5f369dc141e85e54ea4a06da906133606a2080936cf83a` |
| `herdr.png` | Herdr macOS app, `dev.herdr.app` 0.1.16, `Herdr.icns` | 2026-11-20 | 1024 | `d742b6776d86cb8673a04414929f07cdb2599d18102f4e9a2e72227656d485f5` |
| `iterm.png` | iTerm2 macOS app, `com.googlecode.iterm2` 3.7.8, `iTerm2 App Icon for Release.icns` | 2026-11-20 | 256 | `3c2d92b2b0b5d18b25fc3c5560a9b82725d0c3ce2e0101f77e80113d80dff0c6` |
| `orca.png` | Orca macOS app, `com.stablyai.orca` 1.4.262, `icon.icns` | 2026-11-20 | 1024 | `28539efb901bac42b497fcfe25759d4928ec836ed2c0bb56014601d27c0e3b16` |
| `vscode.png` | Visual Studio Code macOS app, `com.microsoft.VSCode` 1.147.0, `Code.icns` | 2026-11-20 | 1024 | `66d4e5a4f21d0e68e530b26e992341d00ffe2764ec0cbdc668b2a604d6e604a7` |
| `terminal-app.png` | Terminal macOS app, `com.apple.Terminal` 2.15, `Terminal.icns` | 2026-11-20 | 256 | `073acdf006a91fa7c46a3ebc7586b47ddd7c2188d6f07902c36e18a67804d811` |
| `ghostty.png` | `ghostty-org/ghostty` @ `d69f9ed83ca7275fa5afbba0fa968d0d9ada9f5a`, `images/icons/icon_1024.png` | 2026-11-20 | 1024 | `82f2f030626375594523b0219df882f046145bf3244869c904053511ec29046c` |
| `kitty.png` | `kovidgoyal/kitty` @ `2a0f5a6b89762cb242b7dd483ea3f95dc3696472`, `logo/kitty.png` (its `kitty.icns` is no larger) | 2026-11-20 | 256 | `238d24e2730c94e9aaed76d25140bb3e2ade241ec313cc0b29d206e46cbfdabe` |
| `wezterm.png` | `wezterm/wezterm` @ `630ba680e5f88fe1cab5d302bac1265c449fc7b7`, `assets/macos/WezTerm.app/Contents/Resources/terminal.icns` (its PNG is 128 px) | 2026-11-20 | 1024 | `e90dca311c0da3d39b9d5bfd9e5a8e2dd260eab5d11a403540cd93b4495e0a83` |
| `zellij.png` | `zellij-org/zellij` @ `62cfa6c36dab1cba7f40cb41b4cf34aaed13db72`, `zellij-utils/assets/icons/logo1024.png` | 2026-11-20 | 1024 | `c6a8c8a97cb3e5d35a5ac868a2dab9837cc6ac2a5f43c332fef7c22bf28f0204` |
| `cmux.png` | `manaflow-ai/cmux` @ `4f71257eacca90790e8bff62604167eb53cee203`, `Assets.xcassets/AppIcon.appiconset/512@2x.png` (the light icon) | 2026-11-20 | 1024 | `b70417c3e03c13096abb3bbb88be605b97164974e033980573f66f807c496a58` |
| `opencode.png` | `anomalyco/opencode` @ `d9eb208a22bd0ddbf69420a6b67c26851ad36e18`, `packages/desktop/icons/prod/icon.png` | 2026-11-20 | 512 | `324bd6ab9499f006519209eaa883519f37b9373a59d6eb01235189d4ac67ea27` |
| `tmux.png` | `tmux/tmux` @ `b2a01282069146476ceca974ff255437ff00865e`, `logo/tmux-logomark.svg`, rasterised to 512 px with resvg | 2026-11-20 | 160 (SVG) | `bdc956f2193c3cf4a49d304b76f43d6c6e69670224a45e0422b3e8066de8e358` |
| `warp.png` | Warp's site icon, <https://www.warp.dev/favicon-196x196.png>, the largest icon `https://www.warp.dev/` declares | 2026-11-20 | 196 | `052f0aa0c1b45740c49072743708a53c7a0e317582385fb61dd8b6c67f74d9e2` |

## How the files were made

- **App bundles** (ChatGPT, Claude, Cursor, Herdr, iTerm2, Orca, VS Code, Terminal): the bundle's `.icns` was read, never
  changed, and `sips -s format png -Z 512` wrote a PNG into a scratch directory. iTerm2's and Terminal's `.icns` hold
  256 px at most, so they were converted at 256 without `-Z`.
- **Repositories and sites:** each file was downloaded from a URL pinned to the commit above into its own empty scratch
  directory and read only by Pillow. tmux publishes its mark as an SVG: resvg (`@resvg/resvg-js` 2.6.2, fit to 512 px
  wide, no background) rasterised it on transparency, unchanged; the mark is square, so it needed no padding.
- **Every file** was then re-encoded by Pillow: converted to RGBA, reduced to 512 px with LANCZOS when larger, rebuilt
  from its raw pixels and saved with no ICC profile, text chunk or other metadata. Pixel values are otherwise as `sips`
  or the vendor wrote them.
- **Smaller than 512:** iTerm2 and Terminal (256, their bundles' largest), kitty (256, its largest) and Warp (196, its
  site's largest) are kept at their own size, never upscaled.

## Card colours

The generator measures each card's colour from these files. On ChatGPT and Claude its rule gives `#2C2E3A` and
`#D97656`, where the Apps screen mockup's hand-measured values were `#262834` and `#D97757`: within 8 per channel, and
the rule's values are the ones used (accepted by the PM, 2026-11-20).

## Left out

- `rex`: no official app icon found; the Apps screen shows its name only.
