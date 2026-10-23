import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';
import '../finder_document.dart';

/// Said over a tab whose file moved under its edits — Orca's "changed on
/// disk" banner, with its two ways out — or whose save failed.
class FinderDiskBanner extends StatelessWidget {
  const FinderDiskBanner({super.key, required this.document});

  final FinderDocument document;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final (message, actions) = switch (document.disk) {
      FinderDiskChange.changed => (
        'This file changed on disk while you have unsaved edits.',
        [
          _action('Reload from Disk', document.reloadFromDisk),
          _action('Keep My Edits', document.keepMine),
        ],
      ),
      FinderDiskChange.deleted => (
        'This file was deleted or moved. Saving puts it back.',
        const <Widget>[],
      ),
      FinderDiskChange.none => (document.saveError, const <Widget>[]),
    };
    if (message == null) return const SizedBox.shrink();
    return Container(
      key: const ValueKey('finder-disk-banner'),
      color: AppColors.warning.withValues(alpha: .14),
      padding: const EdgeInsets.fromLTRB(14, 4, 8, 4),
      child: Row(
        children: [
          Icon(AppIcons.triangleAlert, size: 14, color: AppColors.warning),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: grid.AppType.label(color: AppColors.text),
            ),
          ),
          ...actions,
        ],
      ),
    );
  }

  Widget _action(String label, Future<void> Function() onPressed) =>
      TextButton(onPressed: onPressed, child: Text(label));
}
