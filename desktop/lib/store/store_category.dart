import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import 'store_listing.dart';
import 'store_featured_art.dart';
import 'store_exploration.dart';
import 'store_explore_widgets.dart';
import 'store_models.dart';

/// A short invitation and an icon-led catalog. Product details and examples
/// remain one click away; browsing never turns into a wall of screenshots.
class StoreCategory extends StatefulWidget {
  const StoreCategory({
    super.key,
    required this.name,
    required this.categories,
    required this.onCategory,
    required this.entries,
    required this.loaded,
    required this.ratingFor,
    required this.installed,
    required this.onOpen,
  });

  final String name;
  final List<String> categories;
  final ValueChanged<String> onCategory;
  final List<DshEntry> entries;
  final bool loaded;
  final StoreRating Function(DshEntry) ratingFor;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;

  @override
  State<StoreCategory> createState() => _StoreCategoryState();
}

class _StoreCategoryState extends State<StoreCategory> {
  bool _installedOnly = false;
  bool _restored = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_restored) {
      _installedOnly =
          PageStorage.maybeOf(
            context,
          )?.readState(context, identifier: 'store-installed:${widget.name}') ==
          true;
      _restored = true;
    }
  }

  void _filter(bool installedOnly) {
    setState(() => _installedOnly = installedOnly);
    PageStorage.maybeOf(context)?.writeState(
      context,
      installedOnly,
      identifier: 'store-installed:${widget.name}',
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final name = widget.name;
    final loaded = widget.loaded;
    final ratingFor = widget.ratingFor;
    final installed = widget.installed;
    final onOpen = widget.onOpen;
    final installedCount = widget.entries.where((e) => installed(e.id)).length;
    final entries = _installedOnly
        ? widget.entries.where((e) => installed(e.id)).toList()
        : widget.entries;
    final related = (storeRelatedDisciplines[name] ?? const <String>[])
        .where(widget.categories.contains)
        .toList();
    final discipline = storeDiscipline(name);
    final example = discipline.example(widget.entries);
    final coding = name == 'Coding';
    return LayoutBuilder(
      builder: (context, box) {
        final padding = box.maxWidth < 680 ? 20.0 : 36.0;
        return SingleChildScrollView(
          key: ValueKey('store-catalog:$name'),
          padding: EdgeInsets.fromLTRB(padding, 32, padding, 40),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _DisciplineHero(
                    name: name,
                    entry: example,
                    headline: discipline.headline,
                    description: discipline.description,
                    onOpen: example == null ? null : () => onOpen(example.id),
                  ),
                  const SizedBox(height: 26),
                  StoreExploreHeading(
                    title: coding ? 'Coding agents' : 'Explore $name',
                    subtitle: entries.isEmpty && !loaded
                        ? null
                        : '${entries.length} ${coding ? (entries.length == 1 ? 'coding agent' : 'coding agents') : (entries.length == 1 ? 'harness' : 'harnesses')}',
                  ),
                  const SizedBox(height: 14),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      ChoiceChip(
                        key: const ValueKey('store-filter-all'),
                        label: const Text('All'),
                        selected: !_installedOnly,
                        showCheckmark: false,
                        onSelected: (_) => _filter(false),
                      ),
                      ChoiceChip(
                        key: const ValueKey('store-filter-installed'),
                        label: Text('Installed · $installedCount'),
                        selected: _installedOnly,
                        showCheckmark: false,
                        onSelected: (_) => _filter(true),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  if (entries.isEmpty && _installedOnly)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 36),
                      child: Column(
                        children: [
                          Text(
                            'Your next tool is waiting.',
                            style: TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w600,
                              color: grid.AppPalette.textPrimary,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Explore the harnesses in $name and choose one to try.',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 14,
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 14),
                          TextButton(
                            onPressed: () => _filter(false),
                            child: const Text('Show all harnesses'),
                          ),
                        ],
                      ),
                    )
                  else if (entries.isEmpty)
                    loaded
                        ? Padding(
                            padding: const EdgeInsets.symmetric(vertical: 36),
                            child: Text(
                              'Nothing here yet.',
                              style: TextStyle(
                                color: grid.AppPalette.textSecondary,
                              ),
                            ),
                          )
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Asking this computer…',
                                style: TextStyle(
                                  color: grid.AppPalette.textSecondary,
                                ),
                              ),
                              const SizedBox(height: 16),
                              const SkeletonBlock(
                                child: Skeleton(height: 210, radius: 20),
                              ),
                            ],
                          )
                  else
                    StoreListing(
                      entries: entries,
                      ratingFor: ratingFor,
                      onOpen: onOpen,
                    ),

                  if (related.isNotEmpty) ...[
                    const SizedBox(height: 36),
                    const StoreExploreHeading(
                      title: 'Where could this take you next?',
                    ),
                    const SizedBox(height: 16),
                    Wrap(
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        for (final category in related)
                          ActionChip(
                            key: ValueKey('store-related:$category'),
                            avatar: Icon(
                              LucideIcons.arrowUpRight300,
                              size: 14,
                              color: grid.AppPalette.textSecondary,
                            ),
                            label: Text(category),
                            onPressed: () => widget.onCategory(category),
                          ),
                      ],
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

class _DisciplineHero extends StatelessWidget {
  const _DisciplineHero({
    required this.name,
    required this.entry,
    required this.headline,
    required this.description,
    required this.onOpen,
  });
  final String name;
  final DshEntry? entry;
  final String headline;
  final String description;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) => Column(
    key: const ValueKey('store-category-hero'),
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(
        name,
        style: TextStyle(
          fontSize: 34,
          height: 1.15,
          letterSpacing: -1,
          fontWeight: FontWeight.w700,
          color: grid.AppPalette.textPrimary,
        ),
      ),
      const SizedBox(height: 20),
      LayoutBuilder(
        builder: (context, box) {
          final compact =
              box.maxWidth < 740 ||
              MediaQuery.textScalerOf(context).scale(14) > 20;
          final copy = Padding(
            padding: const EdgeInsets.all(26),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'GET STARTED',
                  style: TextStyle(
                    fontSize: 10,
                    letterSpacing: 1.2,
                    fontWeight: FontWeight.w700,
                    color: grid.AppPalette.accentOnSurface,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  headline.replaceAll('\n', ' '),
                  style: TextStyle(
                    fontSize: 27,
                    height: 1.15,
                    letterSpacing: -.5,
                    fontWeight: FontWeight.w700,
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  description,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.5,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
                if (entry != null) ...[
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      StoreAppIcon(entry: entry!, size: 30),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Explore ${entry!.name}',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: grid.AppPalette.textPrimary,
                          ),
                        ),
                      ),
                      Icon(
                        LucideIcons.arrowRight300,
                        size: 16,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ],
                  ),
                ],
              ],
            ),
          );
          final art = entry == null
              ? null
              : AspectRatio(
                  aspectRatio: 2,
                  child: StoreFeaturedArt(category: name, entry: entry!),
                );
          final body = compact || art == null
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [copy, ?art],
                )
              : Row(
                  children: [
                    Expanded(child: copy),
                    Expanded(child: art),
                  ],
                );
          return entry == null
              ? body
              : StoreExploreCard(
                  key: const ValueKey('store-category-feature'),
                  color: storeDiscipline(name).color,
                  onTap: onOpen!,
                  semanticLabel: 'Explore ${entry!.name}',
                  child: body,
                );
        },
      ),
    ],
  );
}
