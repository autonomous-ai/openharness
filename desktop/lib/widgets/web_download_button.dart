import 'package:flutter/material.dart';
import 'package:url_launcher/link.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import 'workspace_bar_control.dart';

/// The browser's consistent handoff to the existing macOS/Linux download page.
class WebDownloadButton extends StatelessWidget {
  const WebDownloadButton({super.key});

  static final uri = Uri.parse('https://harness.autonomous.ai/download');
  static const _text = '[ Download app ]';

  static double widthOf(BuildContext context) =>
      workspaceBarTextSizeOf(context, _text).width +
      workspaceBarCellSizeOf(context).width * 2;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Link(
      uri: uri,
      target: LinkTarget.blank,
      builder: (context, followLink) => WorkspaceBarControl(
        label: 'Download app',
        onPressed: followLink,
        builder: (context, emphasized) => SizedBox(
          width: widthOf(context),
          height: workspaceBarControlHeight(context),
          child: Center(
            child: Text(
              _text,
              style: workspaceBarTextStyle(
                color: grid.AppPalette.textPrimary,
                emphasized: emphasized,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
