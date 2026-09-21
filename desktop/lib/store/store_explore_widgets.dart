import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/engine_identity.dart';
import 'store_editorial.dart';
import 'store_cover_art.dart';
import 'store_exploration.dart';

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
                fontSize: 21,
                height: 1.15,
                fontWeight: FontWeight.w700,
                letterSpacing: -.4,
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
              final viewport = cover.viewport;
              final imageSize = cover.imageSize;
              final framed = viewport == null || imageSize == null
                  ? Transform.scale(scale: cover.scale, child: child)
                  : FittedBox(
                      fit: cover.fit,
                      alignment: cover.alignment,
                      child: SizedBox(
                        width: viewport.width,
                        height: viewport.height,
                        child: ClipRect(
                          child: OverflowBox(
                            alignment: Alignment.topLeft,
                            minWidth: imageSize.width,
                            maxWidth: imageSize.width,
                            minHeight: imageSize.height,
                            maxHeight: imageSize.height,
                            child: Transform.translate(
                              offset: Offset(-viewport.left, -viewport.top),
                              child: child,
                            ),
                          ),
                        ),
                      ),
                    );
              return Stack(
                fit: StackFit.expand,
                children: [
                  ColoredBox(
                    color: cover.background ?? grid.AppPalette.panelBg,
                    child: ClipRect(child: framed),
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
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
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
    final radius = BorderRadius.circular(16);
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
