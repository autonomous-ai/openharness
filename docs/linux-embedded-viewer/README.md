# Embedded viewers on Linux

Linux Harness workspaces can display their web viewers beside the agent terminal, using WebKitGTK 4.1 through `webview_all`.

![Memories rendering inside the Harness Linux viewer pane beside its agent terminal](memories-linux.png)

Screenshot supplied and approved for publication by Edwin Rodriguez (ProgreTech), October 16, 2026. The owner confirmed that Memories renders inside Harness after restarting the patched desktop build.

## Try it

Install the WebKitGTK 4.1 runtime (`libwebkit2gtk-4.1-0` on Ubuntu), build the desktop application, and open a workspace with a viewer, such as Memories. The page appears in the left pane beside the agent terminal.

Linux viewer panes use rectangular clipping because the native GTK overlay hides itself under rounded Flutter clips. Terminal panes retain their rounded clipping.

## Verification

- Ubuntu 26.04 x64, Flutter 3.47.2, Dart 3.13.2, WebKitGTK 4.1.
- The initial viewer and Store dialog tests passed (18 tests).
- After the clipping correction, all 14 viewer tests passed, including a regression assertion checking the viewer's ancestor clipping.
- Linux release compilation passed. The owner verified the rendered Memories page shown above.

The AppImage requires the host WebKitGTK runtime; it is not bundled. The screenshot confirms page rendering, but does not establish that every viewer, media feature, dialog overlay, or keyboard interaction works. macOS behavior was not exercised on this Linux host.

For local Linux packages, follow the existing release packaging convention and put the build version in `version.txt` beside the executable. Omitting it makes the application report the placeholder version from `pubspec.yaml` and offer an unnecessary update. The tested local package uses `1.2.88+progretech.viewer.2`.
