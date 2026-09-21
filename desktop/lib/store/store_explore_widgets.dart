import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/engine_identity.dart';
import 'store_editorial.dart';
import 'store_cover_art.dart';
import 'store_exploration.dart';
import 'store_models.dart';

class StoreExploreHeading extends StatelessWidget {
  const StoreExploreHeading({
    super.key,
    required this.title,
    this.subtitle,
    this.action,
    this.onAction,
  });
  final String title;
  final String? subtitle;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: TextStyle(
                fontSize: 25,
                height: 1.15,
                fontWeight: FontWeight.w700,
                letterSpacing: -.7,
                color: grid.AppPalette.textPrimary,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 8),
              Text(
                subtitle!,
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
      if (onAction != null) ...[
        const SizedBox(width: 16),
        TextButton(onPressed: onAction, child: Text(action!)),
      ],
    ],
  );
}

/// Curated covers for browsing; actual output images for prompt examples.
/// A failed cover falls back to the example, then the package's mark.
class StoreProjectArt extends StatelessWidget {
  const StoreProjectArt({
    super.key,
    required this.entry,
    this.fit = BoxFit.cover,
    this.showExample = false,
  });
  final DshEntry entry;
  final BoxFit fit;
  final bool showExample;

  @override
  Widget build(BuildContext context) {
    final color = storeDiscipline(storeCategoryFor(entry)).color;
    final fallback = DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [color.withValues(alpha: .25), grid.AppPalette.panelBg],
        ),
      ),
      child: Center(
        child: EngineMark(engine: entry.id, displayName: entry.name, size: 76),
      ),
    );
    final asset = storeProjectAsset(entry);
    final url =
        entry.examples.map((e) => e.image).whereType<String>().firstOrNull ??
        entry.screenshots.firstOrNull;
    final uri = url == null ? null : Uri.tryParse(url);
    final Widget example;
    if (asset != null) {
      example = Image.asset(
        asset,
        fit: fit,
        excludeFromSemantics: true,
        frameBuilder: (_, child, frame, _) => frame == null ? fallback : child,
        errorBuilder: (_, _, _) => fallback,
      );
    } else if (uri?.scheme == 'https' && uri!.hasAuthority) {
      example = Image.network(
        url!,
        fit: fit,
        excludeFromSemantics: true,
        frameBuilder: (_, child, frame, _) => frame == null ? fallback : child,
        errorBuilder: (_, _, _) => fallback,
      );
    } else {
      example = fallback;
    }
    final cover = showExample ? null : storeCoverArt[entry.id];
    final art = cover == null
        ? example
        : Image.asset(
            cover.asset,
            fit: cover.fit,
            alignment: cover.alignment,
            excludeFromSemantics: true,
            errorBuilder: (_, _, _) => example,
            frameBuilder: (context, child, frame, _) {
              if (frame == null) return example;
              return Stack(
                fit: StackFit.expand,
                children: [
                  ColoredBox(
                    color: cover.background ?? grid.AppPalette.panelBg,
                    child: ClipRect(
                      child: Transform.scale(scale: cover.scale, child: child),
                    ),
                  ),
                  if (cover.credit != null && cover.source != null)
                    Positioned(
                      right: 8,
                      bottom: 8,
                      child: _CoverCredit(cover: cover),
                    ),
                ],
              );
            },
          );
    return Semantics(
      label: '${entry.name} preview',
      image: true,
      child: SizedBox.expand(child: art),
    );
  }
}

class _CoverCredit extends StatelessWidget {
  const _CoverCredit({required this.cover});
  final StoreCoverArt cover;

  @override
  Widget build(BuildContext context) => Tooltip(
    message:
        '${cover.description}\n${cover.credit} · ${cover.license}\nView source',
    child: Material(
      color: const Color(0xc91a1b1e),
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () async {
          final messenger = ScaffoldMessenger.maybeOf(context);
          try {
            if (await launchUrl(
              Uri.parse(cover.source!),
              mode: LaunchMode.externalApplication,
            )) {
              return;
            }
          } catch (_) {
            // Keep the card usable if an external browser is unavailable.
          }
          if (messenger?.mounted == true) {
            messenger!.showSnackBar(
              const SnackBar(content: Text('Could not open the image source')),
            );
          }
        },
        child: Semantics(
          label: 'Image credit: ${cover.credit}. ${cover.license}. View source',
          button: true,
          child: const Padding(
            padding: EdgeInsets.all(9),
            child: Icon(LucideIcons.info300, size: 14, color: Colors.white),
          ),
        ),
      ),
    ),
  );
}

class StoreExploreCard extends StatefulWidget {
  const StoreExploreCard({
    super.key,
    required this.child,
    required this.onTap,
    required this.color,
    this.semanticLabel,
  });
  final Widget child;
  final VoidCallback onTap;
  final Color color;
  final String? semanticLabel;

  @override
  State<StoreExploreCard> createState() => _StoreExploreCardState();
}

class _StoreExploreCardState extends State<StoreExploreCard> {
  bool _hovered = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final active = _hovered || _focused;
    final radius = BorderRadius.circular(20);
    return AnimatedContainer(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 150),
      decoration: BoxDecoration(
        borderRadius: radius,
        border: Border.all(
          color: active ? widget.color : grid.AppPalette.divider,
          width: 1,
        ),
        boxShadow: active
            ? [
                BoxShadow(
                  color: widget.color.withValues(alpha: .08),
                  blurRadius: 20,
                ),
              ]
            : [],
      ),
      child: Material(
        color: grid.AppPalette.panelBg,
        borderRadius: radius,
        clipBehavior: Clip.antiAlias,
        child: Semantics(
          label: widget.semanticLabel,
          button: true,
          child: InkWell(
            onTap: widget.onTap,
            onHover: (value) => setState(() => _hovered = value),
            onFocusChange: (value) => setState(() => _focused = value),
            focusColor: widget.color.withValues(alpha: .10),
            hoverColor: widget.color.withValues(alpha: .04),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

class StoreProjectGrid extends StatelessWidget {
  const StoreProjectGrid({
    super.key,
    required this.entries,
    required this.ratingFor,
    required this.onOpen,
    required this.actionsFor,
    this.showExamples = false,
  });
  final List<DshEntry> entries;
  final StoreRating Function(DshEntry) ratingFor;
  final ValueChanged<String> onOpen;
  final Widget Function(DshEntry) actionsFor;
  final bool showExamples;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
      final columns = box.maxWidth >= 1080 && scale <= 1.25
          ? 3
          : box.maxWidth >= 620 && scale <= 1.5
          ? 2
          : 1;
      final width = (box.maxWidth - (columns - 1) * 20) / columns;
      return Wrap(
        spacing: 20,
        runSpacing: 20,
        children: [
          for (final entry in entries)
            SizedBox(
              width: width,
              child: _ProjectCard(
                key: ValueKey('store-card:${entry.id}'),
                entry: entry,
                rating: ratingFor(entry),
                onOpen: () => onOpen(entry.id),
                actions: actionsFor(entry),
                showExample: showExamples,
              ),
            ),
        ],
      );
    },
  );
}

class _ProjectCard extends StatelessWidget {
  const _ProjectCard({
    super.key,
    required this.entry,
    required this.rating,
    required this.onOpen,
    required this.actions,
    required this.showExample,
  });
  final DshEntry entry;
  final StoreRating rating;
  final VoidCallback onOpen;
  final Widget actions;
  final bool showExample;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    // Upstream covers describe the tool, not the result of our example prompt.
    final cover = showExample ? null : storeCoverArt[entry.id];
    final prompt = storeProjectPrompt(entry);
    final title = cover == null
        ? storeProjectTitle(entry)
        : prompt == null
        ? null
        : storeBenefit(entry);
    Future<void> copyPrompt() async {
      await Clipboard.setData(ClipboardData(text: prompt!));
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Prompt copied')));
      }
    }

    return StoreExploreCard(
      color: storeDiscipline(storeCategoryFor(entry)).color,
      onTap: onOpen,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AspectRatio(
            aspectRatio: 1.65,
            child: StoreProjectArt(entry: entry, showExample: showExample),
          ),
          SizedBox(
            height: 288 * scale,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      EngineMark(
                        engine: entry.id,
                        displayName: entry.name,
                        size: 26,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          entry.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 18,
                            height: 1.15,
                            fontWeight: FontWeight.w600,
                            color: grid.AppPalette.textPrimary,
                          ),
                        ),
                      ),
                      if (entry.hasUpdate)
                        Tooltip(
                          message: 'Update available',
                          child: Icon(
                            LucideIcons.arrowUpCircle300,
                            size: 16,
                            color: grid.AppPalette.accentOnSurface,
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (title != null) ...[
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        height: 1.3,
                        fontWeight: FontWeight.w600,
                        color: grid.AppPalette.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  Text(
                    prompt == null
                        ? storeBenefit(entry)
                        : cover == null
                        ? '“$prompt”'
                        : 'Try: “$prompt”',
                    maxLines: title == null ? 3 : 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.45,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  const Spacer(),
                  Row(
                    children: [
                      if (!rating.isEmpty) ...[
                        const Icon(
                          Icons.star_rounded,
                          size: 14,
                          color: Color(0xffd39c44),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '${rating.average.toStringAsFixed(1)} · ${rating.count}',
                          style: TextStyle(
                            fontSize: 12,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                        if (prompt != null) ...[
                          const SizedBox(width: 8),
                          AppIconButton(
                            key: ValueKey('store-copy-idea:${entry.id}'),
                            icon: LucideIcons.copy300,
                            size: 14,
                            tooltip: 'Copy prompt',
                            onPressed: copyPrompt,
                          ),
                        ],
                      ] else if (prompt != null) ...[
                        TextButton.icon(
                          key: ValueKey('store-copy-idea:${entry.id}'),
                          onPressed: copyPrompt,
                          style: TextButton.styleFrom(
                            foregroundColor: grid.AppPalette.textSecondary,
                            padding: const EdgeInsets.symmetric(horizontal: 4),
                            minimumSize: const Size(0, 34),
                          ),
                          icon: const Icon(LucideIcons.copy300, size: 13),
                          label: const Text(
                            'Copy prompt',
                            style: TextStyle(fontSize: 12),
                          ),
                        ),
                      ] else ...[
                        Text(
                          'Explore',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Icon(
                          LucideIcons.arrowUpRight300,
                          size: 14,
                          color: grid.AppPalette.textSecondary,
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 8),
                  actions,
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class StoreLearningNote extends StatelessWidget {
  const StoreLearningNote({super.key});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(28),
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: grid.AppPalette.divider)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Learn the next craft through the things you build.',
          style: TextStyle(
            fontSize: 23,
            height: 1.2,
            letterSpacing: -.5,
            fontWeight: FontWeight.w600,
            color: grid.AppPalette.textPrimary,
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Give an agent an idea. Inspect what it makes. Change a detail and try again. '
          'Your curiosity sets the direction; your judgment shapes what comes next.',
          style: TextStyle(
            fontSize: 14,
            height: 1.6,
            color: grid.AppPalette.textSecondary,
          ),
        ),
      ],
    ),
  );
}
