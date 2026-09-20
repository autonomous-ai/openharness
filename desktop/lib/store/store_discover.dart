import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../widgets/engine_identity.dart';
import 'store_editorial.dart';
import 'store_exploration.dart';
import 'store_explore_widgets.dart';
import 'store_models.dart';

/// Invitations to explore, backed by the catalog on this machine. No invented
/// availability, popularity, or ratings; each preview opens its actual harness.
class StoreDiscover extends StatefulWidget {
  const StoreDiscover({
    super.key,
    required this.entries,
    required this.loaded,
    required this.ratingFor,
    required this.installed,
    required this.onOpen,
    required this.onAction,
    required this.onCollection,
    required this.onAll,
    required this.onEngines,
  });

  final List<DshEntry> entries;
  final bool loaded;
  final StoreRating Function(DshEntry) ratingFor;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;
  final ValueChanged<StoreCollection> onCollection;
  final VoidCallback onAll;
  final VoidCallback onEngines;

  @override
  State<StoreDiscover> createState() => _StoreDiscoverState();
}

class _StoreDiscoverState extends State<StoreDiscover> {
  final _paths = GlobalKey();

  void _explore() {
    final target = _paths.currentContext;
    if (target == null) return;
    Scrollable.ensureVisible(
      target,
      alignment: .03,
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 350),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final byId = {for (final entry in widget.entries) entry.id: entry};
    final samples = [
      for (final id in [
        'autonomous/blender',
        'autonomous/text-to-cad',
        'autonomous/mujoco',
        'autonomous/godogen',
        'autonomous/phaser',
        'autonomous/marimo',
      ])
        ?byId[id],
    ].take(3).toList();
    final engines = [
      for (final id in ['claude', 'codex', 'cursor']) ?byId[id],
    ];
    final crafts = widget.entries
        .where((e) => !e.isEngine && !e.isViewerPackage)
        .toList();
    const picks = [
      'autonomous/text-to-cad',
      'autonomous/score',
      'autonomous/marimo',
      'autonomous/mujoco',
      'autonomous/remotion',
      'autonomous/roundtable',
    ];
    crafts.sort((a, b) {
      final ai = picks.indexOf(a.id), bi = picks.indexOf(b.id);
      final rank = (ai < 0 ? 999 : ai).compareTo(bi < 0 ? 999 : bi);
      return rank == 0 ? a.name.compareTo(b.name) : rank;
    });
    final collections = storeCollections
        .where((c) => crafts.any(c.includes))
        .toList();
    return LayoutBuilder(
      builder: (context, box) {
        final padding = box.maxWidth < 680 ? 20.0 : 36.0;
        return SingleChildScrollView(
          key: const PageStorageKey('store-discover-scroll'),
          padding: EdgeInsets.fromLTRB(padding, 12, padding, 40),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _CuriosityHero(
                    samples: samples,
                    onOpen: widget.onOpen,
                    onExplore: collections.isEmpty
                        ? widget.onEngines
                        : _explore,
                  ),
                  if (engines.isNotEmpty) ...[
                    const SizedBox(height: 24),
                    _CodingStart(
                      entries: engines,
                      installed: widget.installed,
                      onOpen: widget.onOpen,
                      onAction: widget.onAction,
                      onAll: widget.onEngines,
                    ),
                  ],
                  if (collections.isNotEmpty) ...[
                    const SizedBox(height: 40),
                    StoreExploreHeading(
                      key: _paths,
                      title: 'Choose your next superpower.',
                      subtitle:
                          'A new discipline starts with one small project.',
                      action: 'Browse all',
                      onAction: widget.onAll,
                    ),
                    const SizedBox(height: 22),
                    LayoutBuilder(
                      builder: (context, constraints) {
                        final scale =
                            MediaQuery.textScalerOf(context).scale(14) / 14;
                        final columns =
                            constraints.maxWidth >= 1080 && scale <= 1.25
                            ? 3
                            : constraints.maxWidth >= 620 && scale <= 1.5
                            ? 2
                            : 1;
                        final width =
                            (constraints.maxWidth - (columns - 1) * 20) /
                            columns;
                        return Wrap(
                          spacing: 20,
                          runSpacing: 20,
                          children: [
                            for (final collection in collections)
                              SizedBox(
                                width: width,
                                child: _CuriosityPath(
                                  key: ValueKey(
                                    'store-collection:${collection.id}',
                                  ),
                                  collection: collection,
                                  entries: crafts
                                      .where(collection.includes)
                                      .toList(),
                                  onTap: () => widget.onCollection(collection),
                                ),
                              ),
                          ],
                        );
                      },
                    ),
                    const SizedBox(height: 42),
                    const StoreExploreHeading(
                      title: 'Make something you haven’t made before.',
                      subtitle: 'Real projects. Familiar agents. A few places to begin.',
                    ),
                    const SizedBox(height: 22),
                    StoreProjectGrid(
                      entries: crafts.take(6).toList(),
                      ratingFor: widget.ratingFor,
                      installed: widget.installed,
                      onOpen: widget.onOpen,
                      onAction: widget.onAction,
                    ),
                    const SizedBox(height: 40),
                    const StoreLearningNote(),
                  ] else if (!widget.loaded) ...[
                    const SizedBox(height: 32),
                    const SkeletonBlock(
                      child: Skeleton(height: 240, radius: 20),
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

class _CuriosityHero extends StatelessWidget {
  const _CuriosityHero({
    required this.samples,
    required this.onOpen,
    required this.onExplore,
  });
  final List<DshEntry> samples;
  final ValueChanged<String> onOpen;
  final VoidCallback onExplore;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final narrow =
          box.maxWidth < 650 || MediaQuery.textScalerOf(context).scale(14) > 20;
      final compact = box.maxWidth < 1000;
      const ink = Color(0xff182b24);
      final copy = Padding(
        padding: EdgeInsets.all(compact ? 28 : 38),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'FOR POLYMATHS IN THE MAKING',
              style: TextStyle(
                fontSize: 10,
                letterSpacing: 1.6,
                fontWeight: FontWeight.w700,
                color: Color(0xff45543a),
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'Follow your\ncuriosity.',
              style: TextStyle(
                fontSize: compact ? 45 : 59,
                height: .98,
                letterSpacing: -2.5,
                fontWeight: FontWeight.w700,
                color: ink,
              ),
            ),
            const SizedBox(height: 24),
            const Text(
              'Start with code. Build across disciplines.',
              style: TextStyle(
                fontSize: 16,
                height: 1.4,
                fontWeight: FontWeight.w600,
                color: ink,
              ),
            ),
            const SizedBox(height: 10),
            const Text(
              'A part. A film. A world of your own.\nGive your next idea somewhere to go.',
              style: TextStyle(
                fontSize: 14,
                height: 1.6,
                color: Color(0xff45543a),
              ),
            ),
            const SizedBox(height: 26),
            FilledButton.icon(
              onPressed: onExplore,
              iconAlignment: IconAlignment.end,
              style: FilledButton.styleFrom(
                backgroundColor: ink,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(
                  horizontal: 22,
                  vertical: 18,
                ),
              ),
              icon: const Icon(LucideIcons.arrowDown300, size: 16),
              label: const Text('Find your next project'),
            ),
          ],
        ),
      );
      final art = samples.isEmpty
          ? null
          : Padding(
              padding: const EdgeInsets.all(24),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: _HeroProject(
                      entry: samples.first,
                      tall: samples.length > 1,
                      onTap: () => onOpen(samples.first.id),
                    ),
                  ),
                  if (samples.length > 1) ...[
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        children: [
                          for (final entry in samples.skip(1)) ...[
                            _HeroProject(
                              entry: entry,
                              onTap: () => onOpen(entry.id),
                            ),
                            if (entry != samples.last)
                              const SizedBox(height: 14),
                          ],
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            );
      return Container(
        key: const ValueKey('store-curiosity-hero'),
        decoration: BoxDecoration(
          color: const Color(0xffdfefbc),
          borderRadius: BorderRadius.circular(24),
        ),
        clipBehavior: Clip.antiAlias,
        child: narrow || art == null
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [copy, ?art],
              )
            : Row(
                children: [
                  Expanded(flex: 11, child: copy),
                  Expanded(flex: 12, child: art),
                ],
              ),
      );
    },
  );
}

class _HeroProject extends StatelessWidget {
  const _HeroProject({
    required this.entry,
    required this.onTap,
    this.tall = false,
  });
  final DshEntry entry;
  final VoidCallback onTap;
  final bool tall;

  @override
  Widget build(BuildContext context) => Material(
    key: ValueKey('store-feature:${entry.id}'),
    color: const Color(0xff22302b),
    borderRadius: BorderRadius.circular(14),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Column(
        children: [
          AspectRatio(
            aspectRatio: tall ? .94 : 1.65,
            child: StoreProjectArt(entry: entry),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    entry.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                const Icon(
                  LucideIcons.arrowUpRight300,
                  size: 14,
                  color: Color(0xffdfefbc),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _CodingStart extends StatelessWidget {
  const _CodingStart({
    required this.entries,
    required this.installed,
    required this.onOpen,
    required this.onAction,
    required this.onAll,
  });
  final List<DshEntry> entries;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;
  final VoidCallback onAll;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        children: [
          Expanded(
            child: Text(
              'Your starting point: code.',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: grid.AppPalette.textSecondary,
              ),
            ),
          ),
          TextButton(onPressed: onAll, child: const Text('All coding agents')),
        ],
      ),
      const SizedBox(height: 8),
      LayoutBuilder(
        builder: (context, box) {
          final columns =
              box.maxWidth >= 650 &&
                  MediaQuery.textScalerOf(context).scale(14) <= 18
              ? 3
              : 1;
          final width = (box.maxWidth - (columns - 1) * 12) / columns;
          return Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (final entry in entries)
                SizedBox(
                  width: width,
                  child: Material(
                    key: ValueKey('store-card:${entry.id}'),
                    color: grid.AppSurface.recess,
                    borderRadius: BorderRadius.circular(14),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: () => onOpen(entry.id),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        child: Row(
                          children: [
                            EngineMark(
                              engine: entry.id,
                              displayName: entry.name,
                              size: 30,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                entry.name,
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: grid.AppPalette.textPrimary,
                                ),
                              ),
                            ),
                            TextButton(
                              key: ValueKey('store-action:${entry.id}'),
                              onPressed: () => onAction(entry),
                              child: Text(installed(entry.id) ? 'Open' : 'Get'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    ],
  );
}

class _CuriosityPath extends StatelessWidget {
  const _CuriosityPath({
    super.key,
    required this.collection,
    required this.entries,
    required this.onTap,
  });
  final StoreCollection collection;
  final List<DshEntry> entries;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final discipline = storeDiscipline(collection.categories.first);
    final example = storeCollectionExample(collection, entries)!;
    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    return StoreExploreCard(
      color: discipline.color,
      onTap: onTap,
      semanticLabel: 'Explore ${collection.title}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AspectRatio(aspectRatio: 2, child: StoreProjectArt(entry: example)),
          SizedBox(
            height: 195 * scale,
            child: Padding(
              padding: const EdgeInsets.all(22),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    collection.categories.join(' + ').toUpperCase(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10,
                      letterSpacing: 1.2,
                      fontWeight: FontWeight.w600,
                      color: grid.AppTheme.isDark
                          ? discipline.color
                          : const Color(0xff485648),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    collection.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 23,
                      height: 1.1,
                      letterSpacing: -.5,
                      fontWeight: FontWeight.w700,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    collection.subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.4,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  const Spacer(),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${entries.length} ${entries.length == 1 ? 'harness' : 'harnesses'} to explore',
                          style: TextStyle(
                            fontSize: 12,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ),
                      Icon(
                        LucideIcons.arrowRight300,
                        size: 18,
                        color: grid.AppPalette.textPrimary,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
