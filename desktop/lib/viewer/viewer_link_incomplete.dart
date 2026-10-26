import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/empty_state.dart';
import 'viewer_location.dart';

/// A viewer link missing its machine or agent (`/?viewer=1`): what to run for a
/// whole one, and a way back to the workspace instead of a dead end.
class ViewerLinkIncomplete extends StatelessWidget {
  const ViewerLinkIncomplete({
    super.key,
    required this.location,
    this.open = _openHere,
  });

  /// The link this page was opened at.
  final Uri location;

  /// Opens the workspace; a test passes its own.
  final Future<void> Function(Uri workspace) open;

  static Future<void> _openHere(Uri workspace) =>
      launchUrl(workspace, webOnlyWindowName: kIsWeb ? '_self' : null);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final prose = grid.AppType.body(
      color: grid.AppPalette.textSecondary,
      height: 1.4,
    );
    return Material(
      color: Theme.of(context).scaffoldBackgroundColor,
      child: EmptyState(
        icon: AppIcons.unlink,
        title: 'This viewer link is incomplete',
        action: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text.rich(
              key: const Key('viewer-link-incomplete-message'),
              TextSpan(
                style: prose,
                children: [
                  const TextSpan(text: 'Run '),
                  TextSpan(
                    text: 'hn view',
                    style: grid.AppType.mono(
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const TextSpan(text: ' again for a new link.'),
                ],
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 18),
            FilledButton(
              // A thumb's target on a phone.
              style: const ButtonStyle(
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              onPressed: () => open(ViewerLocation.workspaceOf(location)),
              child: const Text('Open Harness'),
            ),
          ],
        ),
      ),
    );
  }
}
