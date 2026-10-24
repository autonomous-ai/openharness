import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/desktop_download.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import 'workspace_bar_control.dart';
import 'workspace_share_button.dart';

/// Opens [uri] in a new browser tab, inside the click that asked for it: a
/// `window.open` made later is outside the user's gesture, which browsers
/// block as a popup or open as a separate window.
Future<bool> openInNewTab(Uri uri) =>
    launchUrl(uri, webOnlyWindowName: '_blank');

/// Whether a browser on [platform] (this one when absent) is a phone's or a
/// tablet's, iOS or Android, where the store bar offers the Harness app
/// (`web/shell/web_store_banner.dart`): a computer's download is no use there,
/// so [WebDownloadButton] is left out (audit finding S9).
bool browserHasAppStore([TargetPlatform? platform]) =>
    switch (platform ?? defaultTargetPlatform) {
      TargetPlatform.iOS || TargetPlatform.android => true,
      _ => false,
    };

/// The Harness product page.
final harnessAppPage = Uri.parse('https://www.autonomous.ai/harness-app');

/// The browser's handoff to the desktop build that suits this computer
/// ([DesktopDownload]), in a new tab so the workspace stays open behind it.
class WebDownloadButton extends StatelessWidget {
  const WebDownloadButton({
    super.key,
    this.open = openInNewTab,
    this.prominent = false,
  });

  /// How the page is opened; tests pass a recorder.
  final Future<bool> Function(Uri uri) open;

  /// True fills it like Share: the bar's one filled action when Share is off.
  final bool prominent;

  /// This computer's build, or the `/desktop` page when none suits it.
  static Uri get uri => DesktopDownload.uri;
  static const _text = 'Download app';

  /// Filled like Share when [prominent], a step brighter under the pointer;
  /// otherwise bare, with the bar's recessed well under the pointer.
  static Color backgroundFor({required bool prominent, required bool hovered}) {
    if (prominent) {
      return hovered
          ? grid.AppPalette.accentHover
          : WorkspaceShareButton.backgroundFor(true);
    }
    return hovered ? grid.AppSurface.recessHover : Colors.transparent;
  }

  static double widthOf(BuildContext context) =>
      workspaceBarTextSizeOf(context, _text).width +
      workspaceBarCellSizeOf(context).width * 2;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // One node: the control's focus would otherwise be a nameless child of
    // its label, and Tab would land on a "button" with no name.
    return MergeSemantics(
      child: Semantics(
        link: true,
        linkUrl: uri,
        child: WorkspaceBarControl(
          label: 'Download app',
          onPressed: () => open(uri),
          // Hover lifts the fill; the label keeps its weight. Turning bold under
          // the pointer reflowed the word and read as a glitch, not a response.
          builder: (context, hovered) => ColoredBox(
            color: backgroundFor(prominent: prominent, hovered: hovered),
            child: SizedBox(
              width: widthOf(context),
              height: workspaceBarControlHeight(context),
              child: Center(
                child: Text(
                  _text,
                  style: workspaceBarTextStyle(
                    color: prominent
                        ? WorkspaceShareButton.foregroundFor(true)
                        : grid.AppPalette.textPrimary,
                    emphasized: prominent,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
