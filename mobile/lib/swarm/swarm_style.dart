import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'team_glance.dart';

/// The pieces Swarm's screens are drawn with, as the approved prototype v2
/// draws them: a top bar with its title beside the menu or back button,
/// captions in sentence case, cards of rows, round avatars, a project's
/// initial in a tile, filled counts, and buttons a thumb can find. Every
/// colour is one of the app's own tokens.

/// Ink on a dark warning fill: a count waiting on the person.
const _onWarn = Color(0xFF1A1200);

/// The colour of an agent's state: working green, waiting yellow, down red.
Color swarmStateColor(SwarmAgentState state) => switch (state) {
  SwarmAgentState.working => AppColors.success,
  SwarmAgentState.waiting || SwarmAgentState.stuck => AppColors.warning,
  SwarmAgentState.down => AppColors.danger,
  SwarmAgentState.limited || SwarmAgentState.idle => AppPalette.textFaint,
};

/// The colour [id]'s avatar takes, the same on every screen and every run.
Color swarmAvatarColor(String id) {
  // FNV-1a: String.hashCode is not promised to be stable across runs.
  var hash = 0x811c9dc5;
  for (final unit in id.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0xffffffff;
  }
  return AppPalette.avatarPalette[hash % AppPalette.avatarPalette.length];
}

String _initial(String name) {
  final trimmed = name.trim();
  return trimmed.isEmpty ? '?' : trimmed.characters.first.toUpperCase();
}

/// A screen's top bar: the menu or back button ([leading], a 44-point
/// [SwarmIconButton]) 4 points in from the edge, the title 4 points beside it
/// in the terminal's face, and under it maybe one quiet line.
class SwarmTopBar extends StatelessWidget {
  const SwarmTopBar({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
  });

  final Widget leading;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 2, 8, 2),
        child: Row(
          children: [
            leading,
            const SizedBox(width: 4),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    key: const ValueKey('swarm-title'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: tty
                        .style(size: 17, weight: FontWeight.w600)
                        .copyWith(height: 1.25),
                  ),
                  if (subtitle case final subtitle?)
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textSecondary,
                        fontSize: 13,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A caption over a card, in sentence case, with maybe a count at its right.
class SwarmCaption extends StatelessWidget {
  const SwarmCaption(this.text, {super.key, this.count, this.first = false});

  final String text;

  /// What waits on the person, in the warning colour; null shows none.
  final int? count;

  /// The first thing on the screen: less room above it.
  final bool first;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(4, first ? 6 : 24, 4, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: Color.lerp(
                  AppPalette.textFaint,
                  AppPalette.textSecondary,
                  .5,
                ),
                fontSize: 13,
              ),
            ),
          ),
          if (count case final count? when count > 0)
            Text(
              '$count',
              key: const ValueKey('swarm-needs-count'),
              style: tty
                  .style(size: 12.5, color: AppColors.warning)
                  .copyWith(height: 1),
            ),
        ],
      ),
    );
  }
}

/// A card of rows, a hairline between them.
class SwarmGroup extends StatelessWidget {
  const SwarmGroup({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: ColoredBox(
        color: AppGlass.rowFill,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (i, child) in children.indexed) ...[
              if (i > 0) Divider(height: 1, thickness: 1, color: AppGlass.hair),
              child,
            ],
          ],
        ),
      ),
    );
  }
}

/// A person's or an agent's round mark: their initial on their colour.
class SwarmAvatar extends StatelessWidget {
  const SwarmAvatar({
    super.key,
    required this.id,
    required this.name,
    this.size = 32,
    this.ring,
  });

  final String id, name;
  final double size;

  /// A ring of this colour around it, where avatars overlap.
  final Color? ring;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: swarmAvatarColor(id),
      shape: BoxShape.circle,
      border: ring == null
          ? null
          : Border.all(
              color: ring!,
              width: 2,
              strokeAlign: BorderSide.strokeAlignOutside,
            ),
    ),
    child: Text(
      _initial(name),
      style: TextStyle(
        color: Colors.white,
        fontSize: size >= 32 ? 13.5 : 11,
        fontWeight: FontWeight.w600,
        height: 1,
      ),
    ),
  );
}

/// A project's mark: its initial in a rounded tile.
class SwarmProjectTile extends StatelessWidget {
  const SwarmProjectTile(this.name, {super.key});

  final String name;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: AppPalette.swarmSearchSurface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        _initial(name).toLowerCase(),
        style: tty
            .style(
              size: 14,
              weight: FontWeight.w600,
              color: AppPalette.swarmAccent,
            )
            .copyWith(height: 1),
      ),
    );
  }
}

/// A count in a filled circle: blue, or yellow for what waits on the person.
class SwarmBadge extends StatelessWidget {
  const SwarmBadge(this.count, {super.key, this.warn = false});

  final int count;
  final bool warn;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 22, minHeight: 22),
    padding: const EdgeInsets.symmetric(horizontal: 7),
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: warn ? AppColors.warning : AppPalette.accent,
      borderRadius: BorderRadius.circular(11),
    ),
    child: Text(
      '$count',
      style: TextStyle(
        color: warn ? _onWarn : Colors.white,
        fontSize: 12.5,
        fontWeight: FontWeight.w600,
        height: 1,
      ),
    ),
  );
}

/// How a [SwarmButton] is drawn.
enum SwarmButtonStyle {
  /// A quiet button on a field, rimmed: a decision's option.
  plain,

  /// The screen's one main action, filled.
  fill,

  /// Words alone, in the accent: the second way out.
  link,
}

/// A button at least 44 points tall, in the app's sans face.
class SwarmButton extends StatelessWidget {
  const SwarmButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.style = SwarmButtonStyle.plain,
    this.icon,
    this.wide = false,
    this.busy = false,
    this.busyLabel,
  });

  final String label;
  final VoidCallback? onPressed;
  final SwarmButtonStyle style;
  final IconData? icon;

  /// The whole width, taller and bolder: a screen's main action.
  final bool wide;

  /// Working: a spinner and [busyLabel], and taps do nothing.
  final bool busy;
  final String? busyLabel;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final (fill, ink, rim) = switch (style) {
      SwarmButtonStyle.plain => (
        AppPalette.swarmSearchSurface,
        AppPalette.textPrimary,
        AppGlass.hair,
      ),
      SwarmButtonStyle.fill => (AppPalette.accent, Colors.white, null),
      SwarmButtonStyle.link => (null, AppPalette.swarmAccent, null),
    };
    final enabled = onPressed != null && !busy;
    final text = TextStyle(
      color: ink,
      fontSize: wide ? 16 : 15,
      fontWeight: wide ? FontWeight.w600 : FontWeight.w500,
      height: 1.25,
    );
    return Semantics(
      button: true,
      enabled: enabled,
      label: busy ? busyLabel ?? label : label,
      excludeSemantics: true,
      child: Material(
        color: fill ?? Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: rim == null ? BorderSide.none : BorderSide(color: rim),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: enabled
              ? () {
                  HapticFeedback.selectionClick();
                  onPressed!();
                }
              : null,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: wide ? 52 : 44),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: style == SwarmButtonStyle.link ? 10 : 18,
                vertical: 8,
              ),
              child: Row(
                mainAxisSize: wide ? MainAxisSize.max : MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (busy) ...[
                    SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: ink,
                        backgroundColor: ink.withValues(alpha: .35),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ] else if (icon case final icon?) ...[
                    Icon(icon, size: 20, color: ink),
                    const SizedBox(width: 8),
                  ],
                  Flexible(
                    child: Text(
                      busy ? busyLabel ?? label : label,
                      textAlign: TextAlign.center,
                      style: text,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A round 44-point button holding one glyph: the drawer's close, the top
/// bar's menu and back ([size] 24 there).
class SwarmIconButton extends StatelessWidget {
  const SwarmIconButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
    this.size = 22,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final double size;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onPressed();
        },
        child: SizedBox.square(
          dimension: 44,
          child: Icon(icon, size: size, color: AppPalette.textPrimary),
        ),
      ),
    );
  }
}

/// A Swarm page's back, in its top bar ([SwarmTopBar]); keyed as the app's
/// other back buttons are.
class SwarmBackButton extends StatelessWidget {
  const SwarmBackButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => SwarmIconButton(
    key: const ValueKey('tty-back'),
    icon: LucideIcons.chevronLeft300,
    size: 24,
    label: 'Back',
    onPressed: onPressed,
  );
}
