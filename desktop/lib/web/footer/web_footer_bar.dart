import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/workspace_bar_style.dart';
import '../../state/workspace_chrome.dart';
import '../../terminal/terminal_theme.dart';
import '../../terminal/terminal_theme_store.dart';
import '../../widgets/box_chrome.dart' show kWorkspaceInset;
import '../../widgets/pane_menu.dart';
import '../../widgets/web_download_button.dart';
import '../../widgets/workspace_bar_control.dart';
import '../../widgets/workspace_share_button.dart';
import '../shell/web_dropdown_control.dart';
import '../shell/web_hidden_under_keyboard.dart';

/// The footer on a phone, shaped like its header: the whole status line as one
/// dropdown whose menu holds each entry, then Download app, and Share when it
/// is on. Gone while the on-screen keyboard is up — the terminal needs that
/// height more.
class WebFooterBar extends StatelessWidget {
  const WebFooterBar({super.key, required this.footer});

  final WorkspaceFooter footer;

  @override
  Widget build(BuildContext context) {
    final foreground = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    ).foreground;
    final share = footer.share;
    return WebHiddenUnderKeyboard(
      child: Material(
        key: const ValueKey('workspace-status-bar'),
        type: MaterialType.transparency,
        child: SizedBox(
          height: workspaceBarControlHeight(context) + kWorkspaceInset,
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: workspaceBarCellSizeOf(context).width,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Builder(
                      builder: (context) => WebDropdownControl(
                        key: const ValueKey('web-footer-menu-button'),
                        label: footer.summary,
                        tooltip: 'Status',
                        color: foreground,
                        onPressed: () => _open(context),
                      ),
                    ),
                  ),
                ),
                // One filled action in the bar: Share when it is on.
                WebDownloadButton(prominent: share == null),
                if (share != null) ...[
                  SizedBox(width: workspaceBarCellSizeOf(context).width),
                  _WebShareIconButton(share: share),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    final position = webMenuAnchor(context);
    if (position == null) return;
    final choice = await showPaneMenu<WorkspaceFooterItem>(
      context: context,
      // Opened by a click: no row is lit until the pointer picks one.
      focusFirst: false,
      position: position,
      minWidth: 260,
      maxWidth: 360,
      children: (close) => [
        for (final item in footer.items)
          paneMenuItem(
            onTap: () => close(item),
            child: KeyedSubtree(
              key: ValueKey('web-footer:${item.title}'),
              child: PaneMenuRow(
                selected: false,
                title: item.title,
                status: item.detail.isEmpty ? null : item.detail,
              ),
            ),
          ),
      ],
    );
    // Run once the menu has closed and handed focus back.
    choice?.onPressed?.call();
  }
}

/// Share as an icon on the accent fill: still the bar's primary action, in
/// the width of one tab-bar button.
class _WebShareIconButton extends StatelessWidget {
  const _WebShareIconButton({required this.share});

  final WorkspaceFooterItem share;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = share.onPressed != null;
    final height = workspaceBarControlHeight(context);
    return WorkspaceBarControl(
      key: const ValueKey('workspace-share-button'),
      label: share.title,
      tooltip: share.detail,
      onPressed: share.onPressed,
      builder: (context, emphasized) => ColoredBox(
        color: WorkspaceShareButton.backgroundFor(enabled),
        child: SizedBox(
          width: workspaceBarCellSizeOf(context).width * 4,
          height: height,
          child: Icon(
            AppIcons.share,
            size: 16,
            color: WorkspaceShareButton.foregroundFor(enabled),
          ),
        ),
      ),
    );
  }
}
