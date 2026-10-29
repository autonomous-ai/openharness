import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'catch_up.dart';

/// "While you were away", under the New messages line: what needs the reader,
/// what is blocked and what landed, each item opening its message
/// ([onOpen]), and Close ([onClose]). Each list has its words as well as its
/// mark, so colour is never the only signal.
class SuperTabCatchUpCard extends StatelessWidget {
  const SuperTabCatchUpCard({
    super.key,
    required this.summary,
    required this.onOpen,
    required this.onClose,
  });

  final SuperTabCatchUp summary;
  final ValueChanged<String> onOpen;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final decisions = summary.decisions;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.panelPadding,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.panelPadding,
        grid.AppDesktop.controlGap,
      ),
      child: Semantics(
        container: true,
        label: 'While you were away',
        child: DecoratedBox(
          key: const ValueKey('super-catch-up'),
          decoration: BoxDecoration(
            color: DesktopChrome.surface,
            border: Border.all(color: DesktopChrome.rim),
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.groupGap,
              grid.AppDesktop.controlGap,
              grid.AppDesktop.controlGap,
              grid.AppDesktop.groupGap,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _header(),
                _section(
                  'Needs you',
                  AppIcons.hand,
                  DesktopChrome.accent,
                  summary.needsYou,
                ),
                _section(
                  'Blocked',
                  AppIcons.triangleAlert,
                  grid.AppPalette.warn,
                  summary.blocked,
                ),
                _section(
                  'Landed',
                  AppIcons.circleCheck,
                  grid.AppPalette.online,
                  summary.landed,
                ),
                if (decisions > 0)
                  _note(
                    decisions == 1
                        ? '1 decision waits for you'
                        : '$decisions decisions wait for you',
                  ),
                // Never a partial summary read as the whole absence.
                if (summary.more)
                  _note(
                    'Covers only the first part of what you missed. '
                    'Newer messages are below.',
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _note(String text) => Padding(
    padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
    child: Text(text, style: DesktopChrome.metadata()),
  );

  Widget _header() => Row(
    children: [
      Icon(
        AppIcons.sparkles,
        size: grid.AppDesktop.iconSize,
        color: DesktopChrome.accent,
      ),
      const SizedBox(width: grid.AppDesktop.controlGap),
      Text('While you were away', style: DesktopChrome.control(medium: true)),
      const SizedBox(width: grid.AppDesktop.controlGap),
      // The count takes the spare width, so Close sits at the card's end.
      Expanded(
        child: Text(
          switch ((summary.unread, summary.more)) {
            (0, _) => '',
            (final count, true) => '$count+ new messages',
            (1, false) => '1 new message',
            (final count, false) => '$count new messages',
          },
          style: DesktopChrome.metadata(),
          overflow: TextOverflow.ellipsis,
        ),
      ),
      AppIconButton(
        key: const ValueKey('super-catch-up-close'),
        tooltip: 'Close',
        icon: AppIcons.close,
        onPressed: onClose,
      ),
    ],
  );

  Widget _section(
    String heading,
    IconData icon,
    Color color,
    SuperTabCatchUpList list,
  ) {
    if (list.items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            heading,
            style: DesktopChrome.metadata().copyWith(
              fontWeight: grid.AppFont.semibold,
            ),
          ),
          for (final item in list.items)
            _SuperTabCatchUpRow(
              item: item,
              icon: icon,
              color: color,
              onOpen: () => onOpen(item.messageId),
            ),
          if (list.more > 0)
            Text('${list.more} more', style: DesktopChrome.metadata()),
        ],
      ),
    );
  }
}

/// One item: its mark, who wrote it and what it says; opens its message.
class _SuperTabCatchUpRow extends StatelessWidget {
  const _SuperTabCatchUpRow({
    required this.item,
    required this.icon,
    required this.color,
    required this.onOpen,
  });

  final SuperTabCatchUpItem item;
  final IconData icon;
  final Color color;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) => InkWell(
    key: ValueKey('super-catch-up-${item.messageId}'),
    onTap: onOpen,
    hoverColor: grid.AppSurface.hoverFill,
    borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: grid.AppDesktop.listRowGap),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: grid.AppDesktop.listRowGap),
            child: Icon(icon, size: grid.AppDesktop.iconSize, color: color),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  if (item.author.isNotEmpty)
                    TextSpan(
                      text: '${item.author}  ',
                      style: DesktopChrome.control(medium: true),
                    ),
                  TextSpan(text: item.text, style: DesktopChrome.control()),
                ],
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    ),
  );
}
