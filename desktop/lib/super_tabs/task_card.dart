import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/harness_activity.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';

/// One card of a project's Tasks view, on the Board and as a List row alike:
/// its title (up to [titleLines]), caption and shared activity mark.
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
    required this.activity,
    required this.onOpen,
    this.titleLines = 2,
    this.tile = false,
    this.selected = false,
    this.trailing,
  });

  final String title, caption;
  final bool needsYou, unread;
  final HarnessActivity activity;
  final VoidCallback onOpen;
  final int titleLines;
  final bool tile, selected;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final muted = DesktopChrome.metadata();
    return Semantics(
      button: true,
      selected: selected ? true : null,
      label: [
        title,
        caption,
        if (!needsYou)
          switch (activity) {
            HarnessActivity.starting => 'Queued',
            HarnessActivity.needsInput => 'Waiting on a person',
            HarnessActivity.offline => 'Blocked or agent lost',
            HarnessActivity.done => 'Shipped',
            _ => activity.label,
          },
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
                    Text(
                      title,
                      maxLines: titleLines,
                      overflow: TextOverflow.ellipsis,
                      style:
                          DesktopChrome.control(color: DesktopChrome.foreground)
                              .copyWith(
                                fontWeight: unread
                                    ? FontWeight.w600
                                    : FontWeight.w400,
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
              const SizedBox(width: grid.AppDesktop.menuInset),
              ActivityMark(
                activity: activity,
                color: DesktopChrome.foreground,
                tooltip: false,
              ),
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
