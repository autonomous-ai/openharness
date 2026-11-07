import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/pull_request_icon.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'backlog.dart';
import 'chip.dart';
import 'identity.dart';
import 'model.dart';
import 'task_groups.dart';

/// A Board card's pull request ("#3480") and acceptance checks done of all.
/// None of a kind shows nothing (task #3869).
class SuperTabCardFacts {
  const SuperTabCardFacts({this.pullRequest, this.checks});
  final String? pullRequest;
  final ({int done, int total})? checks;
  bool get isEmpty => pullRequest == null && checks == null;
}

/// One card of a project's Tasks view, on the Board and as a List row alike:
/// its title (up to [titleLines]), its caption led by its [priority] (task
/// #3117), and its shared activity mark.
///
/// On the Board it is a [tile], drawn as Trello draws a card (anh Dee, task
/// #3787): raised card material on its column's tinted lane, rounded one
/// step less than the lane, with a soft shadow that lifts on hover; its
/// [lane]'s colour label on top, then the title, then one quiet line of
/// priority and caption. The task the reader has open is [selected]: the
/// sidebar's selected-row fill, not the blue keyboard selection, and said to
/// a screen reader.
class SuperTabTaskCard extends StatefulWidget {
  const SuperTabTaskCard({
    super.key,
    required this.title,
    required this.caption,
    required this.needsYou,
    required this.unread,
    required this.activity,
    required this.onOpen,
    this.markLabel,
    this.priority,
    this.lane,
    this.titleLines = 2,
    this.captionLines = 1,
    this.tile = false,
    this.selected = false,
    this.warn = false,
    this.chips = const [],
    this.facts = const SuperTabCardFacts(),
    this.agent,
    this.requester,
    this.trailing,
    this.note,
    this.noteKey,
  });

  final String title, caption;

  /// A second quiet line on a Board card (#3820): the PM's decision, an open question, or a pause; null for none.
  final String? note;
  final Key? noteKey;
  final bool needsYou, unread;
  final HarnessActivity activity;

  /// What the activity mark means when its activity's own word is too broad ("In review" for a needs-input mark):
  /// its tooltip and what a screen reader hears; null says the activity's word.
  final String? markLabel;
  final VoidCallback onOpen;
  final SuperTabTaskPriority? priority;

  /// The crew lane the task is handed out in ("Desktop"), its label on a
  /// Board tile; null when no lane owns it.
  final String? lane;
  final int titleLines;

  /// How many lines the caption takes; null takes as many as it needs.
  final int? captionLines;
  final bool tile, selected;

  /// The caption is a warning (a merge that has waited too long).
  final bool warn;

  /// A tile's state chips, its pull request and checks, and the agent on it and who asked, which sit in its
  /// footer, the avatars bottom right (task #3869). A List row shows none of them.
  final List<SuperTabStateChip> chips;
  final SuperTabCardFacts facts;
  final SuperTabAgent? agent;
  final SuperTabPerson? requester;
  final Widget? trailing;

  /// A tile's padding: the spacing scale's 12, between the control and the
  /// group gap.
  static const tilePadding =
      (grid.AppDesktop.controlGap + grid.AppDesktop.groupGap) / 2;

  @override
  State<SuperTabTaskCard> createState() => _SuperTabTaskCardState();
}

/// A lane's label colour: one of the roster's hand-picked hues, which carry
/// white at 5:1 or more and stay the same in both appearances, so a lane is
/// found by its colour before it is read. Red and amber are left to P0 and P1.
Color superTabLaneColor(String lane) {
  const palette = grid.AppPalette.avatarPalette;
  return switch (lane.toLowerCase()) {
    'desktop' => palette[0],
    'cli' => palette[1],
    'mobile' => palette[2],
    'backend' => palette[5],
    'docs' => palette[6],
    _ => palette[7],
  };
}

class _SuperTabTaskCardState extends State<SuperTabTaskCard> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final w = widget;
    return Semantics(
      button: true,
      selected: w.selected ? true : null,
      label: [
        w.title,
        ?w.lane,
        if (w.priority case final priority?) 'Priority ${priority.badge}',
        w.caption,
        ?w.note,
        if (!w.needsYou) _markWord,
        if (w.unread) 'New replies',
        for (final chip in w.chips) chip.label,
        ?w.facts.pullRequest,
        if (w.facts.checks case final checks?)
          '${checks.done} of ${checks.total} checks done',
      ].join(', '),
      excludeSemantics: true,
      child: _surface(
        Padding(
          padding: w.tile
              ? const EdgeInsets.all(SuperTabTaskCard.tilePadding)
              : const EdgeInsets.symmetric(
                  horizontal: grid.AppDesktop.controlGap,
                  vertical: grid.AppDesktop.menuInset,
                ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (w.tile && w.lane != null) ...[
                _LaneLabel(w.lane!),
                const SizedBox(height: grid.AppDesktop.controlGap),
              ],
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: _text()),
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  _mark(),
                  ?w.trailing,
                ],
              ),
              if (w.tile && w.chips.isNotEmpty) ...[
                const SizedBox(height: grid.AppDesktop.controlGap),
                Wrap(
                  spacing: grid.AppDesktop.menuInset,
                  runSpacing: grid.AppDesktop.menuInset,
                  children: [for (final chip in w.chips) _chip(chip)],
                ),
              ],
              if (w.tile &&
                  (!w.facts.isEmpty ||
                      w.agent != null ||
                      w.requester != null)) ...[
                const SizedBox(height: grid.AppDesktop.controlGap),
                _footer(),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// The title, the card's strongest text, over its one quiet line.
  Widget _text() {
    final w = widget;
    final hasLine = w.priority != null || w.caption.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          w.title,
          maxLines: w.titleLines,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.control(color: DesktopChrome.foreground)
              .copyWith(
                // Unread out-ranks the medium every tile title has.
                fontWeight: w.unread
                    ? grid.AppFont.semibold
                    : w.tile
                    ? grid.AppFont.medium
                    : grid.AppFont.regular,
                height: w.tile ? 1.35 : null,
              ),
        ),
        if (hasLine)
          Padding(
            padding: EdgeInsets.only(
              top: w.tile
                  ? grid.AppDesktop.menuInset
                  : w.priority == null
                  ? 0
                  : grid.AppDesktop.listRowGap,
            ),
            child: Row(
              crossAxisAlignment: w.captionLines == null
                  ? CrossAxisAlignment.start
                  : CrossAxisAlignment.center,
              children: [
                if (w.priority case final priority?) ...[
                  if (w.tile)
                    _PriorityMark(priority)
                  else
                    SuperTabPriorityBadge(priority),
                  const SizedBox(width: grid.AppDesktop.menuInset),
                ],
                Flexible(
                  child: Text(
                    w.caption,
                    maxLines: w.captionLines,
                    // An ellipsis without a line limit still cuts the text
                    // to one line.
                    overflow: w.captionLines == null
                        ? TextOverflow.clip
                        : TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(
                      color: w.warn ? grid.AppPalette.warn : null,
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (w.note case final note?)
          Padding(
            padding: const EdgeInsets.only(top: grid.AppDesktop.menuInset),
            child: Text(
              note,
              key: w.noteKey,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            ),
          ),
      ],
    );
  }

  Widget _chip(SuperTabStateChip chip) =>
      superTabTintedChip(chip.label, switch (chip) {
        SuperTabStateChip.readyToMerge => grid.AppPalette.online,
        SuperTabStateChip.ciFailing => grid.AppPalette.usageCritical,
        SuperTabStateChip.needsYou => grid.AppPalette.warn,
      }, key: ValueKey('super-card-chip-${chip.name}'));

  /// The pull request and checks on the left, and on the right the agent's avatar with the requester's
  /// small beside it, bottom right, where a Trello card puts its members.
  Widget _footer() {
    final w = widget;
    Widget fact(String key, Widget icon, String text) => Padding(
      padding: const EdgeInsets.only(right: grid.AppDesktop.controlGap),
      child: Row(
        key: ValueKey(key),
        mainAxisSize: MainAxisSize.min,
        children: [
          icon,
          const SizedBox(width: grid.AppDesktop.listRowGap * 2),
          Text(text, style: DesktopChrome.metadata()),
        ],
      ),
    );
    const iconSize = 14.0;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (w.facts.pullRequest case final pr?)
          fact(
            'super-card-pr',
            SvgPicture.asset(
              pullRequestIconAsset('Open'),
              width: iconSize,
              height: iconSize,
              colorFilter: ColorFilter.mode(
                DesktopChrome.muted,
                BlendMode.srcIn,
              ),
            ),
            pr,
          ),
        if (w.facts.checks case final checks?)
          fact(
            'super-card-checks',
            Icon(AppIcons.check, size: iconSize, color: DesktopChrome.muted),
            '${checks.done}/${checks.total}',
          ),
        const Spacer(),
        if (w.requester case final person?) ...[
          SuperTabAvatar.person(
            person,
            key: const ValueKey('super-card-requester'),
            size: _requesterSize,
          ),
          const SizedBox(width: grid.AppDesktop.listRowGap * 2),
        ],
        if (w.agent case final agent?)
          SuperTabAvatar.agent(
            agent,
            key: const ValueKey('super-card-agent'),
            size: _agentSize,
            engineBadge: false,
          ),
      ],
    );
  }

  /// The agent's avatar, the size of a roster row's, and the requester's a step smaller beside it.
  static const _agentSize = SuperTabAvatar.rowSize;
  static const _requesterSize = 18.0;

  /// The card's state in words: the mark's tooltip and the screen reader's.
  String get _markWord =>
      widget.markLabel ??
      switch (widget.activity) {
        HarnessActivity.starting => 'Queued',
        HarnessActivity.needsInput => 'Waiting on a person',
        HarnessActivity.offline => 'Blocked or agent lost',
        HarnessActivity.done => 'Shipped',
        _ => widget.activity.label,
      };

  // A bare glyph says nothing until it is named (finding 13 of #4211): the card's word, not the terminal's.
  Widget _mark() => Tooltip(
    message: _markWord,
    child: ListenableBuilder(
      listenable: Listenable.merge([terminalThemeStore, appearancePrefsStore]),
      builder: (context, _) => ActivityMark(
        activity: widget.activity,
        color: activityColor(
          widget.activity,
          terminalThemeFor(
            grid.AppTheme.surfacePalette,
            terminalThemeStore.value,
          ),
          color: appearancePrefsStore.value.prompt.color,
        ),
        tooltip: false,
      ),
    ),
  );

  /// A List row is a plain row that takes the list's hover, filled when it is
  /// selected; a Board tile is raised card material of its own, its shadow a
  /// step deeper under the pointer. Each fill is [Ink] on its own [Material],
  /// so the hover paints over it inside its lane.
  Widget _surface(Widget body) {
    final w = widget;
    final radius = BorderRadius.circular(
      w.tile ? grid.AppCard.insetRadius : DesktopChrome.rowRadius,
    );
    final ink = InkWell(
      onTap: w.onOpen,
      onHover: w.tile
          ? (hovered) {
              if (hovered != _hovered) setState(() => _hovered = hovered);
            }
          : null,
      hoverColor: grid.AppSurface.hoverFill,
      focusColor: grid.AppSurface.hoverFill,
      borderRadius: radius,
      child: body,
    );
    if (!w.tile && !w.selected) return ink;
    final fill = grid.AppSurface.selectedFill;
    return Material(
      type: MaterialType.transparency,
      child: Ink(
        decoration: w.tile
            ? BoxDecoration(
                color: w.selected
                    ? Color.alphaBlend(fill, grid.AppCard.base)
                    : grid.AppCard.base,
                borderRadius: radius,
                border: Border.all(
                  color: w.selected
                      ? grid.AppGlass.lift
                      : grid.AppCard.insetHair,
                ),
                boxShadow: _hovered
                    ? grid.AppGlass.shadow
                    : grid.AppGlass.cardShadow,
              )
            : BoxDecoration(color: fill, borderRadius: radius),
        child: ink,
      ),
    );
  }
}

/// A lane's label, as Trello labels a card: a small capsule of the lane's
/// colour with its name in white, so the colour is never the only cue.
class _LaneLabel extends StatelessWidget {
  const _LaneLabel(this.lane);
  final String lane;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: ValueKey('super-task-lane-$lane'),
    decoration: BoxDecoration(
      color: superTabLaneColor(lane),
      borderRadius: BorderRadius.circular(grid.AppDesktop.paneCloseInset),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.menuInset,
        vertical: grid.AppDesktop.listRowGap / 2,
      ),
      child: Text(
        lane,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.metadata(color: grid.AppDesktop.onSelection)
            .copyWith(fontWeight: grid.AppFont.medium, height: 1.25),
      ),
    ),
  );
}

/// A tile's priority, kept small: P0 and P1 lead with a dot of their ink (red,
/// amber) and say their name in it; P2 and P3 are a quiet word.
class _PriorityMark extends StatelessWidget {
  const _PriorityMark(this.priority);
  final SuperTabTaskPriority priority;

  @override
  Widget build(BuildContext context) {
    final color = superTabPriorityColor(priority);
    final loud =
        priority == SuperTabTaskPriority.p0 ||
        priority == SuperTabTaskPriority.p1;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (loud) ...[
          SizedBox.square(
            dimension: grid.AppDesktop.menuInset,
            child: DecoratedBox(
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
          ),
          const SizedBox(width: grid.AppDesktop.paneCloseInset),
        ],
        Text(
          priority.badge,
          style: DesktopChrome.metadata(color: color)
              .copyWith(fontWeight: loud ? grid.AppFont.semibold : null),
        ),
      ],
    );
  }
}
