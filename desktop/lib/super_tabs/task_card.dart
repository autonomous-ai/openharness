import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// One card of a project's Tasks view, on the Board and as a List row alike:
/// its title (up to [titleLines]), then its caption, and "Needs you" with a red
/// dot when it waits on the reader. New replies make the title bold with a dot,
/// said to a screen reader, so colour is never the only signal.
///
/// On the Board it is a [tile] (task #2948): an inset tile set into its
/// column's panel, one step less rounded than the panel, with no shadow.
/// The task the reader has open is [selected]: the sidebar's selected-row
/// fill, not the blue keyboard selection, and said to a screen reader.
class SuperTabTaskCard extends StatelessWidget {
  const SuperTabTaskCard({
    super.key,
    required this.title,
    required this.caption,
    required this.needsYou,
    required this.unread,
    required this.onOpen,
    this.titleLines = 2,
    this.tile = false,
    this.selected = false,
    this.trailing,
  });

  final String title, caption;
  final bool needsYou, unread;
  final VoidCallback onOpen;
  final int titleLines;
  final bool tile, selected;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final muted = DesktopChrome.metadata();
    final dot = SizedBox.square(
      dimension: grid.AppDesktop.controlGap,
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: grid.AppPalette.dangerFill,
          shape: const CircleBorder(),
        ),
      ),
    );
    return Semantics(
      button: true,
      selected: selected ? true : null,
      label: [
        title,
        caption,
        if (needsYou) 'Needs you',
        if (unread) 'New replies',
      ].join(', '),
      excludeSemantics: true,
      child: _surface(
        Padding(
          padding: EdgeInsets.symmetric(
            horizontal: grid.AppDesktop.controlGap,
            vertical: tile
                ? grid.AppDesktop.controlGap
                : grid.AppDesktop.menuInset,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (needsYou)
                      Row(
                        children: [
                          dot,
                          const SizedBox(width: grid.AppDesktop.menuInset),
                          Text(
                            'Needs you',
                            style: DesktopChrome.metadata(
                              color: DesktopChrome.foreground,
                            ),
                          ),
                        ],
                      ),
                    Text(
                      title,
                      maxLines: titleLines,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.control(
                        color: DesktopChrome.foreground,
                        medium: unread,
                      ),
                    ),
                    if (caption.isNotEmpty)
                      Text(
                        caption,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: muted,
                      ),
                  ],
                ),
              ),
              if (unread) ...[
                const SizedBox(width: grid.AppDesktop.menuInset),
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.menuInset,
                  ),
                  child: SizedBox.square(
                    dimension: grid.AppDesktop.controlGap,
                    child: DecoratedBox(
                      decoration: ShapeDecoration(
                        color: grid.AppPalette.accent,
                        shape: const CircleBorder(),
                      ),
                    ),
                  ),
                ),
              ],
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }

  /// A List row is a plain row that takes the list's hover, filled when it is
  /// selected; a Board tile is inset material of its own. Each fill is [Ink]
  /// on its own [Material], so the hover paints over it inside its panel.
  Widget _surface(Widget body) {
    final radius = BorderRadius.circular(
      tile ? grid.AppCard.insetRadius : DesktopChrome.rowRadius,
    );
    final ink = InkWell(
      onTap: onOpen,
      hoverColor: grid.AppSurface.hoverFill,
      focusColor: grid.AppSurface.hoverFill,
      borderRadius: radius,
      child: body,
    );
    if (!tile && !selected) return ink;
    final fill = grid.AppSurface.selectedFill;
    return Material(
      type: MaterialType.transparency,
      child: Ink(
        decoration: tile
            ? BoxDecoration(
                color: selected
                    ? Color.alphaBlend(fill, grid.AppCard.inset)
                    : grid.AppCard.inset,
                borderRadius: radius,
                border: Border.all(color: grid.AppCard.insetHair),
              )
            : BoxDecoration(color: fill, borderRadius: radius),
        child: ink,
      ),
    );
  }
}
