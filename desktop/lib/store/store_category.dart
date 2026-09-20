import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import 'store_listing.dart';
import 'store_exploration.dart';
import 'store_explore_widgets.dart';
import 'store_models.dart';

/// A discipline has its own invitation, real examples, and tools to try. Search
/// and the complete index keep their compact rows; individual pages are unchanged.
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
    required this.onAction,
  });

  final String name;
  final List<String> categories;
  final ValueChanged<String> onCategory;
  final List<DshEntry> entries;
  final bool loaded;
  final StoreRating Function(DshEntry) ratingFor;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;

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
    final onAction = widget.onAction;
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
          padding: EdgeInsets.fromLTRB(padding, 12, padding, 40),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _DisciplineHero(
                    name: name,
                    discipline: discipline,
                    entry: example,
                    headline: discipline.headline,
                    description: discipline.description,
                    onOpen: example == null ? null : () => onOpen(example.id),
                  ),
                  const SizedBox(height: 32),
                  StoreExploreHeading(
                    title: coding
                        ? 'The agents you already know.'
                        : discipline.invitation,
                    subtitle: entries.isEmpty && !loaded
                        ? null
                        : '${entries.length} ${coding ? (entries.length == 1 ? 'coding agent' : 'coding agents') : (entries.length == 1 ? 'harness' : 'harnesses')} to explore.',
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
                  else if (coding)
                    StoreListing(
                      entries: entries,
                      ratingFor: ratingFor,
                      installed: installed,
                      onOpen: onOpen,
                      onAction: onAction,
                    )
                  else
                    StoreProjectGrid(
                      entries: entries,
                      ratingFor: ratingFor,
                      installed: installed,
                      onOpen: onOpen,
                      onAction: onAction,
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
                  if (entries.isNotEmpty && !coding) ...[
                    const SizedBox(height: 40),
                    const StoreLearningNote(),
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
    required this.discipline,
    required this.entry,
    required this.headline,
    required this.description,
    required this.onOpen,
  });
  final String name;
  final StoreDiscipline discipline;
  final DshEntry? entry;
  final String headline;
  final String description;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final narrow =
          box.maxWidth < 650 || MediaQuery.textScalerOf(context).scale(14) > 20;
      final compact = box.maxWidth < 1000;
      final copy = Padding(
        padding: EdgeInsets.all(compact ? 26 : 36),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              name.toUpperCase(),
              style: const TextStyle(
                fontSize: 11,
                letterSpacing: 2,
                fontWeight: FontWeight.w700,
                color: Color(0xff344437),
              ),
            ),
            const SizedBox(height: 22),
            Text(
              headline,
              style: TextStyle(
                fontSize: compact ? 35 : 43,
                height: 1.05,
                letterSpacing: -1.6,
                fontWeight: FontWeight.w700,
                color: const Color(0xff182b24),
              ),
            ),
            const SizedBox(height: 18),
            Text(
              description,
              style: const TextStyle(
                fontSize: 14,
                height: 1.6,
                color: Color(0xff37473d),
              ),
            ),
            if (entry != null) ...[
              const SizedBox(height: 22),
              TextButton.icon(
                key: const ValueKey('store-category-feature'),
                onPressed: onOpen,
                iconAlignment: IconAlignment.end,
                icon: const Icon(LucideIcons.arrowUpRight300, size: 16),
                style: TextButton.styleFrom(
                  foregroundColor: const Color(0xff182b24),
                  backgroundColor: Colors.white.withValues(alpha: .55),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 18,
                    vertical: 14,
                  ),
                  shape: const StadiumBorder(),
                ),
                label: Text('Explore ${entry!.name}'),
              ),
            ],
          ],
        ),
      );
      final art = entry == null
          ? null
          : AspectRatio(
              aspectRatio: narrow ? 1.8 : 1.35,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: StoreProjectArt(entry: entry!),
                ),
              ),
            );
      return Container(
        key: const ValueKey('store-category-hero'),
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: discipline.color,
          borderRadius: BorderRadius.circular(24),
        ),
        child: narrow || art == null
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [copy, ?art],
              )
            : Row(
                children: [
                  Expanded(flex: 11, child: copy),
                  Expanded(flex: 10, child: art),
                ],
              ),
      );
    },
  );
}
