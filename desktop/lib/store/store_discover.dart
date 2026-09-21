import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import 'store_collections.dart';
import 'store_editorial.dart';
import 'store_exploration.dart';
import 'store_explore_widgets.dart';
import 'store_featured_art.dart';
import 'store_listing.dart';
import 'store_models.dart';

/// Three editorial features invite exploration before the icon collections. The catalog itself
/// uses the same recognizable icons and rows as categories and search.
class StoreDiscover extends StatelessWidget {
  const StoreDiscover({
    super.key,
    required this.entries,
    required this.loaded,
    required this.ratingFor,
    required this.onOpen,
    required this.onCategory,
    required this.onAll,
    required this.onEngines,
  });

  final List<DshEntry> entries;
  final bool loaded;
  final StoreRating Function(DshEntry) ratingFor;
  final ValueChanged<String> onOpen;
  final ValueChanged<String> onCategory;
  final VoidCallback onAll;
  final VoidCallback onEngines;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final byId = {for (final entry in entries) entry.id: entry};
    // Editorial stories share an art direction and open actual catalog entries.
    final features = [
      ?(byId['codex'] ?? byId['claude']),
      ?byId['autonomous/blender'],
      ?byId['autonomous/autonomous-circuit'],
    ];
    final engines = [
      for (final id in ['claude', 'codex', 'cursor']) ?byId[id],
    ];
    final crafts = entries
        .where((entry) => !entry.isEngine && !entry.isViewerPackage)
        .toList();
    const picks = [
      'autonomous/text-to-cad',
      'autonomous/strudel',
      'autonomous/marimo',
      'autonomous/remotion',
      'autonomous/roundtable',
      'autonomous/marp',
    ];
    crafts.sort((a, b) {
      final ai = picks.indexOf(a.id), bi = picks.indexOf(b.id);
      final rank = (ai < 0 ? 999 : ai).compareTo(bi < 0 ? 999 : bi);
      return rank == 0 ? a.name.compareTo(b.name) : rank;
    });
    final recent = storeRecentlyUpdated(crafts).take(6).toList();
    final topRated = storeTopRated(entries, ratingFor).take(6).toList();
    final categories = [
      for (final name in [...storeCategoryDomains.keys, 'Other'])
        if (name != 'Coding' &&
            crafts.any((entry) => storeCategoryFor(entry) == name))
          name,
    ];
    return LayoutBuilder(
      builder: (context, box) {
        final padding = box.maxWidth < 680 ? 20.0 : 36.0;
        return SingleChildScrollView(
          key: const PageStorageKey('store-discover-scroll'),
          padding: EdgeInsets.fromLTRB(padding, 32, padding, 40),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Follow your curiosity.',
                    key: const ValueKey('store-curiosity-hero'),
                    style: TextStyle(
                      fontSize: 34,
                      height: 1.15,
                      letterSpacing: -1.1,
                      fontWeight: FontWeight.w700,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  if (features.isNotEmpty) ...[
                    const SizedBox(height: 24),
                    LayoutBuilder(
                      builder: (context, constraints) {
                        final scale =
                            MediaQuery.textScalerOf(context).scale(14) / 14;
                        final wide =
                            constraints.maxWidth >= 980 &&
                            scale <= 1.25 &&
                            features.length == 3;
                        final width = wide
                            ? (constraints.maxWidth - 40) / 3
                            : (constraints.maxWidth * .86).clamp(280.0, 520.0);
                        final cards = [
                          for (final entry in features)
                            SizedBox(
                              width: width,
                              child: _FeaturedStory(
                                entry: entry,
                                onTap: () => onOpen(entry.id),
                              ),
                            ),
                        ];
                        return SingleChildScrollView(
                          key: const PageStorageKey('store-featured-scroll'),
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              for (var i = 0; i < cards.length; i++) ...[
                                if (i > 0) const SizedBox(width: 20),
                                cards[i],
                              ],
                            ],
                          ),
                        );
                      },
                    ),
                  ],
                  if (engines.isNotEmpty) ...[
                    const SizedBox(height: 24),
                    StoreExploreHeading(
                      title: 'Start with code.',
                      action: 'All coding agents',
                      onAction: onEngines,
                    ),
                    const SizedBox(height: 6),
                    StoreListing(
                      entries: engines,
                      ratingFor: ratingFor,
                      onOpen: onOpen,
                    ),
                  ],
                  if (recent.isNotEmpty) ...[
                    const SizedBox(height: 28),
                    const StoreExploreHeading(
                      title: 'New & updated',
                      subtitle:
                          'The latest additions and updates in this release.',
                    ),
                    const SizedBox(height: 8),
                    StoreListing(
                      key: const ValueKey('store-recent-collection'),
                      rowKeyPrefix: 'store-recent',
                      entries: recent,
                      ratingFor: ratingFor,
                      onOpen: onOpen,
                    ),
                  ],
                  if (topRated.length >= 2) ...[
                    const SizedBox(height: 28),
                    const StoreExploreHeading(
                      title: 'Top rated',
                      subtitle: 'Rated by the people building with them.',
                    ),
                    const SizedBox(height: 8),
                    StoreListing(
                      key: const ValueKey('store-top-rated-collection'),
                      rowKeyPrefix: 'store-top-rated',
                      showRanks: true,
                      entries: topRated,
                      ratingFor: ratingFor,
                      onOpen: onOpen,
                    ),
                  ],
                  if (crafts.isNotEmpty) ...[
                    const SizedBox(height: 32),
                    StoreExploreHeading(
                      title: 'A little beyond your comfort zone.',
                      subtitle: 'Pick a tool. Try a small idea. See where it takes you.',
                      action: 'Browse all',
                      onAction: onAll,
                    ),
                    const SizedBox(height: 8),
                    StoreListing(
                      entries: crafts.take(6).toList(),
                      ratingFor: ratingFor,
                      onOpen: onOpen,
                    ),
                    const SizedBox(height: 32),
                    const StoreExploreHeading(
                      title: 'Build across disciplines.',
                    ),
                    const SizedBox(height: 16),
                    LayoutBuilder(
                      builder: (context, constraints) {
                        final scale =
                            MediaQuery.textScalerOf(context).scale(14) / 14;
                        final columns = (constraints.maxWidth / (320 * scale))
                            .floor()
                            .clamp(1, 3);
                        final width =
                            (constraints.maxWidth - (columns - 1) * 16) /
                            columns;
                        return Wrap(
                          spacing: 16,
                          runSpacing: 16,
                          children: [
                            for (final name in categories)
                              SizedBox(
                                width: width,
                                child: _DisciplineLink(
                                  key: ValueKey('store-category:$name'),
                                  name: name,
                                  entries: crafts
                                      .where(
                                        (entry) =>
                                            storeCategoryFor(entry) == name,
                                      )
                                      .toList(),
                                  onTap: () => onCategory(name),
                                ),
                              ),
                          ],
                        );
                      },
                    ),
                    const SizedBox(height: 32),
                    Text(
                      'For polymaths in the making.',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: grid.AppPalette.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Learn the next craft through the things you build.',
                      style: TextStyle(
                        fontSize: 14,
                        height: 1.5,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ] else if (!loaded) ...[
                    const SizedBox(height: 32),
                    const SkeletonBlock(
                      child: Skeleton(height: 160, radius: 16),
                    ),
                  ] else ...[
                    const SizedBox(height: 32),
                    Text(
                      'Start with a coding agent. More disciplines will appear here as harnesses become available.',
                      style: TextStyle(
                        fontSize: 14,
                        height: 1.5,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _FeaturedStory extends StatelessWidget {
  const _FeaturedStory({required this.entry, required this.onTap});
  final DshEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final category = entry.isEngine
        ? 'Coding'
        : entry.id == 'autonomous/blender'
        ? 'Design'
        : 'Engineering';
    final headline = switch (category) {
      'Coding' => 'Build what comes next.',
      'Design' => 'Give your ideas shape.',
      _ => 'Build something real.',
    };
    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    return StoreExploreCard(
      key: ValueKey('store-feature:${entry.id}'),
      color: storeDiscipline(category).color,
      onTap: onTap,
      semanticLabel: 'Explore ${entry.name}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  category.toUpperCase(),
                  style: TextStyle(
                    fontSize: 10,
                    letterSpacing: 1.1,
                    fontWeight: FontWeight.w700,
                    color: grid.AppPalette.accentOnSurface,
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  height: 50 * scale,
                  child: Text(
                    headline,
                    style: TextStyle(
                      fontSize: 21,
                      height: 1.15,
                      letterSpacing: -.4,
                      fontWeight: FontWeight.w700,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                ),
                Row(
                  children: [
                    StoreAppIcon(entry: entry, size: 24),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Explore ${entry.name}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: grid.AppPalette.textSecondary,
                        ),
                      ),
                    ),
                    Icon(
                      LucideIcons.arrowRight300,
                      size: 15,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ],
                ),
              ],
            ),
          ),
          AspectRatio(
            aspectRatio: 2,
            child: StoreFeaturedArt(
              key: ValueKey('store-feature-art:${entry.id}'),
              category: category,
              entry: entry,
            ),
          ),
        ],
      ),
    );
  }
}

class _DisciplineLink extends StatelessWidget {
  const _DisciplineLink({
    super.key,
    required this.name,
    required this.entries,
    required this.onTap,
  });
  final String name;
  final List<DshEntry> entries;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final discipline = storeDiscipline(name);
    final example = discipline.example(entries)!;
    return StoreExploreCard(
      color: discipline.color,
      onTap: onTap,
      semanticLabel: 'Explore $name',
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Row(
          children: [
            StoreAppIcon(entry: example, size: 48),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    '${entries.length} ${entries.length == 1 ? 'harness' : 'harnesses'}',
                    style: TextStyle(
                      fontSize: 12,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Icon(
              LucideIcons.chevronRight300,
              size: 16,
              color: grid.AppPalette.textSecondary,
            ),
          ],
        ),
      ),
    );
  }
}
