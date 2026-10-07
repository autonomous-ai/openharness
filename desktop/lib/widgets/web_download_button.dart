import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import 'workspace_bar_control.dart';
import 'workspace_share_button.dart';

/// Opens [uri] in a new browser tab, inside the click that asked for it: a
/// `window.open` made later is outside the user's gesture, which browsers
/// block as a popup or open as a separate window.
Future<bool> openInNewTab(Uri uri) =>
    launchUrl(uri, webOnlyWindowName: '_blank');

/// The Harness product page; its download view is one query away.
final harnessAppPage = Uri.parse('https://www.autonomous.ai/harness-app');

/// The browser's consistent handoff to the existing macOS/Linux download page,
/// in a new tab so the workspace stays open behind it.
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

  static final uri = harnessAppPage.replace(
    queryParameters: {'page': 'download'},
  );
  static const _text = 'Download app';

  static double widthOf(BuildContext context) =>
      workspaceBarTextSizeOf(context, _text).width +
      workspaceBarCellSizeOf(context).width * 2;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Semantics(
      link: true,
      linkUrl: uri,
      child: WorkspaceBarControl(
        label: 'Download app',
        onPressed: () => open(uri),
        builder: (context, emphasized) => ColoredBox(
          color: prominent
              ? WorkspaceShareButton.backgroundFor(true)
              : Colors.transparent,
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
                  emphasized: emphasized,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
