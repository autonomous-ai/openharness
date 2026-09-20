import 'package:flutter/material.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/engine_identity.dart';
import 'store_editorial.dart';
import 'store_models.dart';

/// Compact, responsive rows for search, the complete index, and coding agents.
class StoreListing extends StatelessWidget {
  const StoreListing({
    super.key,
    required this.entries,
    required this.ratingFor,
    required this.installed,
    required this.onOpen,
    required this.onAction,
  });
  final List<DshEntry> entries;
  final StoreRating Function(DshEntry) ratingFor;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final columns = box.maxWidth >= 1120
          ? 3
          : box.maxWidth >= 720
          ? 2
          : 1;
      final width = (box.maxWidth - (columns - 1) * 24) / columns;
      return Wrap(
        spacing: 24,
        children: [
          for (final entry in entries)
            SizedBox(
              width: width,
              child: _ProductRow(
                key: ValueKey('store-card:${entry.id}'),
                entry: entry,
                rating: ratingFor(entry),
                installed: installed(entry.id),
                onOpen: () => onOpen(entry.id),
                onAction: () => onAction(entry),
              ),
            ),
        ],
      );
    },
  );
}

class _ProductRow extends StatelessWidget {
  const _ProductRow({
    super.key,
    required this.entry,
    required this.rating,
    required this.installed,
    required this.onOpen,
    required this.onAction,
  });
  final DshEntry entry;
  final StoreRating rating;
  final bool installed;
  final VoidCallback onOpen;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.transparent,
    child: InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        constraints: const BoxConstraints(minHeight: 94),
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 6),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
        ),
        child: Row(
          children: [
            EngineMark(engine: entry.id, displayName: entry.name, size: 42),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    entry.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    storeBenefit(entry),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.3,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  if (!rating.isEmpty) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Icon(
                          Icons.star_rounded,
                          size: 12,
                          color: grid.AppPalette.textSecondary,
                        ),
                        const SizedBox(width: 3),
                        Text(
                          '${rating.average.toStringAsFixed(1)} · ${rating.count}',
                          style: TextStyle(
                            fontSize: 11,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 12),
            TextButton(
              key: ValueKey('store-action:${entry.id}'),
              onPressed: entry.isViewerPackage ? onOpen : onAction,
              style: TextButton.styleFrom(
                backgroundColor: grid.AppSurface.selectedFill,
                foregroundColor: grid.AppPalette.accentOnSurface,
                minimumSize: const Size(62, 30),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                shape: const StadiumBorder(),
              ),
              child: Text(
                entry.isViewerPackage
                    ? 'View'
                    : entry.hasUpdate
                    ? 'Update'
                    : installed
                    ? 'Open'
                    : 'Get',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
