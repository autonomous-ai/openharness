import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_b.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'profile_model.dart';
import 'swarm_face.dart';
import 'team_glance.dart';

/// The pieces Swarm's screens are drawn with, as the approved prototype v2
/// draws them: a top bar with its title beside the menu or back button,
/// captions in sentence case, cards of rows, round avatars, a project's
/// initial in a tile, filled counts, and buttons a thumb can find. Every
/// colour is one of the app's own tokens.

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
/// in the terminal's face, and under it maybe one quiet line; at its end
/// maybe one more button ([trailing]).
class SwarmTopBar extends StatelessWidget {
  const SwarmTopBar({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
    this.line,
    this.trailing,
    this.onTitle,
    this.titleLabel,
  });

  final Widget leading;
  final String title;
  final String? subtitle;

  /// A line of its own under the title in place of [subtitle]: a team line.
  final Widget? line;

  /// At the bar's end: a [SwarmIconButton].
  final Widget? trailing;

  /// The title, with its line, is a button too: a channel's name opens its
  /// details in Slack, a project's here. [titleLabel] is how it is heard.
  final VoidCallback? onTitle;
  final String? titleLabel;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    Widget words = Column(
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
        if (line case final line?)
          line
        else if (subtitle case final subtitle?)
          Text(
            subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppType.caption(color: AppPalette.textSecondary),
          ),
      ],
    );
    if (onTitle case final onTitle?) {
      words = Semantics(
        button: true,
        label: titleLabel,
        onTap: onTitle,
        excludeSemantics: titleLabel != null,
        child: InkWell(
          key: const ValueKey('swarm-title-button'),
          borderRadius: BorderRadius.circular(AppCard.insetRadius),
          onTap: onTitle,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget),
            child: Align(alignment: Alignment.centerLeft, child: words),
          ),
        ),
      );
    }
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.xs,
          AppSpace.xs,
          AppSpace.s,
          AppSpace.xs,
        ),
        child: Row(
          children: [
            leading,
            const SizedBox(width: 4),
            Expanded(child: words),
            ?trailing,
          ],
        ),
      ),
    );
  }
}

/// A tab's title at the top of its screen, in the terminal's face, with
/// maybe one button at its end ([trailing], a [SwarmIconButton]) and a quiet
/// line under it ([subtitle]). With [onTitle] the title is a button too,
/// [leading] before it and a chevron after it, as Home's Swarm switcher is:
/// [titleLabel] is how it is heard.
class SwarmTabHeader extends StatelessWidget {
  const SwarmTabHeader(
    this.title, {
    super.key,
    this.trailing,
    this.leading,
    this.onTitle,
    this.titleLabel,
    this.subtitle,
    this.loading = false,
  });

  final String title;
  final Widget? trailing;
  final Widget? leading;
  final VoidCallback? onTitle;
  final String? titleLabel;
  final String? subtitle;

  /// The title is on its way: a bar as tall as its words in their place.
  final bool loading;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final style = Tty.of(context)
        .style(size: 20, weight: FontWeight.w600)
        .copyWith(height: 1.2);
    final text = loading
        ? SkeletonText(
            key: const ValueKey('swarm-title-loading'),
            style: style,
            width: 120,
          )
        : Text(
            title,
            key: const ValueKey('swarm-title'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          );
    final onTitle = this.onTitle;
    final head = _title(text, onTitle);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          // A button's ink reaches past its words.
          onTitle == null ? AppSpace.screenInset : AppSpace.s,
          AppSpace.xs,
          AppSpace.xs,
          AppSpace.xs,
        ),
        child: Row(
          children: [
            Expanded(
              child: switch (subtitle) {
                null => head,
                final subtitle => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    head,
                    Padding(
                      padding: EdgeInsets.only(
                        left: onTitle == null ? 0 : AppSpace.xs,
                      ),
                      child: Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.caption(color: AppPalette.textSecondary),
                      ),
                    ),
                  ],
                ),
              },
            ),
            ?trailing,
          ],
        ),
      ),
    );
  }

  Widget _title(Widget text, VoidCallback? onTitle) => onTitle == null
      ? text
      : Align(
          alignment: Alignment.centerLeft,
          child: Semantics(
            key: const ValueKey('swarm-title-button'),
            button: true,
            label: titleLabel ?? title,
            excludeSemantics: true,
            onTap: onTitle,
            child: InkWell(
              borderRadius: BorderRadius.circular(AppControl.radius),
              onTap: onTitle,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: minTouchTarget),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (leading case final leading?) ...[
                        leading,
                        const SizedBox(width: AppSpace.s),
                      ],
                      Flexible(child: text),
                      const SizedBox(width: AppSpace.xs),
                      Icon(
                        LucideIcons.chevronDown300,
                        size: 18,
                        color: AppPalette.textFaint,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
}

/// A caption over a card, in sentence case, with maybe a count, or a
/// [note], or a control ([trailing]), at its right.
class SwarmCaption extends StatelessWidget {
  const SwarmCaption(
    this.text, {
    super.key,
    this.count,
    this.countColor,
    this.countKey = const ValueKey('swarm-needs-count'),
    this.note,
    this.first = false,
    this.trailing,
  });

  final String text;

  /// Quiet words at its right: what the card's column means, or a count in
  /// words ("Points this week", "2 working · 1 waiting").
  final String? note;

  /// How many there are: what waits on the person, in the warning colour
  /// unless [countColor] says otherwise; null shows none.
  final int? count;
  final Color? countColor;
  final Key countKey;

  /// The first thing on the screen: less room above it.
  final bool first;

  /// A control at its right end, a thumb's touch tall (44 points): Home's
  /// Sort and filter on its projects (Tony, 2026-11-03). Centred on the
  /// words, it takes the room above and under them, so they stay about where
  /// they are without it.
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final quiet = AppType.caption(
      color: Color.lerp(AppPalette.textFaint, AppPalette.textSecondary, .5),
    );
    if (trailing case final trailing?) {
      return Padding(
        padding: EdgeInsets.fromLTRB(
          AppSpace.xs,
          first ? 0 : AppSpace.s + 2,
          0,
          0,
        ),
        child: Row(
          children: [
            Expanded(child: Text(text, style: quiet)),
            trailing,
          ],
        ),
      );
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpace.xs,
        first ? AppSpace.s : AppSpace.xl,
        AppSpace.xs,
        AppSpace.s,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Expanded(child: Text(text, style: quiet)),
          if (note case final note? when note.isNotEmpty)
            Flexible(
              flex: 2,
              child: Text(
                note,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.end,
                style: quiet,
              ),
            ),
          if (count case final count? when count > 0)
            Text(
              '$count',
              key: countKey,
              style: tty
                  .style(size: 12.5, color: countColor ?? AppColors.warning)
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
      borderRadius: BorderRadius.circular(AppCard.radius),
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

/// A row's glyph ([SwarmRow.leading]): You's rows, Settings' when opened from
/// Swarm. In a 32-point box so the titles of a card line up.
class SwarmRowGlyph extends StatelessWidget {
  const SwarmRowGlyph(this.icon, {super.key});

  static const double width = 32;

  final IconData icon;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: width,
    child: Icon(icon, size: 22, color: AppPalette.textSecondary),
  );
}

/// A row on its way, in the shape of the row it stands for: a mark at its
/// left, a bar for its title and a longer one for the line under it, each as
/// tall as the line it stands for ([SkeletonText]), so nothing moves when the
/// row arrives. It stands for a card's row (`SwarmRow`) with a line under its
/// title — a need's — or its title alone ([titleOnly]), or a project's on Home
/// ([nameOnly]).
class SwarmSkeletonRow extends StatelessWidget {
  const SwarmSkeletonRow({
    super.key,
    this.round = false,
    this.titleOnly = false,
    this.nameOnly = false,
    this.width = .45,
  });

  /// An avatar's round mark rather than a project's tile.
  final bool round;

  /// The row it stands for has no line under its title.
  final bool titleOnly;

  /// A project's row on Home ([SwarmHomeProjectRow]): its name alone, with no
  /// mark before it, on its one line, as tall as it.
  final bool nameOnly;

  /// The title bar's share of the row's words.
  final double width;

  @override
  Widget build(BuildContext context) {
    // The real rows' metrics.
    final title = AppType.label(height: 1.3);
    final line = AppType.caption(height: 1.35);
    final titleOnly = this.titleOnly || nameOnly;
    return ConstrainedBox(
      constraints: BoxConstraints(minHeight: nameOnly ? minTouchTarget : 56),
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: AppSpace.l,
          vertical: nameOnly ? AppSpace.xs : AppSpace.m,
        ),
        child: Row(
          children: [
            if (!nameOnly) ...[
              Skeleton(
                width: 32,
                height: 32,
                radius: 8,
                shape: round ? BoxShape.circle : BoxShape.rectangle,
              ),
              const SizedBox(width: 12),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  SkeletonText(style: title, widthFactor: width),
                  if (!titleOnly) ...[
                    const SizedBox(height: 3),
                    SkeletonText(
                      style: line,
                      widthFactor: (width + .25).clamp(0, 1),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// [rows] rows on their way ([SwarmSkeletonRow]), in a card ([SwarmGroup]),
/// fading towards the last; one "Loading" to a screen reader. Keyed [id]; its
/// row `i`, `$id-$i`.
class SwarmSkeletonRows extends StatelessWidget {
  SwarmSkeletonRows({
    required this.id,
    this.rows = 2,
    this.round = false,
    this.titleOnly = false,
    this.nameOnly = false,
  }) : super(key: ValueKey(id));

  final String id;
  final int rows;

  /// Avatars' round marks rather than projects' tiles.
  final bool round;

  /// Rows with no line under their titles ([SwarmSkeletonRow.titleOnly]).
  final bool titleOnly;

  /// Projects' rows on Home ([SwarmSkeletonRow.nameOnly]).
  final bool nameOnly;

  @override
  Widget build(BuildContext context) {
    final children = [
      for (var i = 0; i < rows; i++)
        Opacity(
          opacity: skeletonFade(i, rows, depth: .4),
          child: SwarmSkeletonRow(
            key: ValueKey('$id-$i'),
            round: round,
            titleOnly: titleOnly,
            nameOnly: nameOnly,
            width: i.isEven ? .45 : .6,
          ),
        ),
    ];
    return SkeletonBlock(child: SwarmGroup(children: children));
  }
}

/// A person's or an agent's round mark: their picture, or their initial on
/// their colour; a person's status emoji at its corner while it lasts.
class SwarmAvatar extends StatelessWidget {
  const SwarmAvatar({
    super.key,
    required this.id,
    required this.name,
    this.size = 32,
    this.picture,
    this.status,
  });

  final String id, name;
  final double size;

  /// What they chose to wear; null wears the initial.
  final SuperTabAvatarPicture? picture;

  /// A person's status; null for an agent.
  final SuperTabPersonStatus? status;

  @override
  Widget build(BuildContext context) {
    final color = swarmAvatarColor(id);
    final face = SwarmFace(
      picture: picture,
      size: size,
      tint: color,
      fallback: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        child: Text(
          _initial(name),
          style: TextStyle(
            color: AppInk.onFill,
            fontSize: size >= 32 ? 13.5 : 11,
            fontWeight: FontWeight.w600,
            height: 1,
          ),
        ),
      ),
    );
    return SwarmStatusFace(name: name, size: size, status: status, face: face);
  }
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
        borderRadius: BorderRadius.circular(AppCard.insetRadius),
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

/// The Lead's tags still waiting on the person in a chat or a project, at
/// its row's trailing edge: "@2" in the warning ink, said in words (desktop
/// design system: Mentions); [filled], on an accent pill, as Home's project
/// rows draw it (Tony's prototype B1, 2026-10-29).
class SwarmTags extends StatelessWidget {
  const SwarmTags(this.count, {super.key, this.filled = false});

  final int count;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final text = Text(
      '@$count',
      maxLines: 1,
      style: AppType.caption(
        color: filled ? AppInk.onFill : AppColors.warning,
        fontWeight: AppFont.semibold,
        height: filled ? 1 : null,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
    return Semantics(
      label: count == 1 ? '1 mention' : '$count mentions',
      excludeSemantics: true,
      child: filled
          ? Container(
              constraints: const BoxConstraints(minWidth: 22, minHeight: 20),
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
              alignment: Alignment.center,
              decoration: ShapeDecoration(
                color: AppPalette.accent,
                shape: const StadiumBorder(),
              ),
              child: text,
            )
          : text,
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
    padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
    alignment: Alignment.center,
    decoration: ShapeDecoration(
      color: warn ? AppColors.warning : AppPalette.accent,
      shape: const StadiumBorder(),
    ),
    child: Text(
      '$count',
      style: AppType.caption(
        color: warn ? SwarmInk.onWarning : AppInk.onFill,
        fontWeight: AppFont.semibold,
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
      SwarmButtonStyle.fill => (AppPalette.accent, AppInk.onFill, null),
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
          borderRadius: BorderRadius.circular(AppControl.radius),
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
                horizontal: style == SwarmButtonStyle.link
                    ? AppSpace.m
                    : AppSpace.l,
                vertical: AppSpace.s,
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

/// A choice of a few, side by side, that takes effect on the tap — Settings'
/// Theme: System | Dark | Light.
///
/// Swarm's chips (Activity's filters) drawn as one control: a pill track in the
/// search surface, the chosen segment filled in the primary ink with the
/// page's ground for its words, the others in the secondary ink. A segment is
/// a compact control ([AppControl.heightSmall]) with a control's words
/// ([AppType.label]); it is pressed across 44 points of height though it draws
/// 28, so the track sits in a 56-point row as the − + stepper does.
class SwarmSegments<T> extends StatelessWidget {
  const SwarmSegments({
    super.key,
    required this.values,
    required this.selected,
    required this.label,
    required this.onSelected,
  });

  final List<T> values;
  final T selected;
  final String Function(T value) label;

  /// A segment tapped that is not [selected] already.
  final ValueChanged<T> onSelected;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return DecoratedBox(
      decoration: ShapeDecoration(
        color: AppPalette.swarmSearchSurface,
        shape: const StadiumBorder(),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.xs),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final value in values)
              _SwarmSegment(
                label: label(value),
                selected: value == selected,
                onTap: () => onSelected(value),
              ),
          ],
        ),
      ),
    );
  }
}

class _SwarmSegment extends StatelessWidget {
  const _SwarmSegment({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // The chosen one is already chosen: no click, nothing sent.
    final VoidCallback? choose = selected
        ? null
        : () {
            HapticFeedback.selectionClick();
            onTap();
          };
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      // Its children's semantics are excluded, the InkWell's tap with them: a
      // screen reader taps through this node (review of #2920).
      onTap: choose,
      excludeSemantics: true,
      child: TouchTarget(
        child: Material(
          color: selected ? AppPalette.textPrimary : Colors.transparent,
          shape: const StadiumBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: choose,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppControl.heightSmall,
                minWidth: minTouchTarget,
              ),
              child: Padding(
                // Three at the label size, System the longest, fit a 375-point
                // phone's row beside its title without shrinking.
                padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
                child: Center(
                  widthFactor: 1,
                  heightFactor: 1,
                  child: Text(
                    label,
                    maxLines: 1,
                    style: AppType.label(
                      color: selected
                          ? AppPalette.windowBg
                          : AppPalette.textSecondary,
                      fontWeight: selected ? AppFont.semibold : AppFont.medium,
                      height: 1.2,
                    ),
                  ),
                ),
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
    this.selected,
    this.dot = false,
  });

  final IconData icon;
  final String label;

  /// Null: greyed, and heard as not enabled.
  final VoidCallback? onPressed;
  final double size;

  /// A switch's state: on, it is tinted in the accent; null for a plain
  /// button.
  final bool? selected;

  /// A dot in the accent at the glyph's corner: something is changed from its
  /// default. Say what in [label], as a dot is not heard.
  final bool dot;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final onPressed = this.onPressed;
    final on = selected ?? false;
    final color = onPressed == null
        ? AppPalette.textFaint
        : on
        ? AppPalette.swarmAccent
        : AppPalette.textPrimary;
    return Semantics(
      button: true,
      enabled: onPressed != null,
      toggled: selected,
      label: label,
      excludeSemantics: true,
      onTap: onPressed,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onPressed == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onPressed();
              },
        child: SizedBox.square(
          dimension: 44,
          child: Center(
            child: DecoratedBox(
              decoration: ShapeDecoration(
                color: on
                    ? AppPalette.swarmAccent.withValues(alpha: .16)
                    : Colors.transparent,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppControl.radius),
                ),
              ),
              child: SizedBox.square(
                dimension: 36,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    Icon(icon, size: size, color: color),
                    if (dot)
                      PositionedDirectional(
                        top: AppSpace.xs,
                        end: AppSpace.xs,
                        child: SizedBox.square(
                          key: const ValueKey('swarm-icon-dot'),
                          dimension: AppSpace.s,
                          child: DecoratedBox(
                            decoration: ShapeDecoration(
                              color: AppPalette.swarmAccent,
                              shape: const CircleBorder(),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
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
