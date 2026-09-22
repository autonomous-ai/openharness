import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/engine_identity.dart';
import 'store_editorial.dart';
import 'store_models.dart';

/// One consistent app identity across discovery, categories, and search.
/// Vendor marks retain their aspect ratio and their light/dark treatments.
class StoreAppIcon extends StatelessWidget {
  const StoreAppIcon({super.key, required this.entry, this.size = 56});
  final DshEntry entry;
  final double size;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(size * .12),
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        borderRadius: BorderRadius.circular(size * .23),
        border: Border.all(color: grid.AppPalette.divider),
      ),
      child: EngineMark(
        engine: entry.id,
        displayName: entry.name,
        size: size * .76,
      ),
    );
  }
}

/// Icon rows are the default catalog presentation. Reserve large imagery for
/// editorial features, so tools with different output formats scan alike.
class StoreListing extends StatelessWidget {
  const StoreListing({
    super.key,
    required this.entries,
    required this.ratingFor,
    required this.onOpen,
    this.rowKeyPrefix = 'store-card',
    this.showRanks = false,
  });
  final List<DshEntry> entries;
  final StoreRating Function(DshEntry) ratingFor;
  final ValueChanged<String> onOpen;
  final String rowKeyPrefix;
  final bool showRanks;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return LayoutBuilder(
      builder: (context, box) {
        final scale = terminalTextScaleOf(context);
        final columns = (box.maxWidth / (340 * scale)).floor().clamp(1, 3);
        final width = (box.maxWidth - (columns - 1) * 28) / columns;
        final reserveRating = entries.any((entry) => !ratingFor(entry).isEmpty);
        final reserveUpdate = entries.any((entry) => entry.hasUpdate);
        return Wrap(
          spacing: 28,
          children: [
            for (final entry in entries)
              SizedBox(
                width: width,
                child: _ProductRow(
                  key: ValueKey('$rowKeyPrefix:${entry.id}'),
                  rank: showRanks ? entries.indexOf(entry) + 1 : null,
                  entry: entry,
                  rating: ratingFor(entry),
                  reserveRating: reserveRating,
                  reserveUpdate: reserveUpdate,
                  onOpen: () => onOpen(entry.id),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _ProductRow extends StatelessWidget {
  const _ProductRow({
    super.key,
    required this.entry,
    required this.rating,
    required this.reserveRating,
    required this.reserveUpdate,
    required this.onOpen,
    this.rank,
  });
  final DshEntry entry;
  final StoreRating rating;
  final bool reserveRating;
  final bool reserveUpdate;
  final VoidCallback onOpen;
  final int? rank;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final scale = terminalTextScaleOf(context);
    final benefit = entry.isEngine
        ? entry.tagline ??
              engineIdentity(entry.id).tagline ??
              storeBenefit(entry)
        : storeBrowseBenefit(entry);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 4),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (rank != null) ...[
                SizedBox(
                  width: 18,
                  child: Text(
                    '$rank',
                    style: terminalTextStyle(
                      fontWeight: FontWeight.w600,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
              ],
              StoreAppIcon(entry: entry),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Tooltip(
                      message: entry.name,
                      child: Text(
                        entry.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: terminalTextStyle(
                          fontWeight: FontWeight.w600,
                          color: grid.AppPalette.textPrimary,
                        ),
                      ),
                    ),
                    const SizedBox(height: 4),
                    SizedBox(
                      height: 32 * scale,
                      child: Text(
                        benefit,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: terminalTextStyle(
                          height: 1.3,
                          color: grid.AppPalette.textSecondary,
                        ),
                      ),
                    ),
                    if (reserveUpdate) ...[
                      const SizedBox(height: 4),
                      Text(
                        entry.hasUpdate ? 'Update available' : ' ',
                        style: terminalTextStyle(
                          color: grid.AppPalette.accentOnSurface,
                        ),
                      ),
                    ],
                    if (reserveRating) ...[
                      const SizedBox(height: 4),
                      SizedBox(
                        height: 14 * scale,
                        child: rating.isEmpty
                            ? null
                            : Row(
                                children: [
                                  Icon(
                                    Icons.star_rounded,
                                    size: 12,
                                    color: grid.AppPalette.textSecondary,
                                  ),
                                  const SizedBox(width: 3),
                                  Text(
                                    '${rating.average.toStringAsFixed(1)} · ${rating.count}',
                                    style: terminalTextStyle(
                                      color: grid.AppPalette.textSecondary,
                                    ),
                                  ),
                                ],
                              ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
