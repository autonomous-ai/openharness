import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// Swarm Home's drawer, from the left edge like the desktop's sidebar: Swarm
/// Home, then the way back to Harness (the terminals), and Settings at its
/// foot. A row closes the drawer before it opens anything.
class SwarmDrawer extends StatelessWidget {
  const SwarmDrawer({
    super.key,
    required this.needs,
    this.onHarness,
    this.onSettings,
  });

  /// How many things wait on the person, beside Swarm Home.
  final int needs;

  /// Harness at the root; null where there is no shell to switch (a test).
  final VoidCallback? onHarness;

  /// Settings over Swarm Home, opened from the context it is given.
  final void Function(BuildContext context)? onSettings;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    void close() => Scaffold.of(context).closeDrawer();
    return Drawer(
      backgroundColor: AppPalette.panelBg,
      shape: const RoundedRectangleBorder(),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 8),
              child: TtyText(
                'Swarm',
                size: TtySize.title,
                weight: FontWeight.w600,
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 4),
                children: [
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-home'),
                    icon: LucideIcons.network300,
                    title: 'Swarm Home',
                    selected: true,
                    badge: needs > 0 ? '$needs' : null,
                    badgeColor: tty.yellow,
                    onTap: close,
                  ),
                  if (onHarness case final harness?)
                    SwarmDrawerRow(
                      key: const ValueKey('swarm-drawer-harness'),
                      icon: LucideIcons.squareTerminal300,
                      title: 'Harness',
                      onTap: () {
                        close();
                        harness();
                      },
                    ),
                ],
              ),
            ),
            if (onSettings case final settings?) ...[
              Divider(height: 1, thickness: 1, color: AppGlass.hair),
              SwarmDrawerRow(
                key: const ValueKey('swarm-drawer-settings'),
                icon: LucideIcons.settings300,
                title: 'Settings',
                onTap: () {
                  close();
                  settings(context);
                },
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// One row of the drawer: a glyph, a title and maybe a line under it, a
/// count, and at the right an optional control of its own.
class SwarmDrawerRow extends StatelessWidget {
  const SwarmDrawerRow({
    super.key,
    this.icon,
    required this.title,
    this.detail,
    this.badge,
    this.badgeColor,
    this.selected = false,
    this.indent = false,
    this.trailing,
    required this.onTap,
  });

  final IconData? icon;
  final String title;
  final Widget? detail;
  final String? badge;
  final Color? badgeColor;
  final bool selected;

  /// A chat under its project: lined up with the project's name.
  final bool indent;
  final Widget? trailing;
  final VoidCallback? onTap;

  /// Every row clears this, for a thumb.
  static const double height = 52;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Material(
      color: selected ? AppSurface.selectedFill : Colors.transparent,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: height),
          child: Padding(
            padding: EdgeInsets.only(
              left: indent ? Tty.origin + 22 + 14 : Tty.origin,
              right: trailing == null ? Tty.origin : 0,
            ),
            child: Row(
              children: [
                if (icon case final icon?) ...[
                  Icon(icon, size: 22, color: AppPalette.textSecondary),
                  const SizedBox(width: 14),
                ],
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: AppPalette.textPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        if (detail case final detail?) ...[
                          const SizedBox(height: 2),
                          detail,
                        ],
                      ],
                    ),
                  ),
                ),
                if (badge case final badge?)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TtyText(
                      badge,
                      color: badgeColor ?? tty.text,
                      weight: FontWeight.w600,
                      size: TtySize.meta,
                    ),
                  ),
                ?trailing,
              ],
            ),
          ),
        ),
      ),
    );
  }
}
